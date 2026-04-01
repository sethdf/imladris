---
sidebar_position: 7
---

# Implementation Roadmap

Complete sequencing of all planned and identified work. Each item is assessed for domain-specificity, technical dependencies, and strategic position.

## Guiding Principle

> **Value is demonstrated through restraint, not coverage.** The system earns trust by doing a narrow set of things with enough precision and transparency that confidence grows faster than anxiety.

This principle drives all sequencing decisions below: do the foundational things first, resist expanding scope until the previous increment is stable and trusted.

## All Planned Work

| # | Spec | Area | Scope | Status | Blocks |
|---|------|------|-------|--------|--------|
| 0a | [Status Dashboard](./status-dashboard) | Windmill infra | Platform | Ready | Nothing |
| 0b | [Investigate-First Pipeline](./investigate-first-pipeline) | Windmill pipeline | Platform | Ready | Nothing |
| 0c | Fix cognitive-arch doc terminology | Docs | Docs | Trivial | Nothing |
| 1a | [Domain-Modular Architecture](./modularization) | Directory reorg | Platform | Design done | Personal domain, new user onboarding |
| 1b | [Docker-Modular Architecture](./docker-modular) | Infrastructure | Infra | Ready | Memory-sync (PAI containerization first) |
| 2a | [PAI Memory Sync](./memory-sync) | PAI / Postgres | Platform | Draft | Entity extraction automation, trend storage |
| 2b | Personal Domain Pack (stub) | Personal | Domain | Needs spec | Modularization reorg |
| 3a | Entity extraction + feedback loop | Intelligence | Platform | Gap/Phase 5+ | Contextual surfacing |
| 3b | Contextual surfacing (full) | Intelligence | Platform | Gap/Phase 5+ | Entity extraction |

## Phase 0 — Ship Now (no architecture changes, both already scoped)

Both specs are self-contained improvements to the existing system. Neither blocks nor is blocked by any structural work. Ship these in the next 1-2 sessions.

### 0a: Status Dashboard
- **Why now:** Operational visibility into box health, credential freshness, schedule health — immediately useful regardless of any future architecture changes
- **Domain:** Platform/infra — works in any domain structure
- **Risk:** Very low. New script + `tailscale serve` setup
- **Dependency:** None

### 0b: Investigate-First Pipeline
- **Why now:** Improves quality of existing triage output — every investigation run benefits
- **Domain:** Platform core — the 3-phase pipeline (INVESTIGATE → CREATE → ESCALATE) is domain-agnostic
- **Risk:** Low. Additive schema changes + rewrite of `process_actionable.ts`
- **Dependency:** None. Lands in current `f/devops/` — will be moved to `f/core/` in Phase 1a

**Note on 0b landing location:** Implement `process_actionable.ts` changes in the current `f/devops/` folder. The Phase 1a migration will move it to `f/core/` — this is a path rename, not a re-implementation.

### 0c: Cognitive Architecture Doc Terminology
- Fix "Docusaurus site" → "this docs site" (line 7 and section heading)
- Update Part XI gap status: items #5-8 already addressed by docker-modular spec
- Trivial — one editing session

---

## Phase 1 — Foundation (structural + infra)

These establish the structural and infrastructure foundation everything else builds on. Must complete before expanding to new domains.

### 1a: Domain-Modular Directory Reorganization
- **Why here:** Before implementing the personal domain pack or onboarding new users, the directory structure must be the right shape. Doing this after additional work is added to `f/devops/` creates migration debt.
- **Scope:** Top-level boundary establishment only. Create `core/`, `domains/work/`, `shared/`, `infra/` folders. Move scripts. Regenerate `.script.yaml` metadata. Time-box to 1 session.
- **What this is NOT:** A full architectural rebuild. Windmill pipeline logic is unchanged. No Windmill flows are modified. It's a rename + `wmill sync`.
- **Risk:** Medium. Windmill script paths in `.script.yaml` must be updated. Test all schedules after migration.
- **Dependency:** Phase 0 specs landed (so nothing gets moved mid-implementation)

### 1b: Docker-Modular Architecture (PAI containerization)
- **Why here:** Containerizing Claude Code into a named Docker container (with named volumes for MEMORY and config) is the infra prerequisite for the memory sync in Phase 2. It also reduces Ansible from 16 roles to 4-5.
- **Scope:** Per the [spec](./docker-modular): build PAI container image, create named volumes, install `pai` session manager, migrate `~/.claude` into volumes, collapse Ansible.
- **Risk:** Medium. Host-to-container migration of Claude Code. Well-proven path (Anthropic devcontainer). Clear rollback: stop container, run `claude` on host directly.
- **Dependency:** None, but should follow 1a so the box architecture is clean before this adds more moving parts

---

## Phase 2 — Intelligence Expansion

With structural and infra foundations stable, expand PAI's intelligence capabilities and add the personal domain.

### 2a: PAI Memory Sync (Postgres)
- **Why here:** Requires PAI session containers (Phase 1b) to be stable. Memory in named volumes → Postgres sync creates the substrate for cross-session querying, entity extraction, and trend storage.
- **Scope:** Per the [spec](./memory-sync): inotify daemon syncing `~/.claude/` to Postgres 16+. Apache AGE for graph queries, pgvector for semantic search.
- **Risk:** Medium-high. Self-hosted Postgres (not RDS/Aurora — Apache AGE requires self-hosted). Requires PAI containers to be running.
- **Dependency:** Phase 1b (PAI containerization), Docker-Modular infra stable

