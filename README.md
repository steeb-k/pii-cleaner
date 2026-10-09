# PII Cleaner

A local-only PII sanitizer for CrowdStrike Falcon and Rapid7 (InsightIDR /
InsightVM) logs: it replaces hostnames, usernames, domains, emails, IPs,
and more with typed, numbered tokens (`{{HOST_1}}`, `{{USER_2}}`, ...),
and keeps a legend so the mapping can be reused across files and sessions.
Everything runs on your machine; nothing is ever uploaded anywhere.

## Architecture: one core, several host apps

```
core/        pure, dependency-free sanitization logic (the product)
apps/
  web/       single-page browser UI               (shipping)
  cli/       tiny Node command-line tool           (shipping)
  macos/     "Obfuscate": SwiftUI menu-bar app, via JavaScriptCore (shipping)
```

All the actual PII-detection behavior &mdash; field recognition, the regex
sweep, the legend, the leak check &mdash; lives in **`core/sanitizer.js`**
and nowhere else. It's plain ES2020 with zero npm dependencies and no DOM,
Node, or browser-specific globals (no `window`, `document`, `require`,
`process`, `Buffer`, network or storage calls). That's a deliberate design
choice, not an accident: it's what lets the *same, unmodified* file run
as-is in three completely different JS hosts:

- **Node** &mdash; `require('./core/sanitizer.js')` picks it up via
  `module.exports`.
- **Browser** &mdash; a `<script>` tag defines `window.PIISanitizer`.
- **JavaScriptCore** (used by the macOS app) &mdash; has neither
  `module` nor `window`, so the core falls back through `globalThis` (and
  then `self`/`this`) to attach itself, giving `globalThis.PIISanitizer`
  with zero shimming.

Each host app in `apps/` is just UI/plumbing around that one core: it
collects input from wherever is natural for that platform (a textarea and
file picker, stdin/argv, the clipboard and drag-and-drop), calls
`createSession()` / `session.sanitize()`, and presents the result. None of
them re-implement or fork the detection logic, so a fix or new detector in
`core/` benefits every host app at once, and there's exactly one place to
audit for correctness.

See [`core/README.md`](core/README.md) for the full API contract, and
[`docs/SPEC.md`](docs/SPEC.md) for the detailed design spec (detection
pipeline order, field maps, token rules, non-goals).

## Repo layout

| Path | What |
|---|---|
| `core/` | Shared sanitizer (`sanitizer.js`), its own unit tests, its API README |
| `apps/web/` | Browser UI: `index.html`, `app.js`, `styles.css`, `serve.py`, tests |
| `apps/cli/` | `pii-clean.js` Node CLI, tests |
| `apps/macos/` | Obfuscate: SwiftUI + JavaScriptCore menu-bar app (SwiftPM package, sandboxed, tests, `build-app.sh`) |
| `samples/` | Synthetic CrowdStrike/Rapid7 fixtures, fictional values only |
| `docs/SPEC.md` | Design spec: detection pipeline, field maps, token/case rules |
| `scripts/build-web.sh` | Builds `dist/web/`, a flat deployable copy of the web app |
| `.github/workflows/ci.yml` | Runs the test suite (minus headless-Chromium tests) on push/PR |
| `.github/workflows/release.yml` | Tag-driven release: signed + notarized universal macOS build, GitHub release (`docs/ci-release.md`) |
| `scripts/ci/`, `scripts/notarize-macos.sh` | CI keychain import and notarization helpers used by `release.yml` |

## Quick start

### Web app

```sh
python3 apps/web/serve.py        # -> http://127.0.0.1:8080/apps/web/
# or just open apps/web/index.html directly (file://, no server needed)
```

### CLI

```sh
echo '{"ComputerName":"WKS-1","UserName":"jdoe"}' | node apps/cli/pii-clean.js
```

See [`apps/cli/README.md`](apps/cli/README.md) for flags (`--legend-in`/
`--legend-out`, `--disable`, `--quiet`) and exit codes.

### macOS app (Obfuscate)

```sh
bash apps/macos/build-app.sh --open   # -> dist/macos/Obfuscate.app (menu-bar only)
```

Needs Xcode command-line tools (Swift 5.9+). See
[`apps/macos/README.md`](apps/macos/README.md) for details (SwiftUI menu bar,
JavaScriptCore bridge, App Sandbox; the only networking is the in-app updater's
check of GitHub releases).

## Running the tests

