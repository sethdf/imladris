# Imladris 2.0 Spec — Capabilities Review

> Review of the capabilities defined in the spec on branch `claude/clone-public-repo-YthIn`, assessing feasibility, completeness, and risk for each major capability area.

---

## Executive Summary

The spec describes a comprehensive personal cloud workstation with 8 major capability areas: Workspaces, Datahub/Intake, Triage, Authentication, Commands/Skills, Sync, Windmill orchestration, and Mobile Access. The design principles are strong and well-articulated. The architecture is sound — flat files + SQLite index, thin skills routing to Windmill scripts, lazy auth via BWS. Several capabilities are already partially implemented in the current codebase (auth-keeper, intake system, tmux zones), which de-risks the overall plan.

However, the spec overreaches in several areas where it describes capabilities that would require significant new infrastructure (Windmill), introduces concepts not yet validated (bidirectional sync with write-back queues), and leaves key implementation details unspecified (triage prompts, conflict resolution edge cases, Windmill UI access).

**Overall assessment:** The spec is a strong vision document and a reasonable architecture plan. It is weakest as an implementation guide — the gap between "what" and "how" is large in several areas, particularly around Windmill integration, bidirectional sync, and the command surface area.

---

## Capability 1: Workspaces (Zone + Mode Organization)

### What's Specified

- 2 zones (work, home) × 5 modes (tasks, comms, projects, research, adhoc) = 10 workspaces
- tmux-based window management with 11 windows (window 0 = dashboard)
- Visual signaling: colors, prompt prefix, status bar
- Context save/restore on transitions via SessionStart/SessionEnd hooks
- Interstitial journaling on zone switches

### Feasibility: High

Most of this builds on existing infrastructure. The current codebase already has:
- 5-zone tmux workflow (CLAUDE.md documents it)
- `tmux-session-colors.sh` for visual signaling
- PAI hooks for session lifecycle

The jump from 5 flat zones to 2×5 zone+mode is a structural refactor, not a greenfield build.

### Gaps

| Gap | Severity | Notes |
|-----|----------|-------|
| Window lifecycle unclear | Medium | Pre-created on startup vs on-demand? If pre-created, 11 empty windows is noisy. If on-demand, switching to a non-existent window needs handling. |
| Pane management undefined | Medium | Parallel panes mentioned (`/task split`) but creation/destruction rules not specified. What happens if user creates 4 panes manually? |
| Context serialization format | Low | Hooks write to `~/.claude/history/workspaces/*.md` but the schema isn't defined. What fields? How does Claude parse it on restore? |
| Mode default questionable | Low | `/work` defaults to comms. The FEATURE-REVIEW raises this — tasks seems more natural as a default. |

### Risk Assessment

**Low risk.** This is the most mature capability area. The main risk is scope creep — adding features like auto-pause on meeting start, meeting mode, etc. Stick to the 10 workspace model and iterate.

---

## Capability 2: Datahub (Unified Intake)

### What's Specified

- Flat file storage: one markdown file per item with YAML frontmatter
- SQLite index for queries (FTS implied but not confirmed)
- Directory structure: `{zone}/{source}/{id}.md`
- Items from: email (MS365, Gmail), Slack, Telegram, Signal, calendar, SDP tickets
- Triage classification: act / keep / delete
- Bidirectional sync with write-back queue

### Feasibility: Medium-High

The current codebase already has `lib/intake/` with:
- SQLite database at `/data/.cache/intake/intake.sqlite`
- Adapters for Telegram, Signal, Slack, Email, Calendar
- CLI for sync, query, triage, stats
- Triage engine with 4 layers (Entities → Rules → Similarity → AI)

The spec proposes moving from SQLite-primary to flat-files-primary with SQLite as index. This is a philosophical shift — not just a refactor. The current system stores data in SQLite; the spec wants markdown files as the source of truth.

### Gaps

| Gap | Severity | Notes |
|-----|----------|-------|
| Migration path from current intake to datahub | High | No migration plan specified. The current intake system is SQLite-first. Moving to flat-file-first is a significant change. |
| Index rebuild mechanism | Medium | If SQLite corrupts, `datahub rebuild-index` is needed but not specified. |
| Search implementation | Medium | FTS5? Grep? Both? Matters for performance with thousands of items. |
| Binary attachments | Medium | "Stored where?" is unanswered. Email attachments can be large. |
| Scale concerns | Low | Thousands of markdown files in a directory tree. Fine for grep, potentially slow for `ls`. |

### Risk Assessment

**Medium risk.** The flat-file approach is philosophically sound (Principle 7: Plain Text Everything) but operationally unproven at this scale. The biggest risk is the migration from the existing intake system — this could break working functionality if not handled carefully.

