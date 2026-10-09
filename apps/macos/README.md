# Obfuscate &mdash; the PII Cleaner macOS menu-bar app

**Obfuscate** is a SwiftUI menu-bar app (no Dock icon) that embeds the shared sanitizer in
[`core/`](../../core/README.md) via `JavaScriptCore`, so detection logic is
identical across the web app, the CLI, and this host &mdash; only the UI differs.
Everything is local: the app is sandboxed, and the only thing it ever talks to is GitHub,
to check for and download its own updates.

## Why JavaScriptCore

`core/sanitizer.js` is plain, dependency-free ES2020 with no DOM and no
Node-only globals (see `core/README.md`), and it ends its export tail with
a `globalThis` fallback specifically so a bare `JSContext` (no `window`, no
`module`) still gets `globalThis.PIISanitizer` after evaluating the file.
That means **zero porting work**: no reimplementing the regex and
field-mapping logic in Swift, and no risk of the macOS app's detection
drifting from the web app's.

## Layout

```
Package.swift              SwiftPM package (tools 5.9, Swift 5 language mode, macOS 14+)
Info.plist                 LSUIElement=true (menu-bar only), CFBundleIconFile=AppIcon
Obfuscate.entitlements     app-sandbox + files.user-selected.read-write + network.client (updater) + allow-jit
ObfuscateUpdater.plist     Info.plist of the updater helper (LSUIElement, com.obfuscate.app.updater)
ObfuscateUpdater.entitlements  empty on purpose: the helper runs outside the sandbox
build-app.sh               builds + bundles + ad-hoc signs dist/macos/Obfuscate.app (helper nested inside)
Icons/AppIcon.iconset/     app icon PNGs (16..512 @1x/@2x); build-app.sh turns them into AppIcon.icns
Icons/source/              SVG sources + generate_icons.py for the icon set
Sources/PIICore/           library: JavaScriptCore bridge (Foundation + JavaScriptCore only)
Sources/Obfuscate/         executable: SwiftUI/AppKit UI; Updater.swift is the only file that uses the network
Sources/UpdateInstall/     library: the install half of the updater (signature checks, quarantine, swap); no network
Sources/ObfuscateUpdater/  executable: the unsandboxed helper, Contents/Helpers/ObfuscateUpdater.app in the bundle
Sources/Obfuscate/Resources/  ObfuscateTemplate{,@2x,@3x}.png, the menu-bar template icon
Tests/PIICoreTests/        bridge tests, JSC-vs-Node parity, updater rules, network-confinement and icon-asset checks
```

There is no `.xcodeproj`; everything works from the command line.

## Build, run, test

```sh
swift build --package-path apps/macos
swift test  --package-path apps/macos      # or: npm run test:macos
bash apps/macos/build-app.sh [--open]      # or: npm run build:macos
```

`build-app.sh` writes `dist/macos/Obfuscate.app` and a `ditto` zip next to it
(git-ignored). Set `CONFIGURATION=debug` for a debug build, `OBFUSCATE_UNIVERSAL=1`
for arm64 + x86_64, and `CODESIGN_IDENTITY` to sign with a Developer ID instead
of ad-hoc (`OBFUSCATE_NOTARIZE=1` then notarizes and staples; see `docs/ci-release.md`). Quit the app from its popover, or
`pkill -x Obfuscate`.

## Icons

The app icon lives in `Icons/AppIcon.iconset/` as PNGs; `build-app.sh` runs
`iconutil` on that folder to produce `Contents/Resources/AppIcon.icns`, so
nothing binary beyond the PNGs is committed. The menu-bar icon is
`ObfuscateTemplate.png` (+`@2x`, `@3x`) under `Sources/Obfuscate/Resources/`.
`build-app.sh` copies them flat into `Contents/Resources/` (next to
`sanitizer.js`). Plain `swift build` does not compile asset catalogs, so
`MenuBarIcon.swift` assembles the three PNGs into one template `NSImage` at
runtime (looking in `Contents/Resources/` first, then SwiftPM's dev resource
bundle, then an SF Symbol fallback); being a template, it follows the menu
bar's light/dark tint. When the last sanitize
reported possible leaks, a small warning badge is shown next to it.
SVG sources and the generator script are in `Icons/source/`.

## Where `sanitizer.js` comes from

There is exactly one copy: `core/sanitizer.js`. It is never copied into the
Swift source tree. `build-app.sh` copies it, unmodified, into the app's
`Contents/Resources/` at build time. `CoreScript.locate()` uses
`Bundle.main`'s resource if present, otherwise walks up from the source file
to `<repo>/core/sanitizer.js` (used by tests and dev builds). A test asserts
the resolved file is byte-identical to `core/sanitizer.js`.

