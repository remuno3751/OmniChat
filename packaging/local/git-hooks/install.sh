#!/bin/sh
# Installs the pre-commit hook into this clone.
cd "$(git rev-parse --show-toplevel)" || exit 1
cp packaging/local/git-hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
echo "pre-commit hook installed"
