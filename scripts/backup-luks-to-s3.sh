#!/bin/bash
# Create a full backup of the LUKS encrypted volume to S3
# This preserves the encryption - you'll need the LUKS passphrase to restore

set -euo pipefail

DEVICE="/dev/nvme1n1"  # The encrypted device
S3_BUCKET="${BACKUP_S3_BUCKET:-}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TEMP_FILE="/tmp/luks-backup-$TIMESTAMP.img.gz"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
error() { echo "[ERROR] $*" >&2; exit 1; }

if [ -z "$S3_BUCKET" ]; then
    error "BACKUP_S3_BUCKET not set"
fi

if [ ! -b "$DEVICE" ]; then
    error "Device not found: $DEVICE"
fi

# Check available space
DEVICE_SIZE=$(blockdev --getsize64 "$DEVICE" 2>/dev/null || echo "0")
FREE_SPACE=$(df /tmp --output=avail | tail -1)
REQUIRED=$((DEVICE_SIZE / 1024))  # Convert to KB

log "Device size: $((DEVICE_SIZE / 1024 / 1024 / 1024))GB"
log "Free space: $((FREE_SPACE / 1024 / 1024))GB"

if [ "$FREE_SPACE" -lt "$REQUIRED" ]; then
    log "Not enough temp space, streaming directly to S3..."
    
    # Stream directly to S3 (no local copy)
    sudo dd if="$DEVICE" bs=1M status=progress | \
        gzip -9 | \
        aws s3 cp - "$S3_BUCKET/luks-full-backups/luks-$TIMESTAMP.img.gz" \
            --storage-class GLACIER_IR
else
    log "Creating compressed backup: $TEMP_FILE"
    sudo dd if="$DEVICE" bs=1M status=progress | gzip -9 > "$TEMP_FILE"
    
    log "Uploading to S3: $S3_BUCKET"
    aws s3 cp "$TEMP_FILE" "$S3_BUCKET/luks-full-backups/luks-$TIMESTAMP.img.gz" \
        --storage-class GLACIER_IR
    
    rm -f "$TEMP_FILE"
fi

log "LUKS volume backup complete"
log "To restore: aws s3 cp $S3_BUCKET/luks-full-backups/luks-$TIMESTAMP.img.gz - | gunzip | sudo dd of=/dev/nvme1n1 bs=1M"
