#!/bin/bash
# DevBox bootstrap script - Nix + home-manager edition
# System-level setup only; user packages managed by home-manager
#
# Terraform template variables:
# shellcheck disable=SC2154

exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

CHECKPOINT_FILE="/var/log/user-data-progress"
FAILED_STEPS=""

# =============================================================================
# Helper Functions
# =============================================================================

log() { echo "[$(date '+%H:%M:%S')] $*"; }
log_success() { log "✓ $*"; }
log_error() { log "✗ $*"; }
log_skip() { log "○ $* (skipped)"; }

step_done() { grep -q "^$1$" "$CHECKPOINT_FILE" 2>/dev/null; }
mark_done() { echo "$1" >> "$CHECKPOINT_FILE"; }

run_step() {
    local step_name="$1" description="$2"
    shift 2
    if step_done "$step_name"; then
        log_skip "$description"
        return 0
    fi
    log "Starting: $description"
    if "$@"; then
        mark_done "$step_name"
        log_success "$description"
    else
        log_error "$description (exit code: $?)"
        FAILED_STEPS="$FAILED_STEPS $step_name"
        return 1
    fi
}

# =============================================================================
# System Setup (root-level, can't be in home-manager)
# =============================================================================

setup_system() {
    hostnamectl set-hostname "${hostname}"
    timedatectl set-timezone "${timezone}"

    # Remove SSM agent - we use Tailscale SSH only
    snap remove amazon-ssm-agent 2>/dev/null || true
    systemctl stop snap.amazon-ssm-agent.amazon-ssm-agent.service 2>/dev/null || true
    systemctl disable snap.amazon-ssm-agent.amazon-ssm-agent.service 2>/dev/null || true

    # Increase inotify watches for file watchers
    echo "fs.inotify.max_user_watches=524288" >> /etc/sysctl.conf
    sysctl -p

    # Minimal system packages (just what's needed for Nix bootstrap)
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
        curl git cryptsetup ca-certificates gnupg

    # Auto-updates for security
    apt-get install -y unattended-upgrades apt-listchanges
    cat > /etc/apt/apt.conf.d/50unattended-upgrades <<'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
EOF
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
    if ! command -v tailscale &>/dev/null; then
        curl -fsSL https://tailscale.com/install.sh | sh
    fi

    # Clean up old devices
    log "Cleaning up old Tailscale devices..."
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

setup_data_volume() {
    # Self-attach the data EBS volume (required for EC2 Fleet where instance IDs change)
    # Find volume by tag and attach it to this instance

    local VOLUME_TAG="${data_volume_tag}"
    local DEVICE_NAME="/dev/sdf"
    local REGION
    local INSTANCE_ID
    REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)
    INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)

    # Check if already attached
    if [ -e /dev/nvme1n1 ] || [ -e /dev/xvdf ]; then
        log "Data volume already attached"
        return 0
    fi

    # Install AWS CLI if not present (needed for volume attachment)
    if ! command -v aws &>/dev/null; then
        apt-get install -y awscli
    fi

    # Find the volume by tag
    local VOLUME_ID
    VOLUME_ID=$(aws ec2 describe-volumes \
        --region "$REGION" \
        --filters "Name=tag:Name,Values=$VOLUME_TAG" "Name=status,Values=available" \
        --query "Volumes[0].VolumeId" \
        --output text 2>/dev/null)

    if [ -z "$VOLUME_ID" ] || [ "$VOLUME_ID" = "None" ]; then
        log "No available data volume found with tag: $VOLUME_TAG"
        log "Volume may already be attached or doesn't exist"
        return 0
    fi

    log "Attaching volume $VOLUME_ID to instance $INSTANCE_ID"
    aws ec2 attach-volume \
        --region "$REGION" \
        --volume-id "$VOLUME_ID" \
        --instance-id "$INSTANCE_ID" \
        --device "$DEVICE_NAME"

    # Wait for attachment
    local MAX_WAIT=60
    local WAITED=0
    while [ ! -e /dev/nvme1n1 ] && [ ! -e /dev/xvdf ] && [ $WAITED -lt $MAX_WAIT ]; do
        sleep 2
        WAITED=$((WAITED + 2))
        log "Waiting for volume to attach... ($WAITED/$MAX_WAIT)"
    done

    if [ -e /dev/nvme1n1 ] || [ -e /dev/xvdf ]; then
        log_success "Data volume attached successfully"
    else
        log_error "Volume attachment timed out"
        return 1
    fi
}

