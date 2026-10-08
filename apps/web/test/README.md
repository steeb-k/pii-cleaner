# PII Cleaner web app tests

These are the tests for the `apps/web` host app only. Core sanitizer logic
is unit-tested separately under `core/test/`. Run everything (Node 22+,
tested on Node 26; no npm installs) from the repo root:

```sh
node --test apps/web/test/
```

Files:

- `nonetwork.test.js` - static no-network guarantees (exact CSP meta, no remote includes,
  no fetch/XHR/WebSocket/storage/cookie/dialog APIs outside comments, scanning
  `core/sanitizer.js`, `apps/web/app.js`, `apps/web/index.html`) and a runtime check
  that `serve.py` binds 127.0.0.1 only and sends `Cache-Control: no-store`.
- `browser.test.js` - headless Chromium (`/usr/bin/chromium`) driven over the DevTools
  Protocol with Node's built-in `WebSocket`. Loads `apps/web/index.html` via `file://` and
  via `serve.py`, drives the UI, and asserts no console errors, no CSP violations, and no
  requests other than the four local files. Skipped automatically if no Chromium binary
  is found, and **not run in CI** for that reason (see `.github/workflows/ci.yml`) &mdash;
  run it locally before release.
- `helpers.js` - shared helpers (not a test file): `ROOT` (repo root), `WEB` (this app's
  directory), `CORE_JS` (path to `core/sanitizer.js`), `readSample`.

All test data is fictional.
