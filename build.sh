#!/bin/bash
# Builds "Android Mirroring.app" next to this script.
set -euo pipefail
cd "$(dirname "$0")"

APP="Android Mirroring.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

SOURCES=(Sources/main.swift Sources/Core.swift Sources/UI.swift Sources/Connect.swift Sources/Transfer.swift)
FRAMEWORKS=(-framework AppKit -framework AVFoundation -framework CoreMedia)

if [ "${UNIVERSAL:-0}" = "1" ]; then
  # One app for Apple Silicon and Intel Macs (used for the downloadable release). Plain ./build.sh builds for this Mac only.
  TMP="$(mktemp -d)"
  for ARCH in arm64 x86_64; do
    swiftc -O -swift-version 5 -target "$ARCH-apple-macos14.0" \
      -o "$TMP/$ARCH" "${SOURCES[@]}" "${FRAMEWORKS[@]}" 2>&1
  done
  lipo -create -output "$APP/Contents/MacOS/AndroidMirroring" "$TMP/arm64" "$TMP/x86_64"
  rm -rf "$TMP"
else
  swiftc -O -swift-version 5 \
    -o "$APP/Contents/MacOS/AndroidMirroring" "${SOURCES[@]}" \
    "${FRAMEWORKS[@]}" 2>&1
fi
test -x "$APP/Contents/MacOS/AndroidMirroring"

cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Android Mirroring</string>
  <key>CFBundleDisplayName</key><string>Android Mirroring</string>
  <key>CFBundleIdentifier</key><string>local.android-mirroring</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleExecutable</key><string>AndroidMirroring</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

codesign --force --deep -s - "$APP" >/dev/null 2>&1 || echo "warning: ad-hoc signing failed; the app may not open"
echo "Built: $PWD/$APP"
