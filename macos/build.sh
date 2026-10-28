#!/bin/sh
# Builds a lightweight FliskOS.app (native WKWebView shell + bundled server sources).
# Requires Xcode Command Line Tools; the app uses Node.js 22.12+ from your PATH.
set -eu
cd "$(dirname "$0")/.."
APP="dist/FliskOS.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"
swiftc -O -o "$APP/Contents/MacOS/FliskOS" macos/main.swift
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
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "Built $APP ($(du -sh "$APP" | cut -f1))"
