#!/usr/bin/env bash
# devbox-init - Initialize devbox after first SSH
# Does NOT use set -e - handles errors explicitly per step
# Uses Bitwarden Secrets Manager (bws) for all secrets

DATA_DEV="/dev/nvme1n1"
DATA_MAPPER="data"
DATA_MOUNT="/data"
CHECKPOINT_FILE="$HOME/.devbox-init-progress"
FAILED_STEPS=""

# =============================================================================
# Helper Functions
# =============================================================================

log() { echo "[$(date '+%H:%M:%S')] $*"; }
log_success() { log "✓ $*"; }
log_error() { log "✗ $*"; }
log_skip() { log "○ $* (skipped - already done)"; }

step_done() { grep -q "^$1$" "$CHECKPOINT_FILE" 2>/dev/null; }
mark_done() { echo "$1" >> "$CHECKPOINT_FILE"; }

run_step() {
    local step_name="$1"
    local description="$2"
    shift 2

    if step_done "$step_name"; then
        log_skip "$description"
        return 0
    fi

    log "Starting: $description"
    if "$@"; then
        mark_done "$step_name"
        log_success "$description"
        return 0
    else
        log_error "$description (exit code: $?)"
        FAILED_STEPS="$FAILED_STEPS $step_name"
        return 1
    fi
}

# =============================================================================
# Bitwarden Secrets Manager Functions
# =============================================================================

# Get a secret value by name (key)
# Usage: bws_get "secret-name"
bws_get() {
    local secret_name="$1"

    if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
        log_error "BWS_ACCESS_TOKEN not set"
        return 1
    fi

    # List all secrets and find by key name, then get the value
    local secret_id
    secret_id=$(bws secret list 2>/dev/null | jq -r --arg name "$secret_name" '.[] | select(.key == $name) | .id' 2>/dev/null)

    if [[ -z "$secret_id" ]]; then
        return 1
    fi

    bws secret get "$secret_id" 2>/dev/null | jq -r '.value'
}

# Check if a secret exists by name
bws_exists() {
    local secret_name="$1"

    if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
        return 1
    fi

    bws secret list 2>/dev/null | jq -e --arg name "$secret_name" '.[] | select(.key == $name)' &>/dev/null
}

# =============================================================================
# Pre-flight Check
# =============================================================================

check_bws() {
    if ! command -v bws &>/dev/null; then
        log_error "Bitwarden Secrets Manager CLI (bws) not installed"
        log_error "Install: Download from https://github.com/bitwarden/sdk-sm/releases"
        return 1
    fi

    # Check for access token
    if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
        # Try to load from file
        local token_file="$HOME/.config/bws/access-token"
        if [[ -f "$token_file" ]]; then
            BWS_ACCESS_TOKEN=$(cat "$token_file")
            export BWS_ACCESS_TOKEN
        else
            log_error "BWS_ACCESS_TOKEN not set"
            log_error "Set environment variable or create: $token_file"
            return 1
        fi
    fi

    # Test access by listing secrets
    if ! bws secret list &>/dev/null; then
        log_error "Failed to access Bitwarden Secrets Manager"
        log_error "Check your access token is valid"
        return 1
    fi

    log_success "Bitwarden Secrets Manager connected"
    return 0
}

# =============================================================================
# Setup Steps
# =============================================================================

