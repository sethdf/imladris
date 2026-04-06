---
sidebar_position: 8
---

# Postgres Multi-Schema, Hive Collective & Compaction Protection

Extends the [PAI Memory Sync](./memory-sync) spec with three additions:
1. **Multi-schema layout** — a single Postgres instance partitioned by domain
2. **Hive collective** — cross-instance shared intelligence via logical replication
3. **Compaction protection** — zero-loss at Claude Code context compaction events

---

## 1. Multi-Schema Design

### Schemas ARE Domains — and schemas are optional

The Postgres schema structure is isomorphic to the Windmill domain structure:

| Windmill directory | Postgres schema | Required? | Install when |
|-------------------|----------------|-----------|--------------|
| `f/core/` | `core` | **Yes** — always | Every installation |
| `f/domains/work/` | `work` | Optional | Work domain deployed |
| `f/domains/personal/` | `personal` | Optional | Personal domain deployed |
| `f/shared/` | `shared` | Optional | Cross-domain queries needed |

A minimal installation has only `core`. A full installation has all four. Scripts that query across schemas check for schema existence before joining — a missing schema is not an error, it's an unconfigured domain.

This mirrors the domain principle: **deploy a domain → its schema exists. Don't deploy it → schema doesn't exist, nothing breaks.**

### One Postgres instance, four optional schemas

```
PostgreSQL 16+ (single instance per imladris)
├── schema: core          ← PAI cognitive memory + core pipeline (REQUIRED)
├── schema: work          ← Work domain operational data (OPTIONAL)
├── schema: personal      ← Personal domain data (OPTIONAL)
└── schema: shared        ← Cross-domain + cross-instance intelligence (OPTIONAL)
```

Every table belongs to exactly one schema. Cross-schema queries are just SQL joins. Apache AGE knowledge graph spans all schemas. pgvector embeddings live in `core` but can reference objects in any schema via foreign key.

**Installation order:** `core` first. Then add domains incrementally. Each domain's `sql/schemas/{domain}.sql` is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) — safe to re-run.

**Cross-schema query safety pattern:**
```sql
-- Check if work schema exists before joining
SELECT EXISTS(
    SELECT 1 FROM information_schema.schemata WHERE schema_name = 'work'
) AS work_deployed;

-- Scripts guard cross-schema joins:
-- IF work schema exists: JOIN work.triage_results ...
-- ELSE: return core results only
```

### `core` schema — PAI memory (written by memory-sync daemon)

| Table | Contents |
|-------|----------|
| `memory_objects` | Current state of every file in `~/.claude/` |
| `memory_object_versions` | Full version history of every file |
| `memory_vectors` | pgvector embeddings for semantic search (Phase 2) |
| `memory_lines` | Individual lines from append-only JSONL files |
| `sessions` | Session metadata (start, end, work item, context estimate) |
| `compaction_checkpoints` | Compaction summaries written directly at compaction time |

The memory-sync inotify daemon writes exclusively to `core`. No other component writes to `core` directly except the PreCompact hook writing to `compaction_checkpoints` (see Section 3).

### `work` schema — work domain operational data

| Table | Contents |
|-------|----------|
| `triage_results` | Finalized triage records synced from SQLite (not replacing SQLite) |
| `investigation_log` | Investigation results per item, linked to triage records |
| `entities_work` | Work-domain entities: AWS accounts, Azure users, services, IPs |
| `sdp_snapshot` | Periodic SDP ticket state snapshots |
| `credential_audit` | Credential freshness log (status_check runs) |

**SQLite relationship:** The Windmill triage SQLite cache (`/local/cache/triage/index.db`) remains the hot operational store — write-heavy, low-latency, NVMe-backed. Finalized records (items that have reached terminal state: `task_created`, `escalated`, `dismissed`) are synced to `work.triage_results` via a lightweight Windmill sync script. SQLite is the working cache; `work.triage_results` is the record.

