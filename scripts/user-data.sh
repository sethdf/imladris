#!/bin/bash
set -euo pipefail

# Log output for debugging
exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

echo "=== Starting devbox setup ==="

# 1. Update system packages
apt-get update && apt-get upgrade -y

# 2. Install core development tooling
apt-get install -y \
    zsh \
    git \
    git-crypt \
    curl \
    wget \
    unzip \
    jq \
    htop \
    tmux \
    ripgrep \
    fd-find \
    bat \
    ncdu \
    software-properties-common \
    build-essential \
    ca-certificates \
    gnupg \
    lsb-release \
    apt-transport-https

# 3. Install Docker (official method)
curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
sh /tmp/get-docker.sh
usermod -aG docker ubuntu

# 4. Install Docker Compose plugin
apt-get install -y docker-compose-plugin

# 5. Install and configure Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --auth-key=${tailscale_auth_key} --hostname=${tailscale_hostname} --ssh

# 6. Install AWS CLI v2
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install
rm -rf /tmp/aws /tmp/awscliv2.zip

# 6. Install AWS SSM Session Manager Plugin
curl -fsSL "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" -o /tmp/session-manager-plugin.deb
dpkg -i /tmp/session-manager-plugin.deb
rm /tmp/session-manager-plugin.deb

# 7. Install GitHub CLI
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null
apt-get update && apt-get install -y gh

# 8. Install Node.js (LTS via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
apt-get install -y nodejs

# 9. Install Python tools
apt-get install -y python3-pip python3-venv python3-full

# 10. Install fzf (fuzzy finder)
apt-get install -y fzf

# 11. Install lazygit
LAZYGIT_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazygit/releases/latest" | jq -r '.tag_name' | sed 's/v//')
curl -fsSL "https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_Linux_x86_64.tar.gz" | tar xz -C /usr/local/bin lazygit

# 12. Install lazydocker
LAZYDOCKER_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazydocker/releases/latest" | jq -r '.tag_name' | sed 's/v//')
curl -fsSL "https://github.com/jesseduffield/lazydocker/releases/download/v${LAZYDOCKER_VERSION}/lazydocker_${LAZYDOCKER_VERSION}_Linux_x86_64.tar.gz" | tar xz -C /usr/local/bin lazydocker

# 13. Install delta (better git diffs)
DELTA_VERSION=$(curl -s "https://api.github.com/repos/dandavison/delta/releases/latest" | jq -r '.tag_name')
curl -fsSL "https://github.com/dandavison/delta/releases/download/${DELTA_VERSION}/git-delta_${DELTA_VERSION}_amd64.deb" -o /tmp/delta.deb
dpkg -i /tmp/delta.deb
rm /tmp/delta.deb

# 14. Install eza (modern ls)
apt-get install -y gpg
mkdir -p /etc/apt/keyrings
curl -fsSL https://raw.githubusercontent.com/eza-community/eza/main/deb.asc | gpg --dearmor -o /etc/apt/keyrings/gierens.gpg
echo "deb [signed-by=/etc/apt/keyrings/gierens.gpg] http://deb.gierens.de stable main" | tee /etc/apt/sources.list.d/gierens.list
chmod 644 /etc/apt/keyrings/gierens.gpg /etc/apt/sources.list.d/gierens.list
apt-get update && apt-get install -y eza

# 15. Install zoxide (smarter cd)
curl -sSfL https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | sh
mv /root/.local/bin/zoxide /usr/local/bin/

# 16. Install direnv
apt-get install -y direnv

# 17. Install tldr
npm install -g tldr

# 18. Install Claude Code CLI
npm install -g @anthropic-ai/claude-code

# 18. Install mise (version manager for node/python/go/etc)
curl https://mise.run | sh
mv /root/.local/bin/mise /usr/local/bin/

# =============================================================================
# CLOUD PROVIDER CLIs
# =============================================================================

# 19. Install Azure CLI
curl -sL https://aka.ms/InstallAzureCLIDeb | bash

