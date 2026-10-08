# PII Cleaner &mdash; CLI

A tiny, dependency-free Node command-line host for the shared sanitizer in
[`core/`](../../core/README.md). Useful for sanitizing logs in a pipeline,
in a script, or anywhere a browser isn't available.

## Usage

```sh
node apps/cli/pii-clean.js [options] [file ...]
```

```
Options:
  --legend-in <file>   import a legend JSON exported earlier, so previously-seen
                        values get the same tokens again
  --legend-out <file>  export the session legend as JSON after processing
  --disable TYPE,TYPE  comma-separated PII types to leave untouched (e.g. IP,PHONE)
  --quiet              suppress file separators, warnings, and summary lines on stderr
  -h, --help           show help
```

With no files given, it reads from stdin:

```sh
echo '{"ComputerName":"WKS-1","UserName":"jdoe"}' | node apps/cli/pii-clean.js
```

With multiple files, all of them are sanitized with **one shared session**,
so the same hostname/user/etc. gets the same token in every file, and (unless
`--quiet`) each file's sanitized output is preceded by a separator line:

```
// ==== <filename> ====
```

Sanitized output always goes to **stdout only**. Any possible leaks
(from the same leak check the web app's "Leak check" tab uses) are listed
on **stderr**, one per line, and never mixed into stdout, so you can pipe
stdout straight into another tool while still seeing leaks in your terminal
or a log.

## Exit codes

- `0` &mdash; ok, no leaks reported.
- `1` &mdash; a file, stdin, or the legend could not be read (or the
  `--legend-out` file could not be written).
- `2` &mdash; sanitization succeeded, but the leak check reported one or more
  possible leaks (see stderr). Use this to gate a script: `pii-clean ... || echo "check leaks"`.

## Legend workflow

```sh
node apps/cli/pii-clean.js --legend-out legend.json investigation1/*.json
# ...later, same investigation, same tokens:
node apps/cli/pii-clean.js --legend-in legend.json investigation2/*.json
```

The legend file is exactly `core`'s `session.exportLegend()` shape
(`{ version, created, entries }`) &mdash; the same format the web app's
"Download legend JSON" button produces, so legends are interchangeable
between the two host apps.

## No network, no dependencies

This CLI is Node core modules only (`fs`, `path`) plus `core/sanitizer.js`,
which itself makes no network or storage calls. It never writes anything
except stdout and, if you pass `--legend-out`, the one file you named.
