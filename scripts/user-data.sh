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

# 5. Install AWS CLI v2
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

# 23. Set hostname
hostnamectl set-hostname ${hostname}

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

# =============================================================================
# USER ENVIRONMENT SETUP
# =============================================================================

# 26. Setup ubuntu user environment
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

echo "=== Devbox setup complete ==="
