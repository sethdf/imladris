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

# --- Authenticate ---
# Windmill CE ships with a default superadmin: admin@windmill.dev / changeme
# After first run, we change the password. The API token persists regardless.
ADMIN_EMAIL="admin@windmill.dev"
AUTH_TOKEN=""

info "Authenticating with Windmill..."

# Try default password first, then common alternatives
for PASSWORD in "changeme"; do
  LOGIN_RESPONSE=$(curl -sf -X POST "$WINDMILL_URL/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\": \"$ADMIN_EMAIL\", \"password\": \"$PASSWORD\"}" 2>&1) || continue

  # Windmill login returns the token directly as a string, not JSON
  if [ -n "$LOGIN_RESPONSE" ] && [ "$LOGIN_RESPONSE" != "Bad request: Invalid login" ]; then
    AUTH_TOKEN="$LOGIN_RESPONSE"
    info "Authentication successful"
    break
  fi
done

if [ -z "$AUTH_TOKEN" ]; then
  error "Failed to authenticate with Windmill"
  error "Default password may have been changed. Generate a token manually at $WINDMILL_URL"
  exit 1
fi

# Change the default password for security
NEW_PASS=$(openssl rand -base64 24)
curl -sf -X POST "$WINDMILL_URL/api/users/setpassword" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"password\": \"$NEW_PASS\"}" >/dev/null 2>&1 && \
  info "Default admin password changed (API token still works)" || \
  warn "Could not change default password (may already be changed)"

# --- Create API token ---
info "Creating API token..."

# Windmill returns the token as a plain string, not JSON
API_TOKEN=$(curl -sf -X POST "$WINDMILL_URL/api/users/tokens/create" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "claude-code-mcp"}' 2>&1)

if [ -z "$API_TOKEN" ]; then
  error "Failed to create API token"
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
