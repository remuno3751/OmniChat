#!/bin/sh
# OmniChat server installer for Linux (systemd). Run as root from the extracted tarball:
#   sudo ./install.sh
# Layout:  /opt/omnichat (program)  /etc/omnichat/config.env  /var/lib/omnichat (data)
# Re-running upgrades in place; config and data are never touched.
set -eu

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo ./install.sh" >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "systemd (systemctl) is required." >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/server"
[ -f "$SRC/dist/boot.js" ] ||{ echo "server/ not found next to install.sh (extract the whole tarball)." >&2; exit 1; }
[ -x "$SRC/runtime/node" ] || { echo "bundled runtime/node missing in this tarball." >&2; exit 1; }
[ -f "$HERE/omnichat-admin" ] || { echo "omnichat-admin not found next to install.sh (extract the whole tarball)." >&2; exit 1; }

PREFIX=/opt/omnichat
CONF=/etc/omnichat
DATA=/var/lib/omnichat
UNIT=/etc/systemd/system/omnichat.service

if ! id omnichat >/dev/null 2>&1; then
  NOLOGIN=/usr/sbin/nologin
  [ -x "$NOLOGIN" ] || NOLOGIN=/sbin/nologin
  [ -x "$NOLOGIN" ] || NOLOGIN=/bin/false
  useradd --system --home-dir "$DATA" --no-create-home --shell "$NOLOGIN" omnichat
fi

if systemctl is-active --quiet omnichat 2>/dev/null; then
  echo "Stopping running service for upgrade..."
  systemctl stop omnichat
fi

rm -rf "$PREFIX.new"
mkdir -p "$PREFIX.new"
cp -a "$SRC/." "$PREFIX.new/"
rm -rf "$PREFIX.old"
if [ -d "$PREFIX" ]; then mv "$PREFIX" "$PREFIX.old"; fi
mv "$PREFIX.new" "$PREFIX"
rm -rf "$PREFIX.old"
chown -R root:root "$PREFIX"

mkdir -p "$CONF" "$DATA"
chown omnichat:omnichat "$DATA"
chmod 750 "$DATA"
if [ ! -f "$CONF/config.env" ]; then
  # umask in a subshell: created private (root only) and then given root:omnichat 640
  (
    umask 077
    {
      sed -e '/^# DATA_DIR/d' "$SRC/config.env.example"
      echo
      echo "DATA_DIR=$DATA"
    } > "$CONF/config.env"
  )
  chmod 640 "$CONF/config.env"
  chown root:omnichat "$CONF/config.env"
  echo "Created $CONF/config.env"
else
  echo "Keeping existing $CONF/config.env"
fi

install -m 644 "$HERE/omnichat.service" "$UNIT"
install -m 755 "$HERE/omnichat-admin" /usr/local/bin/omnichat-admin
systemctl daemon-reload
systemctl enable --now omnichat

PORT="$(sed -n 's/^PORT=//p' "$CONF/config.env" | tail -n1)"
PORT="${PORT:-8787}"
echo
echo "OmniChat $(cat "$PREFIX/VERSION" 2>/dev/null) installed and started."
echo "  Admin:   create the first administrator on this server (required before anyone can log in):"
echo "             sudo omnichat-admin create <username>"
echo "           (password is asked on the terminal; or use the OmniChat Server app, see docs/SERVER-APP.md)"
echo "  Open:    http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT/   (then log in with that account)"
echo "  Config:  $CONF/config.env  (then: sudo systemctl restart omnichat)"
echo "  Data:    $DATA"
echo "  Logs:    journalctl -u omnichat -f"
echo "  Firewall: open TCP $PORT yourself if needed (ufw allow $PORT/tcp  or  firewall-cmd --add-port=$PORT/tcp --permanent)"
