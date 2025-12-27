#!/bin/bash
set -euo pipefail

# Log output for debugging (no secrets in this script!)
exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

echo "=== Starting devbox setup ==="

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
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
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

# 8. CLI tools via npm
npm install -g tldr @anthropic-ai/claude-code @bitwarden/cli @pnp/cli-microsoft365

# 9. Modern CLI tools
LAZYGIT_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazygit/releases/latest" | jq -r '.tag_name' | sed 's/v//')
curl -fsSL "https://github.com/jesseduffield/lazygit/releases/download/v$${LAZYGIT_VERSION}/lazygit_$${LAZYGIT_VERSION}_Linux_x86_64.tar.gz" | tar xz -C /usr/local/bin
LAZYDOCKER_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazydocker/releases/latest" | jq -r '.tag_name' | sed 's/v//')
curl -fsSL "https://github.com/jesseduffield/lazydocker/releases/download/v$${LAZYDOCKER_VERSION}/lazydocker_$${LAZYDOCKER_VERSION}_Linux_x86_64.tar.gz" | tar xz -C /usr/local/bin
curl -sSfL https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | sh && mv /root/.local/bin/zoxide /usr/local/bin/
curl https://mise.run | sh && mv /root/.local/bin/mise /usr/local/bin/

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

# 14. Bootstrap scripts for Bitwarden secrets
mkdir -p /home/ubuntu/bin

cat > /home/ubuntu/bin/bw-unlock <<'BWUNLOCK'
#!/usr/bin/env bash
set -uo pipefail
BW_SESSION_FILE="$HOME/.config/bitwarden/session"
_status() { bw status 2>/dev/null | jq -r '.status' 2>/dev/null || echo "unknown"; }
_save() { mkdir -p "$(dirname "$BW_SESSION_FILE")" && echo "$BW_SESSION" > "$BW_SESSION_FILE" && chmod 600 "$BW_SESSION_FILE"; }
_load() { [[ -f "$BW_SESSION_FILE" ]] && export BW_SESSION=$(cat "$BW_SESSION_FILE") && [[ "$(_status)" == "unlocked" ]]; }
_unlock() {
    command -v bw &>/dev/null || { echo "Error: bw not installed"; return 1; }
    _load && { echo "Session restored"; return 0; }
    case "$(_status)" in
        unlocked) echo "Already unlocked" ;;
        locked) BW_SESSION=$(bw unlock --raw) && export BW_SESSION && _save && echo "Unlocked" ;;
        unauthenticated) bw login && BW_SESSION=$(bw unlock --raw) && export BW_SESSION && _save && echo "Logged in" ;;
        *) echo "Unknown status"; return 1 ;;
    esac
}
_unlock
BWUNLOCK

cat > /home/ubuntu/bin/devbox-init <<'DEVBOXINIT'
#!/usr/bin/env bash
set -euo pipefail

DATA_DEV="/dev/nvme1n1"
DATA_MAPPER="data"
DATA_MOUNT="/data"

bw status 2>/dev/null | jq -e '.status == "unlocked"' &>/dev/null || { echo "Run: source ~/bin/bw-unlock"; exit 1; }
bw sync &>/dev/null

# =============================================================================
# LUKS Data Volume
# =============================================================================
if [[ -b "$DATA_DEV" ]]; then
    echo "=== Setting up encrypted data volume ==="
    LUKS_KEY=$(bw get password "devbox/luks-key" 2>/dev/null) || { echo "Error: devbox/luks-key not found in Bitwarden"; exit 1; }

    if ! sudo cryptsetup isLuks "$DATA_DEV" 2>/dev/null; then
        echo "Formatting $DATA_DEV with LUKS (first time setup)..."
        echo "$LUKS_KEY" | sudo cryptsetup luksFormat --type luks2 "$DATA_DEV" -
        echo "$LUKS_KEY" | sudo cryptsetup open "$DATA_DEV" "$DATA_MAPPER" -
        sudo mkfs.ext4 -L data "/dev/mapper/$DATA_MAPPER"
        sudo mkdir -p "$DATA_MOUNT"
        sudo mount "/dev/mapper/$DATA_MAPPER" "$DATA_MOUNT"
        sudo mkdir -p "$DATA_MOUNT/home"
        sudo cp -a /home/ubuntu/. "$DATA_MOUNT/home/" 2>/dev/null || true
        sudo chown -R ubuntu:ubuntu "$DATA_MOUNT/home"
        echo "Data volume initialized"
    else
        if [[ ! -e "/dev/mapper/$DATA_MAPPER" ]]; then
            echo "Unlocking LUKS volume..."
            echo "$LUKS_KEY" | sudo cryptsetup open "$DATA_DEV" "$DATA_MAPPER" -
        fi
        sudo mkdir -p "$DATA_MOUNT"
        if ! mountpoint -q "$DATA_MOUNT"; then
            sudo mount "/dev/mapper/$DATA_MAPPER" "$DATA_MOUNT"
        fi
        echo "Data volume unlocked and mounted"
    fi

    # Bind mount encrypted home over /home/ubuntu
    if [[ -d "$DATA_MOUNT/home" ]] && ! mountpoint -q /home/ubuntu; then
        sudo mount --bind "$DATA_MOUNT/home" /home/ubuntu
        echo "Home directory mounted from encrypted volume"
    fi
