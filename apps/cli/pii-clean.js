#!/usr/bin/env node
'use strict';
/*
 * pii-clean.js — tiny Node CLI host for the shared PII sanitizer core.
 *
 * Usage:
 *   node apps/cli/pii-clean.js [--legend-in legend.json] [--legend-out legend.json]
 *                              [--disable TYPE,TYPE] [--quiet] [file ...]
 *
 * Reads one or more files, or stdin if none are given, and sanitizes all of them
 * with ONE shared session, so the same real-world value gets the same token across
 * every file in the run. Sanitized output goes to stdout; possible leaks go to stderr.
 *
 * Exit codes: 0 = ok, 1 = a file/legend could not be read or written,
 *             2 = ok, but one or more possible leaks were reported (stderr has details).
 *
 * No dependencies: Node core modules only.
 */
const fs = require('fs');
const path = require('path');

const PIISanitizer = require(path.join(__dirname, '..', '..', 'core', 'sanitizer.js'));

const USAGE = [
  'Usage: node apps/cli/pii-clean.js [options] [file ...]',
  '',
  'Reads one or more files (or stdin, if no files are given), sanitizes them with',
  'one shared session so tokens stay consistent across files, and writes sanitized',
  'output to stdout. With more than one file (and without --quiet), each file\'s',
  'output is preceded by a "// ==== <filename> ====" line. Possible leaks are',
  'reported on stderr, never mixed into stdout.',
  '',
  'Options:',
  '  --legend-in <file>   import a legend JSON exported earlier, so previously-seen',
  '                        values get the same tokens again',
  '  --legend-out <file>  export the session legend as JSON after processing',
  '  --disable TYPE,TYPE  comma-separated PII types to leave untouched (e.g. IP,PHONE)',
  '  --quiet              suppress file separators, warnings, and summary lines on stderr',
  '  -h, --help           show this help',
  '',
  'Exit codes: 0 ok, 1 a file/legend could not be read or written, 2 possible leaks found.'
].join('\n');

function parseArgs(argv) {
  const opts = { legendIn: null, legendOut: null, disable: [], quiet: false, files: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--legend-in') { opts.legendIn = argv[++i]; } else if (a === '--legend-out') {
      opts.legendOut = argv[++i];
    } else if (a === '--disable') {
      opts.disable = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--quiet') {
      opts.quiet = true;
    } else if (a === '-h' || a === '--help') {
      opts.help = true;
    } else if (a === '--') {
      opts.files.push(...argv.slice(i + 1));
      break;
    } else {
      opts.files.push(a);
    }
  }
  return opts;
}

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
    return;
  }

  const enabled = {};
  opts.disable.forEach((t) => { enabled[t] = false; });

  const session = PIISanitizer.createSession();

  if (opts.legendIn) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(opts.legendIn, 'utf8'));
    } catch (e) {
      process.stderr.write('pii-clean: could not read --legend-in ' + opts.legendIn + ': ' + e.message + '\n');
      process.exit(1);
      return;
    }
    try {
      const r = session.importLegend(json);
      if (!opts.quiet) {
        process.stderr.write('pii-clean: legend-in: imported ' + r.imported + ', skipped ' + r.skipped + '\n');
      }
    } catch (e) {
      process.stderr.write('pii-clean: invalid --legend-in ' + opts.legendIn + ': ' + e.message + '\n');
      process.exit(1);
      return;
    }
  }

  let inputs;
  if (opts.files.length === 0) {
    let text;
    try {
      text = readStdin();
    } catch (e) {
      process.stderr.write('pii-clean: could not read stdin: ' + e.message + '\n');
      process.exit(1);
      return;
    }
    inputs = [{ name: '(stdin)', text: text }];
  } else {
    inputs = [];
    for (const f of opts.files) {
      try {
        inputs.push({ name: f, text: fs.readFileSync(f, 'utf8') });
      } catch (e) {
        process.stderr.write('pii-clean: could not read ' + f + ': ' + e.message + '\n');
        process.exit(1);
        return;
      }
    }
  }

  const multi = inputs.length > 1;
  const outParts = [];
  const leakLines = [];
  let anyLeaks = false;

  inputs.forEach((input) => {
    const result = session.sanitize(input.text, { enabled: enabled, filename: input.name });

    if (multi && !opts.quiet) {
      outParts.push('// ==== ' + input.name + ' ====\n' + result.output);
    } else {
      outParts.push(result.output);
    }

    if (result.error) {
      process.stderr.write('pii-clean: ' + input.name + ': error: ' + result.error + '\n');
    } else if (result.warning && !opts.quiet) {
      process.stderr.write('pii-clean: ' + input.name + ': warning: ' + result.warning + '\n');
    }

    if (result.leaks && result.leaks.length) {
      anyLeaks = true;
      result.leaks.forEach((leak) => {
        leakLines.push(input.name + ': [' + leak.type + '] ' + leak.value);
      });
    }
  });

  process.stdout.write(outParts.join('\n') + '\n');

  if (leakLines.length) {
    process.stderr.write('pii-clean: ' + leakLines.length + ' possible leak(s):\n');
    leakLines.forEach((l) => process.stderr.write('  ' + l + '\n'));
  }

  if (opts.legendOut) {
    try {
      fs.writeFileSync(opts.legendOut, JSON.stringify(session.exportLegend(), null, 2) + '\n');
    } catch (e) {
      process.stderr.write('pii-clean: could not write --legend-out ' + opts.legendOut + ': ' + e.message + '\n');
      process.exit(1);
      return;
    }
  }

  process.exit(anyLeaks ? 2 : 0);
}

main();
