# Imladris DevBox - AI Assistant Guide

Terraform-managed AWS development workstation with Tailscale VPN access.

## Project Overview

**Purpose:** Cloud dev environment with persistent LUKS-encrypted storage
**Instance:** EC2 t4g.large (ARM64, 2 vCPU, 8GB RAM)
**Access:** Tailscale mesh VPN (zero public ports)
**Storage:** LUKS-encrypted EBS volume (hall-of-fire) with hourly snapshots
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

| Script | Purpose |
|--------|---------|
| `scripts/user-data-nix.sh` | Instance bootstrap (Nix + home-manager) |
| `scripts/imladris-init.sh` | LUKS unlock, skills install, shell setup |
| `scripts/imladris-unlock.sh` | LUKS unlock only (for reboots) |
| `scripts/session-sync.sh` | Git-based session history sync |
| `scripts/auth-keeper.sh` | Lazy auth refresh for AWS/Azure CLIs |
| `scripts/bws-init.sh` | Bitwarden Secrets Manager helpers |

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

- Instance hostname: `imladris`
- Data volume name: `hall-of-fire`
- Default region: `us-east-1`
- Declarative config via Nix (not imperative apt)
- Skills format: PAI (SkillName/SKILL.md)

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
