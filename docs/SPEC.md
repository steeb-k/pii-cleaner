# PII Cleaner — Design Spec

Local-only web app that sanitizes CrowdStrike Falcon and Rapid7 (InsightIDR / InsightVM)
JSON logs by replacing PII with typed, numbered tokens, and produces a legend for reversal.

## Hard constraints
1. **Zero network.** No CDNs, fonts, analytics, fetch/XHR, WebSockets, service workers.
   `index.html` must carry
   `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'">`
   Must work from `python3 serve.py` (localhost HTTP) **and** by double-clicking `index.html` (file://).
2. **No persistence by default.** Legend and inputs live in JS memory only. No localStorage/sessionStorage/IndexedDB/cookies.
3. **Vanilla JS, no build step, no npm dependencies.** ES2020 is fine (Chromium/Firefox current).
4. Pure sanitization logic lives in `sanitizer.js` and must be loadable from Node (`module.exports` when available, else `window.PIISanitizer`) so tests can run headless.

## Files
```
pii-cleaner/
  core/
    sanitizer.js      pure logic, no DOM access, no Node/browser-only globals
    package.json      @pii-cleaner/core
    README.md         API contract for host apps
    test/
      helpers.js
      sanitizer.test.js
  apps/
    web/
      index.html       UI (loads styles.css + ../../core/sanitizer.js + app.js via relative paths)
      styles.css
      app.js           DOM wiring
      serve.py         `python3 apps/web/serve.py [port]` -> http.server bound to 127.0.0.1 only,
                        serves the repo root, no-cache headers
      README.md
      test/
        helpers.js
        nonetwork.test.js
        browser.test.js
        README.md
    cli/
      pii-clean.js     Node CLI host (no dependencies)
      README.md
      test/
        cli.test.js
    macos/
      README.md        plan for a SwiftUI menu-bar host embedding core via JavaScriptCore
  samples/             synthetic CrowdStrike + Rapid7 records (fictional values only)
  docs/
    SPEC.md            this file
  scripts/
    build-web.sh       builds dist/web/, a flat deployable copy of apps/web + core/sanitizer.js
  .github/workflows/
    ci.yml
  package.json         root workspace scripts
  README.md
```

## Input handling
Accept pasted text or a chosen file (FileReader, local only). Auto-detect:
- single JSON object
- JSON array of objects
- NDJSON (one object per line; tolerate blank lines)
- fallback: treat as raw text and apply regex + custom-list passes only
Pretty-print output with 2-space indent unless input was NDJSON (then emit NDJSON).
Show a parse error inline, never throw to console only.

## Token format
`{{TYPE_N}}` with N starting at 1 per type. Types:
`HOST, USER, DOMAIN, EMAIL, IP, MAC, SID, ID, PATH, URL, CUSTOM`
(IPv6 uses `IP` too. `ID` covers GUID/UUID, CrowdStrike aid/cid, Rapid7 asset ids, serial numbers, phone numbers map to `PHONE`.)
Add `PHONE` to the list. `OU` covers Active Directory organizational units.
Final list: HOST, USER, DOMAIN, OU, EMAIL, IP, MAC, SID, ID, PATH, URL, PHONE, CUSTOM.

Same real value -> same token for the whole session (across multiple sanitize runs and files).
Matching is **case-insensitive** for HOST/USER/DOMAIN/OU/EMAIL (`JDOE` and `jdoe` share a token);
case-sensitive for everything else. Store the first-seen original casing in the legend.

## Detection pipeline (order matters)
Each category is a toggle in the UI, **all ON by default**.

### Pass 1 — structured field recognition (walks parsed JSON)
Match keys case-insensitively, on the leaf key name (so `device.hostname` matches `hostname`).
Built-in key map (extend freely; keep in one table `FIELD_MAP` in sanitizer.js):

| Type | Keys |
|---|---|
| HOST | ComputerName, hostname, host_name, HostName, device_name, DeviceName, hostnames, asset, asset_name, name (only when parent key is `host`/`asset`/`device`), source_host, destination_host, MachineDomain is DOMAIN not HOST |
| USER | UserName, user_name, username, user, UserPrincipal, logon_user, account, source_user, destination_user, user.name, SamAccountName, actor_user, target_user, LogonUser, account_name(s), source_account_name(s), destination_account_name(s) (display names such as `Firstname Lastname` are one value, not split) |
| DOMAIN | MachineDomain, LogonDomain, domain, UserDomain, dns_domain, source_domain |
| OU | ou, ous, organizational_unit, organizationalunit, org_unit, ou_display, active_directory_dn_display |
| EMAIL | email, mail, user_email, email_address, sender, recipient |
| IP | LocalAddressIP4, RemoteAddressIP4, LocalAddressIP6, RemoteAddressIP6, aip, ip, ip_address, source_ip, destination_ip, src_ip, dst_ip, external_ip, local_ip, remote_ip, public_ip, address, ipv4, ipv6, addresses |
| MAC | MAC, mac, mac_address, PhysicalAddress, macs |
| SID | UserSid, UserSid_readable, sid, AuthenticationId (if it looks like a SID), LogonSid |
| ID | aid, cid, agent_id, AgentId, device_id, DeviceId, asset_id, SensorId, serial, serial_number, SystemSerialNumber, BiosSerial, uuid, guid, id (only if value matches UUID/hex ≥16) , organization_id, customer_id |
| PATH | ImageFileName, FilePath, TargetFileName, ParentBaseFileName (no), path, file_path, CommandLine (free text — handled in pass 3 not here) |
| URL | url, uri, HttpUrl, DomainName, request_url, referer |
| PHONE | phone, phone_number, mobile |

Values can be strings, or arrays of strings (sanitize each element).
When a HOST/USER/DOMAIN/EMAIL/IP/MAC/SID/ID value is learned here, it goes into the
session dictionary so pass 3 can replace it anywhere.

EMAIL special-case: `jdoe@corp.example` → learn `jdoe` as USER and `corp.example` as DOMAIN,
and emit `{{EMAIL_1}}` for the full address.

OU special-case: a value may be a single OU name (`ou: ["Laptops", "Accounting Dept"]`) or a
backslash-joined OU path (`active_directory_dn_display: ["Laptops\\Computers\\Accounting Dept"]`).
Tokenize each path segment on its own (`{{OU_1}}\\{{OU_2}}\\{{OU_3}}`) so the same OU shares a
token in both fields and the hierarchy depth stays visible.

OU names are mostly generic vocabulary (`Computers`, `Laptops`, `Finance`), so unlike every
other learned type they are **not** swept as bare words through free text (`CONTEXT_ONLY_TYPES`).
In free text an OU is replaced only where the context proves it is one (sweep step 1b):
- an `OU=` component of a distinguished name, learned or not, case-insensitively
  (`CN=WKS1,OU=Accounting Dept,OU=Computers,DC=corp,DC=local`); LDAP-escaped characters
  (`OU=Sales\\, EMEA`) stay inside the value
- a backslash-joined path made entirely of already-learned OUs (`Laptops\\Computers\\Finance`)

The leak check applies the same rule: a bare `Computers` in a sentence is never reported.

PATH special-case: do not tokenize the whole path. Replace only the user segment:
`C:\Users\jdoe\Desktop\x.exe` → `C:\Users\{{USER_1}}\Desktop\x.exe`;
`/home/jdoe/x` and `/Users/jdoe/x` likewise. If a learned HOST appears in a UNC path
`\\HOST\share`, replace it. Keep file names and extensions.

### Pass 2 — custom lists (user-supplied, one value per line, in UI textarea)
Four textareas: Hostnames, Usernames, Domains, Other sensitive strings (→ CUSTOM).
Values added to the dictionary before pass 3 so they are replaced everywhere, including free text.
Custom values also get regex-escaped and matched with word boundaries when they are
alphanumeric; without boundaries when they contain punctuation.

### Pass 3 — regex sweep over every string value (and raw text)
Apply to every string leaf in the JSON (including keys? **no**, values only) and to raw text mode.
Order (longest/most specific first to avoid partial matches). **EMAIL and URL run before the
dictionary pass** so a whole email/URL becomes a single token instead of being fragmented by
previously-learned user/domain/host substrings:
0a. EMAIL regex (learn user + domain; emit `{{EMAIL_N}}`)
0b. URL regex (learn host; emit `{{URL_N}}`)
1. Dictionary replacement: all learned values except context-only types (OU), sorted by length
   descending, case-insensitive for HOST/USER/DOMAIN/EMAIL, with `\b`-style boundaries that treat `\`, `/`, `@`, `.`, `:`, quotes
   and whitespace as boundaries (so `jdoe` in `CORP\jdoe` matches, but `jdoe` in `jdoeadmin` does not).
1b. OU contexts: `OU=` DN components and backslash paths of learned OUs (see the OU special-case)
2. (moved to 0a)
3. (moved to 0b) URL regex covers `https?://`, `ftp://`; learn the host portion as HOST/DOMAIN.
4. IPv4 (reject if any octet > 255), IPv6 (reasonable regex; avoid matching MACs or timestamps)
5. MAC (`aa:bb:cc:dd:ee:ff`, `aa-bb-…`, `aabb.ccdd.eeff`)
6. SID `S-1-5-21-…`
7. GUID/UUID `8-4-4-4-12` hex
8. Windows user path segments `[A-Za-z]:\\Users\\([^\\]+)` and POSIX `/home/([^/]+)`, `/Users/([^/]+)`
9. FQDN-like tokens `host.sub.domain.tld` **only** when the TLD is in a short allow-list
   (com, net, org, local, lan, corp, internal, io, edu, gov, mil, co, uk, de, etc.) — avoid
   matching version numbers like `1.2.3.4` (already consumed by IP) and file names like `svchost.exe`.
10. PHONE (E.164 and common US formats; conservative)

Do **not** touch: timestamps, numbers, booleans, JSON keys, process names, hashes
(SHA256/MD5 are not PII and are useful for analysis), ports, event names, severity.

Tokens already emitted must never be re-matched by later passes (protect `{{…}}` spans).

### Leak check (post-processing)
Re-run passes 2–3 regexes over the sanitized output. Anything matched that is not a token
is reported in a "Possible leaks" panel with the value, the category, and a one-click
"Add to custom list and re-run" action. Also flag any string from the custom lists that
still appears verbatim.

## Legend
In-memory `Map` of `{ token, type, original, count }`.
Export as JSON (`{ version:1, created:ISO, entries:[…] }`) and CSV (`token,type,original,count`).
Import JSON legend: pre-seeds the dictionary so tokens stay stable across sessions; counters
resume from the max N per type.
UI shows the legend as a sortable table with a filter box.

## Output actions
- Copy sanitized output to clipboard (navigator.clipboard with textarea fallback).
- Download sanitized output (`<original-name>.sanitized.json` or `.ndjson`/`.txt`).
- Download legend JSON / CSV.
- Clear session (wipes dictionary, counters, inputs, legend) with confirmation built into the page
  (no `confirm()`).

## UI layout (single page, no framework)
Header: title + "100% local — no network" badge + a live indicator that CSP is active.
Left column: Input (textarea + file picker + format auto-detect label), Options (category
toggles, custom-list textareas, legend import), Sanitize button.
Right column: tabs — Output | Legend | Leak check. Stats line: records processed, replacements by type.
Keyboard: Ctrl/Cmd+Enter = sanitize.
Dark/light via `prefers-color-scheme`. Monospace for log text. Must be usable at 1024px wide.

## Non-goals (v1)
Reverse mode (restoring tokens), timestamp shifting, private/public IP distinction, server-side processing.

## Acceptance
- A synthetic CrowdStrike DetectionSummaryEvent and a Rapid7 InsightIDR alert round-trip
  through the pipeline with every PII field tokenized and nothing else changed.
- Same hostname in two files → same token.
- Legend export → clear → import → re-sanitize yields identical tokens.
- Opening DevTools Network tab shows only the 4 local files, nothing else, ever.
- `grep -nE "https?://|fetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB" *.js *.html` returns only comments or the CSP line.