## Using it

- **Sanitize clipboard**: reads text from the clipboard, sanitizes it, writes the result back.
- **Drop zone**: drop one or more log files; they share one session so tokens stay consistent.
  Then "Copy all to clipboard" (multiple files are joined with `// ==== <name> ====`
  separators, like the CLI) or "Save…".
- **Leaks** (red) lists possible leftover PII; the menu-bar icon changes when there are any.
- **Types** toggles each PII type; **Custom values** pre-seeds HOST/USER/DOMAIN/CUSTOM lists.
- **Legend**: import/export JSON (same format as the web app and CLI) or export CSV; "Clear session" resets.
- **Install Update**: appears at the top of the popover when a newer release exists (see below).

## Updates

The app checks GitHub for a newer release once at launch and whenever the
popover is opened, at most once an hour (the time of the last check is kept
across launches). At launch a found update is offered in a dialog; from the
popover it is an **Install Update (x.y.z)** button. Either way the same thing
happens: the release zip is downloaded, unpacked with `ditto`, checked (it must
be an `Obfuscate.app` of the expected version, and with a Developer ID build
running, signed by the same team), then handed to the updater helper, which
swaps it into the folder the app lives in and launches the new version after
the old one quits. The check is a GET of
`https://api.github.com/repos/steeb-k/pii-cleaner/releases/latest` (which never
returns a draft or `-testN` prerelease); the download is the
`Obfuscate-<ver>-macos-universal.zip` asset from that release. Nothing is sent.
A failed check is silent; a failed install says why.

The helper exists because of the sandbox. Every file a sandboxed process
writes, including what `ditto` unpacks on the app's behalf, gets a quarantine
attribute with the sandbox flag set, and macOS will not execute a binary that
carries it; the app cannot remove the attribute from inside the sandbox
either. So the app launches `Contents/Helpers/ObfuscateUpdater.app` through
LaunchServices (which gives it its own process, outside the sandbox) with the
staged bundle on its command line, and quits. The helper repeats the bundle
and signature checks (it is the process with the power to put something in
Applications, so it trusts nothing it did not verify), clears the quarantine,
swaps the bundle in, removes the staging directory and relaunches Obfuscate.
It has no entitlements, no networking code and no UI beyond a failure dialog;
`NoNetworkTests` and CI pin all of that. If the app is running translocated
(opened straight from Downloads, never moved), the update asks you to move it
to Applications first. A copy installed by hand from a browser download is
itself quarantined, so its first update may show one Gatekeeper prompt for
the helper; after that install the quarantine is gone for good.

## Sandbox and network story

The entitlements file contains `com.apple.security.app-sandbox`,
`com.apple.security.files.user-selected.read-write`,
`com.apple.security.cs.allow-jit` (JavaScriptCore's JIT under the hardened
runtime of signed builds; executable memory only) and
`com.apple.security.network.client`, which the updater needs for its two GETs
to GitHub. There is no `network.server`. Networking lives in exactly one file,
`Sources/Obfuscate/Updater.swift`, and every URL in the sources is on a GitHub
host; the updater refuses any other host, including on redirects. The nested
updater helper is the one unsandboxed process (see Updates above): it carries
no entitlements and no networking code, and only ever runs during an install.
`NoNetworkTests` pins all of that, and CI checks the built app's and the
helper's entitlements.
Logs are only ever read from the clipboard or dropped files and written back
to the clipboard or where you save them. Dropping a
file grants read access to that file only; sibling directories are **not**
writable, so sanitized files are never written next to the original. Output
goes to the clipboard, or through a save panel (one file) / a folder chooser
(several files, written as `<name>.sanitized.<ext>`, never overwriting
&mdash; existing names get `-2`, `-3`, ...).

## Legend storage

In memory only, until you export it. The export panel defaults to
`~/Library/Application Support/Obfuscate/` (created on demand; inside the
sandbox this is the app container's equivalent). The JSON is exactly the
core's `exportLegend()` output, interchangeable with the web app and CLI.

## Limitations

- No global hotkey in v1; the clipboard flow is button-driven from the popover
  (a Carbon `RegisterEventHotKey` hotkey is a possible follow-up).
- Local builds are ad-hoc signed (`codesign --sign -`), enough for the sandbox to
  apply. Release builds are made by CI from a `v<version>` tag: universal, Developer
  ID signed, notarized and stapled. See `docs/ci-release.md`.
