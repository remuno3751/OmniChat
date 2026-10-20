#!/bin/sh
# OmniChat server installer for macOS (arm64 / x64). Run from the extracted tarball.
#   sudo ./install.sh     system install: /usr/local/omnichat, LaunchDaemon (starts at boot)
#   ./install.sh          per-user install: ~/Library/Application Support/OmniChat, LaunchAgent (starts at login)
# Re-running upgrades in place; config and data are never touched.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/server"
[ -f "$SRC/dist/boot.js" ] ||{ echo "server/ not found next to install.sh (extract the whole tarball)." >&2; exit 1; }
[ -x "$SRC/runtime/node" ] || { echo "bundled runtime/node missing in this tarball." >&2; exit 1; }
[ -f "$HERE/omnichat-admin" ] || { echo "omnichat-admin not found next to install.sh (extract the whole tarball)." >&2; exit 1; }

# archives downloaded with a browser carry the quarantine flag; drop it so the bundled node can run
xattr -dr com.apple.quarantine "$SRC" 2>/dev/null || true

LABEL=com.omnichat.server
RUNAS=""
if [ "$(id -u)" -eq 0 ]; then
  MODE=system
  PREFIX=/usr/local/omnichat
  BASE=/usr/local/omnichat-data         # config + data + logs, outside PREFIX so upgrades keep them
  PLIST=/Library/LaunchDaemons/$LABEL.plist
  # never run the server as root: the service runs as the user who invoked sudo
  RUNAS="${SUDO_USER:-}"
  if [ -z "$RUNAS" ] || [ "$RUNAS" = root ]; then
    echo "Do not run this installer as root directly. Run it from your own account:" >&2
    echo "  sudo ./install.sh" >&2
    echo "(the server runs as the user who started sudo; nothing was changed)" >&2
    exit 1
  fi
else
  MODE=user
  BASE="$HOME/Library/Application Support/OmniChat"
  PREFIX="$BASE/app"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
fi
LOGS="$BASE/logs"
CONF="$BASE/config.env"
DATA="$BASE/data"

# stop old instance (upgrade)
if [ "$MODE" = system ]; then
  launchctl bootout system "$PLIST" 2>/dev/null || true
else
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
fi

rm -rf "$PREFIX.new"
mkdir -p "$(dirname "$PREFIX")" "$PREFIX.new"
cp -R "$SRC/." "$PREFIX.new/"
rm -rf "$PREFIX.old"
if [ -d "$PREFIX" ]; then mv "$PREFIX" "$PREFIX.old"; fi
mv "$PREFIX.new" "$PREFIX"
rm -rf "$PREFIX.old"

mkdir -p "$DATA" "$LOGS"
if [ ! -f "$CONF" ]; then
  # umask in a subshell: the file is never readable by others, not even for a moment
  (
    umask 077
    {
      sed -e '/^# DATA_DIR/d' "$SRC/config.env.example"
      echo
      echo "DATA_DIR=$DATA"
    } > "$CONF"
  )
  chmod 600 "$CONF"
  echo "Created $CONF"
else
  echo "Keeping existing $CONF"
fi
if [ "$MODE" = system ] && [ -n "$RUNAS" ]; then
  # run as the invoking (non-root) user so the data stays accessible to them
  chown -R "$RUNAS" "$BASE"
fi
chmod 700 "$BASE" "$DATA" "$LOGS"

# launchd has no EnvironmentFile: a small wrapper loads config.env, then execs node.
# config.env is NOT sourced (the default DATA_DIR contains a space): it is read as plain KEY=VALUE lines,
# the value is everything after the first '=' (internal spaces kept, no quotes, no expansion).
{
  cat <<RUNHEAD
#!/bin/sh
CONF="$CONF"
RUNHEAD
  cat <<'RUNPARSE'
if [ -f "$CONF" ]; then
  cr=$(printf '\r')
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%"$cr"}
    case "$line" in *=*) ;; *) continue ;; esac
    key=${line%%=*}
    val=${line#*=}
    case "$key" in ''|[0-9]*|*[!A-Za-z0-9_]*) continue ;; esac
    export "$key=$val"
  done < "$CONF"
fi
RUNPARSE
  cat <<RUNTAIL
export NODE_ENV=production
export WEB_DIR="$PREFIX/web"
# set after config.env is loaded so config.env cannot override them; KeepAlive restarts after exit 75
export OMNICHAT_INSTALL_TYPE=macos-service
export OMNICHAT_SUPERVISED=1
cd "$PREFIX" || exit 1
exec "$PREFIX/runtime/node" dist/boot.js
RUNTAIL
} > "$PREFIX/run.sh"
chmod 755 "$PREFIX/run.sh"

# omnichat-admin: account administration with the same config.env and runtime as run.sh (no sudo: see the script)
sed -e "s|@CONF@|$CONF|" -e "s|@PREFIX@|$PREFIX|" "$HERE/omnichat-admin" > "$PREFIX/omnichat-admin"
chmod 755 "$PREFIX/omnichat-admin"
if [ "$MODE" = system ]; then
  install -m 755 "$PREFIX/omnichat-admin" /usr/local/bin/omnichat-admin
  ADMIN_CMD=omnichat-admin
else
  ADMIN_CMD="$PREFIX/omnichat-admin"
fi

mkdir -p "$(dirname "$PLIST")"
{
  cat <<PLISTHEAD
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$PREFIX/run.sh</string></array>
  <key>WorkingDirectory</key><string>$PREFIX</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGS/omnichat.out.log</string>
  <key>StandardErrorPath</key><string>$LOGS/omnichat.err.log</string>
PLISTHEAD
  if [ "$MODE" = system ] && [ -n "$RUNAS" ]; then
    echo "  <key>UserName</key><string>$RUNAS</string>"
  fi
  echo "</dict>"
  echo "</plist>"
} > "$PLIST"
if [ "$MODE" = system ]; then
  chown root:wheel "$PLIST"
  chmod 644 "$PLIST"
  launchctl bootstrap system "$PLIST"
else
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
fi

PORT="$(sed -n 's/^PORT=//p' "$CONF" | tail -n1)"
PORT="${PORT:-8787}"
echo
echo "OmniChat $(cat "$PREFIX/VERSION" 2>/dev/null) installed ($MODE mode) and started."
echo "  Admin:  create the first administrator (required before anyone can log in):"
echo "            $ADMIN_CMD create <username>"
echo "          (password is asked on the terminal; or use the OmniChat Server app, see docs/SERVER-APP.md)"
if [ "$MODE" = user ]; then
  echo "          (per-user install: $PREFIX is not on PATH, so use the full path above)"
fi
echo "  Open:   http://localhost:$PORT/   (then log in with that account)"
echo "  Config: $CONF"
echo "  Data:   $DATA"
echo "  Logs:   $LOGS"
echo "If macOS asks to allow incoming connections for 'node', click Allow to reach it from other devices."
