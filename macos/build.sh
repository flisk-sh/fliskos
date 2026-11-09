#!/bin/sh
# Builds a lightweight FliskOS.app (native WKWebView shell + bundled server sources).
# Requires Xcode Command Line Tools; the app uses Node.js 22.12+ from your PATH.
# `--release` also builds for both Mac architectures and zips the app for GitHub Releases. FLISKOS_VERSION
# (like v0.2.1) overrides the version from package.json.
set -eu
cd "$(dirname "$0")/.."
APP="dist/FliskOS.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"
VERSION="${FLISKOS_VERSION:-$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json)}"
VERSION="${VERSION#v}"
if [ "${1:-}" = "--release" ]; then
  swiftc -O -target arm64-apple-macos12 -o dist/FliskOS-arm64 macos/main.swift
  swiftc -O -target x86_64-apple-macos12 -o dist/FliskOS-x86_64 macos/main.swift
  lipo -create dist/FliskOS-arm64 dist/FliskOS-x86_64 -output "$APP/Contents/MacOS/FliskOS"
  rm -f dist/FliskOS-arm64 dist/FliskOS-x86_64
else
  swiftc -O -o "$APP/Contents/MacOS/FliskOS" macos/main.swift
fi
cp -R src public package.json "$APP/Contents/Resources/app/"
[ -f macos/AppIcon.icns ] && cp macos/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>FliskOS</string>
<key>CFBundleIdentifier</key><string>com.flisk-sh.fliskos</string>
<key>CFBundleExecutable</key><string>FliskOS</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundleDisplayName</key><string>FliskOS</string>
<key>NSHumanReadableCopyright</key><string>MIT License</string>
<key>CFBundleShortVersionString</key><string>$VERSION</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
if [ "${1:-}" = "--release" ]; then
  rm -f dist/FliskOS-macOS.zip
  (cd dist && ditto -c -k --keepParent FliskOS.app FliskOS-macOS.zip)
fi
echo "Built $APP ($(du -sh "$APP" | cut -f1))"
