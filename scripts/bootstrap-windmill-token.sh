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
# Extract token from URL-based config (type: url) or env-based config (legacy)
CURRENT_URL=$(jq -r '.mcpServers.windmill.url // ""' "$SETTINGS_FILE")
if [ -n "$CURRENT_URL" ] && ! echo "$CURRENT_URL" | grep -q "__WINDMILL_TOKEN__"; then
  CURRENT_TOKEN=$(echo "$CURRENT_URL" | grep -oP 'token=\K[^&]+')
  if [ -n "$CURRENT_TOKEN" ] && curl -sf -H "Authorization: Bearer $CURRENT_TOKEN" "$WINDMILL_URL/api/version" >/dev/null 2>&1; then
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

# --- Ensure workspace exists ---
WORKSPACE="imladris"
WORKSPACES=$(curl -sf -H "Authorization: Bearer $AUTH_TOKEN" "$WINDMILL_URL/api/workspaces/list" 2>/dev/null)
if ! echo "$WORKSPACES" | jq -e ".[] | select(.id == \"$WORKSPACE\")" >/dev/null 2>&1; then
  info "Creating workspace '$WORKSPACE'..."
  curl -sf -X POST -H "Authorization: Bearer $AUTH_TOKEN" -H "Content-Type: application/json" \
    "$WINDMILL_URL/api/workspaces/create" \
    -d "{\"id\": \"$WORKSPACE\", \"name\": \"Imladris\"}" >/dev/null 2>&1 && \
    info "Workspace created" || warn "Workspace creation failed (may already exist)"
else
  info "Workspace '$WORKSPACE' exists"
fi

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
# Windmill MCP uses HTTP streamable transport — URL-based config
WORKSPACE="imladris"
MCP_URL="$WINDMILL_URL/api/mcp/w/$WORKSPACE/mcp?token=$API_TOKEN"

TEMP_FILE=$(mktemp)
jq --arg url "$MCP_URL" \
  '.mcpServers.windmill = {"type": "url", "url": $url}' \
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
