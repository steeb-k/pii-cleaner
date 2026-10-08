# Changelog

The `## [<version>]` section matching a release tag becomes that release's
notes (see `docs/ci-release.md`).

## [0.9.0]

- First release of Obfuscate, the macOS menu-bar app: clipboard and
  drag-and-drop sanitizing, per-type toggles, custom values, legend
  import/export. Sandboxed, no network entitlement, Developer ID signed and
  notarized.
- Web app and CLI hosts, all sharing the one `core/sanitizer.js`.
