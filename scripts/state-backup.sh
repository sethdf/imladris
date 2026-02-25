#!/usr/bin/env bash
set -euo pipefail

# state-backup.sh — Back up all stateful data to S3, encrypted with CMK.
# Runs on EC2 with IAM role (no credentials needed).

BUCKET="imladris-state-767448074758"
KMS_KEY="alias/workstation-ebs"
REGION="us-east-1"
HOME_DIR="/home/ec2-user"
LOG_FILE="${HOME_DIR}/.claude/logs/state-backup.log"
TODAY=$(date +%Y-%m-%d)
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

SSE_ARGS=(--sse aws:kms --sse-kms-key-id "${KMS_KEY}" --region "${REGION}")

# Ensure log directory exists
mkdir -p "$(dirname "${LOG_FILE}")"

# Log helper — writes to log file with timestamp
log() {
    echo "[${TIMESTAMP}] $*" | tee -a "${LOG_FILE}"
}

cleanup() {
    local exit_code=$?
    if [[ ${exit_code} -ne 0 ]]; then
        log "ERROR: Backup failed with exit code ${exit_code}"
    fi
    # Clean up temp files
    rm -f "${TMPDIR:-/tmp}/windmill-db-backup.sql.gz"
    exit ${exit_code}
}
trap cleanup EXIT

log "=== Starting state backup ==="

# 1. Sync ~/.claude/ to S3 (incremental, excluding symlinked dirs)
log "Syncing ~/.claude/ to s3://${BUCKET}/latest/claude/ ..."
aws s3 sync "${HOME_DIR}/.claude/" "s3://${BUCKET}/latest/claude/" \
    --exclude "skills/*" \
    --exclude "agents/*" \
    --exclude "hooks/*" \
    --no-follow-symlinks \
    --delete \
    "${SSE_ARGS[@]}" \
    2>&1 | tee -a "${LOG_FILE}"
log "Claude directory sync complete."

# 2. Dump Windmill Postgres → gzip → upload
log "Dumping Windmill Postgres database..."
DUMP_FILE="${TMPDIR:-/tmp}/windmill-db-backup.sql.gz"
docker exec imladris-windmill_db-1 pg_dump -U postgres windmill | gzip > "${DUMP_FILE}"
log "Uploading windmill-db.sql.gz to S3..."
aws s3 cp "${DUMP_FILE}" "s3://${BUCKET}/latest/windmill-db.sql.gz" \
    "${SSE_ARGS[@]}" \
    2>&1 | tee -a "${LOG_FILE}"
log "Windmill DB backup complete."

# 3. Upload .env file
log "Uploading .env file..."
aws s3 cp "${HOME_DIR}/repos/imladris/.env" "s3://${BUCKET}/latest/env-file" \
    "${SSE_ARGS[@]}" \
    2>&1 | tee -a "${LOG_FILE}"
log ".env upload complete."

# 4. Sync ~/.wmill/ to S3
log "Syncing ~/.wmill/ to S3..."
aws s3 sync "${HOME_DIR}/.wmill/" "s3://${BUCKET}/latest/wmill/" \
    --delete \
    "${SSE_ARGS[@]}" \
    2>&1 | tee -a "${LOG_FILE}"
log "wmill config sync complete."

# 5. Create daily snapshot if it doesn't exist yet
DAILY_PREFIX="daily/${TODAY}/"
DAILY_EXISTS=$(aws s3api list-objects-v2 \
    --bucket "${BUCKET}" \
    --prefix "${DAILY_PREFIX}" \
    --max-keys 1 \
    --region "${REGION}" \
    --query 'KeyCount' \
    --output text 2>/dev/null || echo "0")

if [[ "${DAILY_EXISTS}" == "0" ]]; then
    log "Creating daily snapshot for ${TODAY}..."

    # Copy latest/ → daily/YYYY-MM-DD/ (server-side copy)
    aws s3 sync "s3://${BUCKET}/latest/" "s3://${BUCKET}/${DAILY_PREFIX}" \
        "${SSE_ARGS[@]}" \
        2>&1 | tee -a "${LOG_FILE}"
    log "Daily snapshot created."

    # Prune daily snapshots older than 30 days
    log "Pruning daily snapshots older than 30 days..."
    CUTOFF=$(date -d "30 days ago" +%Y-%m-%d 2>/dev/null || date --date="30 days ago" +%Y-%m-%d)
    aws s3 ls "s3://${BUCKET}/daily/" --region "${REGION}" 2>/dev/null | while read -r _ _ _ prefix; do
        # prefix looks like "YYYY-MM-DD/"
        dir_date="${prefix%/}"
        if [[ "${dir_date}" < "${CUTOFF}" ]]; then
            log "Removing old snapshot: daily/${dir_date}/"
            aws s3 rm "s3://${BUCKET}/daily/${dir_date}/" \
                --recursive \
                --region "${REGION}" \
                2>&1 | tee -a "${LOG_FILE}"
        fi
    done
    log "Pruning complete."
else
    log "Daily snapshot for ${TODAY} already exists, skipping."
fi

log "=== State backup completed successfully ==="
exit 0