This applies the same principle as PAI MEMORY: filesystem is the working cache, Postgres is the system of record.

### `personal` schema — personal domain data

| Table | Contents |
|-------|----------|
| `triage_results` | Personal triage items (separate from work — no cross-contamination) |
| `telegram_context` | Personal Telegram conversation context, threaded |
| `entities_personal` | Personal entities: contacts, projects, recurring topics |
| `calendar_events` | Calendar event log (work and personal calendar, tagged by domain) |

### `shared` schema — cross-domain and cross-instance

| Table | Contents |
|-------|----------|
| `insights` | High-value learnings explicitly graduated from work or personal |
| `entities_global` | Entities that span domains (a person who appears in both work and personal) |
| `knowledge_graph` | Apache AGE property graph — nodes and edges across all domains |
| `hive_log` | Replication event log for debugging cross-instance sync |

**The `shared` schema is the only schema that replicates between imladris instances.**

Work and personal schemas never leave their instance. What you learn about your AWS accounts stays in `work`. What you talk about in personal Telegram stays in `personal`. Only insights you explicitly graduate to `shared` can propagate to another instance.

---

## 2. Hive Collective

### What "hive" means

Two separate imladris installations — for example, your personal home machine and a work EC2 — can share a `shared` schema. Each instance independently classifies, investigates, and learns. Insights explicitly marked as cross-instance relevant propagate to the partner.

The result: one instance's discovery (a new investigation pattern, a frequently-encountered entity, a verified playbook) becomes available to the other without manual copying.

### Mechanism: Logical replication

Logical replication over Tailscale. Each instance publishes its `shared` schema. The partner subscribes. Changes propagate asynchronously — no live connectivity required per query.

```
Instance A (home EC2)                  Instance B (work EC2)
┌─────────────────────┐                ┌─────────────────────┐
│ schema: core        │                │ schema: core        │
│ schema: work        │                │ schema: work        │
│ schema: personal    │                │ schema: personal    │
│ schema: shared ─────┼──replication──►│ schema: shared      │
│         ◄───────────┼──replication───┼─────                │
└─────────────────────┘                └─────────────────────┘
     Tailscale: 100.x.x.x                  Tailscale: 100.y.y.y
```

**Why logical replication over postgres_fdw:**

| Property | Logical Replication | postgres_fdw |
|----------|-------------------|--------------|
| Requires live connection per query | No — async | Yes |
| Works offline (syncs when reconnected) | Yes | No |
| Bidirectional | Yes (with conflict resolution) | Manual |
| Data lives locally on each instance | Yes | No — remote reads |
| Tailscale latency impact | None at query time | Every query |

### Setup

```sql
-- On BOTH instances: create dedicated hive user
CREATE USER hive_sync WITH REPLICATION LOGIN PASSWORD 'use-bws-generated';
GRANT USAGE ON SCHEMA shared TO hive_sync;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA shared TO hive_sync;

-- On Instance A: publish
CREATE PUBLICATION hive_shared_pub FOR TABLES IN SCHEMA shared;

-- On Instance B: subscribe to A
CREATE SUBSCRIPTION hive_from_a
  CONNECTION 'host=100.x.x.x port=5432 dbname=pai user=hive_sync password=xxx sslmode=require'
  PUBLICATION hive_shared_pub;

-- On Instance A: subscribe to B (bidirectional)
CREATE SUBSCRIPTION hive_from_b
  CONNECTION 'host=100.y.y.y port=5432 dbname=pai user=hive_sync password=xxx sslmode=require'
  PUBLICATION hive_shared_pub;
```

Tailscale provides the network layer — no ports exposed to the public internet.

### What can enter `shared`

Graduation from `work` or `personal` to `shared` requires explicit action — never automatic. A Windmill script (`graduate_insight.ts`) or `pai share insight <id>` CLI command marks an insight as shared and inserts it into `shared.insights`.

