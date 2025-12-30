#!/bin/bash
# Devbox user-data script with robust error handling
# Does NOT use set -e - handles errors explicitly per step

# Log output for debugging
exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

CHECKPOINT_FILE="/var/log/user-data-progress"
FAILED_STEPS=""

# =============================================================================
# Helper Functions
# =============================================================================

log() { echo "[$(date '+%H:%M:%S')] $*"; }
log_success() { log "✓ $*"; }
log_error() { log "✗ $*"; }
log_skip() { log "○ $* (skipped - already done)"; }

# Check if a step was already completed
step_done() {
    grep -q "^$1$" "$CHECKPOINT_FILE" 2>/dev/null
}

# Mark a step as completed
mark_done() {
    echo "$1" >> "$CHECKPOINT_FILE"
}

# Run a step with error handling
# Usage: run_step "step_name" "description" command args...
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
# Setup Steps (each is a function that can fail independently)
# =============================================================================

setup_architecture() {
    # Architecture detection (from Terraform variable)
    ARCH="${architecture}"
    log "Architecture: $ARCH"

    if [ "$ARCH" = "arm64" ]; then
        export AWS_ARCH="aarch64"
        export LAZYGIT_ARCH="arm64"
        export LAZYDOCKER_ARCH="arm64"
    else
        export AWS_ARCH="x86_64"
        export LAZYGIT_ARCH="x86_64"
        export LAZYDOCKER_ARCH="x86_64"
    fi
    return 0
}

setup_system_packages() {
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
    apt-get install -y \
        zsh git git-crypt curl wget unzip jq htop tmux ripgrep fd-find bat ncdu \
        software-properties-common build-essential ca-certificates gnupg lsb-release \
        fzf direnv cryptsetup eza
}

setup_docker() {
    if command -v docker &>/dev/null; then
        log "Docker already installed"
        return 0
    fi
    curl -fsSL https://get.docker.com | sh
    usermod -aG docker ubuntu
    apt-get install -y docker-compose-plugin
}

setup_tailscale() {
    if command -v tailscale &>/dev/null; then
        log "Tailscale already installed"
    else
        curl -fsSL https://tailscale.com/install.sh | sh
    fi

    # Remove old devbox devices from tailnet before registering
    log "Cleaning up old Tailscale devices matching '${tailscale_hostname}'..."
    OLD_DEVICES=$(curl -s -u "${tailscale_api_key}:" \
        "https://api.tailscale.com/api/v2/tailnet/-/devices" \
        | jq -r '.devices[] | select(.hostname | startswith("${tailscale_hostname}")) | .id' 2>/dev/null || true)

    for DEVICE_ID in $OLD_DEVICES; do
        log "Deleting device: $DEVICE_ID"
        curl -s -X DELETE -u "${tailscale_api_key}:" \
            "https://api.tailscale.com/api/v2/device/$DEVICE_ID" || true
    done

    tailscale up --auth-key=${tailscale_auth_key} --hostname=${tailscale_hostname} --ssh
}

setup_aws_cli() {
    if command -v aws &>/dev/null; then
        log "AWS CLI already installed"
        return 0
    fi
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$${AWS_ARCH}.zip" -o /tmp/awscliv2.zip
    unzip -q /tmp/awscliv2.zip -d /tmp
    /tmp/aws/install
    rm -rf /tmp/aws /tmp/awscliv2.zip
}

setup_github_cli() {
    if command -v gh &>/dev/null; then
        log "GitHub CLI already installed"
        return 0
    fi
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list
    apt-get update
    apt-get install -y gh
}

setup_nodejs() {
    if command -v node &>/dev/null; then
        log "Node.js already installed"
        return 0
    fi
    curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
    apt-get install -y nodejs
}

setup_python() {
    apt-get install -y python3-pip python3-venv python3-full
    pip3 install --break-system-packages gcalcli || log "gcalcli install failed (non-fatal)"
}

setup_npm_packages() {
    # Essential CLI tools - LifeMaestro's install.sh will handle bw and claude
    npm install -g tldr @pnp/cli-microsoft365 || log "Some npm packages failed (non-fatal)"
}

setup_modern_cli_tools() {
    # lazygit
    if ! command -v lazygit &>/dev/null; then
        LAZYGIT_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazygit/releases/latest" | jq -r '.tag_name' | sed 's/v//')
        curl -fsSL "https://github.com/jesseduffield/lazygit/releases/download/v$${LAZYGIT_VERSION}/lazygit_$${LAZYGIT_VERSION}_Linux_$${LAZYGIT_ARCH}.tar.gz" | tar xz -C /usr/local/bin
        log "lazygit installed"
    fi

    # lazydocker
    if ! command -v lazydocker &>/dev/null; then
        LAZYDOCKER_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazydocker/releases/latest" | jq -r '.tag_name' | sed 's/v//')
        curl -fsSL "https://github.com/jesseduffield/lazydocker/releases/download/v$${LAZYDOCKER_VERSION}/lazydocker_$${LAZYDOCKER_VERSION}_Linux_$${LAZYDOCKER_ARCH}.tar.gz" | tar xz -C /usr/local/bin
        log "lazydocker installed"
    fi

    # zoxide
    if ! command -v zoxide &>/dev/null; then
        curl -sSfL https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | sh
        mv /root/.local/bin/zoxide /usr/local/bin/ 2>/dev/null || true
        log "zoxide installed"
    fi

    # mise
    if ! command -v mise &>/dev/null; then
        curl https://mise.run | sh
        mv /root/.local/bin/mise /usr/local/bin/ 2>/dev/null || true
        log "mise installed"
    fi

    return 0
}

