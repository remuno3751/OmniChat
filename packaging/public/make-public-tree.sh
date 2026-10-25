#!/usr/bin/env bash
# Builds the tree for the PUBLIC repository from the committed files of this (private) repo:
# no .git, internal notes removed, then the pre-publication audits from docs/RELEASING.md §6-1.
# Nothing is pushed. Usage (repo root, clean working tree):  bash packaging/public/make-public-tree.sh [../omnichat-public]
set -euo pipefail

OUT="${1:-../omnichat-public}"
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then echo "refusing: $OUT exists and is not empty"; exit 1; fi
if [ -n "$(git status --porcelain)" ]; then echo "refusing: working tree has uncommitted changes (the archive uses HEAD)"; exit 1; fi

# Internal notes that are not published. docs/HANDOFF.md, NEXT-VERSION.md and DSH-PLUGIN-RESEARCH.md stay: other docs link to them.
# (If you add a name here, the "links to removed notes" check below tells you which docs still point at it.)
INTERNAL=(
  docs/NIGHT-QUEUE.md
  docs/MAC-BUILD-PROMPT.md
  docs/design/V056-TODO.md
)

mkdir -p "$OUT"
git archive --format=tar HEAD | tar -x -C "$OUT"
for f in "${INTERNAL[@]}"; do rm -f "$OUT/$f"; done

# RELEASING.md §6 describes how the private history was dropped: not for the public copy.
if [ -f "$OUT/docs/RELEASING.md" ]; then
  node -e '
    const fs = require("fs"); const p = process.argv[1];
    const s = fs.readFileSync(p, "utf8"); const i = s.indexOf("\n## 6. ");
    if (i >= 0) fs.writeFileSync(p, s.slice(0, i).trimEnd() + "\n");
  ' "$OUT/docs/RELEASING.md"
fi

cd "$OUT"
fail=0

echo "== secrets (must be empty, apart from test dummies)"
grep -rnIE "ghp_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----" . --exclude=package-lock.json --exclude-dir=node_modules \
  | grep -vE "SECRETTOKEN|pre-commit:" || true

echo "== key / certificate files (must be empty)"
found=$(find . \( -name '*.keystore' -o -name '*.jks' -o -name '*.p12' -o -name '*.pfx' -o -name '*.pem' -o -name '*.key' -o -name '.env' \) -not -path './node_modules/*' -print)
if [ -n "$found" ]; then echo "$found"; fail=1; fi

echo "== personal paths / emails (must be empty)"
if grep -rnIiE "C:\\\\Users\\\\renre|/Users/renre|renrenren|@gmail\.com" . --exclude=package-lock.json --exclude=THIRD_PARTY_NOTICES.txt --exclude=make-public-tree.sh --exclude-dir=node_modules; then fail=1; fi

echo "== owner name: only remuno may appear as a person (\"ren\" alone, real addresses, device names; must be empty)"
if grep -rnIiE "(^|[^A-Za-z])ren([^A-Za-z]|$)|renre|192\.168\.0\.(120|152)\b|100\.104\.233|zephyrus" . --exclude=package-lock.json --exclude=THIRD_PARTY_NOTICES.txt --exclude=make-public-tree.sh --exclude-dir=node_modules; then fail=1; fi

echo "== links to removed notes (fix these)"
for f in "${INTERNAL[@]}"; do
  grep -rnI "$(basename "$f")" . --exclude=package-lock.json --exclude=make-public-tree.sh --exclude-dir=node_modules && fail=1 || true
done

echo "== files: $(find . -type f | wc -l)"
if [ "$fail" -ne 0 ]; then echo "AUDIT FAILED: fix the findings above in the private repo, commit, and run again"; exit 2; fi
echo "OK: $OUT is ready (no .git yet). Next: docs/RELEASING.md §6-3 (git init, noreply email, one commit)."
