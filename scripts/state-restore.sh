#!/usr/bin/env bash
set -euo pipefail

# state-restore.sh — Restore all state from S3 backup after fresh deploy.
# Runs on EC2 with IAM role (no credentials needed).
# Logs to stdout (interactive use during deploy).

BUCKET="imladris-state-767448074758"
KMS_KEY="alias/workstation-ebs"
REGION="us-east-1"
HOME_DIR="/home/ec2-user"

SSE_ARGS=(--sse aws:kms --sse-kms-key-id "${KMS_KEY}" --region "${REGION}")

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

# Check if a backup exists in S3
check_backup_exists() {
    local prefix="$1"
    local count
    count=$(aws s3api list-objects-v2 \
        --bucket "${BUCKET}" \
        --prefix "${prefix}" \
        --max-keys 1 \
        --region "${REGION}" \
        --query 'KeyCount' \
        --output text 2>/dev/null || echo "0")
    [[ "${count}" != "0" ]]
}

# Wait for Docker container to be healthy
wait_for_docker() {
    local container="$1"
    local max_wait=120
    local waited=0

    log "Waiting for Docker container '${container}' to be ready..."

    while [[ ${waited} -lt ${max_wait} ]]; do
        # Check if container exists and is running
        if docker inspect --format='{{.State.Running}}' "${container}" 2>/dev/null | grep -q true; then
            # Try a simple query to confirm Postgres is accepting connections
            if docker exec "${container}" pg_isready -U postgres -q 2>/dev/null; then
                log "Container '${container}' is ready."
                return 0
            fi
        fi
        sleep 2
        waited=$((waited + 2))
        if (( waited % 10 == 0 )); then
            log "Still waiting for '${container}'... (${waited}s/${max_wait}s)"
        fi
    done

    log "ERROR: Container '${container}' did not become ready within ${max_wait}s."
    return 1
}

log "=== Starting state restore from s3://${BUCKET}/latest/ ==="

# 1. Restore ~/.claude/ (preserve symlinks — don't overwrite them)
log "Restoring ~/.claude/ directory..."
if check_backup_exists "latest/claude/"; then
    mkdir -p "${HOME_DIR}/.claude"
    aws s3 sync "s3://${BUCKET}/latest/claude/" "${HOME_DIR}/.claude/" \
        --no-follow-symlinks \
        "${SSE_ARGS[@]}"
    log "Claude directory restored. Symlinks (skills/, agents/, hooks/) preserved."
else
    log "WARNING: No claude/ backup found in S3. Skipping."
fi

# 1b. Restore ~/.claude.json (Claude Code config — lives in home root, not ~/.claude/)
log "Restoring .claude.json..."
if check_backup_exists "latest/claude-config.json"; then
    aws s3 cp "s3://${BUCKET}/latest/claude-config.json" "${HOME_DIR}/.claude.json" \
        "${SSE_ARGS[@]}"
    chmod 600 "${HOME_DIR}/.claude.json"
    log ".claude.json restored (chmod 600)."
else
    log "WARNING: No claude-config.json backup found in S3. Skipping."
fi

# 2. Restore .env file
log "Restoring .env file..."
if check_backup_exists "latest/env-file"; then
    mkdir -p "${HOME_DIR}/repos/imladris"
    aws s3 cp "s3://${BUCKET}/latest/env-file" "${HOME_DIR}/repos/imladris/.env" \
        "${SSE_ARGS[@]}"
    chmod 600 "${HOME_DIR}/repos/imladris/.env"
    log ".env file restored (chmod 600)."
else
    log "WARNING: No env-file backup found in S3. Skipping."
fi

# 3. Restore wmill config
WMILL_CONFIG_DIR="${HOME_DIR}/.config/windmill"
log "Restoring wmill config..."
if check_backup_exists "latest/wmill/"; then
    mkdir -p "${WMILL_CONFIG_DIR}"
    aws s3 sync "s3://${BUCKET}/latest/wmill/" "${WMILL_CONFIG_DIR}/" \
        "${SSE_ARGS[@]}"
    log "wmill config restored."
else
    log "WARNING: No wmill/ backup found in S3. Skipping."
fi

# 4. Restore Windmill Postgres database
log "Restoring Windmill Postgres database..."
if check_backup_exists "latest/windmill-db.sql.gz"; then
    DB_CONTAINER=$(docker ps --format '{{.Names}}' | grep windmill_db || echo "imladris-windmill_db-1")
    wait_for_docker "${DB_CONTAINER}"

    DUMP_FILE="${TMPDIR:-/tmp}/windmill-db-restore.sql.gz"
    aws s3 cp "s3://${BUCKET}/latest/windmill-db.sql.gz" "${DUMP_FILE}" \
        "${SSE_ARGS[@]}"

    log "Dropping and recreating windmill database..."
    docker exec "${DB_CONTAINER}" psql -U postgres -c "DROP DATABASE IF EXISTS windmill;" 2>/dev/null || true
    docker exec "${DB_CONTAINER}" psql -U postgres -c "CREATE DATABASE windmill;" 2>/dev/null

    log "Loading database dump..."
    gunzip -c "${DUMP_FILE}" | docker exec -i "${DB_CONTAINER}" psql -U postgres windmill

    rm -f "${DUMP_FILE}"
    log "Windmill database restored."
else
    log "No windmill-db.sql.gz found in S3 — skipping DB restore (fresh install)."
fi

log "=== State restore completed successfully ==="
exit 0
