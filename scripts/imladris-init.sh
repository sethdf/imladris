#!/usr/bin/env bash
# imladris-init - Initialize LUKS encrypted data volume with work/home directories
set -euo pipefail

DATA_MAPPER="data"
DATA_MOUNT="/data"

# Timeouts (in seconds)
BWS_TIMEOUT=30
CURL_TIMEOUT=10
CRYPTSETUP_TIMEOUT=60

log() { echo "[$(date '+%H:%M:%S')] $*"; }
log_success() { echo "[$(date '+%H:%M:%S')] ✓ $*"; }
log_error() { echo "[$(date '+%H:%M:%S')] ✗ $*"; }

# Retry wrapper with exponential backoff
# Usage: retry <max_attempts> <command> [args...]
retry() {
    local max_attempts=$1
    shift
    local attempt=1
    local wait_time=2

    while [[ $attempt -le $max_attempts ]]; do
        if "$@"; then
            return 0
        fi
        if [[ $attempt -lt $max_attempts ]]; then
            log "Attempt $attempt failed, retrying in ${wait_time}s..."
            sleep $wait_time
            wait_time=$((wait_time * 2))
            [[ $wait_time -gt 30 ]] && wait_time=30
        fi
        ((attempt++))
    done
    return 1
}

# Detect data device (handles both NVMe and Xen naming)
detect_data_device() {
    # NVMe instances (t4g, m6g, etc) - second NVMe device
    if [[ -b /dev/nvme1n1 ]]; then
        echo "/dev/nvme1n1"
        return 0
    fi
    # Xen instances - /dev/xvdf is common for additional volumes
    if [[ -b /dev/xvdf ]]; then
        echo "/dev/xvdf"
        return 0
    fi
    # Fallback for older instances
    if [[ -b /dev/sdf ]]; then
        echo "/dev/sdf"
        return 0
    fi
    return 1
}

DATA_DEV=""

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
    "aws-cross-accounts:JSON array of AWS accounts for cross-account access"
)

check_bws() {
    if ! command -v bws &>/dev/null; then
        log_error "bws CLI not installed"
        return 1
    fi

    if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
        local token_file="$HOME/.config/bws/access-token"
        # Also check LUKS-encrypted location
        local luks_token_file="$DATA_MOUNT/.secrets/bws-token"
        if [[ -f "$luks_token_file" ]]; then
            BWS_ACCESS_TOKEN=$(cat "$luks_token_file")
            export BWS_ACCESS_TOKEN
        elif [[ -f "$token_file" ]]; then
            BWS_ACCESS_TOKEN=$(cat "$token_file")
            export BWS_ACCESS_TOKEN
        else
            # Prompt for token
            echo -n "BWS Access Token: "
            read -r BWS_ACCESS_TOKEN
            if [[ -z "$BWS_ACCESS_TOKEN" ]]; then
                return 1
            fi
            export BWS_ACCESS_TOKEN
            # Save for future use
            mkdir -p "$(dirname "$token_file")"
            echo "$BWS_ACCESS_TOKEN" > "$token_file"
            chmod 600 "$token_file"
        fi
    fi

    # Test connection with timeout and retry
    if ! retry 3 timeout "$BWS_TIMEOUT" bws secret list &>/dev/null; then
        log_error "Invalid token or connection failed"
        rm -f "$HOME/.config/bws/access-token" 2>/dev/null
        return 1
    fi

    log_success "BWS connected"
}

list_secrets() {
    timeout "$BWS_TIMEOUT" bws secret list 2>/dev/null | jq -r '.[].key' | sort
}

secret_exists() {
    local name="$1"
    timeout "$BWS_TIMEOUT" bws secret list 2>/dev/null | jq -e --arg name "$name" '.[] | select(.key == $name)' &>/dev/null
}