setup_cloud_clis() {
    # Azure CLI
    if ! command -v az &>/dev/null; then
        curl -sL https://aka.ms/InstallAzureCLIDeb | bash || log "Azure CLI install failed (non-fatal)"
    fi

    # Google Cloud CLI
    if ! command -v gcloud &>/dev/null; then
        curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
        echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee /etc/apt/sources.list.d/google-cloud-sdk.list
        apt-get update
        apt-get install -y google-cloud-cli || log "GCloud CLI install failed (non-fatal)"
    fi

    return 0
}

setup_system_config() {
    hostnamectl set-hostname ${hostname}
    timedatectl set-timezone ${timezone}

    if ! grep -q "fs.inotify.max_user_watches" /etc/sysctl.conf; then
        echo "fs.inotify.max_user_watches=524288" >> /etc/sysctl.conf
        sysctl -p
    fi
}

setup_git_delta() {
    cat > /etc/gitconfig <<'GITCFG'
[core]
    pager = delta
[delta]
    navigate = true
    side-by-side = true
    line-numbers = true
GITCFG
}

setup_spot_watcher() {
    cat > /usr/local/bin/spot-watcher <<'SPOTWATCHER'
#!/bin/bash
TOKEN_URL="http://169.254.169.254/latest/api/token"
METADATA_URL="http://169.254.169.254/latest/meta-data/spot/instance-action"
NOTIFIED=false
while true; do
    TOKEN=$(curl -s -X PUT "$TOKEN_URL" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null)
    RESP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" -w "%%{http_code}" -o /tmp/spot-action "$METADATA_URL" 2>/dev/null)
    if [ "$RESP" = "200" ] && [ "$NOTIFIED" = "false" ]; then
        wall "SPOT INTERRUPTION - Hibernating in ~2 min"
        NOTIFIED=true
    fi
    sleep 5
done
SPOTWATCHER
    chmod +x /usr/local/bin/spot-watcher

    cat > /etc/systemd/system/spot-watcher.service <<'SPOTSERVICE'
[Unit]
Description=Spot interruption watcher
After=network.target
[Service]
Type=simple
ExecStart=/usr/local/bin/spot-watcher
Restart=always
[Install]
WantedBy=multi-user.target
SPOTSERVICE
    systemctl daemon-reload
    systemctl enable --now spot-watcher
}

setup_bootstrap_scripts() {
    SCRIPTS_BASE="https://raw.githubusercontent.com/${github_username}/aws-devbox/master/scripts"
    mkdir -p /home/ubuntu/bin

    curl -fsSL "$SCRIPTS_BASE/bw-unlock.sh" -o /home/ubuntu/bin/bw-unlock || log "Failed to download bw-unlock"
    curl -fsSL "$SCRIPTS_BASE/devbox-init.sh" -o /home/ubuntu/bin/devbox-init || log "Failed to download devbox-init"
    curl -fsSL "$SCRIPTS_BASE/devbox-check.sh" -o /home/ubuntu/bin/devbox-check || log "Failed to download devbox-check"
    curl -fsSL "$SCRIPTS_BASE/devbox-restore.sh" -o /home/ubuntu/bin/devbox-restore || log "Failed to download devbox-restore"

    chmod +x /home/ubuntu/bin/bw-unlock /home/ubuntu/bin/devbox-init /home/ubuntu/bin/devbox-check /home/ubuntu/bin/devbox-restore 2>/dev/null || true
    chown -R ubuntu:ubuntu /home/ubuntu/bin
}

