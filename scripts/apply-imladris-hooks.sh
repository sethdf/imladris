#!/usr/bin/env bash
# =============================================================================
# apply-imladris-hooks.sh — Idempotent Imladris Hook + Settings Deployment
# =============================================================================
# Adds imladris-specific hooks and settings.json registrations on top of PAI.
# PAI owns ~/.claude/hooks/ directory (installed via AI installer).
# Imladris adds individual symlinks for its custom hooks into that directory.
#
# Safe to run multiple times. Safe after PAI updates.
#
# Usage:
#   ./scripts/apply-imladris-hooks.sh [--repo-dir /path/to/imladris]
#
# Environment:
#   IMLADRIS_REPO_DIR — Override repo location (default: auto-detect from script location)

set -euo pipefail

# ========================================
# Configuration
# ========================================

CLAUDE_DIR="${HOME}/.claude"
HOOKS_DIR="${CLAUDE_DIR}/hooks"
SETTINGS_FILE="${CLAUDE_DIR}/settings.json"

# Detect repo dir from script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${IMLADRIS_REPO_DIR:-$(dirname "$SCRIPT_DIR")}"

# Parse --repo-dir flag
while [[ $# -gt 0 ]]; do
  case $1 in
    --repo-dir) REPO_DIR="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

HOOK_SOURCE="${REPO_DIR}/pai-config/hooks"

# Imladris custom hooks (these are the ONLY hooks imladris owns)
CUSTOM_HOOKS=(
  McpLogger.hook.ts
  McpSecurityValidator.hook.ts
  PrdSync.hook.ts
  StateSnapshot.hook.ts
  ContextCompaction.hook.ts
  CrossWorkstreamLearning.hook.ts
)

# ========================================
# Validation
# ========================================

if [[ ! -d "$HOOK_SOURCE" ]]; then
  echo "ERROR: Hook source dir not found: $HOOK_SOURCE" >&2
  exit 1
fi

if [[ ! -d "$CLAUDE_DIR" ]]; then
  echo "ERROR: ~/.claude directory not found. Install PAI first." >&2
  exit 1
fi

# Ensure hooks directory exists (PAI installer should create it, but be safe)
mkdir -p "$HOOKS_DIR"

# ========================================
# Step 1: Symlink imladris hooks into ~/.claude/hooks/
# ========================================

echo "=== Symlinking imladris hooks ==="

for hook in "${CUSTOM_HOOKS[@]}"; do
  src="${HOOK_SOURCE}/${hook}"
  dest="${HOOKS_DIR}/${hook}"

  if [[ ! -f "$src" ]]; then
    echo "  SKIP: ${hook} (source not found)"
    continue
  fi

  # Remove existing file/symlink at destination
  if [[ -e "$dest" || -L "$dest" ]]; then
    rm -f "$dest"
  fi

  ln -sf "$src" "$dest"
  echo "  OK: ${hook}"
done

# ========================================
# Step 2: Merge imladris hook registrations into settings.json
# ========================================

echo "=== Updating settings.json hook registrations ==="

if [[ ! -f "$SETTINGS_FILE" ]]; then
  echo "  WARN: settings.json not found — creating minimal"
  echo '{"hooks":{}}' > "$SETTINGS_FILE"
fi

# Use bun to merge (jq may not be available; bun always is on imladris)
bun -e "
const fs = require('fs');
const path = '${SETTINGS_FILE}';
const settings = JSON.parse(fs.readFileSync(path, 'utf-8'));

// Ensure hooks structure exists
if (!settings.hooks) settings.hooks = {};
if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];

// Helper: ensure a hook registration exists for a tool-event matcher (PreToolUse/PostToolUse)
function ensureToolHook(eventArray, matcher, command) {
  let entry = eventArray.find(e => e.matcher === matcher);
  if (!entry) {
    entry = { matcher, hooks: [] };
    eventArray.push(entry);
  }
  const exists = entry.hooks.some(h => h.command === command);
  if (!exists) {
    entry.hooks.push({ type: 'command', command });
  }
}

