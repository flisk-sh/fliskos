#!/bin/sh
# Installs FliskOS on a Mac: downloads the latest release, puts it in Applications and opens it.
# The app is not notarized by Apple, so macOS blocks a copy downloaded in a browser. A file curl saves has no
# quarantine flag, so this installs the same release zip with nothing to click through.
# Source: https://github.com/flisk-sh/fliskos (website/public/install.sh)
set -eu

[ "$(uname -s)" = "Darwin" ] || { echo "FliskOS for Mac needs macOS." >&2; exit 1; }

if [ -n "${FLISKOS_INSTALL_DIR:-}" ]; then
  dir="$FLISKOS_INSTALL_DIR"
elif [ -w /Applications ]; then
  dir=/Applications
else
  dir="$HOME/Applications"
fi
app="$dir/FliskOS.app"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading FliskOS..."
curl -fsSL "https://github.com/flisk-sh/fliskos/releases/latest/download/FliskOS-macOS.zip" -o "$tmp/app.zip"
ditto -x -k "$tmp/app.zip" "$tmp"
[ -x "$tmp/FliskOS.app/Contents/MacOS/FliskOS" ] || { echo "The download did not contain FliskOS.app." >&2; exit 1; }

mkdir -p "$dir"
# A running copy has to close before it can be replaced.
if pgrep -f "$app/Contents/MacOS/FliskOS" >/dev/null 2>&1; then
  osascript -e 'tell application "FliskOS" to quit' >/dev/null 2>&1 || true
  sleep 1
fi
rm -rf "$app"
ditto "$tmp/FliskOS.app" "$app"
xattr -cr "$app" 2>/dev/null || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app" >/dev/null 2>&1 || true

echo "Installed $app"
command -v node >/dev/null 2>&1 || command -v bun >/dev/null 2>&1 || echo "FliskOS also needs Node.js 22.12+ or Bun: https://nodejs.org"
command -v flisk >/dev/null 2>&1 || echo "To run your projects, install the Flisk CLI: curl -fsSL https://flisk.sh/install.sh | sh"
[ -n "${FLISKOS_NO_OPEN:-}" ] || open "$app"