setup_spot_handler() {
    local SCRIPTS_BASE="https://raw.githubusercontent.com/dacapo-labs/host/master/scripts"

    # Download spot interruption handler
    curl -fsSL "$SCRIPTS_BASE/spot-interruption-handler.sh" -o /usr/local/bin/spot-interruption-handler || {
        log "Creating basic spot handler"
        cat > /usr/local/bin/spot-interruption-handler <<'HANDLER'
#!/bin/bash
while true; do
    if curl -s -m 2 http://169.254.169.254/latest/meta-data/spot/instance-action &>/dev/null; then
        wall "SPOT INTERRUPTION: Instance will be terminated soon!"
        sleep 120
    fi
    sleep 5
done
HANDLER
    }
    chmod +x /usr/local/bin/spot-interruption-handler

    cat > /etc/systemd/system/spot-interruption-handler.service <<'SERVICE'
[Unit]
Description=EC2 Spot Instance Interruption Handler
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/spot-interruption-handler
Restart=always
RestartSec=5
Environment="SNS_TOPIC_ARN=${sns_topic_arn}"

[Install]
WantedBy=multi-user.target
SERVICE

    systemctl daemon-reload
    systemctl enable --now spot-interruption-handler
}

# =============================================================================
# Nix Installation
# =============================================================================

setup_nix() {
    if [ -d /nix ]; then
        log "Nix already installed"
        return 0
    fi

    # Set HOME for nix installer (required when running as root)
    export HOME=/root

    # Install Nix in multi-user mode
    curl -L https://nixos.org/nix/install | sh -s -- --daemon --yes

    # Enable flakes
    mkdir -p /etc/nix
    cat > /etc/nix/nix.conf <<'NIXCONF'
experimental-features = nix-command flakes
NIXCONF

    # Restart nix-daemon to pick up config
    systemctl restart nix-daemon
}

setup_home_manager() {
    # Source nix profile
    . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh

    # Clone the host repo
    local REPO_DIR="/home/ubuntu/repos/github.com/dacapo-labs/host"
    if [ ! -d "$REPO_DIR" ]; then
        sudo -u ubuntu mkdir -p "$(dirname "$REPO_DIR")"
        sudo -u ubuntu git clone https://github.com/dacapo-labs/host.git "$REPO_DIR"
    fi

    # Ensure ubuntu owns cache directories (nix install may have created them as root)
    sudo -u ubuntu mkdir -p /home/ubuntu/.cache/nix /home/ubuntu/.local/share/nix
    chown -R ubuntu:ubuntu /home/ubuntu/.cache /home/ubuntu/.local

    # Determine architecture for flake target
    local HM_CONFIG="ubuntu"
    if [ "$(uname -m)" = "x86_64" ]; then
        HM_CONFIG="ubuntu-x86"
    fi

    # Run home-manager as ubuntu user (with output to log)
    log "Running home-manager switch for $HM_CONFIG..."
    cd "$REPO_DIR/nix" || return 1
    sudo -u ubuntu bash -c "
        . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
        cd $REPO_DIR/nix
        nix run home-manager -- switch --flake .#$HM_CONFIG 2>&1
    " || {
        log_error "home-manager switch failed, will need manual run"
        return 1
    }
}

# =============================================================================
# Bitwarden Secrets Manager CLI
# =============================================================================

setup_bws() {
    if command -v bws &>/dev/null; then
        log "bws CLI already installed"
        return 0
    fi

    local BWS_VERSION="1.0.0"
    local ARCH
    if [ "$(uname -m)" = "aarch64" ]; then
        ARCH="aarch64-unknown-linux-gnu"
    else
        ARCH="x86_64-unknown-linux-gnu"
    fi

    local BWS_URL="https://github.com/bitwarden/sdk/releases/download/bws-v$${BWS_VERSION}/bws-$${ARCH}-$${BWS_VERSION}.zip"

    log "Installing bws CLI v$${BWS_VERSION} for $${ARCH}..."
    cd /tmp || return 1
    curl -fsSL "$BWS_URL" -o bws.zip
    unzip -o bws.zip
    mv bws /usr/local/bin/
    chmod +x /usr/local/bin/bws
    rm -f bws.zip

    # Verify installation
    if bws --version &>/dev/null; then
        log_success "bws CLI installed: $(bws --version)"
    else
        log_error "bws CLI installation failed"
        return 1
    fi
}

