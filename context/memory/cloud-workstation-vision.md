# Cloud Workstation Vision

## Date: 2026-02-18
## Status: ARCHITECTURE DEFINED — NOT YET BUILT

---

## The Vision

A cloud-based, secure, deterministic-first workstation where Claude+PAI is the single interface for all DevOps work. One session. Zero authentication friction. Zero data loss. Zero context friction. Zero downtime.

**Replaces:** tmux with work defined by directories (multiple panes, isolated contexts, manual switching)
**Integrates:** Windmill (self-hosted on EC2) as automation/credential/workflow layer, accessed via MCP
**Principle:** Deterministic-First — MCP as default external access, CLI as escape hatch, all calls logged

---

## Core Requirements

| Requirement | Definition | Status |
|------------|-----------|--------|
| **Zero auth friction** | All services accessible without manual token management | MCP servers handle auth — PLANNED |
| **Zero data loss** | Every learning, decision, insight persists forever | MEMORY + PRDs — PARTIAL (needs auto-persistence) |
| **Zero context friction** | Switching tasks doesn't lose previous context | PRD-based workstreams — PARTIAL (needs better recovery) |
| **Zero downtime** | Always available, survives reboots and session changes | Cloud instance + persistent state files — PARTIAL |
| **Single session** | One physical session to work against, no tmux juggling | PAI orchestrates multiple workstreams — DESIGNED |

---

## Intelligence Cycle (Decided 2026-02-19)

Every piece of external information follows the same four-stage cycle. This is PAI's existing OBSERVE→THINK→VERIFY→LEARN pattern given actual collection infrastructure.

```
COLLECT ──→ CORRELATE ──→ SURFACE ──→ LEARN
  ↑                                     │
  └─────────────────────────────────────┘
  (learning improves what/when/how we collect)
```

### Stage 1: COLLECT — Gather from sources

| Pattern | Mechanism | Examples |
|---------|-----------|---------|
| **Pull** (scheduled) | Windmill cron + Steampipe queries | Cross-account AWS state, SDP ticket check, cost reports, compliance scans |
| **Push** (event-driven) | Windmill webhooks + Slack bot | SDP events, AWS SNS alerts, GitHub events, Slack messages |
| **Feed** (continuous) | Windmill cron polling | RSS security feeds, CVE/NVD feeds, vendor changelogs (future) |

**Adding any new source:** Decide pull/push/feed → implement via Windmill → output feeds to triage agent.

### Stage 2: CORRELATE — Connect across sources

| Type | What | Mechanism |
|------|------|-----------|
| **Same-entity** | Multiple sources about the same resource | Steampipe SQL JOINs, triage agent context matching |
| **Same-time** | Events clustering temporally | Triage agent timestamps vs current-work.json and job history |
| **Same-pattern** | Looks like something we've seen | MEMORY/LEARNING search, CONTEXT RECOVERY finds similar PRDs |
| **Cross-domain** | Different types of info connected | Triage context bundle includes all active workstreams |

**Gap: Entity extraction.** Incoming data isn't auto-mapped to known entities (instances, IPs, accounts). Future enhancement.

### Stage 3: SURFACE — Present at the right time

| Mode | When | Mechanism |
|------|------|-----------|
| **Proactive** | You should know now | Triage NOTIFY → Slack DM + voice |
| **Contextual** | Related to what you're working on | Triage QUEUE with workstream flag |
| **Retrospective** | What happened in this period | Daily/weekly activity reports |
| **On-demand** | You ask about it | Steampipe queries, PRD searches |

**Gap: Contextual enrichment.** System doesn't proactively pull related info into active workstreams without being asked. Future enhancement.

### Stage 4: LEARN — Remember patterns for next cycle

| Type | Mechanism |
|------|-----------|
| Per-workstream | PRD decisions + log |
| Cross-domain patterns | MEMORY/LEARNING |
| Triage calibration | Triage agent reads MEMORY |

**Gap: Triage feedback loop.** No mechanism to improve triage quality based on outcomes. **Gap: Time-series trends.** No way to answer "is this getting worse over 3 months?"

### Gaps Summary (Phase 5+)

