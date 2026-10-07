'use strict';
// Headless Chromium end-to-end checks, driven over the Chrome DevTools Protocol
// (Node's built-in WebSocket client; no npm packages). Loads index.html via file://
// and via serve.py, records every network request, console message, log entry and
// exception, and drives the UI. Skips (with reason) if Chromium is unavailable.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, readSample } = require('./helpers.js');

const CHROMIUM = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
const HAS_WS = typeof WebSocket === 'function';
const SKIP = !CHROMIUM ? 'no chromium binary found' : (!HAS_WS ? 'no global WebSocket in this Node' : false);

// ids referenced by app.js (computed independently of the browser)
const APP_IDS = [...fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8').matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      } else if (msg.method) {
        this.listeners.forEach((l) => l(msg));
      }
    });
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 20000);
    });
  }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

async function launchChromium(userDataDir) {
  const proc = spawn(CHROMIUM, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0',
    '--user-data-dir=' + userDataDir, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--disable-extensions', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  const wsUrl = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('chromium did not start: ' + err.slice(-2000))), 30000);
    proc.stderr.on('data', (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(t); reject(new Error('chromium exited ' + code + ': ' + err.slice(-2000))); });
  });
  const cdp = new CDP(wsUrl);
  await cdp.open();
  return { proc, cdp };
}

// Open a fresh page, record everything, navigate to url, wait for load.
async function openPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const rec = { requests: [], console: [], logs: [], exceptions: [], cspViolations: [], loaded: false };
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    const p = msg.params || {};
    if (msg.method === 'Network.requestWillBeSent') rec.requests.push(p.request.url);
    if (msg.method === 'Runtime.consoleAPICalled') rec.console.push({ type: p.type, text: (p.args || []).map((a) => a.value || a.description).join(' ') });
    if (msg.method === 'Log.entryAdded') rec.logs.push({ level: p.entry.level, source: p.entry.source, text: p.entry.text, url: p.entry.url });
    if (msg.method === 'Runtime.exceptionThrown') rec.exceptions.push(p.exceptionDetails);
    if (msg.method === 'Page.loadEventFired') rec.loaded = true;
  });
  const s = (m, prm) => cdp.send(m, prm, sessionId);
  await s('Network.enable');
  await s('Runtime.enable');
  await s('Log.enable');
  await s('Page.enable');
  await s('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
  await s('Page.navigate', { url });
  const deadline = Date.now() + 15000;
  while (!rec.loaded && Date.now() < deadline) await sleep(50);
  assert.ok(rec.loaded, 'page did not load: ' + url);
  const evaluate = async (expr) => {
    const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  };
  return { sessionId, targetId, rec, evaluate, close: () => cdp.send('Target.closeTarget', { targetId }) };
}

function isAllowedUrl(u, httpOrigin) {
  if (u.startsWith('file://' + ROOT + '/')) return true;
  if (httpOrigin && u.startsWith(httpOrigin + '/')) return true;
  return /^(data|blob|about):/.test(u);
}

