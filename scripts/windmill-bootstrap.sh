#!/usr/bin/env bash
set -euo pipefail

# Windmill Bootstrap Script
# Runs after Ansible deploys Windmill containers on a fresh EC2 instance.
# Makes Windmill fully operational without manual steps.

WINDMILL_URL="http://localhost:8000"
S3_BUCKET="imladris-state-767448074758"
S3_REGION="us-east-1"
SCRIPTS_DIR="$HOME/repos/imladris/windmill/f/devops"
BOOTSTRAP_DIR="$HOME/repos/imladris/scripts"
MAX_RETRIES=60
RETRY_INTERVAL=5

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

die() {
  log "FATAL: $*"
  exit 1
}

warn() {
  log "WARN: $*"
}

# ---------------------------------------------------------------------------
# Step 1: Wait for Windmill server to be healthy
# ---------------------------------------------------------------------------
log "Step 1: Waiting for Windmill server to be healthy..."

healthy=false
for i in $(seq 1 "$MAX_RETRIES"); do
  if curl -sf "${WINDMILL_URL}/api/version" >/dev/null 2>&1; then
    healthy=true
    break
  fi
  log "  Attempt $i/$MAX_RETRIES - server not ready, retrying in ${RETRY_INTERVAL}s..."
  sleep "$RETRY_INTERVAL"
done

if [ "$healthy" != "true" ]; then
  die "Windmill server did not become healthy after $((MAX_RETRIES * RETRY_INTERVAL))s"
fi

log "Windmill server is healthy."

# ---------------------------------------------------------------------------
# Step 2: Check for S3 backup and branch accordingly
# ---------------------------------------------------------------------------
log "Step 2: Checking for S3 backup..."

s3_backup_exists=false
if aws s3 ls "s3://${S3_BUCKET}/latest/windmill-db.sql.gz" --region "$S3_REGION" >/dev/null 2>&1; then
  s3_backup_exists=true
  log "S3 backup found. Restoring from backup."
else
  log "No S3 backup found. Proceeding with fresh install."
fi

if [ "$s3_backup_exists" = "true" ]; then
  # --- Restore path ---
  log "Running state-restore.sh..."
  if bash "${BOOTSTRAP_DIR}/state-restore.sh"; then
    log "State restore completed."
  else
    warn "state-restore.sh failed (exit $?). Continuing with credential sync."
  fi

  log "Refreshing credentials after restore..."
  if bash "${BOOTSTRAP_DIR}/sync-credentials.sh"; then
    log "Credential sync completed."
  else
    warn "sync-credentials.sh failed (exit $?). Credentials may be stale."
  fi

else
  # --- Fresh install path ---

  # 2a. Generate admin API token
  log "Step 2a: Generating Windmill admin API token..."
  TOKEN=""
  TOKEN=$(curl -sf -X POST "${WINDMILL_URL}/api/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"email":"admin@windmill.dev","password":"changeme"}' \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p') || true

  if [ -z "$TOKEN" ]; then
    die "Failed to obtain admin token from Windmill. Is the server running with default credentials?"
  fi
  log "Admin token obtained."

  # Create a longer-lived token for CLI use
  CLI_TOKEN=""
  CLI_TOKEN=$(curl -sf -X POST "${WINDMILL_URL}/api/users/tokens/create" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"label":"bootstrap","expiration":null}' \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p') || true

  if [ -z "$CLI_TOKEN" ]; then
    warn "Could not create long-lived token. Falling back to session token."
    CLI_TOKEN="$TOKEN"
  else
    log "Long-lived CLI token created."
  fi

  # 2b. Configure wmill CLI
  log "Step 2b: Configuring wmill CLI workspace..."
  if wmill workspace add imladris "${WINDMILL_URL}/" --token "$CLI_TOKEN" 2>/dev/null; then
    log "wmill workspace 'imladris' added."
  else
    warn "wmill workspace add failed (may already exist). Attempting switch."
    wmill workspace switch imladris 2>/dev/null || true
  fi

  # 2c. Sync credentials from BWS
  log "Step 2c: Running sync-credentials.sh..."
  if bash "${BOOTSTRAP_DIR}/sync-credentials.sh"; then
    log "Credential sync completed."
  else
    warn "sync-credentials.sh failed (exit $?). Some variables may be missing."
  fi

  # 2d. Push all scripts (must run from windmill/ dir for relative paths)
  log "Step 2d: Pushing Windmill scripts..."
  cd "$HOME/repos/imladris/windmill"
  script_count=0
  script_fail=0
  for ts in f/devops/*.ts; do
    [ -f "$ts" ] || continue
    script_name="$(basename "$ts")"
    if wmill script push "$ts" 2>/dev/null; then
      log "  Pushed: $script_name"
      ((script_count++))
    else
      warn "  Failed to push: $script_name"
      ((script_fail++))
    fi
  done
  log "Scripts pushed: ${script_count} succeeded, ${script_fail} failed."

  # 2e. Push all schedules
  log "Step 2e: Pushing Windmill schedules..."
  sched_count=0
  sched_fail=0
  for sched in f/devops/*.schedule.yaml; do
    [ -f "$sched" ] || continue
    sched_name="$(basename "$sched")"
    # wmill schedule push needs both file_path and remote_path (both with .schedule.yaml suffix)
    if wmill schedule push "$sched" "$sched" 2>/dev/null; then
      log "  Pushed: $sched_name"
      ((sched_count++))
    else
      warn "  Failed to push: $sched_name"
      ((sched_fail++))
    fi
  done
  log "Schedules pushed: ${sched_count} succeeded, ${sched_fail} failed."
fi

# ---------------------------------------------------------------------------
# Step 3: Final verification
# ---------------------------------------------------------------------------
log "Step 3: Final verification..."

if curl -sf "${WINDMILL_URL}/api/version" >/dev/null 2>&1; then
  version=$(curl -sf "${WINDMILL_URL}/api/version")
  log "Windmill is operational. Version: ${version}"
else
  die "Final verification failed. Windmill is not responding."
fi

log "Bootstrap complete."
