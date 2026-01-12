#!/usr/bin/env bash
# imladris-init - Initialize LUKS encrypted data volume with work/home directories
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

# Required secrets (init fails without these)
REQUIRED_SECRETS=("luks-keyfile")

# Optional secrets (features work without, but enhanced with)
OPTIONAL_SECRETS=(
    "sdp-base-url:ServiceDesk Plus base URL"
    "sdp-api-key:ServiceDesk Plus API key"
    "sdp-technician-id:ServiceDesk Plus technician ID"
    "sessions-git-repo:Git repo for session history sync"
    "github-token:GitHub personal access token"
    "tailscale-auth-key:Tailscale auth key for additional devices"
)

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

list_secrets() {
    bws secret list 2>/dev/null | jq -r '.[].key' | sort
}

secret_exists() {
    local name="$1"
    bws secret list 2>/dev/null | jq -e --arg name "$name" '.[] | select(.key == $name)' &>/dev/null
}

create_secret() {
    local name="$1"
    local value="$2"
    local project_id

    # Get the first project ID (or create one if needed)
    project_id=$(bws project list 2>/dev/null | jq -r '.[0].id // empty')

    if [[ -z "$project_id" ]]; then
        log_error "No BWS project found. Create one in Bitwarden first."
        return 1
    fi

    bws secret create "$name" "$value" "$project_id" &>/dev/null
}

