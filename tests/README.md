# PII Cleaner tests

Run everything (Node 22+, tested on Node 26; no npm installs):

```sh
node --test tests/
```

Files:

- `sanitizer.test.js` - unit tests for `sanitizer.js` (samples with an independent PII
  oracle, format detection, token stability, legend import/export/CSV, category toggles,
  custom lists, detectors, idempotence, leak check, adversarial inputs).
- `nonetwork.test.js` - static no-network guarantees (exact CSP meta, no remote includes,
  no fetch/XHR/WebSocket/storage/cookie/dialog APIs outside comments) and a runtime check
  that `serve.py` binds 127.0.0.1 only and sends `Cache-Control: no-store`.
- `browser.test.js` - headless Chromium (`/usr/bin/chromium`) driven over the DevTools
  Protocol with Node's built-in `WebSocket`. Loads `index.html` via `file://` and via
  `serve.py`, drives the UI, and asserts no console errors, no CSP violations, and no
  requests other than the four local files. Skipped automatically if no Chromium binary
  is found.
- `helpers.js` - shared helpers (not a test file).

All test data is fictional.