| Can enter `shared` | Cannot enter `shared` |
|--------------------|----------------------|
| Investigation patterns ("this class of alert correlates with X") | Raw triage results |
| Verified playbooks ("when A happens, do B") | SDP ticket contents |
| Entity relationships that span both life contexts | Personal Telegram messages |
| Learning signals about what investigation approaches work | AWS account IDs |
| Knowledge graph edges with no sensitive payload | Credential data of any kind |

The privacy boundary is: **no item with a specific sensitive identifier enters shared**. Patterns and relationships, yes. Raw data, no.

### Conflict resolution

If both instances simultaneously update the same `shared.insights` row, Postgres logical replication uses **last-write-wins** by default (based on commit timestamp). For most shared content this is acceptable — insight content is append-style, not concurrent-edit.

For `shared.knowledge_graph` (Apache AGE edges), conflicts are resolved by keeping both edges — graph merging is additive, not destructive.

---

## 3. Compaction Protection

### Current state

| Layer | Mechanism | Status |
|-------|-----------|--------|
| Early warning | `ContextCompaction.hook.ts` fires on UserPromptSubmit, estimates token usage, warns at ~70% | ✅ Wired |
| Capture at compaction | `PreCompact.hook.ts` fires before compaction, saves auto-generated summary to `MEMORY/WORK/{session}/compaction-{ts}.md` and `MEMORY/STATE/last-compaction.json` | ✅ Wired, verified fired |
| Durable backup | inotify daemon picks up compaction file and syncs to Postgres | ❌ Memory-sync not yet deployed |
| Zero-loss direct write | PreCompact writes synchronously to Postgres before returning | ❌ Not yet built |

**The gap:** The PreCompact hook currently writes to the same local filesystem that could be lost. If the disk fails in the ~5s window between the compaction-*.md write and the inotify daemon push, the checkpoint is gone. For a zero-loss claim, the PreCompact hook must write directly and synchronously to Postgres.

### Compaction checkpoint table

```sql
CREATE TABLE core.compaction_checkpoints (
    id              BIGSERIAL PRIMARY KEY,
    session_id      TEXT NOT NULL,
    session_dir     TEXT,                    -- MEMORY/WORK/{slug} if known
    task_title      TEXT,
    trigger         TEXT DEFAULT 'auto',
    summary         TEXT NOT NULL,           -- Claude's auto-generated context summary
    checkpoint_path TEXT,                    -- Filesystem path (may be null if disk unavailable)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON core.compaction_checkpoints (session_id);
CREATE INDEX ON core.compaction_checkpoints (created_at DESC);
```

### PreCompact hook enhancement (when memory-sync is deployed)

The existing `PreCompact.hook.ts` gains an optional Postgres write path. The inotify daemon also picks up the compaction file — but the direct write happens first and is synchronous:

```
Compaction event fires
        │
        ▼
PreCompact.hook.ts runs
        │
        ├──① Write summary to filesystem (existing, always runs)
        │   └── MEMORY/WORK/{session}/compaction-{ts}.md
        │   └── MEMORY/STATE/last-compaction.json
        │
        ├──② Write summary DIRECTLY to Postgres core.compaction_checkpoints
        │   └── Synchronous pg INSERT before hook exits
        │   └── Runs only if POSTGRES_URL env var is set (graceful degradation)
        │   └── ~10ms — acceptable within PreCompact hook budget
        │
        └── Exit 0 (never blocks compaction regardless)
                │
                ▼
        inotify daemon fires on compaction-{ts}.md write (~5s later)
        └── Syncs file to core.memory_objects (normal path, idempotent with ②)
```

**Graceful degradation:** If Postgres is unavailable when PreCompact fires, the hook exits cleanly after the filesystem write — it logs the miss to stderr but never blocks compaction. The inotify daemon catches up when Postgres is available again.

### What the summary captures (and what it doesn't)

Claude Code's auto-generated compaction summary is the best available snapshot of "what was I doing." It includes:
- Active task and recent decisions
- Files modified, tools used
- Key context for resuming work

