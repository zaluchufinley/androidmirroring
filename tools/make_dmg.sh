#!/bin/bash
# Packs "Android Mirroring.app" (built by ./build.sh) into a drag-to-Applications disk image.
#
#   ./tools/make_dmg.sh [version]      ->  dist/Android-Mirroring-<version>-macOS.dmg
set -euo pipefail
cd "$(dirname "$0")/.."

APP="Android Mirroring.app"
VERSION="${1:-dev}"
OUT="dist/Android-Mirroring-${VERSION}-macOS.dmg"

test -d "$APP" || { echo "error: $APP not found. Run ./build.sh first." >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

mkdir -p dist
rm -f "$OUT"
hdiutil create -volname "Android Mirroring" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$OUT" >/dev/null
echo "Built: $PWD/$OUT"
