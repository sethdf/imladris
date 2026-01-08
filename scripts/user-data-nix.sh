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

setup_spot_handler() {
    local SCRIPTS_BASE="https://raw.githubusercontent.com/${github_username}/host/master/scripts"

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

    # Determine architecture for flake target
    local HM_CONFIG="ubuntu"
    if [ "$(uname -m)" = "x86_64" ]; then
        HM_CONFIG="ubuntu-x86"
    fi

    # Run home-manager as ubuntu user
    cd "$REPO_DIR/nix"
    sudo -u ubuntu -i bash -c "
        . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
        cd $REPO_DIR/nix
        nix run home-manager -- switch --flake .#$HM_CONFIG
    "
}

# =============================================================================
# DevBox Scripts (outside of Nix - for LUKS/BWS operations)
# =============================================================================

setup_devbox_scripts() {
    local SCRIPTS_BASE="https://raw.githubusercontent.com/${github_username}/host/master/scripts"

    mkdir -p /home/ubuntu/bin
    cd /home/ubuntu/bin

    # Download devbox management scripts
    curl -fsSL "$SCRIPTS_BASE/devbox-init.sh" -o devbox-init
    curl -fsSL "$SCRIPTS_BASE/devbox-check.sh" -o devbox-check
    curl -fsSL "$SCRIPTS_BASE/devbox-restore.sh" -o devbox-restore
    curl -fsSL "$SCRIPTS_BASE/bws-init.sh" -o bws-init
    curl -fsSL "$SCRIPTS_BASE/session-sync-setup.sh" -o session-sync-setup

    chmod +x devbox-init devbox-check devbox-restore bws-init session-sync-setup
    chown -R ubuntu:ubuntu /home/ubuntu/bin

    # Session sync systemd template
    curl -fsSL "$SCRIPTS_BASE/session-sync@.service" -o /etc/systemd/system/session-sync@.service
    systemctl daemon-reload
}

setup_shell() {
    # Set zsh as default shell for ubuntu
    chsh -s /home/ubuntu/.nix-profile/bin/zsh ubuntu 2>/dev/null || \
    chsh -s "$(which zsh)" ubuntu 2>/dev/null || \
    chsh -s /usr/bin/zsh ubuntu
}

setup_motd() {
    cat > /etc/motd <<'MOTD'

  ____             ____
 |  _ \  _____   _| __ )  _____  __
 | | | |/ _ \ \ / /  _ \ / _ \ \/ /
 | |_| |  __/\ V /| |_) | (_) >  <
 |____/ \___| \_/ |____/ \___/_/\_\

 Managed by: Nix + home-manager
 Config:     ~/repos/github.com/dacapo-labs/host/nix/

 Commands:
   home-manager switch    Apply config changes
   devbox-init           Initialize LUKS volume
   devbox-check          Health check

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
    run_step "spot_handler"  "Spot interruption"      setup_spot_handler
    run_step "nix"           "Nix installation"       setup_nix
    run_step "home_manager"  "home-manager setup"     setup_home_manager
    run_step "devbox_scripts" "DevBox scripts"        setup_devbox_scripts
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
