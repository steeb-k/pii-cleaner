#!/usr/bin/env bash
# Builds "Obfuscate.app" into dist/macos/ and zips it.
#
#   bash apps/macos/build-app.sh [--open]
#
# Environment:
#   CONFIGURATION=debug|release   default release
#   OBFUSCATE_UNIVERSAL=1         build arm64 + x86_64 (CI does; a dev box builds its own arch)
#   CODESIGN_IDENTITY=...         'Developer ID Application: Name (TEAMID)' present in a keychain.
#                                 Unset = ad-hoc ('-'): fine for a dev box, cannot be notarized.
#   OBFUSCATE_NOTARIZE=1          notarize + staple the sealed bundle before zipping
#                                 (scripts/notarize-macos.sh; needs CODESIGN_IDENTITY and NOTARY_*)
#
# Output: dist/macos/Obfuscate.app (its path is the only thing on stdout) and
#         dist/macos/Obfuscate-<version>-macos-<universal|arm64|x86_64>.zip
#
# Signing: ad-hoc by default. With a real identity every Mach-O gets a secure
# timestamp and the hardened runtime, the two things notarization checks beyond
# the signature itself. CI (.github/workflows/release.yml) sets all of the
# above; see docs/ci-release.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG="$ROOT/apps/macos"
OUT="$ROOT/dist/macos"
CONFIGURATION="${CONFIGURATION:-release}"
OPEN=0
for a in "$@"; do [ "$a" = "--open" ] && OPEN=1; done

# Identity and the flags that go with it. Ad-hoc ('-') cannot carry a
# timestamp; a real identity must, and must opt into the hardened runtime.
IDENTITY="${CODESIGN_IDENTITY:--}"
if [ "$IDENTITY" = "-" ]; then
  SIGN_FLAGS="--timestamp=none"
  [ "${OBFUSCATE_NOTARIZE:-0}" = 1 ] && { echo "build-app: OBFUSCATE_NOTARIZE=1 needs CODESIGN_IDENTITY (an ad-hoc bundle cannot be notarized)" >&2; exit 1; }
else
  SIGN_FLAGS="--timestamp --options runtime"
fi

ARCH_FLAGS=()
if [ "${OBFUSCATE_UNIVERSAL:-0}" = 1 ]; then
  ARCH_FLAGS=(--arch arm64 --arch x86_64); SLICE=universal
else
  SLICE="$(uname -m)"
fi

VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$PKG/Info.plist")"
[ -n "$VERSION" ] || { echo "build-app: no CFBundleShortVersionString in Info.plist" >&2; exit 1; }

swift build -c "$CONFIGURATION" ${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"} --package-path "$PKG" 1>&2
BINDIR="$(swift build -c "$CONFIGURATION" ${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"} --package-path "$PKG" --show-bin-path)"
BIN="$BINDIR/Obfuscate"

APP="$OUT/Obfuscate.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Obfuscate"
cp "$PKG/Info.plist" "$APP/Contents/Info.plist"
# The one shared core, copied unmodified.
cp "$ROOT/core/sanitizer.js" "$APP/Contents/Resources/sanitizer.js"
# Menu-bar template icon PNGs, flat in Resources/ (MenuBarIcon.swift looks here first).
cp "$PKG"/Sources/Obfuscate/Resources/ObfuscateTemplate*.png "$APP/Contents/Resources/"
# App icon: built from the committed PNG iconset so the PNGs stay the source of truth.
iconutil -c icns "$PKG/Icons/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

# Seal the bundle (the one Mach-O is the executable itself).
# shellcheck disable=SC2086
codesign --force --sign "$IDENTITY" $SIGN_FLAGS --entitlements "$PKG/Obfuscate.entitlements" "$APP" 1>&2
codesign --verify --deep --strict "$APP" || { echo "build-app: the sealed bundle does not verify" >&2; exit 1; }
if [ "$IDENTITY" != "-" ]; then
  echo "build-app: TeamIdentifier -> $(codesign -dv --verbose=2 "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')" >&2
fi
if [ "${OBFUSCATE_NOTARIZE:-0}" = 1 ]; then
  "$ROOT/scripts/notarize-macos.sh" "$APP" 1>&2
fi

echo "build-app: Obfuscate arches -> $(lipo -archs "$APP/Contents/MacOS/Obfuscate")" >&2

# Zip with ditto so the signature, extended attributes and (stapled) ticket survive.
ZIP="$OUT/Obfuscate-$VERSION-macos-$SLICE.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
echo "build-app: wrote $ZIP ($(du -sh "$ZIP" | awk '{print $1}'))" >&2

echo "$APP"
[ "$OPEN" = 1 ] && open "$APP"
exit 0
