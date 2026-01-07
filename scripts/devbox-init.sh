#!/usr/bin/env bash
# devbox-init - Initialize LUKS encrypted data volume
# This is the minimal infrastructure setup - personal config belongs elsewhere
set -euo pipefail

DATA_DEV="/dev/nvme1n1"
DATA_MAPPER="data"
DATA_MOUNT="/data"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
log_success() { echo "[$(date '+%H:%M:%S')] ✓ $*"; }
log_error() { echo "[$(date '+%H:%M:%S')] ✗ $*"; }

# =============================================================================
# Bitwarden Secrets Manager
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
            log_error "Set env var or create: $token_file"
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
    local secret_id
    secret_id=$(bws secret list 2>/dev/null | jq -r --arg name "$secret_name" '.[] | select(.key == $name) | .id')
    [[ -z "$secret_id" ]] && return 1
    bws secret get "$secret_id" 2>/dev/null | jq -r '.value'
}

# =============================================================================
# LUKS Setup
# =============================================================================

setup_luks() {
    if [[ ! -b "$DATA_DEV" ]]; then
        log "No data device at $DATA_DEV - skipping LUKS setup"
        return 0
    fi

    log "Setting up encrypted data volume..."

    local LUKS_KEY
    LUKS_KEY=$(bws_get "luks-key") || { log_error "luks-key not found in Secrets Manager"; return 1; }

    if ! sudo cryptsetup isLuks "$DATA_DEV" 2>/dev/null; then
        # First time setup
        log "Formatting $DATA_DEV with LUKS..."
        sudo wipefs -a "$DATA_DEV" 2>/dev/null || true
        echo -n "$LUKS_KEY" | sudo cryptsetup luksFormat --type luks2 -q "$DATA_DEV" -
        echo -n "$LUKS_KEY" | sudo cryptsetup open "$DATA_DEV" "$DATA_MAPPER" -
        sudo mkfs.ext4 -L data "/dev/mapper/$DATA_MAPPER"
        sudo mkdir -p "$DATA_MOUNT"
        sudo mount "/dev/mapper/$DATA_MAPPER" "$DATA_MOUNT"

        # Create home directory on encrypted volume
        sudo mkdir -p "$DATA_MOUNT/home"
        sudo cp -a /home/ubuntu/. "$DATA_MOUNT/home/" 2>/dev/null || true
        sudo chown -R ubuntu:ubuntu "$DATA_MOUNT/home"
        log_success "Data volume initialized"
    else
        # Existing LUKS volume - unlock it
        if [[ ! -e "/dev/mapper/$DATA_MAPPER" ]]; then
            log "Unlocking LUKS volume..."
            echo -n "$LUKS_KEY" | sudo cryptsetup open "$DATA_DEV" "$DATA_MAPPER" -
        fi

        sudo mkdir -p "$DATA_MOUNT"
        if ! mountpoint -q "$DATA_MOUNT"; then
            sudo mount "/dev/mapper/$DATA_MAPPER" "$DATA_MOUNT"
        fi
        log_success "Data volume unlocked and mounted"
    fi

    # Bind mount home from encrypted volume
    if [[ -d "$DATA_MOUNT/home" ]] && ! mountpoint -q /home/ubuntu; then
        sudo mount --bind "$DATA_MOUNT/home" /home/ubuntu
        log_success "Home directory mounted from encrypted volume"
    fi

    # Create encrypted-home symlink for convenience
    ln -sfn "$DATA_MOUNT/home" "$HOME/encrypted-home" 2>/dev/null || true
}

# =============================================================================
# PAI Bootstrap (runs on encrypted volume)
# =============================================================================

setup_pai() {
    local PAI_REPO="$HOME/pai"
    local PAI_DIR="$HOME/encrypted-home/.claude"

    if [[ ! -d "$PAI_REPO" ]]; then
        log "PAI repo not found at $PAI_REPO - skipping"
        return 0
    fi

    if [[ -d "$PAI_DIR/history" ]]; then
        log "PAI already bootstrapped"
        return 0
    fi

    log "Bootstrapping PAI to encrypted storage..."

    # Create PAI directory on encrypted volume
    mkdir -p "$PAI_DIR"

    # Create symlink from ~/.claude to encrypted location
    if [[ -d "$HOME/.claude" && ! -L "$HOME/.claude" ]]; then
        # Move any existing .claude contents to encrypted location
        cp -a "$HOME/.claude/." "$PAI_DIR/" 2>/dev/null || true
        rm -rf "$HOME/.claude"
    fi
    ln -sfn "$PAI_DIR" "$HOME/.claude"

    # Run PAI bootstrap
    export PAI_DIR
    if command -v bun &>/dev/null; then
        cd "$PAI_REPO/Bundles/Kai" && bun run install.ts --non-interactive || {
            log "PAI bootstrap requires interaction - run manually:"
            log "  cd ~/pai/Bundles/Kai && bun run install.ts"
            return 0
        }
        log_success "PAI bootstrapped to encrypted storage"
    else
        log "Bun not installed - run PAI bootstrap manually:"
        log "  cd ~/pai/Bundles/Kai && bun run install.ts"
    fi
}

# =============================================================================
# Custom Skills Installation
# =============================================================================

install_custom_skills() {
    local SKILLS_SRC="$HOME/work/skills"
    local SKILLS_DST="$HOME/.claude/skills"

    if [[ ! -d "$SKILLS_SRC" ]]; then
        log "No custom skills repo at $SKILLS_SRC - skipping"
        return 0
    fi

    log "Installing custom skills..."
    mkdir -p "$SKILLS_DST"

    # Install skill markdown files (README.md -> skill-name.md)
    for skill_dir in "$SKILLS_SRC"/*/; do
        [[ -d "$skill_dir" ]] || continue
        local name=$(basename "$skill_dir")

        # Skip hidden directories and common non-skill dirs
        [[ "$name" == .* ]] && continue

        if [[ -f "$skill_dir/README.md" ]]; then
            cp "$skill_dir/README.md" "$SKILLS_DST/${name}.md"
            log "  Installed skill: $name"
        fi
    done

    # Install helper scripts from src/ directories
    mkdir -p "$HOME/bin"
    for script in "$SKILLS_SRC"/*/src/*.sh; do
        [[ -f "$script" ]] || continue
        local script_name=$(basename "$script")
        cp "$script" "$HOME/bin/${script_name%.sh}"
        chmod +x "$HOME/bin/${script_name%.sh}"
        log "  Installed script: ${script_name%.sh}"
    done

    # Install hooks from src/ directories
    local HOOKS_DST="$HOME/.claude/hooks"
    mkdir -p "$HOOKS_DST"
    for hook in "$SKILLS_SRC"/*/src/*-hook.ts; do
        [[ -f "$hook" ]] || continue
        cp "$hook" "$HOOKS_DST/"
        log "  Installed hook: $(basename "$hook")"
    done

    log_success "Custom skills installed"
}

# =============================================================================
# Main
# =============================================================================

log "=== DevBox Init ==="

if ! check_bws; then
    log_error "Cannot proceed without Bitwarden Secrets Manager access"
    exit 1
fi

if setup_luks; then
    log_success "LUKS setup complete"
    log ""
    log "Encrypted storage ready at /data"
    log "Home directory is on encrypted volume"
else
    log_error "LUKS setup failed"
    exit 1
fi

# Bootstrap PAI on encrypted volume
setup_pai

# Install custom skills from ~/work/skills/
install_custom_skills

log ""
log_success "DevBox initialization complete"
log "Next: Install PAI packs with Claude: claude 'Install packs from ~/pai/Packs/'"
