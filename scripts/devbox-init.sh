#!/usr/bin/env bash
# devbox-init - Initialize LUKS encrypted data volume with work/home directories
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
        sudo chown ubuntu:ubuntu "$DATA_MOUNT"
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
}

# =============================================================================
# Directory Setup (work/home separation - files only, unified PAI)
# =============================================================================

setup_directories() {
    log "Setting up work/home directories..."

    # Create directory structure on encrypted volume
    # Work directories
    mkdir -p "$DATA_MOUNT/work"/{repos,tickets,notes}

    # Home directories
    mkdir -p "$DATA_MOUNT/home"/{repos,projects,notes}

    # Create .envrc for context-aware settings via direnv
    # Note: PAI uses default ~/.claude location (unified history)
    if [[ ! -f "$DATA_MOUNT/work/.envrc" ]]; then
        cat > "$DATA_MOUNT/work/.envrc" << 'EOF'
# Auto-loaded by direnv when entering this directory
export CONTEXT="work"
export GHQ_ROOT="$PWD/repos"
export SDP_TICKETS_DIR="$PWD/tickets"
EOF
        log "  Created work/.envrc"
    fi

    if [[ ! -f "$DATA_MOUNT/home/.envrc" ]]; then
        cat > "$DATA_MOUNT/home/.envrc" << 'EOF'
# Auto-loaded by direnv when entering this directory
export CONTEXT="home"
export GHQ_ROOT="$PWD/repos"
EOF
        log "  Created home/.envrc"
    fi

    # Create symlinks from user home to directories
    ln -sfn "$DATA_MOUNT/work" "$HOME/work"
    ln -sfn "$DATA_MOUNT/home" "$HOME/home"

    # Allow direnv for both directories
    mkdir -p "$HOME/.config/direnv"
    if [[ ! -f "$HOME/.config/direnv/direnv.toml" ]]; then
        cat > "$HOME/.config/direnv/direnv.toml" << EOF
[whitelist]
prefix = ["$DATA_MOUNT"]
EOF
    fi

    # Auto-allow the .envrc files
    direnv allow "$DATA_MOUNT/work" 2>/dev/null || true
    direnv allow "$DATA_MOUNT/home" 2>/dev/null || true

    log_success "Work/home directories created"
    log "  ~/work  → $DATA_MOUNT/work  (work repos, tickets)"
    log "  ~/home  → $DATA_MOUNT/home  (personal repos, projects)"
    log "  PAI uses default ~/.claude (unified history)"
}

# =============================================================================
# PAI Setup (unified - uses default ~/.claude)
# =============================================================================

setup_pai() {
    log "Checking PAI setup..."

    # PAI uses default location ~/.claude
    local PAI_DIR="$HOME/.claude"

    if [[ -d "$PAI_DIR/hooks" ]] || [[ -d "$PAI_DIR/skills" ]]; then
        log_success "PAI already configured at $PAI_DIR"
        return 0
    fi

    # Check if PAI repo is available for bootstrapping
    local PAI_REPO="$HOME/work/repos/github.com/danielmiessler/Personal_AI_Infrastructure"
    if [[ ! -d "$PAI_REPO" ]]; then
        PAI_REPO="$HOME/home/repos/github.com/danielmiessler/Personal_AI_Infrastructure"
    fi

    if [[ ! -d "$PAI_REPO" ]]; then
        log "PAI repo not found - install PAI manually or clone:"
        log "  ghq get danielmiessler/Personal_AI_Infrastructure"
        log "  Then run PAI installer from Bundles/Official"
        return 0
    fi

    log "PAI repo found at: $PAI_REPO"
    log "Run PAI installer: cd $PAI_REPO/Bundles/Official && bun run install.ts"
}

# =============================================================================
# Custom Skills Installation (to default ~/.claude)
# =============================================================================

