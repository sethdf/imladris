# AWS DevBox

Terraform configuration for a reliable AWS cloud development workstation with spot pricing and Tailscale access.

## Why This Configuration?

**Instance: m7a.xlarge (AMD EPYC Gen 4)**
- 4 vCPUs, 16 GB RAM
- **~$0.06/hour spot** (vs $0.20 on-demand) = ~70% savings
- No CPU throttling (unlike t3 burstable instances)

**OS: Ubuntu Server 24.04 LTS**
- Native VS Code Remote support
- 5+ years of support
- Best package availability

**Storage: gp3 with upgraded throughput**
- 100 GB, 3000 IOPS, 250 MiB/s throughput
- Faster `npm install`, `git clone`, etc.
- Daily snapshots via DLM (7-day retention)

**Security: Tailscale (no public IP)**
- Zero exposed ports - no SSH to the internet
- Access from anywhere via encrypted mesh VPN
- Tailscale SSH for authentication (no keys to manage)

**Spot + Hibernation**
- Auto-hibernates on spot interruption (saves RAM state)
- Auto-restarts when capacity returns
- CLI warnings before shutdown

## Quick Start

### Prerequisites

Install these tools:
```bash
# macOS
brew install git-crypt sops age terraform tailscale

# Or see: https://github.com/getsops/sops, https://github.com/FiloSottile/age
```