setup_luks() {
    if [[ ! -b "$DATA_DEV" ]]; then
        log "No data device at $DATA_DEV - skipping LUKS setup"
        return 0
    fi

    log "=== Setting up encrypted data volume ==="
    local LUKS_KEY
    LUKS_KEY=$(bws_get "luks-key") || { log_error "luks-key not found in Secrets Manager"; return 1; }

    if ! sudo cryptsetup isLuks "$DATA_DEV" 2>/dev/null; then
        log "Formatting $DATA_DEV with LUKS (first time setup)..."
        sudo wipefs -a "$DATA_DEV" 2>/dev/null || true
        echo -n "$LUKS_KEY" | sudo cryptsetup luksFormat --type luks2 -q "$DATA_DEV" -
        echo -n "$LUKS_KEY" | sudo cryptsetup open "$DATA_DEV" "$DATA_MAPPER" -
        sudo mkfs.ext4 -L data "/dev/mapper/$DATA_MAPPER"
        sudo mkdir -p "$DATA_MOUNT"
        sudo mount "/dev/mapper/$DATA_MAPPER" "$DATA_MOUNT"
        sudo mkdir -p "$DATA_MOUNT/home"
        sudo cp -a /home/ubuntu/. "$DATA_MOUNT/home/" 2>/dev/null || true
        sudo chown -R ubuntu:ubuntu "$DATA_MOUNT/home"
        log "Data volume initialized"
    else
        if [[ ! -e "/dev/mapper/$DATA_MAPPER" ]]; then
            log "Unlocking LUKS volume..."
            echo -n "$LUKS_KEY" | sudo cryptsetup open "$DATA_DEV" "$DATA_MAPPER" -
        fi
        sudo mkdir -p "$DATA_MOUNT"
        if ! sudo blkid "/dev/mapper/$DATA_MAPPER" &>/dev/null; then
            log "Creating filesystem on LUKS volume..."
            sudo mkfs.ext4 -L data "/dev/mapper/$DATA_MAPPER"
        fi
        if ! mountpoint -q "$DATA_MOUNT"; then
            sudo mount "/dev/mapper/$DATA_MAPPER" "$DATA_MOUNT"
        fi
        log "Data volume unlocked and mounted"
    fi

    if [[ -d "$DATA_MOUNT/home" ]] && ! mountpoint -q /home/ubuntu; then
        sudo mount --bind "$DATA_MOUNT/home" /home/ubuntu
        log "Home directory mounted from encrypted volume"
    fi
}

setup_ssh_keys() {
    log "=== Setting up SSH keys ==="
    mkdir -p ~/.ssh && chmod 700 ~/.ssh

    # Home key
    if [[ ! -f ~/.ssh/id_ed25519_home ]]; then
        if bws_exists "github-ssh-home"; then
            bws_get "github-ssh-home" > ~/.ssh/id_ed25519_home
            chmod 600 ~/.ssh/id_ed25519_home
            log "Home SSH key installed"
        else
            log "github-ssh-home not found (optional)"
        fi
    else
        log "Home SSH key already exists"
    fi

    # Work key
    if [[ ! -f ~/.ssh/id_ed25519_work ]]; then
        if bws_exists "github-ssh-work"; then
            bws_get "github-ssh-work" > ~/.ssh/id_ed25519_work
            chmod 600 ~/.ssh/id_ed25519_work
            log "Work SSH key installed"
        else
            log "github-ssh-work not found (optional)"
        fi
    else
        log "Work SSH key already exists"
    fi

    # SSH config
    if [[ ! -f ~/.ssh/config ]]; then
        cat > ~/.ssh/config <<'SSHCFG'
Host github.com-home
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_home
    IdentitiesOnly yes
Host github.com-work
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_work
    IdentitiesOnly yes
SSHCFG
        chmod 600 ~/.ssh/config
        log "SSH config created"
    fi

    # Known hosts
    grep -q "github.com" ~/.ssh/known_hosts 2>/dev/null || ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null
}

setup_github_cli() {
    log "=== Setting up GitHub CLI ==="
    if gh auth status &>/dev/null; then
        log "GitHub CLI already authenticated"
        return 0
    fi

    if bws_exists "github-token"; then
        bws_get "github-token" | gh auth login --with-token
        gh config set git_protocol ssh
        log "GitHub CLI authenticated"
    else
        log "github-token not found (optional)"
    fi
}

