#!/usr/bin/env bash
# link.sh — Symlink modules/pai/* subtrees into ~/.claude/
# Idempotent. Source of truth is this repo; ~/.claude/ just points here.
# Leaves existing install.sh (upstream PAI installer) alone.

set -euo pipefail

MODULE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.claude"
mkdir -p "$TARGET_DIR"

# Subtrees to link. Runtime data (MEMORY, projects, sessions, cache, logs, etc.)
# stays in ~/.claude/ and is NOT tracked by git.
ENTRIES=(
  CLAUDE.md
  CLAUDE.md.template
  install.sh
  PAI
  PAI-Install
  skills
  hooks
  agents
  lib
  VoiceServer
  Observability
  WORK
)

link_entry() {
  local name="$1"
  local src="${MODULE_DIR}/${name}"
  local dst="${TARGET_DIR}/${name}"

  [ -e "$src" ] || { echo "skip (not in repo): $name"; return 0; }

  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    echo "ok (already linked): $name"
    return 0
  fi

  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    local bak="${dst}.pre-pai-install.$(date +%s)"
    echo "backing up existing $dst -> $bak"
    mv "$dst" "$bak"
  fi

  ln -sfn "$src" "$dst"
  echo "linked: $name -> $src"
}

for e in "${ENTRIES[@]}"; do link_entry "$e"; done

# settings.json: never symlink (runtime-mutable + contains secrets).
# Only render from template on first run.
if [ ! -f "${TARGET_DIR}/settings.json" ]; then
  echo "rendering initial settings.json from template"
  "${MODULE_DIR}/install-settings.sh"
else
  echo "settings.json exists — not touched (run install-settings.sh --force to replace)"
fi

echo "done. PAI source now served from ${MODULE_DIR}"
