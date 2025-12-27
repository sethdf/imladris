#!/usr/bin/env bash
# devbox-init - Initialize devbox after first SSH
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
        sudo wipefs -a "$DATA_DEV" 2>/dev/null || true
        echo -n "$LUKS_KEY" | sudo cryptsetup luksFormat --type luks2 -q "$DATA_DEV" -
        echo -n "$LUKS_KEY" | sudo cryptsetup open "$DATA_DEV" "$DATA_MAPPER" -
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
            echo -n "$LUKS_KEY" | sudo cryptsetup open "$DATA_DEV" "$DATA_MAPPER" -
        fi
        sudo mkdir -p "$DATA_MOUNT"
        if ! sudo blkid "/dev/mapper/$DATA_MAPPER" &>/dev/null; then
            echo "Creating filesystem on LUKS volume..."
            sudo mkfs.ext4 -L data "/dev/mapper/$DATA_MAPPER"
        fi
        if ! mountpoint -q "$DATA_MOUNT"; then
            sudo mount "/dev/mapper/$DATA_MAPPER" "$DATA_MOUNT"
        fi
        echo "Data volume unlocked and mounted"
    fi

    if [[ -d "$DATA_MOUNT/home" ]] && ! mountpoint -q /home/ubuntu; then
        sudo mount --bind "$DATA_MOUNT/home" /home/ubuntu
        echo "Home directory mounted from encrypted volume"
    fi
fi

echo "=== Setting up SSH keys ==="
mkdir -p ~/.ssh && chmod 700 ~/.ssh
if [[ ! -f ~/.ssh/id_ed25519_home ]]; then
    bw get item "devbox/github-ssh-home" &>/dev/null && bw get item "devbox/github-ssh-home" | jq -r '.fields[]? | select(.name=="private_key") | .value' > ~/.ssh/id_ed25519_home && chmod 600 ~/.ssh/id_ed25519_home && echo "Home key installed"
else
    echo "Home key already exists"
fi
if [[ ! -f ~/.ssh/id_ed25519_work ]]; then
    bw get item "devbox/github-ssh-work" &>/dev/null && bw get item "devbox/github-ssh-work" | jq -r '.fields[]? | select(.name=="private_key") | .value' > ~/.ssh/id_ed25519_work && chmod 600 ~/.ssh/id_ed25519_work && echo "Work key installed"
else
    echo "Work key already exists"
fi
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
grep -q "github.com" ~/.ssh/known_hosts 2>/dev/null || ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null

echo "=== Setting up GitHub CLI ==="
gh auth status &>/dev/null || { bw get item "devbox/github-token" &>/dev/null && bw get password "devbox/github-token" | gh auth login --with-token && gh config set git_protocol ssh; }

echo "=== Setting up git identity ==="
mkdir -p ~/.config/git

IDENTITY=$(bw get item "devbox/identity" 2>/dev/null) || { echo "Warning: devbox/identity not found in Bitwarden"; IDENTITY=""; }

if [[ -n "$IDENTITY" ]]; then
    GIT_NAME_HOME=$(echo "$IDENTITY" | jq -r '.fields[]? | select(.name=="git_name_home") | .value // empty')
    GIT_EMAIL_HOME=$(echo "$IDENTITY" | jq -r '.fields[]? | select(.name=="git_email_home") | .value // empty')
    GIT_NAME_WORK=$(echo "$IDENTITY" | jq -r '.fields[]? | select(.name=="git_name_work") | .value // empty')
    GIT_EMAIL_WORK=$(echo "$IDENTITY" | jq -r '.fields[]? | select(.name=="git_email_work") | .value // empty')
else
    GIT_NAME_HOME="Seth"
    GIT_EMAIL_HOME="your-email@example.com"
    GIT_NAME_WORK="Your Name"
    GIT_EMAIL_WORK="your-work-email@example.com"
fi

if [[ ! -f ~/.config/git/config-home ]]; then
    cat > ~/.config/git/config-home <<GH
[user]
    name = $GIT_NAME_HOME
    email = $GIT_EMAIL_HOME
[url "git@github.com-home:"]
    insteadOf = git@github.com:
GH
    echo "Git config-home created"
else
    echo "Git config-home already exists"
fi
if [[ ! -f ~/.config/git/config-work ]]; then
    cat > ~/.config/git/config-work <<GW
[user]
    name = $GIT_NAME_WORK
    email = $GIT_EMAIL_WORK
[url "git@github.com-work:"]
    insteadOf = git@github.com:
GW
    echo "Git config-work created"
else
    echo "Git config-work already exists"
fi
grep -q "claude-sessions/home" ~/.gitconfig 2>/dev/null || cat >> ~/.gitconfig <<'GINC'
[includeIf "gitdir:~/claude-sessions/home/"]
    path = ~/.config/git/config-home
[includeIf "gitdir:~/claude-sessions/work/"]
    path = ~/.config/git/config-work
GINC

echo "=== Setting up AWS config ==="
mkdir -p ~/.aws

if [[ -n "$IDENTITY" ]]; then
    AWS_ACCOUNT_ID=$(echo "$IDENTITY" | jq -r '.fields[]? | select(.name=="aws_account_id") | .value // empty')
    AWS_SSO_START_URL=$(echo "$IDENTITY" | jq -r '.fields[]? | select(.name=="aws_sso_start_url") | .value // empty')
    AWS_SSO_REGION=$(echo "$IDENTITY" | jq -r '.fields[]? | select(.name=="aws_sso_region") | .value // empty')
    AWS_ROLE_NAME=$(echo "$IDENTITY" | jq -r '.fields[]? | select(.name=="aws_role_name") | .value // empty')
