#!/usr/bin/env bash
# =============================================================================
# sync-credentials.sh - Bitwarden → Windmill Credential Sync
# =============================================================================
# Decision 13/20: Bitwarden Secrets is source of truth, Windmill vault is cache
#
# Usage: ./sync-credentials.sh [--dry-run]
#
# Prerequisites:
#   - bws CLI installed and configured (BWS_ACCESS_TOKEN set or in env)
#   - wmill CLI installed and configured
#   - Windmill running at localhost:8000

set -euo pipefail

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[SYNC]${NC} $*"; }
warn()  { echo -e "${YELLOW}[SYNC]${NC} $*"; }
error() { echo -e "${RED}[SYNC]${NC} $*" >&2; }

# --- Preflight ---
if ! command -v bws &>/dev/null; then
  error "bws CLI not found. Install: https://bitwarden.com/help/secrets-manager-cli/"
  exit 1
fi

if ! command -v wmill &>/dev/null; then
  error "wmill CLI not found. Install: npm install -g windmill-cli"
  exit 1
fi

# Check bws is authenticated
if ! bws secret list &>/dev/null 2>&1; then
  error "bws not authenticated. Set BWS_ACCESS_TOKEN or run bws login"
  exit 1
fi

info "Starting Bitwarden → Windmill credential sync"
$DRY_RUN && info "(DRY RUN — no changes will be made)"

# --- Sync secrets ---
# bws secret list returns JSON array of secrets
SECRETS=$(bws secret list 2>/dev/null)

if [ -z "$SECRETS" ] || [ "$SECRETS" == "[]" ]; then
  warn "No secrets found in Bitwarden Secrets Manager"
  exit 0
fi

SYNCED=0
SKIPPED=0
ERRORS=0

# Parse each secret and sync to Windmill
echo "$SECRETS" | jq -c '.[]' | while read -r secret; do
  KEY=$(echo "$secret" | jq -r '.key')
  VALUE=$(echo "$secret" | jq -r '.value')
  NOTE=$(echo "$secret" | jq -r '.note // ""')

  # Map Bitwarden key to Windmill variable path
  # Convention: Bitwarden key "sdp_api_key" → Windmill "f/devops/sdp_api_key"
  # Keys prefixed with "wm_" get the prefix stripped
  WMILL_PATH="f/devops/${KEY#wm_}"

  if $DRY_RUN; then
    info "Would sync: $KEY → $WMILL_PATH"
    continue
  fi

  # Check if variable already exists in Windmill
  if wmill variable get "$WMILL_PATH" &>/dev/null 2>&1; then
    # Update existing
    if wmill variable update "$WMILL_PATH" --value "$VALUE" &>/dev/null 2>&1; then
      info "Updated: $KEY → $WMILL_PATH"
      SYNCED=$((SYNCED + 1))
    else
      error "Failed to update: $KEY → $WMILL_PATH"
      ERRORS=$((ERRORS + 1))
    fi
  else
    # Create new (as secret variable)
    if wmill variable create "$WMILL_PATH" --value "$VALUE" --is-secret &>/dev/null 2>&1; then
      info "Created: $KEY → $WMILL_PATH"
      SYNCED=$((SYNCED + 1))
    else
      error "Failed to create: $KEY → $WMILL_PATH"
      ERRORS=$((ERRORS + 1))
    fi
  fi
done

info "Sync complete: ${SYNCED} synced, ${SKIPPED} skipped, ${ERRORS} errors"
