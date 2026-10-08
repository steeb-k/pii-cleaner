# @pii-cleaner/core

Pure, dependency-free PII-sanitization logic shared by every host app in this
repo (`apps/web`, `apps/cli`, and `apps/macos`). This package has
**no DOM access, no `require`/`process`/`Buffer` usage, and no network or
storage calls** &mdash; it only touches `module`, and falls back through
`globalThis`/`window`/`self`/`this` to attach its export, so it loads
identically in Node, in a browser `<script>` tag, and inside a JavaScriptCore
context with no shims. See `../docs/SPEC.md` for the full design rationale;
this document is the API contract host apps should code against.

## Loading it

```js
// Node (CommonJS)
const PIISanitizer = require('./core/sanitizer.js');
```

```html
<!-- Browser: load before any code that uses it -->
<script src="../../core/sanitizer.js"></script>
<script>
  var session = window.PIISanitizer.createSession();
</script>
```

```swift
// JavaScriptCore (apps/macos host)
let ctx = JSContext()!
ctx.evaluateScript(try String(contentsOf: sanitizerJsURL))
// PIISanitizer is now globalThis.PIISanitizer inside the context:
let createSession = ctx.objectForKeyedSubscript("PIISanitizer")
  .objectForKeyedSubscript("createSession")
let session = createSession.call(withArguments: [])
```

In every host, the module exposes one top-level object, `PIISanitizer`,
with this shape:

```ts
PIISanitizer = {
  createSession(options?): Session,
  detectFormat(text: string): 'json' | 'array' | 'ndjson' | 'text',
  analyzeInput(text: string): { format, records?, warning? },
  TYPES: string[],        // ['HOST','USER','DOMAIN','EMAIL','IP','MAC','SID','ID','PATH','URL','PHONE','CUSTOM']
  FIELD_MAP: Record<string, string[]>,  // type -> lower-cased leaf JSON key names it recognizes
}
```

## `createSession(options)`

Creates an isolated, stateful sanitization session: its own token
dictionary, per-type counters, legend, and custom lists. `options` is
currently unused (reserved) &mdash; pass `{}` or omit it. Use **one session**
across everything that should share tokens (e.g. several files from the
same investigation), and a fresh session per unrelated job.

A session is a plain object with these methods:

### `session.sanitize(text, opts?)`

Sanitizes `text` (a string; non-strings are coerced). `opts`:

- `opts.enabled` &mdash; an object mapping each entry of `TYPES` to `true`/`false`
  (default: every type `true`). Pass only the overrides you want; unlisted
  types stay enabled. Example: `{ enabled: { IP: false } }` leaves IPv4/IPv6
  untouched everywhere (structured fields, custom lists, and the regex
  sweep all honor it; so does the leak check).
- `opts.filename` &mdash; accepted but currently informational only; the
  sanitizer itself does not change behavior based on it (host apps may use
  it for their own display/download naming).

Auto-detects the input shape (single JSON object, JSON array, NDJSON, or
raw text) and returns:

```ts
{
  output: string,             // sanitized text, re-serialized in the detected format
                               // (JSON: 2-space pretty-print; NDJSON: one compact line per record)
  format: 'json' | 'array' | 'ndjson' | 'text',
  records: number,             // records processed (0 if input was empty/unparseable-as-raw-text-too)
  stats: { byType: Record<string, number>, total: number },  // replacement counts
  leaks: Array<{ value: string, type: string, context: string }>,
  warning: string | null,      // e.g. "input looks like JSON/NDJSON but could not be parsed..."
  error: string | null,        // set (and output: '', records: 0) only on an unexpected internal error
}
```

Call `sanitize()` as many times as you like on one session (same file
pasted twice, or many files in a batch): the same real-world value always
maps to the same token for the life of the session, and the leak list is
deduped per output text.

### `session.importLegend(json)`

