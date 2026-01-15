#!/usr/bin/env bash
# backup-to-gdrive - Sync /data to Google Drive for offsite backup
set -euo pipefail

BACKUP_SOURCE="/data"
GDRIVE_REMOTE="gdrive"
GDRIVE_PATH="imladris-backup"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# Check rclone is configured
if ! rclone listremotes | grep -q "^${GDRIVE_REMOTE}:$"; then
    echo "Error: rclone remote '$GDRIVE_REMOTE' not configured"
    echo ""
    echo "To set up Google Drive backup:"
    echo "  1. On a machine with a browser, run: rclone authorize \"drive\""
    echo "  2. Copy the token output"
    echo "  3. Run: rclone config"
    echo "  4. Edit 'gdrive' remote and paste the token"
    exit 1
fi

log "Starting backup to Google Drive..."
log "Source: $BACKUP_SOURCE"
log "Destination: ${GDRIVE_REMOTE}:${GDRIVE_PATH}"

# Sync with progress, excluding unnecessary files
rclone sync "$BACKUP_SOURCE" "${GDRIVE_REMOTE}:${GDRIVE_PATH}" \
    --progress \
    --exclude "lost+found/**" \
    --exclude "backups/**" \
    --transfers 4 \
    --checkers 8 \
    --contimeout 60s \
    --timeout 300s \
    --retries 3 \
    --low-level-retries 10 \
    "$@"

log "Backup complete!"
log ""
log "To verify: rclone ls ${GDRIVE_REMOTE}:${GDRIVE_PATH}"
log "To check size: rclone size ${GDRIVE_REMOTE}:${GDRIVE_PATH}"
