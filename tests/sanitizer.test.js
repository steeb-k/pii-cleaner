'use strict';
// Unit tests for the pure logic in sanitizer.js. All values are fictional.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { S, readSample, newSession, run, tokenFor, tokensIn, parseCSV } = require('./helpers.js');

const TOKEN_RE = /\{\{[A-Z]+_\d+\}\}/;

// ---------------------------------------------------------------------------
// Independent oracle: every fictional PII value present in each sample file.
// Written by hand from the sample files, NOT derived from the sanitizer.
// ---------------------------------------------------------------------------
const ORACLE = {
  'crowdstrike_detection.json': [
    'a1b2c3d4e5f60718293a4b5c6d7e8f90', '1234567890abcdef1234567890abcdef', 'WKS-FIN-042',
    'example.corp', 'jdoe', 'S-1-5-21-111111111-222222222-333333333-1001', '10.20.30.40',
    '203.0.113.25', 'AA:BB:CC:DD:EE:FF', 'fileserver01', 'jdoe@example.corp',
    'deadbeefdeadbeefdeadbeefdeadbeef'
  ],
  'crowdstrike_ndjson.ndjson': [
    '1111222233334444555566667777888a', 'a1b2c3d4e5f60718293a4b5c6d7e8f90', '99998888777766665555444433332222',
    'WKS-FIN-042', 'example.corp', 'jdoe', 'asmith', '10.20.30.40', '10.20.30.41', '203.0.113.25',
    '198.51.100.77', 'AA:BB:CC:DD:EE:FF', '11:22:33:44:55:66', 'update.example.corp',
    'https://update.example.corp/payload.bin'
  ],
  'rapid7_idr_alert.json': [
    '7f3c6a9e-4b2d-4e1a-9c3f-2d6b8a1e5f90', '2a9d1e3c-5b7f-4a8e-9d1c-3f5b7a9e1d2c',
    '4e2d9b7a-1c3f-4a5e-8b6d-7f9a1e3c5b7f', '00000000-0000-0000-0000-000000000000', 'jdoe', 'WKS-FIN-042',
    '10.20.30.40', '203.0.113.25', 'fileserver01', 'example.corp', 'jdoe@example.corp',
    'https://update.example.corp/payload.bin', 'update.example.corp', 'AA:BB:CC:DD:EE:FF',
    'S-1-5-21-111111111-222222222-333333333-1001'
  ],
  'rapid7_vm_asset.json': [
    '10.20.30.50', '192.168.1.50', 'AA:BB:CC:DD:EE:01', 'WKS-FIN-050', 'wks-fin-050.example.corp',
    '4e2d9b7a-1c3f-4a5e-8b6d-7f9a1e3c5b7f', 'b3f1c2d4e5a6b7c8d9e0f1a2b3c4d5e6', 'SN-7X9K2L4M6P8Q',
    'asmith', 'asmith@example.corp', 'example.corp'
  ]
};

function parseOutput(name, output) {
  if (name.endsWith('.ndjson')) {
    return output.split('\n').map((l) => JSON.parse(l));
  }
  return JSON.parse(output);
}

