#!/bin/bash
set -euo pipefail

# Log output for debugging
exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

echo "=== Starting devbox setup ==="

# Architecture detection (from Terraform variable)
ARCH="${architecture}"
echo "Architecture: $ARCH"

# Map architecture to various naming conventions used by different tools
if [ "$ARCH" = "arm64" ]; then
    AWS_ARCH="aarch64"
    LAZYGIT_ARCH="arm64"
    LAZYDOCKER_ARCH="arm64"
    HIMALAYA_ARCH="aarch64-linux"
else
    AWS_ARCH="x86_64"
    LAZYGIT_ARCH="x86_64"
    LAZYDOCKER_ARCH="x86_64"
    HIMALAYA_ARCH="x86_64-linux"
fi

# 1. System update and core tools
apt-get update && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
apt-get install -y zsh git git-crypt curl wget unzip jq htop tmux ripgrep fd-find bat ncdu \
    software-properties-common build-essential ca-certificates gnupg lsb-release fzf direnv \
    cryptsetup eza

# 2. Docker
curl -fsSL https://get.docker.com | sh
usermod -aG docker ubuntu
apt-get install -y docker-compose-plugin

# 3. Tailscale
curl -fsSL https://tailscale.com/install.sh | sh

# Remove old devbox devices from tailnet before registering
echo "Cleaning up old Tailscale devices matching '${tailscale_hostname}'..."
OLD_DEVICES=$(curl -s -u "${tailscale_api_key}:" \
  "https://api.tailscale.com/api/v2/tailnet/-/devices" \
  | jq -r '.devices[] | select(.hostname | startswith("${tailscale_hostname}")) | .id')
for DEVICE_ID in $OLD_DEVICES; do
  echo "Deleting device: $DEVICE_ID"
  curl -s -X DELETE -u "${tailscale_api_key}:" \
    "https://api.tailscale.com/api/v2/device/$DEVICE_ID"
done

tailscale up --auth-key=${tailscale_auth_key} --hostname=${tailscale_hostname} --ssh

# 4. AWS CLI
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$${AWS_ARCH}.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscliv2.zip

# 5. GitHub CLI
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list
apt-get update && apt-get install -y gh

# 6. Node.js LTS
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
apt-get install -y nodejs

# 7. Python
apt-get install -y python3-pip python3-venv python3-full
pip3 install --break-system-packages gcalcli

# 8. CLI tools via npm
npm install -g tldr @anthropic-ai/claude-code @bitwarden/cli @pnp/cli-microsoft365

# 9. Modern CLI tools
LAZYGIT_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazygit/releases/latest" | jq -r '.tag_name' | sed 's/v//')
curl -fsSL "https://github.com/jesseduffield/lazygit/releases/download/v$${LAZYGIT_VERSION}/lazygit_$${LAZYGIT_VERSION}_Linux_$${LAZYGIT_ARCH}.tar.gz" | tar xz -C /usr/local/bin
LAZYDOCKER_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazydocker/releases/latest" | jq -r '.tag_name' | sed 's/v//')
curl -fsSL "https://github.com/jesseduffield/lazydocker/releases/download/v$${LAZYDOCKER_VERSION}/lazydocker_$${LAZYDOCKER_VERSION}_Linux_$${LAZYDOCKER_ARCH}.tar.gz" | tar xz -C /usr/local/bin
curl -sSfL https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | sh && mv /root/.local/bin/zoxide /usr/local/bin/
curl https://mise.run | sh && mv /root/.local/bin/mise /usr/local/bin/
HIMALAYA_VERSION=$(curl -s "https://api.github.com/repos/pimalaya/himalaya/releases/latest" | jq -r '.tag_name' | sed 's/v//')
curl -fsSL "https://github.com/pimalaya/himalaya/releases/download/v$${HIMALAYA_VERSION}/himalaya.$${HIMALAYA_ARCH}.tgz" | tar xz -C /usr/local/bin

