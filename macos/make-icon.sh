#!/bin/sh
# Builds macos/AppIcon.icns from the FliskOS logo. Run by hand when the logo changes; needs rsvg-convert.
# The logo's source of truth is apps/fliskos.svg in https://github.com/flisk-sh/flisk-emoji.
set -eu
cd "$(dirname "$0")"
set_dir="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$set_dir"
# macOS icons draw the artwork at about 80% of the canvas, centered.
for size in 16 32 64 128 256 512 1024; do
  art=$((size * 824 / 1024))
  rsvg-convert --width "$art" --height "$art" --page-width "$size" --page-height "$size" --left $(((size - art) / 2)) --top $(((size - art) / 2)) \
    ../website/public/logo.svg -o "$set_dir/$size.png"
done
for size in 16 32 128 256 512; do
  double=$((size * 2))
  cp "$set_dir/$size.png" "$set_dir/icon_${size}x${size}.png"
  cp "$set_dir/$double.png" "$set_dir/icon_${size}x${size}@2x.png"
done
rm -f "$set_dir"/[0-9]*.png
iconutil -c icns -o AppIcon.icns "$set_dir"
