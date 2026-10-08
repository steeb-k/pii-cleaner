'use strict';
// Tests for the apps/cli pii-clean.js host. All test data is fictional.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../..');
const CLI = path.join(ROOT, 'apps', 'cli', 'pii-clean.js');

function run(args, opts) {
  return spawnSync('node', [CLI, ...args], Object.assign({ encoding: 'utf8' }, opts || {}));
}

describe('apps/cli/pii-clean.js', () => {
  test('sanitizes a sample file given as an argument', () => {
    const sample = path.join(ROOT, 'samples', 'crowdstrike_detection.json');
    const r = run([sample]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\{\{HOST_1\}\}/);
    assert.doesNotMatch(r.stdout, /WKS-FIN-042/);
  });

  test('stdin mode: reads and sanitizes piped input with no file args', () => {
    const r = run([], { input: JSON.stringify({ ComputerName: 'WKS-1', UserName: 'jdoe' }) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\{\{HOST_1\}\}/);
    assert.match(r.stdout, /\{\{USER_1\}\}/);
  });

  test('--legend-out writes a legend JSON with entries', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-cli-'));
    const legendPath = path.join(tmp, 'legend.json');
    const r = run(['--legend-out', legendPath, '--quiet'], { input: JSON.stringify({ ComputerName: 'WKS-9' }) });
    assert.equal(r.status, 0, r.stderr);
    const legend = JSON.parse(fs.readFileSync(legendPath, 'utf8'));
    assert.equal(legend.version, 1);
    assert.ok(Array.isArray(legend.entries) && legend.entries.length >= 1);
    assert.ok(legend.entries.some((e) => e.type === 'HOST' && e.original === 'WKS-9'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('--legend-in keeps tokens stable across separate runs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-cli-'));
    const legendPath = path.join(tmp, 'legend.json');
    const input = JSON.stringify({ ComputerName: 'WKS-STABLE' });

    const first = run(['--legend-out', legendPath, '--quiet'], { input: input });
    assert.equal(first.status, 0, first.stderr);
    const firstToken = /\{\{HOST_\d+\}\}/.exec(first.stdout)[0];

    const second = run(['--legend-in', legendPath, '--quiet'], { input: input });
    assert.equal(second.status, 0, second.stderr);
    const secondToken = /\{\{HOST_\d+\}\}/.exec(second.stdout)[0];

    assert.equal(secondToken, firstToken);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('exit code 2 when a leak is present (unlearned UNC host in free text)', () => {
    const input = 'robocopy D:\\data \\\\srv-unknown\\share';
    const r = run([], { input: input });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /srv-unknown/);
    assert.match(r.stderr, /possible leak/);
  });

  test('--disable IP leaves IPs intact', () => {
    const r = run(['--disable', 'IP'], { input: JSON.stringify({ ip: '10.1.2.3' }) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /10\.1\.2\.3/);
    assert.doesNotMatch(r.stdout, /\{\{IP_/);
  });

  test('multiple files share one session and print filename separators', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-cli-'));
    const a = path.join(tmp, 'a.json');
    const b = path.join(tmp, 'b.json');
    fs.writeFileSync(a, JSON.stringify({ ComputerName: 'WKS-SHARED' }));
    fs.writeFileSync(b, JSON.stringify({ ComputerName: 'WKS-SHARED', UserName: 'jdoe' }));
    const r = run([a, b]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp('==== ' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' ===='));
    assert.match(r.stdout, new RegExp('==== ' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' ===='));
    const tokens = [...r.stdout.matchAll(/\{\{HOST_(\d+)\}\}/g)].map((m) => m[1]);
    assert.ok(tokens.length >= 2);
    assert.ok(tokens.every((n) => n === tokens[0]), 'same hostname across files must share one token: ' + tokens);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