setup_user_environment() {
    sudo -u ubuntu bash <<'USERSETUP'
# Oh My Zsh
if [[ ! -d ~/.oh-my-zsh ]]; then
    sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
fi

# Set default shell to zsh
sudo chsh -s $(which zsh) ubuntu 2>/dev/null || true

# Create directories
mkdir -p ~/code ~/projects ~/.local/bin ~/.claude ~/.claude/rules

# Add to zshrc if not already present
if ! grep -q "DEVBOX_SETUP" ~/.zshrc 2>/dev/null; then
    cat >> ~/.zshrc <<'ZSHRC'
# DEVBOX_SETUP
command -v mise &>/dev/null && eval "$(mise activate zsh)"
command -v zoxide &>/dev/null && eval "$(zoxide init zsh)"
command -v direnv &>/dev/null && eval "$(direnv hook zsh)"
export PATH="$HOME/bin:$HOME/.local/bin:$PATH"
alias ls='eza' ll='eza -la' lg='lazygit' ld='lazydocker'
alias unlock='source ~/bin/bw-unlock' init='~/bin/devbox-init' check='~/bin/devbox-check'
alias restore='~/bin/devbox-restore' status='~/bin/devbox-restore status'

# Track last working directory for restore
DEVBOX_LAST_DIR="$HOME/.cache/devbox/last-working-dir"
mkdir -p "$(dirname "$DEVBOX_LAST_DIR")"
chpwd() { echo "$PWD" > "$DEVBOX_LAST_DIR" }

# Auto-restore on SSH login (tmux attach/create)
if [[ -z "${TMUX:-}" && -n "${SSH_CONNECTION:-}" && -z "${DEVBOX_NO_RESTORE:-}" ]]; then
    ~/bin/devbox-restore
fi
ZSHRC
fi

# Add to bashrc if not already present
if ! grep -q "DEVBOX_SETUP" ~/.bashrc 2>/dev/null; then
    cat >> ~/.bashrc <<'BASHRC'
# DEVBOX_SETUP
command -v zoxide &>/dev/null && eval "$(zoxide init bash)"
command -v direnv &>/dev/null && eval "$(direnv hook bash)"
export PATH="$HOME/bin:$HOME/.local/bin:$PATH"
alias ls='eza' ll='eza -la' lg='lazygit' ld='lazydocker'
alias unlock='source ~/bin/bw-unlock' init='~/bin/devbox-init' check='~/bin/devbox-check'
BASHRC
fi

# Claude settings
cat > ~/.claude/settings.json <<'CLAUDE'
{"permissions":{"allow":["Bash(git *)","Bash(gh *)","Bash(aws *)","Bash(npm *)","Bash(docker *)","Bash(terraform *)","Bash(bw *)","Read","Write","Edit","Glob","Grep","Task","WebFetch","TodoRead","TodoWrite"],"deny":[]}}
CLAUDE

# Claude rules
cat > ~/.claude/rules/save-progress.md <<'SAVEMD'
# Save Progress Frequently

This devbox does NOT hibernate - stopping loses all running state.
However, auto-restore recovers: tmux sessions, last directory, and Docker projects.

## What Auto-Restores
- tmux session (auto-attaches on SSH login)
- Last working directory
- Docker projects (listed in ~/.config/devbox/docker-projects.txt)

## What Does NOT Restore
- Running processes (except Docker containers)
- Uncommitted git changes (these persist on disk)
- Open editor buffers (use VS Code Remote or save frequently)

## Rules
- Commit work frequently (at least every significant milestone)
- Push to remote before ending sessions
- Use descriptive commit messages
- Never leave uncommitted work when stepping away

## Commands
- `status` - Show devbox status (Bitwarden, Docker, /home)
- `restore` - Manually trigger restore
- `DEVBOX_NO_RESTORE=1 zsh` - Skip auto-restore

## Before Stopping
If the user says they're done or stepping away:
1. Check for uncommitted changes: `git status`
2. Offer to commit and push
3. Remind about unsaved work in other repos
SAVEMD
USERSETUP
}

setup_motd() {
    cat > /etc/motd <<'MOTD'
================================================================================
                            WELCOME TO DEVBOX
================================================================================
  First time:  unlock && init
  Health check: check

  Commands:
    unlock  - Authenticate with Bitwarden
    init    - Set up LUKS, SSH keys, configs
    check   - Verify all dependencies
================================================================================
MOTD
}

# =============================================================================
# Main Execution
# =============================================================================

log "=== Starting devbox setup ==="
touch "$CHECKPOINT_FILE"

# Architecture must run first (sets env vars)
setup_architecture

# Run all steps - failures don't stop execution
run_step "system_packages" "System packages" setup_system_packages
run_step "docker" "Docker" setup_docker
run_step "tailscale" "Tailscale" setup_tailscale
run_step "aws_cli" "AWS CLI" setup_aws_cli
run_step "github_cli" "GitHub CLI" setup_github_cli
run_step "nodejs" "Node.js" setup_nodejs
run_step "python" "Python" setup_python
run_step "npm_packages" "NPM packages" setup_npm_packages
run_step "modern_cli_tools" "Modern CLI tools" setup_modern_cli_tools
run_step "cloud_clis" "Cloud CLIs" setup_cloud_clis
run_step "system_config" "System config" setup_system_config
run_step "git_delta" "Git delta config" setup_git_delta
run_step "spot_watcher" "Spot watcher" setup_spot_watcher
run_step "bootstrap_scripts" "Bootstrap scripts" setup_bootstrap_scripts
run_step "user_environment" "User environment" setup_user_environment
run_step "motd" "MOTD" setup_motd

# Summary
log "=== Devbox setup complete ==="
if [[ -n "$FAILED_STEPS" ]]; then
    log_error "Failed steps:$FAILED_STEPS"
    log "Review /var/log/user-data.log for details"
    log "Re-run failed steps manually or reboot to retry"
else
    log_success "All steps completed successfully"
fi

# Show checkpoint status
log "Checkpoint file: $CHECKPOINT_FILE"
cat "$CHECKPOINT_FILE"
