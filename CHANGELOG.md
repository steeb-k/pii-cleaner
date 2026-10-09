# Changelog

The `## [<version>]` section matching a release tag becomes that release's
notes (see `docs/ci-release.md`).

## [0.9.5]

- No functional change: a release cut to exercise the in-app updater from 0.9.4.

## [0.9.4]

- Obfuscate checks GitHub for a newer release once at launch and whenever the
  popover is opened, at most once an hour. At launch a found update is offered
  in a dialog; in the popover it is an **Install Update** button. Installing
  downloads the release zip, verifies it (an `Obfuscate.app` of the expected
  version, signed by the same team), replaces the app in place and relaunches
  it. It still talks only to GitHub, and only to check and download; logs never
  leave the Mac. Downloads follow GitHub's redirect to its release CDN
  (`release-assets.githubusercontent.com`); a redirect anywhere else is
  refused and reported by host. `open Obfuscate.app --args --install-update`
  runs the whole path from a terminal without asking.
- The app is no longer sandboxed. A sandboxed process marks everything it
  writes with a quarantine that macOS refuses to launch, so a sandboxed
  updater cannot produce a working app, and the sandbox-safe detour through a
  nested helper fell at LaunchServices. The entitlements are now the JIT and
  nothing else, no network entitlement included; the no-network promise is
  pinned by the tests (one networking file, GitHub hosts only) and by CI.
- Web app: a link to the project on GitHub in the top-right corner of the
  header.

## [0.9.3]

- Exempt subtrees: under `analysis_hour_destinations` (outgoing-traffic
  destinations) nothing is detected or learned, so vendor domains, public IPs
  and the like stay as they are. Values known from elsewhere in the input,
  such as your own domain, hosts and users, are still replaced there, and
  private addresses (RFC 1918, link-local, loopback) are always tokenized. The
  table `EXEMPT_SUBTREES` in the core is the place to add more sections, with
  this rule, skipped outright, or with only some types switched off.

## [0.9.2]

- USER now also covers `identity`, `userDisplayName`, `user_display_name`,
  `displayName` and `display_name`. A value written `Lastname, Firstname` is
  one token, and `Firstname Lastname` is learned alongside it so the name is
  replaced in either order wherever it recurs in free text.
- USER now also covers `source_account_names` and the other
  `*account_name(s)` keys. A display name such as `Firstname Lastname` is one
  token, and is replaced wherever it recurs in free text.
- Web app: the page fits the browser window without page scroll; the input
  and output boxes flex to use the available height.

## [0.9.1]

- New `OU` type: Active Directory organizational units are scrubbed from `ou`
  and `active_directory_dn_display` (and similar keys). Backslash-joined OU
  paths are tokenized per segment, so `Laptops\Computers\Finance` becomes
  `{{OU_1}}\{{OU_2}}\{{OU_3}}` and each OU shares its token across fields.
  Because OU names are mostly generic words, they are not replaced as bare
  words in free text: only `OU=` components of a distinguished name and
  backslash paths of known OUs are. The leak check follows the same rule.
- Web app: renamed to Obfuscate with the macOS app icon (inlined, so the page
  still loads only its four local files), a shorter header, and an Output /
  Legend / Leak check panel that grows to the height of the browser window
  instead of a fixed height.

## [0.9.0]

- First release of Obfuscate, the macOS menu-bar app: clipboard and
  drag-and-drop sanitizing, per-type toggles, custom values, legend
  import/export. Sandboxed, no network entitlement, Developer ID signed and
  notarized.
- Web app and CLI hosts, all sharing the one `core/sanitizer.js`.