You'll also need:
1. [Tailscale account](https://tailscale.com/) (free for personal use)
2. [Tailscale auth key](https://login.tailscale.com/admin/settings/keys) - create a reusable key
3. Tailscale installed on your local machine
4. AWS credentials configured

### First-Time Setup

```bash
# 1. Fork this repo, then clone your fork
git clone https://github.com/YOUR_USERNAME/aws-devbox.git
cd aws-devbox
make setup

# 2. Add your Tailscale auth key
sops secrets.yaml
# Edit: replace "tskey-auth-REPLACE-ME" with your key

# 3. IMPORTANT: Backup encryption keys to password manager
make backup-keys

# 4. Deploy
make apply

# 5. Connect (via Tailscale)
ssh devbox
```

### Recovering on a New Machine

```bash
# 1. Clone your fork
git clone https://github.com/YOUR_USERNAME/aws-devbox.git
cd aws-devbox

# 2. Restore keys from password manager
# Git-crypt key (decode base64 and unlock):
echo "YOUR_BASE64_KEY" | base64 -d > /tmp/gc-key
git-crypt unlock /tmp/gc-key && rm /tmp/gc-key

# Age key (for sops):
mkdir -p ~/.config/sops/age
cat > ~/.config/sops/age/keys.txt << 'EOF'
# paste your age key here
EOF

# 3. Now you can work normally
make plan
make apply
```

## Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `bitwarden_email` | (required) | Email for Bitwarden account |
| `github_username` | (required) | Your GitHub username (for script downloads) |
| `aws_region` | us-east-1 | AWS region |
| `instance_type` | m7a.xlarge | EC2 instance type |
| `volume_size` | 100 | Root volume size (GB) |
| `volume_iops` | 3000 | gp3 IOPS |
| `volume_throughput` | 250 | gp3 throughput (MiB/s) |
| `tailscale_auth_key` | (required) | Tailscale auth key |
| `tailscale_hostname` | devbox | Hostname in Tailscale |
| `use_spot` | true | Use spot instances (~70% savings) |
| `spot_max_price` | "" | Max spot price (empty = on-demand cap) |
| `notification_emails` | [] | Emails for spot interruption alerts |
| `spot_restart_attempts` | 5 | Retry attempts before giving up |
| `enable_schedule` | true | Enable auto start/stop schedule |
| `schedule_start` | 0 5 * * ? * | Cron for auto-start (5am) |
| `schedule_stop` | 0 23 * * ? * | Cron for auto-stop (11pm) |
| `schedule_timezone` | America/Denver | Timezone for schedule (Mountain) |

## Tailscale Access

Once deployed, access your devbox via Tailscale:

```bash
# SSH (uses Tailscale SSH - no keys needed)
ssh devbox

# Or with explicit user
ssh ubuntu@devbox
```

### VS Code Remote

Add to `~/.ssh/config`:
```
Host devbox
    HostName devbox
```

Then in VS Code: `Remote-SSH: Connect to Host...` → `devbox`

### Using as Exit Node (VPN)

You can route all your traffic through the devbox:

```bash
# On devbox: enable exit node
sudo tailscale up --advertise-exit-node

# On your machine: use devbox as exit node
tailscale up --exit-node=devbox
```

## Spot Instance Behavior

**How it works:**
1. Instance runs on spot pricing (~$0.06/hr)
2. If AWS reclaims capacity, you get 2-minute warning
3. Instance auto-hibernates (RAM saved to EBS)
4. Lambda auto-restarts when capacity returns
5. Instance resumes exactly where you left off

**Interruption frequency:** m7a.xlarge typically <5% monthly

**CLI Warnings:**
- Spot interruption: Wall broadcast + tmux notification
- Scheduled shutdown: 15-min and 5-min warnings

**To disable spot and use on-demand:**
```hcl
use_spot = false
```

## Scheduled Start/Stop

By default, the instance:
- **Hibernates at 11pm** Mountain Time (saves RAM state)
- **Starts at 5am** Mountain Time (resumes from hibernation)

This runs 18 hours/day instead of 24, saving ~25% more on top of spot savings.

**To customize the schedule:**
```hcl
schedule_start    = "0 6 * * ? *"   # 6am
schedule_stop     = "0 22 * * ? *"  # 10pm
schedule_timezone = "America/New_York"  # Eastern
```

**To disable scheduling:**
```hcl
enable_schedule = false
```

**Working late?** Just keep working. It'll hibernate at 11pm, you manually start it if needed.

## What's Installed

### Core Development
- Docker + Docker Compose
- Node.js LTS
- Python 3 + pip + venv
- Zsh + Oh My Zsh
- git, curl, jq, htop, tmux

### Productivity Tools
| Tool | Description | Alias |
|------|-------------|-------|
| `fzf` | Fuzzy finder (Ctrl-r for history) | - |
| `zoxide` | Smarter cd that learns your dirs | `z` |
| `direnv` | Auto-load .envrc per directory | - |
| `lazygit` | Git TUI | `lg` |
| `lazydocker` | Docker TUI | `ld` |
| `delta` | Better git diffs (auto-configured) | - |
| `mise` | Version manager (node/python/go) | - |
| `eza` | Modern ls with git status | `ls`, `ll`, `lt` |
| `bat` | Cat with syntax highlighting | `cat` |
| `ripgrep` | Fast grep | `rg` |
| `fd` | Fast find | `fd` |
| `ncdu` | Interactive disk usage | `ncdu` |
| `tldr` | Simplified man pages | `tldr` |

### Cloud Provider CLIs
| Tool | Description | Alias |
|------|-------------|-------|
| AWS CLI v2 | Amazon Web Services | `aws-whoami` |
| AWS SSM Plugin | Session Manager support | - |
| Azure CLI | Microsoft Azure | `az-whoami` |
| Google Cloud CLI | GCP | `gcp-whoami` |

### Windows / Microsoft 365 Admin
| Tool | Description |
|------|-------------|
| PowerShell Core | Cross-platform PowerShell (`pwsh`) |
| CLI for Microsoft 365 | M365 administration (`m365`) |
| Microsoft.Graph | PowerShell module for Graph API |
| Az | PowerShell module for Azure |
| ExchangeOnlineManagement | Exchange Online admin |
| MicrosoftTeams | Teams admin |

## Cloud Authentication

```bash
# AWS
aws configure
# or
aws sso login --profile your-profile

# Azure
az login

# GCP
gcloud auth login
gcloud config set project YOUR_PROJECT

# Microsoft 365
m365 login

# PowerShell (Graph/Exchange/Teams)
pwsh
Connect-MgGraph -Scopes "User.Read.All"
Connect-ExchangeOnline
Connect-MicrosoftTeams
```

## Manual Controls

```bash
# Stop instance (compute charges stop, EBS continues)
aws ec2 stop-instances --instance-ids $(terraform output -raw instance_id)

# Hibernate instance (saves RAM to disk)
aws ec2 stop-instances --instance-ids $(terraform output -raw instance_id) --hibernate

# Start instance
aws ec2 start-instances --instance-ids $(terraform output -raw instance_id)
```

## Cost Comparison

| Configuration | Monthly Cost |
|---------------|--------------|
| On-demand 24/7 | ~$150 |
| On-demand 50hr/week | ~$43 |
| Spot 24/7 | ~$45 |
| Spot + schedule (18hr/day) | ~$33 |
| **Spot + schedule (actual ~10hr/day use)** | **~$18** |
| Stopped (storage only) | ~$10 |

## Destroy

```bash
terraform destroy
```

Note: Root volume has `delete_on_termination = false` for safety. Delete manually if needed.