# =============================================================================
# DevBox Scripts (outside of Nix - for LUKS/BWS operations)
# =============================================================================

setup_imladris_scripts() {
    # Scripts are in dacapo-labs/host repo (not user's personal repo)
    local SCRIPTS_BASE="https://raw.githubusercontent.com/dacapo-labs/host/master/scripts"

    mkdir -p /home/ubuntu/bin
    cd /home/ubuntu/bin || return 1

    # Download imladris management scripts
    curl -fsSL "$SCRIPTS_BASE/imladris-init.sh" -o imladris-init
    curl -fsSL "$SCRIPTS_BASE/imladris-check.sh" -o imladris-check
    curl -fsSL "$SCRIPTS_BASE/imladris-restore.sh" -o imladris-restore
    curl -fsSL "$SCRIPTS_BASE/bws-init.sh" -o bws-init
    curl -fsSL "$SCRIPTS_BASE/session-sync-setup.sh" -o session-sync-setup

    chmod +x imladris-init imladris-check imladris-restore bws-init session-sync-setup
    chown -R ubuntu:ubuntu /home/ubuntu/bin

    # Session sync systemd template
    curl -fsSL "$SCRIPTS_BASE/session-sync@.service" -o /etc/systemd/system/session-sync@.service
    systemctl daemon-reload
}

setup_shell() {
    # Set zsh as default shell for ubuntu (only if zsh exists)
    local zsh_path="/home/ubuntu/.nix-profile/bin/zsh"

    if [ -x "$zsh_path" ]; then
        # Add to /etc/shells if not present
        grep -qxF "$zsh_path" /etc/shells || echo "$zsh_path" >> /etc/shells
        chsh -s "$zsh_path" ubuntu
        log "Shell set to nix zsh: $zsh_path"
    elif command -v zsh &>/dev/null; then
        chsh -s "$(which zsh)" ubuntu
        log "Shell set to system zsh: $(which zsh)"
    else
        # Keep bash as fallback
        log "zsh not found, keeping bash as shell"
    fi
}

setup_motd() {
    cat > /etc/motd <<'MOTD'

              .     *    .        .   *       .
        *    .    ___|___    .        .     *
           .    /   |   \     *    .        .
      .       /    /|\    \       .     *
           __/____/_|_\____\__     .        .
    *     |  _______________ |        *
         |  |  ^   ^   ^  |  |   .        .
    .    |  | /|\ /|\ /|\ |  |      *
         |  | |||_|||_||| |  |  .       .
      *  |  | ||| ||| ||| |  |     *
    .    |__|_|||_|||_|||_|__|        .    *
         /   \-----------/   \   .
        /     \  /   \  /     \      .
       /       \/     \/       \   *
      /_________\     /_________\       .

     I M L A D R I S   -   Sanctuary of Lore

 Managed by: Nix + home-manager
 Config:     ~/repos/github.com/dacapo-labs/host/nix/

 Commands:
   home-manager switch    Apply config changes
   imladris-init          Initialize LUKS volume
   imladris-check         Health check

MOTD
}

# =============================================================================
# Main Execution
# =============================================================================

main() {
    log "=========================================="
    log "DevBox Bootstrap (Nix Edition)"
    log "Architecture: ${architecture}"
    log "Hostname: ${hostname}"
    log "=========================================="

    touch "$CHECKPOINT_FILE"

    run_step "system"        "System setup"           setup_system
    run_step "docker"        "Docker"                 setup_docker
    run_step "tailscale"     "Tailscale"              setup_tailscale
    run_step "data_volume"   "Data volume attach"     setup_data_volume
    run_step "spot_handler"  "Spot interruption"      setup_spot_handler
    run_step "nix"           "Nix installation"       setup_nix
    run_step "home_manager"  "home-manager setup"     setup_home_manager
    run_step "imladris_scripts" "DevBox scripts"        setup_imladris_scripts
    run_step "bws"           "BWS CLI"                setup_bws
    run_step "shell"         "Default shell"          setup_shell
    run_step "motd"          "Login message"          setup_motd

    log "=========================================="
    if [ -n "$FAILED_STEPS" ]; then
        log "Completed with failures:$FAILED_STEPS"
    else
        log "Bootstrap complete!"
    fi
    log "=========================================="
}

main "$@"
