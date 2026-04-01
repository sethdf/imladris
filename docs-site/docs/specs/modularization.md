---
sidebar_position: 6
---

# Domain-Modular Architecture

## Context

Imladris was built entirely for one person's DevOps/cloud engineer work role. The platform core — the triage pipeline, investigation engine, AI inference, cache, and MCP server — is domain-agnostic. The coupling to Seth's specific work context lives at two seams: **data source integrations** (what you ingest from) and **action targets** (what you do with findings). Separating these enables:

1. A personal life domain alongside the work domain
2. Others adopting the platform for entirely different contexts
3. Cleaner maintenance — domain changes don't touch the pipeline

## First Principles Finding

The 4-function pipeline is invariant regardless of domain:

```
INGEST → CLASSIFY/CORRELATE → SURFACE → ACT
```

Domain context enters only at:
- **Ingest sources** — which external systems you pull signals from
- **Action targets** — which ticketing, messaging, or logging systems receive output

Everything else (`cache_lib`, `bedrock`, `triage_pipeline`, `process_actionable`, `agentic_investigator`, `mcp_server`, `approval_flow`, `trend_engine`, `triage_feedback`) is platform infrastructure that works the same regardless of domain.

## Proposed Directory Structure

```
windmill/f/
  core/                           ← Domain-agnostic pipeline (never domain-specific)
    cache_lib.ts                   # SQLite cache, FTS, entity index
    bedrock.ts                     # Bedrock AI inference wrapper
    triage_pipeline.ts             # Single-item classify → correlate → propose
    process_actionable.ts          # Three-phase: INVESTIGATE → CREATE → ESCALATE
    agentic_investigator.ts        # Bedrock Converse tool-use investigation engine
    mcp_server.ts                  # MCP interface for Claude sessions
    batch_triage_emails.ts         # Email intake pipeline
    batch_triage_slack.ts          # Slack intake pipeline
    batch_triage_telegram.ts       # Telegram intake pipeline
    approval_flow.ts               # Human gate for destructive operations
    trend_engine.ts                # Time-series trend detection
    triage_feedback.ts             # Quality measurement + calibration
    contextual_surface.ts          # Proactive context injection into workstreams
    response_playbook.ts           # Approved remediation execution
    activity_report.ts             # Activity log → readable report
    reingest_dismissed.ts          # Re-queue dismissed items
    catchup_lib.ts                 # Cron catchup logic library
    entity_extract.ts              # Entity extraction + enrichment library
    knowledge_store.ts             # Entity-relationship persistence
    correlate_triage.ts            # Cross-source correlation
    feed_collector.ts              # RSS/CVE/feed ingestion

  domains/
    work/
      sources/                     ← What to INGEST for work domain
        aws_helper.ts
        get_aws_resources.ts
        get_azure_devices.ts
        get_azure_sign_ins.ts
        get_azure_users.ts
        cloudflare_*.ts
        sophos_*.ts
        signoz_*.ts
        aikido_*.ts
        steampipe_helper.ts
        query_steampipe.ts
        query_resources.ts
        get_sdp_tickets.ts
        get_security_events.ts     # Securonix
        get_monitoring_alerts.ts   # Site24x7
        get_security_groups.ts
        batch_triage_sdp.ts        # SDP-specific intake
        check_network.ts
        compliance_scan.ts
        cost_report.ts
      actions/                     ← What to DO for work domain
        add_note.ts
        close_ticket.ts
        create_ticket.ts
        create_task.ts
        sdp_morning_summary.ts
        sdp_aws_correlate.ts
        tag_triage_emails.ts
        mark_alerts_read.ts
        investigate_sdp_tickets.ts
        audit_investigation_coverage.ts
      infra/                       ← Token refresh + work-domain ops
        refresh_sdp_token.ts
        refresh_site24x7_token.ts
        query_vendors.ts

    personal/                      ← First slice: Telegram + personal email + RSS
      sources/                     ← TBD — see Personal Domain Pack spec
      actions/                     ← TBD
      infra/                       ← TBD

  shared/                         ← Usable by any domain
    slack_post_message.ts
    slack_helper.ts
    slack_list_channels.ts
    slack_read_channel.ts
    slack_read_thread.ts
    slack_search.ts
    slack_user_info.ts
    telegram_helper.ts
    telegram_list_chats.ts
    telegram_read_messages.ts
    list_emails.ts
    list_calendar.ts
    list_tickets.ts
    upstream_updates.ts
    context7_query_docs.ts
    context7_resolve_library.ts
    load_domain_knowledge.ts
    triage_overview.ts
    query_cache.ts
    search_alert_history.ts

  infra/                          ← Platform-level box operations (not domain logic)
    monitor_worker_health.ts
    parse_windmill_logs.ts
    status_check.ts
    manage_credentials.ts
    build_investigation_tool.ts
    discover_resources.ts
    slack_post_message.ts         # Shared, but also used as infra alerting
```

