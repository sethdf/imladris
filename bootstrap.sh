#!/usr/bin/env bash
set -euo pipefail

# Imladris Bootstrap — sets up a fresh EC2 instance as a cloud workstation.
# Run once after launching from AMI or clean instance.
# Idempotent — safe to re-run.

REPOS_DIR="$HOME/repos"
CLAUDE_DIR="$HOME/.claude"

echo "=== Imladris Bootstrap ==="

# --- 1. Clone repos (skip if already present) ---

if [ ! -d "$REPOS_DIR/PAI" ]; then
  echo "[1/6] Cloning PAI..."
  git clone https://github.com/danielmiessler/PAI.git "$REPOS_DIR/PAI"
else
  echo "[1/6] PAI already cloned, pulling latest..."
  git -C "$REPOS_DIR/PAI" pull --ff-only || true
fi

if [ ! -d "$REPOS_DIR/imladris" ]; then
  echo "[1/6] Cloning imladris..."
  git clone https://github.com/sethdf/imladris.git "$REPOS_DIR/imladris"
else
  echo "[1/6] imladris already cloned."
fi

# --- 2. Create symlinks (Claude Code expected paths → repos) ---

echo "[2/6] Creating symlinks..."
mkdir -p "$CLAUDE_DIR"

# Skills: ~/.claude/skills/ → ~/repos/PAI/skills/
if [ -L "$CLAUDE_DIR/skills" ]; then
  rm "$CLAUDE_DIR/skills"
fi
ln -sfn "$REPOS_DIR/PAI/skills" "$CLAUDE_DIR/skills"

# Agents: ~/.claude/agents/ → ~/repos/PAI/agents/
if [ -L "$CLAUDE_DIR/agents" ]; then
  rm "$CLAUDE_DIR/agents"
fi
ln -sfn "$REPOS_DIR/PAI/agents" "$CLAUDE_DIR/agents"

echo "  skills/ → $REPOS_DIR/PAI/skills/"
echo "  agents/ → $REPOS_DIR/PAI/agents/"

# --- 3. Create runtime directories (real, not symlinks) ---

echo "[3/6] Creating runtime directories..."
mkdir -p "$CLAUDE_DIR/MEMORY/WORK"
mkdir -p "$CLAUDE_DIR/MEMORY/STATE"
mkdir -p "$CLAUDE_DIR/MEMORY/LEARNING/REFLECTIONS"
mkdir -p "$CLAUDE_DIR/projects"
mkdir -p "$CLAUDE_DIR/logs"

# --- 4. Settings template (first time only) ---

echo "[4/6] Checking settings.json..."
if [ ! -f "$CLAUDE_DIR/settings.json" ]; then
  if [ -f "$REPOS_DIR/PAI/settings.json.template" ]; then
    cp "$REPOS_DIR/PAI/settings.json.template" "$CLAUDE_DIR/settings.json"
    echo "  Copied settings.json template. Edit as needed."
  else
    echo "  No template found. Create ~/.claude/settings.json manually."
  fi
else
  echo "  settings.json already exists, not overwriting."
fi

# --- 5. Bitwarden Secrets bootstrap ---

echo "[5/6] Checking Bitwarden Secrets..."
if command -v bws &> /dev/null; then
  if [ -n "${BWS_ACCESS_TOKEN:-}" ]; then
    echo "  bws available and token set. Secrets can be synced."
  else
    echo "  bws installed but BWS_ACCESS_TOKEN not set. Set it to enable secret sync."
  fi
else
  echo "  bws not installed. Install: https://bitwarden.com/help/secrets-manager-cli/"
fi

# --- 6. Start services ---

echo "[6/6] Starting services..."
if [ -f "$REPOS_DIR/imladris/docker-compose.yml" ]; then
  cd "$REPOS_DIR/imladris"
  docker compose up -d
  echo "  Windmill started."
else
  echo "  docker-compose.yml not found. Skipping service start."
fi

echo ""
echo "=== Bootstrap complete ==="
echo "  Repos:    $REPOS_DIR/"
echo "  Claude:   $CLAUDE_DIR/"
echo "  Skills:   $CLAUDE_DIR/skills/ → $REPOS_DIR/PAI/skills/"
echo "  Agents:   $CLAUDE_DIR/agents/ → $REPOS_DIR/PAI/agents/"
echo "  Runtime:  $CLAUDE_DIR/MEMORY/"
echo ""
echo "Next steps:"
echo "  1. Configure ~/.claude/settings.json"
echo "  2. Set up Tailscale: tailscale up"
echo "  3. Deploy CloudFormation: see cloudformation/"