install_custom_skills() {
    local SKILLS_SRC="$HOME/work/repos/github.com/dacapo-labs/host/skills"

    # Fall back to home context or old location
    if [[ ! -d "$SKILLS_SRC" ]]; then
        SKILLS_SRC="$HOME/home/repos/github.com/dacapo-labs/host/skills"
    fi
    if [[ ! -d "$SKILLS_SRC" ]]; then
        SKILLS_SRC="$HOME/skills"
    fi

    if [[ ! -d "$SKILLS_SRC" ]]; then
        log "No custom skills found - skipping"
        return 0
    fi

    log "Installing custom skills..."

    # Install to default ~/.claude location
    local SKILLS_DST="$HOME/.claude/skills"
    mkdir -p "$SKILLS_DST"

    # Install skill markdown files
    for skill_dir in "$SKILLS_SRC"/*/; do
        [[ -d "$skill_dir" ]] || continue
        local name=$(basename "$skill_dir")
        [[ "$name" == .* ]] && continue

        if [[ -f "$skill_dir/README.md" ]]; then
            cp "$skill_dir/README.md" "$SKILLS_DST/${name}.md"
            log "  Installed skill: $name"
        fi
    done

    # Install helper scripts to ~/bin
    mkdir -p "$HOME/bin"
    for script in "$SKILLS_SRC"/*/src/*.sh; do
        [[ -f "$script" ]] || continue
        local script_name=$(basename "$script")
        cp "$script" "$HOME/bin/${script_name%.sh}"
        chmod +x "$HOME/bin/${script_name%.sh}"
        log "  Installed script: ${script_name%.sh}"
    done

    # Install hooks to default location
    local HOOKS_DST="$HOME/.claude/hooks"
    mkdir -p "$HOOKS_DST"
    for hook in "$SKILLS_SRC"/*/src/*-hook.ts; do
        [[ -f "$hook" ]] || continue
        cp "$hook" "$HOOKS_DST/"
        log "  Installed hook: $(basename "$hook")"
    done

    log_success "Custom skills installed to ~/.claude"
}

# =============================================================================
# Configure SDP API from BWS
# =============================================================================

setup_sdp_credentials() {
    log "Configuring ServiceDesk Plus credentials..."

    local SDP_BASE_URL SDP_API_KEY SDP_TECH_ID
    SDP_BASE_URL=$(bws_get "sdp-base-url" 2>/dev/null) || true
    SDP_API_KEY=$(bws_get "sdp-api-key" 2>/dev/null) || true
    SDP_TECH_ID=$(bws_get "sdp-technician-id" 2>/dev/null) || true

    if [[ -z "$SDP_BASE_URL" || -z "$SDP_API_KEY" ]]; then
        log "SDP credentials not in BWS - skipping"
        return 0
    fi

    # Add to work context .envrc
    local work_envrc="$DATA_MOUNT/work/.envrc"
    if ! grep -q "SDP_BASE_URL" "$work_envrc" 2>/dev/null; then
        cat >> "$work_envrc" << EOF

# ServiceDesk Plus API (from BWS)
export SDP_BASE_URL="$SDP_BASE_URL"
export SDP_API_KEY="$SDP_API_KEY"
export SDP_TECHNICIAN_ID="$SDP_TECH_ID"
EOF
    fi

    direnv allow "$DATA_MOUNT/work" 2>/dev/null || true

    log_success "SDP credentials added to work context"
}

# =============================================================================
# Session Sync Setup (unified ~/.claude/history)
# =============================================================================

setup_session_sync() {
    local SESSIONS_REPO
    SESSIONS_REPO=$(bws_get "sessions-git-repo" 2>/dev/null) || true

    if [[ -z "$SESSIONS_REPO" ]]; then
        log "No sessions-git-repo in BWS - skipping session-sync"
        return 0
    fi

    log "Setting up session-sync..."

    # Use default ~/.claude location (symlinked to /data for persistence)
    local history_dir="$HOME/.claude/history"
    mkdir -p "$history_dir"

    if [[ ! -d "$history_dir/.git" ]]; then
        cd "$history_dir"
        git init -q
        git remote add origin "$SESSIONS_REPO" 2>/dev/null || git remote set-url origin "$SESSIONS_REPO"
        echo "# PAI Session History" > README.md
        git add README.md
        git commit -q -m "Initial history" 2>/dev/null || true
        git push -u origin main 2>/dev/null || log "  Push failed - may need to create repo first"
    fi

    # Configure session-sync service
    mkdir -p "$HOME/.config/session-sync"
    cat > "$HOME/.config/session-sync/default.conf" << EOF
SYNC_DIR=$history_dir
BRANCH=main
EOF

    systemctl --user enable "session-sync@default" 2>/dev/null || true

    log_success "Session sync configured for ~/.claude/history"
}

# =============================================================================
# Shell Integration
# =============================================================================

setup_shell_integration() {
    log "Setting up shell integration..."

    # Add context helper functions to zshrc
    local zshrc_additions='
# DevBox Context Helpers
ctx() {
    case "${1:-}" in
        work|w) cd ~/work ;;
        home|h) cd ~/home ;;
        *) echo "Current: ${CONTEXT:-none}"; echo "Usage: ctx [work|home]" ;;
    esac
}

# Show context in prompt (optional)
# PROMPT="%F{cyan}[${CONTEXT:-?}]%f $PROMPT"
'

    if ! grep -q "DevBox Context Helpers" "$HOME/.zshrc" 2>/dev/null; then
        echo "$zshrc_additions" >> "$HOME/.zshrc"
        log "  Added context helpers to .zshrc"
    fi

    log_success "Shell integration configured"
    log "  Use 'ctx work' or 'ctx home' to switch contexts"
    log "  Or just 'cd ~/work' / 'cd ~/home' (direnv auto-switches)"
}

# =============================================================================
# Main
# =============================================================================

log "=== DevBox Init ==="
log ""

if ! check_bws; then
    log_error "Cannot proceed without Bitwarden Secrets Manager access"
    exit 1
fi

if ! setup_luks; then
    log_error "LUKS setup failed"
    exit 1
fi

# Set up work/home directories (files only, unified PAI)
setup_directories

# Check PAI setup (uses default ~/.claude)
setup_pai

# Install custom skills (to ~/.claude)
install_custom_skills

# Configure SDP credentials (work context)
setup_sdp_credentials

# Session sync (unified history)
setup_session_sync

# Shell helpers
setup_shell_integration

log ""
log_success "DevBox initialization complete"
log ""
log "Directory structure:"
log "  ~/work   → Work files (repos, tickets, notes)"
log "  ~/home   → Personal files (repos, projects, notes)"
log "  ~/.claude → PAI (unified history, skills, hooks)"
log ""
log "GHQ_ROOT auto-switches via direnv when you cd into ~/work or ~/home."
log ""
log "Next steps:"
log "  1. cd ~/work && direnv allow"
log "  2. cd ~/home && direnv allow"
log "  3. Start Claude: claude"
