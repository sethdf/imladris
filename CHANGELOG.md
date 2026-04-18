## v2.8.3 (2026-04-18)

### Fixes
- as_user helper for root execution + mosh replaces ET

## v2.8.2 (2026-04-18)

### Fixes
- Bun install on Ubuntu + install-settings graceful fallback

## v2.8.1 (2026-04-18)

### Fixes
- handle root execution on Ubuntu — Bun HOME, npm for Claude, ET package

## v2.8.0 (2026-04-18)

### Features
- Ubuntu 24.04 + Eternal Terminal + hardened deploy.sh

## v2.7.3 (2026-04-18)

### Fixes
- add tmux + mosh install and auto-attach on SSH

## v2.7.2 (2026-04-18)

### Fixes
- install Docker Compose from GitHub releases on AL2023

### Infrastructure
- chore: remove auto-clone of PAI upstream from install-deps

## v2.7.1 (2026-04-18)

### Fixes
- test conventional commit hook

## v2.7.0 (2026-04-18)

### Features
- auto-release from conventional commits

### Infrastructure
- chore: move finops CFN templates to sethdf/finops repo

# Changelog

All notable changes to imladris are documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: `MAJOR.MINOR.PATCH` — MINOR = spec ships, PATCH = operational fix or small additive
v2 = current EC2-based running system. v3 reserved for future comprehensive modular redesign.

---

## [Unreleased]

Operational monitoring and tuning in progress:
- Investigation quality monitoring (reviewing agentic_investigator output accuracy)
- Auto-dismiss rule tuning based on observed false positive rate

---

## [2.1.0] — 2026-04-06 ✅

### Added
- `f/core/batch_triage_slack_schedule.schedule.yaml`: Slack triage now runs every 30 min
  (script was deployed but never scheduled — no Slack items were reaching triage cache)
- `f/core/batch_triage_emails_schedule.schedule.yaml`: Email triage now runs every 15 min
  with `days_back=1` (was never scheduled — triage cache was 111h stale)
- `f/domains/work/sources/batch_triage_sdp_schedule.schedule.yaml`: SDP triage now runs
  every 15 min (script was deployed but never scheduled)
- `windmill/f/imladris/status_check.ts`: Health dashboard script — box health + data source
  checks in quick/full/datasources modes. Already deployed prior to this release.
- `status-dashboard/server.ts` + `index.html`: Bun HTTP server on :3100 with triage queue
  API, bulk actions, Windmill proxy with server-side auth injection. Already deployed.
- Tailscale Serve: `/status → :3100` and `/` → Windmill on :8000 at
  `https://imladris-4.dzo-musical.ts.net`

### Fixed
- Deleted 5 duplicate `f/devops/` schedules that were double-running against `f/core/` scripts
  (activity_report, batch_triage_telegram, contextual_surface, feed_collector,
  investigation_accuracy_digest)
- Deleted broken `f/devops/cross_correlate_schedule` (pointed to non-existent
  `f/devops/cross_correlate`; correct schedule is `f/core/correlate_triage_schedule`)

---

## [2.0.2] — 2026-04-03 ✅

### Fixed
- `sync-credentials.sh`: Replaced `wmill variable create/update` CLI calls (removed in wmill
  v1.645.0) with direct REST API calls. All 730+ BWS secrets now sync correctly to Windmill
  variables. The credential chain (BWS → Windmill → SDP OAuth) was broken at this step.
- SDP OAuth token restored: Triggered `refresh_sdp_token` to fetch fresh Zoho token after
  sync was restored. SDP API calls now succeed.

### Added
- `~/.claude/hooks/SDPWorkSync.hook.ts`: UserPromptSubmit hook that auto-creates SDP tasks
  for adhoc PAI work sessions. Fires after AutoWorkCreation, reads
  `current-work-{session_id}.json`, deduplicates via `sdp-sync-{session_id}.json`, triggers
  Windmill `f/domains/work/actions/create_task` fire-and-forget. Exits 0 on any error.
