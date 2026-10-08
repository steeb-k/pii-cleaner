'use strict';
// Shared helpers for the web app's test suite. All data is fictional.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');
const WEB = path.resolve(__dirname, '..');
const CORE_JS = path.join(ROOT, 'core', 'sanitizer.js');

function readSample(name) {
  return fs.readFileSync(path.join(ROOT, 'samples', name), 'utf8');
}

module.exports = { ROOT, WEB, CORE_JS, readSample };