It does **not** include:
- Raw tool outputs (search results, file contents viewed)
- The full conversation transcript
- Intermediate reasoning that didn't make it into the summary

For Algorithm sessions, PRD writes throughout execution mean compaction loss is minimal even without this hook — the PRD is a continuous write-ahead log of the session's work. For native-mode sessions, the compaction summary is the only persistent record.

**This is a known remaining limitation.** The compaction summary is what Claude generates, not what we define. The only way to guarantee richer checkpointing for native-mode sessions is to use Algorithm mode for important work (which already writes to PRD continuously).

### LoadContext enhancement (Phase 2)

Once `core.compaction_checkpoints` exists, `LoadContext.hook.ts` (which fires at session start) gains a Postgres lookup path:

```
SessionStart → LoadContext fires
├── Read MEMORY/STATE/current-work.json (filesystem, fast)
├── Check MEMORY/STATE/last-compaction.json (filesystem)
└── If session_id matches a compaction checkpoint in Postgres:
    └── Surface the full summary in session start context
        (not just the 500-char preview in last-compaction.json)
```

This means a session that was compacted mid-flight gets its full summary surfaced at the next prompt — not just a truncated preview.

---

## 4. Extensions to memory-sync Spec

This spec is additive to [memory-sync](./memory-sync). Changes to that spec:

| Section | Addition |
|---------|---------|
| Architecture diagram | Add `schema: work`, `schema: personal`, `schema: shared` below the existing Postgres box |
| Phase 1 | Add `core.compaction_checkpoints` table creation to schema setup |
| Phase 1 | Add PreCompact direct-write path as a memory-sync deploy step |
| Phase 2+ | Add hive collective setup as an optional Phase 2 capability |
| Goals | Add: "Cross-domain queryability — work and personal data queryable via SQL joins in the same instance" |

---

## 5. Files to Create / Modify

| File | Change |
|------|--------|
| `windmill/f/core/sync_triage_to_postgres.ts` | New: sync finalized SQLite records to `work.triage_results` |
| `windmill/f/core/graduate_insight.ts` | New: mark an insight as shared, insert into `shared.insights` |
| `~/.claude/hooks/PreCompact.hook.ts` | Modify: add synchronous Postgres write path (guarded by env var) |
| `sql/schemas/core.sql` | New: DDL for `core` schema tables |
| `sql/schemas/work.sql` | New: DDL for `work` schema tables |
| `sql/schemas/personal.sql` | New: DDL for `personal` schema tables |
| `sql/schemas/shared.sql` | New: DDL for `shared` schema tables |
| `sql/hive/setup-publisher.sql` | New: logical replication publisher setup |
| `sql/hive/setup-subscriber.sql` | New: logical replication subscriber setup |
| `docs-site/docs/specs/memory-sync.md` | Update: reference this spec, add multi-schema note |

---

## 6. Verification

1. `psql -c '\dn'` on imladris Postgres shows four schemas: `core`, `work`, `personal`, `shared`
2. Finalized triage records appear in `work.triage_results` after SQLite sync script runs
3. PreCompact fires → `core.compaction_checkpoints` has a new row within 30s
4. An insight graduated via `graduate_insight.ts` appears in `shared.insights`
5. On a second imladris instance: subscribe and verify `shared.insights` replicates within 60s of graduation
6. Disconnect the two instances (pause Tailscale), graduate another insight on Instance A, reconnect — verify it appears on Instance B after reconnect
7. `SELECT * FROM core.compaction_checkpoints ORDER BY created_at DESC LIMIT 5` shows recent compaction history
8. `LoadContext.hook.ts` surfaces full compaction summary (not 500-char preview) after a compacted session

---

*Phase 2 target. Requires [Docker-Modular](./docker-modular) (Phase 1) and [PAI Memory Sync](./memory-sync) (Phase 2) as prerequisites.*