# 20. Install Google Cloud CLI
curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee /etc/apt/sources.list.d/google-cloud-sdk.list
apt-get update && apt-get install -y google-cloud-cli

# =============================================================================
# WINDOWS / MS365 ADMIN TOOLS
# =============================================================================

# 21. Install PowerShell Core
curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/microsoft.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/ubuntu/24.04/prod noble main" | tee /etc/apt/sources.list.d/microsoft.list
apt-get update && apt-get install -y powershell

# 22. Install CLI for Microsoft 365 (m365)
npm install -g @pnp/cli-microsoft365

# =============================================================================
# SYSTEM CONFIGURATION
# =============================================================================

# 23. Set hostname and timezone
hostnamectl set-hostname ${hostname}
timedatectl set-timezone ${timezone}

# 24. Configure sysctl for development
cat >> /etc/sysctl.conf <<EOF
# Increase inotify watchers for large codebases
fs.inotify.max_user_watches=524288
fs.inotify.max_user_instances=512
EOF
sysctl -p

# 25. Configure git to use delta
cat > /etc/gitconfig <<EOF
[core]
    pager = delta

[interactive]
    diffFilter = delta --color-only

[delta]
    navigate = true
    side-by-side = true
    line-numbers = true

[merge]
    conflictstyle = diff3

[diff]
    colorMoved = default
EOF

# 26. Create shutdown warning script and timers
cat > /usr/local/bin/shutdown-warning <<'SCRIPT'
#!/bin/bash
MINS=$1
wall "⚠️  DEVBOX HIBERNATING IN $MINS MINUTES ⚠️
Your session will be saved (hibernation preserves RAM state).
To keep working: manually restart after 11pm, or stop the schedule."
SCRIPT
chmod +x /usr/local/bin/shutdown-warning

# 15-minute warning timer (10:45pm)
cat > /etc/systemd/system/shutdown-warning-15.service <<'SERVICE'
[Unit]
Description=Shutdown warning (15 minutes)

[Service]
Type=oneshot
ExecStart=/usr/local/bin/shutdown-warning 15
SERVICE

cat > /etc/systemd/system/shutdown-warning-15.timer <<'TIMER'
[Unit]
Description=15-minute shutdown warning

[Timer]
OnCalendar=*-*-* 22:45:00
Persistent=false

[Install]
WantedBy=timers.target
TIMER

# 5-minute warning timer (10:55pm)
cat > /etc/systemd/system/shutdown-warning-5.service <<'SERVICE'
[Unit]
Description=Shutdown warning (5 minutes)

[Service]
Type=oneshot
ExecStart=/usr/local/bin/shutdown-warning 5
SERVICE

cat > /etc/systemd/system/shutdown-warning-5.timer <<'TIMER'
[Unit]
Description=5-minute shutdown warning

[Timer]
OnCalendar=*-*-* 22:55:00
Persistent=false

[Install]
WantedBy=timers.target
TIMER

systemctl daemon-reload
systemctl enable --now shutdown-warning-15.timer
systemctl enable --now shutdown-warning-5.timer

# 27. Create spot interruption watcher
cat > /usr/local/bin/spot-watcher <<'SCRIPT'
#!/bin/bash
# Polls EC2 metadata for spot interruption notices
METADATA_URL="http://169.254.169.254/latest/meta-data/spot/instance-action"
TOKEN_URL="http://169.254.169.254/latest/api/token"
NOTIFIED=false

while true; do
    # Get IMDSv2 token
    TOKEN=$(curl -s -X PUT "$TOKEN_URL" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null)

    # Check for spot interruption
    RESPONSE=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" -w "%{http_code}" -o /tmp/spot-action "$METADATA_URL" 2>/dev/null)

    if [ "$RESPONSE" = "200" ] && [ "$NOTIFIED" = "false" ]; then
        ACTION=$(cat /tmp/spot-action | jq -r '.action' 2>/dev/null)
        TIME=$(cat /tmp/spot-action | jq -r '.time' 2>/dev/null)

        wall "🚨 SPOT INTERRUPTION NOTICE 🚨