- `~/.claude/settings.json`: SDPWorkSync added to UserPromptSubmit hooks after AutoWorkCreation.
- Windmill variables `f/devops/sdp_base_url` and `f/devops/sdp_api_key` confirmed populated via BWS sync.

---

## [2.0.1] — 2026-04-03 ✅

### Fixed
- `windmill/wmill.yaml`: `nonDottedPaths: true` → `false`. The `true` setting caused `wmill sync`
  to look for `*__flow/` directories; our flows use `*.flow/` format. All flows were silently
  skipped during sync.
- Deleted orphan flat file `windmill/f/core/triage_flow.flow.yaml` (conflicted with
  `triage_flow.flow/` directory).
- Ran `wmill sync pull` after explicit flow pushes to align local format with Windmill's
  inline script expansion (`!inline *.ts` + separate `.inline_script.ts` files). Subsequent
  `wmill sync push --dry-run` shows 0 drift.

---

## [2.0.0] — 2026-04-01 ✅ Baseline Tag

Initial versioned baseline. Captures the full deployed pipeline as of first version tagging.

### Platform
- Windmill 1.x running on EC2 (BuxtonIT account 767448074758) with 2 Docker containers × 4 workers
- SQLite triage cache at `/local/cache/triage/index.db` (NVMe, ephemeral by design)
- Tailscale overlay network; MCP server at `f/core/mcp_server.ts`
- AWS Bedrock integration: Haiku (triage), Sonnet (investigation), Opus (deep investigation)
- Bitwarden Secrets Manager as source of truth for all credentials
- Ansible-managed OS configuration

### Triage Pipeline (`f/devops/`)
- `process_actionable.ts`: 3-phase pipeline (INVESTIGATE → CREATE → ESCALATE)
- `agentic_investigator.ts`: Multi-round tool-use investigation using Bedrock Converse API;
  16+ read-only investigation tools; structured output (severity, confidence, root_cause,
  evidence, criteria_status)
- `batch_triage_emails.ts`: M365 Graph API email ingestion
- `batch_triage_slack.ts`: Slack thread-as-unit ingestion (thread replies concatenated)
- `batch_triage_sdp.ts`: SDP requests + tasks ingestion; SDP-native items marked `sdp-native`
- `batch_triage_telegram.ts`: Telegram alert ingestion
- `cache_lib.ts`: Cross-source dedup by exact subject match; SQLite persistence
- `correlate_triage.ts`: Cross-source correlation
- `trend_engine.ts`: Time-series trend storage (partial implementation)

### Output & Reporting
- Rich HTML formatting for all SDP output (tables, severity badges, inline CSS)
- SDP task creation: `**` prefix on AI-created tasks for visual differentiation
- SDP comment posting: investigation results → notes (requests) + worklogs (tasks)
- `sdp_morning_summary.ts`: Daily SDP digest
- `activity_report.ts`: Activity reporting
- Auto-dismiss daily summary for known low-priority patterns (Site24x7 up alerts, etc.)

### Memory & Intelligence
- `memory_embed_flow`: Embeds PAI MEMORY files into vector store; scheduled nightly at 2am PT
- `knowledge_store.ts`, `memory_embed_planner.ts`, `memory_embed_worker.ts`: Memory embedding stack
- `contextual_surface.ts`: Contextual surfacing scaffold (partial — Phase 3b target)
- `entity_extract.ts`: Entity extraction scaffold (partial — Phase 3a target)
- `triage_feedback.ts`: Triage feedback scaffold (partial — Phase 3a target)

### Feeds & Schedules
- `feed_collector.ts`: RSS/Atom feed ingestion; scheduled
- `investigation_accuracy_digest.ts`: Investigation quality digest

