#!/usr/bin/env bash
# Fetch external projects referenced by imladris.
# Each tool is installed from its upstream — we never vendor the code.

set -euo pipefail

REPOS_DIR="${REPOS_DIR:-${HOME}/repos}"
mkdir -p "$REPOS_DIR"

# --- Ruflo (claude-flow CLI, consumed via the ruflo wrapper binary) ---
# upstream: https://github.com/ruvnet/claude-flow
if ! command -v ruflo >/dev/null 2>&1; then
  echo "installing @claude-flow/cli globally"
  npm i -g @claude-flow/cli
else
  echo "ruflo already present: $(which ruflo)"
fi

# --- PAI upstream (reference clone — not a fork) ---
# upstream: https://github.com/danielmiessler/PAI
if [ ! -d "${REPOS_DIR}/PAI/.git" ]; then
  echo "cloning danielmiessler/PAI -> ${REPOS_DIR}/PAI"
  git clone https://github.com/danielmiessler/PAI.git "${REPOS_DIR}/PAI"
else
  echo "PAI upstream already cloned at ${REPOS_DIR}/PAI"
fi

# --- Add future external references here (Fabric etc.) ---
# Pattern: check-if-present, then install/clone from upstream. Never vendor.

echo "done."