Action: $ACTION
Time: $TIME

Your instance will hibernate in ~2 minutes.
All RAM state will be saved - you can resume after restart."

        NOTIFIED=true

        # Also send to any tmux sessions
        for session in $(tmux list-sessions -F '#{session_name}' 2>/dev/null); do
            tmux display-message -t "$session" "🚨 SPOT INTERRUPTION - Hibernating in ~2 min"
        done
    fi

    sleep 5
done
SCRIPT
chmod +x /usr/local/bin/spot-watcher

cat > /etc/systemd/system/spot-watcher.service <<'SERVICE'
[Unit]
Description=Spot interruption watcher
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/spot-watcher
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now spot-watcher

# =============================================================================
# CLAUDE SESSIONS SETUP
# =============================================================================

# 28. Setup GitHub SSH keys for work and home accounts
echo "Setting up GitHub SSH keys..."
mkdir -p /home/ubuntu/.ssh
chmod 700 /home/ubuntu/.ssh

%{ if github_ssh_key_home_b64 != "" ~}
# Decode and write home SSH key
echo "${github_ssh_key_home_b64}" | base64 -d > /home/ubuntu/.ssh/id_ed25519_home
chmod 600 /home/ubuntu/.ssh/id_ed25519_home

# Configure SSH for GitHub home account (sethdf)
cat >> /home/ubuntu/.ssh/config <<'SSHCONFIG'
Host github.com-home
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_home
    IdentitiesOnly yes

SSHCONFIG
echo "Home SSH key configured (sethdf)"
%{ endif ~}

%{ if github_ssh_key_work_b64 != "" ~}
# Decode and write work SSH key
echo "${github_ssh_key_work_b64}" | base64 -d > /home/ubuntu/.ssh/id_ed25519_work
chmod 600 /home/ubuntu/.ssh/id_ed25519_work

# Configure SSH for GitHub work account (sfoleybuxton)
cat >> /home/ubuntu/.ssh/config <<'SSHCONFIG'
Host github.com-work
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_work
    IdentitiesOnly yes

SSHCONFIG
echo "Work SSH key configured (sfoleybuxton)"
%{ endif ~}

chmod 600 /home/ubuntu/.ssh/config 2>/dev/null || true
chown -R ubuntu:ubuntu /home/ubuntu/.ssh

# =============================================================================
# USER ENVIRONMENT SETUP
# =============================================================================

# 29. Setup ubuntu user environment
sudo -u ubuntu bash <<'USEREOF'
# Install Oh My Zsh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended

# Set zsh as default shell
sudo chsh -s $(which zsh) ubuntu

# Create common directories
mkdir -p ~/code ~/projects ~/.local/bin

# Setup mise for user
echo 'eval "$(mise activate zsh)"' >> ~/.zshrc

# Setup zoxide for user
echo 'eval "$(zoxide init zsh)"' >> ~/.zshrc

# Setup direnv for user
echo 'eval "$(direnv hook zsh)"' >> ~/.zshrc

# Setup fzf keybindings
echo 'source /usr/share/doc/fzf/examples/key-bindings.zsh' >> ~/.zshrc
echo 'source /usr/share/doc/fzf/examples/completion.zsh' >> ~/.zshrc

# Aliases for modern tools
cat >> ~/.zshrc <<'ALIASES'

# Modern CLI aliases
alias ls='eza'
alias ll='eza -la'
alias la='eza -la'
alias lt='eza --tree'
alias cat='batcat'
alias lg='lazygit'
alias ld='lazydocker'

# Cloud CLI aliases
alias tf='terraform'
alias aws-whoami='aws sts get-caller-identity'
alias az-whoami='az account show'
alias gcp-whoami='gcloud config get-value account'
ALIASES

# Install PowerShell modules for MS365/Azure AD administration
pwsh -Command "Install-Module -Name Microsoft.Graph -Scope CurrentUser -Force -AllowClobber"
pwsh -Command "Install-Module -Name Az -Scope CurrentUser -Force -AllowClobber"
pwsh -Command "Install-Module -Name ExchangeOnlineManagement -Scope CurrentUser -Force"
pwsh -Command "Install-Module -Name MicrosoftTeams -Scope CurrentUser -Force"
USEREOF