**Recommendation:** Keep SQLite as primary store (it works today) and add flat-file export as a secondary view. Don't rewrite working code to match a philosophical preference.

---

## Capability 3: Triage (AI Classification)

### What's Specified

- Three states: act, keep, delete
- Claude-based classification via Windmill batch job every 15 minutes
- Override via `/item mark`
- Confidence score stored in metadata
- Feedback loop deferred to v2

### Feasibility: Medium

The current intake system already has a 4-layer triage engine. The spec simplifies this to Claude-only triage via Windmill. This is simultaneously simpler (one engine) and harder (requires Windmill + Bedrock API calls from Windmill context).

### Gaps

| Gap | Severity | Notes |
|-----|----------|-------|
| **Triage prompt not specified** | **High** | This is the core of the capability and it's undefined. "Use Claude to classify" is a goal, not a specification. Prompt engineering for triage is non-trivial — false positives (marking FYI as actionable) create noise; false negatives (missing actionable items) create risk. |
| Cost model | Medium | Running Claude on every incoming item every 15 minutes could be expensive. Need token estimates. Current intake uses a hybrid approach (rules + similarity + AI) to limit AI calls. |
| Batch vs streaming | Low | Batch every 15 min means a P0 item could wait 14 minutes. Is that acceptable? |

### Risk Assessment

**Medium risk.** The current triage system works. Replacing it with a Windmill-orchestrated Claude-only approach is higher-risk than iterating on what exists. The missing prompt template is a critical gap — this should be specified and tested before any implementation begins.

---

## Capability 4: Authentication (Frictionless Credentials)

### What's Specified

- BWS as single root credential store
- Bootstrap chain: LUKS → BWS → Windmill
- Lazy-loaded, auto-refreshed tokens via auth-keeper
- Cross-account AWS via STS AssumeRole
- Secret naming convention: `{zone}-{service}-{item}`

### Feasibility: High

This is largely already built. `auth-keeper.sh` is ~1800 lines and handles AWS SSO, Azure CLI, Google OAuth, MS365, Slack, Telegram, Signal, and ServiceDesk Plus. The spec correctly describes what already works.

### Gaps

| Gap | Severity | Notes |
|-----|----------|-------|
| First-time OAuth setup flows | Medium | How does a user complete initial MS365/Slack/Google OAuth? Not documented. This is a one-time event but blocks all downstream functionality. |
| Token rotation policy | Low | BWS access token rotation not specified. |
| Windmill credential sync | Medium | The spec assumes BWS secrets auto-sync to Windmill variables/resources. This mechanism isn't built yet. |

### Risk Assessment

**Low risk.** Auth is the most mature subsystem. The main new work is Windmill credential sync, which is a well-defined integration task.

---

## Capability 5: Commands / Skills Surface Area

### What's Specified

The spec defines an extensive command set:

| Category | Count | Examples |
|----------|-------|---------|
| Workspace | 3 | `/work`, `/home`, `/status` |
| Task | 11 | `/task list/show/start/switch/note/log/status/pause/done/close/create` |
| Item | 3 | `/inbox`, `/item show/mark/done` |
| Search | 1 | `/search` with filters |
| Calendar | 3 | `/calendar`, `/calendar week/add` |
| Communication | 2 | `/slack`, `/slack reply` |
| Attachment | 2 | `/attachment list/download` |
| Cloud | 2 | `/aws`, `/gcp` |
| System | 3 | `/ops status/failures/run`, `/sync status` |
| Tags | 3 | `/tag add/remove/list` |

**Total: ~33 commands**

### Feasibility: Low-Medium

This is the most ambitious part of the spec. Each command is a PAI skill that routes to a Windmill script. 33 commands means ~33 skills and ~33+ Windmill scripts to build, test, and maintain.

### Gaps

| Gap | Severity | Notes |
|-----|----------|-------|
| `/task resume` missing | High | Referenced in DAY-IN-THE-LIFE but not in the command spec. |
| `/item` vs `/task` semantics | High | Confusing overlap. The FEATURE-REVIEW flags this — "Task = SDP ticket? Item = any datahub entry?" This needs to be resolved before implementation. |
| `/slack reply` feasibility | Medium | Slackdump is read-only. How does write-back work? The spec doesn't address this. |
| `/mode` command missing | Medium | Referenced in scenarios but not in command list. |
| `/dashboard` undefined | Medium | Referenced but not specified. |
| Prioritization for build order | High | 33 commands can't all be built at once. No build order or MVP subset defined. |

### Risk Assessment

