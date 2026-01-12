#!/usr/bin/env bash
# imladris-unlock - Unlock LUKS data volume after reboot
# Simpler than imladris-init: just unlocks existing volume, no setup
set -euo pipefail

DATA_DEV="/dev/nvme1n1"
DATA_MAPPER="data"
DATA_MOUNT="/data"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
log_success() { echo "[$(date '+%H:%M:%S')] ✓ $*"; }
log_error() { echo "[$(date '+%H:%M:%S')] ✗ $*"; }

# =============================================================================
# BWS Functions
# =============================================================================

check_bws() {
    if ! command -v bws &>/dev/null; then
        log_error "bws CLI not installed"
        return 1
    fi

    if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
        local token_file="$HOME/.config/bws/access-token"
        if [[ -f "$token_file" ]]; then
            BWS_ACCESS_TOKEN=$(cat "$token_file")
            export BWS_ACCESS_TOKEN
        else
            log_error "BWS_ACCESS_TOKEN not set"
            log_error "Set env var: export BWS_ACCESS_TOKEN='your-token'"
            log_error "Or create file: $token_file"
            return 1
        fi
    fi

    if ! bws secret list &>/dev/null; then
        log_error "Failed to connect to Bitwarden Secrets Manager"
        return 1
    fi

    log_success "Connected to Bitwarden Secrets Manager"
}

bws_get() {
    local secret_name="$1"
    local secret_id=""
    secret_id=$(bws secret list 2>/dev/null | jq -r --arg name "$secret_name" '.[] | select(.key == $name) | .id')
    [[ -z "$secret_id" ]] && return 1
    bws secret get "$secret_id" 2>/dev/null | jq -r '.value'
}

# =============================================================================
# LUKS Unlock
# =============================================================================

get_luks_key() {
    local BWS_KEYFILE=""
    local PASSPHRASE=""

    BWS_KEYFILE=$(bws_get "luks-keyfile") || {
        log_error "luks-keyfile not found in Secrets Manager"
        return 1
    }

    echo "" >&2
    echo "╔════════════════════════════════════════════════════════════════╗" >&2
    echo "║  LUKS MFA: Enter your personal passphrase                      ║" >&2
    echo "║  (Combined with BWS keyfile - both required to unlock)         ║" >&2
    echo "╚════════════════════════════════════════════════════════════════╝" >&2
    echo "" >&2
    read -rs -p "Passphrase: " PASSPHRASE </dev/tty
    echo "" >&2

    if [[ -z "$PASSPHRASE" ]]; then
        log_error "Passphrase cannot be empty"
        return 1
    fi

    echo -n "${BWS_KEYFILE}${PASSPHRASE}"
}

unlock_luks() {
    if [[ ! -b "$DATA_DEV" ]]; then
        log_error "No data device at $DATA_DEV"
        log_error "Is the EBS volume attached?"
        return 1
    fi

    if ! sudo cryptsetup isLuks "$DATA_DEV" 2>/dev/null; then
        log_error "$DATA_DEV is not a LUKS volume"
        log_error "Run 'imladris-init' for first-time setup"
        return 1
    fi

    if [[ -e "/dev/mapper/$DATA_MAPPER" ]]; then
        log "Volume already unlocked"
    else
        log "Unlocking LUKS volume..."
        local LUKS_KEY=""
        LUKS_KEY=$(get_luks_key) || return 1

        echo -n "$LUKS_KEY" | sudo cryptsetup open "$DATA_DEV" "$DATA_MAPPER" - || {
            log_error "Failed to unlock - wrong passphrase or BWS keyfile changed"
            return 1
        }
        log_success "Volume unlocked"
    fi

    sudo mkdir -p "$DATA_MOUNT"
    if ! mountpoint -q "$DATA_MOUNT"; then
        sudo mount "/dev/mapper/$DATA_MAPPER" "$DATA_MOUNT"
        log_success "Mounted at $DATA_MOUNT"
    else
        log "Already mounted at $DATA_MOUNT"
    fi
}

# =============================================================================
# BWS Token Persistence
# =============================================================================