# =============================================================================
# CLAUDE SESSIONS FRAMEWORK SETUP
# =============================================================================

%{ if github_ssh_key_home_b64 != "" && git_crypt_key_b64 != "" ~}
echo "=== Setting up Claude Sessions Framework ==="

# Clone and setup as ubuntu user
sudo -u ubuntu bash <<CLAUDEEOF
set -e

# Add GitHub's host key to known_hosts
ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null

# Clone the claude-sessions-config repo
if [ ! -d ~/.config/claude-sessions ]; then
    echo "Cloning claude-sessions-config..."
    git clone git@github.com-home:YOUR_USERNAME/claude-sessions-config.git ~/.config/claude-sessions
fi

# Decode and apply git-crypt key
echo "Unlocking encrypted secrets..."
echo "${git_crypt_key_b64}" | base64 -d > /tmp/git-crypt-key
cd ~/.config/claude-sessions
git-crypt unlock /tmp/git-crypt-key
rm -f /tmp/git-crypt-key

# Source claude-sessions functions in .zshrc
if ! grep -q "claude-sessions" ~/.zshrc; then
    cat >> ~/.zshrc <<'CLAUDERC'

# Claude Sessions Framework
export CC_CONFIG_DIR="\$HOME/.config/claude-sessions"
if [[ -f "\$CC_CONFIG_DIR/context-switch.sh" ]]; then
    source "\$CC_CONFIG_DIR/context-switch.sh"
fi
if [[ -f "\$CC_CONFIG_DIR/functions.sh" ]]; then
    source "\$CC_CONFIG_DIR/functions.sh"
fi
CLAUDERC
fi

# Also add to .bashrc for bash sessions
if ! grep -q "claude-sessions" ~/.bashrc 2>/dev/null; then
    cat >> ~/.bashrc <<'CLAUDERC'

# Claude Sessions Framework
export CC_CONFIG_DIR="\$HOME/.config/claude-sessions"
if [[ -f "\$CC_CONFIG_DIR/context-switch.sh" ]]; then
    source "\$CC_CONFIG_DIR/context-switch.sh"
fi
if [[ -f "\$CC_CONFIG_DIR/functions.sh" ]]; then
    source "\$CC_CONFIG_DIR/functions.sh"
fi
CLAUDERC
fi

# Create claude-sessions directory structure
mkdir -p ~/claude-sessions/home ~/claude-sessions/work

echo "Claude Sessions Framework installed!"
echo "Run 'ccsetup' after first login to create session repos."
CLAUDEEOF
%{ endif ~}

# =============================================================================
# AWS SSO CONFIGURATION
# =============================================================================

%{ if aws_sso_start_url != "" && aws_sso_account_id != "" ~}
echo "=== Setting up AWS SSO Configuration ==="

sudo -u ubuntu mkdir -p /home/ubuntu/.aws

# Create AWS config with home profile for Bedrock access
cat > /home/ubuntu/.aws/config <<AWSCONFIG
[default]
region = us-east-1

[profile home]
sso_session = home-sso
sso_account_id = ${aws_sso_account_id}
sso_role_name = ${aws_sso_role_name}
region = us-east-1

[sso-session home-sso]
sso_start_url = ${aws_sso_start_url}
sso_region = us-east-1
sso_registration_scopes = sso:account:access
AWSCONFIG

chown ubuntu:ubuntu /home/ubuntu/.aws/config
echo "AWS config created with home profile"
%{ endif ~}

# =============================================================================
# GIT IDENTITY CONFIGURATION
# =============================================================================

echo "=== Setting up Git Identity ==="

sudo -u ubuntu mkdir -p /home/ubuntu/.config/git

%{ if git_user_email_home != "" ~}
# Create home git config
cat > /home/ubuntu/.config/git/config-home <<GITCONFIG
[user]
    name = ${git_user_name_home}
    email = ${git_user_email_home}

