#!/bin/sh
# Builds FliskOS and installs it so it shows up in Launchpad, Spotlight and Finder > Applications.
# Installs to /Applications when writable, otherwise ~/Applications. Never uses sudo.
set -eu
cd "$(dirname "$0")/.."
./macos/build.sh
SRC="dist/FliskOS.app"

if [ -w /Applications ]; then DEST_DIR=/Applications; else DEST_DIR="$HOME/Applications"; mkdir -p "$DEST_DIR"; fi
DEST="$DEST_DIR/FliskOS.app"

# Quit a running copy so it can be replaced. Before the renames the app was Flisk App, and before that TDK App.
osascript -e 'tell application "FliskOS" to quit' >/dev/null 2>&1 || true
osascript -e 'tell application "Flisk App" to quit' >/dev/null 2>&1 || true
osascript -e 'tell application "TDK App" to quit' >/dev/null 2>&1 || true
sleep 1
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
# Remove the pre-rename bundles from either Applications directory, since an old install may have used the other one.
for OLD_DEST in "/Applications/Flisk App.app" "$HOME/Applications/Flisk App.app" "/Applications/TDK App.app" "$HOME/Applications/TDK App.app"; do
  # `|| true`: an unwritable old bundle (other admin account, MDM, flags) must not abort
  # the install before Launch Services registration and the success message.
  if [ -d "$OLD_DEST" ]; then rm -rf "$OLD_DEST" || true; fi
done
xattr -dr com.apple.quarantine "$DEST" >/dev/null 2>&1 || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" >/dev/null 2>&1 || true
touch "$DEST"
echo "Installed $DEST"
echo "Open it from Launchpad or Spotlight, or run: open -a FliskOS"
