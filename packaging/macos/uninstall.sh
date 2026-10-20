#!/bin/sh
# Removes the OmniChat launchd job and program. Config and data are KEPT unless --purge is given.
#   sudo ./uninstall.sh [--purge]    (system install)      ./uninstall.sh [--purge]   (per-user install)
set -eu
LABEL=com.omnichat.server
if [ "$(id -u)" -eq 0 ]; then
  PLIST=/Library/LaunchDaemons/$LABEL.plist
  launchctl bootout system "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf /usr/local/omnichat
  rm -f /usr/local/bin/omnichat-admin
  BASE=/usr/local/omnichat-data
else
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf "$HOME/Library/Application Support/OmniChat/app"
  BASE="$HOME/Library/Application Support/OmniChat"
fi
if [ "${1:-}" = "--purge" ]; then
  rm -rf "$BASE"
  echo "Removed program, config and data."
else
  echo "Removed program and launchd job. Kept $BASE (use --purge to delete it)."
fi