manage_secrets() {
    echo ""
    echo "╔════════════════════════════════════════════════════════════════╗"
    echo "║              Bitwarden Secrets Manager                         ║"
    echo "╚════════════════════════════════════════════════════════════════╝"
    echo ""

    # Get existing secrets
    local existing_secrets
    existing_secrets=$(list_secrets)

    echo "📋 Current secrets in BWS:"
    if [[ -n "$existing_secrets" ]]; then
        echo "$existing_secrets" | sed 's/^/   • /'
    else
        echo "   (none)"
    fi
    echo ""

    # Check required secrets
    echo "🔐 Required secrets:"
    local missing_required=()
    for secret in "${REQUIRED_SECRETS[@]}"; do
        if secret_exists "$secret"; then
            echo "   ✓ $secret"
        else
            echo "   ✗ $secret (MISSING)"
            missing_required+=("$secret")
        fi
    done
    echo ""

    # Check optional secrets
    echo "📦 Optional secrets:"
    local missing_optional=()
    for entry in "${OPTIONAL_SECRETS[@]}"; do
        local name="${entry%%:*}"
        local desc="${entry#*:}"
        if secret_exists "$name"; then
            echo "   ✓ $name"
        else
            echo "   ○ $name - $desc"
            missing_optional+=("$entry")
        fi
    done
    echo ""

    # Handle missing required secrets
    if [[ ${#missing_required[@]} -gt 0 ]]; then
        echo "⚠️  Missing required secrets. Create them now?"
        echo ""
        for secret in "${missing_required[@]}"; do
            case "$secret" in
                luks-keyfile)
                    echo "luks-keyfile: Random data for LUKS encryption"
                    read -p "  Generate random keyfile? [Y/n] " choice
                    if [[ "${choice:-y}" =~ ^[Yy]$ ]]; then
                        local keyfile
                        keyfile=$(openssl rand -base64 32)
                        if create_secret "luks-keyfile" "$keyfile"; then
                            log_success "Created luks-keyfile"
                        else
                            log_error "Failed to create luks-keyfile"
                            return 1
                        fi
                    else
                        log_error "luks-keyfile is required for LUKS encryption"
                        return 1
                    fi
                    ;;
            esac
        done
        echo ""
    fi

    # Offer to create optional secrets
    if [[ ${#missing_optional[@]} -gt 0 ]]; then
        echo "Would you like to configure optional secrets?"
        read -p "  Configure optional secrets? [y/N] " choice

        if [[ "${choice:-n}" =~ ^[Yy]$ ]]; then
            echo ""
            echo "Select secrets to configure (space-separated numbers, or 'all'):"
            local i=1
            for entry in "${missing_optional[@]}"; do
                local name="${entry%%:*}"
                local desc="${entry#*:}"
                echo "  $i) $name - $desc"
                ((i++))
            done
            echo ""
            read -p "Selection: " selection

            if [[ "$selection" == "all" ]]; then
                selection=$(seq 1 ${#missing_optional[@]} | tr '\n' ' ')
            fi

            for num in $selection; do
                if [[ $num -ge 1 && $num -le ${#missing_optional[@]} ]]; then
                    local entry="${missing_optional[$((num-1))]}"
                    local name="${entry%%:*}"
                    local desc="${entry#*:}"
                    echo ""
                    echo "Creating: $name ($desc)"
                    read -sp "  Value: " value
                    echo ""
                    if [[ -n "$value" ]]; then
                        if create_secret "$name" "$value"; then
                            log_success "Created $name"
                        else
                            log_error "Failed to create $name"
                        fi
                    else
                        log "  Skipped (empty value)"
                    fi
                fi
            done
        fi
        echo ""
    fi

    log_success "Secrets configuration complete"
}

bws_get() {
    local secret_name="$1"
    local secret_id
    secret_id=$(bws secret list 2>/dev/null | jq -r --arg name "$secret_name" '.[] | select(.key == $name) | .id')
    [[ -z "$secret_id" ]] && return 1
    bws secret get "$secret_id" 2>/dev/null | jq -r '.value'
}

# =============================================================================
# LUKS Setup (MFA: BWS keyfile + personal passphrase)
# =============================================================================

get_luks_key() {
    local BWS_KEYFILE PASSPHRASE

    BWS_KEYFILE=$(bws_get "luks-keyfile") || {
        log_error "luks-keyfile not found in Secrets Manager"
        log_error "Create a secret named 'luks-keyfile' with random data (e.g., openssl rand -base64 32)"
        return 1
    }

    # UI goes to stderr so it doesn't get captured with the key
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

    # Return combined key (only this goes to stdout)
    echo -n "${BWS_KEYFILE}${PASSPHRASE}"
}

setup_luks() {
    if [[ ! -b "$DATA_DEV" ]]; then
        log "No data device at $DATA_DEV - skipping LUKS setup"
        return 0
    fi

    log "Setting up encrypted data volume (MFA)..."

    local LUKS_KEY
    LUKS_KEY=$(get_luks_key) || return 1

    if ! sudo cryptsetup isLuks "$DATA_DEV" 2>/dev/null; then
        # First time setup - confirm passphrase
        echo ""
        read -rs -p "Confirm passphrase: " CONFIRM_PASS
        echo ""

        local BWS_KEYFILE
        BWS_KEYFILE=$(bws_get "luks-keyfile")
        local CHECK_KEY="${BWS_KEYFILE}${CONFIRM_PASS}"

        if [[ "$LUKS_KEY" != "$CHECK_KEY" ]]; then
            log_error "Passphrases do not match"
            return 1
        fi

        log "Formatting $DATA_DEV with LUKS2..."
        log "⚠️  WARNING: This will DESTROY all data on $DATA_DEV"
        read -p "Type 'yes' to continue: " CONFIRM
        [[ "$CONFIRM" == "yes" ]] || { log "Aborted"; return 1; }

        sudo wipefs -a "$DATA_DEV" 2>/dev/null || true
        echo -n "$LUKS_KEY" | sudo cryptsetup luksFormat --type luks2 -q "$DATA_DEV" -
        echo -n "$LUKS_KEY" | sudo cryptsetup open "$DATA_DEV" "$DATA_MAPPER" -
        sudo mkfs.ext4 -L data "/dev/mapper/$DATA_MAPPER"
        sudo mkdir -p "$DATA_MOUNT"
        sudo mount "/dev/mapper/$DATA_MAPPER" "$DATA_MOUNT"
        sudo chown ubuntu:ubuntu "$DATA_MOUNT"
        log_success "Data volume initialized with MFA"
        log "🔐 Unlock requires: BWS keyfile + your passphrase"
    else
        # Existing LUKS volume - unlock it
        if [[ ! -e "/dev/mapper/$DATA_MAPPER" ]]; then
            log "Unlocking LUKS volume..."
            echo -n "$LUKS_KEY" | sudo cryptsetup open "$DATA_DEV" "$DATA_MAPPER" - || {
                log_error "Failed to unlock - wrong passphrase or BWS keyfile changed"
                return 1
            }
        fi

        sudo mkdir -p "$DATA_MOUNT"
        if ! mountpoint -q "$DATA_MOUNT"; then
            sudo mount "/dev/mapper/$DATA_MAPPER" "$DATA_MOUNT"
        fi
        log_success "Data volume unlocked and mounted"
    fi
}

# =============================================================================
# BWS Token Persistence (store on LUKS, remove from root)
# =============================================================================

persist_bws_token() {
    local SECRETS_DIR="$DATA_MOUNT/.secrets"
    local TOKEN_FILE="$SECRETS_DIR/bws-token"
    local ROOT_TOKEN_FILE="$HOME/.config/bws/access-token"

    # Create secrets directory on LUKS with restricted permissions
    sudo mkdir -p "$SECRETS_DIR"
    sudo chown ubuntu:ubuntu "$SECRETS_DIR"
    chmod 700 "$SECRETS_DIR"

    # Store token on LUKS
    if [[ -n "${BWS_ACCESS_TOKEN:-}" ]]; then
        echo -n "$BWS_ACCESS_TOKEN" > "$TOKEN_FILE"
        chmod 600 "$TOKEN_FILE"
        log_success "BWS token stored on encrypted volume"
    fi

    # Remove token from root volume (if present)
    if [[ -f "$ROOT_TOKEN_FILE" ]]; then
        rm -f "$ROOT_TOKEN_FILE"
        log "Removed BWS token from root volume"
    fi

    # Remove parent dir if empty
    rmdir "$HOME/.config/bws" 2>/dev/null || true
}

load_bws_token_from_luks() {
    local TOKEN_FILE="$DATA_MOUNT/.secrets/bws-token"

    if [[ -f "$TOKEN_FILE" ]]; then
        BWS_ACCESS_TOKEN=$(cat "$TOKEN_FILE")
        export BWS_ACCESS_TOKEN
        return 0
    fi
    return 1
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
        local name
        name=$(basename "$skill_dir")
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
        local script_name
        script_name=$(basename "$script")
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

    local config_dir="$HOME/.config/imladris"
    mkdir -p "$config_dir"

    # Write context helpers to separate file (zshrc is managed by nix)
    local helpers_file="$config_dir/shell-helpers.sh"
    cat > "$helpers_file" << 'EOF'
# Imladris Context Helpers
ctx() {
    case "${1:-}" in
        work|w) cd ~/work ;;
        home|h) cd ~/home ;;
        *) echo "Current: ${CONTEXT:-none}"; echo "Usage: ctx [work|home]" ;;
    esac
}
EOF
    log "  Created $helpers_file"

    # Write BWS token sourcing script
    local bws_env_file="$config_dir/bws-env.sh"
    cat > "$bws_env_file" << 'EOF'
# Imladris BWS Token Loader
# Source this in your shell profile to auto-load BWS token from LUKS
_bws_token_file="/data/.secrets/bws-token"
if [[ -f "$_bws_token_file" ]]; then
    export BWS_ACCESS_TOKEN="$(cat "$_bws_token_file")"
fi
unset _bws_token_file
EOF
    chmod 600 "$bws_env_file"
    log "  Created $bws_env_file"

    log_success "Shell integration configured"
    log "  Use 'ctx work' or 'ctx home' to switch contexts"
    log "  Source bws-env.sh in profile for BWS token auto-load"
}

# =============================================================================
# Main
# =============================================================================

show_help() {
    cat << EOF
Usage: imladris-init [OPTIONS]

Initialize the Imladris devbox environment.

Options:
  --secrets      Only run secrets management (list/create BWS secrets)
  --skip-secrets Skip interactive secrets management
  --help         Show this help message

Examples:
  imladris-init              Full initialization with interactive secrets
  imladris-init --secrets    Just manage BWS secrets
  imladris-init --skip-secrets  Skip secrets prompts (requires luks-keyfile exists)
EOF
}

# Parse arguments
SECRETS_ONLY=false
SKIP_SECRETS=false
for arg in "$@"; do
    case "$arg" in
        --secrets) SECRETS_ONLY=true ;;
        --skip-secrets) SKIP_SECRETS=true ;;
        --help|-h) show_help; exit 0 ;;
        *) log_error "Unknown option: $arg"; show_help; exit 1 ;;
    esac
done

log "=== Imladris Init ==="
log ""

if ! check_bws; then
    log_error "Cannot proceed without Bitwarden Secrets Manager access"
    exit 1
fi

# Secrets-only mode
if [[ "$SECRETS_ONLY" == true ]]; then
    manage_secrets
    exit 0
fi

# Interactive secrets management (unless skipped)
if [[ "$SKIP_SECRETS" == false ]]; then
    manage_secrets
fi

if ! setup_luks; then
    log_error "LUKS setup failed"
    exit 1
fi

# Persist BWS token to LUKS and remove from root volume
persist_bws_token

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
log_success "Imladris initialization complete"
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
