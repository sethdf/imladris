# Imladris DevBox - AI Assistant Guide

Terraform-managed AWS development workstation with Tailscale VPN access, built on [PAI (Personal AI Infrastructure)](https://github.com/danielmiessler/Personal_AI_Infrastructure).

## Project Overview

**Foundation:** [PAI](https://github.com/danielmiessler/Personal_AI_Infrastructure) - Skills, hooks, memory, response format
**Purpose:** Cloud dev environment with persistent LUKS-encrypted storage
**Instance:** EC2 m7g.xlarge (ARM64/Graviton3, 4 vCPU, 16GB RAM)
**Access:** Tailscale mesh VPN (zero public ports)
**Storage:** LUKS-encrypted EBS volume (hall-of-fire) with hourly snapshots
**Volumes:** Root 50GB + Data 100GB, gp3 (6000 IOPS, 500 MiB/s)
**AI:** Claude Code via AWS Bedrock (auto-refreshing credentials)

## Claude Code / Bedrock Setup

Claude Code uses AWS Bedrock with instance profile credentials (auto-refresh, never expires).

```bash
# Set environment variables (add to ~/.zshrc for persistence)
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=us-east-1

# Start Claude
claude
```

The IAM instance profile has `bedrock:InvokeModel` permissions for all Anthropic models.

## 5-Zone Workflow System

Simplified workspace organization to prevent session sprawl and reduce startup friction.

### The 5 Zones

| Zone | Command | Directory | Purpose |
|------|---------|-----------|---------|
| **home** | `/home` | `~/home` | Personal projects, PAI, imladris, finances |
| **work** | `/work` | `~/work` | Primary work tasks and projects |
| **research** | `/research` | `~/work/research` | Investigation, learning, exploration |
| **tasks** | `/tasks` | `~/work/tasks` | Tickets, requests, changes, actionable items |
| **adhoc** | `/adhoc` | `~/work/adhoc` | Quick one-off questions, temp work |

### Rules

1. **One tmux session** - Use `main` session only
2. **Max 5 windows** - One per zone (duplicates prevented automatically)
3. **Zone commands switch, don't create** - `/work` switches to existing work window if open

### Daily Startup

```
SSH → tmux attach → /startup or /dashboard → Pick ONE zone → /work or /home etc
```

### Auth is Automatic

Don't hunt for credentials. Auth-keeper handles everything:
- **Check status:** `auth-keeper status`
- **AWS/Azure/MS365:** Commands auto-authenticate via lazy loading
- **Secrets:** BWS (Bitwarden Secrets) - use `bws_get "secret-name"`

### Tmux Quick Reference

| Action | Keys |
|--------|------|
| Switch window | `Ctrl-b n` (next) or `Ctrl-b 1-5` |
| List windows | `Ctrl-b w` |
| Detach | `Ctrl-b d` |
| Reattach | `tmux attach` |

## Cross-Account AWS Access

The instance role has `sts:AssumeRole` permission, enabling access to any AWS account that trusts it.

### Setup in Target Accounts

In each AWS account you want to access, update the role's trust policy to allow the imladris instance role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::IMLADRIS_ACCOUNT_ID:role/imladris-instance-role"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

### Account Registry (BWS)

Accounts are stored in BWS secret `aws-cross-accounts` as a JSON array:

```json
[
  {
    "id": "111111111111",
    "name": "org-dev",
    "roles": ["ReadOnlyAccess", "AdministratorAccess"],
    "purpose": "Development environment"
  },
  {
    "id": "222222222222",
    "name": "org-prod",
    "roles": ["ReadOnlyAccess"],
    "purpose": "Production (read-only)"
  }
]
```

### Managing Accounts

```bash
# Add a new account interactively
aws-accounts-config add

# List configured accounts
aws-accounts-config list

# Regenerate ~/.aws/config from BWS
aws-accounts-config generate

# Test access to all accounts
aws-accounts-config test
```

Generated profile names follow the pattern `{name}-{role-suffix}`:
- `org-dev-readonly` (for ReadOnlyAccess)
- `org-dev-admin` (for AdministratorAccess)
- `org-prod-readonly`

### Usage

```bash
# Use specific profile
aws --profile org-dev-readonly s3 ls
aws --profile org-dev-admin ec2 describe-instances

# Set default profile
export AWS_PROFILE=org-dev-readonly
aws s3 ls
```

No authentication flows, no token expiry, just works.

## Repository Structure

**Important:** Local repo clones are separate from running scripts/skills.

```
GitHub
  │
  ├── sethdf/imladris      (this repo - infra & scripts)
  └── sethdf/curu-skills   (custom Claude skills)
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  imladris instance                                          │
│                                                             │
│  ~/repos/github.com/sethdf/imladris/   ← working copy      │
│  ~/repos/github.com/sethdf/curu-skills/ ← working copy     │
│  ~/repos/github.com/anthropics/skills/  ← official skills  │
│  ~/repos/github.com/danielmiessler/Personal_AI_Infrastructure/ │
│                                                             │
│  ~/bin/imladris-init    ← downloaded from GitHub           │
│  ~/.claude/skills/      ← copied from repos                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Key point:** Editing `~/repos/.../imladris-init.sh` does NOT update `~/bin/imladris-init`.

## Development Workflow

### Editing Scripts

```bash
# Edit in repo
cd ~/repos/github.com/sethdf/imladris
vim scripts/imladris-init.sh

# Test locally (copy to live location)
cp scripts/imladris-init.sh ~/bin/

# When happy, commit & push
git add -A && git commit -m "fix: whatever" && git push
```

### Editing Skills

```bash
# Edit in repo
cd ~/repos/github.com/sethdf/curu-skills
vim MySkill/SKILL.md

# Sync to Claude
cp -r MySkill ~/.claude/skills/

# Or re-run init to sync all skills
imladris-init
```

### Syncing Skills Back to Repo

When you create/edit skills interactively in Claude:
```bash
curu-sync    # Copies ~/.claude/skills → repo
curu-commit  # Sync + commit with message
curu-watch   # Auto-sync daemon (run in tmux)
```

## Key Files

| File | Purpose |
|------|---------|
| `main.tf` | Core infrastructure (VPC, EC2, EBS, IAM) |
| `variables.tf` | Input variables with defaults |
| `terraform.tfvars` | Environment config (git-crypt encrypted) |
| `nix/home.nix` | User environment (packages, shell, tools) |
| `nix/flake.nix` | Nix flake for home-manager |

## Scripts

All scripts are in `scripts/` and symlinked to `~/bin` for easy access.

### Core Scripts

| Script | Description |
|--------|-------------|
| `imladris-init.sh` | Full initialization: LUKS setup with MFA (BWS keyfile + passphrase), BWS secrets management, directory setup (work/home separation), skills installation (curu-skills, anthropic/skills), shell integration, repo watch (gitwatch for auto-commits) |
| `imladris-unlock.sh` | Quick unlock for reboots: LUKS MFA only, persists BWS token to encrypted volume, creates shell export file for new sessions |
| `imladris-check.sh` | Health check: BWS connectivity, required secrets (luks-keyfile, tailscale-*), LUKS volume status, Tailscale connection |
| `imladris-restore.sh` | Status display showing LUKS, network, directories; can auto-unlock LUKS |
| `user-data-nix.sh` | EC2 user-data bootstrap: system setup, Docker, Tailscale, Nix installation, home-manager, Claude Code & MCP servers, bws CLI |

### Authentication & Authorization

| Script | Description |
|--------|-------------|
| `auth-keeper.sh` | Unified lazy auth (~1800 lines): AWS SSO (auto-refresh before expiry), Azure CLI, Google OAuth, MS365 PowerShell, Slack CLI, Telegram, Signal, ServiceDesk Plus. Use `auth-keeper status` for overview |
| `asudo.sh` | Cloud access control with audit logging. Like sudo for cloud: `asudo aws dev`, `asudo aws prod --admin`, `asudo azure sub`, `asudo gcp project`. Supports AWS (ReadOnly/Admin roles), Azure subscriptions, GCP projects, M365 access levels. Admin access logged with justification |
| `bws-init.sh` | Bitwarden Secrets Manager helpers: `bws_get`, `bws_exists`, `bws_set`, `bws_list`. Auto-initializes BWS token from file or LUKS. Source this script in shell |
| `bws-create-secrets.sh` | Create required BWS secrets with placeholders: tailscale-*, luks-keyfile, sdp-*, aws-cross-accounts, sessions-git-repo |
| `aws-accounts-config.sh` | Generate ~/.aws/config from BWS secret aws-cross-accounts. Commands: generate, list, test, add. Profile names: {name}-{role-suffix} |
| `setup-cross-account-roles.sh` | Create ImladrisReadOnly/ImladrisAdmin roles in target accounts. Configures trust policy for imladris instance role. Run locally with SSO access |
| `claude-backend.sh` | Switch Claude Code backends: `bedrock` (AWS billing via instance role), `team` (Team Premium OAuth), `personal` (Personal Max OAuth). Manages auth.json backup/restore via BWS |

### Backup & Sync

| Script | Description |
|--------|-------------|
| `backup-stateful.sh` | Backup AI/stateful content to /data/backups: ~/.claude, repos, bin, config, ssh, aws, secrets. Keeps 7 days of daily backups with rsync |
| `backup-to-s3.sh` | Sync /data/backups to S3 with Intelligent Tiering. Requires BACKUP_S3_BUCKET env var |
| `backup-luks-to-s3.sh` | Full LUKS volume backup to S3 Glacier. Streams directly if insufficient temp space. Preserves encryption |
| `backup-to-gdrive.sh` | Sync /data to Google Drive via rclone. Excludes lost+found and backups. Requires rclone gdrive remote configured |
| `backup-status.sh` | Show backup status: local backups, latest backup size, scheduled timer, DLM snapshot status |
| `backup-overview.sh` | Display backup strategy documentation: EBS snapshots (hourly), file-level sync (daily), S3 offsite (optional) |
| `session-sync.sh` | Real-time git sync daemon using inotifywait. Watches directory, debounces changes (30s), auto-commits/pushes. Run as systemd service |
| `session-sync-setup.sh` | Initialize session sync: creates git repo, configures remote, installs systemd service template, enables auto-sync |

### Messaging & Notifications

| Script | Description |
|--------|-------------|
| `signal-interface.sh` | Signal as command interface for PAI. Link phone, send/receive messages, process commands (status, ping, uptime, ip). Uses signal-cli |
| `signal-inbox.sh` | Capture Signal messages to ~/inbox with markdown frontmatter. Commands (/ping, /status, /help) get responses; text messages saved to inbox |
| `telegram-inbox.sh` | Capture Telegram messages to ~/inbox via bot API. Similar command interface (/ping, /status, /inbox). Runs as daemon or foreground |

### Utilities

| Script | Description |
|--------|-------------|
| `pai-today.sh` | Show today's Claude Code activity from ~/.claude/history.jsonl with timestamps |
| `pai-log.sh` | View Claude sessions: today's files, current/latest session, list all sessions, prompts |
| `update-check.sh` | Daily AI tooling update checker. Checks PAI, Claude Code (@anthropic-ai/claude-code), MCP servers (@modelcontextprotocol/*), skills repos (curu-skills, anthropics/skills), simplex-chat. Runs at midnight via systemd timer. Notifications via SimpleX (E2E encrypted). Commands: check, report, notify |
| `tmux-session-colors.sh` | Tmux zone-based color theming. Colors pane borders/status by context: green (home), blue (work), red (prod/admin), purple (other). Called by direnv/session hooks |
| `user-data-legacy.sh` | Legacy non-Nix bootstrap: apt packages, oh-my-zsh, tmux plugins, spot interruption handler. Deprecated in favor of Nix |

## Libraries

### Unified Intake System (`lib/intake/`)

Universal intake system for personal information triage - a local RAG for messages from all sources.

```bash
# Initialize database
bun run lib/intake/cli.ts init

# Sync from sources
bun run lib/intake/cli.ts sync all          # All sources
bun run lib/intake/cli.ts sync telegram     # Single source

# Query items
bun run lib/intake/cli.ts query -z work -n 10
bun run lib/intake/cli.ts query --untriaged

# Run triage
bun run lib/intake/cli.ts triage run

# Show statistics
bun run lib/intake/cli.ts stats
```

**Architecture:**
```
Sources (Telegram, Signal, Slack, Email, Calendar)
    ↓
Adapters (lib/intake/adapters/)
    ↓
SQLite Database (/data/.cache/intake/intake.sqlite)
    ↓
Triage Engine (4 layers: Entities → Rules → Similarity → AI)
    ↓
Classified Items (Category, Priority, Quick-Win)
```

**Supported Sources:**
| Source | Adapter | Auth Method |
|--------|---------|-------------|
| Telegram | Bot API | BWS: telegram-bot-token |
| Signal | signal-cli REST | BWS: signal-phone |
| Slack | slackdump archive | Local SQLite |
| Email (MS365) | Graph API | auth-keeper ms365 |
| Email (Gmail) | Gmail API | auth-keeper google |
| Calendar (MS365) | Graph API | auth-keeper ms365 |
| Calendar (Gmail) | Calendar API | auth-keeper google |

**Triage Output:**
- Category: Action-Required, FYI, Awaiting-Reply, Delegated, Scheduled, Reference
- Priority: P0 (emergency), P1 (today), P2 (week), P3 (convenient)
- Quick-Win flag with estimated time
- Confidence score (0-100)

**Python Triage Service (optional, for better accuracy):**
```bash
cd lib/intake/triage-service
pip install -r requirements.txt
uvicorn server:app --port 8100
```

## Skills

Local skills in `skills/` directory:

| Skill | Purpose |
|-------|---------|
| `servicedesk-plus/` | ServiceDesk Plus ticket management with two-way sync |

**Note:** curu-sync, curu-commit, curu-watch commands are PAI features in the curu-skills repo, not in imladris.

## Tests

Test infrastructure in `tests/` directory:

| Directory | Framework | Coverage |
|-----------|-----------|----------|
| `tests/shell/` | Bats | 174 shell script tests |
| `tests/integration/` | Go + Terratest | Infrastructure validation |
| `tests/unit/` | pytest | Python unit tests (stub) |
| `tests/docker/` | Docker Compose | Containerized test execution |

```bash
make test-shell     # Run Bats tests
make test-docker    # Run all tests in Docker
```

## Common Commands

```bash
# Terraform
make plan          # Preview changes
make apply         # Deploy infrastructure
make destroy       # Tear down (keeps EBS volume)
make validate      # Lint Terraform + shell

# Testing
make test-shell    # Run bats tests locally
make test-docker   # Run all tests in Docker container

# On instance
imladris-init      # Initialize/unlock LUKS, install skills
imladris-check     # Health check
auth-keeper status # Check AWS/Azure token status
```

## Architecture

```
┌─────────────────────────────────────────┐
│  VPC (10.0.0.0/16)                      │
│  ┌───────────────────────────────────┐  │
│  │  Public Subnet                    │  │
│  │  ┌─────────────┐  ┌────────────┐  │  │
│  │  │ EC2         │──│ EBS Data   │  │  │
│  │  │ (imladris)  │  │ (hall-of-  │  │  │
│  │  │             │  │  fire)     │  │  │
│  │  └─────────────┘  └────────────┘  │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
         │
         │ Tailscale VPN (no public SSH)
         │
    ┌────┴────┐
    │ Client  │
    └─────────┘
```

## Security Notes

- **Secrets:** `terraform.tfvars` is git-crypt encrypted
- **Access:** IMDSv2 enforced, Tailscale SSH only
- **Storage:** LUKS encryption with MFA (BWS keyfile + passphrase)
- **Keys:** Backed up via Bitwarden Secrets Manager
- **Bedrock:** Instance profile credentials (no keys to manage)

## Important Conventions

- **Foundation:** [PAI (Personal AI Infrastructure)](https://github.com/danielmiessler/Personal_AI_Infrastructure) by Daniel Miessler
- Instance hostname: `imladris`
- Data volume name: `hall-of-fire`
- Default region: `us-east-1`
- Declarative config via Nix (not imperative apt)
- Skills format: PAI (`SkillName/SKILL.md`)

## After Fresh Deploy

```bash
ssh imladris
imladris-init      # Prompts for BWS token + LUKS passphrase
exec zsh           # Reload shell
claude             # Start Claude Code
```

## After Reboot

```bash
ssh imladris
imladris-init      # Prompts for LUKS passphrase only (BWS token persisted)
claude
```