### Deprecated (safe to delete)
- `auto_triage.ts` — superseded by `batch_triage_*` + `agentic_investigator.ts`
- `cross_correlate.ts` — superseded by `cache_lib.ts` + `investigate.ts`

## Domain Pack Convention

A domain pack is a **directory under `domains/`** containing three subdirectories:

| Subdirectory | Purpose |
|---|---|
| `sources/` | Scripts that pull data from external systems into the cache |
| `actions/` | Scripts that create tasks, post messages, or trigger remediations |
| `infra/` | Token refresh scripts and domain-specific maintenance ops |

Each pack also has:
- `README.md` — what this domain does, credential requirements, setup steps
- `credentials.md` — which BWS secret keys are required
- `schedules/` — schedule YAML files for this domain's cron jobs

The pipeline core never imports from domain packs directly. Domain packs register their intake sources by calling standard `cache_lib` functions — the coupling is data-model, not code import.

## What "Platform Core" Means for a New User

The minimum viable imladris (no domain-specific content) requires:

| Component | What it does |
|---|---|
| `core/*.ts` pipeline scripts | The 4-function loop |
| Windmill + Postgres | Automation engine + job database |
| SQLite cache on fast storage | Triage results store |
| Bedrock (or alternative LLM endpoint) | Classification + investigation |
| One MCP-connected Claude session | Human interface |

A new user then adds **exactly one domain pack** to make it useful. No domain pack is bundled in core — instead, a **synthetic demo mode** (clearly labeled fake data) can be activated to show what a populated pipeline looks like before any real credentials are configured.

## Onboarding Path for a New User

1. **Install platform core** — Windmill + Postgres + SQLite + `core/*.ts` scripts
2. **Run synthetic demo** — see what a populated triage dashboard looks like
3. **Choose a domain pack** — work domain (if DevOps/cloud) or personal domain (if starting with personal life use case)
4. **Configure credentials** — follow `domains/{pack}/credentials.md`
5. **Enable schedules** — activate cron jobs for chosen pack's intake sources
6. **Verify pipeline** — run a manual triage cycle, confirm MCP tool connectivity

## Implementation Notes

- The rename from `f/devops/` and `f/investigate/` to the new structure is a **Windmill path migration** — scripts must be updated in Windmill after moving, not just at the git level
- Windmill script paths are stored in `.script.yaml` files — these must be regenerated after the move
- Migration can be done incrementally: start by creating the new top-level folders and moving one domain at a time
- The `batch_triage_sdp.ts` script is the only intake script that's domain-specific (goes to `domains/work/sources/`) — all other `batch_triage_*` are platform core

## Files to Create

| File | Purpose |
|---|---|
| `windmill/f/core/` | New core folder (scripts moved in) |
| `windmill/f/domains/work/` | Work domain pack |
| `windmill/f/domains/personal/` | Personal domain pack (initial stub) |
| `windmill/f/shared/` | Shared scripts usable by any domain |
| `windmill/f/infra/` | Platform infrastructure ops |
| `windmill/f/domains/work/README.md` | Work domain setup guide |
| `windmill/f/domains/work/credentials.md` | Required BWS secret keys |

## Verification

1. Every script categorized to exactly one folder — no ambiguous placement
2. `core/` scripts have zero imports from `domains/` — dependency direction is one-way
3. Work domain pack fully functional after migration (existing schedules + integrations unchanged)
4. Personal domain stub deployable (empty sources/actions/infra, README documents what will go there)
5. `wmill sync push` succeeds after migration
6. Existing triage pipeline completes a full cycle after migration
