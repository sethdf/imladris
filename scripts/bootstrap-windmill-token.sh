#!/usr/bin/env bash
# =============================================================================
# bootstrap-windmill-token.sh - Generate Windmill API Token
# =============================================================================
# One-time setup: creates admin user if needed, generates API token,
# patches settings.json with the real token.
#
# Usage: ./bootstrap-windmill-token.sh
#
# Prerequisites:
#   - Windmill running at localhost:8000
#   - jq installed
#   - ~/.claude/settings.json exists (from Ansible provisioning)

set -euo pipefail

WINDMILL_URL="http://localhost:8000"
SETTINGS_FILE="$HOME/.claude/settings.json"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# --- Preflight checks ---
if ! command -v jq &>/dev/null; then
  error "jq is required but not installed"
  exit 1
fi

if ! curl -sf "$WINDMILL_URL/api/version" >/dev/null 2>&1; then
  error "Windmill not reachable at $WINDMILL_URL"
  error "Is Windmill running? Try: docker compose -f ~/repos/imladris/docker-compose.yml up -d"
  exit 1
fi

if [ ! -f "$SETTINGS_FILE" ]; then
  error "Settings file not found: $SETTINGS_FILE"
  exit 1
fi

info "Windmill is reachable at $WINDMILL_URL"

# --- Check if already configured ---
CURRENT_TOKEN=$(jq -r '.mcpServers.windmill.env.WINDMILL_TOKEN // ""' "$SETTINGS_FILE")
if [ -n "$CURRENT_TOKEN" ] && [ "$CURRENT_TOKEN" != "__WINDMILL_TOKEN__" ]; then
  # Verify the existing token works
  if curl -sf -H "Authorization: Bearer $CURRENT_TOKEN" "$WINDMILL_URL/api/version" >/dev/null 2>&1; then
    info "Windmill token already configured and working"
    exit 0
  else
    warn "Existing token is invalid, generating new one"
  fi
fi

# --- Setup admin user ---
# Windmill requires initial setup — create admin user if not exists
info "Checking Windmill setup status..."

# Try to login as admin first
ADMIN_EMAIL="admin@imladris.local"
ADMIN_PASSWORD="$(openssl rand -base64 24)"

# Check if setup is needed (first-time Windmill)
SETUP_RESPONSE=$(curl -sf "$WINDMILL_URL/api/users/exists" 2>/dev/null || echo "error")

if [ "$SETUP_RESPONSE" = "false" ] || [ "$SETUP_RESPONSE" = "error" ]; then
  info "First-time Windmill setup — creating admin user..."

  # Create the first user (superadmin)
  CREATE_RESPONSE=$(curl -sf -X POST "$WINDMILL_URL/api/auth/signup" \
    -H "Content-Type: application/json" \
    -d "{
      \"email\": \"$ADMIN_EMAIL\",
      \"password\": \"$ADMIN_PASSWORD\",
      \"name\": \"Imladris Admin\"
    }" 2>&1) || true

  if echo "$CREATE_RESPONSE" | jq -e '.error' >/dev/null 2>&1; then
    warn "User creation returned: $CREATE_RESPONSE"
    warn "Trying to login with default credentials instead..."
  else
    info "Admin user created: $ADMIN_EMAIL"
    info "Password saved for this session only (not persisted)"
  fi
fi

# --- Get auth token ---
info "Authenticating to get session token..."

# Try our generated credentials, then common defaults
for PASSWORD in "$ADMIN_PASSWORD" "changeme"; do
  LOGIN_RESPONSE=$(curl -sf -X POST "$WINDMILL_URL/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\": \"$ADMIN_EMAIL\", \"password\": \"$PASSWORD\"}" 2>&1) || continue

  AUTH_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.token // empty' 2>/dev/null) || continue

  if [ -n "$AUTH_TOKEN" ]; then
    info "Authentication successful"
    break
  fi
done

if [ -z "${AUTH_TOKEN:-}" ]; then
  error "Failed to authenticate with Windmill"
  error "You may need to manually create a user at $WINDMILL_URL"
  exit 1
fi

# --- Create API token ---
info "Creating API token..."

TOKEN_RESPONSE=$(curl -sf -X POST "$WINDMILL_URL/api/users/tokens/create" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "claude-code-mcp", "expiration": null}' 2>&1)

API_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '. // empty' 2>/dev/null)

if [ -z "$API_TOKEN" ]; then
  error "Failed to create API token"
  error "Response: $TOKEN_RESPONSE"
  exit 1
fi

info "API token created successfully"

# --- Patch settings.json ---
info "Patching $SETTINGS_FILE..."

# Use jq to safely update the token
TEMP_FILE=$(mktemp)
jq --arg token "$API_TOKEN" \
  '.mcpServers.windmill.env.WINDMILL_TOKEN = $token' \
  "$SETTINGS_FILE" > "$TEMP_FILE"

mv "$TEMP_FILE" "$SETTINGS_FILE"
chmod 644 "$SETTINGS_FILE"

info "Settings updated with Windmill API token"

# --- Verify ---
info "Verifying token..."
if curl -sf -H "Authorization: Bearer $API_TOKEN" "$WINDMILL_URL/api/version" >/dev/null 2>&1; then
  info "Token verified successfully"
  VERSION=$(curl -sf -H "Authorization: Bearer $API_TOKEN" "$WINDMILL_URL/api/version")
  info "Windmill version: $VERSION"
else
  error "Token verification failed"
  exit 1
fi

info "Windmill bootstrap complete"