// Drives the UI end-to-end; returns observations for assertions.
const DRIVE = (sample, ids) => `(async () => {
  const $ = (id) => document.getElementById(id);
  const out = {};
  out.missingIds = ${JSON.stringify(ids)}.filter((id) => !$(id));
  out.sanitizeText = $('sanitize-btn') && $('sanitize-btn').textContent;
  const boxes = [...document.querySelectorAll('#category-toggles input[type=checkbox]')];
  out.toggleCount = boxes.length;
  out.allChecked = boxes.every((b) => b.checked);
  out.csp = $('csp-indicator').textContent;
  const inp = $('input-text');
  inp.value = ${JSON.stringify(sample)};
  inp.dispatchEvent(new Event('input'));
  out.formatLabel = $('format-label').textContent;
  $('sanitize-btn').click();
  out.output = $('output-text').value;
  out.stats = $('stats-line').textContent;
  out.legendRows = $('legend-tbody').children.length;
  out.leakBadgeHidden = $('leak-count-badge').hidden;
  // keyboard shortcut
  $('output-text').value = '';
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  out.afterCtrlEnter = $('output-text').value.length > 0;
  $('output-text').value = '';
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  out.afterCmdEnter = $('output-text').value.length > 0;
  // tabs
  document.querySelector('.tab-btn[data-tab=legend]').click();
  out.legendTabVisible = !$('tab-legend').hidden && $('tab-output').hidden;
  document.querySelector('.tab-btn[data-tab=output]').click();
  // legend filter + sort
  $('legend-filter').value = 'HOST';
  $('legend-filter').dispatchEvent(new Event('input'));
  out.filteredRows = [...$('legend-tbody').children].map((tr) => tr.children[1].textContent);
  $('legend-filter').value = '';
  $('legend-filter').dispatchEvent(new Event('input'));
  document.querySelector('#legend-table th[data-sort=count]').click();
  out.sortedOk = $('legend-tbody').children.length === out.legendRows;
  // token column sort is numeric-aware (HOST_2 before HOST_10)
  {
    const prev = inp.value;
    inp.value = Array.from({ length: 12 }, (_, i) => 'ip 10.200.0.' + (i + 1)).join(' ; ');
    $('sanitize-btn').click();
    const th = document.querySelector('#legend-table th[data-sort=token]');
    th.click(); // sort by token asc
    const toks = [...$('legend-tbody').children].map((tr) => tr.children[0].textContent).filter((t) => t.startsWith('{{IP_'));
    out.ipTokenOrder = toks;
    inp.value = prev;
    $('sanitize-btn').click();
  }
  // copy (clipboard may be unavailable headless; must not throw, must report)
  $('copy-btn').click();
  await new Promise((r) => setTimeout(r, 300));
  out.copyStatus = $('copy-status').textContent;
  // downloads (Blob + anchor) must not throw
  $('download-output-btn').click();
  $('download-legend-json-btn').click();
  $('download-legend-csv-btn').click();
  // invalid JSON shows inline message
  inp.value = '{"ip": "10.1.2.3", ';
  inp.dispatchEvent(new Event('input'));
  $('sanitize-btn').click();
  out.parseErrorVisible = !$('parse-error').hidden;
  out.parseErrorText = $('parse-error').textContent;
  out.invalidOutput = $('output-text').value;
  // leak check panel + one-click add
  inp.value = 'robocopy D:\\\\data \\\\\\\\FILESRV-09\\\\finance';
  $('sanitize-btn').click();
  out.leakBadge = $('leak-count-badge').hidden ? null : $('leak-count-badge').textContent;
  const leakBtn = document.querySelector('#leaks-list .leak-row button');
  if (leakBtn) leakBtn.click();
  out.customHostAfterLeak = $('custom-host').value;
  out.outputAfterLeakFix = $('output-text').value;
  out.leakBadgeAfterFix = $('leak-count-badge').hidden;
  // clear flow with in-page confirmation
  $('clear-btn').click();
  out.confirmShown = !$('clear-confirm').hidden;
  $('clear-confirm-no').click();
  out.confirmHiddenAfterNo = $('clear-confirm').hidden;
  out.outputKeptAfterNo = $('output-text').value.length > 0;
  $('clear-btn').click();
  $('clear-confirm-yes').click();
  out.afterClear = { input: inp.value, output: $('output-text').value, legend: $('legend-tbody').children.length, host: $('custom-host').value, confirmHidden: $('clear-confirm').hidden };
  // storage untouched
  try { out.localStorageLen = window.localStorage.length; } catch (e) { out.localStorageLen = 0; }
  out.cookie = document.cookie;
  return out;
})()`;

