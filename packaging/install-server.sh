#!/usr/bin/env bash
# OmniChat server installer for Linux (systemd) and macOS (launchd).
#
# Run from a clone of the repository:
#   sudo bash packaging/install-server.sh             # Linux (root required)
#   sudo bash packaging/install-server.sh             # macOS system install (LaunchDaemon)
#        bash packaging/install-server.sh             # macOS per-user install (LaunchAgent)
#        bash packaging/install-server.sh --dry-run   # print the plan, change nothing
#
# Steps: prerequisites, build (npm ci + build-release.mjs), assemble the tarball layout in a
# temp dir, pre-create config.env (only if absent), run the platform installer
# (packaging/<linux|macos>/install.sh), wait for /healthz, run the doctor, print next steps.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DRY_RUN=0
ASSUME_YES=0
PORT=8787
HOST=0.0.0.0
DATA_DIR=""
ALLOW_REG=0
SEARXNG_URL=""
BRIDGE_NAME=""
OS_OVERRIDE=""   # hidden: --os linux|macos, dry-run planning only
CHANGED=0

# ---------------------------------------------------------------- helpers

die() { echo "ERROR: $*" >&2; exit 1; }

usage_error() {
  echo "ERROR: $*" >&2
  echo "Try: $(basename "$0") --help" >&2
  exit 2
}

usage() {
  cat <<'EOF'
Usage: install-server.sh [options]

Installs the OmniChat server as a service: Linux (systemd, run as root) or
macOS (launchd: system LaunchDaemon as root, otherwise a per-user LaunchAgent).
Run it from a clone of the repository.

Options:
  --dry-run               Show the checks and the full plan; change nothing; never prompt
  --port N                HTTP port, 1-65535 (default 8787)
  --host ADDR             Bind address (default 0.0.0.0)
  --data-dir DIR          Data directory, absolute path. Linux: must be /var/lib/omnichat
                          (default). macOS default: root -> /usr/local/omnichat-data/data,
                          otherwise ~/Library/Application Support/OmniChat/data
  --allow-registration    Allow self-registration once an admin exists (new accounts are regular users)
  --no-registration       No self-registration (default). The first administrator is created on the
                          server with omnichat-admin (see the steps printed at the end)
  --searxng-url URL       Optional SearXNG web search backend, e.g. http://localhost:8888
  --bridge-name NAME      Print DeepSeek Harness PC bridge setup hints for this name
                          (not a server setting)
  --yes                   Do not prompt; use flags and defaults
  -h, --help              Show this help

Prompts appear only when stdin is a terminal and neither --yes nor --dry-run is given.
Exit codes: 0 ok, 1 failed prerequisite or step, 2 usage error.
EOF
}

# run CMD ARGS...  -- prints "+ CMD ARGS", executes unless dry run; failure aborts
run() {
  echo "+ $*"
  if [ "$DRY_RUN" -eq 0 ]; then
    "$@" || die "step failed: $*"
  fi
}

# run_in DIR CMD ARGS...  -- same, inside DIR
run_in() {
  local dir="$1"; shift
  echo "+ (cd $dir && $*)"
  if [ "$DRY_RUN" -eq 0 ]; then
    (cd "$dir" && "$@") || die "step failed: $*"
  fi
}

