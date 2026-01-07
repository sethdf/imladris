#!/usr/bin/env bash
# bws-create-secrets.sh - Create required secrets in Bitwarden Secrets Manager
# Run this once to set up the secret structure, then populate values via BW web UI
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }

# Check prerequisites
if ! command -v bws &>/dev/null; then
    fail "bws CLI not installed"
    echo "Download from: https://github.com/bitwarden/sdk-sm/releases"
    exit 1
fi

if ! command -v jq &>/dev/null; then
    fail "jq not installed"
    exit 1
fi

# Get token if not set
if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
    echo -n "Enter BWS Access Token: "
    read -rs BWS_ACCESS_TOKEN
    echo ""
    export BWS_ACCESS_TOKEN
fi

# Test connection
echo "Testing connection to Bitwarden Secrets Manager..."
if ! bws project list &>/dev/null; then
    fail "Failed to connect. Check your access token."
    exit 1
fi
ok "Connected to Secrets Manager"
echo ""

# List projects and let user choose
echo "Available projects:"
bws project list | jq -r '.[] | "  \(.id)  \(.name)"'
echo ""
echo -n "Enter Project ID: "
read -r PROJECT_ID

if [[ -z "$PROJECT_ID" ]]; then
    fail "Project ID required"
    exit 1
fi

echo ""
echo "=== Creating secrets in project $PROJECT_ID ==="
echo ""

# Get existing secrets
EXISTING=$(bws secret list 2>/dev/null | jq -r '.[].key' || echo "")

# Function to create secret if it doesn't exist
create_secret() {
    local key="$1"
    local note="${2:-}"
    local placeholder="PLACEHOLDER - UPDATE ME"

    if echo "$EXISTING" | grep -q "^${key}$"; then
        warn "$key (already exists - skipping)"
    else
        if bws secret create "$key" "$placeholder" "$PROJECT_ID" --note "$note" &>/dev/null; then
            ok "$key"
        else
            fail "$key (creation failed)"
        fi
    fi
}

echo "--- Infrastructure secrets ---"
create_secret "tailscale-auth-key" "Tailscale auth key for joining tailnet (used by Terraform)"
create_secret "tailscale-api-key" "Tailscale API key for device cleanup (used by Terraform)"
create_secret "luks-key" "LUKS encryption passphrase for data volume (used by devbox-init)"

echo ""
echo "=== Done ==="
echo ""
echo "Next steps:"
echo "  1. Go to Bitwarden Secrets Manager web UI"
echo "  2. Update each secret with the actual value"
echo "  3. Save your BWS access token to: ~/.config/bws/access-token"
echo "     (and lifemaestro/secrets/bw-sm-access-token for Terraform)"
echo "  4. Run: make plan"
echo ""
echo "To list all secrets: bws secret list | jq -r '.[] | \"\(.key): \(.id)\"'"