`json` must be `{ entries: [...] }` as produced by `exportLegend()` (or
hand-built with the same shape). Pre-seeds the session's dictionary so
previously-tokenized values get the *same* token again, and advances each
type's counter past the highest `N` already used, so newly-seen values get
fresh, non-colliding tokens. Throws if `json`/`json.entries` is missing.
Returns `{ imported: number, skipped: number }` &mdash; an entry is skipped if
it's malformed, its type isn't in `TYPES`, its token doesn't match
`{{TYPE_N}}` for that type, or it collides with something the session
already holds under a different token/value.

### `session.exportLegend()`

Returns `{ version: 1, created: <ISO timestamp>, entries: [{ token, type,
original, count }, ...] }`, sorted by type then token number. This is the
canonical legend format `importLegend` expects back.

### `session.exportLegendCSV()`

Returns the same entries as CSV text: header row `token,type,original,count`,
RFC4180 quoting for fields containing commas/quotes/newlines.

### `session.addCustom(type, values)`

`type` must be one of `'HOST' | 'USER' | 'DOMAIN' | 'CUSTOM'` (the four
free-text custom lists; not every entry in `TYPES` can take custom values).
`values` is an array of strings, or a single string split on newlines
(`\r?\n`). Each non-empty value is added to the session dictionary (so pass-3
and future `sanitize()` calls will replace it everywhere, including inside
free text) and remembered as a "custom list" value for the leak check. Throws
on an invalid `type`.

### `session.clear()`

Wipes the session's dictionary, reserved tokens, counters, and custom
lists back to a fresh state. Equivalent to discarding the session and
calling `createSession()` again, except you keep the same object reference.

## Token format

`{{TYPE_N}}`, `N` starting at 1 per type, per session. `TYPES`:

```
HOST, USER, DOMAIN, EMAIL, IP, MAC, SID, ID, PATH, URL, PHONE, CUSTOM
```

- `IP` covers both IPv4 and IPv6.
- `ID` covers GUID/UUIDs, CrowdStrike `aid`/`cid`, Rapid7 asset IDs, and
  serial numbers.
- `PATH` is reserved for the "user path segment" detector: whole file paths
  are never wrapped in a single `{{PATH_N}}` token; only an embedded
  username (`C:\Users\jdoe\...` -> `C:\Users\{{USER_1}}\...`) is replaced.
- Literal `{{TYPE_N}}`-shaped text already present in input is reserved on
  `sanitize()` and never handed out as a token for a different value.

## Matching case rules

Matching is **case-insensitive** for `HOST`/`USER`/`DOMAIN`/`EMAIL`
(`JDOE` and `jdoe` share one token); case-sensitive for every other type.
The legend stores the first-seen original casing.

## `PIISanitizer.TYPES` / `FIELD_MAP` / `detectFormat`

- `TYPES` &mdash; the array above; the authoritative list of valid types for
  `opts.enabled`, `addCustom`, and legend entries.
- `FIELD_MAP` &mdash; `{ TYPE: [lower-cased leaf JSON key names] }` used by pass 1
  (structured field recognition) when walking parsed JSON/NDJSON records.
  Keys are matched case-insensitively on the leaf key name only (so
  `device.hostname` matches the `hostname` entry under `HOST`).
- `detectFormat(text)` &mdash; returns just the `format` string
  (`'json'|'array'|'ndjson'|'text'`) that `sanitize()` would use; convenience
  wrapper around `analyzeInput`.
- `analyzeInput(text)` &mdash; returns `{ format, records?, warning? }`;
  `records` holds already-parsed values for structured formats so callers
  (and `sanitize()` itself) don't need to parse twice.

## Behavior host apps can rely on

- No DOM, no network, no storage, no timers, no I/O of any kind: everything
  is synchronous, pure computation over the arguments you pass in.
- Never touches hashes (SHA256/MD5), timestamps, numbers, booleans, JSON
  keys, ports, or process names.
- Invalid JSON/NDJSON falls back to raw-text sanitization, with `warning`
  naming the parse error (and line, for NDJSON) instead of throwing.
