#!/bin/bash
#
# session-sync-setup.sh - Initialize a new session sync repository
#
# Usage:
#   session-sync-setup.sh <name> <directory> <git-remote>
#
# Examples:
#   session-sync-setup.sh home ~/sessions/home git@github.com:user/home-sessions.git
#   session-sync-setup.sh work ~/sessions/work git@github.com:user/work-sessions.git
#
# This will:
#   1. Create the directory if it doesn't exist
#   2. Initialize git repo and configure remote
#   3. Create systemd config
#   4. Enable and start the sync service

set -euo pipefail

NAME="${1:-}"
SYNC_DIR="${2:-}"
GIT_REMOTE="${3:-}"
BRANCH="${4:-main}"

if [[ -z "$NAME" || -z "$SYNC_DIR" || -z "$GIT_REMOTE" ]]; then
    echo "Usage: $0 <name> <directory> <git-remote> [branch]"
    echo ""
    echo "Examples:"
    echo "  $0 home ~/sessions/home git@github.com:user/home-sessions.git"
    echo "  $0 work ~/sessions/work git@github.com:user/work-sessions.git"
    exit 1
fi

# Expand ~ in path
SYNC_DIR="${SYNC_DIR/#\~/$HOME}"

log() {
    echo "[+] $*"
}

error() {
    echo "[!] Error: $*" >&2
    exit 1
}

# Create directory
log "Creating directory: $SYNC_DIR"
mkdir -p "$SYNC_DIR"

# Initialize git repo
cd "$SYNC_DIR"
if [[ ! -d .git ]]; then
    log "Initializing git repository..."
    git init -q
    git checkout -q -b "$BRANCH"

    # Create initial README
    cat > README.md << EOF
# Session Sync: $NAME

Auto-synced session files. Do not edit directly.

Created: $(date '+%Y-%m-%d %H:%M:%S')
EOF
    git add README.md
    git commit -q -m "Initial commit"
fi

# Configure remote
log "Configuring remote: $GIT_REMOTE"
if git remote get-url origin &>/dev/null; then
    git remote set-url origin "$GIT_REMOTE"
else
    git remote add origin "$GIT_REMOTE"
fi

# Try initial push (repo must exist on remote)
log "Pushing to remote..."
if ! git push -u origin "$BRANCH" 2>/dev/null; then
    echo ""
    echo "Warning: Could not push to remote. Make sure the repository exists:"
    echo "  $GIT_REMOTE"
    echo ""
    echo "Create it on GitHub first, then run:"
    echo "  cd $SYNC_DIR && git push -u origin $BRANCH"
    echo ""
fi

# Create systemd config directory
CONFIG_DIR="$HOME/.config/session-sync"
mkdir -p "$CONFIG_DIR"

# Create config file
CONFIG_FILE="$CONFIG_DIR/$NAME.conf"
log "Creating config: $CONFIG_FILE"
cat > "$CONFIG_FILE" << EOF
# Session sync configuration for: $NAME
# Created: $(date '+%Y-%m-%d %H:%M:%S')

SYNC_DIR=$SYNC_DIR
BRANCH=$BRANCH
EOF

# Install service file if not present
SERVICE_FILE="/etc/systemd/system/session-sync@.service"
if [[ ! -f "$SERVICE_FILE" ]]; then
    log "Installing systemd service template..."
    SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
    if [[ -f "$SCRIPT_DIR/session-sync@.service" ]]; then
        sudo cp "$SCRIPT_DIR/session-sync@.service" "$SERVICE_FILE"
        sudo systemctl daemon-reload
    else
        echo "Warning: session-sync@.service not found. Install manually."
    fi
fi

# Install sync script if not present
SYNC_SCRIPT="/usr/local/bin/session-sync.sh"
if [[ ! -f "$SYNC_SCRIPT" ]]; then
    log "Installing session-sync.sh..."
    SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
    if [[ -f "$SCRIPT_DIR/session-sync.sh" ]]; then
        sudo cp "$SCRIPT_DIR/session-sync.sh" "$SYNC_SCRIPT"
        sudo chmod +x "$SYNC_SCRIPT"
    else
        echo "Warning: session-sync.sh not found. Install manually."
    fi
fi

# Enable and start service
log "Enabling session-sync@$NAME service..."
systemctl --user daemon-reload 2>/dev/null || true
systemctl --user enable "session-sync@$NAME" 2>/dev/null || true
systemctl --user start "session-sync@$NAME" 2>/dev/null || {
    echo ""
    echo "Note: Could not start service (might need user session)."
    echo "Start manually with: systemctl --user start session-sync@$NAME"
}

echo ""
echo "Session sync configured for '$NAME'"
echo "  Directory: $SYNC_DIR"
echo "  Remote:    $GIT_REMOTE"
echo "  Branch:    $BRANCH"
echo ""
echo "Commands:"
echo "  Status:  systemctl --user status session-sync@$NAME"
echo "  Logs:    journalctl --user -u session-sync@$NAME -f"
echo "  Stop:    systemctl --user stop session-sync@$NAME"
echo "  Restart: systemctl --user restart session-sync@$NAME"
