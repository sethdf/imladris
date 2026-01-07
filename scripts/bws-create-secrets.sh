#!/usr/bin/env bash
# bws-create-secrets.sh - Create all required secrets in Bitwarden Secrets Manager
# Run this once to set up the secret structure, then populate values via BW web UI
set -euo pipefail

# Colors
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

echo "--- Required for Terraform ---"
create_secret "tailscale-auth-key" "Tailscale auth key for joining tailnet"
create_secret "tailscale-api-key" "Tailscale API key for device cleanup"

echo ""
echo "--- Required for devbox-init ---"
create_secret "luks-key" "LUKS encryption passphrase for data volume"
create_secret "github-ssh-home" "SSH private key for home GitHub (base64 encoded)"
create_secret "github-token" "GitHub Personal Access Token for gh CLI"
create_secret "github-home-name" "Git author name for home identity"
create_secret "github-home-email" "Git author email for home identity"
create_secret "github-home-username" "GitHub username"

echo ""
echo "--- Optional secrets ---"
create_secret "github-ssh-work" "SSH private key for work GitHub (base64 encoded)"
create_secret "github-work-name" "Git author name for work identity"
create_secret "github-work-email" "Git author email for work identity"
create_secret "git-crypt-key" "git-crypt key (base64 encoded)"

echo ""
echo "--- AWS (optional) ---"
create_secret "aws-account-id" "AWS account ID for SSO"
create_secret "aws-sso-start-url" "AWS SSO start URL"
create_secret "aws-sso-region" "AWS SSO region (e.g., us-east-1)"
create_secret "aws-role-name" "AWS SSO role name"

echo ""
echo "--- Gmail OAuth (optional) ---"
create_secret "gmail-email" "Gmail email address"
create_secret "gmail-client-id" "Gmail OAuth client ID"
create_secret "gmail-client-secret" "Gmail OAuth client secret"

echo ""
echo "--- MS365 OAuth (optional) ---"
create_secret "ms365-email" "MS365 email address"
create_secret "ms365-client-id" "MS365 OAuth client ID"
create_secret "ms365-client-secret" "MS365 OAuth client secret"
create_secret "ms365-tenant-id" "MS365 tenant ID"

echo ""
echo "--- Repo configs (optional) ---"
create_secret "claude-sessions-repo" "GitHub repo for claude-sessions (user/repo format)"
create_secret "lifemaestro-repo" "GitHub repo for lifemaestro (user/repo format)"
create_secret "baton-repo" "GitHub repo for baton (user/repo format)"

echo ""
echo "=== Done ==="
echo ""
echo "Next steps:"
echo "  1. Go to Bitwarden Secrets Manager web UI"
echo "  2. Update each secret with the actual value"
echo "  3. Save your BWS access token to: lifemaestro/secrets/bw-sm-access-token"
echo "  4. Run: make plan"
echo ""
echo "To list all secrets: bws secret list | jq -r '.[] | \"\(.key): \(.id)\"'"
