#!/bin/bash
# Sync encrypted volume backups to S3 for offsite storage

set -euo pipefail

BACKUP_BASE="/data/backups"
S3_BUCKET="${BACKUP_S3_BUCKET:-}"
AWS_PROFILE="${BACKUP_AWS_PROFILE:-default}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
error() { echo "[ERROR] $*" >&2; exit 1; }

if [ -z "$S3_BUCKET" ]; then
    error "BACKUP_S3_BUCKET not set. Export it or add to /etc/environment"
fi

if [ ! -d "$BACKUP_BASE" ]; then
    error "Backup directory not found: $BACKUP_BASE"
fi

log "Syncing $BACKUP_BASE to $S3_BUCKET"
log "Using AWS profile: $AWS_PROFILE"

# Sync with intelligent tiering for cost optimization
# --delete removes files from S3 that no longer exist locally
aws s3 sync "$BACKUP_BASE" "$S3_BUCKET/backups" \
    --profile "$AWS_PROFILE" \
    --storage-class INTELLIGENT_TIERING \
    --exclude "*.tmp" \
    --exclude ".DS_Store"

log "S3 sync complete"

# Show bucket size
log "S3 bucket size:"
aws s3 ls --summarize --recursive "$S3_BUCKET/backups" --profile "$AWS_PROFILE" | tail -2