create_secret() {
    local name="$1"
    local value="$2"
    local project_id

    # Get the first project ID (or create one if needed)
    project_id=$(timeout "$BWS_TIMEOUT" bws project list 2>/dev/null | jq -r '.[0].id // empty')

    if [[ -z "$project_id" ]]; then
        log_error "No BWS project found. Create one in Bitwarden first."
        return 1
    fi

    timeout "$BWS_TIMEOUT" bws secret create "$name" "$value" "$project_id" &>/dev/null
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

    # Get secret with timeout and retry
    secret_id=$(retry 3 timeout "$BWS_TIMEOUT" bws secret list 2>/dev/null | jq -r --arg name "$secret_name" '.[] | select(.key == $name) | .id')
    [[ -z "$secret_id" ]] && return 1

    timeout "$BWS_TIMEOUT" bws secret get "$secret_id" 2>/dev/null | jq -r '.value'
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
    # Detect data device dynamically
    DATA_DEV=$(detect_data_device) || {
        log "No data device found (checked nvme1n1, xvdf, sdf) - skipping LUKS setup"
        return 0
    }
    log "Detected data device: $DATA_DEV"

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
        echo -n "$LUKS_KEY" | sudo timeout "$CRYPTSETUP_TIMEOUT" cryptsetup luksFormat --type luks2 -q "$DATA_DEV" - || {
            log_error "LUKS format failed (timeout: ${CRYPTSETUP_TIMEOUT}s)"
            return 1
        }
        echo -n "$LUKS_KEY" | sudo timeout "$CRYPTSETUP_TIMEOUT" cryptsetup open "$DATA_DEV" "$DATA_MAPPER" - || {
            log_error "LUKS open failed after format"
            return 1
        }
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
            echo -n "$LUKS_KEY" | sudo timeout "$CRYPTSETUP_TIMEOUT" cryptsetup open "$DATA_DEV" "$DATA_MAPPER" - || {
                log_error "Failed to unlock - wrong passphrase or BWS keyfile changed (timeout: ${CRYPTSETUP_TIMEOUT}s)"
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

    # Store token on LUKS (atomic write to prevent brief world-readable window)
    if [[ -n "${BWS_ACCESS_TOKEN:-}" ]]; then
        local TMP_FILE="$TOKEN_FILE.tmp.$$"
        (umask 077; echo -n "$BWS_ACCESS_TOKEN" > "$TMP_FILE")
        mv "$TMP_FILE" "$TOKEN_FILE"
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
    mkdir -p "$DATA_MOUNT/work"/{repos,tickets,notes,adhoc}

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

    # Create symlinks from user home to data volume
    ln -sfn "$DATA_MOUNT/work" "$HOME/work"
    ln -sfn "$DATA_MOUNT/home" "$HOME/home"

    # Claude Code config - symlink to data volume for persistence
    mkdir -p "$DATA_MOUNT/.claude"
    ln -sfn "$DATA_MOUNT/.claude" "$HOME/.claude"

    # AWS config - symlink to data volume
    mkdir -p "$DATA_MOUNT/.aws"
    ln -sfn "$DATA_MOUNT/.aws" "$HOME/.aws"

    # Stateful config directories - symlink to data volume
    # These contain credentials, tokens, and state that must survive root volume loss
    local CONFIG_DIRS="bws claude fabric gcloud gitwatch himalaya simplex-bridge slack-listener rclone"
    for dir in $CONFIG_DIRS; do
        mkdir -p "$DATA_MOUNT/.config/$dir"
        if [[ -d "$HOME/.config/$dir" ]] && [[ ! -L "$HOME/.config/$dir" ]]; then
            # Merge existing content then replace with symlink
            rsync -a "$HOME/.config/$dir/" "$DATA_MOUNT/.config/$dir/" 2>/dev/null || true
            rm -rf "$HOME/.config/$dir"
        fi
        ln -sfn "$DATA_MOUNT/.config/$dir" "$HOME/.config/$dir"
    done

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
    log "  ~/work    → $DATA_MOUNT/work    (work repos, tickets)"
    log "  ~/home    → $DATA_MOUNT/home    (personal repos, projects)"
    log "  ~/.claude → $DATA_MOUNT/.claude (PAI skills, hooks, settings)"
    log "  ~/.aws    → $DATA_MOUNT/.aws    (AWS profiles, credentials)"
    log "  ~/.config/{bws,gcloud,fabric,...} → $DATA_MOUNT/.config/ (stateful configs)"
}

# =============================================================================
# PAI Setup (unified - uses default ~/.claude)
# =============================================================================

setup_pai() {
    log "Checking PAI setup..."

    # PAI uses default location ~/.claude (symlinked to /data/.claude)
    local PAI_DIR="$HOME/.claude"

    if [[ -d "$PAI_DIR/hooks" ]] && [[ -d "$PAI_DIR/skills" ]]; then
        log_success "PAI already configured at $PAI_DIR"
        return 0
    fi

    # Check if PAI repo is available
    # Check multiple possible ghq locations
    local PAI_REPO=""
    for repo_root in "$HOME/repos" "$HOME/work/repos" "$HOME/home/repos"; do
        if [[ -d "$repo_root/github.com/danielmiessler/Personal_AI_Infrastructure" ]]; then
            PAI_REPO="$repo_root/github.com/danielmiessler/Personal_AI_Infrastructure"
            break
        fi
    done

    if [[ -z "$PAI_REPO" ]]; then
        log "PAI repo not found - clone it first:"
        log "  ghq get danielmiessler/Personal_AI_Infrastructure"
        return 0
    fi

    log "PAI repo found at: $PAI_REPO"

    # PAI requires AI-assisted installation (two-phase process)
    # Phase 1: Interactive bootstrap asks for preferences
    # Phase 2: AI reads pack files and installs skills/hooks
    log ""
    log "To install PAI, run 'claude' and say:"
    log "  Install PAI from $PAI_REPO/Bundles/Official"
    log ""
    log "Claude will handle both bootstrap and pack installation."
}

# =============================================================================
# Curu Skills Installation
# Curu: "Skill" in Elvish (from Curunír, "Man of Skill")
# =============================================================================

install_curu_skills() {
    # Look for curu-skills repo in standard ghq locations
    local SKILLS_SRC=""
    for repo_root in "$HOME/repos" "$HOME/work/repos" "$HOME/home/repos"; do
        if [[ -d "$repo_root/github.com/sethdf/curu-skills" ]]; then
            SKILLS_SRC="$repo_root/github.com/sethdf/curu-skills"
            break
        fi
    done

    # Clone if not found
    if [[ -z "$SKILLS_SRC" ]]; then
        log "Cloning curu-skills..."
        if command -v ghq &>/dev/null; then
            ghq get sethdf/curu-skills 2>/dev/null || true
            SKILLS_SRC="$HOME/repos/github.com/sethdf/curu-skills"
        else
            git clone https://github.com/sethdf/curu-skills.git "$HOME/repos/github.com/sethdf/curu-skills" 2>/dev/null || true
            SKILLS_SRC="$HOME/repos/github.com/sethdf/curu-skills"
        fi
    fi

    if [[ ! -d "$SKILLS_SRC" ]]; then
        log "Could not clone curu-skills repo"
        return 0
    fi

    log "Awakening Curu's skills from $SKILLS_SRC..."

    # Install to ~/.claude (symlinked to /data/.claude for persistence)
    local SKILLS_DST="$HOME/.claude/skills"
    local HOOKS_DST="$HOME/.claude/hooks"
    mkdir -p "$SKILLS_DST" "$HOOKS_DST" "$HOME/bin"

    # Symlink skills (PAI format: SkillName/SKILL.md)
    # Using symlinks so changes in curu-skills are immediately discoverable
    local skill_count=0
    for skill_dir in "$SKILLS_SRC"/*/; do
        [[ -d "$skill_dir" ]] || continue
        local name
        name=$(basename "$skill_dir")
        [[ "$name" == .* ]] && continue
        [[ "$name" == "hooks" ]] && continue  # Skip hooks directory

        # Symlink skill directory (preserves PAI structure, enables live updates)
        if [[ -f "$skill_dir/SKILL.md" ]]; then
            # Remove existing (copy or broken symlink) and create fresh symlink
            rm -rf "$SKILLS_DST/$name"
            ln -sfn "$skill_dir" "$SKILLS_DST/$name"
            ((skill_count++))
        fi
    done

    # Symlink helper scripts to ~/bin
    local script_count=0
    for script in "$SKILLS_SRC"/*/Tools/*.sh; do
        [[ -f "$script" ]] || continue
        local script_name
        script_name=$(basename "$script")
        ln -sf "$script" "$HOME/bin/${script_name%.sh}"
        chmod +x "$script"
        ((script_count++))
    done

    # Symlink hooks from hooks/ directory
    local hook_count=0
    if [[ -d "$SKILLS_SRC/hooks" ]]; then
        for hook in "$SKILLS_SRC/hooks"/*; do
            [[ -f "$hook" ]] || continue
            local hook_name
            hook_name=$(basename "$hook")
            ln -sf "$hook" "$HOOKS_DST/$hook_name"
            ((hook_count++))
        done
    fi

    if [[ $skill_count -gt 0 ]] || [[ $script_count -gt 0 ]] || [[ $hook_count -gt 0 ]]; then
        log_success "Curu awakened: $skill_count skills, $script_count scripts, $hook_count hooks (symlinked)"
    else
        log "No skills found in curu-skills repo"
    fi
}

# =============================================================================
# Imladris Scripts Installation
# Symlink imladris/scripts to ~/bin for easy access
# =============================================================================

install_imladris_scripts() {
    # Look for imladris repo in standard ghq locations
    local IMLADRIS_SRC=""
    for repo_root in "$HOME/repos" "$HOME/work/repos" "$HOME/home/repos"; do
        if [[ -d "$repo_root/github.com/sethdf/imladris" ]]; then
            IMLADRIS_SRC="$repo_root/github.com/sethdf/imladris"
            break
        fi
    done

    if [[ ! -d "$IMLADRIS_SRC" ]]; then
        log "Imladris repo not found - skipping script installation"
        return 0
    fi

    log "Installing imladris scripts from $IMLADRIS_SRC..."

    mkdir -p "$HOME/bin"

    # Symlink scripts (remove .sh extension for cleaner commands)
    local script_count=0
    for script in "$IMLADRIS_SRC/scripts"/*.sh; do
        [[ -f "$script" ]] || continue
        local script_name
        script_name=$(basename "$script" .sh)

        # Skip template/service files
        [[ "$script_name" == *"@"* ]] && continue
        [[ "$script_name" == *".service"* ]] && continue
        [[ "$script_name" == *".timer"* ]] && continue

        ln -sf "$script" "$HOME/bin/$script_name"
        ((script_count++))
    done

    if [[ $script_count -gt 0 ]]; then
        log_success "Imladris scripts installed: $script_count scripts (symlinked to ~/bin)"
    else
        log "No imladris scripts found"
    fi
}

# =============================================================================
# Update Check Timer Installation
# Daily check for AI tooling updates (PAI, Claude Code, MCP, skills)
# =============================================================================

install_update_check_timer() {
    # Look for imladris repo in standard ghq locations
    local IMLADRIS_SRC=""
    for repo_root in "$HOME/repos" "$HOME/work/repos" "$HOME/home/repos"; do
        if [[ -d "$repo_root/github.com/sethdf/imladris" ]]; then
            IMLADRIS_SRC="$repo_root/github.com/sethdf/imladris"
            break
        fi
    done

    if [[ ! -d "$IMLADRIS_SRC" ]]; then
        return 0
    fi

    local SCRIPTS_DIR="$IMLADRIS_SRC/scripts"
    local SYSTEMD_USER_DIR="$HOME/.config/systemd/user"

    # Check if timer and service files exist
    if [[ ! -f "$SCRIPTS_DIR/update-check.timer" ]] || [[ ! -f "$SCRIPTS_DIR/update-check.service" ]]; then
        return 0
    fi

    log "Installing update-check timer..."

    mkdir -p "$SYSTEMD_USER_DIR"

    # Copy timer and service
    cp "$SCRIPTS_DIR/update-check.timer" "$SYSTEMD_USER_DIR/"
    cp "$SCRIPTS_DIR/update-check.service" "$SYSTEMD_USER_DIR/"

    # Reload and enable
    if systemctl --user daemon-reload 2>/dev/null; then
        if systemctl --user enable update-check.timer 2>/dev/null; then
            systemctl --user start update-check.timer 2>/dev/null || true
            log_success "Update check timer installed (runs at midnight)"
        fi
    fi
}

# =============================================================================
# Anthropic Official Skills Installation
# https://github.com/anthropics/skills
# =============================================================================

install_anthropic_skills() {
    # Look for anthropics/skills repo in standard ghq locations
    local SKILLS_SRC=""
    for repo_root in "$HOME/repos" "$HOME/work/repos" "$HOME/home/repos"; do
        if [[ -d "$repo_root/github.com/anthropics/skills" ]]; then
            SKILLS_SRC="$repo_root/github.com/anthropics/skills"
            break
        fi
    done

    if [[ -z "$SKILLS_SRC" ]]; then
        log "Anthropic skills repo not found - clone it first:"
        log "  ghq get anthropics/skills"
        return 0
    fi

    log "Installing Anthropic official skills from $SKILLS_SRC..."

    local SKILLS_DST="$HOME/.claude/skills"
    mkdir -p "$SKILLS_DST"

    local skill_count=0

    # Install skills from skills/ directory (structure: skills/skill-name/SKILL.md)
    if [[ -d "$SKILLS_SRC/skills" ]]; then
        for skill_dir in "$SKILLS_SRC/skills"/*/; do
            [[ -d "$skill_dir" ]] || continue
            local name
            name=$(basename "$skill_dir")
            [[ "$name" == .* ]] && continue

            # Check for SKILL.md
            if [[ -f "$skill_dir/SKILL.md" ]]; then
                # Prefix with "anthropic-" to avoid conflicts
                cp -r "$skill_dir" "$SKILLS_DST/anthropic-${name}"
                ((skill_count++))
            fi
        done
    fi

    if [[ $skill_count -gt 0 ]]; then
        log_success "Anthropic skills installed: $skill_count skills"
    else
        log "No Anthropic skills found to install"
    fi
}

# =============================================================================
# Curu Packs Installation
# PAI-compliant packs for identity, auth, comms, and simplex-bridge
# =============================================================================

install_curu_packs() {
    # Packs are now in curu-skills/packs/ (not a separate repo)
    local PACKS_SRC=""
    for repo_root in "$HOME/repos" "$HOME/work/repos" "$HOME/home/repos"; do
        if [[ -d "$repo_root/github.com/sethdf/curu-skills/packs" ]]; then
            PACKS_SRC="$repo_root/github.com/sethdf/curu-skills/packs"
            break
        fi
    done

    if [[ -z "$PACKS_SRC" ]]; then
        log "Curu skills/packs not found - clone curu-skills first:"
        log "  ghq get -p sethdf/curu-skills"
        return 0
    fi

    log "Installing curu packs from $PACKS_SRC..."

    # Install simplex-bridge
    if [[ -d "$PACKS_SRC/simplex-bridge-pack" ]]; then
        # Config
        mkdir -p "$HOME/.config/simplex-bridge"
        if [[ -f "$PACKS_SRC/simplex-bridge-pack/src/config/simplex-bridge.yaml" ]]; then
            cp "$PACKS_SRC/simplex-bridge-pack/src/config/simplex-bridge.yaml" \
               "$HOME/.config/simplex-bridge/config.yaml"
        fi

        # Script
        if [[ -f "$PACKS_SRC/simplex-bridge-pack/src/scripts/simplex-bridge.sh" ]]; then
            ln -sf "$PACKS_SRC/simplex-bridge-pack/src/scripts/simplex-bridge.sh" \
                   "$HOME/bin/simplex-bridge"
            chmod +x "$PACKS_SRC/simplex-bridge-pack/src/scripts/simplex-bridge.sh"
        fi

        # Systemd service
        mkdir -p "$HOME/.config/systemd/user"
        if [[ -f "$PACKS_SRC/simplex-bridge-pack/src/systemd/simplex-bridge.service" ]]; then
            cp "$PACKS_SRC/simplex-bridge-pack/src/systemd/simplex-bridge.service" \
               "$HOME/.config/systemd/user/"
        fi

        log_success "Simplex bridge installed (run 'simplex-bridge status' to verify)"
    fi

    # Log directory for simplex conversations
    mkdir -p "$HOME/inbox/simplex"

    # Note about manual steps
    log "  NOTE: To complete simplex-bridge setup:"
    log "    1. Link SimpleX device: simplex-chat -> /connect"
    log "    2. Scan QR with phone"
    log "    3. Enable service: systemctl --user enable --now simplex-bridge"
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
# AWS Cross-Account Config from BWS
# =============================================================================

setup_aws_config() {
    log "Checking AWS cross-account configuration..."

    # Check if secret exists
    if ! bws_get "aws-cross-accounts" &>/dev/null; then
        log "aws-cross-accounts not in BWS - skipping"
        log "  To configure: aws-accounts-config add"
        return 0
    fi

    # Run the config generator
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    if [[ -f "$script_dir/aws-accounts-config.sh" ]]; then
        bash "$script_dir/aws-accounts-config.sh" generate
    elif [[ -f "$HOME/bin/aws-accounts-config" ]]; then
        "$HOME/bin/aws-accounts-config" generate
    else
        log "aws-accounts-config script not found"
        return 0
    fi
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
# Repo Watch (gitwatch)
# Auto-commit sethdf repos on file changes using gitwatch
# =============================================================================

setup_repo_watch() {
    log "Setting up repo-watch (gitwatch for sethdf repos)..."

    local GITWATCH_REPO="$HOME/repos/github.com/gitwatch/gitwatch"
    local SETHDF_REPOS="$HOME/repos/github.com/sethdf"

    # Clone gitwatch if not present
    if [[ ! -d "$GITWATCH_REPO" ]]; then
        log "  Cloning gitwatch..."
        ghq get gitwatch/gitwatch || true
    fi

    # Symlink gitwatch to PATH
    if [[ -f "$GITWATCH_REPO/gitwatch.sh" ]]; then
        ln -sf "$GITWATCH_REPO/gitwatch.sh" "$HOME/.local/bin/gitwatch"
        log "  Linked gitwatch to ~/.local/bin/gitwatch"
    fi

    # Create systemd user service directory
    mkdir -p "$HOME/.config/systemd/user"

    # Create gitwatch service template
    cat > "$HOME/.config/systemd/user/gitwatch@.service" << 'GITWATCH_SERVICE'
[Unit]
Description=gitwatch for %I
After=network.target

[Service]
Type=simple
ExecStart=%h/.local/bin/gitwatch -r origin -b main -s 10 %h/repos/github.com/sethdf/%i
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
GITWATCH_SERVICE

    # Reload systemd
    systemctl --user daemon-reload

    # Enable and start services for each sethdf repo
    if [[ -d "$SETHDF_REPOS" ]]; then
        for repo_dir in "$SETHDF_REPOS"/*/; do
            [[ -d "$repo_dir/.git" ]] || continue
            repo_name=$(basename "$repo_dir")

            log "  Enabling gitwatch for: $repo_name"
            systemctl --user enable "gitwatch@${repo_name}.service" 2>/dev/null || true
            systemctl --user start "gitwatch@${repo_name}.service" 2>/dev/null || true
        done
    fi

    log_success "repo-watch installed"
    log "  gitwatch@<repo>.service - Auto-commit daemon per repo"
    log "  Watching: $(ls -1 "$SETHDF_REPOS" 2>/dev/null | tr '\n' ' ')"
    log ""
    log "  Commands:"
    log "    systemctl --user status 'gitwatch@*'     - Check status"
    log "    systemctl --user restart gitwatch@imladris  - Restart watcher"
    log "    journalctl --user -u gitwatch@imladris -f   - View logs"
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

# Install Curu skills (to ~/.claude, persisted on /data)
install_curu_skills

# Install imladris scripts (symlinked to ~/bin)
install_imladris_scripts

# Install Anthropic official skills
install_anthropic_skills

# Install Curu packs (simplex-bridge, etc.)
install_curu_packs

# Curu development tools (sync, watch, commit)
setup_repo_watch

# Configure SDP credentials (work context)
setup_sdp_credentials

# Configure AWS cross-account profiles from BWS
setup_aws_config

# Session sync (unified history)
setup_session_sync

# Update check timer (daily AI tooling update checks)
install_update_check_timer

# Shell helpers
setup_shell_integration

log ""
log_success "Imladris initialization complete"
log ""
log "╔════════════════════════════════════════════════════════════════╗"
log "║                    Directory Structure                         ║"
log "╚════════════════════════════════════════════════════════════════╝"
log "  ~/work     → Work files (repos, tickets, notes, adhoc)"
log "  ~/home     → Personal files (repos, projects, notes)"
log "  ~/.claude  → Curu AI (skills, hooks, history) → /data/.claude"
log ""
log "╔════════════════════════════════════════════════════════════════╗"
log "║                      Next Steps                                ║"
log "╚════════════════════════════════════════════════════════════════╝"
log ""
log "  1. Start a new shell (to pick up environment):"
log "     exec zsh"
log ""
log "  2. Start Claude Code:"
log "     claude"
log ""
log "  3. (Optional) Enable direnv for work/home directories:"
log "     cd ~/work && direnv allow"
log "     cd ~/home && direnv allow"
log ""
log "╔════════════════════════════════════════════════════════════════╗"
log "║                    Repo Watch (gitwatch)                       ║"
log "╚════════════════════════════════════════════════════════════════╝"
log "  Auto-commits all sethdf repos on file changes"
log "  systemctl --user status 'gitwatch@*'  - Check status"
log "  journalctl --user -u gitwatch@imladris -f  - View logs"
log ""
log "╔════════════════════════════════════════════════════════════════╗"
log "║                    On Next Reboot                              ║"
log "╚════════════════════════════════════════════════════════════════╝"
log "  Just run: imladris-init"
log "  (Will prompt for LUKS passphrase only - BWS token persisted)"
log ""
