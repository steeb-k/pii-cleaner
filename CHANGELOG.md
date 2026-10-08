# Changelog

The `## [<version>]` section matching a release tag becomes that release's
notes (see `docs/ci-release.md`).

## [0.9.3]

- Exempt subtrees: everything under `analysis_hour_destinations`
  (outgoing-traffic destinations) is left untouched, at any depth, including
  values that are tokenized elsewhere in the same input. Nothing is learned
  from that section and the leak check ignores it. The table
  `EXEMPT_SUBTREES` in the core is the place to add more sections, either
  skipped outright or with only some types switched off.

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
