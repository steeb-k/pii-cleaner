#!/usr/bin/env bash
# Builds dist/web/: a flat, deployable copy of the web app that no longer
# relies on apps/web's relative ../../core/sanitizer.js reference back into
# the monorepo (so dist/web/ can be copied anywhere, e.g. a static host's
# Pages folder, and still work).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist/web"

rm -rf "$OUT"
mkdir -p "$OUT"

cp "$ROOT/apps/web/index.html" "$OUT/index.html"
cp "$ROOT/apps/web/app.js" "$OUT/app.js"
cp "$ROOT/apps/web/styles.css" "$OUT/styles.css"
cp "$ROOT/apps/web/README.md" "$OUT/README.md"
cp "$ROOT/core/sanitizer.js" "$OUT/sanitizer.js"
cp -R "$ROOT/samples" "$OUT/samples"

# Rewrite the script src from the monorepo-relative path to the flat,
# same-directory path used in dist/web/.
sed -i.bak 's#\.\./\.\./core/sanitizer\.js#sanitizer.js#' "$OUT/index.html"
rm -f "$OUT/index.html.bak"

echo "$OUT"