# 10. Cloud CLIs
curl -sL https://aka.ms/InstallAzureCLIDeb | bash
curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee /etc/apt/sources.list.d/google-cloud-sdk.list
apt-get update && apt-get install -y google-cloud-cli

# 11. System config
hostnamectl set-hostname ${hostname}
timedatectl set-timezone ${timezone}
echo "fs.inotify.max_user_watches=524288" >> /etc/sysctl.conf && sysctl -p

# 12. Git delta
cat > /etc/gitconfig <<'GITCFG'
[core]
    pager = delta
[delta]
    navigate = true
    side-by-side = true
    line-numbers = true
GITCFG

# 13. Spot watcher service
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
systemctl daemon-reload && systemctl enable --now spot-watcher

# 14. Download bootstrap scripts from GitHub
SCRIPTS_BASE="https://raw.githubusercontent.com/YOUR_USERNAME/aws-devbox/master/scripts"
mkdir -p /home/ubuntu/bin
curl -fsSL "$SCRIPTS_BASE/bw-unlock.sh" -o /home/ubuntu/bin/bw-unlock
curl -fsSL "$SCRIPTS_BASE/devbox-init.sh" -o /home/ubuntu/bin/devbox-init
curl -fsSL "$SCRIPTS_BASE/devbox-check.sh" -o /home/ubuntu/bin/devbox-check
chmod +x /home/ubuntu/bin/bw-unlock /home/ubuntu/bin/devbox-init /home/ubuntu/bin/devbox-check
chown -R ubuntu:ubuntu /home/ubuntu/bin

# 15. User environment
sudo -u ubuntu bash <<'USERSETUP'
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
sudo chsh -s $(which zsh) ubuntu
mkdir -p ~/code ~/projects ~/.local/bin ~/.claude
cat >> ~/.zshrc <<'ZSHRC'
command -v mise &>/dev/null && eval "$(mise activate zsh)"
command -v zoxide &>/dev/null && eval "$(zoxide init zsh)"
command -v direnv &>/dev/null && eval "$(direnv hook zsh)"
export PATH="$HOME/bin:$PATH"
alias ls='eza' ll='eza -la' lg='lazygit' ld='lazydocker'
alias unlock='source ~/bin/bw-unlock' init='~/bin/devbox-init' check='~/bin/devbox-check'
ZSHRC
cat >> ~/.bashrc <<'BASHRC'
command -v zoxide &>/dev/null && eval "$(zoxide init bash)"
command -v direnv &>/dev/null && eval "$(direnv hook bash)"
export PATH="$HOME/bin:$PATH"
alias ls='eza' ll='eza -la' lg='lazygit' ld='lazydocker'
alias unlock='source ~/bin/bw-unlock' init='~/bin/devbox-init' check='~/bin/devbox-check'
BASHRC
cat > ~/.claude/settings.json <<'CLAUDE'
{"permissions":{"allow":["Bash(git *)","Bash(gh *)","Bash(aws *)","Bash(npm *)","Bash(docker *)","Bash(terraform *)","Bash(bw *)","Read","Write","Edit","Glob","Grep","Task","WebFetch","TodoRead","TodoWrite"],"deny":[]}}
CLAUDE
mkdir -p ~/.claude/rules
cat > ~/.claude/rules/save-progress.md <<'SAVEMD'
# Save Progress Frequently

This devbox does NOT hibernate - stopping loses all running state.

## Rules
- Commit work frequently (at least every significant milestone)
- Push to remote before ending sessions
- Use descriptive commit messages
- Never leave uncommitted work when stepping away

## Before Stopping
If the user says they're done or stepping away:
1. Check for uncommitted changes: `git status`
2. Offer to commit and push
3. Remind about unsaved work in other repos
SAVEMD
USERSETUP

# 16. MOTD
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

echo "=== Devbox setup complete ==="