fi

echo "=== Setting up SSH keys ==="
mkdir -p ~/.ssh && chmod 700 ~/.ssh
bw get item "devbox/github-ssh-home" &>/dev/null && bw get item "devbox/github-ssh-home" | jq -r '.fields[]? | select(.name=="private_key") | .value' > ~/.ssh/id_ed25519_home && chmod 600 ~/.ssh/id_ed25519_home && echo "Home key installed"
bw get item "devbox/github-ssh-work" &>/dev/null && bw get item "devbox/github-ssh-work" | jq -r '.fields[]? | select(.name=="private_key") | .value' > ~/.ssh/id_ed25519_work && chmod 600 ~/.ssh/id_ed25519_work && echo "Work key installed"
[[ ! -f ~/.ssh/config ]] && cat > ~/.ssh/config <<'SSHCFG'
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
ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null

echo "=== Setting up GitHub CLI ==="
gh auth status &>/dev/null || { bw get item "devbox/github-token" &>/dev/null && bw get password "devbox/github-token" | gh auth login --with-token && gh config set git_protocol ssh; }

echo "=== Setting up git identity ==="
mkdir -p ~/.config/git
cat > ~/.config/git/config-home <<'GH'
[user]
    name = Seth
    email = your-email@example.com
[url "git@github.com-home:"]
    insteadOf = git@github.com:
GH
cat > ~/.config/git/config-work <<'GW'
[user]
    name = Your Name
    email = your-work-email@example.com
[url "git@github.com-work:"]
    insteadOf = git@github.com:
GW
grep -q "claude-sessions/home" ~/.gitconfig 2>/dev/null || cat >> ~/.gitconfig <<'GINC'
[includeIf "gitdir:~/claude-sessions/home/"]
    path = ~/.config/git/config-home
[includeIf "gitdir:~/claude-sessions/work/"]
    path = ~/.config/git/config-work
GINC

echo "=== Setting up AWS config ==="
mkdir -p ~/.aws
cat > ~/.aws/config <<'AWSCFG'
[default]
region = us-east-1
[profile home]
sso_session = home-sso
sso_account_id = 000000000000
sso_role_name = AdministratorAccess
region = us-east-1
[sso-session home-sso]
sso_start_url = https://d-9067954177.awsapps.com/start
sso_region = us-east-1
sso_registration_scopes = sso:account:access
AWSCFG

echo "=== Setting up claude-sessions ==="
[[ ! -d ~/.config/claude-sessions ]] && [[ -f ~/.ssh/id_ed25519_home ]] && git clone git@github.com-home:YOUR_USERNAME/claude-sessions-config.git ~/.config/claude-sessions
bw get item "devbox/git-crypt-key" &>/dev/null && cd ~/.config/claude-sessions && git-crypt unlock <(bw get item "devbox/git-crypt-key" | jq -r '.fields[]? | select(.name=="key_b64") | .value' | base64 -d) && cd -
mkdir -p ~/claude-sessions/home ~/claude-sessions/work

echo "=== Setting up LifeMaestro ==="
if [[ ! -d ~/code/lifemaestro ]] && [[ -f ~/.ssh/id_ed25519_home ]]; then
    git clone git@github.com-home:YOUR_USERNAME/dotfiles.git ~/code/lifemaestro
    cd ~/code/lifemaestro && ./install.sh && cd -
    # Symlink .claude to get skills/rules globally
    if [[ -d ~/code/lifemaestro/.claude ]]; then
        # Remove default .claude dir (created by user-data) to replace with symlink
        [[ -d ~/.claude && ! -L ~/.claude ]] && rm -rf ~/.claude
        ln -sfn ~/code/lifemaestro/.claude ~/.claude
    fi
    echo "LifeMaestro installed"
else
    echo "LifeMaestro already installed or SSH key missing"
fi

echo "=== DONE ==="
echo "Run: aws sso login --profile home"
DEVBOXINIT

chmod +x /home/ubuntu/bin/bw-unlock /home/ubuntu/bin/devbox-init
chown -R ubuntu:ubuntu /home/ubuntu/bin

# 15. User environment
sudo -u ubuntu bash <<'USERSETUP'
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
sudo chsh -s $(which zsh) ubuntu
mkdir -p ~/code ~/projects ~/.local/bin ~/.claude
cat >> ~/.zshrc <<'ZSHRC'
eval "$(mise activate zsh)"
eval "$(zoxide init zsh)"
eval "$(direnv hook zsh)"
export PATH="$HOME/bin:$PATH"
alias ls='eza' ll='eza -la' lg='lazygit' ld='lazydocker'
alias unlock='source ~/bin/bw-unlock' init='~/bin/devbox-init'
ZSHRC
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
  First time:  source ~/bin/bw-unlock && ~/bin/devbox-init
  Shortcuts:   unlock && init
================================================================================
MOTD

echo "=== Devbox setup complete ==="
