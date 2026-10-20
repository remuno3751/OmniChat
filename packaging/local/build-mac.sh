#!/usr/bin/env bash
# Builds the macOS desktop client (universal DMG) on a Mac and uploads it to the release of the tag.
#   packaging/local/build-mac.sh v0.1.0-beta.9            # build + upload
#   packaging/local/build-mac.sh v0.1.0-beta.9 --no-upload
# Run it from an up-to-date checkout of the commit the tag points at (git pull first).
# Needs: Node 24, Rust (rustup), Xcode command line tools; `git credential fill` must give a GitHub token (same as `git push`).
set -euo pipefail
TAG="${1:?usage: build-mac.sh <tag> [--no-upload]}"
cd "$(dirname "$0")/../.."
# Keep the account name out of the binary (Rust panic locations carry the cargo registry path).
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=/build --remap-path-prefix=$PWD=."
rustup target add aarch64-apple-darwin x86_64-apple-darwin
node desktop/tools/set-version.mjs "$TAG"
trap 'git checkout -q -- desktop/src-tauri/tauri.conf.json desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock 2>/dev/null || true' EXIT
(cd desktop && npm ci --no-audit --no-fund && npx tauri build --target universal-apple-darwin --bundles dmg)
# every built binary (x86_64, arm64 and the universal one), not just the first
find desktop/src-tauri/target -type f -path '*/release/omnichat-desktop' -print0 | xargs -0 node packaging/local/scan-leaks.mjs
mkdir -p out
dmg="$(find desktop/src-tauri/target -type f -path '*/bundle/dmg/*.dmg' | head -1)"
test -n "$dmg"
cp "$dmg" "out/OmniChat-Desktop-${TAG}-macOS-universal.dmg"
cp "$dmg" "out/OmniChat-Desktop-macOS-universal.dmg"   # version-less alias for releases/latest/download/
(cd out && shasum -a 256 "OmniChat-Desktop-$TAG-macOS-universal.dmg" OmniChat-Desktop-macOS-universal.dmg > SHA256SUMS-desktop-mac.txt)   # this tag only: older DMGs left in out/ stay out of the sums
ls -l out
if [ "${2:-}" != "--no-upload" ]; then
  node packaging/local/upload.mjs "$TAG" out/OmniChat-Desktop-"${TAG}"-macOS-universal.dmg out/OmniChat-Desktop-macOS-universal.dmg out/SHA256SUMS-desktop-mac.txt
fi
