#!/bin/bash
# Backup all stateful/AI-generated content to encrypted volume
# Then sync to S3 for offsite backup

set -euo pipefail

BACKUP_BASE="/data/backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$BACKUP_BASE/daily/$TIMESTAMP"
LATEST_LINK="$BACKUP_BASE/latest"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
error() { echo "[ERROR] $*" >&2; exit 1; }

# Ensure backup directory exists
mkdir -p "$BACKUP_DIR"

log "Starting stateful backup to $BACKUP_DIR"

# Backup AI/stateful content
declare -A BACKUP_PATHS=(
    ["claude"]="$HOME/.claude"
    ["repos"]="$HOME/repos"
    ["bin"]="$HOME/bin"
    ["config"]="$HOME/.config"
    ["ssh"]="$HOME/.ssh"
    ["aws"]="$HOME/.aws"
    ["zsh"]="$HOME/.zshrc"
    ["secrets"]="$HOME/.secrets"
)

for name in "${!BACKUP_PATHS[@]}"; do
    src="${BACKUP_PATHS[$name]}"
    if [ -e "$src" ]; then
        log "Backing up: $name"
        rsync -a --delete "$src" "$BACKUP_DIR/$name/" 2>/dev/null || \
        rsync -a "$src" "$BACKUP_DIR/$name" 2>/dev/null || \
        log "  Warning: Could not backup $src"
    fi
done

# Update latest symlink
rm -f "$LATEST_LINK"
ln -s "$BACKUP_DIR" "$LATEST_LINK"

# Cleanup old backups (keep last 7 days)
find "$BACKUP_BASE/daily" -maxdepth 1 -type d -mtime +7 -exec rm -rf {} \; 2>/dev/null || true

log "Local backup complete: $BACKUP_DIR"
log "Backup size: $(du -sh "$BACKUP_DIR" | cut -f1)"

# Optional: Sync to S3 (uncomment when ready)
# S3_BUCKET="s3://your-backup-bucket/imladris"
# if command -v aws &>/dev/null; then
#     log "Syncing to S3: $S3_BUCKET"
#     aws s3 sync "$BACKUP_BASE" "$S3_BUCKET" --delete --storage-class INTELLIGENT_TIERING
# fi

log "Backup complete"
