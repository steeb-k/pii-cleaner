# PII Cleaner &mdash; macOS menu-bar app (plan)

No Xcode project exists yet. This document is the plan for a future
SwiftUI menu-bar host app that embeds the shared sanitizer in
[`core/`](../../core/README.md) via `JavaScriptCore`, so the detection
logic stays identical across the web app, the CLI, and this host &mdash;
only the UI differs.

## Why JavaScriptCore

`core/sanitizer.js` is plain, dependency-free ES2020 with no DOM and no
Node-only globals (see `core/README.md`), and it ends its export tail with
a `globalThis` fallback specifically so a bare `JSContext` (no `window`, no
`module`) still gets `globalThis.PIISanitizer` after evaluating the file.
That means **zero porting work**: no reimplementing 900+ lines of regex
and field-mapping logic in Swift, and no risk of the macOS app's detection
drifting from the web app's.

## Swift bridge sketch (~30 lines)

```swift
import JavaScriptCore

final class PIICore {
    private let ctx: JSContext
    private let sessionObj: JSValue

    init() throws {
        guard let ctx = JSContext() else { throw PIICoreError.contextFailed }
        // Surface JS exceptions and console.log (there should be none at runtime;
        // core/sanitizer.js never calls console.* or throws outside sanitize()'s
        // own try/catch) instead of failing silently.
        ctx.exceptionHandler = { _, exception in
            NSLog("PIICore JS exception: %@", exception?.toString() ?? "?")
        }
        guard let url = Bundle.main.url(forResource: "sanitizer", withExtension: "js"),
              let src = try? String(contentsOf: url, encoding: .utf8) else {
            throw PIICoreError.scriptMissing
        }
        ctx.evaluateScript(src)
        guard let piiSanitizer = ctx.globalObject.objectForKeyedSubscript("PIISanitizer"),
              let createSession = piiSanitizer.objectForKeyedSubscript("createSession"),
              let session = createSession.call(withArguments: []) else {
            throw PIICoreError.apiMissing
        }
        self.ctx = ctx
        self.sessionObj = session
    }

    /// Sanitizes `text` and returns the output plus any possible-leak values.
    func sanitize(_ text: String) -> (output: String, leaks: [String]) {
        guard let sanitize = sessionObj.objectForKeyedSubscript("sanitize"),
              let result = sanitize.call(withArguments: [text], this: sessionObj) else {
            return (text, [])
        }
        let output = result.objectForKeyedSubscript("output")?.toString() ?? ""
        let leaksVal = result.objectForKeyedSubscript("leaks")
        let leaks = (leaksVal?.toArray() as? [[String: Any]] ?? [])
            .map { "\($0["type"] ?? "?"): \($0["value"] ?? "")" }
        return (output, leaks)
    }
}

enum PIICoreError: Error { case contextFailed, scriptMissing, apiMissing }
```

(`JSValue.call(withArguments:this:)` is the usual pattern for calling a
method with the right `this`; the exact API surface should be re-checked
against the Swift/JavaScriptCore version used once an Xcode project exists.)
`sanitizer.js` would ship as a bundled resource (e.g. copied into the app
bundle at build time from `core/sanitizer.js`, the same file the web app
and CLI use unmodified &mdash; no fork, no transpile).

## App shape

- **SwiftUI menu-bar app** (`NSStatusItem` / `MenuBarExtra`), no Dock icon,
  no main window by default &mdash; opens a small popover/panel on click.
- **App Sandbox, no network entitlement.** The whole point of this app
  (like the web app) is that logs never leave the machine; omitting
  `com.apple.security.network.client`/`.server` entitlements makes that a
  platform-enforced guarantee, not just a code-review one.
- **Clipboard-in / clipboard-out** as the primary flow: read `NSPasteboard`
  on a hotkey or button, run `PIICore.sanitize(_:)`, write the result back
  to `NSPasteboard`, show a brief "leaks found" indicator if
  `leaks` is non-empty (mirroring the web app's Leak check tab).
- **Drag-and-drop file flow**: dropping one or more files onto the menu-bar
  popover reads each with `String(contentsOf:)`, sanitizes them with one
  shared `PIICore` session (consistent tokens across files, exactly like
  `apps/cli`'s multi-file mode), and either writes sanitized copies next to
  the originals (`<name>.sanitized.<ext>`) or copies the result to the
  clipboard, user's choice.
- **Legend storage**: in-memory only by default, matching the web app and
  CLI's "no persistence unless you ask" rule. Only when the user explicitly
  chooses to save a legend does it get written to
  `~/Library/Application Support/PII Cleaner/legend.json` (via
  `FileManager.default.urls(for: .applicationSupportDirectory, ...)`) &mdash;
  never silently, and never anywhere iCloud/Dropbox-synced by default. The
  on-disk format is exactly `core`'s `exportLegend()` JSON, so a legend can
  be moved between this app, the web app, and the CLI interchangeably.

## Not yet done

- No Xcode project, target, or entitlements file exists in this repo yet.
- No automated tests for this host (would need an XCTest target once the
  project exists; `core/test/` already covers the shared logic this host
  will call unmodified).