setup_git_identity() {
    log "=== Setting up git identity ==="
    mkdir -p ~/.config/git

    # Get home identity
    local GIT_NAME_HOME GIT_EMAIL_HOME
    GIT_NAME_HOME=$(bws_get "github-home-name" 2>/dev/null) || { log_error "github-home-name not found"; return 1; }
    GIT_EMAIL_HOME=$(bws_get "github-home-email" 2>/dev/null) || { log_error "github-home-email not found"; return 1; }

    # Get work identity (optional)
    local GIT_NAME_WORK GIT_EMAIL_WORK
    GIT_NAME_WORK=$(bws_get "github-work-name" 2>/dev/null) || true
    GIT_EMAIL_WORK=$(bws_get "github-work-email" 2>/dev/null) || true

    # Home config
    if [[ ! -f ~/.config/git/config-home ]]; then
        cat > ~/.config/git/config-home <<GH
[user]
    name = $GIT_NAME_HOME
    email = $GIT_EMAIL_HOME
[url "git@github.com-home:"]
    insteadOf = git@github.com:
GH
        log "Git config-home created"
    fi

    # Work config
    if [[ ! -f ~/.config/git/config-work ]] && [[ -n "$GIT_NAME_WORK" ]]; then
        cat > ~/.config/git/config-work <<GW
[user]
    name = $GIT_NAME_WORK
    email = $GIT_EMAIL_WORK
[url "git@github.com-work:"]
    insteadOf = git@github.com:
GW
        log "Git config-work created"
    fi

    # Include configs
    if ! grep -q "claude-sessions/home" ~/.gitconfig 2>/dev/null; then
        cat >> ~/.gitconfig <<'GINC'
[includeIf "gitdir:~/claude-sessions/home/"]
    path = ~/.config/git/config-home
[includeIf "gitdir:~/claude-sessions/work/"]
    path = ~/.config/git/config-work
[includeIf "gitdir:~/code/"]
    path = ~/.config/git/config-home
GINC
        log "Git includeIf rules added"
    fi
}

setup_aws_config() {
    log "=== Setting up AWS config ==="
    mkdir -p ~/.aws

    if [[ -f ~/.aws/config ]]; then
        log "AWS config already exists"
        return 0
    fi

    # Check for SSO config secrets
    local AWS_ACCOUNT_ID AWS_SSO_START_URL AWS_SSO_REGION AWS_ROLE_NAME
    AWS_ACCOUNT_ID=$(bws_get "aws-account-id" 2>/dev/null) || { log "aws-account-id not found (optional)"; return 0; }
    AWS_SSO_START_URL=$(bws_get "aws-sso-start-url" 2>/dev/null) || { log "aws-sso-start-url not found (optional)"; return 0; }
    AWS_SSO_REGION=$(bws_get "aws-sso-region" 2>/dev/null) || AWS_SSO_REGION="us-east-1"
    AWS_ROLE_NAME=$(bws_get "aws-role-name" 2>/dev/null) || AWS_ROLE_NAME="AdministratorAccess"

    cat > ~/.aws/config <<AWSCFG
[default]
region = us-east-1
[profile home]
sso_session = home-sso
sso_account_id = $AWS_ACCOUNT_ID
sso_role_name = $AWS_ROLE_NAME
region = us-east-1
[sso-session home-sso]
sso_start_url = $AWS_SSO_START_URL
sso_region = $AWS_SSO_REGION
sso_registration_scopes = sso:account:access
AWSCFG
    log "AWS config created"
}

setup_claude_sessions() {
    log "=== Setting up claude-sessions ==="
    mkdir -p ~/claude-sessions/home ~/claude-sessions/work

    if [[ -d ~/.config/claude-sessions ]]; then
        log "claude-sessions config already exists"
        return 0
    fi

    # Get repo name
    local CLAUDE_SESSIONS_REPO
    CLAUDE_SESSIONS_REPO=$(bws_get "claude-sessions-repo" 2>/dev/null) || { log "claude-sessions-repo not found (optional)"; return 0; }

    if [[ ! -f ~/.ssh/id_ed25519_home ]]; then
        log "SSH key not available for cloning"
        return 0
    fi

    git clone "git@github.com-home:${CLAUDE_SESSIONS_REPO}.git" ~/.config/claude-sessions 2>/dev/null || { log "Failed to clone claude-sessions"; return 0; }

    # Unlock with git-crypt if key available
    if bws_exists "git-crypt-key"; then
        cd ~/.config/claude-sessions || return 0
        bws_get "git-crypt-key" | base64 -d > /tmp/gc-key
        git-crypt unlock /tmp/gc-key 2>/dev/null && log "claude-sessions unlocked" || log "git-crypt unlock failed"
        rm -f /tmp/gc-key
        cd - >/dev/null || true
    fi
}

