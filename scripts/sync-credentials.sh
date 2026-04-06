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
  # Convention: Bitwarden key "sdp-base-url" → Windmill "f/devops/sdp_base_url"
  # Keys prefixed with "investigate-" → Windmill "f/investigate/{rest}"
  # Hyphens → underscores (Windmill env vars can't have hyphens)
  # Keys prefixed with "wm_" get the prefix stripped
  CLEAN_KEY="${KEY#wm_}"

  # Route to correct Windmill folder based on BWS key prefix
  if [[ "$CLEAN_KEY" == investigate-* ]]; then
    CLEAN_KEY="${CLEAN_KEY#investigate-}"
    CLEAN_KEY="${CLEAN_KEY//-/_}"
    WMILL_PATH="f/investigate/${CLEAN_KEY}"
  else
    CLEAN_KEY="${CLEAN_KEY//-/_}"
    WMILL_PATH="f/devops/${CLEAN_KEY}"
  fi

  if $DRY_RUN; then
    info "Would sync: $KEY → $WMILL_PATH"
    continue
  fi

  # Use REST API directly — wmill variable create/update subcommands removed in v1.645.0+
  WMILL_TOKEN_VAL=$(python3 -c "import json; d=[json.loads(l) for l in open(\"$HOME/.config/windmill/remotes.ndjson\") if l.strip()]; print(d[0]['token'])" 2>/dev/null)
  WMILL_BASE="http://127.0.0.1:8000/api/w/imladris"
  VALUE_JSON=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$VALUE")

  # Try update first (works whether secret or not)
  HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" -X POST \
    "$WMILL_BASE/variables/update/$WMILL_PATH" \
    -H "Authorization: Bearer $WMILL_TOKEN_VAL" \
    -H "Content-Type: application/json" \
    -d "{\"value\":$VALUE_JSON}" 2>/dev/null)

  if [[ "$HTTP_CODE" == "200" ]]; then
    info "Updated: $KEY → $WMILL_PATH"
    SYNCED=$((SYNCED + 1))
  else
    # Create new (as secret variable)
    HTTP_CODE2=$(curl -sf -o /dev/null -w "%{http_code}" -X POST \
      "$WMILL_BASE/variables/create" \
      -H "Authorization: Bearer $WMILL_TOKEN_VAL" \
      -H "Content-Type: application/json" \
      -d "{\"path\":\"$WMILL_PATH\",\"value\":$VALUE_JSON,\"is_secret\":true,\"description\":\"From BWS: $KEY\"}" 2>/dev/null)
    if [[ "$HTTP_CODE2" == "200" ]]; then
      info "Created: $KEY → $WMILL_PATH"
      SYNCED=$((SYNCED + 1))
    else
      error "Failed ($HTTP_CODE2): $KEY → $WMILL_PATH"
      ERRORS=$((ERRORS + 1))
    fi
  fi
done

info "Sync complete: ${SYNCED} synced, ${SKIPPED} skipped, ${ERRORS} errors"