persist_bws_token() {
    local SECRETS_DIR="$DATA_MOUNT/.secrets"
    local TOKEN_FILE="$SECRETS_DIR/bws-token"
    local ROOT_TOKEN_FILE="$HOME/.config/bws/access-token"

    sudo mkdir -p "$SECRETS_DIR"
    sudo chown ubuntu:ubuntu "$SECRETS_DIR"
    chmod 700 "$SECRETS_DIR"

    if [[ -n "${BWS_ACCESS_TOKEN:-}" ]]; then
        echo -n "$BWS_ACCESS_TOKEN" > "$TOKEN_FILE"
        chmod 600 "$TOKEN_FILE"
        log_success "BWS token stored on encrypted volume"
    fi

    if [[ -f "$ROOT_TOKEN_FILE" ]]; then
        rm -f "$ROOT_TOKEN_FILE"
        log "Removed BWS token from root volume"
    fi

    rmdir "$HOME/.config/bws" 2>/dev/null || true
}

load_bws_token_from_luks() {
    local TOKEN_FILE="$DATA_MOUNT/.secrets/bws-token"

    if [[ -f "$TOKEN_FILE" ]]; then
        BWS_ACCESS_TOKEN=$(cat "$TOKEN_FILE")
        export BWS_ACCESS_TOKEN
        log_success "BWS token loaded from encrypted volume"
        return 0
    fi
    return 1
}

# =============================================================================
# Shell Integration Export
# =============================================================================

export_for_shell() {
    local TOKEN_FILE="$DATA_MOUNT/.secrets/bws-token"
    local SHELL_EXPORT="$HOME/.config/imladris/bws-env.sh"

    mkdir -p "$(dirname "$SHELL_EXPORT")"

    if [[ -f "$TOKEN_FILE" ]]; then
        cat > "$SHELL_EXPORT" << EOF
# Auto-generated by imladris-unlock - source in shell profile
export BWS_ACCESS_TOKEN="\$(cat $TOKEN_FILE 2>/dev/null)"
EOF
        chmod 600 "$SHELL_EXPORT"
        log "Shell export file: $SHELL_EXPORT"
    fi
}

# =============================================================================
# Main
# =============================================================================

show_help() {
    cat << EOF
Usage: imladris-unlock [OPTIONS]

Unlock the LUKS encrypted data volume after a reboot.

This is a simpler script than imladris-init - it just unlocks an existing
LUKS volume. Use imladris-init for first-time setup.

Prerequisites:
  - BWS_ACCESS_TOKEN must be set (env var or ~/.config/bws/access-token)
  - LUKS volume must already be formatted (via imladris-init)

Options:
  --help    Show this help message

Environment:
  BWS_ACCESS_TOKEN    Bitwarden Secrets Manager access token

Examples:
  # With token in environment
  export BWS_ACCESS_TOKEN='your-machine-account-token'
  imladris-unlock

  # Or create token file first
  echo -n 'your-token' > ~/.config/bws/access-token
  chmod 600 ~/.config/bws/access-token
  imladris-unlock

After unlocking:
  - BWS token is moved to /data/.secrets/bws-token
  - Source ~/.config/imladris/bws-env.sh in new shells
  - Or: export BWS_ACCESS_TOKEN="\$(cat /data/.secrets/bws-token)"
EOF
}

for arg in "$@"; do
    case "$arg" in
        --help|-h) show_help; exit 0 ;;
        *) log_error "Unknown option: $arg"; show_help; exit 1 ;;
    esac
done

log "=== Imladris Unlock ==="
log ""

if ! check_bws; then
    log_error "Cannot proceed without Bitwarden Secrets Manager access"
    exit 1
fi

if ! unlock_luks; then
    log_error "Failed to unlock LUKS volume"
    exit 1
fi

# Persist token to LUKS and remove from root
persist_bws_token

# Create shell export file
export_for_shell

# Try to load token from LUKS for verification
if load_bws_token_from_luks; then
    log "BWS token available for this session"
fi

log ""
log_success "Data volume unlocked and mounted at $DATA_MOUNT"
log ""
log "For new shells, source the BWS token:"
log "  source ~/.config/imladris/bws-env.sh"
log ""
log "Or add to your shell profile:"
log "  echo 'source ~/.config/imladris/bws-env.sh 2>/dev/null' >> ~/.zshrc"