// Helper: ensure a hook exists for non-tool events (SessionEnd, UserPromptSubmit, etc.)
// These use {hooks: [...]} without a matcher field
function ensureEventHook(eventArray, command) {
  // Find existing wrapper (first entry without matcher, or create one)
  let entry = eventArray.find(e => !e.matcher && e.hooks);
  if (!entry) {
    entry = { hooks: [] };
    eventArray.push(entry);
  }
  const exists = entry.hooks.some(h => h.command === command);
  if (!exists) {
    entry.hooks.push({ type: 'command', command });
  }
}

// --- Imladris hook registrations ---

// McpSecurityValidator (PreToolUse: mcp__*)
ensureToolHook(settings.hooks.PreToolUse, 'mcp__*',
  'bun run \$HOME/.claude/hooks/McpSecurityValidator.hook.ts');

// McpLogger (PreToolUse + PostToolUse: mcp__*)
ensureToolHook(settings.hooks.PreToolUse, 'mcp__*',
  'bun run \$HOME/.claude/hooks/McpLogger.hook.ts');
ensureToolHook(settings.hooks.PostToolUse, 'mcp__*',
  'bun run \$HOME/.claude/hooks/McpLogger.hook.ts');

// PrdSync (PostToolUse: TaskCreate, TaskUpdate)
ensureToolHook(settings.hooks.PostToolUse, 'TaskCreate',
  'bun run \$HOME/.claude/hooks/PrdSync.hook.ts');
ensureToolHook(settings.hooks.PostToolUse, 'TaskUpdate',
  'bun run \$HOME/.claude/hooks/PrdSync.hook.ts');

// StateSnapshot (PostToolUse: Bash, TaskCreate, TaskUpdate)
ensureToolHook(settings.hooks.PostToolUse, 'Bash',
  'bun run \$HOME/.claude/hooks/StateSnapshot.hook.ts');
ensureToolHook(settings.hooks.PostToolUse, 'TaskCreate',
  'bun run \$HOME/.claude/hooks/StateSnapshot.hook.ts');
ensureToolHook(settings.hooks.PostToolUse, 'TaskUpdate',
  'bun run \$HOME/.claude/hooks/StateSnapshot.hook.ts');

// ContextCompaction (UserPromptSubmit — no matcher, flat wrapper)
ensureEventHook(settings.hooks.UserPromptSubmit,
  'bun run \$HOME/.claude/hooks/ContextCompaction.hook.ts');

// CrossWorkstreamLearning (SessionEnd — no matcher, flat wrapper)
ensureEventHook(settings.hooks.SessionEnd,
  'bun run \$HOME/.claude/hooks/CrossWorkstreamLearning.hook.ts');

// Write back atomically
const tmp = path + '.tmp.' + Date.now();
fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
fs.renameSync(tmp, path);
console.log('  OK: settings.json updated');
"

# ========================================
# Step 3: Ensure MCP server config (Windmill)
# ========================================

echo "=== Verifying MCP server config ==="

bun -e "
const fs = require('fs');
const path = '${SETTINGS_FILE}';
const settings = JSON.parse(fs.readFileSync(path, 'utf-8'));

if (!settings.mcpServers) settings.mcpServers = {};

// Windmill MCP (only add if not present — token may vary)
if (!settings.mcpServers.windmill) {
  console.log('  WARN: windmill MCP not configured — add manually with token');
} else {
  console.log('  OK: windmill MCP present');
}

fs.writeFileSync(path, JSON.stringify(settings, null, 2));
"

echo ""
echo "=== Done. Imladris hooks applied on top of PAI. ==="
echo "Custom hooks: ${#CUSTOM_HOOKS[@]}"
echo "Run 'claude' to verify hooks load correctly."
