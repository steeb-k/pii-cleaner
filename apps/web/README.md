# Obfuscate &mdash; web app

A local-only, single-page web app that sanitizes CrowdStrike Falcon and
Rapid7 (InsightIDR / InsightVM) JSON logs by replacing PII with typed,
numbered tokens (`{{HOST_1}}`, `{{USER_2}}`, ...), and produces a legend
so the mapping can be kept for later reference (there is no "reverse"
mode in v1 &mdash; see Limitations).

Everything runs in your browser tab. Nothing is uploaded, nothing is
persisted automatically, and there is no server-side processing.

This is one of several host apps built on the shared sanitizer in
[`core/`](../../core/README.md); see the [repo root README](../../README.md)
for the overall project layout, and [`apps/cli/`](../cli/README.md) for the
Node command-line host. This document covers only the web app in
`apps/web/`.

## What it does

- Paste JSON, NDJSON, or raw text, or pick a local file.
- Auto-detects the input shape: single JSON object, JSON array, NDJSON
  (one object per line), or falls back to raw text.
- Recognizes CrowdStrike/Rapid7-style field names (`ComputerName`,
  `UserName`, `MachineDomain`, `LocalAddressIP4`, `aid`/`cid`,
  `hostName`/`hostNames`, `source_ip`, `asset_id`, etc.) and tokenizes
  their values.
- Sweeps every string value (and raw text) with a further set of
  regexes to catch PII that shows up in free text (command lines,
  descriptions, URLs) even outside a recognized field: emails, URLs,
  IPv4/IPv6, MAC addresses, Windows SIDs, GUID/UUIDs, Windows/POSIX
  home-directory usernames, allow-listed FQDNs, and phone numbers.
- Never touches hashes (SHA256/MD5), timestamps, numbers, booleans,
  JSON keys, ports, or process names &mdash; those are left exactly as-is.
- The same real-world value always maps to the same token for the
  whole session, across multiple files/pastes, so you can sanitize a
  whole investigation's worth of logs and keep cross-references intact.
- Builds a legend (token &rarr; original value) you can export as JSON
  or CSV, and re-import later so tokens stay stable across sessions.
- Runs a "leak check" after every sanitize pass: it re-scans the
  *output* with the same detectors to catch anything that slipped
  through, plus any custom-list value still present verbatim.

## How to run

Either works equally well; both are exercised by the test suite. Run both
from the repo root, since `index.html` loads the shared core from
`../../core/sanitizer.js`.

### Option A: plain `file://`

Open `apps/web/index.html` in your browser (double-click it, or
`File > Open`). No server, no build step.

### Option B: local HTTP server

```sh
python3 apps/web/serve.py          # http://127.0.0.1:8080/apps/web/
python3 apps/web/serve.py 8099      # custom port
# or: npm run serve
```

`serve.py` is stdlib-only (`http.server`), binds strictly to
`127.0.0.1` (never `0.0.0.0`, so nothing outside this machine can ever
reach it), serves the **repository root** (regardless of your current
working directory, so the relative `../../core/sanitizer.js` reference
resolves), sends `Cache-Control: no-store` on every response, and prints
the URL to connect to (`http://127.0.0.1:PORT/apps/web/`). `Ctrl+C` stops
it.

### Option C: a deployable static build

```sh
bash scripts/build-web.sh    # writes dist/web/, a flat copy with no relative ../../ paths
```

See the root README's "Deploying the web app" section.

## No-network guarantees, and how to verify them yourself

The app makes zero network requests, by construction:

- `index.html` carries a strict CSP meta tag:
  `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'`.
  This blocks any fetch/XHR/WebSocket/image/font/frame load to
  anywhere other than the page's own origin, even if a bug or a
  pasted log line somehow tried to trigger one.
- There are no `<script src="https://...">`/CDN includes, no fonts,
  no analytics, no service workers. The GitHub link in the header is a plain
  `<a href>` (`rel="noopener noreferrer"`, new tab): nothing is requested
  unless you click it.
- `core/sanitizer.js` and `app.js` contain no `fetch(`, `XMLHttpRequest`,
  `WebSocket`, or URL literals.
- No `localStorage`, `sessionStorage`, `IndexedDB`, or cookies are
  used anywhere; the dictionary/legend/inputs live only in JS memory
  for the life of the tab and are gone on reload.

To verify this yourself:

1. **DevTools Network tab.** Open the app (either `file://` or via
   `serve.py`), open DevTools &rarr; Network, clear it, then paste a log,
   toggle categories, click Sanitize, copy/download output, export/
   import a legend, and clear the session. With `serve.py` you should
   see only the handful of local requests for `index.html`,
   `styles.css`, `sanitizer.js`, `app.js` (and any sample file you
   open) &mdash; nothing else, ever. With `file://` the Network tab will
   show nothing at all, since there's no HTTP layer in play.
2. **Static grep check.** From the repo root:
   ```sh
   grep -rnE "https?://|fetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB" core apps --include=*.js --include=*.html
   ```
   This should return nothing but comments, the CSP meta line, and the one
   GitHub project link in the header.

## Token format

`{{TYPE_N}}`, with `N` starting at 1 per type, per session. Types:

```
HOST, USER, DOMAIN, OU, EMAIL, IP, MAC, SID, ID, PATH, URL, PHONE, CUSTOM
```