else
    AWS_ACCOUNT_ID="000000000000"
    AWS_SSO_START_URL="https://d-9067954177.awsapps.com/start"
    AWS_SSO_REGION="us-east-1"
    AWS_ROLE_NAME="AdministratorAccess"
fi

if [[ ! -f ~/.aws/config ]]; then
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
    echo "AWS config created"
else
    echo "AWS config already exists"
fi

echo "=== Setting up claude-sessions ==="
mkdir -p ~/claude-sessions/home ~/claude-sessions/work
if [[ ! -d ~/.config/claude-sessions ]] && [[ -f ~/.ssh/id_ed25519_home ]]; then
    git clone git@github.com-home:YOUR_USERNAME/claude-sessions-config.git ~/.config/claude-sessions 2>/dev/null && \
    bw get item "devbox/git-crypt-key" &>/dev/null && \
    cd ~/.config/claude-sessions && \
    git-crypt unlock <(bw get item "devbox/git-crypt-key" | jq -r '.fields[]? | select(.name=="key_b64") | .value' | base64 -d) 2>/dev/null && \
    cd - || echo "claude-sessions-config not available (optional)"
fi

echo "=== Setting up LifeMaestro ==="
if [[ ! -d ~/code/lifemaestro ]] && [[ -f ~/.ssh/id_ed25519_home ]]; then
    mkdir -p ~/code
    git clone git@github.com-home:YOUR_USERNAME/dotfiles.git ~/code/lifemaestro
    cd ~/code/lifemaestro && ./install.sh && cd -
    if [[ -d ~/code/lifemaestro/.claude ]]; then
        [[ -d ~/.claude && ! -L ~/.claude ]] && rm -rf ~/.claude
        ln -sfn ~/code/lifemaestro/.claude ~/.claude
    fi
    echo "LifeMaestro installed"
else
    echo "LifeMaestro already installed or SSH key missing"
fi

echo "=== Setting up Himalaya (email) ==="
mkdir -p ~/.config/himalaya
if [[ ! -f ~/.config/himalaya/config.toml ]] && bw get item "devbox/gmail-oauth" &>/dev/null; then
    GMAIL_EMAIL=$(bw get item "devbox/gmail-oauth" | jq -r '.login.username // empty')
    GMAIL_CLIENT_ID=$(bw get item "devbox/gmail-oauth" | jq -r '.fields[]? | select(.name=="client_id") | .value // empty')
    GMAIL_CLIENT_SECRET=$(bw get item "devbox/gmail-oauth" | jq -r '.fields[]? | select(.name=="client_secret") | .value // empty')

    if [[ -n "$GMAIL_EMAIL" && -n "$GMAIL_CLIENT_ID" && -n "$GMAIL_CLIENT_SECRET" ]]; then
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
        echo "Himalaya configured. Run: himalaya account configure gmail"
    else
        echo "Gmail OAuth credentials incomplete in Bitwarden"
    fi
else
    echo "Himalaya config exists or devbox/gmail-oauth not in Bitwarden (optional)"
fi

echo "=== Setting up gcalcli (Google Calendar) ==="
if [[ ! -f ~/.gcalcli_oauth ]] && bw get item "devbox/gmail-oauth" &>/dev/null; then
    GMAIL_CLIENT_ID=$(bw get item "devbox/gmail-oauth" | jq -r '.fields[]? | select(.name=="client_id") | .value // empty')
    GMAIL_CLIENT_SECRET=$(bw get item "devbox/gmail-oauth" | jq -r '.fields[]? | select(.name=="client_secret") | .value // empty')

    if [[ -n "$GMAIL_CLIENT_ID" && -n "$GMAIL_CLIENT_SECRET" ]]; then
        cat > ~/.gcalcli_oauth <<GCALCLI
{
  "client_id": "$GMAIL_CLIENT_ID",
  "client_secret": "$GMAIL_CLIENT_SECRET"
}
GCALCLI
        chmod 600 ~/.gcalcli_oauth
        echo "gcalcli configured. Run: gcalcli init"
    fi
else
    echo "gcalcli config exists or devbox/gmail-oauth not in Bitwarden (optional)"
fi

echo "=== Setting up MS365 (email + calendar) ==="
if bw get item "devbox/ms365-oauth" &>/dev/null; then
    MS365_EMAIL=$(bw get item "devbox/ms365-oauth" | jq -r '.login.username // empty')
    MS365_CLIENT_ID=$(bw get item "devbox/ms365-oauth" | jq -r '.fields[]? | select(.name=="client_id") | .value // empty')
    MS365_CLIENT_SECRET=$(bw get item "devbox/ms365-oauth" | jq -r '.fields[]? | select(.name=="client_secret") | .value // empty')
    MS365_TENANT_ID=$(bw get item "devbox/ms365-oauth" | jq -r '.fields[]? | select(.name=="tenant_id") | .value // empty')

    if [[ -n "$MS365_EMAIL" && -n "$MS365_CLIENT_ID" && -n "$MS365_TENANT_ID" ]]; then
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
            echo "Himalaya MS365 configured. Run: himalaya account configure ms365"
        fi

        mkdir -p ~/.config/thallo
        if [[ ! -f ~/.config/thallo/config.toml ]]; then
            cat > ~/.config/thallo/config.toml <<THALLO
[azure]
client_id = "$MS365_CLIENT_ID"
tenant_id = "$MS365_TENANT_ID"

[calendar]
default = "Calendar"
THALLO
            echo "thallo configured. Run: thallo authorize"
        fi
    else
        echo "MS365 OAuth credentials incomplete in Bitwarden"
    fi
else
    echo "devbox/ms365-oauth not in Bitwarden (optional)"
fi

echo "=== DONE ==="
echo "Run: aws sso login --profile home"
