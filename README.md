# Imladris

Cloud workstation on EC2 where Claude+PAI is the single interface for all DevOps work.

## Architecture

- **Single EC2 instance** (m7gd.xlarge) with encrypted EBS (customer-managed KMS key) + 237GB NVMe instance store
- **Windmill** (self-hosted, Docker Compose) for automation, credentials, and workflows
- **Tailscale** for all network access (zero public inbound ports)
- **CloudFormation** for all infrastructure-as-code
- **Ansible** for full OS-level configuration management (16 roles)

## Structure

```
cloudformation/
  imladris-stack.yaml            EC2, security group, IAM role, KMS key
  cross-account-stackset.yaml    ReadOnly + ReadWrite roles for 16 AWS accounts
  signoz-otel-collector.yaml     SigNoz OTel collector CloudFormation

ansible/
  site.yml                       Main playbook (full provision)
  site-boot.yml                  Boot-time playbook (NVMe, services)
  site-bake.yml                  AMI bake playbook
  inventory.yml                  Inventory
  group_vars/imladris.yml        All configuration values
  roles/                         16 roles (see below)
  molecule/                      Molecule tests

windmill/
  f/devops/                      Automation scripts (triage, investigation, SDP, Slack)
  f/investigate/                 Read-only investigation tools (AWS, Azure, network, SIEM)

scripts/
  voice-server.ts                ElevenLabs voice notification server
  deploy-mssql-otel.ps1          MSSQL OTel collector deployment
  signoz-*.sh/yaml               SigNoz monitoring configs

docker-compose.yml               Windmill server + 4 Bun workers + 1 native worker + Postgres + LSP
bootstrap.sh                     Instance init: deps, symlinks, services
tailscale/                       Tailscale setup and ACL config
packer/                          AMI building
```

## Windmill Investigation Pipeline

Automated alert triage, investigation, and resolution pipeline:

```
M365/SDP/Slack → Haiku classify → SQLite cache → process_actionable
                                                      ↓
                                              Opus investigator (8 rounds, 20 tools)
                                                      ↓
                                              Evidence chain + differential diagnosis
                                                      ↓
                                              SDP ticket creation or auto-dismiss
```

### Key Scripts

| Script | Purpose |
|--------|---------|
| `f/devops/batch_triage_emails.ts` | M365 Graph API → Haiku classification |
| `f/devops/batch_triage_sdp.ts` | SDP ticket ingestion |
| `f/devops/batch_triage_slack.ts` | Slack message parsing |
| `f/devops/process_actionable.ts` | 3-phase orchestration (investigate → task → escalate) |
| `f/devops/agentic_investigator.ts` | Bedrock Opus tool-use loop with ISC methodology |
| `f/devops/cache_lib.ts` | SQLite triage cache (5 tables, FTS5 search) |

### Investigation Tools (f/investigate/)

20+ read-only tools across:
- **AWS** (EC2, RDS, ECS, Lambda, S3, CloudWatch, CloudTrail, security groups) — 16 accounts via cross-account roles
- **Azure AD** (devices, sign-ins, users)
- **Network** (DNS, TLS, MX, reverse DNS)
- **Securonix** SIEM (incidents, violations, threats)
- **Site24x7** monitoring (status, alarms)
- **SDP** tickets (search, lookup)
- **Slack** (channels, threads, search, user info)
- **Telegram** (list chats, read messages via MTProto/gramjs)
- **Resource inventory** (auto-discovered AWS assets)
- **Vendor database** (~280 vendors)
- **Alert history** (FTS5 cache search)

## Ansible Roles

16 roles for full instance provisioning from scratch:

| Role | Purpose |
|------|---------|
| `packages` | System packages (git, jq, tmux, cronie, mosh) |
| `nvme` | NVMe instance store formatting and mount |
| `docker` | Docker + docker-compose, data-root on NVMe |
| `nodejs` | Node.js 20 |
| `bun` | Bun runtime |
| `tailscale` | Tailscale installation and auth |
| `windmill` | Docker Compose up, workspace bootstrap, wmill CLI, script push |
| `repos` | Git repo cloning (PAI, imladris, dotfiles) |
| `claude-code` | Claude Code CLI, runtime dirs, symlinks |
| `steampipe` | Steampipe + AWS plugin |
| `bitwarden` | BWS CLI + credential sync |
| `mcp-tools` | MCP tools binary |
| `voice-server` | ElevenLabs voice notification systemd service |
| `ai-failover` | AI provider failover logic |
| `ssm-disable` | Disable SSM agent (Tailscale-only access) |
| `mosh` | Mosh server for mobile access |

### Provision from Scratch

```bash
# From a control machine with SSH access via Tailscale:
cd ~/repos/imladris/ansible
ansible-playbook site.yml -i inventory.yml \
  --extra-vars "tailscale_auth_key=tskey-... bws_access_token=... windmill_admin_password=..."
```

## Docker Compose Services

| Service | Purpose | Notes |
|---------|---------|-------|
| `windmill_server` | Windmill API + UI | Port 8000 (localhost only) |
| `windmill_worker` (x4) | Bun script workers | 4 containers for concurrency |
| `windmill_worker_native` | Native worker | Python, Go, Bash scripts |
| `windmill_db` | PostgreSQL 16 | Data on EBS for persistence |
| `windmill_lsp` | Language server | Port 3001 (localhost only) |

### Worker Capacity

4 Bun workers + concurrency guard (`MAX_CONCURRENT_INVESTIGATIONS=2`) prevents deadlock when investigators call tools via sync HTTP. Always 2 free workers for tool execution.

## AWS Cross-Account Access

16 accounts in BuxtonIT org via StackSet-deployed roles:

- `ImladrisReadOnly` — read-only investigation access
- `ImladrisAdmin` — write access for remediation

StackSet: `ImladrisCrossAccount` (service-managed, auto-deploy, root OU `r-y6dl`)

## Credential Management

- **BWS** (Bitwarden Secrets Manager) is source of truth
- `sync-credentials.sh` syncs BWS → Windmill variables
- Naming: `investigate-*` → `f/investigate/` folder, all others → `f/devops/`
- Integrations: M365, SDP, Site24x7, Aikido, Okta, Securonix, Slack, Telegram

## NVMe Storage Policy

| Location | Contents | Survives restart? |
|----------|----------|-------------------|
| `/local/` (NVMe) | Docker layers, triage cache, build artifacts, worktrees | No |
| `~/` (EBS) | Repos, configs, MEMORY, secrets, Postgres data | Yes |

## Security Posture

7 layers: CMK encryption, MFA-locked KMS, YubiKey root, deleted OrgAccessRole, SCP identity protection, CloudTrail detection, Tailscale-only network.

## Network Access

All services bind to `127.0.0.1` only. External access via Tailscale:
- `https://imladris-4.dzo-musical.ts.net/` → Windmill UI (port 8000)

## Previous Version

The v1 codebase (Terraform/Nix-based) is preserved at tag `v1-archive`.