function parseInput(name, text) {
  if (name.endsWith('.ndjson')) {
    return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
  return JSON.parse(text);
}

// Structural diff: keys identical, non-strings identical, strings with no oracle
// value identical. Returns list of problems.
function structuralDiff(orig, out, oracle, p, problems) {
  const lcOracle = oracle.map((v) => v.toLowerCase());
  if (Array.isArray(orig)) {
    if (!Array.isArray(out) || out.length !== orig.length) { problems.push(p + ': array shape changed'); return problems; }
    orig.forEach((v, i) => structuralDiff(v, out[i], oracle, p + '[' + i + ']', problems));
    return problems;
  }
  if (orig && typeof orig === 'object') {
    if (!out || typeof out !== 'object') { problems.push(p + ': object became ' + typeof out); return problems; }
    const ka = Object.keys(orig);
    const kb = Object.keys(out);
    if (JSON.stringify(ka) !== JSON.stringify(kb)) problems.push(p + ': keys changed ' + ka + ' -> ' + kb);
    ka.forEach((k) => structuralDiff(orig[k], out[k], oracle, p + '.' + k, problems));
    return problems;
  }
  if (typeof orig === 'string') {
    if (typeof out !== 'string') { problems.push(p + ': string type changed'); return problems; }
    const hasPII = lcOracle.some((v) => orig.toLowerCase().includes(v));
    if (!hasPII && orig !== out) problems.push(p + ': non-PII string changed: ' + JSON.stringify(orig) + ' -> ' + JSON.stringify(out));
    return problems;
  }
  if (orig !== out) problems.push(p + ': non-string value changed ' + orig + ' -> ' + out);
  return problems;
}

describe('samples: full pipeline', () => {
  for (const name of Object.keys(ORACLE)) {
    test(name + ': no raw PII remains, nothing else changed', () => {
      const text = readSample(name);
      const { result } = run(text);
      assert.equal(result.error, null);
      assert.ok(!result.warning, 'unexpected warning: ' + result.warning);
      const lcOut = result.output.toLowerCase();
      for (const v of ORACLE[name]) {
        assert.ok(!lcOut.includes(v.toLowerCase()), name + ': raw PII value still present: ' + v);
      }
      assert.deepEqual(result.leaks, [], 'leak check should be empty for ' + name);
      const out = parseOutput(name, result.output); // re-parses
      const problems = structuralDiff(parseInput(name, text), out, ORACLE[name], '$', []);
      assert.deepEqual(problems, []);
    });
  }

  test('crowdstrike_detection: hashes/timestamps/ports/numbers/event fields unchanged exactly', () => {
    const { result } = run(readSample('crowdstrike_detection.json'));
    const o = JSON.parse(result.output);
    assert.equal(o.SHA256HashData, '44d88612fea8a8f36de82e1278abb02f44d88612fea8a8f36de82e1278abb02');
    assert.equal(o.MD5HashData, '44d88612fea8a8f36de82e1278abb02');
    assert.equal(o.FirstBehavior, '2026-09-30T14:22:10Z');
    assert.equal(o.ProcessStartTime, '2026-09-30T14:22:09Z');
    assert.equal(o.LocalPort, 51722);
    assert.equal(o.RemotePort, 443);
    assert.equal(o.ProcessId, '9876');
    assert.equal(o.SeverityName, 'High');
    assert.equal(o.Tactic, 'Execution');
    assert.equal(o.ParentBaseFileName, 'cmd.exe');
    assert.match(o.FilePath, /^C:\\Users\\\{\{USER_\d+\}\}\\AppData\\Local\\Temp\\update\.ps1$/);
  });

  test('ndjson sample: emits NDJSON (one object per line, no pretty print)', () => {
    const { result } = run(readSample('crowdstrike_ndjson.ndjson'));
    assert.equal(result.format, 'ndjson');
    assert.equal(result.records, 3);
    const lines = result.output.split('\n');
    assert.equal(lines.length, 3);
    lines.forEach((l) => { assert.ok(!l.includes('\n  ')); JSON.parse(l); });
  });

  test('json sample output is pretty-printed with 2-space indent', () => {
    const { result } = run(readSample('rapid7_idr_alert.json'));
    assert.ok(result.output.startsWith('{\n  "id": '));
  });

  test('rapid7 vm: booleans/null/numbers untouched; numeric id untouched', () => {
    const { result } = run(JSON.stringify({ id: 50042, ok: true, nothing: null, riskScore: 742.3, ip: '10.9.9.9' }));
    const o = JSON.parse(result.output);
    assert.deepEqual([o.id, o.ok, o.nothing, o.riskScore], [50042, true, null, 742.3]);
  });
});

describe('format detection', () => {
  test('single object', () => {
    assert.equal(S.detectFormat('{"a":1}'), 'json');
    assert.equal(S.detectFormat('\uFEFF  {"a":1}\n'), 'json');
  });
  test('array', () => assert.equal(S.detectFormat('[{"a":1},{"b":2}]'), 'array'));
  test('NDJSON with blank lines and CRLF', () => {
    const t = '{"a":1}\r\n\r\n   \n{"b":"10.1.2.3"}\n\n';
    assert.equal(S.detectFormat(t), 'ndjson');
    const { result } = run(t);
    assert.equal(result.records, 2);
    assert.equal(result.output, '{"a":1}\n{"b":"{{IP_1}}"}');
  });
  test('raw text', () => {
    assert.equal(S.detectFormat('hello from 10.1.2.3'), 'text');
    assert.equal(S.detectFormat('42'), 'text');
    assert.equal(S.detectFormat(''), 'text');
  });
  test('invalid JSON: user-facing warning, no throw, still sanitized as text', () => {
    const s = newSession();
    let r;
    assert.doesNotThrow(() => { r = s.sanitize('{"ip": "10.1.2.3", '); });
    assert.equal(r.format, 'text');
    assert.equal(r.error, null);
    assert.match(r.warning, /could not be parsed/);
    assert.ok(!r.output.includes('10.1.2.3'));
  });
  test('NDJSON with one broken line: warning names the line', () => {
    const r = newSession().sanitize('{"a":1}\n{"b":2\n{"c":3}');
    assert.equal(r.format, 'text');
    assert.match(r.warning, /line 2/);
  });
  test('top-level array of strings is sanitized (was silently skipped)', () => {
    const { result } = run('["jdoe@example.corp", "10.1.2.3", 7]');
    assert.equal(result.format, 'array');
    assert.deepEqual(JSON.parse(result.output), ['{{EMAIL_1}}', '{{IP_1}}', 7]);
  });
});

describe('token stability', () => {
  test('same value across two sanitize calls and two files -> same token', () => {
    const s = newSession();
    const a = s.sanitize(readSample('crowdstrike_detection.json'));
    const b = s.sanitize(readSample('rapid7_idr_alert.json'));
    const host = tokenFor(s, 'HOST', 'WKS-FIN-042');
    assert.ok(host);
    assert.equal(JSON.parse(a.output).ComputerName, host);
    assert.equal(JSON.parse(b.output).source_host, host);
    assert.equal(JSON.parse(b.output).asset.hostname, host);
    const ip = JSON.parse(a.output).LocalAddressIP4;
    assert.equal(JSON.parse(b.output).source_ip, ip);
  });

  test('case-insensitive sharing for HOST/USER/DOMAIN/EMAIL; first casing kept', () => {
    const s = newSession();
    const r = s.sanitize(JSON.stringify([
      { hostname: 'WKS-Case-01', username: 'JDoe', domain: 'Example.Corp', email: 'JDoe@Example.Corp' },
      { hostname: 'wks-case-01', username: 'JDOE', domain: 'EXAMPLE.CORP', email: 'jdoe@example.corp' }
    ]));
    const [x, y] = JSON.parse(r.output);
    assert.deepEqual(x, y);
    const legend = s.exportLegend().entries;
    assert.equal(legend.find((e) => e.type === 'HOST').original, 'WKS-Case-01');
    assert.equal(legend.find((e) => e.type === 'USER').original, 'JDoe');
  });

  test('case-sensitive for SID and ID', () => {
    const s = newSession();
    const r = s.sanitize(JSON.stringify([
      { aid: 'abcdef0123456789abcdef0123456789', sid: 'S-1-5-21-9-9-9-1001' },
      { aid: 'ABCDEF0123456789ABCDEF0123456789', sid: 'S-1-5-21-9-9-9-1001' }
    ]));
    const [x, y] = JSON.parse(r.output);
    assert.notEqual(x.aid, y.aid);
    assert.equal(x.sid, y.sid);
  });

  test('value learned in a LATER record is replaced in an EARLIER record (NDJSON)', () => {
    const t = '{"msg":"ping from WKS-LATE-07 ok"}\n{"ComputerName":"WKS-LATE-07"}';
    const { result } = run(t);
    assert.ok(!result.output.includes('WKS-LATE-07'), result.output);
  });

  test('user learned from a path in a later field is replaced in an earlier field', () => {
    const { result } = run(JSON.stringify({ CommandLine: 'whoami run by pathlate', FilePath: 'C:\\Users\\pathlate\\x.txt' }));
    assert.ok(!result.output.includes('pathlate'), result.output);
    assert.deepEqual(result.leaks, []);
  });
});

describe('legend', () => {
  test('export -> new session import -> identical output', () => {
    const a = newSession();
    const outA = a.sanitize(readSample('crowdstrike_detection.json')).output;
    const legend = JSON.parse(JSON.stringify(a.exportLegend()));
    assert.equal(legend.version, 1);
    assert.ok(!Number.isNaN(Date.parse(legend.created)));
    const b = newSession();
    const res = b.importLegend(legend);
    assert.equal(res.imported, legend.entries.length);
    assert.equal(res.skipped, 0);
    assert.equal(b.sanitize(readSample('crowdstrike_detection.json')).output, outA);
  });

  test('export -> clear -> import -> same tokens (acceptance)', () => {
    const s = newSession();
    const out1 = s.sanitize(readSample('rapid7_idr_alert.json')).output;
    const legend = s.exportLegend();
    s.clear();
    assert.equal(s.exportLegend().entries.length, 0);
    s.importLegend(legend);
    assert.equal(s.sanitize(readSample('rapid7_idr_alert.json')).output, out1);
  });

  test('counters resume from max N per type', () => {
    const s = newSession();
    s.importLegend({ version: 1, entries: [
      { token: '{{HOST_7}}', type: 'HOST', original: 'WKS-OLD-7', count: 1 },
      { token: '{{HOST_3}}', type: 'HOST', original: 'WKS-OLD-3', count: 1 },
      { token: '{{IP_2}}', type: 'IP', original: '10.0.0.2', count: 1 }
    ] });
    const r = s.sanitize(JSON.stringify({ hostname: 'WKS-NEW-1', ip: '10.0.0.99', other: 'WKS-OLD-3 at 10.0.0.2' }));
    const o = JSON.parse(r.output);
    assert.equal(o.hostname, '{{HOST_8}}');
    assert.equal(o.ip, '{{IP_3}}');
    assert.equal(o.other, '{{HOST_3}} at {{IP_2}}');
  });

  test('import into a non-empty session never maps two values to one token', () => {
    const s = newSession();
    s.sanitize(JSON.stringify({ hostname: 'WKS-CUR-1' })); // {{HOST_1}}
    const res = s.importLegend({ entries: [
      { token: '{{HOST_1}}', type: 'HOST', original: 'WKS-OTHER-9', count: 2 },
      { token: '{{HOST_2}}', type: 'HOST', original: 'WKS-FRESH-2', count: 1 },
      { token: 'garbage', type: 'HOST', original: 'x' },
      { token: '{{IP_1}}', type: 'HOST', original: 'mismatch' }
    ] });
    assert.deepEqual(res, { imported: 1, skipped: 3 });
    const e = s.exportLegend().entries.filter((x) => x.token === '{{HOST_1}}');
    assert.equal(e.length, 1);
    assert.equal(e[0].original, 'WKS-CUR-1');
  });

  test('importLegend rejects malformed legend with an Error (caught by UI)', () => {
    assert.throws(() => newSession().importLegend({ nope: 1 }), /Invalid legend/);
    assert.throws(() => newSession().importLegend(null), /Invalid legend/);
  });

  test('CSV export: header, row count, escapes commas/quotes/newlines', () => {
    const s = newSession();
    s.addCustom('CUSTOM', ['Acme, "Widgets" Inc', 'Project Kestrel']);
    s.sanitize('Acme, "Widgets" Inc and Project Kestrel and 10.4.4.4');
    const csv = s.exportLegendCSV();
    const rows = parseCSV(csv);
    assert.deepEqual(rows[0], ['token', 'type', 'original', 'count']);
    assert.equal(rows.length, 1 + s.exportLegend().entries.length);
    assert.ok(csv.includes('"Acme, ""Widgets"" Inc"'));
    const acme = rows.find((r) => r[2] === 'Acme, "Widgets" Inc');
    assert.ok(acme);
    assert.equal(acme[1], 'CUSTOM');
    assert.equal(acme[3], '1');
    rows.slice(1).forEach((r) => assert.equal(r.length, 4));
  });

  test('CSV quotes carriage returns too', () => {
    const s = newSession();
    s.importLegend({ entries: [{ token: '{{CUSTOM_1}}', type: 'CUSTOM', original: 'a\rb', count: 0 }] });
    assert.ok(s.exportLegendCSV().includes('"a\rb"'));
  });

  test('legend export contains only the four documented fields', () => {
    const s = newSession();
    s.sanitize('mail jdoe@example.corp');
    for (const e of s.exportLegend().entries) {
      assert.deepEqual(Object.keys(e).sort(), ['count', 'original', 'token', 'type']);
    }
  });
});

describe('category toggles', () => {
  const INPUT = {
    hostname: 'WKS-TGL-01',
    username: 'tgluser',
    MachineDomain: 'tgl-domain.lan',
    email: 'mailbox@mail-tgl.example.org',
    ip: '10.77.0.9',
    mac: '0A:1B:2C:3D:4E:5F',
    sid: 'S-1-5-21-7-7-7-500',
    aid: '0123456789abcdef0123456789abcdef',
    FilePath: 'C:\\Users\\pathuser\\notes.txt',
    url: 'https://portal.tgl-site.io/login',
    phone: '+14155550199',
    note: 'Project-Bluebird kickoff'
  };
  const RAW = {
    HOST: 'WKS-TGL-01', USER: 'tgluser', DOMAIN: 'tgl-domain.lan', EMAIL: 'mailbox@', IP: '10.77.0.9',
    MAC: '0A:1B:2C:3D:4E:5F', SID: 'S-1-5-21-7-7-7-500', ID: '0123456789abcdef0123456789abcdef',
    PATH: 'pathuser', URL: 'https://', PHONE: '+14155550199', CUSTOM: 'Project-Bluebird'
  };
  function sanitizeWith(disabled) {
    const s = newSession();
    s.addCustom('CUSTOM', ['Project-Bluebird']);
    const enabled = {};
    if (disabled) enabled[disabled] = false;
    return s.sanitize(JSON.stringify(INPUT), { enabled }).output;
  }
  const allOn = sanitizeWith(null);
  const typesAllOn = new Set(tokensIn(allOn).map((t) => t.slice(2, t.indexOf('_'))));

  test('all toggles on: every value tokenized', () => {
    for (const [type, raw] of Object.entries(RAW)) {
      assert.ok(!allOn.includes(raw), type + ' raw value still present');
    }
  });

  for (const type of S.TYPES) {
    test('toggle ' + type + ' off: not tokenized, others still are', () => {
      const out = sanitizeWith(type);
      assert.ok(out.includes(RAW[type]), type + ' value should be left as-is: ' + out);
      assert.ok(!out.includes('{{' + type + '_'), 'no ' + type + ' tokens expected');
      for (const other of typesAllOn) {
        if (other === type) continue;
        assert.ok(out.includes('{{' + other + '_'), other + ' should still be tokenized when ' + type + ' is off');
      }
    });
  }
});

describe('custom lists', () => {
  test('replaced everywhere including free text and every record', () => {
    const s = newSession();
    s.addCustom('HOST', 'BUILD-BOX-3\n\n  ');
    s.addCustom('CUSTOM', ['Operation Nightjar']);
    const r = s.sanitize(JSON.stringify({ a: 'deploy to BUILD-BOX-3 now', b: ['Operation Nightjar', 'x Operation Nightjar y'] }));
    assert.ok(!r.output.includes('BUILD-BOX-3'));
    assert.ok(!r.output.includes('Nightjar'));
    assert.equal(s.exportLegend().entries.length, 2);
  });

  test('boundary rules: CORP\\jdoe, "jdoe", /home/jdoe, user=jdoe, (jdoe) match; jdoeadmin does not', () => {
    const s = newSession();
    s.addCustom('USER', ['jdoe']);
    const r = s.sanitize('CORP\\jdoe "jdoe" /home/jdoe/x user=jdoe, (jdoe); jdoe@ jdoeadmin xjdoe jdoe_old');
    const t = tokenFor(s, 'USER', 'jdoe');
    assert.equal(r.output,
      'CORP\\' + t + ' "' + t + '" /home/' + t + '/x user=' + t + ', (' + t + '); ' + t + '@ jdoeadmin xjdoe jdoe_old');
  });

  test('punctuation-containing custom values match without boundaries', () => {
    const s = newSession();
    s.addCustom('CUSTOM', ['Acme:Secret', 'ticket#42']);
    const r = s.sanitize('xAcme:Secrety and ABCticket#42Z');
    assert.equal(r.output, 'x{{CUSTOM_1}}y and ABC{{CUSTOM_2}}Z');
  });

  test('decision: hyphen/dot values keep boundaries (wks-01 does not match inside wks-010)', () => {
    const s = newSession();
    s.addCustom('HOST', ['wks-01']);
    assert.equal(s.sanitize('wks-01 wks-010').output, '{{HOST_1}} wks-010');
  });

  test('regex metacharacters in custom values are literal', () => {
    const s = newSession();
    const weird = ['a+b(c)*[d]$^.?|\\e', '.*', '(?<x>y)', '{{', 'back\\slash'];
    assert.doesNotThrow(() => s.addCustom('CUSTOM', weird));
    const r = s.sanitize('pre a+b(c)*[d]$^.?|\\e mid back\\slash end aaaa');
    assert.equal(r.error, null);
    assert.ok(!r.output.includes('a+b(c)'));
    assert.ok(!r.output.includes('back\\slash'));
    assert.ok(r.output.endsWith('end aaaa'), '".*" must not match arbitrary text: ' + r.output);
  });

  test('custom value that is a fragment of token syntax cannot corrupt emitted tokens', () => {
    const s = newSession();
    s.addCustom('CUSTOM', ['_1}}', '{{', 'HOST']);
    s.addCustom('HOST', ['zeta-host']);
    const r = s.sanitize('on zeta-host');
    assert.equal(r.output, 'on {{HOST_1}}');
  });

  test('invalid custom list type throws', () => {
    assert.throws(() => newSession().addCustom('IP', ['x']), /Invalid custom list type/);
  });
});

describe('email and URL', () => {
  test('email emits one EMAIL token and learns user + domain', () => {
    const s = newSession();
    const r = s.sanitize('contact mlopez@corp.example now; mlopez logged into corp.example later');
    const em = tokenFor(s, 'EMAIL', 'mlopez@corp.example');
    const u = tokenFor(s, 'USER', 'mlopez');
    const d = tokenFor(s, 'DOMAIN', 'corp.example');
    assert.ok(em && u && d);
    assert.equal(r.output, 'contact ' + em + ' now; ' + u + ' logged into ' + d + ' later');
    assert.equal(tokensIn(r.output).filter((t) => t.startsWith('{{EMAIL')).length, 1);
  });

  test('email stats count one replacement, not three', () => {
    const r = newSession().sanitize('mail mlopez@corp.example');
    assert.deepEqual(r.stats.byType, { EMAIL: 1 });
    assert.equal(r.stats.total, 1);
  });

  test('email already-learned parts do not fragment the address', () => {
    const s = newSession();
    s.addCustom('USER', ['mlopez']);
    s.addCustom('DOMAIN', ['corp.example']);
    const r = s.sanitize('mlopez@corp.example');
    assert.match(r.output, /^\{\{EMAIL_\d+\}\}$/);
  });

  test('URL emits one token and its host is learned and replaced elsewhere', () => {
    const s = newSession();
    const r = s.sanitize('GET https://files.tgl.example.com/a?b=c done; then ping files.tgl.example.com');
    const url = tokenFor(s, 'URL', 'https://files.tgl.example.com/a?b=c');
    assert.ok(url);
    assert.ok(!r.output.includes('files.tgl'));
    assert.ok(r.output.startsWith('GET ' + url + ' done; then ping {{'));
    assert.equal(tokensIn(r.output).filter((t) => t.startsWith('{{URL')).length, 1);
  });

  test('URL trailing sentence punctuation is not part of the URL', () => {
    const s = newSession();
    const r = s.sanitize('see https://a.example.com/p. Also (https://a.example.com/p)');
    assert.equal(r.output, 'see {{URL_1}}. Also ({{URL_1}})');
  });

  test('URL with IP host learns an IP (not a DOMAIN) token', () => {
    const s = newSession();
    const r = s.sanitize('http://10.9.8.7/x then 10.9.8.7');
    assert.equal(r.output, '{{URL_1}} then {{IP_1}}');
  });

  test('URL with single-label host learns HOST', () => {
    const s = newSession();
    const r = s.sanitize('http://intranet-box/wiki and intranet-box');
    assert.equal(r.output, '{{URL_1}} and {{HOST_1}}');
  });
});

describe('paths', () => {
  test('Windows user segment only; filename and extension kept', () => {
    const { result, session } = run('C:\\Users\\kpatel\\Desktop\\report.final.xlsx');
    const t = tokenFor(session, 'USER', 'kpatel');
    assert.equal(result.output, 'C:\\Users\\' + t + '\\Desktop\\report.final.xlsx');
  });

  test('Windows path case-insensitive (c:\\users\\...) and trailing args preserved', () => {
    const { result } = run('dir c:\\users\\kpatel\\x and type C:\\Users\\kpatel > out.txt');
    assert.equal(result.output, 'dir c:\\users\\{{USER_1}}\\x and type C:\\Users\\{{USER_1}} > out.txt');
  });

  test('Windows user segment with a space ("Jane Roe")', () => {
    const { result } = run('C:\\Users\\Jane Roe\\Documents\\a.docx');
    assert.equal(result.output, 'C:\\Users\\{{USER_1}}\\Documents\\a.docx');
  });

  test('POSIX /home and /Users segments', () => {
    const { result } = run('/home/alice/.ssh/id_rsa and /Users/bobm/Library/x.plist');
    assert.equal(result.output, '/home/{{USER_1}}/.ssh/id_rsa and /Users/{{USER_2}}/Library/x.plist');
  });

  test('UNC host replaced when learned', () => {
    const { result } = run(JSON.stringify({ hostname: 'WKS-UNC-01', CommandLine: 'copy \\\\WKS-UNC-01\\c$\\temp\\a.txt .' }));
    assert.equal(JSON.parse(result.output).CommandLine, 'copy \\\\{{HOST_1}}\\c$\\temp\\a.txt .');
  });

  test('USER field CORP\\name also learns the bare name', () => {
    const { result } = run(JSON.stringify({ UserName: 'CORP\\rgarcia', msg: 'rgarcia logged on' }));
    assert.ok(!result.output.includes('rgarcia'));
  });
});

describe('regex detectors', () => {
  test('IPv4 with an octet > 255 is not matched; valid one is', () => {
    const { result } = run('a 300.1.2.3 b 256.256.256.256 c 10.0.0.255');
    assert.equal(result.output, 'a 300.1.2.3 b 256.256.256.256 c {{IP_1}}');
  });

  test('IPv4 inside a longer dotted version string is not matched', () => {
    const { result } = run('ver 1.2.3.4.5 and 10.0.0.1.');
    assert.equal(result.output, 'ver 1.2.3.4.5 and {{IP_1}}.');
  });

  test('IPv6 full form', () => {
    const { result } = run('src 2001:0db8:85a3:0000:0000:8a2e:0370:7334 end');
    assert.equal(result.output, 'src {{IP_1}} end');
  });

  test('IPv6 compressed forms are whole tokens (previously leaked prefix)', () => {
    const { result } = run('fe80::1 2001:db8::8a2e:370:7334 ::1 ::ffff:10.0.0.1');
    assert.equal(result.output, '{{IP_1}} {{IP_2}} {{IP_3}} {{IP_4}}');
  });

  test('timestamps and PowerShell :: are not IPv6', () => {
    const t = 'at 2026-09-30 14:22:10 ok; [Math]::Abs(1); [System.Text.Encoding]::UTF8; 12:30';
    assert.equal(run(t).result.output, t);
  });

  test('MAC in three notations', () => {
    const { result } = run('aa:bb:cc:dd:ee:f1 AA-BB-CC-DD-EE-F2 aabb.ccdd.eef3');
    assert.equal(result.output, '{{MAC_1}} {{MAC_2}} {{MAC_3}}');
  });

  test('SID and UUID', () => {
    const { result } = run('S-1-5-21-123-456-789-1104 / 123e4567-e89b-42d3-a456-426614174000');
    assert.equal(result.output, '{{SID_1}} / {{ID_1}}');
  });

  test('version strings and file names are not tokenized', () => {
    const t = 'v1.2.3 10.0.19045 svchost.exe System.Management.Automation.dll update.ps1 build.example.xyz';
    assert.equal(run(t).result.output, t);
  });

  test('FQDN only with allow-listed TLD', () => {
    const { result } = run('srv.example.com x.y.local a.b.corp c.d.internal e.example.xyz f.example.zip');
    assert.equal(result.output, '{{DOMAIN_1}} {{DOMAIN_2}} {{DOMAIN_3}} {{DOMAIN_4}} e.example.xyz f.example.zip');
  });

  test('phone formats', () => {
    const { result } = run('call 555-123-4567 or +14155550123, (555) 123-4567');
    assert.equal(result.output, 'call {{PHONE_1}} or {{PHONE_2}}, {{PHONE_3}}');
  });

  test('hashes untouched', () => {
    const t = 'sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 md5 d41d8cd98f00b204e9800998ecf8427e';
    assert.equal(run(t).result.output, t);
  });
});

describe('id key rule', () => {
  test('`id` tokenized only for UUID or >=16 hex', () => {
    const { result } = run(JSON.stringify({
      a: { id: '123e4567-e89b-42d3-a456-426614174000' },
      b: { id: '0123456789abcdef' },
      c: { id: '0123456789abcde' },
      d: { id: 'alert-17' },
      e: { id: 1234567 }
    }));
    const o = JSON.parse(result.output);
    assert.match(o.a.id, TOKEN_RE);
    assert.match(o.b.id, TOKEN_RE);
    assert.equal(o.c.id, '0123456789abcde');
    assert.equal(o.d.id, 'alert-17');
    assert.equal(o.e.id, 1234567);
  });
});

describe('idempotence', () => {
  for (const name of Object.keys(ORACLE)) {
    test(name + ': sanitizing sanitized output is a no-op (same + fresh session)', () => {
      const s = newSession();
      const r1 = s.sanitize(readSample(name));
      const r2 = s.sanitize(r1.output);
      assert.equal(r2.output, r1.output);
      assert.equal(r2.stats.total, 0);
      const r3 = newSession().sanitize(r1.output);
      assert.equal(r3.output, r1.output);
    });
  }
});

describe('leak check', () => {
  test('unlearned UNC host slips past detectors -> reported; add to custom list -> gone', () => {
    const s = newSession();
    const input = JSON.stringify({ CommandLine: 'robocopy D:\\data \\\\FILESRV-09\\finance /E' });
    const r1 = s.sanitize(input);
    assert.ok(r1.output.includes('FILESRV-09'));
    const leak = r1.leaks.find((l) => l.value === 'FILESRV-09');
    assert.ok(leak, 'expected leak report, got ' + JSON.stringify(r1.leaks));
    assert.equal(leak.type, 'HOST');
    assert.ok(leak.context.includes('FILESRV-09'));
    s.addCustom(leak.type, [leak.value]);
    const r2 = s.sanitize(input);
    assert.ok(!r2.output.includes('FILESRV-09'));
    assert.deepEqual(r2.leaks, []);
  });

  test('bare hostname in free text with empty custom list is NOT detectable (documented limitation)', () => {
    const r = newSession().sanitize('login from LAPTOP-QX12 failed');
    assert.equal(r.output, 'login from LAPTOP-QX12 failed');
    assert.deepEqual(r.leaks, []);
  });

  test('HOST toggle off: host label before a domain token is left and not reported (user opted out)', () => {
    const r = newSession().sanitize(JSON.stringify({ domain: 'example.corp', m: 'fileserver01.example.corp' }), { enabled: { HOST: false } });
    assert.equal(JSON.parse(r.output).m, 'fileserver01.{{DOMAIN_1}}');
    assert.deepEqual(r.leaks, []); // HOST disabled -> user opted out
  });

  test('leak check sees through JSON escaping (scans string leaves, not stringified output)', () => {
    const s = newSession();
    // In stringified JSON output this UNC path reads \\\\NAS-ARCHIVE; scanning the
    // decoded string leaves must still find it.
    const r = s.sanitize(JSON.stringify({ a: '\\\\NAS-ARCHIVE\\x' }));
    assert.ok(r.leaks.some((l) => l.value === 'NAS-ARCHIVE'));
  });
});

describe('known suspect: FQDN host label next to a learned domain', () => {
  test('fileserver01.example.corp with example.corp learned from a DOMAIN field', () => {
    const s = newSession();
    const r = s.sanitize(JSON.stringify({
      MachineDomain: 'example.corp',
      CommandLine: 'net use \\\\fileserver01.example.corp\\share',
      Desc: 'contacting fileserver01.example.corp.'
    }));
    const o = JSON.parse(r.output);
    assert.ok(!r.output.toLowerCase().includes('fileserver01'), r.output);
    const h = tokenFor(s, 'HOST', 'fileserver01');
    const d = tokenFor(s, 'DOMAIN', 'example.corp');
    assert.equal(o.CommandLine, 'net use \\\\' + h + '.' + d + '\\share');
    assert.equal(o.Desc, 'contacting ' + h + '.' + d + '.');
    assert.deepEqual(r.leaks, []);
  });

  test('crowdstrike sample: CommandLine/DetectDescription no longer leak fileserver01', () => {
    const r = newSession().sanitize(readSample('crowdstrike_detection.json'));
    const o = JSON.parse(r.output);
    assert.match(o.CommandLine, /-Server \{\{HOST_\d+\}\}\.\{\{DOMAIN_1\}\} /);
    assert.match(o.DetectDescription, /contacting \{\{HOST_\d+\}\}\.\{\{DOMAIN_1\}\}\.$/);
  });

  test('multi-label prefix a.b.example.corp', () => {
    const s = newSession();
    const r = s.sanitize(JSON.stringify({ domain: 'example.corp', m: 'db1.east.example.corp' }));
    assert.match(JSON.parse(r.output).m, /^\{\{HOST_\d+\}\}\.\{\{DOMAIN_1\}\}$/);
  });
});

describe('adversarial inputs', () => {
  test('empty string', () => {
    const r = newSession().sanitize('');
    assert.equal(r.output, '');
    assert.equal(r.error, null);
    assert.equal(r.records, 0);
    assert.deepEqual(r.leaks, []);
  });

  test('null / undefined / non-string input does not throw', () => {
    const s = newSession();
    assert.equal(s.sanitize(undefined).output, '');
    assert.equal(s.sanitize(null).output, '');
    assert.equal(s.sanitize(12345).output, '12345');
  });

  test('whitespace only', () => {
    const r = newSession().sanitize('  \n\t \r\n');
    assert.equal(r.error, null);
    assert.equal(r.records, 0);
    assert.equal(r.output.trim(), '');
  });

  test('very long single line (1 MB) raw text and JSON value', () => {
    const filler = 'x'.repeat(1024 * 1024);
    const t0 = Date.now();
    const r = newSession().sanitize('10.1.1.1 ' + filler + ' jdoe@example.corp');
    assert.ok(r.output.startsWith('{{IP_1}} '));
    assert.ok(r.output.endsWith(' {{EMAIL_1}}'));
    const r2 = newSession().sanitize(JSON.stringify({ CommandLine: filler + ' 10.2.2.2 ' + filler }));
    assert.ok(!r2.output.includes('10.2.2.2'));
    assert.ok(Date.now() - t0 < 20000, 'too slow');
  });

  test('many records with many learned values completes in reasonable time', () => {
    const recs = [];
    for (let i = 0; i < 2000; i++) {
      recs.push(JSON.stringify({ ComputerName: 'WKS-' + i, UserName: 'u' + i, CommandLine: 'run by u' + (i % 50) + ' on WKS-' + (i % 50) }));
    }
    const t0 = Date.now();
    const r = newSession().sanitize(recs.join('\n'));
    assert.equal(r.records, 2000);
    assert.ok(!/WKS-\d/.test(r.output));
    assert.ok(Date.now() - t0 < 15000, 'took ' + (Date.now() - t0) + 'ms');
  });

  test('moderately nested JSON (depth 500) is walked', () => {
    const d = 500;
    const t = '{"a":'.repeat(d) + '{"ip":"10.3.3.3"}' + '}'.repeat(d);
    const r = newSession().sanitize(t);
    assert.equal(r.format, 'json');
    assert.ok(!r.output.includes('10.3.3.3'));
  });

  test('extremely nested JSON (depth 20000) does not throw and does not leak', () => {
    const d = 20000;
    const t = '{"a":'.repeat(d) + '"10.3.3.3"' + '}'.repeat(d);
    let r;
    assert.doesNotThrow(() => { r = newSession().sanitize(t); });
    assert.ok(r.error || r.warning, 'user-facing message expected');
    assert.ok(!r.output.includes('10.3.3.3'));
  });

  test('unicode usernames: case-insensitive, boundaries, paths', () => {
    const s = newSession();
    const r = s.sanitize(JSON.stringify({
      UserName: 'jörg.müller',
      a: 'JÖRG.MÜLLER logged in',
      b: 'C:\\Users\\jörg.müller\\Desktop\\x.txt',
      c: 'jörg.müllerß is someone else',
      d: '用户 李雷 /home/李雷/x'
    }));
    const o = JSON.parse(r.output);
    const t = tokenFor(s, 'USER', 'jörg.müller');
    assert.equal(o.a, t + ' logged in');
    assert.equal(o.b, 'C:\\Users\\' + t + '\\Desktop\\x.txt');
    assert.equal(o.c, 'jörg.müllerß is someone else');
    assert.ok(!o.d.includes('/home/李雷'));
    assert.ok(o.d.includes('用户'));
  });

  test('keys that collide with token syntax are kept; no token collision', () => {
    const s = newSession();
    const r = s.sanitize(JSON.stringify({ '{{HOST_1}}': 'plain', hostname: 'WKS-KEY-1' }));
    const o = JSON.parse(r.output);
    assert.equal(o['{{HOST_1}}'], 'plain');
    assert.notEqual(o.hostname, '{{HOST_1}}');
    assert.match(o.hostname, /^\{\{HOST_\d+\}\}$/);
  });

  test('value that is literally "{{HOST_1}}" passes through and is never reused for a real host', () => {
    const s = newSession();
    const r = s.sanitize(JSON.stringify({ hostname: '{{HOST_1}}', ComputerName: 'WKS-REAL-1', m: 'seen {{HOST_1}}' }));
    const o = JSON.parse(r.output);
    assert.equal(o.hostname, '{{HOST_1}}');
    assert.equal(o.m, 'seen {{HOST_1}}');
    assert.notEqual(o.ComputerName, '{{HOST_1}}');
    assert.ok(!s.exportLegend().entries.some((e) => e.original === '{{HOST_1}}'));
  });

  test('empty / whitespace field values are not tokenized', () => {
    const { result, session } = run(JSON.stringify({ UserName: '', ComputerName: '   ', ip: '' }));
    assert.deepEqual(JSON.parse(result.output), { UserName: '', ComputerName: '   ', ip: '' });
    assert.equal(session.exportLegend().entries.length, 0);
  });

  test('prototype-ish keys are treated as plain data', () => {
    const r = newSession().sanitize('{"__proto__":{"hostname":"WKS-PROTO"},"constructor":"10.5.5.5"}');
    assert.equal(r.error, null);
    assert.ok(!r.output.includes('WKS-PROTO'));
    assert.ok(!r.output.includes('10.5.5.5'));
  });

  test('clear() resets counters and dictionary', () => {
    const s = newSession();
    s.addCustom('HOST', ['WKS-C']);
    s.sanitize('WKS-C 10.0.0.1');
    s.clear();
    assert.equal(s.exportLegend().entries.length, 0);
    assert.equal(s.sanitize('WKS-C 10.0.0.9').output, 'WKS-C {{IP_1}}');
  });
});