[url "git@github.com-home:"]
    insteadOf = git@github.com:
    insteadOf = https://github.com/
GITCONFIG
echo "Home git identity configured (${git_user_email_home})"
%{ endif ~}

%{ if git_user_email_work != "" ~}
# Create work git config
cat > /home/ubuntu/.config/git/config-work <<GITCONFIG
[user]
    name = ${git_user_name_work}
    email = ${git_user_email_work}

[url "git@github.com-work:"]
    insteadOf = git@github.com:
    insteadOf = https://github.com/
GITCONFIG
echo "Work git identity configured (${git_user_email_work})"
%{ endif ~}

chown -R ubuntu:ubuntu /home/ubuntu/.config/git

# Add includeIf rules to global gitconfig for claude-sessions directories
sudo -u ubuntu bash <<'GITINCLUDEEOF'
touch ~/.gitconfig

# Home identity for ~/claude-sessions/home/
if ! grep -q "gitdir:.*claude-sessions/home/" ~/.gitconfig 2>/dev/null; then
    cat >> ~/.gitconfig <<'GITINCLUDE'

# Claude Sessions - Home identity (sethdf)
[includeIf "gitdir:~/claude-sessions/home/"]
    path = ~/.config/git/config-home
GITINCLUDE
fi

# Work identity for ~/claude-sessions/work/
if ! grep -q "gitdir:.*claude-sessions/work/" ~/.gitconfig 2>/dev/null; then
    cat >> ~/.gitconfig <<'GITINCLUDE'

# Claude Sessions - Work identity (sfoleybuxton)
[includeIf "gitdir:~/claude-sessions/work/"]
    path = ~/.config/git/config-work
GITINCLUDE
fi
GITINCLUDEEOF

echo "Git includeIf rules configured for directory-based identity switching"

# =============================================================================
# CLAUDE CODE SETTINGS
# =============================================================================

echo "=== Setting up Claude Code Settings ==="

sudo -u ubuntu bash <<'CLAUDESETTINGS'
mkdir -p ~/.claude

# Create Claude Code settings for Bedrock
cat > ~/.claude/settings.json <<'SETTINGS'
{
  "permissions": {
    "allow": [
      "Bash(git *)",
      "Bash(gh *)",
      "Bash(aws *)",
      "Bash(npm *)",
      "Bash(node *)",
      "Bash(python *)",
      "Bash(pip *)",
      "Bash(docker *)",
      "Bash(terraform *)",
      "Bash(make *)",
      "Bash(curl *)",
      "Bash(ls *)",
      "Bash(cat *)",
      "Bash(grep *)",
      "Bash(find *)",
      "Bash(mkdir *)",
      "Bash(rm *)",
      "Bash(cp *)",
      "Bash(mv *)",
      "Bash(touch *)",
      "Bash(chmod *)",
      "Bash(head *)",
      "Bash(tail *)",
      "Bash(wc *)",
      "Bash(sort *)",
      "Bash(uniq *)",
      "Bash(diff *)",
      "Bash(echo *)",
      "Bash(pwd)",
      "Bash(whoami)",
      "Bash(date)",
      "Bash(which *)",
      "Bash(type *)",
      "Bash(env)",
      "Bash(export *)",
      "Bash(source *)",
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Glob",
      "Grep",
      "LS",
      "Task",
      "WebFetch",
      "TodoRead",
      "TodoWrite"
    ],
    "deny": []
  }
}
SETTINGS

echo "Claude Code settings configured"
CLAUDESETTINGS

# =============================================================================
# GITHUB CLI AUTHENTICATION
# =============================================================================

%{ if github_token != "" ~}
echo "=== Setting up GitHub CLI Authentication ==="

# Authenticate gh CLI with token
echo "${github_token}" | sudo -u ubuntu gh auth login --with-token

# Set git protocol to SSH (matches our SSH key setup)
sudo -u ubuntu gh config set git_protocol ssh

echo "GitHub CLI authenticated"
%{ endif ~}

echo "=== Devbox setup complete ==="