setup_lifemaestro() {
    log "=== Setting up LifeMaestro ==="

    if [[ -d ~/code/lifemaestro ]]; then
        log "LifeMaestro already installed"
        return 0
    fi

    # Get repo name
    local LIFEMAESTRO_REPO
    LIFEMAESTRO_REPO=$(bws_get "lifemaestro-repo" 2>/dev/null) || { log "lifemaestro-repo not found (optional)"; return 0; }

    if [[ ! -f ~/.ssh/id_ed25519_home ]]; then
        log "SSH key not available for cloning"
        return 0
    fi

    mkdir -p ~/code
    git clone "git@github.com-home:${LIFEMAESTRO_REPO}.git" ~/code/lifemaestro || { log "Failed to clone lifemaestro"; return 0; }

    # Run install.sh
    if [[ -f ~/code/lifemaestro/install.sh ]]; then
        (cd ~/code/lifemaestro && ./install.sh)
        log "LifeMaestro install.sh completed"
    fi

    # Symlink .claude directory
    if [[ -d ~/code/lifemaestro/.claude ]]; then
        [[ -d ~/.claude && ! -L ~/.claude ]] && rm -rf ~/.claude
        ln -sfn ~/code/lifemaestro/.claude ~/.claude
        log "\$HOME/.claude symlinked to lifemaestro"
    fi
}

setup_baton() {
    log "=== Setting up Baton ==="

    if [[ -d ~/code/baton ]]; then
        log "Baton already installed"
        # Ensure service is running
        if ! systemctl --user is-active --quiet baton 2>/dev/null; then
            systemctl --user start baton 2>/dev/null || true
        fi
        return 0
    fi

    # Get repo name
    local BATON_REPO
    BATON_REPO=$(bws_get "baton-repo" 2>/dev/null) || { log "baton-repo not found (optional)"; return 0; }

    if [[ ! -f ~/.ssh/id_ed25519_home ]]; then
        log "SSH key not available for cloning"
        return 0
    fi

    mkdir -p ~/code
    git clone "git@github.com-home:${BATON_REPO}.git" ~/code/baton || { log "Failed to clone baton"; return 0; }

    # Install baton
    if [[ -f ~/code/baton/pyproject.toml ]]; then
        (cd ~/code/baton && pip install --user -e .)
        log "Baton installed"
    fi

    # Copy config
    mkdir -p ~/.config/lifemaestro
    if [[ ! -f ~/.config/lifemaestro/baton.toml ]] && [[ -f ~/code/baton/baton.example.toml ]]; then
        cp ~/code/baton/baton.example.toml ~/.config/lifemaestro/baton.toml
        log "Baton config copied"
    fi

    # Create systemd user service
    mkdir -p ~/.config/systemd/user
    cat > ~/.config/systemd/user/baton.service <<'BATONSERVICE'
[Unit]
Description=Baton AI Proxy Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/code/baton
ExecStart=%h/.local/bin/uvicorn baton.server:app --host 127.0.0.1 --port 4000
Restart=on-failure
RestartSec=5
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
BATONSERVICE

    # Enable and start service
    systemctl --user daemon-reload
    systemctl --user enable baton
    systemctl --user start baton
    log "Baton service started"

    # Wait for startup
    sleep 2
    if curl -sf http://127.0.0.1:4000/healthz &>/dev/null; then
        log_success "Baton responding at http://127.0.0.1:4000"
    else
        log "Baton may still be starting..."
    fi
}

