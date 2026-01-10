#!/usr/bin/env bash
# imladris-restore - Show status and optionally auto-unlock LUKS
set -euo pipefail

DATA_DEV="/dev/nvme1n1"
DATA_MAPPER="data"
DATA_MOUNT="/data"

# =============================================================================
# Status Display
# =============================================================================

show_status() {
    local bws_status luks_status tailscale_status docker_status

    # BWS status
    if [[ -n "${BWS_ACCESS_TOKEN:-}" ]] && command -v bws &>/dev/null && bws secret list &>/dev/null; then
        bws_status="✓ connected"
    else
        bws_status="○ not configured"
    fi

    # LUKS status
    if [[ -e "/dev/mapper/$DATA_MAPPER" ]] && mountpoint -q "$DATA_MOUNT" 2>/dev/null; then
        local space
        space=$(df -h "$DATA_MOUNT" 2>/dev/null | awk 'NR==2 {print $4}')
        luks_status="✓ mounted ($space free)"
    elif [[ -b "$DATA_DEV" ]]; then
        luks_status="○ locked"
    else
        luks_status="- no volume"
    fi

    # Tailscale status
    if command -v tailscale &>/dev/null && tailscale status &>/dev/null; then
        local ip
        ip=$(tailscale ip -4 2>/dev/null || echo "?")
        tailscale_status="✓ $ip"
    else
        tailscale_status="○ disconnected"
    fi

    # Docker status
    local containers
    containers=$(docker ps -q 2>/dev/null | wc -l || echo "0")
    docker_status="$containers running"

    echo "┌────────────────────────────────────┐"
    echo "│         Imladris Status              │"
    echo "├────────────────────────────────────┤"
    printf "│  LUKS:      %-22s│\n" "$luks_status"
    printf "│  Tailscale: %-22s│\n" "$tailscale_status"
    printf "│  Docker:    %-22s│\n" "$docker_status"
    printf "│  BWS:       %-22s│\n" "$bws_status"
    echo "└────────────────────────────────────┘"
}

# =============================================================================
# Auto-unlock LUKS
# =============================================================================

auto_unlock() {
    # Skip if already unlocked
    [[ -e "/dev/mapper/$DATA_MAPPER" ]] && return 0

    # Skip if no data device
    [[ ! -b "$DATA_DEV" ]] && return 0

    # Skip if not LUKS formatted yet
    sudo cryptsetup isLuks "$DATA_DEV" 2>/dev/null || return 0

    # Try to get BWS token
    if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
        local token_file="$HOME/.config/bws/access-token"
        [[ -f "$token_file" ]] && BWS_ACCESS_TOKEN=$(cat "$token_file") && export BWS_ACCESS_TOKEN
    fi

    [[ -z "${BWS_ACCESS_TOKEN:-}" ]] && return 0

    # Get LUKS key
    local luks_key secret_id
    secret_id=$(bws secret list 2>/dev/null | jq -r '.[] | select(.key == "luks-key") | .id' 2>/dev/null)
    [[ -z "$secret_id" ]] && return 0

    luks_key=$(bws secret get "$secret_id" 2>/dev/null | jq -r '.value')
    [[ -z "$luks_key" ]] && return 0

    # Unlock and mount
    echo -n "$luks_key" | sudo cryptsetup open "$DATA_DEV" "$DATA_MAPPER" - 2>/dev/null || return 0
    sudo mkdir -p "$DATA_MOUNT"
    sudo mount "/dev/mapper/$DATA_MAPPER" "$DATA_MOUNT" 2>/dev/null || return 0

    # Bind mount home
    if [[ -d "$DATA_MOUNT/home" ]] && ! mountpoint -q /home/ubuntu 2>/dev/null; then
        sudo mount --bind "$DATA_MOUNT/home" /home/ubuntu 2>/dev/null || true
    fi

    echo "LUKS volume auto-unlocked"
}

# =============================================================================
# Main
# =============================================================================

case "${1:-status}" in
    status)
        show_status
        ;;
    unlock)
        auto_unlock
        show_status
        ;;
    *)
        echo "Usage: imladris-restore [status|unlock]"
        ;;
esac
