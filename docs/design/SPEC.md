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
11. [Chat Gateway (Mobile Access)](#11-chat-gateway-mobile-access)
12. [Out of Scope](#12-out-of-scope)
13. [Open Questions](#13-open-questions)

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
| Transition | Friction Level | What This Means |
|------------|----------------|-----------------|
| Start working | Low | Just `/work`, context loads automatically |
| Within mode | Low | Commands execute immediately |
| Mode → Mode (same zone) | Medium | Brief pause, context summary shown |
| Zone → Zone | Higher | Full context save, confirmation prompt |

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
│                   Curu skills (PAI) call Windmill API                      │
│                              │                                      │
│                              ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Windmill (native via Nix/systemd) ◄── Integration Gateway    │   │
│  │                                                               │   │
│  │  Scheduled:  pollers/* (sync data → datahub)                 │   │
│  │  On-demand:  queries/* (adhoc lookups, triggered by PAI)     │   │
│  │  Webhooks:   real-time events from external systems          │   │
│  │                                                               │   │
│  │  ALL external API calls go through Windmill scripts          │   │
│  │  Credentials: Windmill variables (synced from BWS)           │   │
│  │  Built-in: retries, rate limits, logging, audit              │   │
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
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │ Tailscale VPN (no public ports)
                              ▼
    External Systems: SDP, MS365, DevOps, Slack, Gmail, GCal,
                      Telegram, Ramp, Securonix, etc.
```

### 3.2 Technology Stack

| Layer | Technology |
|-------|------------|
| Infrastructure | Terraform (AWS) |
| Configuration | Nix + home-manager |
| Integration Gateway | Windmill (APIs, credentials, scheduling, monitoring) |
| Runtime | Bun/Python (scripts in Windmill) |
| AI | Claude Code via AWS Bedrock |
| Framework | PAI (Personal AI Infrastructure) |
| Storage | Flat files (markdown) + SQLite index |
| Secrets | BWS (bootstrap only → Windmill variables) |
| Access | Tailscale SSH only |

### 3.3 Simplified Component Model

**Only 4 systemd services:**

| Service | Purpose |
|---------|---------|
| `postgresql` | Windmill job queue |
| `windmill-server` | API + UI |
| `windmill-worker` | Script execution |
| `tailscaled` | Network access |

Everything else runs in Windmill.

**Eliminated components:**

| Removed | Replaced By |
|---------|-------------|
| auth-keeper.sh (~1800 lines) | Windmill OAuth resources |
| Custom queue processor | Windmill job queue |
| systemd timers (app-level) | Windmill schedules |
| Per-service Curu skills (PAI) | Single Windmill skill |
| Custom status/monitoring | Windmill UI |
| Scattered retry logic | Windmill policies |

**What remains:**

```
Bootstrap:
  systemd → postgres → windmill → tailscale
  luks-unlock (oneshot, pre-boot)
  bws-to-windmill.ts (one-time secret sync)

Runtime:
  Windmill handles everything else

User Interface:
  tmux + workspaces
  Claude Code + PAI
  One Windmill skill (routes all external calls)
```

### 3.4 Data Flow

```
                    External Systems
                          ▲
                          │
                          │ ALL external API calls
                          │
                          ▼
┌─────────────────────────────────────────────────┐
│              Windmill (Gateway)                  │
│                                                  │
│   Inbound:   scheduled pollers → datahub        │
│   Outbound:  on-demand scripts ← PAI triggers   │
│   Webhooks:  real-time events → datahub         │
└─────────────────────────────────────────────────┘
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
     Datahub (files)            Direct responses
            │                   (adhoc queries)
            ▼
     Triage (Claude)
            │
            ▼
     Index (SQLite)
            │
            ▼
     Workspaces (Claude sessions)
            │
            │ Curu skill (PAI) triggers Windmill
            └──────────────────────────────────────►
```

**Key principle:** Claude/PAI never calls external APIs directly. All external communication routes through Windmill scripts.

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

**ID Structure (globally unique):**

IDs follow the pattern `{source}-{external_id}` to guarantee uniqueness across all sources:

| Source | External ID | Datahub ID | File Name |
|--------|-------------|------------|-----------|
| SDP request | `123` | `sdp-123` | `sdp-123.md` |
| SDP general task | `456` | `sdp-task-456` | `sdp-task-456.md` |
| MS365 email | `AAMk...` | `ms365-AAMkAG...` | `ms365-AAMkAG....md` |
| Gmail | `18d5f...` | `gmail-18d5f...` | `gmail-18d5f....md` |
| Slack message | `1706...` | `slack-1706...` | `slack-1706....md` |
| DevOps work item | `789` | `devops-789` | `devops-789.md` |
| Adhoc (local) | timestamp | `adhoc-2026-01-29-14-32` | `adhoc-2026-01-29-14-32.md` |

**Why this matters:**
- `email-123` from Gmail and `123` from SDP are different items
- File names match IDs for easy correlation
- External IDs preserved for sync back to source

**Example item file (`sdp-123.md`):**

```markdown
---
id: sdp-123
source: sdp
type: request
title: Fix auth module
status: in-progress
zone: work
triage: act
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

**Field reference:**

| Field | Type | Values |
|-------|------|--------|
| `id` | string | `{source}-{external_id}` (globally unique) |
| `source` | string | `sdp`, `ms365`, `gmail`, `slack`, `devops`, `adhoc`, etc. |
| `type` | string | `request`, `task`, `email`, `message`, `work-item`, etc. |
| `zone` | string | `work`, `home` |
| `triage` | string | `act`, `keep`, `delete` |
| `priority` | string | `P0`, `P1`, `P2`, `P3` (optional) |
| `tags` | array | Tag names |

### 5.4 Index Schema

```sql
CREATE TABLE items (
  id TEXT PRIMARY KEY,           -- '{source}-{external_id}' format
  source TEXT NOT NULL,          -- 'sdp', 'ms365', 'gmail', etc.
  type TEXT,                     -- 'request', 'email', 'message', etc.
  zone TEXT NOT NULL,            -- 'work', 'home'
  triage TEXT DEFAULT 'keep',    -- 'act', 'keep', 'delete'
  status TEXT,
  priority TEXT,
  timestamp TEXT,
  title TEXT,
  file_path TEXT,
  updated_at TEXT
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,     -- lowercase, normalized
  color TEXT,                    -- hex color for UI
  auto_rule TEXT                 -- optional: regex or rule for auto-tagging
);

CREATE TABLE item_tags (
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
  source TEXT,          -- 'manual', 'auto', 'external' (synced from MS365/Gmail)
  created_at TEXT,
  PRIMARY KEY (item_id, tag_id)
);

CREATE INDEX idx_triage ON items(zone, triage);
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
| `act` | Forever |
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
| `act` | Needs user action | Surfaces in workspace |
| `keep` | Reference/archive | Stored, searchable |
| `delete` | Noise/irrelevant | Moved to trash |

**Engine:** Claude batch triage (Curu skill (PAI) pattern)

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

### 6.1 Simplified Auth Model

**BWS is bootstrap-only.** On startup, secrets sync to Windmill variables. Windmill handles all runtime credential management.

```
┌─────────────────────────────────────────────────────────────────┐
│ Bootstrap (once on startup)                                     │
│                                                                 │
│   BWS ──sync──▶ Windmill Variables                             │
│                                                                 │
│   scripts/bootstrap/bws-to-windmill.ts                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Runtime (Windmill handles everything)                           │
│                                                                 │
│   OAuth tokens: Windmill resources (auto-refresh)              │
│   API keys: Windmill variables (static)                        │
│   AWS roles: On-demand STS assume (scripts/aws/get-session.ts) │
└─────────────────────────────────────────────────────────────────┘
```

**Eliminated:** auth-keeper.sh (~1800 lines). Windmill replaces it entirely.

### 6.2 Secret Naming Convention

```
{zone}-{service}-{item}

Examples:
work-ms365-tenant-id
work-ms365-client-id
work-sdp-api-token
home-google-client-id
home-telegram-bot-token
```

### 6.3 Auth Types by Service

| System | Auth Type | Windmill Handles |
|--------|-----------|------------------|
| MS365 | OAuth2 (Service Principal) | ✓ Auto-refresh via resource |
| SDP | OAuth2 (Zoho) | ✓ Auto-refresh via resource |
| DevOps | PAT | Static variable (warn on expiry) |
| Slack | OAuth2 | ✓ Auto-refresh via resource |
| Google | OAuth2 | ✓ Auto-refresh via resource |
| Telegram | Bot token | Static variable (never expires) |
| AWS | STS AssumeRole | On-demand via script |

### 6.4 Windmill Credential Access

**In scripts:**

```typescript
// API keys (static)
const token = await wmill.getVariable("work-sdp-api-token");

// OAuth tokens (auto-refreshed)
const resource = await wmill.getResource("work-ms365");
const accessToken = resource.token;  // Always valid

// AWS (on-demand assume)
const creds = await wmill.runScript("aws/get-session", {
    account: "prod",
    role: "ReadOnly"
});
```

**No more:**
- `auth-keeper get work-ms365`
- `auth-keeper refresh work-sdp`
- `auth-keeper status`

Windmill UI shows all credential status.

### 6.5 Smart Discovery

Windmill scheduled script detects new BWS entries:

```
scripts/ops/bws-sync.ts (runs every 30 min)
    ↓
"New secret found: jira-api-token"
    ↓
Creates Windmill variable
    ↓
Creates local integration task in datahub
```

**Auto-created integration task:**

```
┌─────────────────────────────────────────────────────────────────┐
│  New service "jira" detected in BWS                             │
│                                                                 │
│  Creates datahub item:                                          │
│    id: local-integrate-jira-{timestamp}                         │
│    source: local                                                │
│    type: integration-task                                       │
│    title: "Build integration for jira"                          │
│                                                                 │
│  With checklist:                                                │
│    □ Create Windmill scripts (scripts/jira/*.ts)                │
│    □ Add schedule for sync                                      │
│    □ Test via Windmill UI                                       │
│    □ Document in CLAUDE.md                                      │
└─────────────────────────────────────────────────────────────────┘
```

**Simplified checklist** (no auth-keeper, no separate Curu skill (PAI)):

```markdown
## Checklist for new integration: jira

- [ ] **Scripts**: Create in Windmill
  - `scripts/jira/sync.ts` - scheduled poller
  - `scripts/jira/get-issue.ts` - on-demand query
  - `scripts/jira/update-issue.ts` - write-back

- [ ] **Schedule**: Add in Windmill UI
  - `jira/sync.ts` → `*/5 * * * *`

- [ ] **Test**: Run manually in Windmill UI

- [ ] **Document**: Update CLAUDE.md
```

One place to add (Windmill). One skill routes all (Windmill Curu skill (PAI)).

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
/item mark <id> <class># Override triage (act/keep/delete)
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
- Curu skills (PAI)
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

### 9.6 First-Time Setup (Bootstrap Guide)

Complete setup in this exact order. Each step depends on previous steps.

**Phase 1: Infrastructure (Terraform)**

```
1. Clone imladris repo locally
2. Configure terraform.tfvars (git-crypt encrypted)
3. terraform apply
4. Wait for instance to be ready
5. Note: Instance has Nix, Tailscale, base packages
```

**Phase 2: Access & Secrets**

```
6. tailscale up (from local machine, approve device)
7. ssh imladris (first connection)
8. BWS_ACCESS_TOKEN=<token> bws-init   ← Unlocks secrets access
9. imladris-unlock                      ← LUKS passphrase prompt
10. Verify: ls /data                    ← Should show directories
```

**Phase 3: Authentication Setup**

```
Order matters - some services depend on others.

11. auth-keeper setup work-ms365        ← Service principal + cert
12. auth-keeper setup work-sdp          ← OAuth2 (uses browser)
13. auth-keeper setup work-devops       ← PAT (manual entry)
14. auth-keeper setup work-slack        ← slackdump browser auth
15. auth-keeper setup home-google       ← OAuth2 (uses browser)
16. auth-keeper setup home-telegram     ← Bot token (manual entry)
17. auth-keeper status                  ← Verify all green
```

**Phase 4: Initial Sync**

```
18. datahub sync --initial              ← 365-day email backfill
    ├── ms365-mail: ~10-30 min (depends on volume)
    ├── gmail: ~10-30 min
    ├── sdp: ~1-5 min
    ├── devops: ~1-5 min
    ├── slack: ~5-15 min (slackdump)
    └── telegram: instant
19. datahub triage --batch              ← Initial classification
20. datahub status                      ← Verify counts
```

**Phase 5: Workspace Setup**

```
21. tmux new -s main                    ← Create main session
22. Run workspace-init                  ← Creates all 11 windows
23. /work                               ← Enter first workspace
24. Claude loads, shows context
```

**Verification Checklist:**

| Check | Command | Expected |
|-------|---------|----------|
| LUKS mounted | `mount \| grep /data` | `/dev/mapper/hall-of-fire on /data` |
| BWS accessible | `bws-get test` | No error |
| All auth valid | `auth-keeper status` | All services green |
| Datahub populated | `datahub stats` | Item counts > 0 |
| Workspaces ready | `tmux list-windows` | 11 windows |

**If Something Fails:**

| Failure | Recovery |
|---------|----------|
| LUKS won't unlock | Check passphrase, verify BWS keyfile exists |
| Auth setup fails | Check BWS secrets exist with correct names |
| Initial sync hangs | Check auth-keeper status for that service |
| Triage errors | Check Claude/Bedrock connectivity |

**Time Estimate:**

| Phase | Duration |
|-------|----------|
| Terraform | 5-10 min |
| Access & Secrets | 5 min |
| Auth Setup | 15-20 min (browser flows) |
| Initial Sync | 30-60 min (background OK) |
| Workspace Setup | 2 min |
| **Total** | **~1-1.5 hours** |

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
│  Phase 3: BREAKDOWN                                             │
│  /breakdown                                                     │
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
| **How Claude behaves** | Curu Skills (PAI) | Execution patterns, response formats |
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
Curu Skills (PAI)              ← Define HOW (patterns, methodology)
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
/breakdown                 # Break plan into implementable units
/implement                 # Execute current unit
/verify                    # Check acceptance criteria
/spec status               # Show current spec state
/spec list                 # List active specs in workspace
```

**Command naming rationale:**

| Command | Purpose | Why this name |
|---------|---------|---------------|
| `/task` | Datahub task management | Primary workflow, used constantly |
| `/breakdown` | Spec Kit phase 3 | Avoids collision, describes action |

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

**Security: Preventing Secret Leaks**

Auto-push to GitHub requires safeguards against accidental secret exposure.

**Pre-commit scanning (mandatory):**

```
┌─────────────────────────────────────────────────────────────────┐
│  Before every auto-commit:                                       │
│                                                                 │
│  1. Run secrets scanner (gitleaks/trufflehog)                   │
│  2. If secrets detected → BLOCK commit → alert user             │
│  3. If clean → proceed with commit + push                       │
└─────────────────────────────────────────────────────────────────┘
```

**Mandatory .gitignore patterns:**

```gitignore
# Secrets - NEVER commit
.env
.env.*
*.pem
*.key
*credentials*
*secret*
auth.json
tokens.json

# Imladris-specific
/datahub/          # Synced data contains PII
/.claude/          # May contain sensitive context
/queue/            # Pending writes may have tokens
```

**What triggers a block:**

| Pattern | Example | Action |
|---------|---------|--------|
| API keys | `AKIA...`, `sk-...` | Block + alert |
| Private keys | `-----BEGIN RSA PRIVATE KEY-----` | Block + alert |
| Passwords in code | `password = "..."` | Block + alert |
| AWS credentials | `aws_secret_access_key` | Block + alert |
| High entropy strings | Random 40+ char strings | Warn (may be false positive) |

**Recovery when blocked:**

```bash
# gitwatch alerts: "Commit blocked: potential secret in config.js:42"

# Option 1: Remove the secret
vim config.js                    # Remove secret, use env var instead

# Option 2: False positive - allowlist
echo "config.js:42" >> .gitleaks-allowlist

# gitwatch resumes automatically after fix
```

**WIP branches are semi-public:**

| Concern | Mitigation |
|---------|------------|
| WIP pushed to GitHub | Use private repos for sensitive work |
| Branch visible to collaborators | Secrets scanner prevents exposure |
| Squash loses history | WIP history preserved locally in reflog |

---

## 11. Chat Gateway (Mobile Access)

### 11.1 Purpose

Continue Claude sessions from iOS via existing chat platforms. This is NOT a mobile app—it's a bridge from Telegram (which already has an iOS app) to Claude Code sessions running on imladris.

### 11.2 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  iOS Device                                                 │
│  ┌─────────────┐                                           │
│  │ Telegram    │  (existing app, no custom code)           │
│  └──────┬──────┘                                           │
└─────────┼───────────────────────────────────────────────────┘
          │ Bot API (existing)
          ▼
┌─────────────────────────────────────────────────────────────┐
│  imladris                                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ chat-gateway.sh                                      │   │
│  │  - Extends telegram-inbox.sh                         │   │
│  │  - Routes /c messages to Claude                      │   │
│  │  - Captures responses, sends back                    │   │
│  └─────────────────────────────────────────────────────┘   │
│                        │                                    │
│                        ▼                                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ tmux session (work:tasks, home:adhoc, etc.)          │   │
│  │  - Claude Code running                               │   │
│  │  - send-keys for input                               │   │
│  │  - capture-pane for output                           │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 11.3 Commands

From Telegram on iOS:

| Command | Action |
|---------|--------|
| `/c <message>` | Send to active Claude session |
| `/c` (no args) | Show current session info |
| `/sessions` | List active tmux windows with Claude |
| `/switch <workspace>` | Switch to workspace (e.g., `work:tasks`) |
| `/new <workspace>` | Start new Claude session in workspace |
| `/last` | Show last response (if truncated) |
| `/cancel` | Cancel pending request |

Regular messages (no `/c`) continue to work as before—saved to inbox.

### 11.4 Session Management

**State file:** `~/.local/state/chat-gateway.json`

```json
{
  "active_session": "work:tasks",
  "last_request": "2026-01-29T14:32:00Z",
  "pending": false,
  "last_response_full": "/tmp/chat-gateway-last.txt"
}
```

**Session selection:**
1. Use explicit `/switch` if specified
2. Otherwise use `active_session` from state
3. Default to `work:adhoc` if no state

**Workspace mapping:**

| Workspace | tmux window |
|-----------|-------------|
| `work:tasks` | `main:work-tasks` |
| `work:comms` | `main:work-comms` |
| `home:adhoc` | `main:home-adhoc` |
| etc. | Pattern: `main:{zone}-{mode}` |

### 11.5 Input/Output Flow

**Input (iOS → Claude):**

```bash
# 1. Receive message from Telegram
msg="/c how do I fix the auth bug?"

# 2. Strip prefix, get content
content="how do I fix the auth bug?"

# 3. Get target session
session=$(jq -r '.active_session' ~/.local/state/chat-gateway.json)
tmux_target="main:${session//:/-}"  # work:tasks → main:work-tasks

# 4. Send to Claude
tmux send-keys -t "$tmux_target" "$content" Enter

# 5. Mark pending
update_state pending=true
```

**Output (Claude → iOS):**

```bash
# 1. Wait for Claude to finish (detect prompt return)
# Poll every 2s, timeout 5min

# 2. Capture response
response=$(tmux capture-pane -t "$tmux_target" -p | extract_last_response)

# 3. Truncate if needed (Telegram limit: 4096 chars)
if [[ ${#response} -gt 4000 ]]; then
    echo "$response" > /tmp/chat-gateway-last.txt
    response="${response:0:3900}...

[Truncated. Send /last for full response]"
fi

# 4. Send back
send_telegram_message "$response"

# 5. Clear pending
update_state pending=false
```

### 11.6 Response Detection

**Challenge:** Know when Claude has finished responding.

**Solution:** Prompt pattern detection + output stability

```bash
# Claude Code shows prompt when ready for input
# Detect by checking if output has stabilized

wait_for_response() {
    local target="$1"
    local timeout=300  # 5 min
    local elapsed=0
    local interval=2
    local last_hash=""

    while [[ $elapsed -lt $timeout ]]; do
        local content=$(tmux capture-pane -t "$target" -p)
        local current_hash=$(echo "$content" | md5sum | cut -d' ' -f1)

        # If content unchanged for 2 checks, assume done
        if [[ "$current_hash" == "$last_hash" ]]; then
            return 0
        fi

        last_hash="$current_hash"
        sleep $interval
        elapsed=$((elapsed + interval))
    done
    return 1  # Timeout
}
```

### 11.7 Security

| Control | Implementation |
|---------|----------------|
| Auth | Only accept from configured `telegram-chat-id` (existing) |
| Rate limit | 20 messages/minute, 100/hour |
| Cost awareness | Estimate tokens, warn on long prompts |
| Timeout | 5 minute max wait per request |
| Queue | One request at a time (reject if pending) |

### 11.8 Limitations

| Limitation | Workaround |
|------------|------------|
| No file uploads | Use `/sync` in datahub, reference by path |
| No streaming | Poll for completion, show "thinking..." |
| Response truncation | `/last` for full response |
| Single request queue | Wait for completion or `/cancel` |
| No multi-turn visibility | Session context maintained server-side |

### 11.9 Example Session

```
You: /c what's the status of the auth bug?

Bot: Looking at work:tasks context...

The auth bug (SDP-1234) is in progress. Last update:
added retry logic to token refresh. Tests passing locally,
CI pending.

Next step: Review CI results and update ticket.

---

You: /c update the ticket with current status

Bot: ✓ Updated SDP-1234:
- Added note: "Retry logic implemented, tests passing"
- Status: In Progress

---

You: /switch home:adhoc

Bot: ✓ Switched to home:adhoc

---

You: /c remind me to call mom tomorrow

Bot: Created reminder in home:tasks:
"Call mom" - Due: 2026-01-30

---

You: /sessions

Bot: Active sessions:
• work:tasks (2m ago)
• work:comms (1h ago)
• home:adhoc ← active
```

### 11.10 Implementation Phases

| Phase | Scope |
|-------|-------|
| 1 | Basic `/c` routing with fixed 30s wait |
| 2 | Smart completion detection, truncation, `/last` |
| 3 | Session management (`/sessions`, `/switch`, `/new`) |
| 4 | Rate limiting, cost estimates |

---

## 12. Out of Scope

| Feature | Reason |
|---------|--------|
| Outbound automation | Collector, not actor |
| Push notifications | Polling model |
| Multi-instance/HA | Single user workstation |
| Native mobile app | Chat gateway via Telegram instead |
| GUI | Terminal only (Telegram is the "GUI") |
| Offline Claude | Bedrock requires network |

---

## 13. Open Questions

| Question | Status |
|----------|--------|
| Secondary offsite backup destination | S3 (see Appendix F) |
| Attachment storage/download location | On-demand to `/data/attachments/` |
| Triage feedback loop (improve Claude) | v2 |
| Mobile/multi-device access | ✓ Resolved: Chat Gateway (Section 11) |

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

**Curu Skills (PAI) for Imladris:**

| Category | Skills |
|----------|--------|
| **Integration** (thin routing) | One skill per Windmill module |
| **AI Processing** | Triage, SpecAssist, TaskContext, Comms |

**Integration skills** — one per Windmill folder:

| Skill | Routes To | Purpose |
|-------|-----------|---------|
| SDP | `f/sdp/*` | ServiceDesk Plus tickets |
| MS365 | `f/ms365/*` | Email, calendar |
| Slack | `f/slack/*` | Messages |
| AWS | `f/aws/*` | Cross-account, S3 |
| Ramp | `f/ramp/*` | Expenses |
| Securonix | `f/securonix/*` | Security alerts |
| Ops | `f/ops/*` | Backups, maintenance |

**AI Processing skills:**

| Skill | Purpose |
|-------|---------|
| Triage | Batch classification |
| SpecAssist | Spec writing |
| TaskContext | Context summarization |
| Comms | Reply drafting |

**Pattern:** Each integration skill is ~20 lines of routing. Logic lives in Windmill scripts.

```
User: "show my SDP tickets"
  → SDP skill (routing)
  → Windmill f/sdp/get-tickets.ts (logic)
  → Returns data
```

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
| Windmill scripts | Bun/Python | Deterministic sync/API logic |
| Workspace commands | Shell | Deterministic tmux control |
| Status TUI | Python | Deterministic display |
| Datahub CLI | Bun | Deterministic data operations |
| Bootstrap | Shell | System initialization |

**Note:** Pollers, queue processor, and auth-keeper are now Windmill scripts, not separate components.

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
2. Notes phase (specify/plan/breakdown/implement)
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

### Projects Mode & Ownership

Projects mode surfaces long-running initiatives you own (vs tasks assigned to you).

**Ownership defined by:**

| Source | Owner Field | You Own If |
|--------|-------------|------------|
| SDP Project | `owner` or `project_manager` | Your user ID matches |
| DevOps Project | `project.owner` | Your user ID matches |
| Local project | `owner` in frontmatter | Set to `self` |

**What appears in projects:**

```
/work projects
    ↓
"Your projects (work):
 - Imladris 2.0 (local) - 3 open tasks
 - Q1 Security Audit (SDP) - 12 open tasks
 - API Migration (DevOps) - 8 open tasks

 Select project to see tasks and progress"
```

**Project vs Task distinction:**

| Aspect | Task | Project |
|--------|------|---------|
| Duration | Hours to days | Weeks to months |
| Subtasks | No | Yes (tasks belong to projects) |
| Ownership | Assigned to you | You're responsible for outcome |
| Completion | Single action | Multiple milestones |

**Commands:**

```bash
/projects                    # List owned projects
/projects show <id>          # Project details + task breakdown
/projects status <id>        # Update project status
/projects add-task <id>      # Create task under project
```

### Comms Mode Workflow

Comms mode is for **batch processing** communications - not staying in it all day. Enter, process actionable items, exit.

**What appears in comms:**

| Source | Item Type | Triage Filter |
|--------|-----------|---------------|
| MS365/Gmail | Email | `triage: act` (needs reply/action) |
| Slack | Thread/DM | `triage: act` (needs response) |
| Telegram | Message | `triage: act` (needs response) |

**Workflow:**

```
/work comms
    ↓
Claude shows inbox summary:

"Comms inbox (work):
 📧 Email: 4 actionable
 💬 Slack: 2 threads need response

 Oldest first:
 1. [email] ms365-AAMk... - Q3 budget review request (2 days ago)
 2. [email] ms365-BBNk... - Architecture decision needed (1 day ago)
 3. [slack] slack-1706... - @you: thoughts on API design? (4 hours ago)
 4. [email] ms365-CCPk... - Meeting follow-up (3 hours ago)
 ...

 Process items, or /inbox to see full list"
```

**Processing an email:**

```
User: "Let's handle the Q3 budget email"
    ↓
Claude loads full item:
- Shows email body
- Shows thread history (if reply)
- Shows sender context (from previous interactions)
    ↓
User: "Draft a reply saying I'll review by Friday"
    ↓
Claude drafts reply (Comms skill)
    ↓
User: "Send it" or "Revise: more formal"
    ↓
/comms send                    ← Queues reply to MS365
/comms done ms365-AAMk...      ← Marks item processed
```

**Processing a Slack thread:**

```
User: "What's the API design question?"
    ↓
Claude loads thread:
- Shows full thread context
- Shows who's involved
- Shows channel context
    ↓
User: "Reply that I prefer REST over GraphQL for this use case, with reasons"
    ↓
Claude drafts reply
    ↓
/slack reply slack-1706... "I'd recommend REST here because..."
    ↓
/comms done slack-1706...
```

**Comms Commands:**

```bash
# View
/inbox                         # Show all actionable comms
/inbox --email                 # Email only
/inbox --slack                 # Slack only
/inbox --unread                # Unread only

# Process
/comms show <id>               # Load full item with context
/comms draft                   # Draft reply to current item
/comms send                    # Queue send for current draft
/comms done <id>               # Mark processed (triage → keep)
/comms snooze <id> <duration>  # Snooze for later (1h, tomorrow, etc.)
/comms delegate <id> <person>  # Forward/assign to someone

# Bulk
/comms archive-read            # Archive all read emails (triage → keep)
/comms process-newsletters     # Auto-process newsletter pattern
```

**Key Principle: Batch, Don't Live Here**

| Pattern | Recommendation |
|---------|----------------|
| Check email constantly | ❌ Don't - use tasks mode |
| Process comms 2-3x/day | ✅ Batch processing |
| Reply immediately to everything | ❌ Urgent goes to tasks |
| Clear inbox to zero | ✅ Goal of each comms session |

**Triage Integration:**

Most emails are auto-triaged to `keep` (reference) not `act`. Only items that genuinely need your response appear in comms inbox.

| Triage Result | Examples | Where It Goes |
|---------------|----------|---------------|
| `act` | Direct questions, requests, approvals | Comms inbox |
| `keep` | CC'd emails, FYIs, receipts | Archive (searchable) |
| `delete` | Spam, newsletters (if unwanted) | Trash |

**When Comms Becomes a Task:**

If an email requires significant work (not just a reply):

```
User: "This budget review is actually a big task"
    ↓
/comms promote ms365-AAMk... --to-task
    ↓
Creates datahub task item linked to email
Syncs to SDP as Request
    ↓
"Created task sdp-890: Q3 budget review. Switch to tasks mode?"
```

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

---

## Appendix F: Edge Cases & Operational Concerns

### Terminology Clarification

| Term | Scope | Examples |
|------|-------|----------|
| **Item** | Any datahub entry | Email, Slack message, SDP ticket, calendar event |
| **Task** | Actionable work item | SDP Request, DevOps work item, General Task |
| **Comm** | Communication needing response | Email needing reply, Slack thread |

**Rule:** "Item" is the generic container. "Task" and "Comm" are item types filtered by mode.

### Default Mode Rationale

`/work` defaults to `comms`, not `tasks`. Why?

| Reason | Explanation |
|--------|-------------|
| Triage first | Check what came in before diving into deep work |
| Quick wins | Process easy comms before committing to tasks |
| Context loading | Comms are lighter context than task work |
| Natural flow | Most people check messages before starting work |

**Override:** `/work tasks` to go directly to tasks.

### When to Use What

| Situation | Use This | Not This |
|-----------|----------|----------|
| Quick question from existing ticket | `/task split sdp-456` | `/adhoc new` |
| Unplanned investigation | `/adhoc new "description"` | `/task split --fresh` |
| Email becomes significant work | `/comms promote` | `/adhoc new` |
| Parallel work while Claude runs | `/task split` | New terminal |

### Concurrent Write Handling

Two panes writing to same context file:

```
Pane 1: saves sdp-123.md at 14:32:01
Pane 2: saves sdp-123.md at 14:32:02
```

**Resolution:** Last-write-wins with merge attempt.

| Scenario | Handling |
|----------|----------|
| Different sections modified | Auto-merge (git-style) |
| Same section modified | Last write wins, previous in `.backup` |
| Conflicting status changes | Alert user, require manual resolution |

**Implementation:** File locks with 100ms timeout. If lock fails, queue write for retry.

### Email & Slack Threading

**Email:**

| Unit | Behavior |
|------|----------|
| Conversation thread | Single item (grouped by `conversationId`) |
| Each message | Appended to thread item as notes |
| New thread | New item |

**Slack:**

| Unit | Behavior |
|------|----------|
| Thread | Single item (grouped by `thread_ts`) |
| Channel message (no thread) | Single item |
| DM | Single item per conversation |

**Why threads, not messages:** Triage and response happen at conversation level, not per-message.

### Git Conflicts in Parallel Panes

Two panes, same repo, both auto-committing:

| Scenario | Handling |
|----------|----------|
| Different files | No conflict, both commit |
| Same file, different lines | Auto-merge on commit |
| Same file, same lines | gitwatch pauses, alerts user |

**Resolution flow:**

```
gitwatch detects conflict
    ↓
Pauses auto-commit for that repo
    ↓
Alerts: "Conflict in src/auth.ts - resolve manually"
    ↓
User resolves (or one pane finishes)
    ↓
gitwatch resumes
```

### Queue & Sync Edge Cases

| Edge Case | Handling |
|-----------|----------|
| Item deleted while write pending | Cancel queued write, log warning |
| External item deleted (404) | Move local to trash, prompt user |
| LUKS not mounted when poller runs | Poller skips cycle, logs warning |
| Initial sync with existing files | Merge by timestamp (newer wins), backup conflicts |
| Duplicate external ID | Append hash suffix, alert user |

### Tag Normalization

All tags normalized to lowercase with special chars stripped:

| Input | Normalized |
|-------|------------|
| `Urgent` | `urgent` |
| `URGENT` | `urgent` |
| `High Priority` | `high-priority` |
| `@important` | `important` |

**Sync behavior:** Normalized locally, original case preserved in external system.

### Timezone Handling

| Timestamp | Format | Timezone |
|-----------|--------|----------|
| Item `created`/`updated` | ISO 8601 | UTC |
| Display to user | Local time | User's TZ (from system) |
| Sync to external | Converted | API's expected TZ |
| Context file timestamps | ISO 8601 | UTC |

**Rule:** Store UTC, display local, convert on sync.

### Rate Limiting

| Service | Limit | Handling |
|---------|-------|----------|
| MS365 Graph | 10,000/10min | Exponential backoff, resume |
| Gmail | 250 quota units/sec | Batch requests, backoff |
| SDP | 50/min | Queue with delay |
| Slack (slackdump) | Session-based | Re-auth if blocked |
| DevOps | 200/min | Backoff |

**On rate limit:**

```
1. Log warning
2. Exponential backoff (1s, 2s, 4s, 8s, max 5min)
3. Resume from last sync point
4. Alert if >3 consecutive failures
```

### Disk Space Management

| Directory | Growth | Management |
|-----------|--------|------------|
| `/data/*/datahub/items/` | ~10MB/month | Purge trash after 365 days |
| `/data/*/datahub/queue/completed/` | Unbounded | Purge after 7 days |
| `/data/claude/` | ~100MB/month | Compact sessions older than 30 days |
| `/data/repos/` | Varies | User manages |

**Alerts:**

| Threshold | Action |
|-----------|--------|
| 80% disk | Warning in status dashboard |
| 90% disk | Alert + auto-purge old queue/trash |
| 95% disk | Pause pollers, urgent alert |

### slackdump Re-authentication

Browser session expires approximately every 30 days.

**Detection:**

```
slackdump returns auth error
    ↓
auth-keeper marks work-slack as expired
    ↓
Status bar shows ⚠ slack auth
    ↓
Slack poller pauses (others continue)
```

**Recovery:**

```bash
auth-keeper setup work-slack    # Opens browser for re-auth
# Follow Slack OAuth flow
# slackdump captures new session
auth-keeper status              # Verify green
```

**Proactive:** Warning at 25 days since last auth.

### Search Across Zones

| Command | Behavior |
|---------|----------|
| `/search "query"` | Current zone only |
| `/search "query" --all` | Both zones |
| `/search "query" --zone home` | Explicit zone |

**Why default to current zone:** Prevents accidental mixing of work/home context.

### Calendar Event Creation

```bash
/calendar add --work "Q3 Planning" --date 2026-02-15 --time 14:00 --duration 1h
```

| Field | Required | Default |
|-------|----------|---------|
| Title | Yes | - |
| Date | No | Today |
| Time | No | Next hour |
| Duration | No | 30min |
| Zone | No | Current zone |

**Sync:** Queued to appropriate calendar (MS365 for work, Google for home).

### Backup & Restore

**Backup layers:**

| Layer | Frequency | Retention | Restore Time |
|-------|-----------|-----------|--------------|
| EBS snapshots (DLM) | Hourly | 24 hours | 10-15 min |
| S3 sync | Daily | 90 days | 30-60 min |
| LUKS full image | Weekly | 4 weeks | 1-2 hours |

**Restore procedure:**

```bash
# From EBS snapshot (fastest)
1. Stop instance
2. Detach current data volume
3. Create volume from snapshot
4. Attach as /dev/xvdf
5. Start instance
6. imladris-unlock

# From S3 (if EBS unavailable)
1. Create fresh data volume
2. Attach and format
3. aws s3 sync s3://backup-bucket/latest /data
4. imladris-unlock

# Full LUKS image (disaster recovery)
1. Download image from S3 Glacier (may take hours)
2. dd to new EBS volume
3. Attach and unlock
```

### Error Notification

Beyond status bar, critical errors notify via:

| Severity | Channel |
|----------|---------|
| Warning | Status bar only |
| Error | Status bar + SimpleX message |
| Critical | Status bar + SimpleX + Telegram |

**What's critical:**

| Event | Severity |
|-------|----------|
| Auth expired | Warning |
| Sync failed 3x | Error |
| Disk 90%+ | Error |
| LUKS mount failed | Critical |
| All pollers down | Critical |

---

## Appendix G: Security Hardening

### Token & Credential Storage

| Credential | Location | Protection |
|------------|----------|------------|
| BWS access token | `/data/config/bws/token` | LUKS + file permissions (600) |
| OAuth refresh tokens | `/data/config/auth-keeper/tokens.json` | LUKS + encrypted at rest (age) |
| slackdump session | `/data/config/slackdump/` | LUKS + file permissions |
| SSH keys | `/data/ssh/` | LUKS + file permissions (600) |
| AWS credentials | None (instance profile) | IAM only |

**Token encryption:**

```bash
# Tokens encrypted with age before writing
age -e -R ~/.age/recipients.txt < tokens.json > tokens.json.age

# Decrypted to memory on read
age -d -i ~/.age/identity.txt < tokens.json.age
```

### Cross-Account Blast Radius

Instance compromise = access to all AWS accounts in registry.

**Mitigations:**

| Control | Implementation |
|---------|----------------|
| Least privilege | ReadOnlyAccess default, Admin requires justification |
| Session duration | 1 hour max for assumed roles |
| CloudTrail | All API calls logged in each account |
| Alerting | GuardDuty alerts on unusual patterns |
| Rotation | Instance role rotated on reboot |

**Admin access flow:**

```bash
auth-keeper aws get org-prod --role Admin
# Prompts: "Admin access to org-prod. Reason?"
# User enters: "Deploying hotfix for auth bug"
# Logged to audit trail
# Session limited to 1 hour
```

### Audit Logging

All sensitive operations logged to `/data/logs/audit.jsonl`:

```json
{
  "timestamp": "2026-01-29T14:32:00Z",
  "action": "aws_assume_role",
  "account": "org-prod",
  "role": "AdminAccess",
  "reason": "Deploying hotfix",
  "session_id": "abc123",
  "source_ip": "100.x.x.x"
}
```

**What's logged:**

| Action | Logged |
|--------|--------|
| AWS role assumption | Always |
| Admin role usage | Always + reason |
| Auth token refresh | Always |
| External API writes | Always |
| File access outside datahub | Never (too noisy) |

**Retention:** 90 days locally, synced to S3 for long-term.

### Network Security

| Component | Exposure |
|-----------|----------|
| SSH | Tailscale only (no public) |
| Pollers | Outbound HTTPS only |
| Claude/Bedrock | Outbound to AWS endpoints |
| Status TUI | localhost only |

**Firewall rules (iptables):**

```
# Allow Tailscale
-A INPUT -i tailscale0 -j ACCEPT

# Allow established connections
-A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Drop everything else inbound
-A INPUT -j DROP

# Allow all outbound
-A OUTPUT -j ACCEPT
```

---

## Appendix H: Windmill Orchestration

### H.1 Overview

[Windmill](https://www.windmill.dev/) is an open-source workflow engine that could replace the custom systemd timers + queue processor architecture. This appendix explores the benefits and trade-offs.

**Why consider Windmill:**
- Many more data sources planned
- Each source currently needs: systemd timer + script + queue handler + retry logic
- Windmill provides all of this out of the box

### H.2 Current vs Windmill Architecture

**Current:**

```
┌─────────────────────────────────────────────────────────────┐
│ systemd timers                                              │
│   ├── sdp-poller.timer (5min)                              │
│   ├── ms365-poller.timer (5min)                            │
│   ├── slack-poller.timer (60s)                             │
│   └── ... (one per source)                                 │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ Bun scripts (custom)                                        │
│   ├── lib/pollers/sdp.ts                                   │
│   ├── lib/pollers/ms365.ts                                 │
│   └── lib/queue/processor.ts  ← custom retry/backoff       │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ Datahub (flat files + SQLite)                              │
└─────────────────────────────────────────────────────────────┘
```

**With Windmill:**

```
┌─────────────────────────────────────────────────────────────┐
│ Windmill (Docker container)                                 │
│   ┌─────────────────────────────────────────────────────┐  │
│   │ Server (Rust) + Workers + Postgres                   │  │
│   │                                                       │  │
│   │ Schedules:           Scripts:                        │  │
│   │   sdp: */5 * * * *     pollers/sdp.ts               │  │
│   │   ms365: */5 * * * *   pollers/ms365.ts             │  │
│   │   slack: * * * * *     pollers/slack.ts             │  │
│   │                                                       │  │
│   │ Built-in: retries, backoff, logging, UI             │  │
│   └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ Datahub (flat files + SQLite)  [unchanged]                 │
└─────────────────────────────────────────────────────────────┘
```

### H.3 Feature Comparison

| Feature | Current (systemd) | Windmill |
|---------|-------------------|----------|
| Scheduling | systemd timers | Built-in cron |
| Retries | Custom per-script | Built-in with policies |
| Backoff | Custom per-script | Configurable |
| Monitoring | journalctl | Web UI dashboard |
| Adding new source | timer + script + handler | Just add script |
| Error visibility | Grep logs | UI with alerts |
| Webhooks | Custom endpoint | Built-in |
| Flows | Manual chaining | Visual composer |
| Approval gates | N/A | Built-in |
| Language support | Bun only | Bun, Python, Go, Bash |

### H.4 Deployment

**Native Deployment (Nix + systemd):**

No Docker required. Windmill is a Rust binary that runs natively.

```nix
# nix/home.nix or system configuration

# Postgres for Windmill job queue
services.postgresql = {
  enable = true;
  ensureDatabases = [ "windmill" ];
  ensureUsers = [{
    name = "windmill";
    ensureDBOwnership = true;
  }];
};

# Windmill server
systemd.services.windmill-server = {
  description = "Windmill Server";
  after = [ "postgresql.service" ];
  wantedBy = [ "multi-user.target" ];
  environment = {
    DATABASE_URL = "postgres://windmill@localhost/windmill";
    BASE_URL = "http://localhost:8000";
  };
  serviceConfig = {
    ExecStart = "${pkgs.windmill}/bin/windmill --mode server";
    Restart = "always";
    User = "windmill";
  };
};

# Windmill worker
systemd.services.windmill-worker = {
  description = "Windmill Worker";
  after = [ "windmill-server.service" ];
  wantedBy = [ "multi-user.target" ];
  environment = {
    DATABASE_URL = "postgres://windmill@localhost/windmill";
  };
  serviceConfig = {
    ExecStart = "${pkgs.windmill}/bin/windmill --mode worker";
    Restart = "always";
    User = "windmill";
  };
};
```

**Resource estimate (native, no container overhead):**
- Postgres: ~50MB RAM
- Windmill server: ~100MB RAM
- Windmill worker: ~50MB RAM + script overhead
- Total: ~200MB baseline

### H.5 Script Language Guidelines

**Default: TypeScript (Bun)**

Aligns with PAI, fast startup, consistent codebase.

**Exception: Python when library is significantly better**

| Use Case | Language | Reason |
|----------|----------|--------|
| HTTP API integrations | TypeScript | Simple fetch, consistent |
| Datahub read/write | TypeScript | Matches PAI stack |
| Ops scripts (backup, cleanup) | TypeScript | Consistency |
| AWS complex operations | Python | boto3 maturity |
| Data processing (if needed) | Python | pandas/numpy |
| ML/AI operations | Python | Library ecosystem |

**Script templates:**

```typescript
// TypeScript (default) - scripts/sdp/sync.ts
import * as wmill from "windmill-client";

export async function main() {
    const token = await wmill.getVariable("sdp_api_token");
    const resp = await fetch("https://sdp.example.com/api/v3/requests", {
        headers: { "Authorization": `Bearer ${token}` }
    });
    const data = await resp.json();
    await writeToDatahub(data.requests);
    return { synced: data.requests.length };
}
```

```python
# Python (when needed) - scripts/aws/org-accounts.py
import wmill
import boto3

def main():
    session = boto3.Session()
    org = session.client("organizations")
    accounts = org.list_accounts()["Accounts"]
    return {"accounts": accounts}
```

**Rule of thumb:** Start with TypeScript. Switch to Python only if you're fighting the language or missing critical libraries.

### H.6 Windmill Best Practices

#### Folder Organization

Use folder-based paths with clear ownership:

```
f/                          # Shared folders
├── sdp/                    # ServiceDesk Plus
│   ├── sync.ts
│   ├── get-tickets.ts
│   └── update-ticket.ts
├── ms365/                  # Microsoft 365
├── aws/                    # AWS operations
├── ops/                    # Backups, maintenance
└── triage/                 # AI processing

u/                          # User-specific (if needed)
└── admin/
    └── debug-scripts/
```

#### Variables vs Resources vs Secrets

| Type | Use For | Example |
|------|---------|---------|
| **Variable** | Simple config strings | `sdp-base-url`, `default-zone` |
| **Secret** | API keys, tokens (encrypted) | `sdp-api-token`, `telegram-bot-token` |
| **Resource** | Structured + OAuth (auto-refresh) | `ms365-oauth`, `slack-oauth`, `postgres-db` |

```typescript
// Variable (simple string)
const baseUrl = await wmill.getVariable("f/sdp/base-url");

// Secret (encrypted, audit-logged)
const token = await wmill.getVariable("f/sdp/api-token");  // same API, marked secret in UI

// Resource (structured, OAuth auto-refresh)
const ms365 = await wmill.getResource("f/ms365/oauth");
const accessToken = ms365.token;  // Always valid, Windmill refreshes
```

#### Error Handling

**Per-script retry policy** (in metadata YAML):

```yaml
# sync.script.yaml
retry:
  max_attempts: 3
  exponential_delay:
    base_ms: 1000
    multiplier: 2
    max_ms: 60000
```

**Workspace-level error handler** — notify on any failure:

```typescript
// f/ops/error-handler.ts
// Set as workspace error handler in Settings

export async function main(error: {
    job_id: string;
    path: string;
    error: string;
}) {
    await sendTelegramMessage(`❌ Job failed: ${error.path}\n${error.error}`);
}
```

**Flow error handling:**

```yaml
# flow.yaml
error_handler:
  path: f/ops/error-handler

steps:
  - id: fetch
    script: f/sdp/sync
    retry:
      max_attempts: 3
    continue_on_error: false  # Stop flow if this fails

  - id: notify
    script: f/ops/send-summary
    continue_on_error: true   # Don't fail flow if notification fails
```

#### Git Sync

**Pull without secrets** (for version control):

```bash
wmill sync pull --skip-secrets --skip-resources
```

**Folder structure after sync:**

```
windmill/
├── f/
│   ├── sdp/
│   │   ├── sync.ts
│   │   └── sync.script.yaml
│   └── ...
├── wmill.yaml
└── .gitignore           # Exclude secrets
```

**Git workflow:**

```
1. Edit locally (VS Code + Windmill extension)
2. Test in Windmill UI
3. wmill sync push
4. Commit to git
```

#### Naming Conventions

| Item | Pattern | Example |
|------|---------|---------|
| Scripts | `{action}.ts` or `{action}-{noun}.ts` | `sync.ts`, `get-tickets.ts` |
| Flows | `{process}-flow` | `full-sync-flow` |
| Variables | `{service}-{item}` | `sdp-base-url` |
| Secrets | `{service}-{credential}` | `sdp-api-token` |
| Resources | `{service}-{type}` | `ms365-oauth` |

#### Timeouts

Set appropriate timeouts per script:

| Script Type | Timeout |
|-------------|---------|
| Quick queries | 30s |
| Sync operations | 5m |
| Batch processing | 15m |
| Backups | 30m |

```yaml
# sync.script.yaml
timeout_s: 300  # 5 minutes
```

### H.7 Poller Migration Example

**Current (sdp-poller.ts):**

```typescript
// lib/pollers/sdp.ts
import { fetchRequests, writeToDatahub } from './common';

async function poll() {
    try {
        const requests = await fetchRequests();
        await writeToDatahub(requests);
    } catch (e) {
        // Custom retry logic
        await sleep(exponentialBackoff(retryCount));
        // ...
    }
}
```

**Windmill version:**

```typescript
// windmill script: pollers/sdp
// Schedule: */5 * * * *
// Retry policy: 3 attempts, exponential backoff

import * as wmill from "windmill-client";

export async function main() {
    const sdpToken = await wmill.getVariable("sdp_api_token");
    const requests = await fetchRequests(sdpToken);
    await writeToDatahub(requests);
    return { synced: requests.length };
}
```

Retry/backoff handled by Windmill, not custom code.

### H.8 New Capabilities

**Webhooks for real-time:**

Instead of polling Slack every 60s, receive events instantly:

```typescript
// windmill webhook: slack-events
// Triggered by: Slack Event API

export async function main(event: SlackEvent) {
    if (event.type === "message") {
        await writeToDatahub(event);
    }
}
```

**Flows for complex ingestion:**

```yaml
# windmill flow: full-sync
summary: Complete sync of all sources
steps:
  - id: sdp
    script: pollers/sdp
  - id: ms365
    script: pollers/ms365
    parallel: true
  - id: slack
    script: pollers/slack
    parallel: true
  - id: triage
    script: triage/batch
    depends_on: [sdp, ms365, slack]
```

**Approval gates for sensitive ops:**

```typescript
// windmill flow: admin-action
steps:
  - id: request
    script: prepare-admin-action
  - id: approve
    type: approval
    timeout: 1h
  - id: execute
    script: execute-admin-action
    depends_on: [approve]
```

### H.9 Windmill as Integration Gateway

**Core principle:** Claude/PAI never calls external APIs directly. All external communication routes through Windmill.

```
┌─────────────────────────────────────────────────────────────────┐
│ Claude / PAI                                                    │
│                                                                 │
│  "get ramp expenses"         "update SDP-1234"                 │
│  "check securonix alerts"    "send slack message"              │
│           │                           │                         │
│           └───────────┬───────────────┘                         │
│                       ▼                                         │
│              Windmill skill                                     │
│         (routes to appropriate script)                          │
└─────────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│ Windmill                                                        │
│                                                                 │
│  scripts/                                                       │
│    ramp/get-expenses.ts        (on-demand)                     │
│    ramp/sync.ts                (scheduled: 0 */6 * * *)        │
│    securonix/get-alerts.ts     (on-demand)                     │
│    securonix/sync.ts           (scheduled: */5 * * * *)        │
│    sdp/get-ticket.ts           (on-demand)                     │
│    sdp/update-ticket.ts        (on-demand)                     │
│    sdp/sync.ts                 (scheduled: */5 * * * *)        │
│    slack/send-message.ts       (on-demand)                     │
│    slack/sync.ts               (scheduled: * * * * *)          │
│                                                                 │
│  All credentials in Windmill variables (synced from BWS)       │
└─────────────────────────────────────────────────────────────────┘
                        │
                        ▼
                 External APIs
```

**Script categories:**

| Category | Trigger | Purpose |
|----------|---------|---------|
| `*/sync.ts` | Scheduled | Periodic data pull → datahub |
| `*/get-*.ts` | On-demand | Adhoc queries, return data directly |
| `*/update-*.ts` | On-demand | Write-back to external system |
| `*/send-*.ts` | On-demand | Outbound messages |

**Benefits of gateway pattern:**

| Concern | Solution |
|---------|----------|
| Credentials scattered | All in Windmill variables |
| Inconsistent error handling | Windmill retry policies |
| No audit trail | Windmill job history |
| Rate limit management | Windmill concurrency controls |
| Adding new source | Just add scripts, skill routes automatically |

### H.10 Interactive vs Scheduled Access

For **scheduled syncs**, all calls go through Windmill—latency doesn't matter.

For **interactive work** (AI or human doing rapid-fire queries), Windmill acts as a **credential provider** rather than a proxy:

```
┌─────────────────────────────────────────────────────────────────┐
│ Scheduled (background sync)                                     │
│                                                                 │
│   Windmill schedule → script → External API → datahub          │
│   (latency doesn't matter, full audit trail)                   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Interactive (AI or human)                                       │
│                                                                 │
│   Step 1: Get credentials                                       │
│   Claude → Windmill → get-creds script → return token/creds    │
│            └──────────── once ────────────┘                     │
│                                                                 │
│   Step 2: Use directly (no Windmill overhead)                  │
│   Claude → External API (using cached creds)                   │
│   Claude → External API                                        │
│   Claude → External API                                        │
│            └── rapid-fire, no 50ms overhead per call ──┘       │
│                                                                 │
│   Step 3: Re-fetch when expired                                │
└─────────────────────────────────────────────────────────────────┘
```

**Credential scripts:**

```typescript
// scripts/aws/get-session.ts
// Returns temporary credentials for interactive AWS work
export async function main(account: string, role: string = "ReadOnly") {
    const roleArn = `arn:aws:iam::${account}:role/Imladris${role}`;
    const creds = await sts.assumeRole({
        RoleArn: roleArn,
        RoleSessionName: "windmill-interactive",
        DurationSeconds: 3600
    });
    return {
        accessKeyId: creds.Credentials.AccessKeyId,
        secretAccessKey: creds.Credentials.SecretAccessKey,
        sessionToken: creds.Credentials.SessionToken,
        expiration: creds.Credentials.Expiration,
        region: "us-east-1"
    };
}

// scripts/ms365/get-token.ts
// Returns OAuth token for interactive MS365 work
export async function main() {
    const resource = await wmill.getResource("ms365_oauth");
    return {
        accessToken: resource.token,
        expiration: resource.expires_at
    };
}

// scripts/slack/get-token.ts
export async function main() {
    const resource = await wmill.getResource("slack_oauth");
    return { token: resource.token };
}
```

**Access patterns by service:**

| Service | Scheduled Sync | Interactive Access |
|---------|---------------|-------------------|
| AWS | Through Windmill | Get creds → use directly |
| MS365 (Graph API) | Through Windmill | Get token → use directly |
| Gmail/GCal | Through Windmill | Get token → use directly |
| Slack | Through Windmill | Get token → use directly |
| SDP | Through Windmill | Through Windmill (low volume) |
| Ramp | Through Windmill | Through Windmill (low volume) |
| Securonix | Through Windmill | Get token → use directly |

**Rule of thumb:** If you might issue 10+ commands in a session, get credentials and call directly. If it's occasional queries, route through Windmill for the audit trail.

**Curu skill (PAI) handles both patterns:**

```markdown
# In Windmill skill

## Interactive session setup
- "aws session for prod" → get-session(account, role) → cache creds
- "connect to ms365" → get-token() → cache token

## Then use cached creds for direct calls
- Uses AWS SDK with cached credentials
- Uses Graph API with cached token
```

### H.11 Why Windmill

| Factor | Windmill |
|--------|----------|
| Footprint | ~150MB steady state (Rust backend) |
| Performance | 26M tasks/month on single $5 worker |
| API | Full REST API for Curu skill (PAI) integration |
| Adding sources | Script + schedule = done |
| Monitoring | Built-in web UI |
| Retries | Configurable policies, no custom code |
| Webhooks | Native support for real-time |
| Languages | Bun, Python, Go, Bash |
| Open source | AGPLv3, no vendor lock-in |

### H.12 Curu Skills (PAI): One Per Windmill Module

**Pattern:** One thin skill per Windmill script folder. Each skill routes requests to its module's scripts.

**Skill structure:**

```
Windmill scripts/          Curu Skills (PAI) (thin routing)
├── f/sdp/            →    SDP skill
├── f/ms365/          →    MS365 skill
├── f/slack/          →    Slack skill
├── f/aws/            →    AWS skill
├── f/ramp/           →    Ramp skill
├── f/securonix/      →    Securonix skill
├── f/ops/            →    Ops skill
└── f/triage/         →    (uses Triage skill, not routing)
```

**Example skill template:**

```markdown
# Skill: SDP

Routes SDP requests to Windmill scripts in f/sdp/.

## Scripts Available
- f/sdp/sync.ts - Scheduled sync (don't call directly)
- f/sdp/get-tickets.ts - List tickets
- f/sdp/get-ticket.ts - Get single ticket
- f/sdp/update-ticket.ts - Update ticket

## Triggers
- "sdp tickets" → run f/sdp/get-tickets
- "show SDP-1234" → run f/sdp/get-ticket {id: "1234"}
- "update SDP-1234 status to resolved" → run f/sdp/update-ticket {id: "1234", status: "resolved"}
- "sync sdp" → run f/sdp/sync

## API Pattern
POST /api/w/main/jobs/run_wait_result/p/f/sdp/get-tickets
Body: { "args": { "status": "open" } }
```

**Why skill-per-module:**

| Aspect | One Giant Skill | Skill Per Module |
|--------|-----------------|------------------|
| Size | Grows unbounded | ~20 lines each |
| Maintenance | Hard to find things | Clear ownership |
| Adding source | Edit huge file | Add new skill |
| Conflicts | Possible | Isolated |

**Skill inventory:**

| Skill | Module | Purpose |
|-------|--------|---------|
| SDP | f/sdp/ | ServiceDesk Plus tickets |
| MS365 | f/ms365/ | Email, calendar |
| Slack | f/slack/ | Messages |
| AWS | f/aws/ | Cross-account, S3, etc. |
| Ramp | f/ramp/ | Expenses |
| Securonix | f/securonix/ | Security alerts |
| Ops | f/ops/ | Backups, sync, maintenance |
| Triage | (built-in) | AI classification |

**Adding new integration:**

```
1. Create Windmill scripts: f/newservice/*.ts
2. Create thin Curu skill (PAI): NewService skill (~20 lines)
3. Done
```

### H.13 Implementation Plan

| Phase | Scope |
|-------|-------|
| 1 | Add Windmill to docker-compose, deploy |
| 2 | Create WindmillOps Curu skill (PAI) |
| 3 | Migrate pollers (telegram, sdp, ms365, etc.) |
| 4 | Migrate all scheduled tasks (backups, sync, cleanup) |
| 5 | Remove systemd timers |
| 6 | Add new sources (Ramp, Securonix, etc.) |
| 7 | Enable webhooks for real-time sources |

### H.14 Unified Scheduler

**Principle:** All application-level scheduled tasks run in Windmill. systemd only handles bootstrap/system services.

**Tasks moving to Windmill:**

| Task | Schedule | Script |
|------|----------|--------|
| **Data Pollers** | | |
| SDP sync | `*/5 * * * *` | `pollers/sdp/sync.ts` |
| MS365 mail sync | `*/5 * * * *` | `pollers/ms365/sync.ts` |
| Gmail sync | `*/5 * * * *` | `pollers/gmail/sync.ts` |
| Slack sync | `* * * * *` | `pollers/slack/sync.ts` |
| Telegram sync | `* * * * *` | `pollers/telegram/sync.ts` |
| DevOps sync | `*/5 * * * *` | `pollers/devops/sync.ts` |
| Calendar sync | `*/15 * * * *` | `pollers/calendar/sync.ts` |
| **Backups** | | |
| Stateful backup | `0 * * * *` (hourly) | `ops/backup-stateful.ts` |
| S3 offsite sync | `0 6 * * *` (daily 6am) | `ops/backup-s3.ts` |
| **Maintenance** | | |
| Log cleanup | `0 3 * * *` (daily 3am) | `ops/log-cleanup.ts` |
| Temp file cleanup | `0 4 * * *` (daily 4am) | `ops/temp-cleanup.ts` |
| Index optimization | `0 5 * * 0` (weekly Sun) | `ops/index-optimize.ts` |
| **Sync** | | |
| BWS → Windmill vars | `*/30 * * * *` | `ops/bws-sync.ts` |
| Update check | `0 0 * * *` (midnight) | `ops/update-check.ts` |
| Session git sync | `*/5 * * * *` | `ops/session-sync.ts` |
| **Triage** | | |
| Batch triage | `*/15 * * * *` | `triage/batch.ts` |

**Stays in systemd (bootstrap/system-level):**

| Service | Reason |
|---------|--------|
| `postgresql.service` | Windmill depends on it |
| `windmill-server.service` | Core infrastructure |
| `windmill-worker.service` | Core infrastructure |
| `tailscaled.service` | Network access |
| `luks-unlock` (oneshot) | Runs before Windmill |

**Directory structure in Windmill:**

```
scripts/
├── pollers/
│   ├── sdp/
│   ├── ms365/
│   ├── gmail/
│   ├── slack/
│   └── ...
├── ops/
│   ├── backup-stateful.ts
│   ├── backup-s3.ts
│   ├── log-cleanup.ts
│   ├── bws-sync.ts
│   ├── update-check.ts
│   └── session-sync.ts
├── triage/
│   └── batch.ts
├── aws/
│   └── get-session.ts
└── {source}/
    ├── sync.ts          (scheduled)
    ├── get-*.ts         (on-demand)
    └── update-*.ts      (on-demand)
```

### H.15 Decision

**Adopted: Windmill as unified scheduler and integration gateway.**

Rationale:
- Single pane of glass for all scheduled tasks
- Consistent monitoring, logging, retry policies
- Many data sources planned — Windmill makes adding each trivial
- Small footprint (~150MB) with excellent performance (Rust)
- Full API enables Curu skill (PAI) integration
- Built-in monitoring eliminates custom dashboard work
- Webhook support enables real-time where available
- Scripts remain portable (just TypeScript/Python)