setup_himalaya() {
    log "=== Setting up Himalaya (email) ==="
    mkdir -p ~/.config/himalaya

    if [[ -f ~/.config/himalaya/config.toml ]]; then
        log "Himalaya config already exists"
        return 0
    fi

    if ! bws_exists "gmail-client-id"; then
        log "gmail-client-id not in Secrets Manager (optional)"
        return 0
    fi

    local GMAIL_EMAIL GMAIL_CLIENT_ID GMAIL_CLIENT_SECRET
    GMAIL_EMAIL=$(bws_get "gmail-email" 2>/dev/null) || { log "gmail-email not found"; return 0; }
    GMAIL_CLIENT_ID=$(bws_get "gmail-client-id" 2>/dev/null) || return 0
    GMAIL_CLIENT_SECRET=$(bws_get "gmail-client-secret" 2>/dev/null) || return 0

    if [[ -z "$GMAIL_EMAIL" || -z "$GMAIL_CLIENT_ID" || -z "$GMAIL_CLIENT_SECRET" ]]; then
        log "Gmail OAuth credentials incomplete"
        return 0
    fi

    cat > ~/.config/himalaya/config.toml <<HIMALAYA
[accounts.gmail]
default = true
email = "$GMAIL_EMAIL"

backend.type = "imap"
backend.host = "imap.gmail.com"
backend.port = 993
backend.encryption = "tls"
backend.login = "$GMAIL_EMAIL"
backend.auth.type = "oauth2"
backend.auth.client-id = "$GMAIL_CLIENT_ID"
backend.auth.client-secret = "$GMAIL_CLIENT_SECRET"
backend.auth.method = "redirect"
backend.auth.auth-url = "https://accounts.google.com/o/oauth2/auth"
backend.auth.token-url = "https://oauth2.googleapis.com/token"
backend.auth.scopes = ["https://mail.google.com/"]

sender.type = "smtp"
sender.host = "smtp.gmail.com"
sender.port = 465
sender.encryption = "tls"
sender.login = "$GMAIL_EMAIL"
sender.auth.type = "oauth2"
sender.auth.client-id = "$GMAIL_CLIENT_ID"
sender.auth.client-secret = "$GMAIL_CLIENT_SECRET"
sender.auth.method = "redirect"
sender.auth.auth-url = "https://accounts.google.com/o/oauth2/auth"
sender.auth.token-url = "https://oauth2.googleapis.com/token"
sender.auth.scopes = ["https://mail.google.com/"]
HIMALAYA
    log "Himalaya configured. Run: himalaya account configure gmail"
}

setup_gcalcli() {
    log "=== Setting up gcalcli (Google Calendar) ==="

    if [[ -f ~/.gcalcli_oauth ]]; then
        log "gcalcli config already exists"
        return 0
    fi

    if ! bws_exists "gmail-client-id"; then
        log "gmail-client-id not in Secrets Manager (optional)"
        return 0
    fi

    local GMAIL_CLIENT_ID GMAIL_CLIENT_SECRET
    GMAIL_CLIENT_ID=$(bws_get "gmail-client-id" 2>/dev/null) || return 0
    GMAIL_CLIENT_SECRET=$(bws_get "gmail-client-secret" 2>/dev/null) || return 0

    if [[ -z "$GMAIL_CLIENT_ID" || -z "$GMAIL_CLIENT_SECRET" ]]; then
        return 0
    fi

    cat > ~/.gcalcli_oauth <<GCALCLI
{
  "client_id": "$GMAIL_CLIENT_ID",
  "client_secret": "$GMAIL_CLIENT_SECRET"
}
GCALCLI
    chmod 600 ~/.gcalcli_oauth
    log "gcalcli configured. Run: gcalcli init"
}