### PAI Integration (additive, in `imladris/pai-config/`)
- Custom hooks: AutoWorkCreation, SDPWorkSync (added v2.0.2), various session management hooks
- Windmill action scripts for SDP, Slack, M365 callable from PAI sessions

---

## [2.1.0] — SHIPPED 2026-04-06: Phase 0a — Status Dashboard + Triage Schedules

**Spec:** `docs-site/docs/specs/status-dashboard.md`
**Dependency:** None. Ships from current `f/devops/` landing area.

### Added
- `status-dashboard/server.ts`: Node.js/Bun HTTP server exposing `/status` dashboard endpoint
- Tailscale Serve configuration: `/status` reachable via Tailscale hostname (no public exposure)
- Dashboard sections: box health (CPU, memory, disk), credential freshness (BWS sync age,
  SDP token TTL), Windmill schedule health (last run, last success per schedule), worker slot
  utilization
- `f/devops/batch_triage_slack_schedule.schedule.yaml`: Wire up Slack ingestion cron (schedule
  was missing despite script being deployed)

---

## [2.2.0] — SHIPPED (pre-2.1.0): Phase 0b — Investigate-First Pipeline

**Spec:** `docs-site/docs/specs/investigate-first-pipeline.md`
**Dependency:** None. Lands in current `f/devops/` (path rename to `f/core/` in v2.3.0).

### Changed
- `process_actionable.ts`: Rewritten to enforce investigation-first ordering. No SDP task
  created until investigation completes and confirms actionability. Prevents low-signal task
  spam.
- Investigation result determines create/escalate/dismiss decision (not triage classifier alone)
- Additive schema additions to `cache_lib.ts` for investigation-linked triage records

