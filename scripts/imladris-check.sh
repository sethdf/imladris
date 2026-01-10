#!/usr/bin/env bash
# imladris-check - Health check for imladris infrastructure
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

echo "=== Imladris Health Check ==="
echo ""

# 1. Check Bitwarden Secrets Manager
echo "Bitwarden Secrets Manager:"
BWS_OK=false
if ! command -v bws &>/dev/null; then
    fail "bws CLI not installed"
    info "Download from: https://github.com/bitwarden/sdk-sm/releases"
else
    if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
        TOKEN_FILE="$HOME/.config/bws/access-token"
        if [[ -f "$TOKEN_FILE" ]]; then
            BWS_ACCESS_TOKEN=$(cat "$TOKEN_FILE")
            export BWS_ACCESS_TOKEN
        fi
    fi

    if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
        warn "BWS_ACCESS_TOKEN not set"
        info "Set env var or create: ~/.config/bws/access-token"
    elif bws secret list &>/dev/null; then
        ok "Connected"
        BWS_OK=true
    else
        fail "Connection failed - check access token"
    fi
fi
echo ""

# 2. Check required secrets
echo "Required Secrets:"
if $BWS_OK; then
    SECRETS=$(bws secret list 2>/dev/null | jq -r '.[].key' || echo "")

    for secret in "luks-key" "tailscale-auth-key" "tailscale-api-key"; do
        if echo "$SECRETS" | grep -q "^${secret}$"; then
            ok "$secret"
        else
            fail "$secret - missing"
        fi
    done
else
    warn "Skipping - connect to BWS first"
fi
echo ""

# 3. Check LUKS volume
echo "LUKS Volume:"
DATA_DEV="/dev/nvme1n1"
if [[ -b "$DATA_DEV" ]]; then
    if sudo cryptsetup isLuks "$DATA_DEV" 2>/dev/null; then
        ok "LUKS formatted"
        if [[ -e /dev/mapper/data ]]; then
            ok "Unlocked"
            if mountpoint -q /data 2>/dev/null; then
                ok "Mounted at /data"
                SPACE=$(df -h /data | awk 'NR==2 {print $4 " available"}')
                info "$SPACE"
            else
                warn "Not mounted - run imladris-init"
            fi
        else
            warn "Locked - run imladris-init"
        fi
    else
        info "Not yet formatted - will format on first imladris-init"
    fi
else
    warn "Data volume not attached ($DATA_DEV)"
fi
echo ""

# 4. Check Tailscale
echo "Tailscale:"
if command -v tailscale &>/dev/null; then
    if tailscale status &>/dev/null; then
        ok "Connected"
        IP=$(tailscale ip -4 2>/dev/null || echo "unknown")
        info "IP: $IP"
    else
        warn "Not connected"
    fi
else
    fail "Not installed"
fi
echo ""

# Summary
echo "=== Summary ==="
if [[ $ERRORS -eq 0 ]] && [[ $WARNINGS -eq 0 ]]; then
    echo -e "${GREEN}All checks passed${NC}"
elif [[ $ERRORS -eq 0 ]]; then
    echo -e "${YELLOW}$WARNINGS warning(s)${NC}"
else
    echo -e "${RED}$ERRORS error(s), $WARNINGS warning(s)${NC}"
fi

exit $ERRORS