**High risk.** This is the largest surface area with the most unknowns. The command set is comprehensive as a vision but lacks an MVP definition. Building all 33 commands before validating the core workflow is a classic overengineering trap.

**Recommendation:** Define a "Week 1" command set of 5-8 commands that cover the core daily workflow from the DAY-IN-THE-LIFE doc. Something like: `/work`, `/home`, `/status`, `/task start`, `/task pause`, `/task done`, `/task note`, `/inbox`. Build and validate those before expanding.

---

## Capability 6: Bidirectional Sync

### What's Specified

- Inbound: Windmill scheduled pollers for each source
- Outbound: Write-back queue with pending/processing/completed/failed states
- Conflict resolution: external wins
- Delta sync: MS365 delta tokens, Gmail history IDs
- Sources: SDP, MS365 (email + calendar), Slack, Telegram, Signal, Google (email + calendar)

### Feasibility: Low-Medium

Inbound sync is partially built (the intake adapters exist). Outbound/bidirectional sync is entirely new and significantly more complex:

- **Reply to email from CLI** requires MS365 Graph API `POST /messages/{id}/reply` with proper threading
- **Update SDP tickets** requires the existing SDP API but with write operations
- **Slack reply** requires a mechanism beyond slackdump (which is read-only)

### Gaps

| Gap | Severity | Notes |
|-----|----------|-------|
| Write-back queue implementation | High | Queue processor with retry logic, dead-letter handling, idempotency — this is a distributed systems problem squeezed into a single-node system. |
| Slack write-back | High | slackdump can't post messages. Need Slack API with bot/user token. Not mentioned. |
| Email threading | Medium | Reply chains, CC handling, attachment forwarding — email is notoriously complex for programmatic interaction. |
| Initial sync duration | Medium | 365 days of email from multiple accounts could take hours. No progress indicator specified. |
| Partial failure states | Medium | If MS365 sync fails but Telegram succeeds, what's the system state? Pollers are independent, but dashboard needs to reflect partial status. |

### Risk Assessment

**High risk.** Bidirectional sync is the single hardest capability in the spec. Inbound polling is straightforward; outbound write-back with queuing, retries, and conflict resolution is an order of magnitude more complex. The spec treats this as a simple queue, but real-world sync systems are full of edge cases (reordering, idempotency, partial failures, rate limits).

**Recommendation:** Start with inbound-only sync. Add outbound write-back for SDP only (simplest API, most controlled environment) as a proof of concept before attempting email or Slack write-back.

---

## Capability 7: Windmill Integration

### What's Specified

- Windmill as the orchestration layer for all polling, syncing, and background jobs
- Native deployment via Nix + systemd
- TypeScript default, Python when needed
- Folder structure: `f/{module}/`
- Credential access via Windmill Variables + Resources
- Interactive pattern: get creds from Windmill, then make direct API calls
- OpenAPI codegen for scaffolding

### Feasibility: Medium

Windmill is a real product that does what's described. The risk isn't "can Windmill do this?" but "is Windmill the right tool for a single-user personal system?"

### Gaps

| Gap | Severity | Notes |
|-----|----------|-------|
| Windmill not yet deployed | High | The current system doesn't use Windmill at all. This is new infrastructure with its own learning curve, failure modes, and resource consumption. |
| Resource overhead | Medium | Windmill is a multi-service system (server, workers, database). On a 4 vCPU / 16GB instance that also runs Claude Code, Docker, Tailscale, etc., resource contention is a concern. |
| UI access | Medium | How is the Windmill web UI accessed? Via Tailscale? Port? Auth? Not specified. |
| Script versioning | Medium | How are Windmill scripts version-controlled? Are they in the git repo or only in Windmill's database? |
| Debugging | Medium | When a Windmill script fails at 3 AM, how is the user notified? How do they debug? |

### Risk Assessment

**Medium-High risk.** Windmill is a solid platform, but introducing it as a dependency for all background operations is a major architectural decision. The current system uses simpler mechanisms (cron, systemd timers, inotifywait) that are well-understood and debuggable.

**Recommendation:** Validate Windmill with a single use case (e.g., SDP polling) before migrating all background jobs to it. Keep the existing systemd-based mechanisms as fallback. Consider whether simpler tools (just cron + scripts) achieve 80% of the value for 20% of the complexity.

---

## Capability 8: Mobile Access (OpenClaw)

### What's Specified

- Multi-platform gateway: Telegram, WhatsApp, Signal as input channels
- Docker deployment
- Read-only filesystem mounts for context
- Security: ALLOWED_CHAT_IDS + API key
- Image support (multimodal)

### Feasibility: Medium-High

