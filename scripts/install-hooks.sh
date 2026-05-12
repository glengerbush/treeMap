#!/usr/bin/env bash
set -euo pipefail
repo_root=$(git rev-parse --show-toplevel)
chmod +x "$repo_root/.githooks/pre-commit" "$repo_root/.githooks/post-commit"
git config core.hooksPath .githooks
echo "Installed hooks: core.hooksPath -> .githooks"
