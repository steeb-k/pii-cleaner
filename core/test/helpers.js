'use strict';
// Shared helpers for the PII Cleaner test suite. All data is fictional.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const S = require(path.join(ROOT, 'core', 'sanitizer.js'));

function readSample(name) {
  return fs.readFileSync(path.join(ROOT, 'samples', name), 'utf8');
}

function newSession() {
  return S.createSession();
}

// Sanitize `text` in a fresh session (or the given one) with optional enabled map.
function run(text, opts, session) {
  const s = session || S.createSession();
  return { session: s, result: s.sanitize(text, opts || {}) };
}

function tokenFor(session, type, original) {
  const lc = String(original).toLowerCase();
  const ci = ['HOST', 'USER', 'DOMAIN', 'OU', 'EMAIL'].includes(type);
  const e = session.exportLegend().entries.find(
    (x) => x.type === type && (ci ? String(x.original).toLowerCase() === lc : x.original === original)
  );
  return e ? e.token : undefined;
}

function tokensIn(text) {
  return (String(text).match(/\{\{[A-Z]+_\d+\}\}/g) || []);
}

// Minimal RFC4180 CSV parser (handles quotes, doubled quotes, embedded commas/newlines).
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

module.exports = { ROOT, S, readSample, newSession, run, tokenFor, tokensIn, parseCSV };
