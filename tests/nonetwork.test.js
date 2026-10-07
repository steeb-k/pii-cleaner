'use strict';
// Static and runtime guarantees that the app is local-only.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT } = require('./helpers.js');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// App files only (top level), as in the SPEC acceptance grep. tests/ is excluded:
// it legitimately talks to 127.0.0.1.
const APP_FILES = fs.readdirSync(ROOT).filter((f) => /\.(js|html|css)$/.test(f));

function stripComments(src, file) {
  let s = src;
  if (file.endsWith('.html')) s = s.replace(/<!--[\s\S]*?-->/g, '');
  // block comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  if (file.endsWith('.js')) {
    // line comments that start a line or follow whitespace / ; ) { ,
    s = s.replace(/(^|[\s;){},])\/\/.*$/gm, '$1');
  }
  return s;
}

describe('static: CSP and includes', () => {
  test('index.html carries the exact CSP meta from SPEC.md', () => {
    const spec = read('SPEC.md');
    const m = /<meta http-equiv="Content-Security-Policy" content="[^"]+">/.exec(spec);
    assert.ok(m, 'CSP meta not found in SPEC.md');
    const html = read('index.html');
    assert.ok(html.includes(m[0]), 'index.html must contain exactly: ' + m[0]);
    // and it must be in <head>, before any script
    const headEnd = html.indexOf('</head>');
    assert.ok(html.indexOf(m[0]) < headEnd);
    assert.ok(html.indexOf(m[0]) < html.indexOf('<script'));
    // exactly one CSP meta
    assert.equal(html.split('http-equiv="Content-Security-Policy"').length - 1, 1);
  });

  test('no remote <script src> / <link href> / any remote src|href in index.html', () => {
    const html = stripComments(read('index.html'), 'index.html');
    assert.doesNotMatch(html, /<script[^>]+src\s*=\s*["']?\s*(https?:)?\/\//i);
    assert.doesNotMatch(html, /<link[^>]+href\s*=\s*["']?\s*(https?:)?\/\//i);
    assert.doesNotMatch(html, /\b(src|href|action|poster|data)\s*=\s*["']?\s*(https?:)?\/\//i);
    assert.doesNotMatch(html, /<(iframe|object|embed|base)\b/i);
  });

  test('index.html loads exactly styles.css, sanitizer.js, app.js via relative paths', () => {
    const html = read('index.html');
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    const links = [...html.matchAll(/<link[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(scripts, ['sanitizer.js', 'app.js']);
    // styles.css + an inline data: favicon (prevents an implicit /favicon.ico request)
    assert.deepEqual(links.sort(), ['data:,', 'styles.css']);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline scripts (CSP script-src self would block them)');
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handlers (blocked by CSP)');
  });

  test('styles.css has no remote url()/@import/fonts', () => {
    const css = stripComments(read('styles.css'), 'styles.css');
    assert.doesNotMatch(css, /@import/i);
    assert.doesNotMatch(css, /url\(\s*["']?\s*(https?:)?\/\//i);
    assert.doesNotMatch(css, /@font-face/i);
  });
});

describe('static: forbidden APIs outside comments', () => {
  const FORBIDDEN = [
    /fetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /navigator\.sendBeacon/, /\bsendBeacon\b/,
    /localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /importScripts/,
    /serviceWorker/, /EventSource/, /RTCPeerConnection/, /new\s+Worker\b/, /window\.open\s*\(/,
    /\balert\s*\(/, /\bconfirm\s*\(/, /\bprompt\s*\(/, /https?:\/\//
  ];
  for (const f of APP_FILES) {
    test(f + ' contains no network/storage/dialog API usage', () => {
      let src = stripComments(read(f), f);
      if (f === 'index.html') {
        // the CSP line itself is allowed by the SPEC acceptance grep
        src = src.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
      }
      for (const re of FORBIDDEN) {
        const m = re.exec(src);
        assert.equal(m, null, f + ': forbidden pattern ' + re + ' found near: ' + (m ? src.slice(Math.max(0, m.index - 40), m.index + 40) : ''));
      }
    });
  }

  test('comment stripper sanity: it would catch a real call', () => {
    const src = stripComments('var a = 1; // fetch(x)\nvar b = fetch("/x");', 'x.js');
    assert.match(src, /fetch\(/);
    assert.equal((src.match(/fetch\(/g) || []).length, 1);
  });

  test('sanitizer.js is DOM-free and Node-loadable', () => {
    const src = stripComments(read('sanitizer.js'), 'sanitizer.js');
    assert.doesNotMatch(src, /\bdocument\./);
    assert.match(src, /module\.exports\s*=/);
    assert.match(src, /window\.PIISanitizer\s*=/);
  });

  test('app.js file picker uses FileReader only (no URL fetch of files)', () => {
    const src = stripComments(read('app.js'), 'app.js');
    assert.match(src, /new FileReader\(\)/);
    assert.doesNotMatch(src, /\.text\(\)|\.arrayBuffer\(\)|\.stream\(\)/);
  });
});

describe('static: serve.py', () => {
  const py = read('serve.py');
  test('binds 127.0.0.1 only and sends no-store', () => {
    assert.match(py, /host\s*=\s*"127\.0\.0\.1"/);
    assert.doesNotMatch(py, /0\.0\.0\.0['"]\s*,|\(\s*['"]['"]\s*,/);
    assert.match(py, /Cache-Control["']\s*,\s*["']no-store/);
  });
});

// ---------------------------------------------------------------------------
// Runtime: start serve.py on a free port and probe it.
// ---------------------------------------------------------------------------
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function get(host, port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: p, timeout: 2000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function tryConnect(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 1500 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}

function nonLoopbackIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

describe('runtime: serve.py', () => {
  let proc;
  let port;
  let stderr = '';

  before(async () => {
    port = await freePort();
    // run from a different cwd to verify it serves its own directory
    proc = spawn('python3', [path.join(ROOT, 'serve.py'), String(port)], { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stderr.on('data', (d) => { stderr += d; });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await tryConnect('127.0.0.1', port)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('serve.py did not start: ' + stderr);
  });

  after(() => {
    if (proc && proc.exitCode === null) proc.kill('SIGTERM');
  });

  test('serves index.html with Cache-Control: no-store', async () => {
    const r = await get('127.0.0.1', port, '/');
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.match(r.body, /Content-Security-Policy/);
  });

  for (const f of ['/index.html', '/styles.css', '/sanitizer.js', '/app.js']) {
    test('GET ' + f + ' -> 200 + no-store', async () => {
      const r = await get('127.0.0.1', port, f);
      assert.equal(r.status, 200);
      assert.equal(r.headers['cache-control'], 'no-store');
    });
  }

  test('404 responses also carry no-store', async () => {
    const r = await get('127.0.0.1', port, '/does-not-exist.txt');
    assert.equal(r.status, 404);
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('not reachable on a non-loopback interface', async (t) => {
    const ip = nonLoopbackIPv4();
    if (!ip) { t.skip('no non-loopback IPv4 interface on this machine'); return; }
    assert.equal(await tryConnect(ip, port), false, 'serve.py answered on ' + ip);
  });
});