```sh
npm test            # everything: core + web (static/runtime, not headless Chromium) + cli
npm run test:core    # core/test/        - sanitizer unit tests
npm run test:web     # apps/web/test/    - no-network statics + serve.py + headless Chromium
npm run test:cli     # apps/cli/test/    - CLI behavior
npm run test:macos   # apps/macos/Tests/ - Swift bridge, JSC-vs-Node parity, no-network (needs Xcode; not in npm test)
```

(Equivalently: `node --test "core/test/*.test.js" "apps/web/test/*.test.js" "apps/cli/test/*.test.js"`.)

`apps/web/test/browser.test.js` drives a headless Chromium instance over
the DevTools Protocol and needs a Chromium binary (`/usr/bin/chromium` or
similar) on `PATH`; it's skipped automatically if none is found, and is
**not run in CI** for that reason &mdash; run it locally before a release.
Everything else (`core/test/`, `apps/web/test/nonetwork.test.js`,
`apps/cli/test/`) has no such dependency and is what CI runs.

## Deploying the web app

The web app's `index.html` references the core via a relative
`../../core/sanitizer.js` path, which only resolves inside this monorepo.
To get a flat, self-contained directory you can drop onto any static host
(e.g. a GitHub Pages folder):

```sh
bash scripts/build-web.sh    # writes dist/web/
# then copy dist/web/*  to your Pages folder (or any static host)
```

`dist/web/` contains `index.html`, `app.js`, `styles.css`, `sanitizer.js`,
`README.md`, and `samples/`, with the script path rewritten so
`sanitizer.js` sits next to `index.html`. It's `.gitignore`d; rebuild it
whenever you deploy.

## Releasing the macOS app

Push a `v<version>` tag matching `CFBundleShortVersionString` in
`apps/macos/Info.plist` (and a `## [<version>]` section in `CHANGELOG.md`).
`.github/workflows/release.yml` tests, builds a universal `Obfuscate.app` on a
hosted Mac, signs it with the Developer ID from the repository secrets,
notarizes and staples it, and publishes one GitHub release with the zip. A
`v<version>-testN` tag makes a prerelease. See [`docs/ci-release.md`](docs/ci-release.md).

## The no-network guarantee

No host app here ever sends a log anywhere, by construction:

- `core/sanitizer.js` touches nothing but its own arguments &mdash; no
  `fetch`, `XMLHttpRequest`, `WebSocket`, storage, or URL literals.
- The web app's `index.html` carries a strict CSP
  (`default-src 'none'; script-src 'self'; ...; connect-src 'none'`) that
  blocks any such attempt even if one slipped in, and `apps/web/serve.py`
  binds to `127.0.0.1` only. Its one outbound reference is the GitHub link
  in the header, which only a click follows.
- The CLI touches only the files you pass it (plus, with `--legend-out`,
  the one legend file you named) and stdin/stdout/stderr.
- The macOS app ships with App Sandbox. Its only networking is the updater
  (`apps/macos/Sources/Obfuscate/Updater.swift`): two GETs to GitHub, at most
  once an hour, to see whether a newer release exists and to download it when
  you say so. Nothing is ever sent. Its tests pin networking to that one file
  and its URLs to GitHub hosts, and CI checks the entitlements
  (`network.client`, never `network.server`); see `apps/macos/README.md`.

Verify it yourself at any time:

```sh
grep -rn "https\?://" core apps --include=*.js --include=*.html --include=*.swift
```

This should return nothing but comments, the web header's GitHub link, and the
updater's GitHub URLs.

## Adding a new host app

Any new host just needs to load `core/sanitizer.js` for its platform (CJS
`require`, a `<script>` tag, or `evaluateScript` for a JS engine) and use
this ten-line contract (full detail in [`core/README.md`](core/README.md)):

```js
const PIISanitizer = require('./core/sanitizer.js'); // or window./globalThis.PIISanitizer
const session = PIISanitizer.createSession();         // one session per batch of related input
const result = session.sanitize(text, { enabled: { IP: false /* etc */ } });
// result: { output, format, records, stats, leaks, warning, error }
session.addCustom('HOST', ['known-host-1', 'known-host-2']); // optional, pre-seed a list
const legend = session.exportLegend();                 // { version, created, entries }
// elsewhere / later / another host app:
otherSession.importLegend(legend);                      // same values -> same tokens
```

Add the new app under `apps/<name>/`, with its own `README.md` and, if it
has automated tests, an `apps/<name>/test/` directory wired into the root
`test` script in `package.json`.
