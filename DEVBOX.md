# DevBox Reference

Complete reference for the AWS DevBox infrastructure and workflows.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Terraform (main.tf)                                            │
│  - AWS infrastructure (VPC, EC2, EBS, Lambda)                   │
│  - Provisions instance with user-data bootstrap                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Nix + home-manager (nix/)                                      │
│  - All packages (ghq, lazygit, fzf, etc.)                       │
│  - Shell config, tmux, git                                      │
│  - Declarative, reproducible                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  LUKS Encrypted Volume (/data)                                  │
│  - Work files: /data/work (repos, tickets)                      │
│  - Home files: /data/home (repos, projects)                     │
│  - Persists across instance rebuilds                            │
└─────────────────────────────────────────────────────────────────┘
```

## Directory Structure

### On Instance (`/home/ubuntu/`)

```
/home/ubuntu/
├── work → /data/work           # Work files (symlink)
├── home → /data/home           # Home files (symlink)
├── .claude/                    # PAI (unified, default location)
│   ├── history/                # Session history
│   ├── hooks/                  # PAI hooks
│   └── skills/                 # Installed skills
├── bin/                        # Installed scripts
│   ├── sdp-api                 # SDP API helper
│   ├── sdp-work                # SDP workflow manager
│   ├── devbox-init             # LUKS/directory setup
│   ├── devbox-check            # Health check
│   └── devbox-restore          # Session restore
└── .nix-profile/               # Nix-managed packages
```

### Encrypted Volume (`/data/`)

```
/data/
├── work/                       # Work files
│   ├── .envrc                  # direnv: CONTEXT, GHQ_ROOT, SDP_*
│   ├── repos/                  # Work repos (ghq)
│   ├── tickets/                # SDP ticket workspaces
│   │   └── SDP-12345/
│   │       ├── notes.md        # Private notes → SDP
│   │       └── replies/        # Public replies → SDP
│   └── notes/                  # Work notes
│
└── home/                       # Home files
    ├── .envrc                  # direnv: CONTEXT, GHQ_ROOT
    ├── repos/                  # Personal repos (ghq)
    ├── projects/               # Side projects
    └── notes/                  # Personal notes
```

## Scripts Reference

### Bootstrap Scripts (run by Terraform user-data)

| Script | Purpose |
|--------|---------|
| `scripts/user-data-nix.sh` | Bootstrap: Nix, Docker, Tailscale, spot handler |
| `scripts/user-data-legacy.sh` | Legacy bash-based bootstrap (fallback) |

### DevBox Management

| Script | Purpose | Usage |
|--------|---------|-------|
| `devbox-init` | Initialize LUKS, create contexts | Run once after first boot |
| `devbox-check` | Health check (BWS, LUKS, Tailscale) | `devbox-check` |
| `devbox-restore` | Restore tmux sessions | Auto-runs on SSH login |

### ServiceDesk Plus

| Script | Purpose | Usage |
|--------|---------|-------|
| `sdp-api` | Low-level SDP API calls | `sdp-api list`, `sdp-api note 123 "msg"` |
| `sdp-work` | Ticket workflow manager | `sdp-work start 123`, `sdp-work sync` |

#### SDP Commands

```bash
# List tickets
sdp-api list

# Get ticket details
sdp-api get 12345
sdp-api get 12345 --json

# Add private note (technicians only)
sdp-api note 12345 "Root cause: config issue"

# Add public reply (visible to requester)
sdp-api reply 12345 "Issue has been resolved"

# Sync local notes file to SDP
sdp-api sync-notes 12345 notes.md

# Get all notes from ticket
sdp-api get-notes 12345

# Update status
sdp-api status 12345 "Resolved"

# Search
sdp-api search "login timeout"
```

#### SDP Workflow

```bash
# Start working on ticket
sdp-work start 12345
cd ~/work/tickets/SDP-12345

# Add notes as you investigate (edit notes.md)
vim notes.md

# Sync notes to SDP (private)
sdp-work sync

# Draft reply
sdp-work reply
vim replies/2025-01-08.md

# Send reply (public)
sdp-work send-reply

# Finish work
sdp-work done
```

## Context Switching

GHQ_ROOT auto-switches via direnv when you `cd`:

```bash
$ cd ~/work
direnv: export CONTEXT=work GHQ_ROOT=/data/work/repos SDP_TICKETS_DIR=/data/work/tickets

$ cd ~/home
direnv: export CONTEXT=home GHQ_ROOT=/data/home/repos

# Quick switch
$ ctx work
$ ctx home
$ ctx          # Show current
```

### What Changes Per Context

| Variable | Work | Home |
|----------|------|------|
| `CONTEXT` | work | home |
| `GHQ_ROOT` | /data/work/repos | /data/home/repos |
| `SDP_TICKETS_DIR` | /data/work/tickets | (not set) |
| `SDP_*` credentials | (set via work/.envrc) | (not set) |

**PAI (Claude Code)** uses the default `~/.claude` location - unified across both contexts.

## Nix Configuration

### Updating Packages

```bash
# Edit config
cd ~/repos/github.com/dacapo-labs/host/nix
vim home.nix

