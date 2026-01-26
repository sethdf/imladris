# Imladris

Terraform-managed AWS development workstation with LUKS encryption, Tailscale access, and Claude Code integration.

## Overview

Imladris is a cloud development environment built on [PAI (Personal AI Infrastructure)](https://github.com/danielmiessler/Personal_AI_Infrastructure) and designed for security, reliability, and AI-assisted development. It provides:

- **Secure Access:** Tailscale VPN only (zero public ports)
- **Encrypted Storage:** LUKS-encrypted persistent data volume
- **Declarative Config:** Nix + home-manager for reproducible environment
- **AI Integration:** Claude Code via AWS Bedrock (auto-refreshing credentials)
- **Cost Optimized:** ARM64 Graviton instances with spot pricing support

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  VPC (10.0.0.0/16)                                          │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Public Subnet (10.0.1.0/24)                           │ │
│  │  ┌──────────────────┐    ┌──────────────────────────┐  │ │
│  │  │ EC2 Instance     │    │ EBS Data Volume          │  │ │
│  │  │ (imladris)       │────│ (hall-of-fire)           │  │ │
│  │  │ m7g.xlarge       │    │ LUKS encrypted           │  │ │
│  │  │ Ubuntu 24.04     │    │ Hourly DLM snapshots     │  │ │
│  │  └──────────────────┘    └──────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
              │
              │ Tailscale VPN (encrypted mesh)
              │
         ┌────┴────┐
         │ Client  │
         └─────────┘
```

## PAI (Personal AI Infrastructure)

**Imladris is built on [PAI (Personal AI Infrastructure)](https://github.com/danielmiessler/Personal_AI_Infrastructure)**, a framework for personalized AI assistants by Daniel Miessler.

PAI provides the skill system, hooks, memory, and workflows that power the Claude Code integration. Imladris extends PAI with:

- **Infrastructure as Code** - Terraform-managed cloud environment
- **LUKS encryption** - MFA-protected persistent storage
- **Cross-account AWS access** - Secure role assumption
- **Context separation** - Work/home isolation via direnv
- **ServiceDesk Plus integration** - Ticket management skills

### PAI Components Used

| Component | Purpose |
|-----------|---------|
| **Skills** | Domain-specific capabilities (`~/.claude/skills/`) |
| **Hooks** | Lifecycle event handlers (`~/.claude/hooks/`) |
| **Memory** | Session history and learnings (`~/.claude/MEMORY/`) |
| **Response Format** | Structured output with voice synthesis |
| **The Algorithm** | Current State → Ideal State execution |

### Setup

PAI is installed automatically by `imladris-init`. Custom skills are cloned from `sethdf/curu-skills`.

```bash
# PAI structure after init
~/.claude/
├── skills/          # PAI + custom skills
├── hooks/           # Event handlers
├── MEMORY/          # Session history
└── settings.json    # Identity & config
```

## Quick Start

### Prerequisites

- AWS credentials configured
- [Tailscale account](https://tailscale.com/) with auth key
- [Bitwarden Secrets Manager](https://bitwarden.com/products/secrets-manager/) access token
- Terraform installed
- Familiarity with [PAI](https://github.com/danielmiessler/Personal_AI_Infrastructure) concepts

### Deploy

```bash
# Clone repository
git clone git@github.com:sethdf/imladris.git
cd imladris

# Initialize Terraform
terraform init

# Deploy (requires tfvars or BWS for secrets)
source scripts/bws-init.sh
terraform apply \
  -var="github_username=sethdf" \
  -var="tailscale_auth_key=$(bws_get tailscale-auth-key)" \
  -var="tailscale_api_key=$(bws_get tailscale-api-key)"
```

### First Connection

```bash
# Connect via Tailscale
ssh imladris

# Initialize LUKS and setup environment
imladris-init
# Prompts for: BWS token, LUKS passphrase

# Start Claude Code
claude
```

### After Reboot

```bash
ssh imladris
imladris-init    # Unlock LUKS only (BWS token cached)
```

## Infrastructure

### AWS Resources

| Resource | Configuration |
|----------|---------------|
| **VPC** | `10.0.0.0/16` with public subnet |
| **EC2** | `m7g.xlarge` ARM64/Graviton3 (4 vCPU, 16GB RAM) |
| **Root Volume** | 50GB gp3 (6000 IOPS, 500 MiB/s) |
| **Data Volume** | 100GB gp3 LUKS-encrypted ("hall-of-fire", 6000 IOPS, 500 MiB/s) |
| **Security Group** | Zero ingress (Tailscale only) |
| **DLM** | Hourly snapshots, 24-hour retention |

### IAM Permissions

The instance profile (`imladris-instance-role`) has minimal permissions:

- **EBS:** Attach/detach own volume (conditional on Project tag)
- **Bedrock:** Invoke Anthropic models
- **STS:** AssumeRole for cross-account access

### Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `aws_region` | `us-east-1` | AWS region |
| `architecture` | `arm64` | CPU architecture |
| `instance_type` | `m7g.xlarge` | Instance size |
| `volume_size` | `50` | Root volume GB |
| `data_volume_size` | `100` | Data volume GB |
| `volume_iops` | `6000` | EBS gp3 IOPS |
| `volume_throughput` | `500` | EBS gp3 throughput MiB/s |
| `hostname` | `imladris` | Instance hostname |
| `github_username` | (required) | For script downloads |
| `tailscale_auth_key` | (required) | Tailscale auth |
| `tailscale_api_key` | (required) | Tailscale API |

## Scripts

All scripts are in `scripts/` and symlinked to `~/bin` for easy access.

### Core Scripts

| Script | Purpose |
|--------|---------|
| `imladris-init` | Full initialization: LUKS setup with MFA (BWS keyfile + passphrase), BWS secrets management, directory setup (work/home separation), skills installation, shell integration, repo watch (gitwatch) |
| `imladris-unlock` | Quick unlock for reboots: LUKS MFA only, persists BWS token to encrypted volume, creates shell export file for new sessions |
| `imladris-check` | Health check: BWS connectivity, required secrets (luks-keyfile, tailscale-*), LUKS volume status, Tailscale connection |
| `imladris-restore` | Status display showing LUKS, network, directories; can auto-unlock LUKS |

### Authentication & Cloud Access

| Script | Purpose |
|--------|---------|
| `auth-keeper` | Unified lazy auth for multiple services: AWS SSO (auto-refresh before expiry), Azure CLI, Google OAuth, MS365 PowerShell, Slack CLI, Telegram, Signal, ServiceDesk Plus. Provides `auth-keeper status` overview and service-specific commands |
| `asudo` | Cloud access control with audit logging. Like sudo but for cloud: `asudo aws dev`, `asudo aws prod --admin`, `asudo azure sub`, `asudo gcp project`. Supports AWS (ReadOnly/Admin roles), Azure subscriptions, GCP projects, M365 access levels. All admin access logged with justification |
| `bws-init` | Bitwarden Secrets Manager helpers: `bws_get`, `bws_exists`, `bws_set`, `bws_list`. Auto-initializes BWS token from file or LUKS. Source this script in shell |
| `claude-backend` | Switch Claude Code backends: `bedrock` (AWS billing via instance role), `team` (Team Premium OAuth), `personal` (Personal Max OAuth). Manages auth.json backup/restore via BWS. Warns if Claude running |

### Backup Scripts

| Script | Purpose |
|--------|---------|
| `backup-stateful` | Backup AI/stateful content to /data/backups: ~/.claude, repos, bin, config, ssh, aws, secrets. Keeps 7 days of daily backups with rsync |
| `backup-to-s3` | Sync /data/backups to S3 with Intelligent Tiering. Requires BACKUP_S3_BUCKET env var |
| `backup-luks-to-s3` | Full LUKS volume backup to S3 Glacier. Streams directly if insufficient temp space. Preserves encryption |
| `backup-to-gdrive` | Sync /data to Google Drive via rclone. Excludes lost+found and backups. Requires rclone gdrive remote configured |
| `backup-status` | Show backup status: local backups, latest backup size, scheduled timer, DLM snapshot status |
| `backup-overview` | Display backup strategy documentation: EBS snapshots (hourly), file-level sync (daily), S3 offsite (optional) |

### Session & Sync Scripts

| Script | Purpose |
|--------|---------|
| `session-sync` | Real-time git sync daemon using inotifywait. Watches directory, debounces changes (30s), auto-commits/pushes. Run as systemd service |
| `session-sync-setup` | Initialize session sync: creates git repo, configures remote, installs systemd service template, enables auto-sync |

### Messaging Scripts

| Script | Purpose |
|--------|---------|
| `signal-interface` | Signal as command interface for PAI. Link phone, send/receive messages, process commands (status, ping, uptime, ip). Uses signal-cli |
| `signal-inbox` | Capture Signal messages to ~/inbox with markdown frontmatter. Commands (/ping, /status, /help) get responses; text messages saved to inbox |
| `telegram-inbox` | Capture Telegram messages to ~/inbox via bot API. Similar command interface (/ping, /status, /inbox). Runs as daemon or foreground |

### PAI/Claude Scripts

| Script | Purpose |
|--------|---------|
| `pai-today` | Show today's Claude Code activity from ~/.claude/history.jsonl with timestamps |
| `pai-log` | View Claude sessions: today's files, current/latest session, list all sessions, prompts |

### Bootstrap Scripts

| Script | Purpose |
|--------|---------|
| `user-data-nix` | EC2 user-data script for new instances: system setup, Docker, Tailscale, Nix installation, home-manager, Claude Code & MCP servers, bws CLI. Used by Terraform |
| `user-data-legacy` | Legacy non-Nix bootstrap: apt packages, oh-my-zsh, tmux plugins, spot interruption handler. Deprecated in favor of Nix |

### Cross-Account Management

| Script | Purpose |
|--------|---------|
| `aws-accounts-config` | Generate ~/.aws/config from BWS secret aws-cross-accounts. Commands: generate, list, test, add. Profile names: {name}-{role-suffix} |
| `setup-cross-account-roles` | Create ImladrisReadOnly/ImladrisAdmin roles in target accounts. Configures trust policy for imladris instance role. Run locally with SSO access |
| `bws-create-secrets` | Create required BWS secrets with placeholders: tailscale-*, luks-keyfile, sdp-*, aws-cross-accounts, sessions-git-repo |

### Utility Scripts

| Script | Purpose |
|--------|---------|
| `tmux-session-colors` | Tmux zone-based color theming. Colors pane borders/status by context: green (home), blue (work), red (prod/admin), purple (other). Called by direnv/session hooks |

## Context Separation

Work and personal contexts are separated via direnv:

```
/data/
├── work/                    # Work context
│   ├── .envrc               # CONTEXT=work, SDP_*, work GHQ_ROOT
│   ├── repos/               # Work repositories
│   ├── tickets/             # ServiceDesk Plus workspaces
│   │   └── SDP-12345/
│   │       ├── .ticket.json
│   │       └── notes.md
│   └── notes/
│
└── home/                    # Personal context
    ├── .envrc               # CONTEXT=home, home GHQ_ROOT
    ├── repos/               # Personal repositories
    └── projects/
```

### Switching Contexts

```bash
cd ~/work     # Sets CONTEXT=work automatically
cd ~/home     # Sets CONTEXT=home automatically
ctx work      # Quick switch alias
ctx home      # Quick switch alias
```

### Context Variables

| Variable | Work Value | Home Value |
|----------|------------|------------|
| `CONTEXT` | `work` | `home` |
| `GHQ_ROOT` | `/data/work/repos` | `/data/home/repos` |
| `SDP_TICKETS_DIR` | `/data/work/tickets` | - |

## Claude Code Integration

### Bedrock Backend

Claude Code uses AWS Bedrock with instance profile credentials:

```bash
# Environment (set in shell config)
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=us-east-1

# Start Claude
claude
```

No API keys to manage - credentials auto-refresh via IMDSv2.

### Backend Switching

```bash
claude-backend bedrock              # AWS Bedrock (default)
claude-backend bedrock --account dev # Via role assumption
claude-backend team                 # Claude Team plan
claude-backend personal             # Claude Personal plan
claude-backend status               # Show current config
```

### Cross-Account Access

The instance role can assume roles in other AWS accounts:

```bash
# Configure in target account trust policy
# Then use asudo for authorization
asudo aws dev              # Readonly access
asudo aws prod --admin     # Admin access (logged)
asudo status               # Show current access
asudo clear                # Revoke all access
```

## Security

### LUKS Encryption

The data volume (`/data`) is LUKS-encrypted with two factors:

1. **Keyfile** - Stored in Bitwarden Secrets Manager
2. **Passphrase** - Entered interactively

```bash
# Unlock flow
imladris-init
# → Retrieves keyfile from BWS
# → Prompts for passphrase
# → Mounts /data
```

### Bitwarden Secrets Manager

Secrets are stored in BWS, retrieved on-demand:

```bash
# Helper functions (from bws-init)
bws_get "secret-name"     # Get secret value
bws_exists "secret-name"  # Check if exists
bws_list                  # List all secrets
```

**Required Secrets:**
- `luks-keyfile` - LUKS encryption key
- `tailscale-auth-key` - Tailscale authentication
- `tailscale-api-key` - Tailscale API access

**Optional Secrets:**
- `sdp-base-url`, `sdp-api-key`, `sdp-technician-id` - ServiceDesk Plus
- `github-token` - GitHub CLI authentication
- AWS account mappings for cross-account access

### Network Security

- **No public SSH** - Security group has zero ingress rules
- **IMDSv2 enforced** - Prevents SSRF attacks on metadata
- **Tailscale SSH** - End-to-end encrypted, identity-based access

## Nix Configuration

### Packages (via home-manager)

The environment is declaratively managed in `nix/home.nix`:

**Development:**
- git, git-crypt, gh, lazygit, delta
- Node.js 20, Python 3.11, Go, Bun
- gcc, make

**CLI Tools:**
- ripgrep, fd, bat, eza, fzf
- jq, yq, htop, ncdu, tree
- yt-dlp (media/transcripts)

**Cloud CLIs:**
- awscli2, azure-cli, google-cloud-sdk
- powershell (Microsoft Graph SDK for M365)

**Shell:**
- zsh with starship prompt
- tmux with plugins (resurrect, continuum, catppuccin)
- direnv, zoxide, mise, ghq

**Messaging:**
- signal-cli (Signal notifications)

**Services:**
- gnome-keyring (OAuth2 token caching)
- inotify-tools, mosh

### Shell Aliases

```bash
# Modern replacements
ls → eza              # Modern ls (also ll, la, lt)
cat → bat             # Syntax highlighting

# TUI tools
lg → lazygit          # Git TUI
ld → lazydocker       # Docker TUI

# DevBox
init → imladris-init  # Initialize/unlock
check → imladris-check
restore → imladris-restore

# Cloud access
ms365 → auth-keeper ms365    # MS365 PowerShell
gmail → auth-keeper google   # Gmail access
gcal → auth-keeper google calendar

# Navigation
repos → ghq-cd        # FZF repo switcher
ta → tmux attach      # Attach to main session
```

### Applying Changes

```bash
# After editing nix/home.nix
home-manager switch --flake .#ubuntu
```

## Backup Strategy

### Three-Tier Approach

1. **DLM Snapshots** - Hourly, 24-hour retention (fast recovery)
2. **Stateful Backups** - Daily to /data, 7-day retention
3. **S3 Offsite** - Optional encrypted backup to S3

### What's Backed Up

- `~/.claude` - Session history, skills, hooks
- `~/repos` - All repositories
- `~/.config` - Application config
- `~/.ssh` - SSH keys
- `~/.aws` - AWS configuration

### Recovery

```bash
# From snapshot
imladris-restore

# From backup
ls /data/backups/latest/
cp -r /data/backups/latest/claude ~/.claude
```

## Development Workflow

### Repository Structure

```
~/repos/github.com/
├── sethdf/
│   ├── imladris/        # This repo
│   └── curu-skills/     # Custom skills
├── anthropics/
│   └── skills/          # Official skills
└── danielmiessler/
    └── Personal_AI_Infrastructure/  # PAI framework
```

### Working with Scripts

```bash
# Edit script in repo
cd ~/repos/github.com/sethdf/imladris
vim scripts/imladris-init.sh

# Deploy to live location
cp scripts/imladris-init.sh ~/bin/

# Commit changes
git add . && git commit && git push
```

### Working with Skills

```bash
# Edit skill
cd ~/repos/github.com/sethdf/curu-skills
vim MySkill/SKILL.md

# Sync to Claude
cp -r MySkill ~/.claude/skills/

# Or use sync helpers
curu-sync     # Copy skills to repo
curu-commit   # Sync + commit
curu-watch    # Auto-sync daemon
```

## ServiceDesk Plus Integration

Work tickets are managed via the SDP skill:

```bash
# List assigned tickets
/sdp-list

# Full ticket operations
/servicedesk-plus

# Ticket workspace
cd ~/work/tickets/SDP-12345
# → Auto-loads ticket context via SessionStart hook
```

### Workspace Structure

```
~/work/tickets/SDP-12345/
├── .ticket.json     # Cached metadata
├── notes.md         # Working notes → synced as private notes
└── replies/         # Public replies to requester
```

## Commands Reference

### Terraform

```bash
terraform init           # Initialize
terraform plan           # Preview changes
terraform apply          # Deploy
terraform output         # Show outputs
```

### Instance Management

```bash
# Via Terraform outputs
ssh imladris             # Connect via Tailscale
imladris-init            # Initialize/unlock
imladris-check           # Health check

# Manual controls
aws ec2 stop-instances --instance-ids $(terraform output -raw instance_id)
aws ec2 start-instances --instance-ids $(terraform output -raw instance_id)
```

### Claude Code

```bash
claude                   # Start Claude Code
claude-backend status    # Check backend
asudo status      # Check cloud access
```

## Cost Optimization

| Configuration | Monthly Cost |
|---------------|--------------|
| On-demand 24/7 | ~$150 |
| Spot 24/7 | ~$45 |
| Spot + schedule (18hr/day) | ~$33 |
| Actual use (~10hr/day) | ~$18 |
| Stopped (storage only) | ~$10 |

## File Reference

| Path | Purpose |
|------|---------|
| `main.tf` | Core infrastructure |
| `variables.tf` | Input variables |
| `outputs.tf` | Output values |
| `nix/home.nix` | User environment config |
| `nix/flake.nix` | Nix flake inputs |
| `scripts/` | Operational scripts |
| `skills/` | Claude skills (SDP) |
| `CLAUDE.md` | AI assistant guide |

## Conventions

- **Instance hostname:** `imladris`
- **Data volume name:** `hall-of-fire`
- **Default region:** `us-east-1`
- **Package management:** Nix (not apt)
- **Shell:** zsh with starship
- **Skills format:** PAI (`SkillName/SKILL.md`)

## License

Private repository for personal use.
