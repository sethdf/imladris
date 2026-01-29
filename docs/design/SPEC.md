# Imladris 2.0 - Project Specification

> A reproducible Linux cloud workstation that captures all inputs from life and work, surfaces actionable items, organizes by context (workspaces), and provides frictionless AI-assisted tools to act on them.

**Version:** 0.1.0 (Draft)
**Last Updated:** 2026-01-29

---

## Table of Contents

1. [Overview](#1-overview)
2. [Guiding Principles](#2-guiding-principles)
3. [Architecture](#3-architecture)
4. [Workspaces](#4-workspaces)
5. [Datahub](#5-datahub)
6. [Authentication](#6-authentication)
7. [Commands](#7-commands)
8. [Infrastructure](#8-infrastructure)
9. [User Scenarios](#9-user-scenarios)
10. [Coding Methodology](#10-coding-methodology)
11. [Out of Scope](#11-out-of-scope)
12. [Open Questions](#12-open-questions)

---

## 1. Overview

### 1.1 Purpose

Imladris 2.0 is a personal cloud workstation for:
- Running Claude Code with PAI for personal productivity
- AI-assisted development environment for work projects
- Aggregating all life and work inputs into a unified system
- Research assistance

### 1.2 Core Components

| Component | Purpose |
|-----------|---------|
| **Workspaces** | Zone + mode context organization |
| **Datahub** | Capture all inputs, sync bidirectionally |
| **Triage** | Surface actionable items via Claude |
| **Tools** | PAI + Claude Code + skills |
| **Auth** | Frictionless credentials via BWS |

### 1.3 Boundaries

**In Scope:**
- Collector and workspace
- Aggregates and presents
- User decides and acts

**Out of Scope:**
- Outbound automation (bots replying, scheduled actions)
- Multi-instance / HA / scaling
- Building a task/project management system

---

## 2. Guiding Principles

### Principle 1: Context Switching is Expensive
- 23 minutes average recovery time after interruption
- Zone switches cost more than mode switches
- Design: Make zone switches deliberate, mode switches easy

### Principle 2: Modes Map to Cognitive Action Types
| Mode | Action Type |
|------|-------------|
| tasks | Execute |
| comms | Communicate |
| projects | Create |
| research | Learn |
| adhoc | Quick/flexible |

### Principle 3: Interstitial Journaling on Transitions
- Claude auto-summarizes context on zone switch
- Saves 23+ minutes of "where was I?" on return

### Principle 4: Friction is Intentional
| Transition | Friction Level |
|------------|----------------|
| Start working | Low |
| Within mode | Low |
| Mode → Mode (same zone) | Medium |
| Zone → Zone | Higher |

### Principle 5: Deep vs Shallow Work Separation
| Shallow (batch) | Deep (protect) |
|-----------------|----------------|
| tasks, comms, adhoc | projects, research |

### Principle 6: Working Memory Limits (3-5 Items)
- 5 modes is optimal
- 2 zones is manageable
- 10 total workspaces within bounds

### Principle 7: Plain Text Everything
- Greppable, scriptable, version-controlled, composable, portable

### Principle 8: Persistence Over Memory
- Session state: tmux
- Context notes: Claude auto-save
- Tasks: flat files
- Inputs: datahub
- Auth: lazy-loaded, auto-refreshed

### Principle 9: Defaults Over Decisions
- Workspace entry has sensible defaults
- Mode switching requires minimal thought
- "Just start" always possible

### Principle 10: Visual Cues = Cognitive Offloading
- Prompt prefix shows workspace
- Status bar shows context
- Colors indicate zone

### Principle 11: Batch Shallow Work
- comms collects all communication
- tasks collects all actionable items
- Process in windows, then close

### Principle 12: Zone Entry = Room Entry
- Switching zones feels deliberate
- Clear separation of concerns
- Work stays in work, home stays in home

---

## 3. Architecture

### 3.1 System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  imladris 2.0                                                       │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Workspaces (tmux)                                            │   │
│  │  Window 0:  status (TUI dashboard)                           │   │
│  │  Window 1-5:  work:comms/tasks/projects/research/adhoc       │   │
│  │  Window 6-10: home:comms/tasks/projects/research/adhoc       │   │
│  │                                                               │   │
│  │  Each window: Claude Code session (PAI)                       │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Datahub                                                      │   │
│  │  ~/work/datahub/items/    (flat files, source of truth)      │   │
│  │  ~/work/datahub/index.sqlite (derived, fast queries)         │   │
│  │  ~/home/datahub/items/                                       │   │
│  │  ~/home/datahub/index.sqlite                                 │   │
│  │  ~/calendar/merged.sqlite (read-only combined view)          │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Pollers (systemd timers)              Queue Processor        │   │
│  │  5 min: ms365, sdp, devops,           Unified with handlers  │   │
│  │         gmail, gcal                   Retries, conflict      │   │
│  │  60s:   slack, telegram               detection              │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Auth-keeper                                                  │   │
│  │  BWS as registry (source of truth)                           │   │
│  │  Auto-discovery of new services                              │   │
│  │  Lazy token refresh                                          │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
         │
         │ Tailscale VPN (no public ports)
         ▼
    External Systems: SDP, MS365, DevOps, Slack, Gmail, GCal, Telegram
```

### 3.2 Technology Stack

| Layer | Technology |
|-------|------------|
| Infrastructure | Terraform (AWS) |
| Configuration | Nix + home-manager |
| Runtime | Bun (pollers, scripts - aligns with PAI) |
| AI | Claude Code via AWS Bedrock |
| Framework | PAI (Personal AI Infrastructure) |
| Storage | Flat files (markdown) + SQLite index |
| Secrets | Bitwarden Secrets Manager (BWS) |
| Access | Tailscale SSH only |

### 3.3 Data Flow

```
External Systems
      │
      ▼ (pollers, every 5min/60s)
Datahub (flat files)
      │
      ▼ (after each poll)
Triage (Claude batch classification)
      │
      ▼
Index (SQLite, derived)
      │
      ▼
Workspaces (Claude sessions)
      │
      ▼ (user actions)
Queue (pending writes)
      │
      ▼ (queue processor)
External Systems
```

---

## 4. Workspaces

### 4.1 Terminology

| Term | Definition |
|------|------------|
| **Zone** | Top-level context (work, home) |
| **Mode** | Activity type (tasks, comms, projects, research, adhoc) |
| **Workspace** | Zone + mode combination (e.g., work:tasks) |

### 4.2 Window Structure

```
tmux session: main
│
├── window 0:  status        ← TUI dashboard
├── window 1:  work:comms    ← default on /work
├── window 2:  work:tasks
├── window 3:  work:projects
├── window 4:  work:research
├── window 5:  work:adhoc
├── window 6:  home:comms    ← default on /home
├── window 7:  home:tasks
├── window 8:  home:projects
├── window 9:  home:research
└── window 10: home:adhoc
```

### 4.3 Zone Switching

- `/work` → switches to work:comms (default mode)
- `/home` → switches to home:comms (default mode)
- `/work tasks` → switches to work:tasks
- On zone switch: Claude auto-summarizes current context

### 4.4 Pane Structure

Freeform. Single pane default (Claude), split as needed.

### 4.5 Visual Signaling

| Element | Work Zone | Home Zone |
|---------|-----------|-----------|
| Status bar color | Blue | Green |
| Pane border | Blue | Green |
| Prompt prefix | `[work:tasks]` | `[home:comms]` |

### 4.6 Status Bar

```
Normal:
┌─────────────────────────────────────────────────────────────────────┐
│ [work:tasks] │ SDP-123 │ 3 actionable │ 14:32                       │
└─────────────────────────────────────────────────────────────────────┘

Auth problem:
┌─────────────────────────────────────────────────────────────────────┐
│ [work:tasks] │ SDP-123 │ 3 actionable │ 14:32 │ ⚠ sdp auth          │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.7 Status Dashboard (Window 0)

TUI showing:
- All workspaces with actionable counts
- Current task per workspace
- Auth status for all services
- Sync status (pending, failed)
- Calendar (next 4 hours, merged)

Auto-refresh: 30 seconds
Implementation: Python + rich/textual

---

## 5. Datahub

### 5.1 Purpose

Bidirectional sync between local system and external services. Captures all inputs, surfaces actionable items.

### 5.2 Storage Structure

```
~/work/datahub/
├── items/                    ← Source of truth (flat files)
│   ├── sdp-123.md
│   ├── email-xyz.md
│   └── slack-abc.md
├── index.sqlite              ← Derived (regeneratable)
├── queue/
│   ├── pending/
│   ├── processing/
│   ├── completed/
│   └── failed/
├── trash/                    ← Soft delete (365-day purge)
└── state/
    └── sync-state.json

~/home/datahub/
└── (same structure)

~/calendar/
└── merged.sqlite             ← Read-only, combined view
```

### 5.3 Item Format

```markdown
---
id: sdp-123
source: sdp
type: request
title: Fix auth module
status: in-progress
zone: work
actionable: true
priority: P2
tags: [auth, urgent, backend]
created: 2026-01-25
updated: 2026-01-28
---

## Description
User reports login failures...

## Notes
### 2026-01-28 14:30 (local)
Found the root cause - token refresh logic

### 2026-01-27 10:00 (sdp)
Assigned to @seth
```

### 5.4 Index Schema

```sql
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  source TEXT,
  type TEXT,
  zone TEXT,
  actionable TEXT,  -- 'actionable', 'keep', 'delete'
  status TEXT,
  priority TEXT,
  timestamp TEXT,
  title TEXT,
  file_path TEXT,
  updated_at TEXT
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  color TEXT,           -- hex color for UI
  auto_rule TEXT        -- optional: regex or rule for auto-tagging
);

CREATE TABLE item_tags (
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
  source TEXT,          -- 'manual', 'auto', 'external' (synced from MS365/Gmail)
  created_at TEXT,
  PRIMARY KEY (item_id, tag_id)
);

CREATE INDEX idx_actionable ON items(zone, actionable);
CREATE INDEX idx_source ON items(source);
CREATE INDEX idx_timestamp ON items(timestamp);
CREATE INDEX idx_item_tags ON item_tags(tag_id);
```

### 5.5 Sources

| Zone | Source | System | Method | Interval |
|------|--------|--------|--------|----------|
| work | Help desk | ServiceDesk Plus Cloud | REST API | 5 min |
| work | Email | MS365 | Graph API (delta) | 5 min |
| work | Calendar | MS365 | Graph API (delta) | 5 min |
| work | Chat | Slack | slackdump | 60s |
| work | Tasks/DevOps | Azure DevOps | REST API | 5 min |
| home | Email | Gmail | history.list | 5 min |
| home | Calendar | Google Calendar | syncToken | 5 min |
| home | Chat | Telegram | getUpdates | 60s |

### 5.6 Email Sync Parameters

**Initial Sync (first run):**

| Parameter | Value | Reason |
|-----------|-------|--------|
| Lookback | 365 days | Full year of context |
| Folders | Inbox + Sent | Sent needed for conversation context |
| Batch size | 100 messages/request | API pagination |

**Ongoing Sync:**

| Parameter | Value | Method |
|-----------|-------|--------|
| MS365 | Delta query | `/messages/delta` tracks changes |
| Gmail | history.list | historyId tracks changes |
| Interval | 5 min | Balance freshness vs API limits |

**What syncs:**

| Field | Synced | Notes |
|-------|--------|-------|
| Subject, From, To, CC | Yes | Core metadata |
| Body (text) | Yes | Needed for triage/search |
| Body (HTML) | No | Text extracted only |
| Attachments | Metadata only | Download on demand |
| Categories/Labels | Yes | Mapped to tags |
| Read status | Yes | Bidirectional sync |
| Flag/Star | Yes | Bidirectional sync |

**Retention:**

| Classification | Retention |
|----------------|-----------|
| `actionable` | Forever |
| `keep` | Forever |
| `delete` | 365 days in trash, then purge |

**Tag sync (bidirectional):**

| Direction | Behavior |
|-----------|----------|
| Inbound | MS365 Categories / Gmail Labels → local tags |
| Outbound | Local tag changes → sync to MS365/Gmail |
| New tags | Created in both systems |

### 5.7 Triage

**Classification (ternary):**
| Value | Meaning | Action |
|-------|---------|--------|
| `actionable` | Needs user action | Surfaces in workspace |
| `keep` | Reference/archive | Stored, searchable |
| `delete` | Noise/irrelevant | Moved to trash |

**Engine:** Claude batch triage (PAI skill pattern)

**Timing:** After each poll

**Override:** `/item mark <id> <classification>`

### 5.8 Sync - Inbound

Each poller:
1. Gets auth token via `auth-keeper get <service>`
2. Fetches delta/changes since last sync
3. Writes/updates flat files
4. Updates sync-state.json
5. Triggers triage + index rebuild

### 5.9 Sync - Outbound

Write queue processor:
1. Watches queue/pending/
2. Routes by service to handler
3. Checks for conflicts (timestamp compare)
4. Sends to external API
5. Moves to completed/ or failed/

### 5.10 Slack Read/Write Split

| Operation | Method |
|-----------|--------|
| Read (poll) | slackdump (browser session) |
| Write (reply) | Slack Bot API (bot token) |

### 5.11 Conflict Scenarios

| Conflict Type | Detection | Resolution |
|---------------|-----------|------------|
| Write (additive) | Timestamp compare | Warn, allow merge |
| Write (destructive) | Timestamp compare | Warn, require confirm |
| Status change | Pre-fetch check | Block, require refresh |
| Deleted externally | 404 response | Prompt: keep/delete/recreate |
| Duplicate creation | Similarity check | Prompt: link/create/edit |
| Stale queue | Timestamp check | Review each item |
| Field-level | Per-field diff | Auto-merge if disjoint |

### 5.12 Item Completion

| Command | Behavior |
|---------|----------|
| `/task done` | Local complete only |
| `/task close "notes"` | Local + external complete |

### 5.13 Archive Policy

| Item Type | Archive After |
|-----------|---------------|
| External (SDP, DevOps) | 90 days after completion |
| Local-only (email, chat) | Never (keep forever) |

### 5.14 Export to Personal VPS

```bash
datahub export --zone home --dest rsync://personal-vps/archive
```

- Format: Flat files (portable markdown)
- Incremental: rsync handles
- Schedule: Daily cron

### 5.15 Attachments

| Direction | Behavior |
|-----------|----------|
| Inbound | Metadata only (filename, size, type) |
| Download | On demand |
| Outbound | v2 |

---

## 6. Authentication

### 6.1 BWS as Registry

BWS (Bitwarden Secrets Manager) is the single source of truth for all services requiring authentication.

### 6.2 Secret Naming Convention

```
{zone}-{service}-{item}

Examples:
work-ms365-tenant-id
work-ms365-client-id
work-ms365-certificate
work-sdp-client-id
work-sdp-refresh-token
home-google-client-id
home-telegram-bot-token
```

### 6.3 Auth Types by Service

| System | Auth Type | Refresh |
|--------|-----------|---------|
| work-ms365 | Service Principal + Certificate | Auto |
| work-sdp | OAuth2 (Zoho) | Auto (refresh token) |
| work-devops | PAT | Manual (warn on expiry) |
| work-slack | slackdump (browser session) | Manual re-auth |
| home-google | OAuth2 | Auto (refresh token) |
| home-telegram | Bot token | Never expires |

### 6.4 auth-keeper Interface

```bash
# Get valid token (refreshes if needed)
auth-keeper get work-ms365
auth-keeper get work-sdp

# Status of all services
auth-keeper status

# Discover new secrets in BWS
auth-keeper discover

# Initial setup
auth-keeper setup work-ms365

# Force refresh
auth-keeper refresh work-sdp
```

### 6.5 Smart Discovery

When new BWS entry detected:
1. auth-keeper prompts: "What service is this for?"
2. User provides: service name, zone, credential type
3. auth-keeper renames to proper pattern
4. User manually enters secret value in BWS

### 6.6 Cloud Account Registry

BWS tracks accessible cloud accounts for discoverability:

**AWS Accounts (BWS: `aws-accounts`):**

```json
[
  {
    "id": "111111111111",
    "name": "prod",
    "alias": "org-prod",
    "roles": ["ReadOnlyAccess", "AdminAccess"],
    "purpose": "Production environment",
    "default_role": "ReadOnlyAccess"
  },
  {
    "id": "222222222222",
    "name": "dev",
    "alias": "org-dev",
    "roles": ["ReadOnlyAccess", "AdminAccess"],
    "purpose": "Development/staging",
    "default_role": "AdminAccess"
  }
]
```

**GCP Projects (BWS: `gcp-projects`):**

```json
[
  {
    "id": "my-project-123",
    "name": "prod",
    "purpose": "Production GCP"
  }
]
```

**AWS Access Model:**
- Instance profile on host provides base credentials
- Profile can assume roles in all registered accounts
- No credential management needed - automatic via EC2 metadata
- auth-keeper generates `~/.aws/config` from BWS registry

**Generated AWS Config:**

```ini
[profile org-prod-readonly]
role_arn = arn:aws:iam::111111111111:role/ReadOnlyAccess
credential_source = Ec2InstanceMetadata

[profile org-prod-admin]
role_arn = arn:aws:iam::111111111111:role/AdminAccess
credential_source = Ec2InstanceMetadata

[profile org-dev-readonly]
role_arn = arn:aws:iam::222222222222:role/ReadOnlyAccess
credential_source = Ec2InstanceMetadata
```

### 6.7 Offline Limitation

Claude via Bedrock requires network. Offline mode is view-only (grep datahub).

---

## 7. Commands

### 7.1 Workspace Commands

```bash
/work [mode]           # Switch to work zone (default: comms)
/home [mode]           # Switch to home zone (default: comms)
/status                # Window 0 - full dashboard
```

### 7.2 Task Commands

```bash
/task list             # Show actionable from datahub
/task show             # Current task details
/task start <id>       # Explicit start
/task switch <id>      # Pause current, start new
/task note "text"      # Add note (syncs)
/task log <time> "text"# Log time (syncs)
/task status <status>  # Change status (syncs)
/task pause            # Save context, no completion
/task done             # Local complete only
/task close "notes"    # Local + external complete
/task create <source> "title"  # Create new item
```

### 7.3 Item Commands

```bash
/inbox                 # Show actionable in current workspace
/item show <id>        # View item details
/item mark <id> <class># Override triage (actionable/keep/delete)
/item done <id>        # Mark item complete
```

### 7.4 Search Commands

```bash
/search "query"              # Search all
/search "query" --zone work  # Filter by zone
/search "query" --source sdp # Filter by source
/search "query" --tag urgent # Filter by tag
/search --tag finance        # All items with tag (no text query)
```

### 7.5 Calendar Commands

```bash
/calendar              # Today's merged view
/calendar week         # Week view
/calendar add --work "title"  # Create work event
/calendar add --home "title"  # Create home event
```

### 7.6 Communication Commands

```bash
/slack                 # Show actionable Slack items
/slack reply <thread>  # Reply to thread
```

### 7.7 Attachment Commands

```bash
/attachment list <item-id>     # List attachments
/attachment download <att-id>  # Download attachment
```

### 7.8 Cloud Commands

```bash
# AWS
auth-keeper aws list                    # List all accessible accounts
auth-keeper aws list --json             # JSON output for skills
auth-keeper aws get <account>           # Assume role, set credentials
auth-keeper aws get <account> --role Admin  # Specific role
auth-keeper aws whoami                  # Current account/role context
auth-keeper aws generate-config         # Regenerate ~/.aws/config from BWS

# GCP
auth-keeper gcp list                    # List all accessible projects
auth-keeper gcp get <project>           # Set GOOGLE_CLOUD_PROJECT
auth-keeper gcp whoami                  # Current project context

# Direct AWS CLI usage (uses generated profiles)
aws --profile org-prod-readonly s3 ls
aws --profile org-dev-admin ec2 describe-instances
```

### 7.9 System Commands

```bash
/auth status           # Auth overview
/auth refresh <service># Refresh token
/sync status           # Sync queue status
/sync retry            # Retry failed items
```

### 7.10 Tag Commands

```bash
# View and manage tags
/tag list                      # List all tags
/tag list --item <id>          # Show tags for item
/tag search <tag>              # Find items with tag

# Apply tags
/tag add <item-id> <tag>       # Add tag to item (syncs to external)
/tag remove <item-id> <tag>    # Remove tag from item
/tag bulk <tag> <query>        # Add tag to all items matching query

# Manage tag definitions
/tag create <name> [--color hex] [--rule regex]  # Create new tag
/tag delete <name>             # Delete tag (removes from all items)
/tag auto                      # Run auto-tagging rules on untagged items

# External sync
/tag sync                      # Force sync tags with MS365/Gmail
```

**Auto-tagging rules (optional):**

| Tag | Rule Example |
|-----|--------------|
| `urgent` | Subject contains "urgent" or "asap" |
| `finance` | From contains "@finance" |
| `meeting` | Has calendar attachment |
| `newsletter` | From matches known newsletter domains |

---

## 8. Infrastructure

### 8.1 Summary (from Imladris 1.0)

| Component | Config |
|-----------|--------|
| Instance | m7g.xlarge (ARM64/Graviton), Ubuntu 24.04 |
| Root volume | 50GB gp3 (6000 IOPS, 500 MiB/s) |
| Data volume | 100GB gp3, LUKS encrypted ("hall-of-fire") |
| Snapshots | Hourly via DLM, 24 retained |
| Offsite backup | Secondary (TBD) |
| Network | VPC, no public ingress, Tailscale only |
| IAM | EBS attach, Bedrock, cross-account assume |

### 8.2 Terraform Structure

Copy from existing imladris repo:
- `main.tf` - VPC, EC2, EBS, IAM, DLM
- `variables.tf` - Configuration
- `outputs.tf` - Instance info
- `versions.tf` - Provider versions

### 8.3 Nix + home-manager

Declarative configuration for:
- Shell (zsh)
- Packages (git, tmux, bun, etc.)
- Claude Code
- PAI skills
- Dotfiles

### 8.4 Storage Layout

All stateful data lives on the LUKS-encrypted data volume (`/data`). Root volume is ephemeral/rebuildable.

**LUKS Volume Structure:**

```
/data/                          ← LUKS mounted (hall-of-fire)
├── work/
│   ├── datahub/
│   │   ├── items/
│   │   ├── index.sqlite
│   │   ├── queue/
│   │   ├── trash/
│   │   └── state/
│   └── tasks/                  ← task context files
│
├── home/
│   ├── datahub/
│   │   └── (same structure)
│   └── tasks/
│
├── repos/                      ← zone-based git repos (ghq)
│   ├── work/
│   │   └── github.com/
│   │       └── work-org/...
│   └── home/
│       └── github.com/
│           └── sethdf/...
│
├── calendar/
│   └── merged.sqlite
│
├── claude/                     ← ~/.claude symlinked here
│   ├── settings.json
│   ├── memory/
│   ├── skills/
│   └── projects/
│
├── ssh/                        ← ~/.ssh symlinked here
│
├── config/
│   ├── bws/
│   ├── slackdump/
│   ├── auth-keeper/
│   └── tmux/
│
└── backups/                    ← local backup staging
```

**Symlinks from Home Directory:**

| Symlink | Target |
|---------|--------|
| `~/.claude` | `/data/claude` |
| `~/.ssh` | `/data/ssh` |
| `~/.bws` | `/data/config/bws` |
| `~/.slackdump` | `/data/config/slackdump` |
| `~/repos` | `/data/repos` |
| `~/work` | `/data/work` |
| `~/home` | `/data/home` |
| `~/calendar` | `/data/calendar` |

**Stateful Items Checklist:**

| Item | Location | On LUKS |
|------|----------|---------|
| Datahub (work/home) | `/data/work/datahub/`, `/data/home/datahub/` | ✓ |
| Calendar merged | `/data/calendar/` | ✓ |
| Task context | `/data/work/tasks/`, `/data/home/tasks/` | ✓ |
| Claude sessions | `/data/claude/` | ✓ |
| PAI memory/skills | `/data/claude/memory/`, `/data/claude/skills/` | ✓ |
| SSH keys | `/data/ssh/` | ✓ |
| Git repos (work) | `/data/repos/work/` | ✓ |
| Git repos (home) | `/data/repos/home/` | ✓ |
| BWS token cache | `/data/config/bws/` | ✓ |
| slackdump auth | `/data/config/slackdump/` | ✓ |
| Auth token cache | `/data/config/auth-keeper/` | ✓ |
| Sync queue | `/data/*/datahub/queue/` | ✓ |
| tmux resurrect | `/data/config/tmux/` | ✓ |

**Ephemeral (Root Volume):**

| Item | Reason |
|------|--------|
| Nix store | Rebuildable from flake |
| Packages | Rebuildable |
| OS | Rebuildable |
| Temp files | Ephemeral by nature |

### 8.5 Update Service

Automatic updates with rollback on failure.

**Components Updated:**

| Component | Source | Frequency |
|-----------|--------|-----------|
| Claude Code | npm (@anthropic-ai/claude-code) | Daily |
| PAI | GitHub (danielmiessler/PAI) | Daily |
| Spec Kit | GitHub (github/spec-kit) | Daily |
| MCP servers | npm (@modelcontextprotocol/*) | Daily |
| Skills repos | GitHub (curu-skills, anthropics/skills) | Daily |
| Nix packages | nixpkgs | Weekly |

**Workflow:**

```
┌─────────────────────────────────────────────────────────────────┐
│  update-service (systemd timer, daily 03:00)                    │
│                                                                 │
│  For each component with update available:                      │
│    1. Snapshot current state                                    │
│    2. Apply update                                              │
│    3. Run validation tests                                      │
│    4. If tests fail → rollback → notify failure                 │
│    5. If tests pass → notify success                            │
└─────────────────────────────────────────────────────────────────┘
```

**Validation Tests:**

| Component | Validation |
|-----------|------------|
| Claude Code | `claude --version`, basic prompt test |
| PAI | Skills load without error |
| Spec Kit | CLI health check |
| MCP servers | Health check endpoints |
| Nix | `nix build` succeeds |

**Notifications:** Via configured channel (SimpleX, Telegram, or status dashboard)

**Rollback:** Each component uses appropriate rollback:
- Nix: `nix profile rollback`
- npm: Previous version pinned in lockfile
- Git repos: `git checkout` to previous commit

### 8.6 Repository Structure

Zone-based repository organization using `ghq`.

**Directory Structure:**

```
/data/repos/
├── work/
│   └── github.com/
│       ├── work-org/
│       │   ├── project-alpha/
│       │   └── project-beta/
│       └── azure.com/
│           └── work-org/
│               └── devops-repo/
│
└── home/
    └── github.com/
        ├── sethdf/
        │   ├── imladris/
        │   ├── curu-skills/
        │   └── personal-projects/
        └── danielmiessler/
            └── PAI/
```

**ghq Configuration:**

```bash
# Workspace sets GHQ_ROOT based on zone
# In work zone:
export GHQ_ROOT=/data/repos/work
ghq get github.com/work-org/project

# In home zone:
export GHQ_ROOT=/data/repos/home
ghq get github.com/sethdf/imladris
```

**Workspace Integration:**

| Zone | GHQ_ROOT | Effect |
|------|----------|--------|
| work | `/data/repos/work` | `ghq list` shows only work repos |
| home | `/data/repos/home` | `ghq list` shows only home repos |

**Benefits:**

- Repos physically separated by zone
- Can export home zone to personal VPS independently
- `ghq list | fzf` shows contextually relevant repos
- No accidental work on wrong repo in wrong zone

---

## 9. User Scenarios

### 9.1 Daily Startup

1. `ssh imladris`
2. `tmux attach`
3. Window 0 shows status dashboard
4. `/work` to start
5. Claude shows last task context

### 9.2 Working on a Task

1. Enter `work:tasks`
2. Auto-loads current task context
3. Work with Claude
4. `/task note "Found bug"` - syncs to SDP
5. `/task switch SDP-456` - saves context, loads new

### 9.3 Processing Email

1. `/work comms`
2. `/inbox` - shows actionable emails
3. "Reply to this email..."
4. Claude drafts, user approves
5. `/item done email-xyz`

### 9.4 Zone Switch

1. Working in `work:tasks`
2. `/home`
3. Claude auto-summarizes work context
4. Enters `home:comms`
5. Claude shows home context

### 9.5 Auth Issue

1. Status bar shows `⚠ sdp auth`
2. `auth-keeper status` - details
3. `auth-keeper refresh work-sdp`
4. Or `auth-keeper setup work-sdp` if refresh fails

---

## 10. Coding Methodology

### 10.1 Spec Kit as Standard

All coding work uses [Spec Kit](https://github.com/github/spec-kit) (GitHub's specification-driven development toolkit) for consistency and reliability.

**Rationale:**
- Specs improve AI code reliability by 2.5-3x
- Consistent methodology eliminates "is this complex enough?" decisions
- Tests are defined in spec phase, not afterthought
- Single user = no team review, so specs provide the "second pair of eyes"

### 10.2 Four-Phase Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│  Phase 1: SPECIFY                                               │
│  /specify "feature description"                                 │
│  → Writes spec.md with requirements, constraints, acceptance    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 2: PLAN                                                  │
│  /plan                                                          │
│  → Technical design, architecture decisions, file changes       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 3: TASKS                                                 │
│  /task                                                          │
│  → Break into implementable units with test criteria            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 4: IMPLEMENT                                             │
│  /implement                                                     │
│  → Code + tests, referencing spec for acceptance criteria       │
└─────────────────────────────────────────────────────────────────┘
```

### 10.3 Integration with PAI

| Layer | Tool | Purpose |
|-------|------|---------|
| **What to build** | Spec Kit | Requirements, constraints, acceptance criteria |
| **How Claude behaves** | PAI Skills | Execution patterns, response formats |
| **Project context** | CLAUDE.md | Repository-specific rules and conventions |
| **External data** | MCP | Structured connections to APIs and services |

**Workflow integration:**

```
User request
    │
    ▼
Spec Kit (/specify)     ← Define WHAT
    │
    ▼
PAI Skills              ← Define HOW (patterns, methodology)
    │
    ▼
Claude Code execution   ← Do the work
    │
    ▼
Spec Kit (/verify)      ← Confirm acceptance criteria met
```

### 10.4 Spec Storage

Specs are stored with their associated code:

```
project/
├── .specs/
│   ├── feature-auth.md
│   ├── feature-auth.plan.md
│   ├── feature-auth.tasks.md
│   └── archive/           ← Completed specs
├── src/
└── tests/
```

For datahub items (SDP tickets, etc.), specs link to the item:

```markdown
---
id: feature-auth
linked_item: sdp-456
status: implementing
---

## Specification
...
```

### 10.5 When Specs Are Required

**Always.** No exceptions for "simple" changes.

| Change Type | Spec Depth |
|-------------|------------|
| Bug fix | Minimal (problem, root cause, fix, test) |
| New feature | Full (requirements, design, tasks, tests) |
| Refactor | Medium (goal, approach, validation) |
| Config change | Minimal (what, why, rollback) |

### 10.6 Spec Kit Commands

```bash
# Workspace-aware (uses current zone/mode context)
/specify "description"     # Start spec for new work
/plan                      # Generate technical plan from spec
/task                      # Break plan into tasks
/implement                 # Execute current task
/verify                    # Check acceptance criteria
/spec status               # Show current spec state
/spec list                 # List active specs in workspace
```

### 10.7 Git Automation

Git commits and pushes happen automatically. Never think about "did I commit?" or "did I push?"

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────┐
│  While working (continuous)                                     │
│                                                                 │
│  File change detected (debounce 30s)                            │
│      ↓                                                          │
│  Auto-commit to wip/{spec-id}                                   │
│      ↓                                                          │
│  Auto-push to GitHub                                            │
│                                                                 │
│  Invisible. You never think about this.                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  On /verify pass                                                │
│                                                                 │
│  Squash WIP commits → single clean commit                       │
│      ↓                                                          │
│  Merge to main                                                  │
│      ↓                                                          │
│  Push main to GitHub                                            │
│      ↓                                                          │
│  Delete WIP branch (local + remote)                             │
└─────────────────────────────────────────────────────────────────┘
```

**What this guarantees:**

| Concern | Handled |
|---------|---------|
| Work committed | Always (every 30s after change) |
| Work pushed to GitHub | Always (after every commit) |
| Work safe if instance dies | Yes, on GitHub |
| Git history clean | Yes, squashed on `/verify` |
| Manual git commands needed | Never (unless you want to) |

**Implementation:**

- `gitwatch` daemon per active repo
- Hooks into Spec Kit `/verify` for squash-merge
- WIP branch naming: `wip/{spec-id}` (e.g., `wip/feature-auth`)
- Commit messages: auto-generated with timestamp + changed files

**Branch flow:**

```
main ─────────────────────────────────●─────────────
                                      ↑
                                      │ squash merge
                                      │
wip/feature-auth ──●──●──●──●──●──●──┘
                   ↑  ↑  ↑  ↑  ↑  ↑
                   auto-commits (invisible)
```

---

## 11. Out of Scope

| Feature | Reason |
|---------|--------|
| Outbound automation | Collector, not actor |
| Push notifications | Polling model |
| Multi-instance/HA | Single user workstation |
| Mobile app | CLI only |
| GUI | Terminal only |
| Offline Claude | Bedrock requires network |

---

## 12. Open Questions

| Question | Status |
|----------|--------|
| Secondary offsite backup destination | TBD |
| Attachment storage/download location | TBD |
| Triage feedback loop (improve Claude) | v2 |

---

## Appendix A: Field Sync Matrix

### ServiceDesk Plus

| Field | Inbound | Outbound |
|-------|---------|----------|
| id | ✓ | — |
| title/subject | ✓ | ✓ |
| description | ✓ | ✓ (create) |
| status | ✓ | ✓ |
| priority | ✓ | ✓ |
| assignee | ✓ | ✓ |
| requester | ✓ | — |
| notes | ✓ | ✓ (append) |
| worklogs | ✓ | ✓ (append) |
| resolution | ✓ | ✓ (close) |

### Azure DevOps

| Field | Inbound | Outbound |
|-------|---------|----------|
| id | ✓ | — |
| title | ✓ | ✓ |
| description | ✓ | ✓ |
| state | ✓ | ✓ |
| assigned_to | ✓ | ✓ |
| priority | ✓ | ✓ |
| comments | ✓ | ✓ (append) |

### MS365 Mail

| Field | Inbound | Outbound |
|-------|---------|----------|
| id, subject, from, to, body | ✓ | — |
| is_read, categories, flag | ✓ | ✓ |
| Send reply | — | ✓ |

### Slack

| Field | Inbound | Outbound |
|-------|---------|----------|
| id, channel, author, text | ✓ | — |
| Post reply, add reaction | — | ✓ |

### Gmail / GCal / Telegram

Similar patterns - see detailed field matrix in conversation.

---

## Appendix B: Polling Schedule

| Poller | Interval | Method |
|--------|----------|--------|
| ms365-mail | 5 min | Delta query |
| ms365-cal | 5 min | Delta query |
| sdp | 5 min | Modified time filter |
| devops | 5 min | Work item query |
| slack | 60s | slackdump |
| gmail | 5 min | history.list |
| gcal | 5 min | syncToken |
| telegram | 60s | getUpdates |

---

## Appendix C: PAI Integration

Imladris 2.0 builds around PAI (Personal AI Infrastructure):

**PAI Provides:**
- AI brain (skills, memory, hooks)
- Goal context (TELOS)
- Execution methodology (Algorithm)
- Response format standards

**Imladris Provides:**
- Workspace organization (zones/modes)
- Datahub (external sources → unified storage)
- Context signaling (status bar, colors)
- Bidirectional sync

**Spec Kit Provides:**
- Specification-driven development workflow
- Four-phase structure (specify → plan → task → implement)
- Acceptance criteria and test definitions
- Consistent methodology for all code changes

**Layer Integration:**

```
┌─────────────────────────────────────────────────────────────────┐
│  User Request                                                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Spec Kit: /specify                                             │
│  "WHAT to build" - requirements, constraints, acceptance        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  PAI: Skills + TELOS                                            │
│  "HOW to think" - methodology, patterns, goal alignment         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  CLAUDE.md: Project Rules                                       │
│  "HOW to behave here" - repo conventions, constraints           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Claude Code: Execution                                         │
│  "DO the work" - code, tests, commits                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Spec Kit: /verify                                              │
│  "CONFIRM done" - acceptance criteria validation                │
└─────────────────────────────────────────────────────────────────┘
```

**New PAI Skills for Imladris:**

| Skill | Purpose |
|-------|---------|
| **Triage** | Batch classification (actionable/keep/delete) |
| **SpecAssist** | Help write clear specifications |
| **TaskContext** | Summarize/restore workspace context |
| **Comms** | Draft replies for email/chat |

---

## Appendix D: Host vs AI Boundary

### Overview

Clear separation between deterministic host code (Imladris) and AI-interpreted skills (Curu-skills).

| Layer | Repository | Characteristics |
|-------|------------|-----------------|
| **Host (Imladris)** | sethdf/imladris | Deterministic, versioned, tested, CLI/code |
| **AI (Curu-skills)** | sethdf/curu-skills | AI-interpreted, flexible, customizable |

### Host Layer (Imladris)

Deterministic functionality that must work identically every time:

| Component | Implementation | Why Host |
|-----------|----------------|----------|
| Pollers | Bun | Deterministic sync logic |
| Queue processor | Bun | Deterministic write handling |
| Auth-keeper | Shell/Bun | Security-sensitive token management |
| Workspace commands | Shell | Deterministic tmux control |
| Status TUI | Python | Deterministic display |
| Index rebuild | Bun | Deterministic SQL operations |
| Datahub CLI | Bun | Deterministic data operations |
| Conflict detection | Bun | Deterministic comparison |

### AI Layer (Curu-skills)

Functionality that benefits from AI interpretation:

| Component | Skill | Why AI |
|-----------|-------|--------|
| Triage | Triage skill | Classification requires understanding |
| Context summarization | TaskContext skill | Summarization is AI strength |
| Reply drafting | Comms skill | Composition benefits from AI |
| Search interpretation | Search skill | Intent understanding |
| Task breakdown | Task skill | Planning benefits from AI |
| Priority suggestions | Triage skill | Judgment calls |

### Decision Rule

| If the component... | Then... |
|---------------------|---------|
| Must work identically every time | Host (Imladris) |
| Benefits from AI interpretation | AI (Curu-skills) |
| User might want to customize behavior | AI (Curu-skills) |
| Is security/auth sensitive | Host (Imladris) |
| Directly interacts with external APIs | Host (Imladris) |
| Formats, interprets, or generates content | AI (Curu-skills) |

### Interface Boundary

Skills call Imladris CLI tools, never external APIs directly:

```
┌─────────────────────────────────────────────────────────────────┐
│  AI Layer (Curu-skills)                                         │
│                                                                 │
│  Triage skill ──────┐                                           │
│  Task skill ────────┼──► Calls Imladris CLI                     │
│  Comms skill ───────┘                                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Host Layer (Imladris)                                          │
│                                                                 │
│  datahub query --actionable     ← Read items                    │
│  datahub write --note "..."     ← Write to queue                │
│  datahub triage --batch         ← Trigger triage                │
│  auth-keeper get <service>      ← (internal only)               │
│                                                                 │
│                    │                                            │
│                    ▼                                            │
│            External APIs (SDP, MS365, etc.)                     │
└─────────────────────────────────────────────────────────────────┘
```

### Cloud Account Discoverability

Skills need to know which cloud accounts are accessible without accessing credentials directly.

**Problem:** Claude doesn't inherently know which AWS/GCP accounts exist or are accessible.

**Solution:** Skills query auth-keeper CLI for account registry:

```bash
# Skill runs this to discover accounts
auth-keeper aws list --json

# Returns:
{
  "accounts": [
    {
      "id": "111111111111",
      "name": "prod",
      "alias": "org-prod",
      "purpose": "Production environment",
      "roles": ["ReadOnlyAccess", "AdminAccess"],
      "default_role": "ReadOnlyAccess"
    },
    ...
  ]
}

# Skill runs this to use a specific account
auth-keeper aws get org-prod --role ReadOnly
# Sets AWS_PROFILE=org-prod-readonly in environment
```

**Skill Pattern for Cloud Work:**

```markdown
## AWS Account Discovery

Before any AWS operation:
1. Run `auth-keeper aws list --json` to get accessible accounts
2. Present accounts to user if ambiguous
3. Run `auth-keeper aws get <account>` to set context
4. Proceed with AWS CLI commands

Never assume account IDs or hardcode credentials.
```

**Registry Updates:**

When user gains/loses access to accounts:
1. Update BWS secret (`aws-accounts` or `gcp-projects`)
2. Run `auth-keeper aws generate-config`
3. Skills automatically discover new accounts on next query

### Benefits

| Benefit | How |
|---------|-----|
| Security | Auth never exposed to AI layer |
| Testability | Host layer is deterministic, testable |
| Flexibility | AI layer can be customized without breaking core |
| Reliability | Critical sync logic is deterministic |
| Upgradability | Can update skills without touching host code |
| Discoverability | Skills query host for available resources |

---

## Appendix E: PAI Workspace Integration

### Overview

Context preservation uses PAI's existing infrastructure (hooks, memory, skills) rather than building parallel systems. Hooks handle session boundaries; skills handle intra-session transitions.

### Context Storage

All context stored within PAI's structure:

```
~/.claude/history/
├── workspaces/                  ← Workspace-level context
│   ├── work:tasks.md
│   ├── work:projects.md
│   ├── work:comms.md
│   ├── home:tasks.md
│   └── ...
├── tasks/                       ← Task-level context
│   ├── sdp-123.md
│   ├── sdp-456.md
│   └── ...
├── sessions/                    ← Existing PAI
├── learnings/
└── decisions/
```

### Environment Variables

Set by workspace switch commands, read by hooks and skills:

```bash
export CONTEXT=work              # Zone (set by direnv on cd)
export WORKSPACE_MODE=tasks      # Mode (set by /work tasks)
export WORKSPACE_NAME=work:tasks # Combined (derived)
export CURRENT_TASK=sdp-123      # Active task ID
```

### Session Lifecycle (Hooks)

**SessionStart Hook** - Loads context on session start:

```typescript
// ~/.claude/hooks/workspace-context-hook.ts
export async function onSessionStart(input: HookInput): Promise<HookOutput> {
  const workspace = process.env.WORKSPACE_NAME;
  const taskId = process.env.CURRENT_TASK;

  let context = "";

  // Load workspace context
  const workspaceFile = `~/.claude/history/workspaces/${workspace}.md`;
  if (fs.existsSync(workspaceFile)) {
    context += fs.readFileSync(workspaceFile, 'utf-8');
  }

  // Load task context if active
  if (taskId) {
    const taskFile = `~/.claude/history/tasks/${taskId}.md`;
    if (fs.existsSync(taskFile)) {
      context += "\n\n" + fs.readFileSync(taskFile, 'utf-8');
    }
  }

  return { continue: true, context };
}
```

**SessionEnd Hook** - Saves context on session end:

```typescript
// ~/.claude/hooks/workspace-autosave-hook.ts
export async function onSessionEnd(input: HookInput): Promise<HookOutput> {
  const workspace = process.env.WORKSPACE_NAME;
  const taskId = process.env.CURRENT_TASK;

  // Generate summary from transcript
  const summary = generateSummary(input.transcript);

  // Save workspace context
  const workspaceFile = `~/.claude/history/workspaces/${workspace}.md`;
  fs.writeFileSync(workspaceFile, formatWorkspaceContext(summary, taskId));

  // Save task context if active
  if (taskId) {
    const taskFile = `~/.claude/history/tasks/${taskId}.md`;
    fs.writeFileSync(taskFile, formatTaskContext(summary));
  }

  return { continue: true };
}
```

**PreCompact Hook** - Preserves context before summarization:

```typescript
// ~/.claude/hooks/precompact-save-hook.ts
export async function onPreCompact(input: HookInput): Promise<HookOutput> {
  // Same logic as SessionEnd - save before context is compacted
  // Ensures context is preserved even if Claude summarizes aggressively
  saveCurrentContext(input);
  return { continue: true };
}
```

### Intra-Session (Skills)

Skills handle context within a session (no hooks fire):

**/task switch** - Save current, load new:

```
User: /task switch sdp-456

Claude (TaskContext skill):
1. Summarizes current work: "You were debugging auth token refresh..."
2. Writes to ~/.claude/history/tasks/sdp-123.md
3. Reads ~/.claude/history/tasks/sdp-456.md
4. Injects new context: "Resuming SDP-456: You were implementing..."
5. Updates CURRENT_TASK=sdp-456
```

**/park** - Force save without ending session:

```
User: /park "investigating rate limiting issue"

Claude (TaskContext skill):
1. Saves current context immediately (same as SessionEnd would)
2. Adds user note to context file
3. Confirms: "Context saved. You can safely switch or close."
```

**/spec pause** - Save spec state:

```
User: /spec pause

Claude (SpecAssist skill):
1. Saves current spec progress
2. Notes phase (specify/plan/task/implement)
3. Records pending decisions
4. Writes to .specs/{spec-id}.paused.md
```

### Context File Format

**Workspace Context** (`~/.claude/history/workspaces/work:tasks.md`):

```markdown
---
workspace: work:tasks
updated: 2026-01-29T14:32:00Z
active_task: sdp-123
---

## Last Session Summary

Working on SDP-123 (auth token refresh bug). Found root cause in
TokenManager.refresh() - wasn't handling 401 responses correctly.

## Active Task

- **ID:** sdp-123
- **Status:** in-progress
- **Last action:** Reading TokenManager.ts

## Pending Questions

- Should we retry on 401 or immediately refresh?
- Need to check if refresh token is also expired

## Open Files

- src/auth/TokenManager.ts:142
- tests/auth/TokenManager.test.ts
```

**Task Context** (`~/.claude/history/tasks/sdp-123.md`):

```markdown
---
task_id: sdp-123
source: sdp
title: Auth token refresh failing intermittently
updated: 2026-01-29T14:32:00Z
spec_id: fix-auth-refresh
---

## Summary

Investigating intermittent auth failures. Users report being logged out
randomly. Found that TokenManager.refresh() doesn't handle 401 during
refresh attempt.

## Progress

1. ✓ Reproduced issue locally
2. ✓ Found root cause in TokenManager.ts:142
3. → Implementing fix
4. ○ Write tests
5. ○ Verify fix

## Key Findings

- 401 during refresh causes infinite loop
- refresh_token might also be expired
- Need to check expiry BEFORE attempting refresh

## Next Steps

Implement retry logic with exponential backoff, add refresh token
expiry check.
```

### Complete Context Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  Session Boundaries (Hooks)                                     │
│                                                                 │
│  SessionStart ──► Load workspace + task context                 │
│  SessionEnd   ──► Save workspace + task context                 │
│  PreCompact   ──► Save before Claude summarizes                 │
└─────────────────────────────────────────────────────────────────┘
         │
         │ Hooks fire automatically
         │
┌────────┴────────────────────────────────────────────────────────┐
│  Within Session (Skills)                                        │
│                                                                 │
│  /task switch ──► Save current task, load new task              │
│  /task pause  ──► Save task context (no load)                   │
│  /park        ──► Save all context immediately                  │
│  /spec pause  ──► Save spec state                               │
└─────────────────────────────────────────────────────────────────┘
         │
         │ Both read/write same files
         │
┌────────┴────────────────────────────────────────────────────────┐
│  Storage                                                        │
│                                                                 │
│  ~/.claude/history/workspaces/{workspace}.md                    │
│  ~/.claude/history/tasks/{task-id}.md                           │
└─────────────────────────────────────────────────────────────────┘
```

### Context Never Lost

| Scenario | What Saves Context |
|----------|-------------------|
| Normal session end | SessionEnd hook |
| Task switch mid-session | TaskContext skill |
| `/park` command | TaskContext skill |
| Context window fills | PreCompact hook |
| SSH disconnect | SessionEnd hook (if clean) |
| Claude Code crash | PreCompact hook (last save) + JSONL transcript |
| Instance reboot | JSONL transcript + `/resume` |

### Recovery Commands

```bash
/resume              # PAI built-in: reload from JSONL transcript
/context show        # Show current loaded context
/context reload      # Force reload from context files
/task history        # Show task context history
```

### Git Automation Controls

```bash
/git pause           # Pause auto-commit (messy refactor)
/git resume          # Resume auto-commit
/git status          # Show auto-commit state
```

### Spec Lifecycle Controls

```bash
/spec pause          # Pause spec, keep WIP branch
/spec resume         # Resume paused spec
/spec abandon        # Archive spec, delete WIP branch
/spec list --all     # Show active, paused, abandoned
```

### Parallel Tasks (Pane-Based)

Work on multiple tasks simultaneously using tmux panes with separate Claude sessions.

**Use case:** Claude is generating code or researching in one session; you want to continue working on something else without waiting.

**Layout:**

```
┌─────────────────────────────────────────────────────────────────┐
│ work:tasks                                                      │
├─────────────────────────────────────────────────────────────────┤
│ Claude session 1 (sdp-123)                                      │
│ [generating code...]                                            │
├─────────────────────────────────────────────────────────────────┤
│ Claude session 2 (sdp-456)                                      │
│ [interactive - you're working here]                             │
└─────────────────────────────────────────────────────────────────┘
```

**Commands:**

```bash
/task split              # Picker: select from actionable datahub items
/task split sdp-456      # Split with specific datahub item
/task split -v sdp-456   # Split vertically (left/right)
/task split --fresh      # Prompt for description → create in datahub → sync to SDP
/task focus              # Toggle focus between panes
/task close-pane         # Close current pane, save its context
/task merge              # Close secondary pane, bring context back to main
```

**Task picker (shown on `/task split` with no args):**

```
Select task for new pane:

  Actionable (work:tasks):
  > sdp-123  Auth token refresh failing       [in-progress]
    sdp-456  Add rate limiting to API         [open]
    sdp-789  Update user dashboard            [open]
    devops-12 Fix CI pipeline timeout         [open]

  [Enter] Select  [/] Filter  [n] New (--fresh)  [q] Cancel
```

**Fresh task flow (`/task split --fresh`):**

```
/task split --fresh
    ↓
Claude: "What are you working on?"
    ↓
User: "Investigating memory leak in auth service"
    ↓
Creates datahub item:
  - source: local
  - type: standalone-task
  - title: "Investigating memory leak in auth service"
  - zone: work (from current workspace)
    ↓
Queues sync to SDP (creates standalone task)
    ↓
Returns new task ID (e.g., sdp-790)
    ↓
Splits pane with new task
```

**Benefits of --fresh flow:**

| Aspect | Value |
|--------|-------|
| Nothing untracked | Even ad-hoc work gets captured |
| Single source of truth | All tasks in datahub, all synced to SDP |
| Findable later | "What was that thing I was working on?" |
| Visible to team | Standalone tasks appear in SDP |

**What happens on `/task split`:**

1. tmux splits current pane (horizontal by default)
2. New pane starts fresh Claude Code session
3. Sets `CURRENT_TASK=sdp-456` in new pane
4. Loads sdp-456 context via SessionStart hook
5. Both panes work independently

**Each pane has:**

| Property | Behavior |
|----------|----------|
| Claude session | Separate (independent context) |
| CURRENT_TASK | Different per pane |
| Context files | Saved independently |
| Git auto-commit | Both active (same repo, same WIP branch is fine) |

**Native tmux also works:**

```bash
Ctrl-b "         # Split horizontally
Ctrl-b %         # Split vertically
Ctrl-b o         # Switch between panes
Ctrl-b z         # Zoom current pane (full screen)
Ctrl-b arrows    # Resize panes
```

**When to use:**

| Situation | Approach |
|-----------|----------|
| Quick detour, will return | `/task switch` (same session) |
| Need to wait for Claude | `/task split` (parallel sessions) |
| Two related tasks simultaneously | `/task split` (parallel sessions) |
| Compare two approaches | `/task split -v` (side by side) |

### Mode Data Sources

All modes get PAI context preservation. The difference is whether items sync to external systems via datahub.

| Mode | Datahub (external sync) | PAI Context | Picker Source |
|------|-------------------------|-------------|---------------|
| **tasks** | Yes → SDP (Request/Incident), DevOps | Yes | Datahub actionable items |
| **comms** | Yes → Email, Slack | Yes | Datahub messages/threads |
| **projects** | Yes → SDP (if owner) | Yes | Datahub owned projects |
| **research** | No | Yes | PAI history (local topics) |
| **adhoc** | Yes → SDP (General Task) | Yes | Datahub + PAI history |

### Research Mode Context

Research topics are tracked locally via PAI history, not synced externally.

**Storage:**

```
~/.claude/history/
├── workspaces/
│   ├── work:research.md      ← Current research summary
│   └── home:research.md
└── research/                  ← Individual research topics
    ├── aws-cost-optimization.md
    ├── nix-flakes-patterns.md
    └── zero-trust-architecture.md
```

**On entering `/work research`:**

```
SessionStart hook fires
    ↓
Loads ~/.claude/history/workspaces/work:research.md
    ↓
Claude shows:

"Recent research topics:
 - AWS cost optimization (last: 2 days ago)
 - Nix flakes patterns (last: 1 week ago)
 - Zero trust architecture (last: 2 weeks ago)

Continue one of these, or start new research?"
```

**Commands:**

```bash
/research                    # Enter research mode, show recent topics
/research continue <topic>   # Resume specific research
/research new "topic"        # Start new research (saved to PAI history)
/research list               # List all research topics
```

### Adhoc Mode Context

Adhoc sessions sync to SDP as **General Tasks** (standalone tasks not linked to requests/problems/changes). This makes quick work visible and findable later.

**Key difference from tasks mode:**
- **tasks** → SDP Request/Incident (linked to a ticket workflow)
- **adhoc** → SDP General Task (standalone, no parent entity)

**Storage:**

```
~/.claude/history/
├── workspaces/
│   ├── work:adhoc.md         ← Current adhoc summary
│   └── home:adhoc.md
└── adhoc/                     ← Individual adhoc sessions (timestamped)
    ├── 2026-01-29-14-32.md
    ├── 2026-01-29-16-45.md
    └── 2026-01-28-09-15.md

~/work/datahub/items/
├── adhoc-2026-01-29-14-32.md  ← Synced to SDP as General Task
└── ...
```

**On entering `/work adhoc`:**

```
SessionStart hook fires
    ↓
Loads ~/.claude/history/workspaces/work:adhoc.md
    ↓
Claude shows:

"Recent adhoc sessions:
 - 14:32 - Debugging why npm install hangs (SDP: adhoc-14)
 - Yesterday - Testing new tmux config (SDP: adhoc-13)
 - 2 days ago - Quick AWS CLI lookup (SDP: adhoc-12)

Continue recent session or start fresh?"
```

**Commands:**

```bash
/adhoc                    # Enter adhoc, show recent sessions
/adhoc continue           # Resume most recent
/adhoc new "description"  # Start fresh → creates SDP General Task
/adhoc close "notes"      # Mark complete in SDP + local
```

**SDP General Task sync:**

| Direction | Behavior |
|-----------|----------|
| Create | `/adhoc new` → queues General Task creation in SDP |
| Update | `/task note` → syncs note to SDP task |
| Complete | `/adhoc close` → marks SDP task complete |
| Worklogs | `/task log` → syncs time to SDP task |

**Why General Tasks for adhoc:**
- Quick work still gets tracked
- Findable later ("what was I doing last Tuesday?")
- Time can be logged against it
- Can be converted to full Request/Incident if it grows
- No ceremony - just start working

### PAI Update Safety

Extensions are additive bolt-ons to PAI, not modifications. Updates are validated before applying.

**Extension Method:**

| Extension | Method | Modifies PAI Core? |
|-----------|--------|-------------------|
| Custom hooks | Files in `~/.claude/hooks/` | No - additive |
| Custom skills | Files in `~/.claude/skills/` | No - additive |
| Environment variables | Set by workspace commands | No - PAI reads them |
| History storage | Write to `~/.claude/history/` | No - uses existing structure |

**Potential Breaking Changes:**

| If PAI changes... | Risk |
|-------------------|------|
| Hook API (HookInput/HookOutput) | Hooks fail to execute |
| History directory structure | Context files not found |
| Skill loading mechanism | Skills not loaded |
| Settings.json schema | Hook registration fails |

**Update Validation (before applying PAI updates):**

```
1. Check PAI changelog for breaking changes
2. Run interface compatibility tests:
   - Hook API: SessionStart, SessionEnd, PreCompact still work
   - History structure: workspaces/, tasks/, research/, adhoc/ exist
   - Skill loading: markdown files in ~/.claude/skills/ load
3. If incompatible → hold update, notify for manual review
4. If compatible → apply, validate, rollback on failure
```

**Graceful Degradation:**

Extensions fail safely - Claude still works, just without enhancements:

| Failure | Behavior |
|---------|----------|
| Missing context file | Start fresh (warn, don't crash) |
| Hook error | Continue session (log error) |
| Skill not loaded | Claude works without skill (degraded) |
| History write fails | Warn, session continues |