### Added
- SDP request/incident auto-creation from high-severity investigation findings (not just tasks)
- Cognitive architecture doc fixes (`docs-site/`): "Docusaurus site" → "this docs site";
  Part XI gap status updated (items #5-8 addressed by docker-modular spec)
- Deprecate `auto_triage.ts` + `cross_correlate.ts` stubs (remove confusion)

---

## [2.2.1] — PLANNED: Triage GUI (Status Dashboard tab)

**Depends on:** v2.2.0 (investigate-first-pipeline data model stable)
**Feature spec:** `memory/feature_status_triage_gui.md`

### Added
- New "Triage" tab in `/status` dashboard: mass-select batch processing of pending triage items
- Backend: query endpoint serving current triage queue from SQLite cache
- UI: checkboxes + select-all, batch actions (dismiss, escalate, assign, investigate, create ticket)
- Calls existing Windmill action endpoints for bulk operations
- Generalizes across all triage sources (not email-specific)

---

## [2.3.0] — PLANNED: Phase 1a — Domain-Modular Directory Reorg

**Spec:** `docs-site/docs/specs/modularization.md`
**Dependency:** Phase 0 complete (nothing moved mid-flight)

### Changed
- Windmill directory restructure: `f/devops/` → `f/core/` (pipeline) + `f/domains/work/`
  (work-specific actions) + `f/shared/` (cross-domain utilities)
- All `.script.yaml` path metadata regenerated after rename
- Schedules verified against new paths after migration
- Time-boxed: directory rename + wmill sync + schedule verification, not a logic rebuild

### Added
- `f/core/`: Domain-agnostic pipeline scripts (process_actionable, agentic_investigator,
  batch_triage_*, cache_lib, trend_engine, etc.)
- `f/domains/work/`: Work-domain-specific scripts (SDP integration, M365, activity reports)
- `f/shared/`: Cross-domain utilities (bedrock.ts, telegram utilities, etc.)
- `f/infra/`: Infrastructure scripts (status queries, health checks)

---

## [2.4.0] — SHIPPED 2026-04-06: Phase 1b — Docker-Modular (PAI Containerization)

**Spec:** `docs-site/docs/specs/docker-modular.md`
**Dependency:** Phase 1a complete (clean box architecture before adding moving parts)

### Added
- `docker/pai/Dockerfile`: PAI container image — node:20-slim + tmux + bun + claude-code +
  inotify-tools + rsync. Built to `ghcr.io/sethdf/imladris/pai:latest` via GitHub Actions.
- `docker/pai/entrypoint.sh`: tmux session entrypoint (attach existing or new-session)
- `.github/workflows/build-pai-image.yml`: CI builds and pushes on `docker/pai/**` changes
- `scripts/pai-session`: Docker session manager shell script — start/attach/list/stop/destroy
  commands. BWS secrets fetched at start time, injected via env-file, cleaned up after run.
- `scripts/setup-pai-volumes.sh`: One-time volume initialization — creates `pai-config` and
  `pai-memory` volumes, populates from current `~/.claude/` on host.
- Named Docker volumes: `pai-config` (ro in containers), `pai-memory` (rw), `pai-session-{name}`
  (exclusive per-session workspace). All persist across container stop/reboot.
- `ansible/roles/workstation/tasks/pai-docker.yml`: Ansible tasks — symlink `pai-session` and
  `setup-pai-volumes` to PATH, deploy `pai-session-resume.service` systemd unit, deploy
  `/etc/cron.d/pai-prune` orphan cleanup cron.
- `pai-session-resume.service`: systemd unit auto-starts all stopped pai-* containers on boot.
- `/etc/cron.d/pai-prune`: daily 4am prune of exited PAI containers older than 24h.

### Changed
- `docker-compose.yml`: `~/.claude` mount changed from `:rw` to `:ro` in Windmill worker
  containers (Phase 0 security fix — closes prompt injection write vector).
- Rollback path: `docker stop pai-default` + run `claude` on host directly. No Ansible rollback
  needed — host Claude Code install untouched.

### Not changed (deferred to later phase)
- Ansible role collapse (16 → 5 roles): deferred until container path stable through host reboot
- MCP servers and voice-server containerization: Phase 2
- Inbox/outbox filesystem queue: Phase 2

---

## [2.5.1] — SHIPPED 2026-04-07: Fix pai-memory volume on NVMe (wrong persistence tier) ✅ Current

### Fixed
- `scripts/pai-session`: `pai-memory` Docker named volume (on NVMe instance store — ephemeral)
  replaced with host bind mount at `/pai/memory` (EBS root volume — survives stop/start).
  Previously, MEMORY files would be lost on every instance stop/start because Docker's
  data-root is at `/local/docker` (NVMe). This is the correct persistence tier for MEMORY.
- `scripts/setup-pai-volumes.sh`: Creates `/pai/memory` host directory instead of `pai-memory`
  Docker volume. Includes auto-migration from existing `pai-memory` volume if present and
  `/pai/memory` is empty. Falls back to populating from `~/.claude/MEMORY/`.
- `ansible/roles/workstation/tasks/pai-sync.yml`: Added `/pai/memory` directory creation,
  volume migration step, and initial population from `~/.claude/MEMORY/` as prerequisite
  tasks (runs before daemon build/deploy steps).

---

## [2.5.0] — SHIPPED 2026-04-06: Phase 2a — PAI Memory Sync (Postgres)

**Spec:** `docs-site/docs/specs/memory-sync.md` (v4.1)
**Dependency:** Phase 1b (Docker-Modular, v2.4.0)

### Added
- `sql/schemas/core.sql`: Idempotent DDL for `core` schema — `memory_objects`,
  `memory_object_versions`, `memory_lines`, `sessions`, `compaction_checkpoints`.
  Includes auto-archive trigger for full version history. Safe to re-run.
- `scripts/pai-sync/daemon.ts`: Host-side inotify daemon watching `/pai/memory` bind mount.
  Spawns `inotifywait`, routes events to SyncEngine. systemd watchdog-compatible.
- `scripts/pai-sync/SyncEngine.ts`: Debounce (5s quiet / 30s max-wait), WAL management,
  push/pull orchestration, status diff, WAL replay on startup.
- `scripts/pai-sync/adapters/PostgresAdapter.ts`: pg driver implementation — `putFile`,
  `getFile`, `getFileHistory`, `putLines`, `getLines`, soft-delete, restore.
- `scripts/pai-sync/cli.ts`: `pai-sync` CLI binary — push/pull/status/history/restore/diff/
  backfill/daemon commands.
- `scripts/pai-sync/backfill.ts`: Initial bulk upload — newest-first, batch 200, progress
  tracking in `STATE/sync-backfill.jsonl`, skips files already in Postgres.
- `scripts/pai-sync/metadata-extractor.ts`: Deterministic metadata extraction — YAML
  frontmatter, JSON parsing, JSONL first-line sampling. No inference.
- `scripts/pai-sync/compression.ts`: gzip + base64 for files >100KB, chunking for >50MB.
- `scripts/pai-sync/syncignore.ts`: Exclude list — `STATE/`, `*.tmp`, `*.lock`.
- `scripts/pai-sync/config.ts`: All config from env vars (watch root, machine ID, debounce).
- `scripts/pai-sync/package.json`: Bun project — `pg` + `yaml` deps, build scripts for
  compiled arm64 binaries.
- `ansible/roles/workstation/tasks/pai-sync.yml`: Rewritten to match v2.5.0 architecture —
  builds compiled binaries to `/usr/local/bin/`, creates `pai_memory` Postgres DB, applies
  `sql/schemas/core.sql`, writes `/etc/pai-sync/env` (640, root:ec2-user), deploys system
  systemd unit (`/etc/systemd/system/pai-sync.service`).
- `ansible/group_vars/imladris.yml`: Added `inotify-tools` to system_packages; added
  `pai_sync_*` configuration variables.

### Architecture
- Watch root: `/pai/memory` (host directory on EBS, bind-mounted into containers)
- Only `pai-memory` contents synced — `pai-config` is in git, no sync needed
- WAL at `/pai/memory/STATE/sync-wal.jsonl` (fsync'd per event, zero data loss)
- JSONL files synced at line level (SHA-256 dedup, union across machines)
- Non-JSONL files synced at file level with full version history in Postgres
- System-level systemd service (not user service) — survives session container lifecycle

### Operational
- Run `pai-sync backfill` once after deploy to load existing MEMORY files
- `pai-sync status` shows local/remote diff
- `pai-sync history <key>` shows all versions of a file
- Daemon start/stop via `pai-sync daemon start|stop|status` or `systemctl`

---

## [2.6.0] — PLANNED: Phase 2b — Multi-Schema Postgres + Hive Collective

**Spec:** `docs-site/docs/specs/postgres-multi-schema.md`
**Dependency:** Phase 2a (Postgres running with base schema)

### Added
- Four Postgres schemas: `core` (pipeline data), `work` (work-domain entities), `personal`
  (personal domain), `shared` (cross-schema promoted entities)
- SQLite → Postgres triage sync: triage cache data flows into `core` schema
- PreCompact hook: direct Postgres write on compaction for zero-loss compaction protection
- Hive logical replication: multi-instance imladris sharing `shared` schema over Tailscale
- `shared` schema graduation mechanism: explicit promotion, not automatic

---

## [2.6.1] — PLANNED: PAI Session Log Viewer (Status Dashboard tab)

**Depends on:** v2.6.0 (Postgres with core schema for queryable hook log rows)
**Feature spec:** `memory/project_pai_session_log_viewer.md`

### Added
- New "Sessions" tab in `/status` dashboard: visual timeline of PAI session activity
- Shows per-session: hooks fired (UserPromptSubmit, PostToolUse, PreCompact, etc.),
  Algorithm phases active (OBSERVE → LEARN), guardrails triggered
- Readable at a glance — not raw JSON; Algorithm phase badges, hook timeline
- Backend: Postgres query over hook event rows synced from PAI containers

---

## [2.7.0] — PLANNED: Phase 2c — Personal Domain Pack (Telegram-first)

**Dependency:** Phase 1a (personal domain has a home), Phase 2a (richer querying preferred)

### Added
- Personal Telegram ingestion: ingest personal Telegram messages into triage cache
  (scoped — explicit conversations only, no ambient expansion)
- `f/domains/personal/` directory: personal-domain scripts isolated from work domain
- Telegram ingestion boundary defined explicitly in `f/domains/personal/telegram_personal.ts`
- Existing `f/shared/telegram_*.ts` utilities reused for ingestion

---

## [2.7.1] — PLANNED: Parking Finder (Personal Utility)

**Spec:** `docs-site/docs/specs/parking-finder.md`
**Prototype:** working code tested 2026-04-01 using SpotParking public API

### Added
- `f/domains/personal/parking_finder.ts`: Queries City of Colorado Springs parking system
  (SpotParking API) for closest free spots near Epicentral Coworking (220 E Pikes Peak Ave)
- Optional Windmill cron: check parking availability on a schedule
- No authentication required (public API)

---

## [2.8.0] — PLANNED: Phase 3a — Entity Extraction + Triage Feedback Loop

**Dependency:** Phase 2a (Postgres for entity store), `trend_engine.ts` stable

### Added
- Entity extraction automation: automated tagging of triage results with extracted entities
  (people, systems, projects, IPs, AWS accounts)
- Triage feedback loop: record acted-on / deferred / dismissed decisions per entity
- Quality calibration: triage quality score per entity type (high-signal vs. noise entities)
- Closes cognitive-architecture.md Part XI gaps: entity extraction (#5) + feedback loop (#6)

---

## [2.9.0] — PLANNED: Phase 3b — Contextual Surfacing (Full)

**Dependency:** Phase 3a (entity extraction + feedback loop providing confidence signal)

### Added
- Proactive contextual surfacing: surface relevant prior investigations, entities, and trends
  into active PAI workstreams
- Gate: only activates when feedback loop has accumulated sufficient signal (confidence threshold)
- Starts conservative; expands based on observed accuracy
- Closes cognitive-architecture.md Part XI gap: contextual surfacing (#7)
- Completes `contextual_surface.ts` partial implementation

---

## Version History Summary

| Version | Type | Description | Status |
|---------|------|-------------|--------|
| 2.0.0 | Baseline | Full triage pipeline, multi-source ingestion, HTML output | ✅ |
| 2.0.1 | Patch | Windmill flows sync fix (nonDottedPaths) | ✅ |
| 2.0.2 | Patch | BWS sync REST fix + SDPWorkSync hook | ✅ |
| 2.1.0 | Minor | Status Dashboard + all triage schedules wired up + process_actionable schedule | ✅ |
| 2.2.0 | Minor | Investigate-First Pipeline (already shipped pre-v2.1.0) | ✅ |
| 2.2.1 | Patch | Triage GUI (status dashboard tab) | ✅ |
| 2.3.0 | Minor | Domain-Modular directory reorg | ✅ |
| 2.4.0 | Minor | Docker-Modular / PAI containerization | ✅ Current |
| 2.5.0 | Minor | PAI Memory Sync / Postgres + AGE + pgvector | Planned |
| 2.6.0 | Minor | Multi-Schema Postgres + Hive Collective | Planned |
| 2.6.1 | Patch | PAI Session Log Viewer | Planned |
| 2.7.0 | Minor | Personal Domain Pack: Telegram-first | Planned |
| 2.7.1 | Patch | Parking Finder utility | Planned |
| 2.8.0 | Minor | Entity Extraction + Triage Feedback Loop | Planned |
| 2.9.0 | Minor | Contextual Surfacing (full) | Planned |

v3.0.0 reserved for future comprehensive modular redesign (separate spec required).
