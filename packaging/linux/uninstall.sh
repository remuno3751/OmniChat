#!/bin/sh
# Removes the OmniChat service and program. Config and data are KEPT unless --purge is given.
#   sudo ./uninstall.sh [--purge]
set -eu
[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }
systemctl disable --now omnichat 2>/dev/null || true
rm -f /etc/systemd/system/omnichat.service
rm -f /usr/local/bin/omnichat-admin
systemctl daemon-reload 2>/dev/null || true
rm -rf /opt/omnichat
if [ "${1:-}" = "--purge" ]; then
  rm -rf /etc/omnichat /var/lib/omnichat
  if id omnichat >/dev/null 2>&1; then userdel omnichat || true; fi
  echo "Removed program, config and data."
else
  echo "Removed program and service. Kept /etc/omnichat and /var/lib/omnichat (use --purge to delete them)."
fi