describe('browser (headless chromium)', { skip: SKIP }, () => {
  let chrome;
  let server;
  let httpOrigin;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-cleaner-chromium-'));

  before(async () => {
    chrome = await launchChromium(path.join(tmp, 'profile'));
    const port = await freePort();
    server = spawn('python3', [path.join(ROOT, 'serve.py'), String(port)], { stdio: 'ignore' });
    httpOrigin = 'http://127.0.0.1:' + port;
    const deadline = Date.now() + 10000;
    for (;;) {
      const ok = await new Promise((r) => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
      if (ok) break;
      if (Date.now() > deadline) throw new Error('serve.py did not start');
      await sleep(100);
    }
  });

  after(() => {
    if (chrome) { chrome.cdp.close(); chrome.proc.kill('SIGKILL'); }
    if (server) server.kill('SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const sample = readSample('crowdstrike_detection.json');

  for (const mode of ['file', 'http']) {
    test(mode + ': renders, works end-to-end, no console errors, no foreign requests', async () => {
      const url = mode === 'file' ? 'file://' + path.join(ROOT, 'index.html') : httpOrigin + '/index.html';
      const page = await openPage(chrome.cdp, url);
      const o = await page.evaluate(DRIVE(sample, APP_IDS));
      await sleep(300);
      const { rec } = page;

      assert.deepEqual(o.missingIds, [], 'ids referenced in app.js missing from DOM');
      assert.match(o.sanitizeText, /Sanitize/);
      assert.equal(o.toggleCount, 12);
      assert.ok(o.allChecked, 'all toggles default ON');
      assert.equal(o.csp, 'CSP active');
      assert.equal(o.formatLabel, 'format: json');
      assert.ok(!o.output.includes('WKS-FIN-042') && !o.output.includes('fileserver01'), o.output);
      assert.match(o.output, /\{\{HOST_1\}\}/);
      assert.match(o.stats, /records: 1/);
      assert.ok(o.legendRows > 5);
      assert.equal(o.leakBadgeHidden, true);
      assert.ok(o.afterCtrlEnter, 'Ctrl+Enter sanitizes');
      assert.ok(o.afterCmdEnter, 'Cmd+Enter sanitizes');
      assert.ok(o.legendTabVisible);
      assert.ok(o.filteredRows.length > 0 && o.filteredRows.every((t) => t === 'HOST'), 'filter: ' + o.filteredRows);
      assert.ok(o.sortedOk);
      const nums = o.ipTokenOrder.map((t) => Number(/_(\d+)/.exec(t)[1]));
      assert.ok(nums.length >= 12);
      assert.deepEqual(nums, [...nums].sort((a, b) => a - b), 'token sort should be numeric: ' + o.ipTokenOrder);
      assert.match(o.copyStatus, /^(Copied\.|Copy failed\.)$/);
      assert.ok(o.parseErrorVisible);
      assert.match(o.parseErrorText, /could not be parsed/);
      assert.ok(!o.invalidOutput.includes('10.1.2.3'));
      assert.equal(o.leakBadge, '1');
      assert.equal(o.customHostAfterLeak, 'FILESRV-09');
      assert.ok(!o.outputAfterLeakFix.includes('FILESRV-09'));
      assert.equal(o.leakBadgeAfterFix, true);
      assert.ok(o.confirmShown && o.confirmHiddenAfterNo && o.outputKeptAfterNo);
      assert.deepEqual(o.afterClear, { input: '', output: '', legend: 0, host: '', confirmHidden: true });
      assert.equal(o.localStorageLen, 0);
      assert.equal(o.cookie, '');

      const foreign = rec.requests.filter((u) => !isAllowedUrl(u, mode === 'http' ? httpOrigin : null));
      assert.deepEqual(foreign, [], 'requests outside local origin');
      const local = rec.requests.filter((u) => !/^(data|blob|about):/.test(u)).map((u) => u.replace(/^.*\//, ''));
      assert.deepEqual([...new Set(local)].sort(), ['app.js', 'index.html', 'sanitizer.js', 'styles.css'], 'only the 4 local files: ' + local);
      const errors = rec.console.filter((c) => c.type === 'error' || c.type === 'warning')
        .concat(rec.logs.filter((l) => l.level === 'error' || l.level === 'warning'));
      assert.deepEqual(errors, [], 'console/log errors or warnings (incl. CSP violations)');
      assert.deepEqual(rec.exceptions, []);
      await page.close();
    });
  }

  test('CSP actively blocks an injected fetch/image to a remote host (file:// and http)', async () => {
    for (const url of ['file://' + path.join(ROOT, 'index.html'), httpOrigin + '/index.html']) {
      const page = await openPage(chrome.cdp, url);
      const r = await page.evaluate(`(async () => {
        const v = [];
        document.addEventListener('securitypolicyviolation', (e) => v.push(e.violatedDirective));
        let fetchBlocked = false;
        try { await fetch('https://pii-cleaner-test.invalid/x'); } catch (e) { fetchBlocked = true; }
        const img = new Image(); img.src = 'https://pii-cleaner-test.invalid/p.png';
        document.body.appendChild(img);
        await new Promise((res) => setTimeout(res, 500));
        return { fetchBlocked, v };
      })()`);
      assert.ok(r.fetchBlocked, 'fetch must be blocked');
      assert.ok(r.v.some((d) => d.startsWith('connect-src')), 'connect-src violation expected: ' + r.v);
      assert.ok(r.v.some((d) => d.startsWith('img-src')), 'img-src violation expected: ' + r.v);
      // proves the console/log capture used by the "no errors" assertions really sees CSP reports
      const seen = page.rec.logs.concat(page.rec.console).map((x) => x.text).join('\n');
      assert.match(seen, /Content Security Policy/);
      const remote = page.rec.requests.filter((u) => u.includes('pii-cleaner-test.invalid'));
      assert.ok(remote.length <= 2, 'blocked requests may be reported but never more');
      await page.close();
    }
  });
});

if (SKIP) {
  test('browser tests skipped', { skip: SKIP }, () => {});
}