setup_ms365() {
    log "=== Setting up MS365 (email + calendar) ==="

    if ! bws_exists "ms365-client-id"; then
        log "ms365-client-id not in Secrets Manager (optional)"
        return 0
    fi

    local MS365_EMAIL MS365_CLIENT_ID MS365_CLIENT_SECRET MS365_TENANT_ID
    MS365_EMAIL=$(bws_get "ms365-email" 2>/dev/null) || { log "ms365-email not found"; return 0; }
    MS365_CLIENT_ID=$(bws_get "ms365-client-id" 2>/dev/null) || return 0
    MS365_CLIENT_SECRET=$(bws_get "ms365-client-secret" 2>/dev/null) || ""
    MS365_TENANT_ID=$(bws_get "ms365-tenant-id" 2>/dev/null) || return 0

    if [[ -z "$MS365_EMAIL" || -z "$MS365_CLIENT_ID" || -z "$MS365_TENANT_ID" ]]; then
        log "MS365 OAuth credentials incomplete"
        return 0
    fi

    # Add MS365 to Himalaya if not present
    if [[ -f ~/.config/himalaya/config.toml ]] && ! grep -q "accounts.ms365" ~/.config/himalaya/config.toml; then
        cat >> ~/.config/himalaya/config.toml <<HIMALAYA_MS365

[accounts.ms365]
default = false
email = "$MS365_EMAIL"

backend.type = "imap"
backend.host = "outlook.office365.com"
backend.port = 993
backend.encryption = "tls"
backend.login = "$MS365_EMAIL"
backend.auth.type = "oauth2"
backend.auth.client-id = "$MS365_CLIENT_ID"
backend.auth.client-secret = "$MS365_CLIENT_SECRET"
backend.auth.method = "redirect"
backend.auth.auth-url = "https://login.microsoftonline.com/$MS365_TENANT_ID/oauth2/v2.0/authorize"
backend.auth.token-url = "https://login.microsoftonline.com/$MS365_TENANT_ID/oauth2/v2.0/token"
backend.auth.scopes = ["https://outlook.office365.com/IMAP.AccessAsUser.All", "https://outlook.office365.com/SMTP.Send", "offline_access"]

sender.type = "smtp"
sender.host = "smtp.office365.com"
sender.port = 587
sender.encryption = "starttls"
sender.login = "$MS365_EMAIL"
sender.auth.type = "oauth2"
sender.auth.client-id = "$MS365_CLIENT_ID"
sender.auth.client-secret = "$MS365_CLIENT_SECRET"
sender.auth.method = "redirect"
sender.auth.auth-url = "https://login.microsoftonline.com/$MS365_TENANT_ID/oauth2/v2.0/authorize"
sender.auth.token-url = "https://login.microsoftonline.com/$MS365_TENANT_ID/oauth2/v2.0/token"
sender.auth.scopes = ["https://outlook.office365.com/IMAP.AccessAsUser.All", "https://outlook.office365.com/SMTP.Send", "offline_access"]
HIMALAYA_MS365
        log "Himalaya MS365 configured. Run: himalaya account configure ms365"
    fi

    # Thallo config
    mkdir -p ~/.config/thallo
    if [[ ! -f ~/.config/thallo/config.toml ]]; then
        cat > ~/.config/thallo/config.toml <<THALLO
[azure]
client_id = "$MS365_CLIENT_ID"
tenant_id = "$MS365_TENANT_ID"

[calendar]
default = "Calendar"
THALLO
        log "thallo configured. Run: thallo authorize"
    fi
}

# =============================================================================
# Main Execution
# =============================================================================

log "=== Devbox Init ==="
touch "$CHECKPOINT_FILE"

# Pre-flight check (must pass)
if ! check_bws; then
    exit 1
fi

# Run all steps - failures don't stop execution
run_step "luks" "LUKS encryption" setup_luks
run_step "ssh_keys" "SSH keys" setup_ssh_keys
run_step "github_cli" "GitHub CLI auth" setup_github_cli
run_step "git_identity" "Git identity" setup_git_identity
run_step "aws_config" "AWS config" setup_aws_config
run_step "claude_sessions" "Claude sessions" setup_claude_sessions
run_step "lifemaestro" "LifeMaestro" setup_lifemaestro
run_step "baton" "Baton proxy" setup_baton
run_step "himalaya" "Himalaya email" setup_himalaya
run_step "gcalcli" "gcalcli calendar" setup_gcalcli
run_step "ms365" "MS365 email/calendar" setup_ms365

# Summary
log "=== Devbox Init Complete ==="
if [[ -n "$FAILED_STEPS" ]]; then
    log_error "Failed steps:$FAILED_STEPS"
    log "Re-run: ~/bin/devbox-init"
else
    log_success "All steps completed successfully"
fi

log ""
log "Next steps:"
log "  aws sso login --profile home"
[[ -f ~/.config/himalaya/config.toml ]] && log "  himalaya account configure gmail"
[[ -f ~/.gcalcli_oauth ]] && log "  gcalcli init"
