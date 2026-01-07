#!/usr/bin/env bash
# devbox-check - Health check script for devbox dependencies
# Uses Bitwarden Secrets Manager (bws)
set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ERRORS=0
WARNINGS=0

ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; ((WARNINGS++)); }
fail() { echo -e "${RED}✗${NC} $1"; ((ERRORS++)); }
info() { echo -e "  $1"; }

# BWS helper - check if secret exists
bws_exists() {
    local secret_name="$1"
    [[ -n "${BWS_ACCESS_TOKEN:-}" ]] && bws secret list 2>/dev/null | jq -e --arg name "$secret_name" '.[] | select(.key == $name)' &>/dev/null
}

echo "=== Devbox Health Check ==="
echo ""

# 1. Check Bitwarden Secrets Manager
echo "Bitwarden Secrets Manager:"
BWS_OK=false
if ! command -v bws &>/dev/null; then
    fail "bws CLI not installed"
    info "Download from: https://github.com/bitwarden/sdk-sm/releases"
else
    # Check for access token
    if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
        TOKEN_FILE="$HOME/.config/bws/access-token"
        if [[ -f "$TOKEN_FILE" ]]; then
            BWS_ACCESS_TOKEN=$(cat "$TOKEN_FILE")
            export BWS_ACCESS_TOKEN
        fi
    fi

    if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
        fail "BWS_ACCESS_TOKEN not set"
        info "Set environment variable or create: ~/.config/bws/access-token"
    elif bws secret list &>/dev/null; then
        ok "Connected and authenticated"
        BWS_OK=true
    else
        fail "Failed to access Secrets Manager - check access token"
    fi
fi
echo ""

# 2. Check required secrets
echo "Secrets Manager Items:"
REQUIRED_ITEMS=(
    "luks-key:LUKS encryption key"
    "github-ssh-home:GitHub SSH key (home)"
    "github-token:GitHub personal access token"
    "github-home-name:GitHub home name"
    "github-home-email:GitHub home email"
)

if $BWS_OK; then
    for ITEM_DESC in "${REQUIRED_ITEMS[@]}"; do
        ITEM_NAME="${ITEM_DESC%%:*}"
        ITEM_LABEL="${ITEM_DESC#*:}"
        if bws_exists "$ITEM_NAME"; then
            ok "$ITEM_LABEL"
        else
            fail "$ITEM_LABEL - missing: $ITEM_NAME"
        fi
    done

    OPTIONAL_ITEMS=(
        "github-ssh-work:GitHub SSH key (work)"
        "github-work-name:GitHub work name"
        "github-work-email:GitHub work email"
        "git-crypt-key:Git-crypt key (for encrypted repos)"
        "gmail-client-id:Gmail OAuth client ID"
        "ms365-client-id:MS365 OAuth client ID"
        "aws-account-id:AWS account ID"
    )
    for ITEM_DESC in "${OPTIONAL_ITEMS[@]}"; do
        ITEM_NAME="${ITEM_DESC%%:*}"
        ITEM_LABEL="${ITEM_DESC#*:}"
        if bws_exists "$ITEM_NAME"; then
            ok "$ITEM_LABEL"
        else
            warn "$ITEM_LABEL - not configured (optional)"
        fi
    done
else
    warn "Skipping item check - configure Secrets Manager first"
fi
echo ""

# 3. Check SSH keys
echo "SSH Keys:"
if [[ -f ~/.ssh/id_ed25519_home ]]; then
    ok "Home SSH key exists"
    if ssh -T git@github.com-home 2>&1 | grep -q "successfully authenticated"; then
        ok "Home key authenticated with GitHub"
    else
        warn "Home key may not be added to GitHub"
        info "Add public key to: https://github.com/settings/keys"
        info "Public key: $(ssh-keygen -y -f ~/.ssh/id_ed25519_home 2>/dev/null | head -1)"
    fi
else
    fail "Home SSH key missing - run devbox-init"
fi

if [[ -f ~/.ssh/id_ed25519_work ]]; then
    ok "Work SSH key exists"
else
    warn "Work SSH key missing (optional)"
fi
echo ""

# 4. Check GitHub CLI
echo "GitHub CLI:"
if command -v gh &>/dev/null; then
    if gh auth status &>/dev/null; then
        ok "Authenticated"
    else
        warn "Not authenticated - run devbox-init or: gh auth login"
    fi
else
    fail "gh CLI not installed"
fi
echo ""

# 5. Check LUKS volume
echo "LUKS Volume:"
DATA_DEV="/dev/nvme1n1"
if [[ -b "$DATA_DEV" ]]; then
    if sudo cryptsetup isLuks "$DATA_DEV" 2>/dev/null; then
        ok "LUKS formatted"
        if [[ -e /dev/mapper/data ]]; then
            ok "Unlocked"
            if mountpoint -q /data 2>/dev/null; then
                ok "Mounted at /data"
            else
                warn "Not mounted - run devbox-init"
            fi
        else
            warn "Locked - run devbox-init to unlock"
        fi
    else
        warn "Not LUKS formatted - will be formatted on first devbox-init"
    fi
else
    fail "Data volume not attached ($DATA_DEV)"
fi
echo ""

# 6. Check LifeMaestro
echo "LifeMaestro:"
if [[ -d ~/code/lifemaestro ]]; then
    ok "Installed at ~/code/lifemaestro"
    if [[ -L "$HOME/.claude" ]] && [[ -d "$HOME/.claude" ]]; then
        ok "\$HOME/.claude symlinked"
    else
        warn "\$HOME/.claude not symlinked - run devbox-init"
    fi
else
    warn "Not installed - will install on devbox-init"
fi
echo ""

# Summary
echo "=== Summary ==="
if [[ $ERRORS -eq 0 ]] && [[ $WARNINGS -eq 0 ]]; then
    echo -e "${GREEN}All checks passed!${NC}"
elif [[ $ERRORS -eq 0 ]]; then
    echo -e "${YELLOW}$WARNINGS warning(s), no errors${NC}"
else
    echo -e "${RED}$ERRORS error(s), $WARNINGS warning(s)${NC}"
    echo ""
    echo "Fix errors before running devbox-init"
fi

exit $ERRORS
