#!/usr/bin/env bash
set -euo pipefail
UUID="quickpaste@0-meeseeks-0.io"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions"
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="$EXT_DIR/$UUID"

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC/." "$DEST/"
glib-compile-schemas "$DEST/schemas"

echo "Installed in $DEST"
echo "1) Log out and log back in (required on Wayland)"
echo "2) Then run:  gnome-extensions enable $UUID"