is_port() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "${#1}" -le 5 ] || return 1
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}
# no whitespace, quotes, '#' or '=' (config.env has no quoting)
is_safe() {
  case "$1" in ''|*[[:space:]]*|*\"*|*\'*|*#*|*=*) return 1 ;; esac
  return 0
}
# may contain spaces (but no quotes, '#' or '=')
is_value() {
  case "$1" in ''|*\"*|*\'*|*#*|*=*) return 1 ;; esac
  return 0
}
is_abs_value() {
  case "$1" in /*) is_value "$1" ;; *) return 1 ;; esac
}
is_url() {
  case "$1" in http://?*|https://?*) is_safe "$1" ;; *) return 1 ;; esac
}
is_url_or_empty() {
  if [ -z "$1" ]; then return 0; fi
  is_url "$1"
}
is_name() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]]
}
is_name_or_empty() {
  if [ -z "$1" ]; then return 0; fi
  is_name "$1"
}

# ask_value VAR LABEL DEFAULT VALIDATOR  -- interactive prompt, re-asks on invalid input
ask_value() {
  local __var="$1" __label="$2" __def="$3" __check="$4" __ans=""
  while true; do
    read -r -p "$__label [$__def]: " __ans || __ans=""
    if [ -z "$__ans" ]; then __ans="$__def"; fi
    if "$__check" "$__ans"; then break; fi
    echo "  invalid value, try again" >&2
  done
  printf -v "$__var" '%s' "$__ans"
}

# ---------------------------------------------------------------- 1. flags

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --port)
      [ $# -ge 2 ] || usage_error "--port needs a value"; PORT="$2"; shift ;;
    --host)
      [ $# -ge 2 ] || usage_error "--host needs a value"; HOST="$2"; shift ;;
    --data-dir)
      [ $# -ge 2 ] || usage_error "--data-dir needs a value"; DATA_DIR="$2"; shift ;;
    --searxng-url)
      [ $# -ge 2 ] || usage_error "--searxng-url needs a value"; SEARXNG_URL="$2"; shift ;;
    --bridge-name)
      [ $# -ge 2 ] || usage_error "--bridge-name needs a value"; BRIDGE_NAME="$2"; shift ;;
    --allow-registration) ALLOW_REG=1 ;;
    --no-registration) ALLOW_REG=0 ;;
    --os)
      [ $# -ge 2 ] || usage_error "--os needs a value"; OS_OVERRIDE="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage_error "unknown option: $1" ;;
  esac
  shift
done

is_port "$PORT" || usage_error "invalid --port '$PORT' (use 1-65535)"
is_safe "$HOST" || usage_error "invalid --host '$HOST'"
if [ -n "$DATA_DIR" ] && ! is_abs_value "$DATA_DIR"; then
  usage_error "invalid --data-dir '$DATA_DIR' (absolute path, no quotes, '#' or '=')"
fi
if [ -n "$SEARXNG_URL" ] && ! is_url "$SEARXNG_URL"; then
  usage_error "invalid --searxng-url '$SEARXNG_URL' (must start with http:// or https://)"
fi
if [ -n "$BRIDGE_NAME" ] && ! is_name "$BRIDGE_NAME"; then
  usage_error "invalid --bridge-name '$BRIDGE_NAME' (letters, digits, . _ - only)"
fi
case "$OS_OVERRIDE" in
  ''|linux|macos) ;;
  *) usage_error "invalid --os '$OS_OVERRIDE' (linux or macos)" ;;
esac
if [ -n "$OS_OVERRIDE" ] && [ "$DRY_RUN" -eq 0 ]; then
  usage_error "--os is only accepted together with --dry-run"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY RUN: nothing will be changed"
  echo
fi

# ---------------------------------------------------------------- platform

UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
UNAME_M="$(uname -m 2>/dev/null || echo unknown)"
case "$UNAME_S" in
  Linux) OS_KIND=linux ;;
  Darwin) OS_KIND=macos ;;
  *) OS_KIND=unsupported ;;
esac
case "$UNAME_M" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) ARCH=unsupported ;;
esac
# the plan follows --os when given (dry run only); otherwise the detected OS (Linux if unsupported)
OS_PLAN="${OS_OVERRIDE:-$OS_KIND}"
if [ "$OS_PLAN" = unsupported ]; then OS_PLAN=linux; fi

# ---------------------------------------------------------------- 2. prompts

if [ "$DRY_RUN" -eq 0 ] && [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
  echo "Answer the prompts (Enter keeps the default in brackets)."
  ask_value PORT "Port" "$PORT" is_port
  ask_value HOST "Bind address" "$HOST" is_safe
  yn_def=n; if [ "$ALLOW_REG" -eq 1 ]; then yn_def=y; fi
  read -r -p "Allow self-registration once an admin exists? (y/n) [$yn_def]: " yn_ans || yn_ans=""
  case "${yn_ans:-$yn_def}" in
    y|Y|yes|YES) ALLOW_REG=1 ;;
    *) ALLOW_REG=0 ;;
  esac
  ask_value SEARXNG_URL "SearXNG URL (empty = none)" "$SEARXNG_URL" is_url_or_empty
  ask_value BRIDGE_NAME "DeepSeek Harness bridge name (empty = none)" "$BRIDGE_NAME" is_name_or_empty
  echo
fi

# ---------------------------------------------------------------- 3. prerequisites

echo "== 1/6 Prerequisites =="
FAILS=0
pass() { printf '[OK]   %s\n' "$*"; }
bad()  { printf '[FAIL] %s\n' "$*"; FAILS=$((FAILS + 1)); }
note() { printf '[NOTE] %s\n' "$*"; }

if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -p 'process.versions.node' 2>/dev/null || echo 0.0.0)"
  NODE_MAJOR="${NODE_VER%%.*}"
  if [ "$NODE_MAJOR" -ge 24 ] 2>/dev/null; then
    pass "node v$NODE_VER (>= 24)"
  else
    bad "node v$NODE_VER found; need Node.js >= 24"
  fi
else
  bad "node: not found in PATH (need Node.js >= 24)"
fi

if command -v git >/dev/null 2>&1; then pass "git found"; else bad "git: not found in PATH"; fi
if command -v npm >/dev/null 2>&1; then pass "npm found"; else bad "npm: not found in PATH"; fi
if command -v curl >/dev/null 2>&1; then pass "curl found"; else bad "curl: not found in PATH (needed for the health check)"; fi

case "$OS_KIND" in
  linux) pass "OS: Linux (uname -s: $UNAME_S)" ;;
  macos) pass "OS: macOS (uname -s: $UNAME_S)" ;;
  *) bad "OS: unsupported (uname -s: $UNAME_S); needs Linux with systemd or macOS" ;;
esac
if [ "$OS_PLAN" != "$OS_KIND" ]; then
  note "planning the $OS_PLAN plan (detected: $UNAME_S); the checks above are for this machine"
fi
if [ "$OS_PLAN" = linux ]; then
  if command -v systemctl >/dev/null 2>&1; then pass "systemd (systemctl found)"; else bad "systemctl not found (the Linux installer needs systemd)"; fi
  if [ "$(id -u)" -eq 0 ]; then
    pass "running as root"
  elif [ "$DRY_RUN" -eq 1 ]; then
    note "not root; a real run must use sudo"
  else
    bad "not root; run with sudo"
  fi
fi
if [ "$OS_PLAN" = macos ] && [ "$(id -u)" -eq 0 ]; then
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
    pass "root via sudo from $SUDO_USER (the service runs as $SUDO_USER)"
  elif [ "$DRY_RUN" -eq 1 ]; then
    note "running as root without sudo; a real run must be started with sudo from your own account"
  else
    bad "running as root directly: start it with 'sudo bash packaging/install-server.sh' from your own account (the service must not run as root)"
  fi
fi

case "$ARCH" in
  unsupported) bad "architecture: $UNAME_M unsupported (need x86_64 or arm64)" ;;
  *) pass "architecture: $ARCH ($UNAME_M)" ;;
esac

if [ "$FAILS" -gt 0 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    note "$FAILS prerequisite(s) failed; the dry run continues"
  else
    die "$FAILS prerequisite(s) failed; nothing was changed"
  fi
fi

# ---------------------------------------------------------------- paths

case "$OS_PLAN" in
  linux)
    OSDIR=linux
    CONF_DIR=/etc/omnichat
    DEFAULT_DATA=/var/lib/omnichat
    ;;
  macos)
    OSDIR=macos
    if [ "$(id -u)" -eq 0 ]; then
      CONF_DIR=/usr/local/omnichat-data
      DEFAULT_DATA=/usr/local/omnichat-data/data
    else
      CONF_DIR="${HOME:-}/Library/Application Support/OmniChat"
      DEFAULT_DATA="$CONF_DIR/data"
    fi
    ;;
esac
CONF_FILE="$CONF_DIR/config.env"
if [ -z "$DATA_DIR" ]; then DATA_DIR="$DEFAULT_DATA"; fi
if [ "$OS_PLAN" = linux ] && [ "$DATA_DIR" != /var/lib/omnichat ]; then
  usage_error "on Linux --data-dir must be /var/lib/omnichat (the systemd unit only allows writes there)"
fi

# ---------------------------------------------------------------- 2. build

echo
echo "== 2/6 Build the server =="
VER="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_ROOT/server/package.json" | head -n 1 || true)"
[ -n "$VER" ] || die "cannot read the version from server/package.json"
NODE_BIN="$(command -v node 2>/dev/null || echo node)"

if [ "$DRY_RUN" -eq 1 ]; then
  TMP="<tmpdir>"
else
  TMP="$(mktemp -d)" || die "cannot create a temp dir"
  trap 'rm -rf "$TMP"' EXIT
fi

run_in "$REPO_ROOT/server" npm ci
run_in "$REPO_ROOT" node packaging/build-release.mjs --out "$TMP/stage" --version "$VER" --node "$NODE_BIN"

# ---------------------------------------------------------------- 3. layout

echo
echo "== 3/6 Assemble the installer layout =="
LAYOUT="$TMP/omnichat-server-$VER"
run mkdir -p "$LAYOUT"
run cp -R "$TMP/stage/server" "$LAYOUT/server"
run cp -R "$REPO_ROOT/packaging/$OSDIR/." "$LAYOUT/"

# ---------------------------------------------------------------- 4. config

echo
echo "== 4/6 Config file: $CONF_FILE =="

cur() { sed -n "s/^$1=//p" "$CONF_FILE" | tail -n 1; }

report_key() {  # report_key KEY WANTED
  local key="$1" want="$2" have
  if grep -q "^$key=" "$CONF_FILE"; then
    have="$(cur "$key" || true)"
    if [ "$have" != "$want" ]; then
      echo "  differs, kept:  $key=$have (requested: $want)"
      CHANGED=1
    fi
  else
    echo "  would add:      $key=$want"
    CHANGED=1
  fi
}

if [ -f "$CONF_FILE" ]; then
  echo "An existing config is kept and NOT overwritten. Comparing with the requested settings:"
  CHANGED=0
  report_key PORT "$PORT"
  report_key HOST "$HOST"
  report_key DATA_DIR "$DATA_DIR"
  report_key ALLOW_REGISTRATION "$ALLOW_REG"
  if [ -n "$SEARXNG_URL" ]; then report_key SEARXNG_URL "$SEARXNG_URL"; fi
  if [ "$CHANGED" -eq 0 ]; then echo "  existing values already match the requested settings"; fi
  # the platform installer keeps this file, so the file's PORT and DATA_DIR are the ones in use
  EXISTING_PORT="$(cur PORT || true)"
  EXISTING_DATA="$(cur DATA_DIR || true)"
  if is_port "$EXISTING_PORT" && [ "$EXISTING_PORT" != "$PORT" ]; then
    echo "  using PORT=$EXISTING_PORT from the existing config for the health check and doctor"
    PORT="$EXISTING_PORT"
  fi
  if [ -n "$EXISTING_DATA" ]; then DATA_DIR="$EXISTING_DATA"; fi
  echo "  Kept as is. Edit the file by hand and restart the service to change anything else."
else
  CONF_CONTENT="# OmniChat server configuration (KEY=VALUE, one per line, no quotes, '#' starts a comment)
# Created by packaging/install-server.sh. Restart the service after editing this file.
PORT=$PORT
HOST=$HOST
DATA_DIR=$DATA_DIR
# 1 = after an admin exists, anyone can register (as a regular user); 0 = no self-registration
ALLOW_REGISTRATION=$ALLOW_REG"
  if [ -n "$SEARXNG_URL" ]; then
    CONF_CONTENT="$CONF_CONTENT
SEARXNG_URL=$SEARXNG_URL"
  fi
  run mkdir -p "$CONF_DIR"
  # Linux: root:omnichat 640 (set after the platform installer creates the user).
  # macOS: owner only, 600. The file is created under umask 077 so it is never readable by others.
  if [ "$OS_PLAN" = linux ]; then CONF_MODE=640; else CONF_MODE=600; fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "+ write $CONF_FILE (umask 077, mode $CONF_MODE) with this content:"
    echo "----- begin -----"
    printf '%s\n' "$CONF_CONTENT"
    echo "----- end -----"
  else
    ( umask 077; printf '%s\n' "$CONF_CONTENT" > "$CONF_FILE" ) || die "cannot write $CONF_FILE"
    chmod "$CONF_MODE" "$CONF_FILE"
    CREATED_CONF=1
    echo "Created $CONF_FILE"
  fi
fi

# ---------------------------------------------------------------- 5. installer

echo
echo "== 5/6 Run the platform installer and check health =="
run sh "$LAYOUT/install.sh"
# the file created above gets the Linux group the service's user now has (root:omnichat 640, as install.sh does)
if [ "$DRY_RUN" -eq 0 ] && [ "${CREATED_CONF:-0}" -eq 1 ] && [ "$OS_PLAN" = linux ] && getent group omnichat >/dev/null 2>&1; then
  chown root:omnichat "$CONF_FILE"
fi

HEALTH_URL="http://127.0.0.1:$PORT/healthz"
if [ "$OS_PLAN" = linux ]; then
  LOGS_HINT="journalctl -u omnichat -f"
else
  LOGS_HINT="$CONF_DIR/logs"
fi
echo "+ wait up to 30 s for $HEALTH_URL to return ok (curl -fsS)"
if [ "$DRY_RUN" -eq 0 ]; then
  healthy=0
  i=0
  while [ "$i" -lt 30 ]; do
    body="$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null || true)"
    if [ "$body" = "ok" ]; then healthy=1; break; fi
    i=$((i + 1))
    sleep 1
  done
  if [ "$healthy" -eq 1 ]; then
    echo "healthz: ok ($HEALTH_URL)"
  else
    die "server did not return ok on $HEALTH_URL within 30 s. Check the logs: $LOGS_HINT"
  fi
fi

# ---------------------------------------------------------------- 6. doctor and next steps

echo
echo "== 6/6 Doctor and next steps =="
DOCTOR_CMD="node $REPO_ROOT/cli/bin/omnichat.mjs doctor --server http://127.0.0.1:$PORT --data-dir $DATA_DIR"
echo "+ $DOCTOR_CMD"
if [ "$DRY_RUN" -eq 0 ]; then
  doctor_rc=0
  node "$REPO_ROOT/cli/bin/omnichat.mjs" doctor --server "http://127.0.0.1:$PORT" --data-dir "$DATA_DIR" || doctor_rc=$?
  if [ "$doctor_rc" -ne 0 ]; then
    echo "(doctor exited $doctor_rc; this is tolerated)"
  fi
fi
echo "Note: the server part of doctor needs an admin login. Create the first administrator (see below),"
echo "then run: omnichat login --server http://127.0.0.1:$PORT"

LAN_IP=""
if [ "$OS_KIND" = linux ]; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
elif [ "$OS_KIND" = macos ]; then
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
fi
case "$HOST" in
  0.0.0.0|::) DISPLAY_HOST="${LAN_IP:-localhost}" ;;
  *) DISPLAY_HOST="$HOST" ;;
esac

if [ "$OS_PLAN" = linux ]; then
  RESTART_CMD="sudo systemctl restart omnichat"
elif [ "$(id -u)" -eq 0 ]; then
  RESTART_CMD="sudo launchctl kickstart -k system/com.omnichat.server"
else
  RESTART_CMD="launchctl kickstart -k gui/$(id -u)/com.omnichat.server"
fi

# the first administrator is created on the machine itself (no HTTP registration for it)
if [ "$OS_PLAN" = linux ]; then
  ADMIN_CMD="sudo omnichat-admin create <username>"
elif [ "$(id -u)" -eq 0 ]; then
  ADMIN_CMD="omnichat-admin create <username>"   # system install: run from your own account, not with sudo
else
  ADMIN_CMD="\"$CONF_DIR/app/omnichat-admin\" create <username>"
fi

echo
if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY RUN complete: nothing was changed. The steps above are what a real run would do."
else
  echo "OmniChat server installed and running."
fi
echo "  Admin:    create the first administrator before anyone can log in (not done by this script):"
echo "            $ADMIN_CMD"
echo "            (the password is asked on the terminal; or use the OmniChat Server app, see docs/SERVER-APP.md)"
echo "  Open:     http://$DISPLAY_HOST:$PORT/   (on this PC: http://localhost:$PORT/), then log in"
echo "  Config:   $CONF_FILE   (after editing: $RESTART_CMD)"
echo "  Data:     $DATA_DIR"
echo "  Logs:     $LOGS_HINT"
echo "  Firewall: open TCP $PORT yourself if needed."

if [ -n "$BRIDGE_NAME" ]; then
  echo
  echo "DeepSeek Harness PC bridge (see docs/DSH.md):"
  echo "  cd $REPO_ROOT/bridge && npm install && npm start -- --server http://$DISPLAY_HOST:$PORT --username <user> --cwd <dir> --name $BRIDGE_NAME"
  echo "  Set OMNICHAT_PASSWORD in the environment for the bridge, not on the command line."
  echo "  In the app: Settings -> Providers -> + Add provider -> preset 'DeepSeek Harness (PC bridge)', baseUrl = $BRIDGE_NAME"
fi
