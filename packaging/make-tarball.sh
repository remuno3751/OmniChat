#!/bin/sh
# Assemble an installer tarball from a staged server folder.
#   make-tarball.sh <stage/server> <linux|macos> <arch: x64|arm64> <version> <outdir>
# -> <outdir>/omnichat-server-<version>-<os>-<arch>.tar.gz
#    (top dir omnichat-server-<version>-<os>-<arch>/ containing server/, install.sh, uninstall.sh, ...)
set -eu
STAGE="$1"; OS="$2"; ARCH="$3"; VER="$4"; OUT="$5"
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="omnichat-server-$VER-$OS-$ARCH"
TMP="$(mktemp -d)"
mkdir -p "$TMP/$NAME" "$OUT"
cp -R "$STAGE" "$TMP/$NAME/server"
cp "$HERE/$OS/"* "$TMP/$NAME/"
chmod +x "$TMP/$NAME/"*.sh "$TMP/$NAME/server/runtime/node" "$TMP/$NAME/server/start.sh" 2>/dev/null || true
tar -C "$TMP" -czf "$OUT/$NAME.tar.gz" "$NAME"
rm -rf "$TMP"
echo "$OUT/$NAME.tar.gz"