# Apply changes (no reboot needed)
home-manager switch --flake .#ubuntu

# Rollback if broken
home-manager rollback
```

### Key Packages Installed

- **Dev tools**: git, lazygit, delta, gh, ghq
- **Search**: ripgrep, fd, fzf, bat, eza
- **Languages**: nodejs, python, go, bun
- **Cloud CLIs**: awscli2, azure-cli, gcloud
- **Shell**: zsh, oh-my-zsh, tmux, direnv, zoxide

## Repo Management (ghq)

```bash
# Clone repo (goes to $GHQ_ROOT/github.com/user/repo)
ghq get user/repo

# List all repos
ghq list

# Jump to repo (with fzf)
cd $(ghq list | fzf | xargs -I{} echo "$GHQ_ROOT/{}")

# Or use the alias
repos    # fuzzy-find and cd to repo
```

## Common Workflows

### First Boot

```bash
# 1. SSH in via Tailscale
ssh devbox

# 2. Initialize LUKS and contexts
devbox-init

# 3. Allow direnv for contexts
cd ~/work && direnv allow
cd ~/home && direnv allow

# 4. Clone essential repos
cd ~/work
ghq get dacapo-labs/host
ghq get danielmiessler/Personal_AI_Infrastructure

# 5. Start Claude
claude
```

### Daily Workflow

```bash
# Start work
ssh devbox
# (auto-attaches to tmux)

# Switch to work context
ctx work

# List tickets
sdp-api list

# Work on a ticket
sdp-work start 12345
# ... investigate, fix ...
sdp-work sync
sdp-work done

# Personal stuff
ctx home
cd projects/my-app
```

### Updating DevBox Config

```bash
# Pull latest
cd ~/work/repos/github.com/dacapo-labs/host
git pull

# Re-run init to install updated scripts
devbox-init

# Or manually copy specific script
cp skills/servicedesk-plus/src/sdp-api.sh ~/bin/sdp-api
```

### Updating Nix Packages

```bash
cd ~/work/repos/github.com/dacapo-labs/host/nix
# Edit home.nix to add/change packages
home-manager switch --flake .#ubuntu
```

## Secrets (Bitwarden Secrets Manager)

Required secrets in BWS:

| Secret | Purpose |
|--------|---------|
| `tailscale-auth-key` | Join Tailscale network |
| `tailscale-api-key` | Device cleanup |
| `luks-key` | LUKS encryption passphrase |
| `sdp-base-url` | ServiceDesk Plus URL |
| `sdp-api-key` | SDP API authentication |
| `sdp-technician-id` | Your technician ID |
| `sessions-git-repo` | Git repo for session sync |

## Terraform Variables

Key variables in `terraform.tfvars`:

```hcl
# Required
github_username = "your-username"

# Instance
instance_type = "m7g.xlarge"    # ARM (Graviton)
architecture  = "arm64"
use_spot      = true            # ~70% cost savings

# Build mode
use_nix = true                  # Nix (recommended) or legacy bash

# Schedule (auto start/stop)
enable_schedule   = true
schedule_start    = "0 5 * * ? *"   # 5am
schedule_stop     = "0 23 * * ? *"  # 11pm
schedule_timezone = "America/Denver"
```

## Troubleshooting

### Check Health

```bash
devbox-check
```

### LUKS Won't Unlock

```bash
# Check BWS connection
bws secret list

# Manual unlock
sudo cryptsetup open /dev/nvme1n1 data
sudo mount /dev/mapper/data /data
```

### Nix Issues

```bash
# Rebuild
home-manager switch --flake .#ubuntu

# Rollback
home-manager generations
home-manager switch --rollback

# Check logs
journalctl --user -u home-manager-ubuntu
```

### Context Not Switching

```bash
# Re-allow direnv
cd ~/work && direnv allow
cd ~/home && direnv allow

# Check .envrc exists
cat /data/work/.envrc
```

## File Locations Quick Reference

| What | Where |
|------|-------|
| Terraform config | `host/main.tf`, `host/variables.tf` |
| Nix config | `host/nix/flake.nix`, `host/nix/home.nix` |
| Bootstrap script | `host/scripts/user-data-nix.sh` |
| DevBox scripts | `host/scripts/devbox-*.sh` |
| SDP skill | `host/skills/servicedesk-plus/` |
| PAI (unified) | `~/.claude/` |
| Work repos | `/data/work/repos/` |
| Home repos | `/data/home/repos/` |
| Tickets | `/data/work/tickets/` |