- `IP` covers both IPv4 and IPv6.
- `ID` covers GUID/UUIDs, CrowdStrike `aid`/`cid`, Rapid7 asset IDs,
  and serial numbers.
- `PATH` is a reserved category for the "user path segment" detector
  (see below) &mdash; whole file paths are never wrapped in a single
  `{{PATH_N}}` token; only the embedded username is replaced.
- Matching is **case-insensitive** for HOST/USER/DOMAIN/EMAIL (`JDOE`
  and `jdoe` share a token); case-sensitive for everything else. The
  legend stores the first-seen original casing.

## Legend workflow

- Every sanitize run updates the in-memory legend (`token, type,
  original, count`).
- **Export JSON** (`{version:1, created, entries:[...]}`) or
  **Export CSV** (`token,type,original,count`) from the Legend tab.
- **Import** a previously exported legend JSON file before sanitizing
  new logs from the same investigation: it pre-seeds the dictionary so
  the *same* original values get the *same* tokens again, and the
  per-type counters resume from the highest `N` already used, so new
  values get fresh, non-colliding tokens.
- The Legend tab has a filter box and sortable columns.

## Category toggles and custom lists

All 12 categories are on by default; uncheck any you don't want
touched. Four free-text lists let you add your own values (one per
line) that get folded into the shared dictionary before the regex
sweep runs, so they're replaced everywhere, including inside free
text: Hostnames, Usernames, Domains, and "Other sensitive strings"
(tokenized as `CUSTOM`).

The Leak check tab lists anything that still looks like PII in the
*output*; each row has an "Add to custom list & re-run" button that
adds that exact value to the right list and re-sanitizes immediately.

## Keyboard

`Ctrl+Enter` / `Cmd+Enter` runs Sanitize from anywhere on the page.

## Samples

`samples/` (repo root) has four synthetic, fictional inputs (no real
hosts, users, or IPs) to exercise every detector in the file picker or
textarea:

- `crowdstrike_detection.json` &mdash; a Falcon `DetectionSummaryEvent`-style
  record.
- `crowdstrike_ndjson.ndjson` &mdash; three NDJSON records sharing one
  hostname, to show dedup/token-stability across records.
- `rapid7_idr_alert.json` &mdash; a synthetic InsightIDR alert/investigation.
- `rapid7_vm_asset.json` &mdash; a synthetic InsightVM asset (`hostName`/
  `hostNames`, `addresses`, `osFingerprint`, `ids`).

To sanitize one from the command line instead of a browser, use the CLI
host in [`apps/cli/`](../cli/README.md), or embed `core/` directly &mdash;
see [`core/README.md`](../../core/README.md) for the API.

## Tests

From the repo root:

```sh
node --test "apps/web/test/*.test.js"    # or: npm run test:web
```

This app's tests are `nonetwork.test.js` (static no-network checks plus
a live `serve.py` check) and `browser.test.js` (a headless Chromium run,
DevTools Protocol, no installs, that drives the UI end to end and
asserts zero foreign requests and zero CSP violations). `browser.test.js`
needs a Chromium binary (`/usr/bin/chromium` or similar) and is **not**
run in CI (see `.github/workflows/ci.yml`) &mdash; it is skipped
automatically wherever no Chromium binary is found, and should be run
locally before release. Core sanitizer logic is unit-tested separately
under `core/test/`.

## Limitations (v1, by design &mdash; see docs/SPEC.md "Non-goals")

- No reverse mode (restoring original values from tokens).
- No timestamp shifting; timestamps are left untouched.
- No private/public IP distinction.
- No server-side processing of any kind.
- Detection is regex/field-name based, not a full NLP/NER model: a bare
  username or hostname mentioned in free text that was never seen in a
  recognized field, custom list, or structured pattern (email/URL/UNC
  path/etc.) cannot be found by magic. Add it to a custom list if you
  know about it ahead of time, or use the Leak check tab's "Add to
  custom list & re-run" action once you spot it.
- The `FQDN` free-text detector only tokenizes dotted hostnames whose
  final label is in a short TLD allow-list (`com`, `net`, `org`,
  `local`, `lan`, `corp`, `internal`, `io`, `edu`, `gov`, `mil`, `co`,
  `uk`, `de`) to avoid false positives on version numbers and file
  names like `svchost.exe`. A domain outside that allow-list that
  hasn't otherwise been learned (e.g. from a mapped field) will not be
  auto-detected in free text.
- IPv6 detection covers full, `::`-compressed, and embedded-IPv4 forms.
  Timestamps (`14:22:10`) and PowerShell `[Math]::Abs` are not matched.
- Invalid JSON is still sanitized as raw text, with an inline warning
  naming the parse error (and the line, for NDJSON).
- Custom lists only grow within a session: removing a line from a
  textarea does not un-learn the value until you Clear the session.
- Boundaries are word-boundary (`\b`) style, so a learned `CORP` will
  also match inside `CORP-WKS-01`. Very short learned values (e.g. a
  one-letter email local part) can over-match; check the Leak and
  Legend tabs if a token looks surprising.
- The IP field key `address` will also tokenize a street address.
- The CSV legend writes originals verbatim. If one starts with `=`,
  `+`, `-` or `@`, a spreadsheet may treat it as a formula; open the
  CSV as text or use the JSON export instead.
- Phone-number detection is intentionally conservative (common
  separated US formats and `+`-prefixed E.164) to avoid false
  positives on IDs/hashes/timestamps.