OpenClaw is a defined product with Docker deployment. The spec correctly scopes it as a gateway, not a full mobile client.

### Gaps

| Gap | Severity | Notes |
|-----|----------|-------|
| API cost control | Medium | Pay-per-use with no budget alerts specified. A runaway conversation could be expensive. |
| Context freshness | Low | How often does OpenClaw re-read context files? |
| MCP server exposure | Low | Which MCP servers should be available to mobile? |

### Risk Assessment

**Low risk.** This is a well-scoped optional capability. It doesn't block any core workflow and can be added incrementally.

---

## Cross-Cutting Concerns

### Complexity Budget

The spec describes a system with:
- 10 workspaces
- 33+ commands
- 7+ data source integrations
- Bidirectional sync with queuing
- Windmill orchestration layer
- Mobile gateway
- Auto-commit git workflows

For a single-user personal system maintained by one person, this is a lot of surface area. The current imladris codebase is already substantial (~15 scripts, intake system, auth-keeper, backup system). The spec roughly triples the operational surface area.

### Build vs Iterate

The biggest tension in the spec is between "design the complete system" and "iterate on what works." The current system has working intake, auth, tmux zones, and backup. The spec proposes replacing several of these with new implementations (flat-file datahub replacing SQLite intake, Windmill replacing cron/systemd, zone+mode replacing flat zones).

**Each replacement carries migration risk and provides marginal value** over the existing working system. The highest-value new capabilities (triage improvements, task context persistence, better dashboard) could be built on top of the existing infrastructure without the architectural rewrites.

### What the Spec Does Well

| Strength | Details |
|----------|---------|
| **Principles** | The 12 principles are excellent. They provide clear decision-making criteria. |
| **Boundaries** | "In scope: collector and workspace. Out of scope: outbound automation, HA, task management system." This is disciplined. |
| **Auth model** | BWS → lazy auth → auto-refresh is already proven and the spec correctly keeps it. |
| **Plain text philosophy** | Grep-friendly, version-controlled, no vendor lock-in. |
| **Day-in-the-life validation** | Walking through real scenarios exposed real gaps. More specs should do this. |
| **Self-aware gap tracking** | The FEATURE-REVIEW document honestly catalogues unknowns. |

### What the Spec Gets Wrong

| Issue | Details |
|-------|---------|
| **No MVP definition** | 33 commands, 7 sources, bidirectional sync — there's no "build this first, validate, then expand" phasing. |
| **Windmill as hard dependency** | Making a new orchestration platform a prerequisite for all background work is high-risk. |
| **Flat-file rewrite of working code** | The intake system works with SQLite. Rewriting it to flat-file-primary adds risk for philosophical satisfaction. |
| **Missing implementation details** | Triage prompt, conflict resolution edge cases, queue processor design — the hardest parts are the least specified. |
| **No resource budget** | Will all this fit on 4 vCPU / 16GB with Claude Code, Docker, Windmill, pollers, etc.? No analysis provided. |

---

## Recommended Build Order

If implementing this spec, I'd suggest the following phased approach:

### Phase 1: Core Workflow (build on existing infrastructure)

1. Zone+Mode workspace refactor (tmux, hooks, visual signaling)
2. Task context persistence (`/task pause`, `/task resume`, `/task note`)
3. Status dashboard (tmux window 0)
4. 5-8 core commands only

### Phase 2: Data & Triage Improvements

5. Improve existing intake adapters (don't rewrite to flat files)
6. Triage prompt development and testing (use existing intake, not Windmill)
7. SDP bidirectional sync (write-back for one source only)

### Phase 3: Orchestration (only if Phase 1-2 validate the model)

8. Windmill deployment and single-source validation
9. Migrate pollers to Windmill (one at a time)
10. Additional source integrations

### Phase 4: Extras

11. Mobile access (OpenClaw)
12. Additional commands beyond core set
13. Multi-source write-back (if SDP write-back proved viable)

---

## Conclusion

The spec is a thoughtful, well-structured vision for Imladris 2.0. The principles are sound, the architecture makes sense, and the self-awareness about gaps (via FEATURE-REVIEW and DAY-IN-THE-LIFE) shows design maturity.

The primary risk is trying to build the complete system at once rather than iteratively. The spec would benefit from:

1. **An MVP definition** — which 5-8 commands make the core daily workflow work?
2. **A decision on Windmill** — validate it with one use case before committing to it as the orchestration layer.
3. **Keeping what works** — the existing intake, auth-keeper, and backup systems are functional. Iterate on them rather than replacing them.
4. **Specifying the hard parts** — the triage prompt and write-back queue are the highest-value, highest-risk capabilities. They need more detail before implementation.