### 2b: Multi-Schema Postgres + Hive Collective
- **Why here:** Extends the base memory-sync with domain partitioning and cross-instance sharing. Requires Postgres to be running (2a) before schemas can be created.
- **Scope:** Per the [spec](./postgres-multi-schema): four schemas (core/work/personal/shared), SQLite→Postgres triage sync, hive logical replication between instances, PreCompact direct Postgres write for zero-loss compaction protection.
- **Risk:** Low-medium. Additive to memory-sync. Logical replication over Tailscale is well-supported. The `shared` schema graduation mechanism requires discipline (explicit, not automatic).
- **Dependency:** Phase 2a (Postgres running with base schema)

### 2c: Personal Domain Pack (initial)
- **Why here:** Directory structure exists (Phase 1a), Postgres ready (Phase 2a enables richer queries for personal data)
- **Scope:** Telegram-first. Ingest personal Telegram messages into cache (scoped — explicit connections only, no ambient expansion). Surface patterns via existing pipeline. No new action targets in initial slice.
- **Risk:** Low-medium. Telegram integration already exists in `shared/telegram_*.ts`. Scope discipline is the risk — define the ingestion boundary explicitly and don't expand it.
- **Dependency:** Phase 1a (personal domain has a home), Phase 2a optional but preferred (richer querying)

---

## Phase 3 — Cognitive Architecture Gaps (Intelligence Layer)

These close the gaps identified in cognitive-architecture.md Part XI. They require the entity data model from Phase 2a (Postgres) to be in place before they're meaningful.

### 3a: Entity Extraction + Triage Feedback Loop (designed together)
- **Why together:** Entity extraction produces the substrate (tagged entities); the feedback loop requires entity-tagged data to produce signal (not noise). Building them separately means the loop won't close.
- **Scope:** Entity extraction: automated tagging of triage results with extracted entities (people, systems, projects, IPs). Feedback loop: record acted-on / deferred / dismissed decisions; calibrate triage quality per entity type.
- **Why this order:** Without entities, "acted on this alert" is an undifferentiated signal. With entities, you learn "alerts about this AWS account are high-signal; alerts about this Slack channel are noise."
- **Dependency:** Phase 2a (Postgres for entity store), trend_engine.ts stable

### 3b: Contextual Surfacing (full implementation)
- **Why last:** Surfacing is the *output* of the intelligence layer. It should only fire when the entity extraction and feedback loop have generated enough signal to surface with confidence. Surfacing without that substrate produces noise that trains users to ignore it — the worst outcome.
- **Gate:** Only activate proactive surfacing when the feedback loop has accumulated sufficient signal to set a confidence threshold. Start low, expand based on observed accuracy.
- **Dependency:** Phase 3a (entity extraction + feedback loop providing the confidence signal)

---

## Sequencing Diagram

```
NOW ─────────────────────────────────────────────────────────────────► TIME

Phase 0          Phase 1              Phase 2           Phase 3
─────────        ────────────────     ─────────────     ─────────────────
Status           Reorg               Memory Sync        Entity Extract +
Dashboard  ────► (1a, 1 session) ──► (2a)         ─┐   Feedback Loop
                                                    ├──► (3a)
Investigate      Docker-Modular       Personal       │
First       ────► Infra (1b)    ──►  Domain (2b)   └──► Contextual
Pipeline                                                 Surfacing (3b)

Doc fixes
(trivial,
do inline)
```

## Quick Wins (Can Ship Without Blocking Infra Work)

These can be done independently, in any order, at any time:

| Item | Effort | Value |
|------|--------|-------|
| Status Dashboard (0a) | 1 session | High — daily operational visibility |
| Investigate-First Pipeline (0b) | 1-2 sessions | High — improves all future investigation quality |
| Cognitive arch doc fixes (0c) | 30 min | Low-medium — cleaner docs |
| Deprecate `auto_triage.ts` + `cross_correlate.ts` | 15 min | Low — removes confusion |

## What NOT To Do

1. **Don't reorg directories during an active implementation sprint** — Do it before Phase 0 lands or after, not during. Mid-flight renaming breaks Windmill paths.
2. **Don't bundle a sample/starter domain pack with the platform core** — Defaults are product promises. An irrelevant default drives people away faster than an empty state.
3. **Don't build contextual surfacing before entity extraction is stable** — A surfacing system without feedback becomes noise. Once trained to ignore it, users never re-enable it.
4. **Don't start the personal domain with finance or health as the first slice** — High-sensitivity data, complex API integrations, no existing scaffolding. Telegram is already partially wired and scoped cleanly.
5. **Don't make the reorg a full freeze** — Time-box to hours, not days. The goal is clean lane boundaries, not perfect structure. Specs 0a and 0b are already designed and shouldn't wait.
6. **Don't implement PAI Memory Sync before Docker-Modular is stable** — Memory Sync requires named volumes from containerized PAI. Running it on host-PAI creates migration complexity.

## Principle Implications

None of the 16 PAI founding principles require modification. The modularization work is consistent with:
- **Principle #8 (UNIX Philosophy):** Domain packs are composable, independent modules
- **Principle #5 (As Deterministic as Possible):** The pipeline core never changes; only the plugged-in sources/actions vary
- **Principle #6 (Code Before Prompts):** All domain coupling is code (scripts), not prompt engineering

One addition that this work surfaces, to be discussed separately:

> **Principle Candidate: Domain Isolation** — Platform intelligence (pipeline, entity store, feedback loop) must have zero code imports from domain packs. Domain packs depend on platform; platform never depends on domain packs. Coupling is data-model only.

This is consistent with the existing principles but makes explicit a constraint that was previously implicit.