1. Feed collection (RSS, CVE, vendor advisories)
2. Entity extraction/enrichment for automatic correlation
3. Contextual surfacing into active workstreams
4. Triage feedback loop for quality improvement
5. Time-series / trend storage

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  INTERFACE LAYER                                                  │
│                                                                  │
│  Claude+PAI Session (terminal)    Windmill Messaging Gateway     │
│  ├── SSH/terminal, deep work      ├── Slack bot (built-in)       │
│  ├── Full Algorithm, PRDs         ├── signal-cli (optional)      │
│  └── Primary work interface       └── Routes to claude -p + PAI  │
│         │                                    │                   │
│         └──────────────┬─────────────────────┘                   │
│                        │  Both use Claude Code + PAI             │
│                        │  (one brain, two doors)                 │
│                        │                                         │
│  ┌─────────────────────▼─────────────────────────────────────┐   │
│  │  Workstreams (PRD-driven, shared across interfaces)       │   │
│  │  ├── Workstream A (PRD-A.md)                              │   │
│  │  ├── Workstream B (PRD-B.md)                              │   │
│  │  └── Workstream C (PRD-C.md)                              │   │
│  └─────────────────────┬─────────────────────────────────────┘   │
│                        │                                         │
│  ┌─────────────────────▼─────────────────────────────────────┐   │
│  │  STANDALONE MCP SERVERS (IAM role only, no stored creds)  │   │
│  │  ├── AWS MCP         (infrastructure, read+write)         │   │
│  │  ├── Steampipe MCP   (research, correlation, read-only)   │   │
│  │  └── McpLogger Hook  (logs all calls via mcp__* wildcard) │   │
│  └─────────────────────┬─────────────────────────────────────┘   │
│                        │                                         │
│  ┌─────────────────────▼─────────────────────────────────────┐   │
│  │  WINDMILL (self-hosted on EC2)                            │   │
│  │                                                           │   │
│  │  ├── Credential vault (cache from Bitwarden Secrets)      │   │
│  │  ├── Script library → auto-exposed as MCP tools           │   │
│  │  │   ├── SDP tools (Zoho OAuth from vault)                │   │
│  │  │   ├── GitHub tools (token from vault)                  │   │
│  │  │   ├── Any SaaS tools (creds from vault)                │   │
│  │  │   └── Custom automation scripts                        │   │
│  │  ├── Slack bot (messaging gateway to claude -p)           │   │
│  │  ├── Cron schedules (compliance, cost, ticket checks)     │   │
│  │  ├── Webhook receivers (SDP events, AWS events)           │   │
│  │  └── Workers (run heavy jobs outside Claude's session)    │   │
│  └─────────────────────┬─────────────────────────────────────┘   │
│                        │                                         │
│  ┌─────────────────────▼─────────────────────────────────────┐   │
│  │  CREDENTIAL HIERARCHY                                     │   │
│  │  ├── Bitwarden Secrets (source of truth, permanent)       │   │
│  │  ├── Windmill vault (operational cache, auto-refresh)     │   │
│  │  ├── EC2 IAM role (cloud providers, zero stored secrets)  │   │
│  │  └── MCP transport auth (automatic, not service auth)     │   │
│  └─────────────────────┬─────────────────────────────────────┘   │
│                        │                                         │
│  ┌─────────────────────▼─────────────────────────────────────┐   │
│  │  CONTEXT LAYER (zero context loss)                        │   │
│  │  ├── current-work.json (active workstreams)               │   │
│  │  ├── PRDs (work state per stream)                         │   │
│  │  ├── MEMORY (persistent learnings)                        │   │
│  │  └── EBS snapshots (machine state, hourly via DLM)        │   │
│  └─────────────────────┬─────────────────────────────────────┘   │
│                        │                                         │
│  ┌─────────────────────▼─────────────────────────────────────┐   │
│  │  CLI ESCAPE HATCH (when MCP doesn't cover it)             │   │
│  │  ├── aws CLI (full API surface)                           │   │
│  │  ├── mcp-tools (deterministic CLI to any MCP server)      │   │
│  │  ├── steampipe CLI (direct SQL if needed)                 │   │
│  │  └── Logged by existing Bash/SecurityValidator hooks      │   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

---

## Context Persistence Model (Zero Context Loss)

Context leaks at 4 layers. Each needs a solution:

### Layer 1: Within a Session (Compaction Survival)

**Problem:** Claude's context window compacts mid-session, losing earlier reasoning.
**Current:** PAI PRD + ISC persist to disk, post-compaction audit.
**Gap:** ~~State only saved during Algorithm LEARN phase — not continuous.~~ RESOLVED by Decision #24.
**Solution:** PRD as write-ahead log — ISC written to disk on every TaskCreate/TaskUpdate. StateSnapshot hook fires on ISC changes AND phase transitions. See "Session Death Resilience" section.

### Layer 2: Across Sessions (Cold Start Recovery)

**Problem:** New session starts empty. Recovery depends on manually reading PRDs + MEMORY.
**Current:** PAI has SessionStart hook, MEMORY files, PRD system.
**Gap:** Cold start requires the AI to search and reconstruct context. Not instant.
**Solution:** `current-work.json` that captures:

```json
{
  "last_updated": "2026-02-18T19:30:00Z",
  "active_workstreams": [
    {
      "name": "AWS Security Group Audit",
      "prd": "~/.claude/MEMORY/WORK/aws-sg-audit/PRD-20260218-aws-sg-audit.md",
      "status": "IN_PROGRESS",
      "last_action": "Found 3 public SGs, awaiting remediation approval",
      "blocking": null,
      "priority": "high"
    },
    {
      "name": "SDP Ticket #4521 — DNS Resolution",
      "prd": "~/.claude/MEMORY/WORK/sdp-4521/PRD-20260218-sdp-4521.md",
      "status": "INVESTIGATING",
      "last_action": "Correlated with Route53 config, suspect missing CNAME",
      "blocking": "Waiting for network team confirmation",
      "priority": "medium"
    }
  ],
  "env_state": {
    "aws_profile": "prod-readonly",
    "aws_region": "us-east-1",
    "steampipe_running": true,
    "sdp_auth_valid": true
  },
  "recent_learnings": [
    "Security groups with 0.0.0.0/0 on port 22 found in 3 VPCs — pattern, not incident"
  ]
}
```

SessionStart hook reads this → immediate context restoration. No searching, no prompting.

### Layer 3: Across Workstreams (Cross-Pollination)

**Problem:** Insight from workstream A never reaches workstream B.
**Current:** MEMORY/LEARNING exists but requires manual writes.
**Gap:** Cross-pollination depends on the AI remembering to save learnings.
**Solution:** Algorithm LEARN phase auto-extracts and saves patterns:
- "This type of SG issue correlates with these types of SDP tickets"
- "When DNS fails, check Route53 AND the VPC DHCP options"
- Stored in MEMORY/LEARNING, tagged by domain, searchable by any workstream

### Layer 4: Across Time (Long-Term Learning)

**Problem:** Solve same problem type months later, start from scratch.
**Current:** Algorithm reflections JSONL file.
**Gap:** Reflections captured but not actively queried on new similar work.
**Solution:** OBSERVE phase CONTEXT RECOVERY already searches reflections for similar tasks.
Needs: better indexing, tagging by problem domain (IAM, networking, DNS, cost, etc.)

---

## Session Death Resilience (Decided 2026-02-19)

Sessions can die at any time: context overflow + rate-limited compact, process crash, instance reboot. The spec must guarantee that NO session death requires manual context reconstruction.

**Core principle: PRD as write-ahead log.** The PRD is written incrementally — every ISC creation, every status change, every phase transition hits disk immediately. Working memory and disk stay in sync at all times. If the session dies, nothing is lost that wasn't already on disk.

### Continuous State Persistence (replaces LEARN-only persistence)

| Event | Written To | What |
|-------|-----------|------|
| TaskCreate (new ISC) | PRD ISC section | New criterion appended immediately |
| TaskUpdate (status) | PRD ISC section | `- [ ]` → `- [x]` immediately |
| Phase transition | current-work.json | Phase, last action, workstream |
| Key decision | PRD DECISIONS section | Decision + rationale |
| LEARN phase | PRD LOG section | Full session summary (unchanged) |

**Implementation — Two layers (belt and suspenders):**

**Layer A: Hook-driven (deterministic, primary).** A `PrdSync.hook.ts` PostToolUse hook intercepts every TaskCreate and TaskUpdate. The hook reads current-work.json to find the active PRD path, then appends/updates the ISC section on disk. This fires automatically regardless of AI behavior or Algorithm prompt changes. Registered in settings.json, testable independently.

**Layer B: Prompt-driven (AI behavior, backup).** The Algorithm prompt also instructs PRD sync. This catches less-structured writes (DECISIONS section, CONTEXT updates) that the hook can't easily automate.

**What could break it:**
- Hook removed from settings.json → Layer B (prompt) still works
- Algorithm prompt changed → Layer A (hook) still works
- Claude Code hook API changes → Layer B still works, fix hook
- Both break simultaneously → extremely unlikely; different systems

**Status:** TO BUILD — needs PrdSync.hook.ts + settings.json hook registration + current-work.json active PRD tracking.

### Three Defense Layers

**PREVENT — Reduce session death frequency:**
- Proactive compaction at ~70% context usage (hook on phase transitions)
- Rate limit: wait 30s + retry compact, don't fail immediately
- Heavy work uses background agents to keep main context lean

**MITIGATE — Session death loses nothing:**
- PRD on disk mirrors working memory at all times (continuous persistence above)
- current-work.json updated every phase transition
- Transcript persisted by Claude Code automatically (`.jsonl` files)

**RECOVER — New session picks up in seconds:**
- Any death → restart Claude → SessionStart hook → reads current-work.json → dashboard
- "Continue" → CONTEXT RECOVERY → PRD loaded → ISC rebuilt → picks up at last completed phase
- No manual re-explanation required. Ever.

### Recovery Times

| Death Mode | Recovery Path | Time |
|-----------|--------------|------|
| `/clear` (context full) | Same terminal → `claude` → SessionStart → PRD reload | ~10s |
| Process crash | Restart in tmux → SessionStart → PRD reload | ~10s |
| Rate-limited compact | Wait 30s → retry, or /clear → same as above | ~10-40s |
| Instance reboot | SSH → tmux → `claude` → SessionStart | ~1 min |
| Instance terminated | Launch from EBS snapshot → SSH → `claude` | ~5 min |

### The Specific Scenario: Compact Rate Limit

```
Context limit reached → /compact → Rate limit error
                                    ↓
                              Wait 30 seconds
                                    ↓
                              Retry /compact
                                    ↓
                         Success? → Continue working
                         Fail?   → /clear (safe because PRD is current)
                                    ↓
                              SessionStart fires
                                    ↓
                              Dashboard shows interrupted workstream
                                    ↓
                              "Continue" → back in 10 seconds
```

**Status:** TO BUILD — requires StateSnapshot hook enhancement (trigger on TaskCreate/TaskUpdate) and incremental PRD writes in Algorithm.

---

## Cold-Start Experience (Sit Down and Work)

When Seth starts a fresh Claude session, the SessionStart hook fires and presents a workstation status dashboard automatically. No searching. No "what was I doing?" prompts.

**The chain:**
1. Run `claude` → PAI loads → SessionStart hook fires
2. Hook reads `~/.claude/state/current-work.json` (written by StateSnapshot hook at every Algorithm phase)
3. Hook queries Windmill API for recent cron/webhook results (what happened while away)
4. Dashboard displayed immediately:

```
┌─ WORKSTATION STATUS ──────────────────────────────────────────┐
│  Last active: 2 hours ago (2026-02-18 11:30 PST)             │
│                                                               │
│  ACTIVE WORKSTREAMS:                                          │
│                                                               │
│  1. [HIGH] AWS Security Group Audit                           │
│     Phase: VERIFY (6/7) — 3 public SGs found                 │
│     Blocked: Waiting for network team approval                │
│     PRD: aws-sg-audit                                         │
│                                                               │
│  2. [MEDIUM] SDP #4521 — DNS Resolution                      │
│     Phase: INVESTIGATE — suspect missing CNAME                │
│     Next: Check Route53 config in prod account                │
│     PRD: sdp-4521                                             │
│                                                               │
│  3. [LOW] Cost Optimization Review                            │
│     Phase: OBSERVE — just started                             │
│     Next: Run Steampipe cost queries across all accounts      │
│     PRD: cost-review-q1                                       │
│                                                               │
│  SINCE YOU LEFT:                                              │
│  - Windmill cron: daily SDP check ran — 2 new tickets         │
│  - Windmill cron: cost report ready                           │
│  - Slack: 3 messages routed to PAI via Slack bot              │
│                                                               │
│  "Continue the SG audit" / "Show new tickets" / anything      │
└───────────────────────────────────────────────────────────────┘
```

5. Seth speaks naturally ("continue the SG audit") → PAI loads the PRD via CONTEXT RECOVERY → ISC rebuilt → working in under 10 seconds

**What's built vs what's needed:**
- SessionStart hook — EXISTS (needs enhancement to read current-work.json and present dashboard)
- current-work.json schema — DESIGNED (see Context Persistence Model above)
- StateSnapshot hook — TO BUILD (writes current-work.json at phase transitions)
- Windmill recent activity query — TO BUILD (call Windmill API for recent job results)
- PRD resume on natural language — EXISTS (PAI's CONTEXT RECOVERY already does this)

---

## What Replaces tmux

| tmux Provided | Single-Session Equivalent |
|--------------|--------------------------|
| Isolation (each pane = project) | PRDs per workstream, each with own ISC and context |
| Persistence (panes stay open) | PRDs + MEMORY + current-work.json on disk — survives everything |
| Quick switching (Ctrl-b + N) | "Switch to the SDP ticket" → load PRD context via natural language |
| Visual parallelism (multiple panes) | **Actual parallelism** — background agents work problems while you work another |
| Long-running processes | Windmill workers for durable jobs, tmux for ephemeral session daemons only |

**tmux is not fully eliminated.** It serves two roles:
1. **Session survival:** Claude+PAI runs inside a tmux pane. SSH disconnect ≠ session lost. Reconnect → `tmux attach` → right where you left off. This is the foundation of zero-downtime.
2. **Background daemons:** Other panes for persistent services (dev servers, watchers). Durable long-running jobs go to Windmill workers.

tmux is a **session persistence layer and background process manager**, not a workspace manager. One pane for Claude+PAI (the workspace), other panes only for persistent daemons.

### Parallel Work Model (Better Than tmux)

tmux gave visual parallelism — multiple panes, but each isolated with no shared context. Claude Code + PAI gives **actual parallelism with shared context:**

```
You: "Investigate the DNS issue across all accounts in the background"

PAI spawns background agent:
  - Agent reads PRD-sdp-4521
  - Calls Steampipe MCP → cross-account Route53 correlation
  - Writes findings back to PRD
  - Notifies when done

You: "Now let's work on the cost review"

PAI works with you in foreground on cost-review PRD
Both you AND the agent share: MEMORY, PRDs, MCP servers, credentials
```

**Explicit triggers (natural language):**
- "Work on this in the background"
- "Kick off an agent to investigate X"
- "Have an agent do Y while we work on Z"
- "Parallelize this"
- "Spin up a Researcher/Engineer/Architect agent for X"

**How it works (PAI Capability #18 — Parallelization):**
- `Task` tool with `run_in_background: true` spawns an independent agent
- Agent gets: MEMORY access, MCP server access, PRD context, credential stack
- Agent works autonomously, writes to PRD, reports back when done
- For coordinated multi-agent work: Agent Teams (TeamCreate + SendMessage)
- All agents share the same filesystem — MEMORY, PRDs, current-work.json

**This is the strongest argument for single-session over tmux.** Parallel work with shared context was never possible in tmux.

### Session Management (Background/Foreground)

Three layers of session bg/fg, from lightweight to full context-switch:

**Layer 1: Background Tasks (within one session) — EXISTS NOW**

```
You: "Background that audit work and investigate SDP #4521"

Background agent continues audit autonomously
You work the SDP ticket in foreground
Later: "What's the status on that background audit?"
Results are waiting.
```

Mechanism: `Task` tool with `run_in_background: true`. Shared MEMORY, PRDs, MCP stack.

**Layer 2: Session Resume — EXISTS NOW (with friction)**

```
# Exit current session (or open new terminal)
# Start fresh session for different work
claude

# Later, resume the original session
claude --resume   # Session picker shows recent sessions
```

Friction: resumed sessions load transcript but lose working memory (TaskList, in-flight state). PRDs bridge this — the PRD captures ISC state on disk, so a resumed session rebuilds context from it via CONTEXT RECOVERY.

**Layer 3: Named Workstream Switching — TO BUILD**

The ideal `jobs`/`fg`/`bg` model for the cloud workstation:

```bash
pai work "AWS audit"          # Start or resume a named workstream
pai shelve                    # Save state (PRD current), exit cleanly
pai work "SDP #4521"          # Start or resume different workstream
pai shelve
pai work "AWS audit"          # Come back — PRD + transcript auto-loaded
pai jobs                      # List active workstreams with status
```

Under the hood:
- `pai work <name>` → finds matching PRD + session ID → `claude --resume <id>` with PRD auto-loaded
- `pai shelve` → ensures PRD is synced, writes to current-work.json, exits cleanly
- `pai jobs` → reads current-work.json + PRD directory, shows workstream status and phase

**What's real vs what we build:**

| Capability | Status | Mechanism |
|-----------|--------|-----------|
| Background a task, keep working | **EXISTS** | Background agents within session |
| Exit and resume a session later | **EXISTS** | `claude --resume` + PRD context recovery |
| Named workstreams with state | **TO BUILD** | `pai work/shelve/jobs` CLI wrapper |
| PRD auto-load on resume | **TO BUILD** | SessionStart hook enhancement |
| True process suspend/resume (ctrl+z) | **BLOCKED** | Needs Claude Code upstream support |

**The PRD is the saved game state.** Transcript gives conversation history. PRD gives working memory (ISC, decisions, key files, phase). Together they enable near-seamless workstream switching.

---

## Service Layer Architecture

### Integration Standard: Deterministic-First

> **All external system access must be deterministic, logged, and independently callable.
> Credential location is determined by service type, not tool type.
> Use Windmill for workflow automation, credential management, and scheduled work.**

**Decision tree for new integrations:**
1. Uses IAM role only (AWS, GCP on EC2)? → Standalone MCP server is fine (AWS MCP, Steampipe MCP)
2. Needs stored credentials (SaaS, OAuth, API keys)? → Build as Windmill script (auto-exposes as MCP tool, credentials from vault)
3. Third-party MCP server exists but needs stored creds? → **Don't use it.** Build equivalent Windmill scripts instead. Credentials stay in one place.
4. MCP doesn't cover a specific API function? → CLI escape hatch (aws/steampipe CLI directly)

**Two categories of MCP tools, no exceptions:**
- **Standalone MCP servers** (IAM role only): AWS MCP, Steampipe MCP — no stored credentials, use EC2 instance role
- **Windmill scripts** (needs stored creds): SDP, GitHub, Slack, any SaaS — credentials from Windmill vault, auto-exposed as MCP tools

**This evolves PAI's CLI-First principle to Deterministic-First.** The spirit (determinism, testability, independent access) is preserved. MCP and Windmill are first-class paths alongside CLI.

### Credential Architecture (Decided 2026-02-18)

**Two auth layers exist — don't conflate them:**

| Layer | What It Does | Example |
|-------|-------------|---------|
| **Transport auth** | How Claude authenticates TO the MCP server | Windmill API token, or local stdio (no auth) |
| **Service auth** | How the tool authenticates to the EXTERNAL service | IAM role → AWS, Windmill vault → SDP |

MCP auth is transport. It does not handle service credentials. The tool behind the MCP server handles service auth.

**Credential hierarchy (3 layers):**

```
LAYER 1: SOURCE OF TRUTH
  Bitwarden Secrets
  (API keys, OAuth client secrets, tokens)
  Permanent home. Put them here.
        │
        │  sync/retrieve
        ▼
LAYER 2: OPERATIONAL CACHE
  Windmill Vault (Resources)
  (Retrieved from Bitwarden, cached, auto-refreshed for OAuth)
  Scripts pull credentials at execution time.
        │
        │  used by Windmill scripts (auto-exposed as MCP tools)
        ▼
LAYER 3: EXECUTION
  Windmill scripts → exposed as MCP tools → Claude calls them
  (credentials never leave Windmill's execution environment)

EXCEPTION: AWS/GCP
  EC2 IAM role — zero stored secrets
  All tools auto-detect via AWS SDK credential chain
  AWS MCP, Steampipe, AND Windmill resolve to same IAM role
```

**Credential rules:**
- **Cloud providers (AWS, GCP):** IAM role or OIDC. Zero stored secrets. All tools on EC2 auto-detect.
- **SaaS (SDP, GitHub, etc.):** Windmill vault. One place. Synced from Bitwarden.
- **No long-lived AWS credentials stored anywhere** — no access keys in config files, env vars, or vault.

### Messaging Gateway (Decided 2026-02-18)

**Windmill replaces OpenClaw as the messaging gateway.** OpenClaw was evaluated and dropped — using 10% of a tool with 60+ CVEs for a webhook bridge function is unjustified when Windmill already provides it.

```
Seth's Phone/Slack → Windmill Slack bot → claude -p + PAI → result back to Slack
```

**Channels:**
- **Slack** (primary): Windmill's built-in Slack bot — @mention or slash commands. Zero extra components.
- **Signal** (optional, later): signal-cli-rest-api (tiny focused service) + Windmill webhook trigger.
- **Any future channel:** Per-platform connector → Windmill webhook → `claude -p`. Not a monolith.

**How it works:** Windmill Slack bot receives message → triggers a Windmill script → script runs `claude -p` with PAI context loaded → PAI reads MEMORY, PRDs, uses MCP servers → result returns to Slack.

**Context is unified:** Both terminal sessions and messaging-triggered `claude -p` invocations read/write the same MEMORY/, PRDs, and current-work.json. One brain, two doors.

**Limitation:** Live in-session conversational context (the terminal's chat thread) is not available to messaging-triggered invocations. Persistent context (files on disk) IS shared. PRDs and current-work.json bridge the gap.

### Auto-Triage: All Inputs, One Funnel (Decided 2026-02-19)

Every external input routes through Windmill to a triage agent that classifies and routes with full workstream context.

**Input sources → Windmill → Triage:**

| Source | Windmill Entry Point |
|--------|---------------------|
| Slack messages | Slack bot (built-in) |
| SDP tickets (new/update) | Webhook |
| AWS alerts (CloudWatch, SecurityHub) | SNS → Webhook |
| GitHub PRs/issues | Webhook |
| PagerDuty (future) | Webhook |

**How triage gets conversational context:**

`claude -p` is stateless — no live session. The Windmill triage script builds a context bundle from disk and injects it:
- `current-work.json` → what Seth is working on right now, priorities, blockers
- Active PRD summaries → status, phase, last action per workstream
- `MEMORY/LEARNING` → recent patterns and domain knowledge

This gives the triage agent enough context to make intelligent routing decisions without the live chat thread.

**Three triage actions:**

| Action | When | What Happens |
|--------|------|-------------|
| **NOTIFY** (urgent) | Production issues, security alerts, explicit requests | Slack DM + voice notification to workstation |
| **QUEUE** (review later) | Related to active work, not urgent | Added to `queued_items` in current-work.json, shows on dashboard |
| **AUTO** (investigate) | Low priority but needs an answer | Second `claude -p` investigates autonomously, writes findings to PRD |

**Triage examples:**
- SDP "DNS not resolving" + active DNS workstream → QUEUE, flagged as related
- AWS ELB 5xx spike, no related workstream → NOTIFY (urgent, new issue)
- SDP "Printer issue" → AUTO (routine, auto-categorize and respond)
- GitHub PR approved on infra-repo + active deployment workstream → QUEUE, flagged

**Status: TO BUILD** — needs Windmill triage script, webhook configurations per source, triage prompt engineering.

### Activity Reports: Daily & Weekly (Decided 2026-02-19)

Automatic "what I did" reports generated from workstream data. Manager-friendly — no ISC jargon, no Algorithm terminology.

**Data sources (all exist or planned):**
- PRDs modified in period → what was worked on, decisions made, criteria passed
- PRD LOG sections → per-session summaries
- Algorithm reflections JSONL → session metadata
- Triage log (Windmill) → what came in, how it was routed
- MCP call logs → services accessed, frequency

**Generation:**
- Windmill cron: daily at 5:00 PM, weekly on Friday at 4:00 PM
- Script gathers data from above sources → feeds to `claude -p` with reporting prompt
- Prompt enforces: accomplishments language, grouped by project, quantified where possible, no internal jargon

**Report format:**
```
## Daily Summary — 2026-02-19

### Completed
- Identified 3 public-facing security groups across prod, staging, dev accounts
- Resolved SDP #4521: DNS failure caused by missing CNAME in Route53

### In Progress
- SG remediation plan drafted, awaiting network team approval
- Q1 cost optimization review: cross-account queries running

### Blocked
- SG remediation: waiting on network team sign-off

### Next Up
- Complete cost review
- Review 2 new SDP tickets from overnight triage
```

**Delivery:** Markdown file (`~/.claude/MEMORY/REPORTS/daily-YYYY-MM-DD.md`) + Slack DM to Seth for review before forwarding to manager.

**The connection:** Triage feeds work IN → PRDs track the work → Reports summarize work OUT. Same data layer (current-work.json, PRDs, MEMORY) serves all three.

**Status: TO BUILD** — needs Windmill cron scripts, report generation prompt, Slack delivery.

### MCP Servers (Zero Auth Friction)

**Category 1: Standalone MCP Servers (IAM role, no stored credentials)**

| Service | MCP Server | Auth | Status |
|---------|-----------|------|--------|
| AWS (broad) | Managed AWS MCP (Preview) | EC2 IAM role (auto-detected) | PLANNED |
| AWS (specific) | awslabs service servers (66) | EC2 IAM role (auto-detected) | PLANNED |
| Steampipe | turbot/steampipe-mcp (official) | EC2 IAM role (auto-detected) | PLANNED |

**Category 2: Windmill Scripts as MCP Tools (stored credentials from vault)**

| Service | Implementation | Auth | Status |
|---------|---------------|------|--------|
| Windmill itself | Windmill built-in MCP server | Windmill API token | PLANNED |
| ServiceDesk Plus | Windmill scripts (auto-MCP) | Zoho OAuth in Windmill vault | PLANNED |
| GitHub | Windmill scripts (auto-MCP) | Token from vault (synced from Bitwarden) | PLANNED |
| Slack | Windmill built-in integration | OAuth in Windmill | PLANNED |
| Future SaaS | Windmill scripts (auto-MCP) | Credentials from vault | — |

**Rule:** Third-party MCP servers that need stored credentials are NOT used. Build equivalent Windmill scripts instead.

### Windmill (Self-Hosted on EC2)

| Capability | What It Provides | Replaces |
|-----------|-----------------|----------|
| **Credential vault** | OAuth tokens, API keys, DB creds — proper UI, RBAC | `.env` files |
| **Script library** | TypeScript/Python scripts auto-exposed as MCP tools | Custom Tools/*.ts |
| **Cron schedules** | Compliance scans, cost reports, ticket checks | External cron + scripts |
| **Webhook receivers** | SDP events, AWS events, GitHub events | Nothing (gap today) |
| **Workers** | Run heavy/long jobs outside Claude's session | Background Bash commands |
| **Approval flows** | Human-in-the-loop for destructive operations | Manual AskUserQuestion |
| **SDP integration** | Scripts for SDP REST API v3, stored creds, auto-MCP | Would have been Tools/ServiceDeskPlus.ts |

**How SDP works through Windmill:**
1. Build TypeScript scripts in Windmill (create_ticket, list_tickets, add_note, etc.)
2. Store SDP Zoho OAuth credentials in Windmill's vault (proper secret management)
3. Scripts auto-expose as MCP tools (Claude calls them natively)
4. Add cron: "check my open tickets every morning"
5. Add webhook: SDP fires on new ticket → Windmill runs triage script
6. All calls logged by McpLogger hook (mcp__windmill__*)

### Hooks (Logging & State)

| Hook | Matcher | Purpose | Status |
|------|---------|---------|--------|
| McpLogger | `mcp__*` (PreToolUse) | Log all MCP tool calls (AWS, Steampipe, Windmill, etc.) | TO BUILD |
| McpLogger | `mcp__*` (PostToolUse) | Log MCP responses | TO BUILD |
| PrdSync | `TaskCreate\|TaskUpdate` (PostToolUse) | Sync ISC to PRD on disk immediately — deterministic, survives prompt changes | TO BUILD |
| StateSnapshot | Bash (voice curl pattern) | Auto-persist working state per phase | TO BUILD |
| AlgorithmTracker | `Bash`, `TaskCreate` (existing) | Track Algorithm phase progression | EXISTS |

### CLI Escape Hatch (When MCP Doesn't Cover It)

| Tool | Purpose | When to Use | Status |
|------|---------|-------------|--------|
| aws CLI v2.33 | Full AWS API surface | MCP doesn't expose specific operation | INSTALLED |
| steampipe CLI | Direct SQL, prepared statements | Steampipe MCP's 5 tools aren't enough | TO INSTALL |
| mcp-tools | Deterministic CLI to any MCP server | Scripting, cron, debugging MCP calls | TO INSTALL |

---

## Key Design Decisions

1. **Deterministic-First** — evolves PAI's CLI-First to accommodate MCP as a first-class path. The principle is determinism/testability/independent-access, not CLI specifically.
2. **MCP as default external access** — MCP servers preferred where they exist. Hook logging (mcp__*) provides determinism. mcp-tools CLI provides independent access.
3. **Windmill as automation/credential layer** — self-hosted on EC2, accessed via its MCP server. Context stays unified in PAI. Scripts auto-expose as MCP tools.
4. **SDP via Windmill, not custom MCP** — build SDP scripts in Windmill, store OAuth creds in vault, scripts auto-become MCP tools. Eliminates need for dedicated SDP MCP server.
5. **CLI as escape hatch, not primary** — aws CLI, steampipe CLI, mcp-tools for operations MCP servers don't cover (~10% of work). Logged by existing Bash hooks.
6. **Single session, multiple workstreams** — PRDs replace tmux panes for context
7. **current-work.json as state bridge** — survives sessions, enables instant recovery
8. **Two-layer persistence** — DLM hourly EBS snapshots (machine) + hook-driven state files (context)
9. **tmux demoted to background process manager** — not a workspace anymore
10. **MCP servers add value beyond raw APIs** — schema discovery, composite tools, guardrails. This isn't just transport — it's a task-oriented layer.
11. **OpenClaw evaluated and dropped** — explored as messaging gateway, rejected. Running a full daemon (60+ CVEs) for a webhook bridge when Windmill's Slack bot already does it.
12. **Windmill is the messaging gateway** — Slack bot built-in, signal-cli optional later. Routes to `claude -p` + PAI. No extra components.
13. **Bitwarden Secrets is source of truth for credentials** — Windmill vault is the operational cache (synced from Bitwarden). IAM role for cloud providers.
14. **Transport auth ≠ service auth** — MCP auth (Claude→server) is transport, handled automatically. Service auth (tool→API) follows the credential hierarchy. Don't conflate them.
15. **Third-party MCP servers with stored creds: don't use them** — build equivalent Windmill scripts instead. Two categories: standalone MCP (IAM only) or Windmill scripts (stored creds).
16. **No long-lived AWS credentials stored anywhere** — EC2 IAM role is the single source for all tools. No access keys in config files, env vars, or vault.
17. **10+ accounts via Organization-level AssumeRole** — Two cross-account roles (ReadOnly + ReadWrite) per member account, deployed via CloudFormation StackSet. Steampipe aggregators for cross-account SQL queries.
18. **Windmill deployment: Docker Compose on same EC2** — t3.xlarge (4 vCPU, 16GB). Not a separate instance. Captured by EBS snapshots.
19. **Implicit workstream switching** — PAI detects workstream from natural language via CONTEXT RECOVERY. No explicit "switch" command needed.
20. **Bitwarden sync via cron** — One bootstrap secret (service account token). Daily Windmill script syncs remaining secrets via `bws` CLI.
21. **Automatic cold-start dashboard** — SessionStart hook reads current-work.json + Windmill API, presents workstation status. No manual context recovery. Speak naturally to resume any workstream.
22. **Three-layer session bg/fg** — Layer 1: background agents within session (exists). Layer 2: `claude --resume` + PRD context recovery (exists with friction). Layer 3: `pai work/shelve/jobs` named workstream CLI (to build). PRD is the saved game state.
23. **Claude runs inside tmux** — SSH disconnect ≠ session lost. `tmux attach` resumes exactly where you left off. tmux is the session persistence layer, not a workspace manager. Zero-downtime depends on this.
24. **PRD continuous sync via hook + prompt** — PrdSync.hook.ts (deterministic, PostToolUse on TaskCreate/TaskUpdate) writes ISC to PRD on disk immediately. Algorithm prompt also instructs sync as backup. Two independent layers — neither depends on the other. Session death at any point loses nothing. /clear becomes safe. Recovery in ~10 seconds.
25. **All inputs funnel through Windmill auto-triage** — Every external input (Slack, SDP, AWS alerts, GitHub) routes to a Windmill triage script → `claude -p` with context bundle (current-work.json + active PRDs + MEMORY). Three actions: NOTIFY (urgent), QUEUE (dashboard), AUTO (investigate autonomously).
26. **Automatic daily and weekly activity reports** — Windmill cron generates manager-friendly "what I did" from PRDs, reflections, and triage logs. No ISC jargon. Delivered to Slack for review before forwarding.
27. **ReadWrite escalation: auto-escalate + hook confirms** — PAI auto-detects write intent and assumes ReadWrite role. SecurityValidator hook catches ALL actual write API calls and prompts for confirmation with details. Two layers: PAI handles the role switch, hook is the deterministic guardrail.
28. **Messaging destructive ops: Windmill approval flows** — Non-interactive `claude -p` (Slack-triggered) queues destructive actions for approval via Windmill's built-in approval flows. Seth approves from Slack or Windmill UI. No destructive operation executes without explicit confirmation.
29. **Windmill authoring via `wmill` CLI** — New integrations built from terminal using `wmill` CLI (script create, push, resource config). PAI drives the process — writes TypeScript, pushes via `wmill`. Browser only for OAuth authorization redirects (one-time per service).
30. **EBS encryption with customer-managed CMK** — All volumes and snapshots encrypted with a customer-managed KMS key. Key policy controlled by Seth, CloudTrail logs all usage. Zero friction — DLM, AMI, recovery paths all work unchanged. LUKS (Tier 3) declined: breaks automatic boot recovery for marginal threat protection gain.
31. **YubiKey FIDO2 on member account root** — Hardware security key required for root login. Phishing-resistant, unclonable. Two YubiKeys registered (primary + backup). Root is the ultimate override — sealing it with a physical device means no one without the YubiKey can escalate.
32. **Delete OrganizationAccountAccessRole from workstation account** — Removes the cross-account role that lets the management account AssumeRole into the workstation. Without it, management account controls SCPs and billing but has no IAM path to resources. Combined with YubiKey root: no external actor can read workstation data.
33. **Tailscale-only network access** — Zero inbound ports from public internet. All access (SSH, Windmill UI, dev ports) via Tailscale mesh VPN only. WireGuard encrypted, identity-based ACLs, MagicDNS. Outbound allowed for AWS APIs and external services. Attack surface: zero listening ports visible to the internet.
34. **Repos ARE production via symlinks** — All code lives in git repos under `~/repos/`. Claude Code's expected paths (`~/.claude/skills/`, `~/.claude/agents/`) are symlinks into repos. No copy/deploy step — edit in repo = live immediately. Runtime state (MEMORY, PRDs, logs) stays as real directories in `~/.claude/`, never in repos. Secrets (`.env`) stay local. `settings.json` is a real file (not symlinked) because it contains local-only config.
35. **CloudFormation for all IaC** — Single IaC tool. StackSets already chosen for cross-account roles (Decision #17). No state file to manage (state lives in AWS). Single-cloud workstation doesn't benefit from Terraform's multi-cloud. One `imladris-stack.yaml` for the workstation, StackSet templates for cross-account. All templates in `~/repos/imladris/cloudformation/`.
36. **Code Factory via thin orchestrator** — `factory.ts` in `~/repos/imladris/` is a single-file orchestrator. Reads PRD, partitions ISC criteria into work packages, spawns parallel Claude agents via `claude -p --worktree` for git-isolated execution, optionally runs independent review agent, merges worktree branches and creates GitHub PR via `gh`. PAI does thinking (Algorithm, ISC). Claude Code does isolation (worktrees). Factory is pure plumbing — disposable if PAI ships native factory. Zero PAI modifications.
37. **Domain tagging: work vs personal workstream separation** — Every workstream carries a `domain` tag (`work` or `personal`). Tag flows through the entire system: PRD frontmatter, current-work.json, triage classification, reports, guardrails, KB partitioning, agent context, and dashboard grouping. Inference-first — domain is auto-assigned from input source mapping and content analysis, never requires manual tagging. Override via `domain: personal` in natural language or PRD frontmatter. See "Domain Tagging Architecture" section for full flow.
38. **Amazon Linux 2023 ARM AMI** — Graviton-native, smallest attack surface, longest AWS support, SSM agent pre-installed. Uses `dnf` (same as bootstrap.sh). AMI resolved via SSM public parameter (`/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64`) — always gets latest patched version, no hardcoded AMI IDs.
39. **UserData automated deploy** — CloudFormation embeds bootstrap.sh in UserData. Instance comes up fully provisioned — no manual SSH required. Reads SSM parameter for bws token, runs full bootstrap, connects Tailscale. If something goes wrong: terminate and redeploy. Fits deterministic-first principle. First access is via Tailscale SSH after bootstrap completes.
40. **SSM Parameter Store with CMK for bootstrap secret** — Bitwarden service account token stored as SSM SecureString at `/imladris/bws-token`, encrypted with the customer-managed workstation CMK (`alias/workstation-ebs`). Same trust model as EBS — only EC2 instance role and root+YubiKey can decrypt. Must use `--key-id alias/workstation-ebs` (not default `aws/ssm` key). One manual `aws ssm put-parameter` before first deploy.

---

## Domain Tagging Architecture

**Decision 37 — Full System Flow**

Every workstream is tagged `work` (default) or `personal`. The tag originates at workstream creation and propagates through every system that touches workstream data. The design principle: **infer always, ask never, override easily.**

### Source-to-Domain Mapping (Deterministic Layer)

Input sources have default domain assignments. These are deterministic — no AI needed:

| Source | Default Domain | Rationale |
|--------|---------------|-----------|
| SDP tickets | `work` | Service desk is always work |
| AWS alerts (CloudWatch, GuardDuty, Config) | `work` | Infrastructure is work |
| GitHub (PRs, issues, Actions) | `work` | Code is work |
| Slack `#work-*` channels | `work` | Channel name convention |
| Slack `#personal-*` channels | `personal` | Channel name convention |
| Slack DMs | `infer` | Could be either — triage agent classifies |
| Interactive terminal (default) | `work` | Most terminal work is DevOps |
| Interactive terminal (explicit override) | as stated | "personal: research cameras" → `personal` |

### Inference Layer (AI-Assisted)

When source mapping returns `infer` or when the interactive session context is ambiguous, PAI uses lightweight classification:
- **Keywords:** AWS, ticket, deploy, infra, SDP, incident → `work`. Camera, music, shopping, recipe, vacation → `personal`.
- **Active workstream context:** If resuming a PRD that's already tagged, inherit.
- **Fallback:** `work`. Conservative default — work guardrails are stricter, so false-positive-as-work is safer than false-positive-as-personal.

### PRD Frontmatter

```yaml
---
prd: true
id: PRD-20260222-camera-comparison
domain: personal          # work | personal
# ... existing fields ...
---
```

The `domain` field is set at PRD creation and persists for the life of the workstream. Can be changed manually in frontmatter if misclassified.

### current-work.json Schema Update

```json
{
  "active_workstreams": [
    {
      "name": "Imladris Phase 1",
      "prd": "~/.claude/MEMORY/WORK/imladris-phase1/PRD-20260218-imladris.md",
      "domain": "work",
      "phase": "BUILD",
      "last_action": "Added Bedrock KB to CloudFormation"
    },
    {
      "name": "Camera Comparison",
      "prd": "~/.claude/MEMORY/WORK/camera-comparison/PRD-20260222-cameras.md",
      "domain": "personal",
      "phase": "VERIFY",
      "last_action": "Compared Sony vs Canon specs"
    }
  ]
}
```

### Triage Flow (Decision 25 Integration)

The Windmill triage script adds domain classification as step 1 of its pipeline:

```
Input arrives → Source mapping (deterministic) → Domain assigned
  ↓
If domain = infer → Content analysis (lightweight AI) → Domain assigned
  ↓
Triage classification (NOTIFY / QUEUE / AUTO) proceeds with domain context
  ↓
Output includes domain tag → PRD created with domain → current-work.json updated
```

The `claude -p` context bundle now includes `"domain": "work|personal"` so the triage agent knows which guardrail profile to apply.

### Guardrail Scoping (Decisions 27, 28 Integration)

Domain tag modifies guardrail behavior:

| Guardrail | `domain: work` | `domain: personal` |
|-----------|----------------|---------------------|
| AWS account access | ReadOnly default, ReadWrite via escalation (Decision 27) | No AWS access unless explicitly requested |
| SecurityValidator hook | Active — confirms all write API calls | Active — same protection applies |
| Destructive ops (Decision 28) | Windmill approval flow | Same — no destructive op without approval |
| Autonomous execution | Read-only by default, queues writes | Read-only by default, queues writes |
| Scope of access | All 10+ AWS accounts via AssumeRole | Only personal account (if configured) |

**Key principle:** Personal workstreams don't automatically get access to work AWS accounts. A personal task doesn't need to query production infrastructure. If it does need AWS, it's probably miscategorized.

### Report Filtering (Decision 26 Integration)

Activity reports use domain tags to separate content:

| Report | Includes | Excludes |
|--------|----------|----------|
| **Daily manager report** | `domain: work` only | `domain: personal` — never visible |
| **Weekly manager report** | `domain: work` only | `domain: personal` — never visible |
| **Personal daily digest** (optional) | `domain: personal` only | `domain: work` — already covered |
| **Full activity log** (Seth only) | Both domains | Nothing excluded |

Manager-friendly reports (Decision 26) NEVER include personal workstream data. This is a hard rule, not a filter preference.

### KB Data Partitioning (S3 Prefix Strategy)

The Knowledge Bucket (added this session) uses domain-based S3 prefixes:

```
s3://imladris-knowledge-{account-id}/
├── work/               # Work domain data
│   ├── sdp/           # Service desk exports
│   ├── aws/           # AWS config, inventory
│   ├── github/        # Repo docs, PR history
│   └── slack-work/    # Work channel archives
├── personal/          # Personal domain data
│   ├── research/      # Personal research
│   ├── shopping/      # Product comparisons
│   └── slack-personal/ # Personal channel archives
└── shared/            # Cross-domain (rare)
    └── reference/     # General reference material
```

Bedrock KB data sources can be scoped to specific S3 prefixes. This means:
- Work KB queries only search `work/` prefix by default
- Personal KB queries only search `personal/` prefix
- Cross-domain search requires explicit request
- Same CMK encryption, same bucket policy — security is identical

### Agent Domain Inheritance

When spawning agents (`claude -p` or background Task agents):

1. **Triage-triggered agents:** Inherit domain from triage classification
2. **Interactive-spawned agents:** Inherit domain from current active PRD
3. **Windmill cron agents:** Domain set in Windmill script configuration
4. **No PRD context:** Default to `work`

The context bundle passed to `claude -p` includes:
```json
{
  "domain": "work",
  "guardrail_profile": "work-readonly",
  "aws_scope": ["all-accounts"],
  ...existing context...
}
```

### Dashboard Grouping (Decision 21 Integration)

The SessionStart cold-start dashboard groups workstreams by domain:

```
┌──────────────────────────────────────────────────┐
│  IMLADRIS WORKSTATION — 2026-02-22 09:45 PST     │
├──────────────────────────────────────────────────┤
│  WORK:                                            │
│    ⚡ Imladris Phase 1    BUILD   15min ago       │
│    📋 SDP #4521           QUEUED  2hr ago         │
│                                                   │
│  PERSONAL:                                        │
│    ⚡ Camera Comparison    VERIFY  30min ago       │
│    ✅ Music Store Research COMPLETE 1hr ago        │
├──────────────────────────────────────────────────┤
│  Windmill: 3 flows OK │ Bedrock: healthy          │
└──────────────────────────────────────────────────┘
```

### Workstream Switching (Decision 19 Integration)

Implicit workstream switching (CONTEXT RECOVERY) now includes domain context:
- "What's the status of the camera research?" → detects `personal` domain PRD, switches
- "Check the SDP ticket" → detects `work` domain PRD, switches
- Domain switch is seamless — no prompt, no confirmation
- Guardrail profile changes automatically based on new active workstream's domain

### Override Mechanisms

Domain is inference-first but always overridable:
1. **Natural language:** "personal: look into guitar amps" — prefix triggers personal domain
2. **PRD frontmatter:** Edit `domain: personal` → `domain: work` (or vice versa)
3. **pai CLI (future):** `pai work --domain personal "guitar research"` — explicit domain flag

No mechanism requires Seth to answer a question or click a confirmation for domain assignment. Zero friction (ISC-A2).

---

## Open Questions

1. ~~**State snapshot frequency**~~ — ANSWERED: Two-layer (DLM hourly + PAI hooks per phase)
2. ~~**Workstream switching UX**~~ — ANSWERED: Implicit by default (PAI detects from request via CONTEXT RECOVERY + current-work.json). Explicit PRD path as escape hatch.
3. ~~**Long-running process tracking**~~ — ANSWERED: Windmill workers for durable jobs, tmux for ephemeral session daemons. Windmill dashboard for tracking.
4. ~~**Session handoff**~~ — ANSWERED: EBS snapshot → new instance → SessionStart hook
5. ~~**Multi-account AWS**~~ — ANSWERED: 10+ accounts. Organization-level. Steampipe connection aggregators (`aws_all`). Two cross-account roles per member (ReadOnly + ReadWrite) deployed via CloudFormation StackSet. EC2 instance AssumeRole into each.
6. ~~**SDP MCP server**~~ — ANSWERED: Build SDP scripts in Windmill → auto-exposed as MCP tools. No dedicated MCP needed.
7. ~~**Windmill timing**~~ — ANSWERED: Foundation stack, not deferred. Self-hosted on EC2, accessed via MCP.
8. ~~**Windmill deployment**~~ — ANSWERED: Docker Compose on same EC2 instance. t3.xlarge (4 vCPU, 16GB) for comfort. Captured by EBS snapshots.
9. ~~**MCP coverage gaps**~~ — ANSWERED: Don't use third-party MCP servers that need stored creds. Build Windmill scripts for SaaS. Only standalone MCP for IAM-only services.
10. ~~**Credential management**~~ — ANSWERED: Bitwarden Secrets → Windmill vault (cache) → scripts. IAM role for cloud. No stored AWS keys.
11. ~~**Messaging gateway**~~ — ANSWERED: Windmill Slack bot (built-in). OpenClaw evaluated and dropped.
12. ~~**Bitwarden → Windmill sync**~~ — ANSWERED: Manual bootstrap (one service account token). Daily Windmill cron script syncs via `bws` CLI.
13. ~~**IAM role scope**~~ — ANSWERED: Two roles per account: ReadOnly (instance profile default) + ReadWrite (via AssumeRole, explicit, CloudTrail logged). Deployed to all 10+ accounts via StackSet.

**All questions answered.** No open items remain.

---

## Disk Encryption (Data at Rest Security) — Decided 2026-02-19

All EBS volumes and snapshots are encrypted with a **customer-managed KMS key (CMK)**.

### Threat Model

| Threat | EBS + AWS Key | EBS + Customer CMK | LUKS (OS-level) |
|--------|--------------|-------------------|-----------------|
| Physical disk theft / decommission | Protected | Protected | Protected |
| Unauthorized AWS service access | Not protected | **Protected** (key policy) | **Protected** |
| Rogue AWS employee | Detectable (CloudTrail) | **Protected** (policy denies) + detectable | **Protected** (key not in AWS) |
| Legal compulsion to AWS | AWS could comply | AWS could comply (KMS has material) | **AWS cannot comply** (no key) |
| Instance reboot recovery | Automatic | Automatic | **Manual passphrase required** |

### Decision: Customer-Managed CMK (Tier 2)

**Why not AWS-managed key (Tier 1):** AWS holds the key with no customer-controlled policy. Offers no protection beyond physical theft.

**Why not LUKS (Tier 3):** Requires manual passphrase on every boot. Breaks zero-downtime recovery (Decision #23 — tmux, auto-recovery paths). Instance reboot, DLM snapshot restore, and AMI launch all require manual intervention. The protection gain (legal compulsion resistance) doesn't justify the operational cost for a single-engineer workstation.

**Why CMK (Tier 2):**
- **Key policy you control** — explicitly deny all AWS services/principals except your account
- **CloudTrail logs every key use** — who decrypted, when, from where. Anomalous access is detectable.
- **Zero friction** — EBS, DLM snapshots, AMI creation all work identically. No passphrase. No boot changes.
- **Recovery paths unchanged** — launch from snapshot, attach volume, cross-AZ restore all automatic
- **Cost:** ~$1/month per CMK + $0.03/10K API calls (negligible)
- **Compliance:** Meets HIPAA, PCI-DSS, SOC 2, FedRAMP requirements for encryption at rest

### Implementation

```bash
# Create customer-managed KMS key
aws kms create-key \
  --description "Workstation EBS encryption" \
  --key-usage ENCRYPT_DECRYPT \
  --origin AWS_KMS

# Create alias for easy reference
aws kms create-alias \
  --alias-name alias/workstation-ebs \
  --target-key-id <key-id>

# Set as default EBS encryption key for the account (all new volumes auto-encrypt)
aws ec2 modify-ebs-default-kms-key-id \
  --kms-key-id alias/workstation-ebs

# Enable EBS encryption by default (all new volumes in this region)
aws ec2 enable-ebs-encryption-by-default

# Existing unencrypted volumes: create encrypted snapshot, then new volume from it
aws ec2 create-snapshot --volume-id vol-xxx --encrypted --kms-key-id alias/workstation-ebs
```

**What gets encrypted automatically after setup:**
- All new EBS volumes (default encryption enabled)
- All DLM snapshots (inherit from source volume)
- All AMIs created from the instance
- Data in transit between EC2 and EBS (always encrypted, separate from at rest)
- All volumes created from encrypted snapshots

**Optional hardening (future):**
- LUKS layer inside EBS for defense-in-depth (adds boot passphrase requirement — tradeoff)
- CloudHSM-backed KMS key (you own the HSM hardware, ~$1.50/hr — significant cost)
- External Key Store (XKS) — KMS uses keys stored outside AWS entirely (maximum control, maximum complexity)

---

## Workstation Security Posture (Decided 2026-02-20)

Six layers that together ensure: **no person other than Seth can read workstation data.** Each layer addresses a different attack vector. All layers are independent — any single layer failing doesn't compromise the others.

```
Layer 7: Tailscale-only network access (zero public ports) ← ZERO ATTACK SURFACE
Layer 6: CloudTrail alerts on critical actions              ← DETECTION
Layer 5: SCP protects Seth's IAM user (MFA + password)      ← PREVENT IDENTITY THEFT
Layer 4: Delete OrganizationAccountAccessRole                ← BLOCK CROSS-ACCOUNT PATH
Layer 3: YubiKey FIDO2 on member account root                ← SEAL ROOT OVERRIDE
Layer 2: MFA-locked KMS key policy (personal secrets)        ← LOCK SENSITIVE DATA TO SETH
Layer 1: CMK-encrypted EBS (all volumes + snapshots)         ← ENCRYPT EVERYTHING AT REST
```

### Layer 1: EBS Encryption with Customer-Managed CMK
All volumes and snapshots encrypted. Key policy controlled by Seth. See "Disk Encryption" section above.

### Layer 2: Personal MFA-Locked KMS Key (Optional, for sensitive data)
A separate KMS key with a restrictive key policy:
- No root principal delegation (IAM policies have no effect)
- Only Seth's IAM user + MFA can encrypt/decrypt
- Only Seth's IAM user + MFA can manage the key
- Explicit Deny for all other principals
- For specific sensitive data (credentials, private keys, personal documents) — not the whole disk

### Layer 3: YubiKey FIDO2 on Root
Member account root protected with hardware FIDO2 security key (YubiKey). Root login requires email + password + physical YubiKey tap. Phishing-resistant, unclonable, unextractable. Register two YubiKeys (primary + backup in secure location).

### Layer 4: Delete OrganizationAccountAccessRole
Remove the auto-created cross-account role that lets the management account AssumeRole into the workstation account. Without this role, the management account has no IAM path into the workstation account. They can modify SCPs and close the account — but cannot access resources.

### Layer 5: SCP Protecting Seth's IAM Identity
Service Control Policy (applied from management account) that prevents any principal except Seth from modifying Seth's:
- MFA device (deactivate, enable, delete, resync, create)
- Password (update, delete, create login profile)

This prevents the attack chain: assume role → reset password → replace MFA → impersonate Seth.

### Layer 6: CloudTrail Alerts
Alarm on critical identity and key management events:
- `DeletePolicy` / `DetachPolicy` on protective SCPs
- `AssumeRole` on any cross-account role in the workstation account
- `UpdateLoginProfile` / `DeactivateMFADevice` on Seth's IAM user
- `PutKeyPolicy` on any KMS key
- `ScheduleKeyDeletion` on any KMS key

### What This Protects Against

| Threat Actor | Can They Read Data? | Why |
|-------------|-------------------|-----|
| Other IAM admin in same account | **No** | KMS key policy explicit Deny + no root delegation |
| Org management account admin | **No** | OrganizationAccessRole deleted, no IAM path in |
| Someone with root email + password | **No** | YubiKey required, physical device on Seth's person |
| AWS employee (internal) | **No** (operational controls) | CMK in FIPS 140-2 HSMs, SOC 2 audited access controls |
| AWS under legal compulsion | **Theoretically yes** | AWS operates the KMS HSMs (upgrade to XKS on non-AWS host to close this gap) |

### Layer 7: Tailscale-Only Network Access (Decided 2026-02-20)
The workstation has **zero inbound ports open to the public internet.** All access is via Tailscale mesh VPN.

**Security group:**
```
Inbound:  NONE (no rules — nothing from 0.0.0.0/0)
Outbound: All traffic (AWS APIs, external services, package updates)
```

**Access paths — all via Tailscale:**
- **SSH:** `ssh workstation` via Tailscale IP (100.x.y.z) or MagicDNS hostname
- **Windmill UI:** `http://workstation:8000` via Tailscale — never exposed publicly
- **Any dev server / debug port:** only reachable from tailnet devices

**What Tailscale provides:**
- WireGuard encryption on all traffic between devices
- Identity-based access (tied to your Tailscale account, not IP addresses)
- ACLs for which devices can reach which ports
- MagicDNS for friendly hostnames (`workstation.tailnet-name.ts.net`)
- Optional: Tailscale SSH (replaces SSH keys entirely with identity-verified, logged sessions)

**Outbound access:** The workstation needs outbound internet for AWS APIs, Windmill external calls (SDP, GitHub, Slack), Steampipe queries, and package updates. Outbound goes via the VPC's internet gateway or NAT gateway — no inbound required.

**Attack surface:** Zero listening ports on the public internet. Port scanners see nothing. The only way in is through a device authenticated on Seth's tailnet.

### Implementation Order
1. Create CMK + enable default EBS encryption (Phase 1, already in roadmap)
2. Register YubiKey(s) on root (console, 5 minutes)
3. Delete OrganizationAccountAccessRole (one CLI command)
4. Create SCP protecting Seth's identity (management account)
5. Set up CloudTrail alerts (EventBridge rules → SNS → Slack)
6. Install Tailscale on workstation, empty security group inbound rules
7. (Optional) Create personal MFA-locked KMS key for sensitive data

**Status: TO BUILD** — all steps documented, ready to execute in Phase 1.

---

## Infrastructure Persistence (Zero Data Loss + Zero Downtime)

**Decided 2026-02-18:** Two-layer snapshot strategy on EC2.

### Layer 1: EBS Snapshots (Machine State — Hourly)

Preserves everything: installed tools, configs, tmux sessions, filesystem state.

**Method: DLM (Data Lifecycle Manager)** — set and forget, fully managed by AWS.

```bash
# Create lifecycle policy: hourly snapshots, retain 24
aws dlm create-lifecycle-policy \
  --description "Workstation hourly snapshots" \
  --state ENABLED \
  --execution-role-arn arn:aws:iam::ACCOUNT:role/AWSDataLifecycleManagerDefaultRole \
  --policy-details '{
    "PolicyType": "EBS_SNAPSHOT_MANAGEMENT",
    "ResourceTypes": ["VOLUME"],
    "TargetTags": [{"Key": "Workstation", "Value": "true"}],
    "Schedules": [{
      "Name": "Hourly",
      "CreateRule": {"Interval": 1, "IntervalUnit": "HOURS"},
      "RetainRule": {"Count": 24},
      "CopyTags": true
    }]
  }'
```

**Cost:** ~$2-3/month for 24 hourly snapshots of a 50GB volume (incremental after first).
**Status: TO CONFIGURE** — needs volume tagged `Workstation=true` and DLM role created.

### Layer 2: PAI State Files (Context State — Per Phase)

Preserves Claude/PAI working context that doesn't live on disk naturally.

**Method: Phase-transition hook** — fires when Algorithm voice curls execute (marks phase boundaries).

**Hook: StateSnapshot.hook.ts**

Triggers on PostToolUse for Bash commands matching voice curl patterns. Updates `current-work.json` with:
- Active workstream name and PRD path
- Current Algorithm phase
- Last significant action
- Blocking items
- Environment state (AWS profile, region, auth validity)

**Frequency:** ~7 writes per Algorithm run (one per phase transition). Low overhead, good granularity.
**Status: TO BUILD** — see hook spec below.

### Layer 3: Weekly AMI (Fast Rebuild)

For zero-downtime full machine replacement.

```bash
# Weekly cron: create AMI with all tools pre-installed
0 0 * * 0 aws ec2 create-image \
  --instance-id i-xxx \
  --name "workstation-$(date +%Y%m%d)" \
  --no-reboot
```

Recovery path: Launch AMI → attach latest EBS snapshot data → go.
**Status: OPTIONAL** — nice to have, not critical with DLM in place.

### Recovery Scenarios

| Scenario | Recovery Method | Time |
|----------|---------------|------|
| Session crash (Claude dies) | Restart Claude → SessionStart reads current-work.json | ~10 seconds |
| Context compaction (mid-session) | Post-compaction audit + PRD re-read | ~30 seconds |
| Instance reboot | tmux restores, restart Claude → SessionStart hook | ~1 minute |
| Instance terminated | Launch from latest EBS snapshot → start Claude → SessionStart | ~5 minutes |
| Instance unrecoverable | Launch from AMI + attach snapshot → start Claude → SessionStart | ~5 minutes |
| Availability zone failure | Launch AMI in different AZ + copy snapshot | ~10 minutes |

---

## Hook Specifications

### StateSnapshot.hook.ts — TO BUILD

**Purpose:** Auto-persist PAI working context to disk at Algorithm phase boundaries.
**Event:** PostToolUse
**Matcher:** Bash (fires on voice curl commands that mark phase transitions)
**Detection:** Check if Bash command matches `curl.*localhost:8888/notify.*phase`

**Writes to:** `~/.claude/state/current-work.json`

**Logic:**
```typescript
// Pseudocode
const input = JSON.parse(await Bun.stdin.text());

// Only fire on voice curl phase announcements
if (!input.tool_input?.command?.includes('localhost:8888/notify')) return;

// Extract phase from the curl message
const phase = extractPhase(input.tool_input.command);

// Read existing state or create new
const state = await readCurrentWork();

// Update with current context
state.last_updated = new Date().toISOString();
state.last_phase = phase;
state.session_id = input.session_id;

// Write back
await Bun.write('~/.claude/state/current-work.json', JSON.stringify(state, null, 2));
```

**Challenge:** The hook knows the phase but not the workstream details (name, PRD path, last action). Those need to be written by the Algorithm itself during execution, or extracted from the ISC task list.

**Possible enhancement:** Read TaskList state and serialize active tasks + statuses into the snapshot.

### McpLogger.hook.ts — TO BUILD

**Purpose:** Log all MCP tool calls for audit and determinism.
**Event:** PreToolUse + PostToolUse
**Matcher:** `mcp__*`

**Writes to:** `~/.claude/logs/mcp-calls.jsonl`

**PreToolUse entry:**
```json
{
  "ts": "2026-02-18T19:30:00Z",
  "event": "pre",
  "session": "abc-123",
  "tool": "mcp__aws__list_ec2_instances",
  "params": {"region": "us-east-1"}
}
```

**PostToolUse entry:**
```json
{
  "ts": "2026-02-18T19:30:01Z",
  "event": "post",
  "session": "abc-123",
  "tool": "mcp__aws__list_ec2_instances",
  "response_size": 4521,
  "duration_ms": 340
}
```

---

## File Layout: Development vs Production (Decided 2026-02-20)

The workstation IS a development environment that modifies itself. This creates a meta-problem: PAI skills, hooks, agents, and settings all live at paths Claude Code expects (`~/.claude/`), but they need to be version-controlled in git repos. Previous Imladris solved this by mapping repos directly to live paths, which created constant confusion about which location was canonical.

### Principle: Repos ARE Production

There is no separate "production location." Git repo checkouts are the live, running code. Symlinks make Claude Code's expected paths point into the repos. No copy step. No deploy step. Edit a file in the repo → it's live immediately.

### Three Categories of Files

| Category | Description | Lives In | Version Controlled |
|----------|-------------|----------|-------------------|
| **Code** | Skills, hooks, agents, tools, settings, configs | Git repos under `~/repos/` | Yes |
| **Runtime State** | MEMORY, PRDs, sessions, current-work.json, logs | `~/.claude/` (real directories) | No |
| **System Config** | `.bashrc`, `.tmux.conf`, Windmill docker-compose | Git repo (`~/repos/dotfiles/`) | Yes |

### Directory Layout

```
~/repos/                              # All git repos live here
├── PAI/                              # PAI system repo (github.com/danielmiessler/PAI)
│   ├── skills/PAI/                   # Skills, tools, hooks, agents
│   ├── settings.json                 # Claude Code settings (template)
│   └── ...
├── imladris/                         # Workstation-specific repo (bootstrap, configs)
│   ├── bootstrap.sh                  # Instance init script
│   ├── docker-compose.yml            # Windmill + services
│   ├── cloudformation/               # StackSets, IAM roles
│   └── ...
└── dotfiles/                         # Shell, tmux, git configs
    ├── .bashrc
    ├── .tmux.conf
    └── ...

~/.claude/                            # Claude Code's expected root
├── skills/ -> ~/repos/PAI/skills     # SYMLINK — skills served from repo
├── agents/ -> ~/repos/PAI/agents     # SYMLINK — agents served from repo
├── hooks/ -> ~/repos/PAI/hooks       # SYMLINK — hooks served from repo (if separate)
├── settings.json                     # REAL FILE — may diverge from repo template
├── keybindings.json                  # REAL FILE — local only
├── MEMORY/                           # REAL DIR — runtime state, never in git
│   ├── WORK/                         # Active PRDs, sessions
│   ├── STATE/                        # current-work.json, dashboards
│   └── LEARNING/                     # Reflections, patterns
├── projects/                         # REAL DIR — project-specific Claude state
├── logs/                             # REAL DIR — MCP logs, hook logs
└── .env                              # REAL FILE — secrets, never in git
```

### The Symlink Contract

| Claude Code expects... | Symlink points to... | Canonical location |
|------------------------|---------------------|--------------------|
| `~/.claude/skills/PAI/` | `~/repos/PAI/skills/PAI/` | **The repo** |
| `~/.claude/agents/` | `~/repos/PAI/agents/` | **The repo** |
| `~/.claude/skills/PAI/.env` | NOT symlinked — `.env` stays at real path or in `~/.claude/` | **Local only** |
| `~/.claude/settings.json` | NOT symlinked — real file | **Local** (repo has template) |
| `~/.claude/MEMORY/` | NOT symlinked — real directory | **Local only** |

### The Workflow

```
Seth edits ~/repos/PAI/skills/PAI/Tools/Inference.ts
  ↓ (symlink means this IS ~/.claude/skills/PAI/Tools/Inference.ts)
Change is immediately live — Claude uses it on next invocation
  ↓
Seth commits and pushes from ~/repos/PAI/
  ↓
Done. No build. No copy. No deploy.
```

### What Goes in Each Repo

**`~/repos/PAI/`** — The PAI system itself
- Skills, tools, hooks, agents, components
- Algorithm prompts, skill index
- Everything that IS the PAI framework
- `.env.example` (template) but NOT `.env` (secrets)

**`~/repos/imladris/`** — Workstation bootstrap and infrastructure
- `bootstrap.sh` — sets up a fresh EC2 instance (installs deps, creates symlinks, starts services)
- `docker-compose.yml` — Windmill + supporting services
- CloudFormation templates (StackSets, IAM roles)
- Tailscale setup scripts
- KMS key creation scripts
- Instance-specific configs that aren't PAI but aren't personal dotfiles

**`~/repos/dotfiles/`** — Personal configs (optional, if Seth version-controls dotfiles)
- Shell configs, tmux config, git config
- Symlinked from `~/.bashrc -> ~/repos/dotfiles/.bashrc` etc.

### Rules

1. **If it's code or config that should be version-controlled → it lives in a repo under `~/repos/`**
2. **If Claude Code needs it at a specific path → symlink from that path into the repo**
3. **If it's generated at runtime (state, logs, sessions, PRDs, MEMORY) → it stays in `~/.claude/` as a real directory, never in any repo**
4. **If it contains secrets (.env, tokens) → it stays local, never symlinked from a repo, never committed**
5. **Canonical location for code = the repo. Always.** The symlink is a convenience for Claude Code, not a separate copy.
6. **`settings.json` is the exception** — it's a real file at `~/.claude/settings.json` because it may contain local-only MCP server configs, paths, and identity that differ from the repo template. The repo carries a `settings.json.template` for bootstrapping.

### Bootstrap Sequence (in `~/repos/imladris/bootstrap.sh`)

```bash
# 1. Clone repos
git clone <PAI-repo> ~/repos/PAI
git clone <imladris-repo> ~/repos/imladris
git clone <dotfiles-repo> ~/repos/dotfiles  # optional

# 2. Create symlinks
ln -sfn ~/repos/PAI/skills ~/.claude/skills
ln -sfn ~/repos/PAI/agents ~/.claude/agents

# 3. Create runtime directories (not symlinks)
mkdir -p ~/.claude/MEMORY/{WORK,STATE,LEARNING}
mkdir -p ~/.claude/projects ~/.claude/logs

# 4. Copy template → real settings (first time only, don't overwrite)
cp -n ~/repos/PAI/settings.json.template ~/.claude/settings.json

# 5. Populate .env from Bitwarden Secrets
# (Windmill cron handles ongoing sync — this is one-time bootstrap)

# 6. Start services
cd ~/repos/imladris && docker compose up -d  # Windmill
```

---

## Implementation Roadmap

### Phase 1: Foundation (MCP + Services + Infrastructure + Credentials)
- [ ] Install Steampipe + AWS plugin on EC2
- [ ] Configure Steampipe MCP server (turbot/steampipe-mcp)
- [ ] Add Steampipe warm-up to SessionStart hook (`steampipe service start` + prime query)
- [ ] Install mcp-tools CLI (Go binary)
- [ ] Set up AWS MCP server (managed preview)
- [ ] Deploy Windmill self-hosted on EC2 (Docker Compose with `restart: always` + healthcheck)
- [ ] Configure Windmill MCP server in Claude Code settings.json
- [ ] Install `wmill` CLI on EC2 for terminal-driven Windmill authoring
- [ ] Configure EC2 IAM role with appropriate permissions
- [ ] Verify all tools (AWS MCP, Steampipe, Windmill) auto-detect IAM role
- [ ] Set up Windmill vault with initial credentials (synced from Bitwarden)
- [ ] Configure Windmill Slack bot for messaging gateway
- [ ] Build McpLogger.hook.ts (PreToolUse + PostToolUse for `mcp__*`)
- [ ] Add Windmill health indicator to SessionStart dashboard
- [ ] Create customer-managed KMS key (`alias/workstation-ebs`) with restrictive key policy
- [ ] Enable EBS encryption by default for the region
- [ ] Set customer CMK as default EBS encryption key
- [ ] Migrate any existing unencrypted volumes (snapshot → encrypted volume)
- [ ] Register YubiKey FIDO2 as root MFA (primary + backup YubiKey)
- [ ] Delete OrganizationAccountAccessRole from workstation account
- [ ] Create SCP protecting Seth's IAM user (MFA + password) in management account
- [ ] Set up CloudTrail EventBridge rules for critical identity/key events → SNS → Slack
- [ ] Clone repos to `~/repos/` (PAI, imladris, dotfiles)
- [ ] Create symlinks: `~/.claude/skills/` → `~/repos/PAI/skills/`, `~/.claude/agents/` → `~/repos/PAI/agents/`
- [ ] Create runtime directories: `~/.claude/MEMORY/`, `~/.claude/projects/`, `~/.claude/logs/`
- [ ] Copy `settings.json.template` → `~/.claude/settings.json` (first-time bootstrap only)
- [ ] Install Tailscale on workstation, join tailnet
- [ ] Remove all inbound security group rules (empty inbound = zero public ports)
- [ ] Verify SSH, Windmill UI accessible only via Tailscale IP
- [ ] (Optional) Enable Tailscale SSH for identity-based, logged SSH sessions
- [ ] (Optional) Create personal MFA-locked KMS key for sensitive data
- [ ] Tag EC2 volume `Workstation=true`
- [ ] Create DLM IAM role + configure hourly EBS snapshot policy (snapshots auto-inherit encryption)

### Phase 2: Service Integrations (via MCP + Windmill)
- [ ] Build SDP scripts in Windmill (list_tickets, create_ticket, add_note, close_ticket)
- [ ] Store SDP Zoho OAuth credentials in Windmill vault
- [ ] Verify SDP scripts auto-expose as MCP tools via Windmill MCP
- [ ] Test: "show my open tickets" → Windmill MCP → SDP script → results
- [ ] Build SecurityValidator hook for write API call confirmation (Decision #27)
- [ ] Define error contract for MCP→Windmill→API chain (structured errors, not opaque failures)
- [ ] Build credential failure recovery UX (PAI detects auth failure → tells user exact fix)
- [ ] Add manual credential sync command (`pai sync-creds`) alongside daily cron
- [ ] Document MCP coverage gaps per server (what falls through to CLI)
- [ ] Build Windmill scripts for any gaps worth automating

### Phase 3: Context Persistence + Session Resilience
- [ ] Design and implement current-work.json schema (finalize fields)
- [ ] Create `~/.claude/state/` directory
- [ ] Build PrdSync.hook.ts (PostToolUse on TaskCreate|TaskUpdate → sync ISC to PRD on disk)
- [ ] Build StateSnapshot.hook.ts (PostToolUse on phase-transition voice curls)
- [ ] Enhance StateSnapshot to also trigger on TaskCreate/TaskUpdate (not just voice curls)
- [ ] Implement atomic writes for current-work.json (write to temp file, rename)
- [ ] Build/enhance SessionStart hook to read current-work.json and restore context
- [ ] Add background agent completion voice notification (curl to voice server on agent done)
- [ ] Enhance Algorithm LEARN phase to auto-extract cross-domain patterns to MEMORY
- [ ] Test: run Algorithm → kill session → restart → verify context restored
- [ ] Test: /clear mid-work → restart → verify PRD has full ISC state

### Phase 4: Single-Session Workflow + Workstream Management
- [ ] Build `pai work/shelve/jobs` CLI wrapper (named workstream switching)
- [ ] Build `pai archive <workstream>` for workstream archiving (PRD → MEMORY/ARCHIVE/)
- [ ] Implement PRD write conflict resolution for parallel agents (separate files, foreground reconciles)
- [ ] Add TTL on current-work.json entries (7d inactive → auto-archive or flag stale)
- [ ] Build Windmill approval flows for messaging gateway destructive operations (Decision #28)
- [ ] Implement workstream switching (natural language → PRD context loading)
- [ ] Add domain tag to PRD frontmatter and current-work.json schema (Decision #37)
- [ ] Implement source-to-domain mapping in triage pipeline (Decision #37)
- [ ] Add domain-aware workstream grouping to SessionStart dashboard (Decision #37)
- [ ] Move long-running processes from tmux to Windmill workers where appropriate
- [ ] Test full cold-start recovery (terminate instance → launch from snapshot → new session → verify)
- [ ] Set up weekly AMI cron (optional, for fast rebuilds)

### Phase 5: Automation + Triage + Reporting
- [ ] Build Windmill triage script + triage prompt engineering (Decision #25)
- [ ] Add domain classification as step 1 of triage pipeline (Decision #37)
- [ ] Configure webhook receivers: SDP events → Windmill
- [ ] Configure webhook receivers: AWS SNS alerts → Windmill
- [ ] Configure webhook receivers: GitHub events → Windmill
- [ ] Test end-to-end: external event → Windmill → triage → NOTIFY/QUEUE/AUTO routing
- [ ] Build daily activity report Windmill cron (5:00 PM) + report prompt (Decision #26)
- [ ] Build weekly activity report Windmill cron (Friday 4:00 PM)
- [ ] Add domain filter to report generation — manager reports exclude personal (Decision #37)
- [ ] Configure report delivery: Markdown file + Slack DM
- [ ] Implement domain-scoped guardrail profiles (work vs personal AWS access) (Decision #37)
- [ ] Configure KB S3 prefix partitioning by domain (Decision #37)
- [ ] Compliance scan automation (Powerpipe benchmarks via Windmill cron)
- [ ] Daily cost report (Steampipe cost queries via Windmill schedule)
- [ ] SDP ticket check (morning summary via Windmill schedule)
- [ ] SDP → AWS correlation (ticket mentions instance → Windmill flow auto-checks state)
- [ ] Cross-AZ recovery runbook (if high availability required)

### Phase 6: Intelligence Cycle Expansion (Future)
- [ ] Feed collection infrastructure (RSS security feeds, CVE/NVD, vendor advisories via Windmill cron)
- [ ] Entity extraction/enrichment for automatic cross-source correlation
- [ ] Contextual surfacing: proactively pull related info into active workstreams
- [ ] Triage feedback loop: measure triage quality, improve routing based on outcomes
- [ ] Time-series / trend storage for "is this getting worse over 3 months?" queries

---

## UX Friction Audit (2026-02-19)

User-centric review of spec from Seth's daily experience perspective. Goal: zero friction, maximum speed, proper guardrails.

### CRITICAL — Blocks Core Claims

**~~F1: Claude must run inside a tmux pane.~~** RESOLVED — Decision #23: Claude runs inside tmux. Updated in spec.

**~~F4: Mid-work state not saved until Algorithm LEARN phase.~~** RESOLVED — Decision #24: PRD as write-ahead log. ISC written to disk immediately on creation/update. StateSnapshot triggers on TaskCreate/TaskUpdate + voice curls. Session death at any point loses nothing.

**F13: Windmill down = all SaaS integrations offline.**
Every stored-credential service (SDP, GitHub, Slack, future SaaS) routes through Windmill. Windmill crash = complete SaaS blackout. Standalone MCP servers (AWS, Steampipe) survive, but the credential layer doesn't.
**Fix:** Docker Compose `restart: always` + healthcheck. Consider: Windmill health check in SessionStart dashboard. Proactive alert (Windmill cron that pings itself — if the cron stops, the alert stops, someone notices).

**~~G1: ReadOnly→ReadWrite escalation UX undefined.~~** RESOLVED — Decision #27: PAI auto-escalates to ReadWrite, SecurityValidator hook confirms all write API calls with details. Two layers.

**~~G2: Messaging gateway can't approve destructive operations.~~** RESOLVED — Decision #28: Windmill approval flows. `claude -p` queues destructive actions, Seth approves from Slack or Windmill UI.

### HIGH — Daily Annoyances

**F2: State only captured during Algorithm runs.**
If Seth does 30 minutes of informal work (no Algorithm), current-work.json isn't updated. Next session dashboard shows stale data.
**Fix:** Broader StateSnapshot triggers — not just voice curls. Could trigger on any significant Bash command, or on a timer (if possible), or on session exit.

**~~F5: No emergency mode for incidents.~~** INVALID — Existing effort levels (Instant <10s, Fast <1min) already handle urgency. Incidents need MORE structure, not less — ISC ensures the fix is verified, LEARN captures data while fresh. The Algorithm's existing compression handles emergencies without a special mode.

**F6: Error messages through MCP→Windmill→API chain are opaque.**
SDP returns 401. By the time it reaches Claude through three layers, error context is lost.
**Fix:** McpLogger PostToolUse hook should capture and surface error details. Windmill scripts should propagate structured errors (not just "failed"). Define error contract.

**F7: Credential failure recovery has no UX.**
OAuth token expires, auto-refresh fails. Now what? Seth needs to go to Windmill UI → find resource → re-auth. Major context switch.
**Fix:** Define the recovery path in the spec. At minimum: PAI detects auth failure → tells Seth exactly what to do ("SDP OAuth expired. Run: `windmill resource refresh sdp-oauth` or re-authenticate at https://windmill.local/resources/sdp").

**~~F11: Adding new integrations requires leaving the terminal.~~** RESOLVED — Decision #29: `wmill` CLI from terminal. PAI writes the TypeScript + pushes via `wmill`. Browser only for one-time OAuth redirects.

**F15: `claude --resume` shows session IDs, not workstream names.**
Session picker is timestamps and IDs. Seth has to guess which was the SDP ticket.
**Fix:** This is a Claude Code upstream limitation. PAI can work around it: `pai work` CLI (Layer 3) maps workstream names to session IDs. Until built, document the friction honestly.

**S1: First Steampipe multi-account query: 10-30 seconds cold.**
10+ AssumeRole calls before data flows on first query.
**Fix:** Add Steampipe warm-up to SessionStart: `steampipe service start` + a cheap query to prime connections. Or: Steampipe runs as a persistent service (not per-query).

### MEDIUM — Occasional or Scalability Concerns

**F3:** current-work.json write conflicts between parallel agents. Fix: atomic writes (write to temp, rename) or simple file lock.

**F8:** 24h credential sync is too slow for urgent rotations. Fix: Add manual sync command (`pai sync-creds`) alongside the daily cron.

**F9:** Background agent completion notification easy to miss. Fix: Voice notification curl when agent completes. Already have the voice server.

**F10:** Parallel agents writing same PRD. Fix: agents write to separate files, foreground reconciles. Or: agent only updates its own ISC criteria, not the full PRD.

**F12:** MCP tool discovery after new Windmill scripts unclear. Fix: document whether Windmill MCP server auto-discovers new scripts or needs restart.

**F14:** No Windmill health monitoring. Fix: Docker healthcheck + Windmill cron self-ping + dashboard indicator.

**F16:** No auto PRD reload on session resume. Fix: part of `pai work` (Layer 3). Until then, SessionStart hook enhancement.

**F17:** Ambiguous workstream names. Fix: current-work.json stores exact PRD path. Disambiguation uses path, not name.

**F18:** No workstream archiving. Fix: `pai archive <workstream>` moves PRD to MEMORY/ARCHIVE/, removes from current-work.json.

**S2:** No Steampipe warm-up. Fix: covered in S1.

**S3:** PRD sprawl slows CONTEXT RECOVERY. Fix: archiving (F18) + CONTEXT RECOVERY searches active PRDs first (current-work.json), then archive only if no match.

**S4:** Stale workstreams in dashboard. Fix: TTL on current-work.json entries (e.g., 7 days inactive → auto-archive or flag as stale).

**G3:** No API rate limiting for agent swarms. Fix: PAI should limit concurrent agents hitting same API. Or: Steampipe's built-in rate limiting is sufficient for read-only. Write operations already go through approval.

### Unaddressed Design Questions (New)

1. ~~**Does Claude run inside tmux or not?**~~ — RESOLVED: Yes. Decision #23.
2. ~~**What is the emergency/triage mode?**~~ — RESOLVED: Not needed. Existing effort levels (Instant/Fast) handle urgency. Incidents need MORE structure, not less.
3. ~~**What is the ReadWrite escalation model?**~~ — RESOLVED: PAI auto-escalates + SecurityValidator hook confirms. Decision #27.
4. ~~**What does the messaging gateway do with destructive requests?**~~ — RESOLVED: Windmill approval flows. Decision #28.
5. ~~**How are new Windmill integrations built — terminal or browser?**~~ — RESOLVED: `wmill` CLI from terminal, browser only for OAuth redirects. Decision #29.
