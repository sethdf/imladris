---
sidebar_position: 3
---


**Version:** 4.0
**Date:** 2026-03-13
**Status:** Draft

---

## Overview

A sync system that durably captures everything PAI writes to `~/.claude/` into a PostgreSQL 16+ database, which serves as the **system of record** — the single canonical store, backup, and portability layer for all PAI memory. The local filesystem is a working cache that PAI reads and writes to; Postgres is where nothing is ever lost. On top of that durable foundation, AI-powered capabilities (semantic search, knowledge graph, failure analysis) are layered using native Postgres extensions.

Fully additive to PAI — existing hooks, tools, and file-based workflows are unchanged.

### Hosting Decision: Self-Hosted PostgreSQL on EC2

The spec requires three extensions — **Apache AGE** (graph queries), **pgml** (in-database ML/embeddings), and **pg_net** (outbound HTTP from triggers) — that are **not available on any managed AWS PostgreSQL service** (neither Aurora nor RDS). This is the deciding factor.

| Extension | Aurora | RDS | Self-Hosted |
|-----------|:------:|:---:|:-----------:|
| pgvector | Yes | Yes | Yes |
| Apache AGE | **No** | **No** | Yes |
| pgml | **No** | **No** | Yes |
| pg_cron | Yes | Yes | Yes |
| pg_trgm | Yes | Yes | Yes |
| ltree | Yes | Yes | Yes |
| pgcrypto | Yes | Yes | Yes |
| pg_net | **No** | **No** | Yes |
| plv8 | Yes | Yes | Yes |
| plpython3u | **No** | **No** | Yes |

**Deployment:** PostgreSQL 16+ on EC2 (imladris or dedicated instance), with pgBackRest continuous WAL archiving to S3 for point-in-time recovery. The sync daemon connects via direct libpq/pg connections (simpler than the RDS Data API, which is HTTP-based and Aurora-only).

**Durability without multi-AZ:** The system is single-user. The sync daemon's local WAL already buffers up to 30 seconds of unpushed writes. pgBackRest archives WAL segments to S3 continuously, giving PITR capability. Worst case on total disk failure: restore from S3 onto a new instance in minutes, losing at most the data between the last WAL segment archived and the failure. For a single-user knowledge store (not a production SaaS), this is an acceptable tradeoff for the full extension stack.

**Cost:** EC2 instance + EBS + S3 WAL archiving.

| Setup | Monthly Cost |
|-------|-------------|
| t4g.micro (1 GiB RAM) + 20 GB EBS + S3 | ~$8 |
| t4g.small (2 GiB RAM) + 20 GB EBS + S3 | ~$14 |
| t4g.small + 50 GB EBS + S3 | ~$17 |
| RDS db.t4g.micro (for comparison — missing extensions) | ~$15 |
| Aurora Serverless v2 (for comparison — missing extensions) | ~$44+ idle floor |

The t4g.small (2 GiB RAM) is the sweet spot — enough for `shared_buffers` + headroom, and currently under a free-tier trial. Self-hosted is cheaper than RDS for comparable specs, and dramatically cheaper than Aurora — while being the only option that supports all required extensions.

**Future option:** If multi-AZ resilience becomes necessary, add a streaming replica on a second EC2 instance with Patroni for automatic failover. Same extension support, doubled cost. Alternatively, **Tembo** (managed Postgres with 200+ extensions) supports pgml and likely Apache AGE via their Trunk package manager — worth evaluating if managed hosting becomes a priority.

---

## Design Principles

### Additive to PAI

PAI hooks and tools continue writing to `~/.claude/` exactly as they do today. The sync daemon watches those writes and pushes them to Postgres. PAI never calls sync. Sync never modifies PAI files.

| Boundary | Rule |
|----------|------|
| Existing hooks | **Unchanged.** No modifications, no new imports, no sync calls. |
| Existing tools | **Unchanged.** SessionHarvester, FailureCapture, OpinionTracker, Wisdom Frames — all continue writing to `~/.claude/` exactly as they do today. |
| Existing file formats | **Unchanged.** No schema migrations, no new fields, no format changes. |
| Existing CLAUDE.md | **Unchanged.** No new instructions, no sync references. |
| New capabilities (Phase 2+) | Read from and enrich data in Postgres. Never modify `~/.claude/`. |

**Why this matters:** PAI works perfectly without sync. If the daemon stops, PAI continues as-is. If PAI changes its file formats, sync adapts — not the other way around. The sync layer is invisible to PAI.

### Two Separate Worlds: Push is Invisible, Query is Explicit

The system has two completely independent halves. Understanding this boundary is critical.

**Push side (invisible, automatic):**
- The daemon watches `~/.claude/` via inotify — a kernel-level filesystem hook
- It fires on every write from any process: Claude, a hook, a manual edit, a script — anything
- PAI has zero knowledge this is happening. Claude has zero knowledge. No adapter, no import, no config
- It's like a backup agent running in the background — the applications being backed up don't know it exists

**Query side (explicit, manual, user-invoked):**
- New `pai` CLI commands (`pai memory search`, `pai knowledge query`, `pai predict`, etc.)
- Run by the user when they want to ask questions grep can't answer
- These commands talk to Postgres directly — they never touch `~/.claude/`
- They are completely separate tools from PAI's existing hooks and tools

**PAI and Claude never talk to Postgres.** The daemon talks to Postgres (push). The `pai` CLI commands talk to Postgres (query). PAI talks to the filesystem. These are three separate systems that share data through the filesystem (PAI → daemon) and through Postgres (daemon → CLI queries).

```
PAI hooks/tools ──writes──> ~/.claude/ ──inotify──> daemon ──pushes──> Postgres
                                                                          |
User ──runs──> pai memory search ──queries──────────────────────────> Postgres
User ──runs──> pai knowledge query ──queries────────────────────────> Postgres
User ──runs──> pai predict ──queries────────────────────────────────> Postgres
```

### Grep-First: Postgres Only When Grep Can't

PAI's existing retrieval — grepping and reading files from `~/.claude/MEMORY/` — is fast, effective, and already proven. The Algorithm, SessionHarvester, LearningPatternSynthesis, and Wisdom Frames all use file-based retrieval and it works. **We do not replace this.**

Postgres queries are reserved for things the filesystem literally cannot do:

| Need | Grep handles it? | Use Postgres? |
|------|-----------------|---------------|
| "Find all learnings mentioning TypeScript" | **Yes** — `grep -r "TypeScript" MEMORY/LEARNING/` | No |
| "Read the current PRD for this task" | **Yes** — `cat MEMORY/WORK/20260305_task/PRD.md` | No |
| "Find all 5-star rated sessions" | **Yes** — `grep '"rating":5' ratings.jsonl` | No |
| "What's the active Wisdom Frame for React?" | **Yes** — `cat MEMORY/WISDOM/react.md` | No |
| "Find learnings *semantically related* to this task (no keyword overlap)" | No — grep is literal matching only | **Yes** (pgvector) |
| "What chain of failures led to this learning?" | No — grep can't traverse relationships | **Yes** (AGE graph) |
| "Show me version 3 of this PRD from two weeks ago" | No — filesystem only has current version | **Yes** (version history) |
| "Restore a file I accidentally deleted" | No — it's gone from the filesystem | **Yes** (soft deletes) |
| "Pull my complete memory onto a new laptop" | No — rsync is manual and fragile | **Yes** (system of record) |
| "What config changes correlated with rating improvements?" | No — requires temporal joins across file types | **Yes** (SQL analytics) |
| "Find learnings that implicitly contradict each other" | No — requires semantic comparison | **Yes** (pgvector + graph) |
| "Warn me about similar past failures before starting this task" | No — requires embedding similarity against task description | **Yes** (pgvector) |

**Rule of thumb:** If the existing PAI tool or a simple grep can answer the question, use that. Postgres is for the questions that are impossible to answer by reading files — semantic similarity, causal chains, version history, cross-machine portability, and temporal analytics.

### Postgres as System of Record

The local filesystem (`~/.claude/`) is a **working cache** — it's what PAI reads and writes to in real-time. PostgreSQL is the **system of record** — the durable, canonical, complete store.

| Property | Filesystem | Postgres |
|----------|-----------|----------|
| Role | Working cache for PAI | System of record |
| Durability | Single machine, single disk | pgBackRest WAL archiving to S3, PITR |
| Completeness | Current machine only | Every file from every machine, every version |
| Data loss risk | Disk failure, accidental deletion, machine loss | pgBackRest to S3 + local WAL buffer; worst case ~30s of unpushed data |
| Portability | rsync/tar (manual, fragile) | `pai sync pull` on any machine (instant, complete) |
| Queryability | grep, find | SQL, pgvector, graph queries, JSONB operators |
| History | Only current version | Full version history (soft deletes, updated_at tracking) |

**What this means in practice:**
- **New machine?** `pai sync pull` → complete PAI memory restored in seconds
- **Disk failure?** Postgres has everything. Rebuild filesystem from Postgres.
- **Accidental deletion?** Postgres has the file (soft deletes, never hard deletes). Restore it.
- **Want to query across all learnings?** SQL, not grep across 500 files.
- **Machine stolen?** Your memory is in Postgres (backed up to S3), not on the laptop.

**The filesystem is not the backup. Postgres is the backup.** The filesystem is what PAI needs to operate locally. Postgres is where the data is safe.

### Version History

Postgres preserves what the filesystem can't: **every version of every file.**

```sql
-- memory_objects stores current state
-- memory_object_versions stores every previous state
CREATE TABLE memory_object_versions (
    key           TEXT NOT NULL,
    version       INTEGER NOT NULL,
    content       TEXT,
    metadata      JSONB,
    content_hash  TEXT NOT NULL,
    session_id    TEXT,
    machine_id    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (key, version)
);
```

When a file is updated in `memory_objects`, the old version is copied to `memory_object_versions` first. The filesystem only has the current version. Postgres has them all.

`pai sync history MEMORY/WORK/20260305_task/PRD.md` → shows every version, who wrote it, when.

---

## Goals

1. **Zero data loss** — every file written to `~/.claude/` (minus known-ephemeral paths) is durably stored in Postgres
2. **Postgres is canonical** — if the filesystem and Postgres disagree, Postgres is the authority for recovery
3. **No Claude dependency** — sync is a standalone daemon using inotify; it does not depend on hooks, Claude Code, or any AI behavior
4. **Sub-agent safe** — multiple concurrent Claude processes can write to the same JSONL files without losing lines
5. **Deterministic core** — the sync pipeline itself uses no AI/ML; purely mechanical file-to-database sync
6. **Swappable backend** — the storage layer is behind an adapter interface; self-hosted Postgres today, managed service tomorrow
7. **PAI-transparent** — existing hooks and tools are unchanged; they keep writing to the filesystem as they do today
8. **Full portability** — `pai sync pull` on a fresh machine bootstraps complete PAI memory
9. **Postgres as platform** — PostgreSQL 16+ is the foundation for AI-powered capabilities via pgvector, Apache AGE, pgml, and native Postgres features

---

## Architecture

```
+---------------------------------------------------+
|  PAI Hooks & Tools (existing, UNCHANGED)           |
|  RatingCapture, SessionHarvester, Algorithm, etc.  |
+------------------------+--------------------------+
                         | writes to ~/.claude/ (as always)
                         v
+---------------------------------------------------+
|  ~/.claude/ (working cache)                        |
|  - What PAI reads/writes in real-time              |
|  - Single machine, single disk, current versions   |
+------------------------+--------------------------+
                         | inotify watches writes
                         v
+---------------------------------------------------+
|  pai-sync daemon (systemd service)                 |
|  - inotify watch on ~/.claude/                     |
|  - Write-ahead log (WAL) for zero data loss        |
|  - Debounced push (5s quiet / 30s max-wait)        |
|  - Gzip compression for large files                |
+------------------------+--------------------------+
                         | pushes to
                         v
+---------------------------------------------------+
|  PostgreSQL 16+ (SYSTEM OF RECORD)                 |
|  - memory_objects / memory_lines (Phase 1)         |
|  - memory_object_versions (full history)           |
|  - memory_vectors (pgvector, Phase 2a)             |
|  - knowledge graph (Apache AGE, Phase 2b)          |
|  - in-database ML (pgml, Phase 2c)                 |
|  - pgBackRest to S3, PITR                          |
+---------------------------------------------------+
           ^
           | pai sync pull (restore/bootstrap)
           v
+---------------------------------------------------+
|  Any machine's ~/.claude/ (working cache)          |
|  - Fresh laptop, new dev environment, recovery     |
+---------------------------------------------------+
```

---

## Daemon Architecture

The sync engine runs as a **standalone systemd service** using inotify to watch `~/.claude/`. It has no dependency on Claude Code, hooks, or any AI process.

### Why a daemon

- **No Claude dependency** — inotify catches every filesystem write regardless of what process made it (Claude, manual edit, script, cron, anything)
- **Zero data loss** — a write-ahead log (WAL) ensures no change is lost even if the daemon crashes
- **Debounce state** — in-memory timers require a long-running process; short-lived hooks can't hold debounce state

### Write-Ahead Log (WAL)

The WAL guarantees zero data loss across daemon restarts, crashes, and power failures.

```
1. inotify fires on file change in ~/.claude/
2. Daemon appends {path, content_hash, timestamp} to WAL file (fsync'd)
3. Debounce timer fires → daemon reads WAL, pushes dirty files to Postgres
4. Only after confirmed push does daemon mark WAL entry as committed
5. On daemon restart, replay any uncommitted WAL entries
```

**WAL location:** `~/.claude/MEMORY/STATE/sync-wal.jsonl` (in STATE/, does not sync — avoids recursion)

**Data loss scenarios:**
| Scenario | Data lost? | Why |
|----------|-----------|-----|
| Daemon crashes mid-push | No | WAL entry exists, replayed on restart |
| Machine loses power | No | WAL is fsync'd to disk before acknowledging the inotify event |
| Network failure during push | No | WAL entry stays uncommitted, retried next push cycle |
| Disk failure | No | **Postgres is the system of record.** `pai sync pull` on new disk restores everything. Only data written between last successful push and disk failure is lost (worst case: 30 seconds). |
| Machine stolen/destroyed | No | Postgres has everything. `pai sync pull` on new machine. |

### systemd Service

```ini
[Unit]
Description=PAI Memory Sync Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/pai-sync-daemon
Restart=always
RestartSec=5
WatchdogSec=60
Environment=PAI_SYNC_POSTGRES_URL=postgresql://pai_sync@localhost:5432/pai_memory

[Install]
WantedBy=default.target
```

### inotify Configuration

- **Watch path:** `~/.claude/` (recursive)
- **Events:** `IN_CLOSE_WRITE`, `IN_MOVED_TO`, `IN_CREATE`, `IN_DELETE`
- **Exclude:** Paths matching `.syncignore` rules (STATE/, PAI/, projects/, *.tmp, *.lock)
- **Resource cost:** Kernel-level, no polling, effectively zero CPU

---

## Sync Scope

**Sync root:** `~/.claude/`

**Strategy:** Sync everything EXCEPT an exclude list. New files/directories are synced by default — safe direction to fail.

### Exclude list (.syncignore)

```
PAI/                    # Source code — lives in git
projects/               # Claude-managed session transcripts (30-day, large)
MEMORY/STATE/           # Ephemeral runtime data — rebuilt per session
*.tmp
*.lock
```

### What gets synced

| Path | Why |
|------|-----|
| `MEMORY/WORK/` | PRDs — the core durable record of all work |
| `MEMORY/LEARNING/` | Learnings, signals, failures, synthesis, reflections |
| `MEMORY/RESEARCH/` | Agent output captures |
| `MEMORY/SECURITY/` | Security audit trail |
| `MEMORY/PAISYSTEMUPDATES/` | Architecture change history |
| `MEMORY/WISDOM/` | Wisdom Frames — domain knowledge graph |
| `settings.json` | Claude Code configuration |
| `keybindings.json` | Key bindings |
| Hook config files | Hook settings (not hook source code — that's in PAI/ which is in git) |

### What does NOT sync

| Path | Why |
|------|-----|
| `PAI/` | In git. Not our problem. |
| `projects/` | Claude-managed, 30-day retention, very large. Not our problem. |
| `MEMORY/STATE/` | Ephemeral by design. Doc says "can be rebuilt." |
| `*.tmp`, `*.lock` | Transient files. |

---

## Sync Triggers

| Trigger | Direction | When |
|---------|-----------|------|
| inotify event + 5s debounce | Push | After any process writes to a synced path |
| 30s max-wait cap | Push | During continuous writes, force push every 30s |
| `pai sync push` | Push | Manual — user runs CLI command |
| `pai sync pull` | Pull | Manual or bootstrap — restores filesystem from Postgres |
| `pai sync status` | Neither | Shows diff between local and remote |

**There is no automatic pull** (except opt-in cross-machine sync in Phase 2). Pull is manual by default. This keeps the system simple and avoids stale remote state overwriting fresh local edits during active work.

---

## Debounce Explained

When inotify detects a file change, we don't push immediately. We batch:

```
inotify: file A changed   -> WAL append, start 5s timer
inotify: file B changed   -> WAL append, reset timer to 5s
inotify: file C changed   -> WAL append, reset timer to 5s
...silence for 5s...       -> NOW push A, B, C together in one batch
```

If writes keep happening continuously (e.g., a long build session), the **30-second max-wait cap** ensures data gets pushed regardless:

```
inotify: file A changed   -> WAL append, start 5s timer, start 30s max timer
inotify: file B (4s later) -> WAL append, reset 5s timer
inotify: file C (8s later) -> WAL append, reset 5s timer
...writes keep coming...
30s max timer fires        -> push everything dirty NOW, reset both timers
```

**Worst-case data loss window: 0 seconds** — the WAL is fsync'd on every inotify event. Data is durable locally the instant it's written. The debounce only affects when it reaches Postgres. Worst case for Postgres lag: 30 seconds during continuous writes.

---

## Large File Handling

Large files (failure transcripts, etc.) need compression for efficient storage and transfer. Solution: **gzip compression with chunking**.

### Strategy

1. Files <= 100KB: push as-is (plain text)
2. Files > 100KB: gzip before push, store compressed in `content` column with `compressed: true` in metadata
3. If gzipped content still > 50MB: **chunk into multiple rows** with sequence numbers (Postgres `TEXT` has no practical size limit, but chunking keeps individual rows manageable)
4. On pull: reassemble chunks if needed, decompress if flagged

### Why not skip large files

Zero data loss means zero data loss. Failure transcripts can be large but they're valuable. We compress and chunk — we never skip.

A 3MB failure transcript gzips to ~600KB → fits in one request. A 15MB transcript gzips to ~3MB → 4 chunks of 750KB each.

---

## Initial Backfill

First `pai sync push` on an existing machine with months of data.

### Strategy

1. **Batch INSERT** — `COPY` command or multi-row `INSERT` for bulk loading
2. **Background process** — runs as a one-time systemd service, does not block the user
3. **Newest-first** — sort by mtime, push newest files first (most valuable data first)
4. **Progress tracking** — writes progress to `STATE/sync-backfill.jsonl`

### Expected performance

| Scenario | Files | API calls | Time |
|----------|-------|-----------|------|
| Fresh machine (1 month) | ~200 | 1 batch | < 5s |
| Established machine (6 months) | ~2000 | 10 batches | < 30s |
| Heavy use (1 year) | ~5000 | 25 batches | < 60s |

After initial backfill, the regular daemon handles incremental sync (typically 0-5 files per push cycle).

---

## JSONL Files — Line-Level Sync

JSONL files are append-only by contract in PAI. Multiple sub-agents may append to the same file concurrently. File-level last-write-wins would lose lines.

**Solution:** JSONL files are synced at the **line level**, not the file level.

### How it works

**Push:**
1. Read the local JSONL file
2. SHA-256 hash each line
3. `putLines()` — insert lines whose hashes don't already exist in the DB
4. Duplicates are idempotent no-ops (primary key is `(file_key, line_hash)`)

**Pull:**
1. `getLines()` — fetch all lines for the file, ordered by `created_at`
2. Write to local file
3. Result naturally merges contributions from multiple agents/machines — Postgres has lines from every machine that ever pushed

**Conflict scenario:**
- Agent A appends line X to `ratings.jsonl` on Machine 1
- Agent B appends line Y to `ratings.jsonl` on Machine 2
- Sync pushes from Machine 1: line X stored in Postgres
- Sync pushes from Machine 2: line Y stored in Postgres
- `pai sync pull` on either machine: both lines X and Y restored
- **Postgres is the union of all machines' contributions. Nothing is lost.**

### Which files are JSONL

Detection is deterministic: any file ending in `.jsonl` gets line-level sync. All others get file-level sync.

### Known JSONL files in PAI

- `LEARNING/SIGNALS/ratings.jsonl`
- `LEARNING/REFLECTIONS/algorithm-reflections.jsonl`
- `SECURITY/security-events.jsonl`
- `STATE/events.jsonl` (excluded — in STATE/)

---

## Non-JSONL Files — File-Level Sync

All non-JSONL files use whole-file sync with version history.

**Push:**
1. Compute SHA-256 of local file content
2. Compare against remote `content_hash`
3. If different: copy current remote to `memory_object_versions`, then upload new via `putFile()`

**Pull:**
1. Fetch current version from `memory_objects`
2. Write to local filesystem
3. Previous versions available via `pai sync history <key>`

**Why version history matters:** A learning file overwritten by mistake, a PRD that was better two versions ago, a settings.json change that broke something — all recoverable from Postgres. The filesystem can't do this.

---

## Storage Adapter Interface

```typescript
interface StorageAdapter {
  // Whole-file operations
  putFile(key: string, content: string, metadata: Record<string, unknown>): Promise<void>;
  getFile(key: string): Promise<{ content: string; metadata: Record<string, unknown>; contentHash: string } | null>;
  getFileVersion(key: string, version: number): Promise<{ content: string; metadata: Record<string, unknown> } | null>;
  getFileHistory(key: string): Promise<VersionEntry[]>;
  listFiles(prefix?: string, metadataFilter?: Record<string, unknown>): Promise<FileEntry[]>;
  deleteFile(key: string): Promise<void>;  // soft delete — content preserved in Postgres

  // JSONL line-level operations
  putLines(fileKey: string, lines: LineEntry[]): Promise<{ inserted: number; skipped: number }>;
  getLines(fileKey: string, since?: Date): Promise<LineEntry[]>;
}

interface FileEntry {
  key: string;
  metadata: Record<string, unknown>;
  contentHash: string;
  updatedAt: Date;
  version: number;
}

interface VersionEntry {
  version: number;
  contentHash: string;
  sessionId: string;
  machineId: string;
  createdAt: Date;
}

interface LineEntry {
  content: string;       // the raw JSON line
  lineHash: string;      // SHA-256 of content
  metadata: Record<string, unknown>;  // parsed fields for queryability
  sessionId: string;
  machineId: string;
  createdAt: Date;
}
```

**`key`** = relative path within `~/.claude/` (e.g., `MEMORY/WORK/20260305_task/PRD.md`, `settings.json`)

**`metadata`** = structured data extracted deterministically from the file:
- For PRD.md: parsed YAML frontmatter (session_id, status, effort_level, title)
- For JSONL lines: parsed JSON fields (rating, type, timestamp)
- For other files: basic info (file extension, size)

Metadata extraction is pure parsing — regex, YAML parser, JSON.parse. No inference.

---

## Database Schema

```sql
-- ============================================================
-- Phase 1: Core sync tables (system of record)
-- ============================================================

-- Current state of every synced file
CREATE TABLE memory_objects (
    key           TEXT PRIMARY KEY,       -- "MEMORY/WORK/20260305_task/PRD.md"
    content       TEXT,                   -- file contents (possibly gzipped + base64)
    metadata      JSONB,                  -- extracted structured data
    content_hash  TEXT NOT NULL,          -- SHA-256 for fast diff
    version       INTEGER NOT NULL DEFAULT 1,  -- incremented on every update
    compressed    BOOLEAN DEFAULT FALSE,  -- true if content is gzipped
    chunk_index   SMALLINT,              -- NULL for non-chunked, 0-based for chunks
    chunk_total   SMALLINT,              -- NULL for non-chunked, total count for chunks
    session_id    TEXT,                   -- which session last wrote this
    machine_id    TEXT,                   -- which machine pushed this
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted       BOOLEAN NOT NULL DEFAULT FALSE  -- soft delete: content preserved forever
);

CREATE INDEX idx_objects_prefix ON memory_objects (key text_pattern_ops);
CREATE INDEX idx_objects_metadata ON memory_objects USING GIN (metadata);
CREATE INDEX idx_objects_updated ON memory_objects (updated_at);
CREATE INDEX idx_objects_machine ON memory_objects (machine_id);

-- Full version history — every previous state of every file
CREATE TABLE memory_object_versions (
    key           TEXT NOT NULL,
    version       INTEGER NOT NULL,
    content       TEXT,
    metadata      JSONB,
    content_hash  TEXT NOT NULL,
    compressed    BOOLEAN DEFAULT FALSE,
    session_id    TEXT,
    machine_id    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (key, version)
);

CREATE INDEX idx_versions_key_time ON memory_object_versions (key, created_at DESC);

-- Trigger: auto-archive previous version before update
CREATE OR REPLACE FUNCTION archive_object_version()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.content_hash IS DISTINCT FROM NEW.content_hash THEN
        INSERT INTO memory_object_versions (key, version, content, metadata, content_hash, compressed, session_id, machine_id)
        VALUES (OLD.key, OLD.version, OLD.content, OLD.metadata, OLD.content_hash, OLD.compressed, OLD.session_id, OLD.machine_id);
        NEW.version := OLD.version + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_archive_version
    BEFORE UPDATE ON memory_objects
    FOR EACH ROW EXECUTE FUNCTION archive_object_version();

-- Line-level storage for JSONL files (append-only, union across all machines)
CREATE TABLE memory_lines (
    file_key      TEXT NOT NULL,          -- "MEMORY/LEARNING/SIGNALS/ratings.jsonl"
    line_hash     TEXT NOT NULL,          -- SHA-256 of line content
    content       TEXT NOT NULL,          -- the raw JSON line
    metadata      JSONB,                  -- parsed fields for queryability
    session_id    TEXT,
    machine_id    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (file_key, line_hash)     -- dedup: same line from multiple machines = one row
);

CREATE INDEX idx_lines_file_time ON memory_lines (file_key, created_at);
CREATE INDEX idx_lines_session ON memory_lines (session_id);
CREATE INDEX idx_lines_machine ON memory_lines (machine_id);
CREATE INDEX idx_lines_metadata ON memory_lines USING GIN (metadata);
```

### Soft deletes — nothing is ever lost

`deleteFile()` sets `deleted = TRUE` and updates `updated_at`. Content is preserved. Previous versions remain in `memory_object_versions`. The system of record never loses data.

`pai sync restore <key>` → sets `deleted = FALSE`, file available on next pull.

`pai sync restore <key> --version 3` → restores a specific historical version.

---

## Authentication

The Postgres adapter connects via standard libpq connection string:
- **Local (same machine):** Unix domain socket or `localhost` — no password needed with `peer` auth
- **Remote:** Connection string with password, or SSL client certificate authentication
- **Secrets management:** Connection credentials stored in `~/.claude/MEMORY/STATE/sync-config.json` (in STATE/, does not sync) or environment variables

The adapter config contains:
- Postgres connection string (or host/port/dbname)
- SSL certificate path (if remote)

---

## File Structure

```
/usr/local/bin/pai-sync-daemon     -- the daemon binary
/etc/systemd/user/pai-sync.service -- systemd unit file

~/.claude/PAI/Sync/                -- source code (in git with PAI)
  SyncEngine.ts          -- debounce logic, WAL management, push/pull orchestration
  StorageAdapter.ts      -- interface definition
  adapters/
    PostgresAdapter.ts   -- libpq/pg connection implementation
  daemon.ts              -- inotify watcher, WAL writer, systemd watchdog
  config.ts              -- cluster ARN, database name, region
  syncignore.ts          -- exclude list logic
  metadata-extractor.ts  -- deterministic metadata parsing (YAML frontmatter, JSON)
  compression.ts         -- gzip/chunking for large files
  cli.ts                 -- `pai sync push`, `pai sync pull`, `pai sync status`, etc.
  backfill.ts            -- initial bulk upload logic
```

---

## Sync Log

Every push and pull writes a log entry to `~/.claude/MEMORY/STATE/sync-log.jsonl`:

```json
{"timestamp":"2026-03-05T10:00:00Z","direction":"push","files_pushed":3,"files_skipped":12,"lines_pushed":5,"versions_archived":1,"duration_ms":340,"errors":[]}
```

This file is in STATE/ so it does NOT sync (it's machine-local operational data).

---

## CLI Commands

```bash
# Core sync operations
pai sync push              # Push all dirty files now (bypass debounce)
pai sync pull              # Restore/update local filesystem from Postgres
pai sync status            # Show diff: local-only, remote-only, modified
pai sync status --verbose  # Include file hashes, versions, and timestamps

# Recovery and history (Postgres as system of record)
pai sync history <key>            # Show all versions of a file
pai sync restore <key>            # Restore a soft-deleted file
pai sync restore <key> --version N  # Restore a specific historical version
pai sync diff <key> [v1] [v2]    # Diff two versions of a file

# Bootstrap and daemon management
pai sync backfill          # Run initial bulk upload (background)
pai sync daemon start      # Start the sync daemon
pai sync daemon stop       # Stop the sync daemon
pai sync daemon status     # Check daemon health
```

---

## Failure Handling

| Failure | Behavior |
|---------|----------|
| Network error on push | Retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s). WAL entry stays uncommitted. Next push cycle retries. |
| Network error on pull | Same retry logic. Abort pull on persistent failure. Local state unchanged. |
| Partial push (some files fail) | Log which files failed. Successful files committed in WAL. Failed files retried next cycle. |
| Corrupt local file | Push it anyway — the database stores what's on disk. Don't interpret or validate content. |
| Database unavailable | All operations fail gracefully with logged errors. PAI continues to work normally — sync is non-blocking. |
| Daemon crash | systemd auto-restarts within 5s. WAL replayed on startup. Zero data loss. |
| Machine power loss | WAL is fsync'd. On reboot, daemon starts via systemd, replays WAL. |
| Disk failure | **Postgres (backed up to S3) has everything.** `pai sync pull` on new disk. Worst case: up to 30s of unpushed writes lost. |
| Machine destroyed | **Postgres has everything.** `pai sync pull` on new machine. Full restore. |
| Accidental file deletion | **Postgres has the file and all versions.** `pai sync restore <key>`. |

**Critical property: sync failures never break PAI.** The sync daemon is a sidecar. If it's down, PAI works exactly as it does today — local filesystem only. But when it's up, Postgres is the safety net that the filesystem never was.

---

## Phase 2: AI-Powered Capabilities (Postgres-native)

These capabilities are **user-invoked `pai` CLI commands** that query Postgres for things grep can't do. They are completely separate from PAI's existing hooks and tools. PAI tools continue writing to the filesystem and grepping files — that works and we don't touch it. Phase 2 commands query the Postgres system of record for semantic similarity, causal chains, and temporal analytics that are impossible to answer from flat files.

**Triggering:** All Phase 2 capabilities are **manual, user-invoked CLI commands.** Nothing runs automatically except the Phase 1 daemon (which just pushes files). The user runs `pai memory search` or `pai predict` when they want it — not on every session, not on every task, not automatically. The enrichment (embeddings, graph population) happens inside Postgres on insert via triggers — invisible and zero-cost to the user — but the *queries* are always explicit.

### What PAI already does (unchanged) — and why it stays

| Capability | PAI Component | How it works today | Why we don't touch it |
|-----------|--------------|-------------------|----------------------|
| Find learnings by keyword | grep across MEMORY/LEARNING/ | Fast, effective, already works | Grep handles keyword lookup fine |
| Auto-generate learnings from sessions | SessionHarvester, WorkCompletionLearning hook | Regex pattern matching on transcripts, writes to LEARNING/ | Works well, proven over months of use |
| Knowledge graph | Wisdom Frames (WisdomFrameUpdater, WisdomCrossFrameSynthesizer) | Domain-classified frames with confidence scores, cross-frame synthesis | File-based cross-frame analysis is effective |
| Explicit contradiction tracking | OpinionTracker | User says "no that's wrong" → confidence adjusted | Handles the explicit case perfectly |
| Failure capture | FailureCapture | Full context dumps for low-rated sessions | Captures everything needed |
| Learning synthesis | LearningPatternSynthesis | Aggregates patterns across learnings | Pattern detection works from files |

**These stay exactly as they are.** Phase 2 adds capabilities for the specific things these tools *can't* do — semantic search (no keyword overlap), causal chain traversal, implicit contradiction detection, temporal analytics, and version recovery.

### 2a. Semantic Search + Hybrid Retrieval (pgvector)

**What PAI can't do today:** Find relevant learnings by meaning. All retrieval is keyword/regex. And flat vector similarity alone can't handle temporal or causal queries — see the design rationale below for why hybrid retrieval matters.

**What Postgres adds — hybrid retrieval, not just vector search:**

```sql
-- Embedding table
CREATE TABLE memory_vectors (
    source_key    TEXT NOT NULL,        -- key in memory_objects
    source_type   TEXT NOT NULL,        -- 'learning', 'failure', 'wisdom_frame', 'prd'
    chunk_text    TEXT NOT NULL,        -- the text that was embedded
    embedding     vector(1536),        -- pgvector column
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (source_key, chunk_text)
);

CREATE INDEX idx_vectors_embedding ON memory_vectors
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_vectors_type ON memory_vectors (source_type);
```

**Hybrid retrieval combines three signals:**

1. **Vector similarity** (pgvector) — semantic meaning: "find learnings about error handling" finds results even if they don't contain the word "error"
2. **Temporal filtering** (metadata + version history) — recency and currency: filter out superseded learnings, weight recent context higher, distinguish current system state from historical
3. **Graph traversal** (Apache AGE, Phase 2b) — causal chains: "find the chain of failures and learnings that led to this Wisdom Frame"

```sql
-- Hybrid query: semantic similarity + temporal recency + not superseded
SELECT mv.chunk_text, mv.source_key,
       1 - (mv.embedding <=> $query_embedding) as similarity,
       mo.updated_at,
       mo.metadata->>'status' as status
FROM memory_vectors mv
JOIN memory_objects mo ON mv.source_key = mo.key
WHERE mv.source_type = 'learning'
  AND mo.deleted = FALSE
  AND mo.updated_at > NOW() - INTERVAL '6 months'  -- temporal filter
  AND mo.metadata->>'status' != 'superseded'        -- currency filter
ORDER BY (1 - (mv.embedding <=> $query_embedding))  -- semantic ranking
    * (1.0 / (1 + EXTRACT(EPOCH FROM NOW() - mo.updated_at) / 86400 / 30))  -- recency decay
LIMIT 10;
```

**Why hybrid matters:** Flat RAG has three failure modes at scale: (1) can't handle relational queries across time, (2) can't distinguish current from superseded context, (3) degrades as corpus grows. Our hybrid approach addresses all three — temporal filtering handles (2), graph traversal handles (1), and metadata-filtered vector search keeps the relevant/irrelevant ratio high as the corpus grows, addressing (3).

**CLI:** `pai memory search "how to handle async errors in TypeScript"` → returns semantically relevant learnings, weighted by recency and filtered for currency.

**Additive to PAI:** PAI's SessionHarvester continues generating learnings the same way. This makes them findable by meaning, time, and causal relationship.

### 2b. Knowledge Graph (Apache AGE)

**What is Apache AGE:** A PostgreSQL extension that adds graph database capabilities directly inside Postgres. It lets you run Cypher queries (the Neo4j graph query language) against data stored in regular Postgres tables. No separate graph database to deploy, backup, or manage. Your graph data gets the same backups and PITR as everything else — because it's just Postgres.

**What PAI can't do today:** Wisdom Frames track domain knowledge with confidence scores, and WisdomCrossFrameSynthesizer finds connections between frames. But there's no way to query causal chains: "What failures led to this learning?" "Which learnings apply to this project?" "What's the chain of decisions that led to this architectural pattern?"

**What the graph adds:**

```sql
-- Load the Apache AGE extension
CREATE EXTENSION IF NOT EXISTS age;
LOAD 'age';
SET search_path = ag_catalog, public;

-- Create the knowledge graph
SELECT create_graph('pai_knowledge');

-- Nodes are created from memory_objects by type
-- A trigger on memory_objects INSERT populates the graph

-- Example: find the causal chain behind a Wisdom Frame
SELECT * FROM cypher('pai_knowledge', $$
    MATCH path = (f:Failure)-[:LED_TO]->(l:Learning)-[:STRENGTHENED]->(w:WisdomFrame)
    WHERE w.domain = 'typescript'
    RETURN f.summary, l.content, w.title, length(path)
    ORDER BY length(path) DESC
$$) as (failure agtype, learning agtype, frame agtype, depth agtype);

-- Example: find all context relevant to a project
SELECT * FROM cypher('pai_knowledge', $$
    MATCH (p:Project {name: 'pai-sync'})-[r]-(n)
    RETURN type(r), labels(n), n.title
$$) as (relation agtype, node_type agtype, title agtype);

-- Example: find contradictions (implicit — complements OpinionTracker's explicit ones)
SELECT * FROM cypher('pai_knowledge', $$
    MATCH (a:Learning)-[:CONTRADICTS]->(b:Learning)
    WHERE a.confidence > 0.5 AND b.confidence > 0.5
    RETURN a.content, b.content, a.created_at, b.created_at
$$) as (learning_a agtype, learning_b agtype, date_a agtype, date_b agtype);
```

**Node types:** Learning, Failure, WisdomFrame, Project, Session, Tool, Language, Pattern
**Edge types:** LED_TO, GENERATED_FROM, APPLIES_TO, CONTRADICTS, SUPERSEDES, STRENGTHENED, USED_IN, RELATED_TO

**How the graph gets populated:**
1. Postgres trigger on `memory_objects` INSERT/UPDATE
2. Deterministic rules create nodes (type inferred from file path — `LEARNING/` → Learning node, `WORK/` → Project node, etc.)
3. Edges created by parsing metadata (session_id links Session→Learning, Failure→Learning edges created when a learning references a failure, etc.)
4. Phase 2a vector similarity creates RELATED_TO edges between semantically similar nodes
5. Contradiction detection creates CONTRADICTS edges

**This is what makes hybrid retrieval work for causal queries.** Vector search finds semantically similar content. The graph traverses causal chains that connect that content. Together they solve the relational-query-across-time problem that flat RAG can't touch.

**CLI:**
- `pai knowledge query "what failures led to learnings about TypeScript error handling"`
- `pai knowledge path <learning-key> <failure-key>` — show the causal chain between two nodes
- `pai knowledge related <key>` — show everything connected to a given node

**Additive to PAI:** Reads Wisdom Frame files that WisdomFrameUpdater already creates. Builds the graph from the Postgres system of record. WisdomCrossFrameSynthesizer continues doing its file-based cross-frame analysis independently. The graph adds queryable causal structure that file-based analysis can't provide.

### 2c. In-Database ML (pgml)

Run models directly in Postgres — no external service round-trips, no API costs for embeddings.

```sql
-- Generate embeddings at insert time — no external API call
CREATE OR REPLACE FUNCTION embed_on_insert()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO memory_vectors (source_key, source_type, chunk_text, embedding)
    VALUES (
        NEW.key,
        CASE WHEN NEW.key LIKE '%LEARNING%' THEN 'learning'
             WHEN NEW.key LIKE '%FAILURE%' THEN 'failure'
             WHEN NEW.key LIKE '%WISDOM%' THEN 'wisdom_frame'
             WHEN NEW.key LIKE '%WORK%' THEN 'prd'
             ELSE 'other' END,
        NEW.content,
        pgml.embed('intfloat/e5-small-v2', NEW.content)
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_embed_on_insert
    AFTER INSERT OR UPDATE ON memory_objects
    FOR EACH ROW EXECUTE FUNCTION embed_on_insert();
```

**Capabilities:**
- Embedding generation at insert time (no external API cost, no network latency)
- Classification (is this learning still relevant? what domain?) — feeds graph edge creation
- Sentiment analysis on failure transcripts (detect frustration patterns → flag for learning extraction)
- Summarization of failure clusters

**Additive to PAI:** Runs entirely inside Postgres. PAI tools never see it. Enriches the system of record automatically as new data arrives.

### 2d. Automated Failure Clustering

**What PAI can't do today:** Detect that failures #47, #112, and #203 are all the same root cause.

**What Postgres adds:**
```sql
-- Cluster similar failures using vector similarity
SELECT a.source_key, b.source_key,
       1 - (a.embedding <=> b.embedding) as similarity
FROM memory_vectors a
JOIN memory_vectors b ON a.source_type = 'failure' AND b.source_type = 'failure'
WHERE a.source_key < b.source_key
  AND 1 - (a.embedding <=> b.embedding) > 0.85;
```

- pg_cron job runs weekly
- Clusters failure embeddings by similarity
- AI summarizes each cluster: "Claude repeatedly fails at X when Y"
- Creates RELATED_TO and LED_TO edges in the knowledge graph
- Can auto-generate candidate learnings from repeated failure patterns

**Additive to PAI:** FailureCapture keeps writing context dumps. This analyzes the accumulated data in Postgres without touching the capture process.

### 2e. Predictive Failure Prevention

**What PAI can't do today:** Warn you before Claude makes a mistake it's made before. Wisdom Frames have a `## Predictive` section but nothing actively uses it.

**What Postgres adds:**

```sql
-- Hybrid query: similar past failures + graph context
SELECT mv.chunk_text as failure_context,
       mo.metadata->>'summary' as failure_summary,
       1 - (mv.embedding <=> $task_embedding) as similarity
FROM memory_vectors mv
JOIN memory_objects mo ON mv.source_key = mo.key
WHERE mv.source_type = 'failure'
  AND mo.deleted = FALSE
ORDER BY mv.embedding <=> $task_embedding
LIMIT 5;

-- Plus: graph query for related learnings that emerged from those failures
SELECT * FROM cypher('pai_knowledge', $$
    MATCH (f:Failure)-[:LED_TO]->(l:Learning)
    WHERE f.key IN $failure_keys
    RETURN l.content, l.confidence
$$) as (learning agtype, confidence agtype);
```

**CLI:** `pai predict "refactor the payment processing module"` → returns similar past failures AND the learnings that came from them.

**Additive to PAI:** Uses FailureCapture data that already exists in Postgres. Adds a query layer.

### 2f. Config/Prompt A/B Analysis

**What PAI can't do today:** Know whether a config change or new learning actually improved outcomes.

**What Postgres adds:**
- Temporal queries across version history: correlate config snapshots with rating trends
- `pai analyze config` → "After adding learning X on March 1, failure rate in TypeScript sessions dropped 35%"

**Additive to PAI:** Reads existing ratings and config version history from Postgres. Pure analysis.

---

## Phase 3: Cross-Machine and Real-Time

### 3a. Real-Time Cross-Machine Sync (LISTEN/NOTIFY)

```sql
CREATE OR REPLACE FUNCTION notify_sync_change()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('sync_changes', json_build_object(
        'key', NEW.key,
        'machine_id', NEW.machine_id,
        'updated_at', NEW.updated_at
    )::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sync_change_trigger
    AFTER INSERT OR UPDATE ON memory_objects
    FOR EACH ROW EXECUTE FUNCTION notify_sync_change();
```

Machines subscribe to `sync_changes` channel. When Machine A pushes, Machine B gets notified and can auto-pull specific changed files. Opt-in behavior — default is still manual pull.

**This is where Postgres as system of record really pays off:** Machine A writes a learning. Daemon pushes to Postgres. Postgres notifies Machine B. Machine B auto-pulls. Both machines have the learning. The filesystem on each machine is a working cache; Postgres is where the data actually lives and flows through.

---

## Phase 4: Windmill Autonomous Workflows

This is what makes PAI agentic. Phases 1-3 build the knowledge backbone (store, enrich, retrieve, serve). Phase 4 schedules the tools that already exist to run without human initiation — closing the learning loop.

**Why Windmill, not Arbol:** PAI's upstream project (danielmiessler/PAI) includes Arbol — a Cloudflare Workers execution layer for Action→Pipeline→Flow composition. Arbol was evaluated and rejected for this architecture. Windmill on EC2 (imladris-4) already provides everything Arbol does — cron scheduling, step chaining, monitoring UI, error handling — plus direct Postgres access and native PAI script execution that Cloudflare Workers cannot offer. The DevOps pipeline (`f/devops/`) already proves the pattern: 55+ scripts, 11 cron schedules, an agentic investigator using Bedrock Opus with 16+ tools. Phase 4 applies the same proven pattern to PAI memory.

### 4a. Filesystem-Based Autonomous Workflows (No Postgres dependency)

These PAI tools operate on `~/.claude/` files and can be scheduled immediately — before the sync daemon or Postgres schema are deployed.

**New Windmill folder:** `f/pai/` alongside existing `f/devops/` and `f/investigate/`.

| Workflow | PAI Tool | Schedule | What It Does |
|----------|----------|----------|-------------|
| `session_harvester.ts` | SessionHarvester.ts | Nightly | Extracts learnings from `projects/` transcripts into `LEARNING/` |
| `learning_synthesis.ts` | LearningPatternSynthesis.ts | Weekly | Aggregates ratings from `SIGNALS/` into pattern reports in `SYNTHESIS/` |
| `wisdom_cross_synthesis.ts` | WisdomCrossFrameSynthesizer.ts | Weekly | Finds cross-domain patterns across Wisdom Frames |
| `integrity_audit.ts` | IntegrityMaintenance.ts | Daily | 16 parallel checks for broken references, orphaned files, schema violations |
| `steering_rule_proposal.ts` | New (~50 lines) | Weekly | Reads `SYNTHESIS/` reports, proposes steering rule changes to a review queue |

**Implementation pattern:** Each Windmill script is a thin wrapper that shells out to the existing PAI tool via `bun run`:

```typescript
// f/pai/session_harvester.ts (Windmill script, native worker group)
export async function main() {
  const result = await Bun.spawn([
    "bun", "run", `${Bun.env.HOME}/.claude/PAI/Tools/SessionHarvester.ts`,
    "--recent", "20"
  ]);
  return { status: result.exitCode === 0 ? "success" : "failed", output: await new Response(result.stdout).text() };
}
```

**Why native worker group:** These scripts need filesystem access to `~/.claude/`. Windmill's native workers run directly on the EC2 host (not in Docker), so they can read and write PAI's memory files.

**Schedule configs:** Each workflow gets a `.schedule.yaml` alongside the script — same pattern as the existing DevOps schedules (`sdp_morning_summary_schedule.schedule.yaml`, etc.).

### 4b. Postgres-Backed Autonomous Workflows (Requires Phases 1-2)

Once the sync daemon is pushing to Postgres and Phase 2 capabilities are live, these workflows query Postgres directly for operations that can't be done on the filesystem.

| Workflow | Depends On | Schedule | What It Does |
|----------|-----------|----------|-------------|
| `entity_resolution_batch.ts` | Phase 2a (pgvector) + 2b (AGE) | Daily | Scans recent `memory_objects` for unresolved entity mentions, clusters via embedding similarity + pg_trgm, creates/merges canonical entity nodes |
| `failure_clustering.ts` | Phase 2d | Weekly | Clusters failure embeddings by similarity, AI-summarizes each cluster, creates knowledge graph edges |
| `contradiction_detection.ts` | Phase 2a + 2b | Weekly | Finds high-confidence learnings with contradicting embeddings, creates CONTRADICTS edges |
| `steering_rule_proposal_v2.ts` | Phase 2a | Weekly | Enhanced version: uses semantic search across all learnings (not just SYNTHESIS/ files) to propose behavioral changes with evidence |
| `rrf_index_refresh.ts` | Phase 2a + 1b | Daily | Pre-computes RRF rankings for common query patterns, updates materialized views |
| `knowledge_graph_maintenance.ts` | Phase 2b | Weekly | Prunes stale edges, recomputes confidence scores, identifies orphaned nodes |

**Implementation pattern:** These scripts query Postgres directly using Windmill's native Postgres resource:

```typescript
// f/pai/failure_clustering.ts (Windmill script)
import * as wmill from "windmill-client";

export async function main() {
  const db = await wmill.getResource("f/devops/pai_memory_db");

  // Find clusters of similar failures
  const clusters = await sql(db, `
    SELECT a.source_key, b.source_key,
           1 - (a.embedding <=> b.embedding) as similarity
    FROM memory_vectors a
    JOIN memory_vectors b ON a.source_type = 'failure' AND b.source_type = 'failure'
    WHERE a.source_key < b.source_key
      AND 1 - (a.embedding <=> b.embedding) > 0.85
  `);

  // AI-summarize each cluster via Bedrock
  for (const cluster of groupClusters(clusters)) {
    const summary = await investigateCluster(cluster);
    await sql(db, `SELECT record_learning($1, $2, 'failure_pattern')`,
      [summary.title, summary.content]);
  }

  return { clusters_found: clusters.length, learnings_created: /* ... */ };
}
```

### 4c. PAI Context in Agentic Workflows (Requires Phase 3c)

The final integration: every Windmill agentic workflow gets PAI's institutional knowledge via `assemble_context()`. This is already designed in the MCP server section — Phase 4c is the operational deployment.

```typescript
// Existing pattern (agentic_investigator.ts today):
const systemPrompt = "You are a DevOps investigator...";

// Phase 4c pattern (agentic_investigator.ts with PAI context):
const paiContext = await sql(db, "SELECT assemble_context($1, 'standard')", [taskDescription]);
const systemPrompt = paiContext.methodology + "\n\n" + paiContext.relevant_memory;
// Now Bedrock Opus has PAI's Algorithm, relevant learnings, failure history, and domain wisdom
```

**What changes:** Add `assemble_context()` preamble to existing agentic scripts (`agentic_investigator.ts`, future `agentic_consolidator.ts`). The DevOps investigator gets smarter because it learns from past investigations stored in Postgres.

### The Closed Loop

Phase 4 completes the autonomous cycle that the agentic assessment identified as missing:

```
PAI hooks capture learning/ratings/failures → filesystem
  → Sync daemon pushes to Postgres (Phase 1)
    → Postgres enriches: embeddings, graph, entity resolution (Phase 2)
      → Windmill workflows consolidate autonomously (Phase 4a/4b):
        SessionHarvester, LearningPatternSynthesis, failure clustering,
        contradiction detection, SteeringRuleProposal
          → Proposals written to review queue
            → Seth reviews, accepts/rejects
              → Accepted rules flow into steering rules
                → Loaded at next session start
                  → PAI behavior improves
                    → Better ratings
                      → (cycle continues)
```

**What's autonomous:** Everything between "filesystem" and "review queue." Windmill runs it on schedule. No human initiation required.

**What stays human:** Reviewing and accepting proposed changes. The quality gate is intentional — "permission to change yourself is permission to break yourself."

### Deployment Sequence

| Step | What | Depends On | Effort |
|------|------|-----------|--------|
| 1 | Create `f/pai/` folder in Windmill workspace | Nothing | Minutes |
| 2 | Deploy Phase 4a scripts (filesystem-based) | PAI tools exist on EC2 | Hours — thin wrappers around existing tools |
| 3 | Add cron schedules for Phase 4a | Step 2 | Minutes — `.schedule.yaml` files |
| 4 | Deploy Phase 4b scripts (Postgres-backed) | Phases 1-2 live | Days — new queries, Bedrock integration |
| 5 | Add `assemble_context()` to agentic scripts | Phase 3c live | Hours — preamble addition to existing scripts |

**Phase 4a can start today.** The PAI tools exist, Windmill is running, the native worker group has filesystem access. The only work is writing thin wrapper scripts and schedule configs.

---

## The Postgres Capability Surface

Once PAI's memory lives in PostgreSQL, it stops being a PAI-only store. It becomes a **general-purpose knowledge platform** that anything can reach — other AI agents, dashboards, APIs, automation pipelines, external services. This section catalogs every built-in and bolt-on Postgres capability and what it concretely enables for PAI memory.

### Built-in: Full-Text Search (tsvector/tsquery)

Postgres has a complete full-text search engine built in — not an extension, not a plugin. It parses text into lexemes, handles stemming (so "learning" matches "learned"), supports ranked results, and can weight different fields differently.

**What this enables:**

```sql
-- Add a tsvector column to memory_objects
ALTER TABLE memory_objects ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;

CREATE INDEX idx_objects_fts ON memory_objects USING GIN (search_vector);

-- Ranked full-text search across all memory
SELECT key, ts_rank(search_vector, query) as rank,
       ts_headline('english', content, query, 'MaxFragments=3') as snippet
FROM memory_objects, to_tsquery('english', 'typescript & error & handling') as query
WHERE search_vector @@ query
  AND deleted = FALSE
ORDER BY rank DESC
LIMIT 10;
```

**Why this matters beyond grep:** Grep is literal string matching. Full-text search understands language — it stems words, ignores stop words, ranks by relevance, and returns highlighted snippets. `grep "error handling"` misses "handled the error" and "error-handling." Full-text search catches all three and ranks them by how prominently they discuss the topic.

**This is the middle ground between grep and pgvector.** Grep is fast but dumb. pgvector is semantic but heavier. Full-text search is smart keyword search — free, built in, no model needed, and dramatically better than grep for finding things in a growing corpus.

```
Grep:       exact string match, no ranking, no stemming
FTS:        language-aware keyword search with ranking and snippets
pgvector:   semantic meaning search (no keyword overlap needed)
```

**CLI:** `pai memory find "error handling typescript"` — uses FTS, not vector search. Fast, free, no embedding model. Reserve `pai memory search` for semantic queries where keywords aren't enough.

### Built-in: JSONB Deep Querying

Every `metadata` column in our schema is JSONB. Postgres can query arbitrarily deep into JSON structures with operators and indexing.

**What this enables:**

```sql
-- Find all PRDs with effort_level XL
SELECT key, metadata->>'title' as title, updated_at
FROM memory_objects
WHERE metadata->>'effort_level' = 'XL'
  AND key LIKE 'MEMORY/WORK/%';

-- Find all ratings above 4 from the last month
SELECT content, metadata->>'rating' as rating, created_at
FROM memory_lines
WHERE file_key LIKE '%ratings.jsonl'
  AND (metadata->>'rating')::int >= 4
  AND created_at > NOW() - INTERVAL '1 month';

-- Find all learnings tagged with a specific domain
SELECT key, metadata->>'domain' as domain
FROM memory_objects
WHERE metadata @> '{"domain": "typescript"}';  -- containment query, uses GIN index

-- Aggregate: average rating by month
SELECT date_trunc('month', created_at) as month,
       AVG((metadata->>'rating')::numeric) as avg_rating,
       COUNT(*) as total_sessions
FROM memory_lines
WHERE file_key LIKE '%ratings.jsonl'
GROUP BY 1 ORDER BY 1;
```

**Why this matters:** PAI's JSONL files are opaque blobs on the filesystem. In Postgres, every field inside every JSON line is queryable, filterable, aggregatable, and indexable. The metadata we already extract on push becomes a first-class queryable dimension.

### Built-in: Window Functions and Temporal Analytics

Postgres window functions let you compute trends, running averages, percentiles, and comparisons across time — queries that are impossible with flat files.

**What this enables:**

```sql
-- Rating trend: 7-day rolling average
SELECT date_trunc('day', created_at) as day,
       AVG((metadata->>'rating')::numeric) OVER (
           ORDER BY date_trunc('day', created_at)
           ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
       ) as rolling_avg_rating
FROM memory_lines
WHERE file_key LIKE '%ratings.jsonl';

-- Failure frequency: are failures increasing or decreasing?
SELECT date_trunc('week', created_at) as week,
       COUNT(*) as failures,
       COUNT(*) - LAG(COUNT(*)) OVER (ORDER BY date_trunc('week', created_at)) as change_from_last_week
FROM memory_objects
WHERE key LIKE 'MEMORY/LEARNING/FAILURES/%'
GROUP BY 1;

-- Time between learning creation and PRD completion (how fast are lessons being applied?)
SELECT l.key as learning,
       p.key as prd,
       p.updated_at - l.created_at as time_to_apply
FROM memory_objects l
JOIN memory_objects p ON p.session_id = l.session_id
WHERE l.key LIKE '%LEARNING%'
  AND p.key LIKE '%WORK%'
  AND p.metadata->>'status' = 'completed';
```

**CLI:** `pai analyze trends` — are you getting better over time? Rating trajectory, failure frequency, learning accumulation rate.

### Built-in: Materialized Views (Pre-Computed Analytics)

Materialized views store the results of expensive queries and refresh on demand. Queries that would scan thousands of rows become instant lookups.

**What this enables:**

```sql
-- Pre-computed dashboard: refreshed by pg_cron daily
CREATE MATERIALIZED VIEW memory_dashboard AS
SELECT
    COUNT(*) FILTER (WHERE key LIKE 'MEMORY/WORK/%') as total_prds,
    COUNT(*) FILTER (WHERE key LIKE 'MEMORY/LEARNING/%') as total_learnings,
    COUNT(*) FILTER (WHERE key LIKE 'MEMORY/LEARNING/FAILURES/%') as total_failures,
    COUNT(*) FILTER (WHERE key LIKE 'MEMORY/WISDOM/%') as total_wisdom_frames,
    (SELECT AVG((metadata->>'rating')::numeric) FROM memory_lines WHERE file_key LIKE '%ratings.jsonl') as avg_rating,
    (SELECT COUNT(DISTINCT machine_id) FROM memory_objects) as machines,
    MAX(updated_at) as last_activity
FROM memory_objects
WHERE deleted = FALSE;

-- Pre-computed: learnings per domain with average confidence
CREATE MATERIALIZED VIEW learning_summary_by_domain AS
SELECT metadata->>'domain' as domain,
       COUNT(*) as learning_count,
       AVG((metadata->>'confidence')::numeric) as avg_confidence,
       MAX(updated_at) as last_updated
FROM memory_objects
WHERE key LIKE 'MEMORY/LEARNING/%'
  AND deleted = FALSE
GROUP BY 1;

-- Refresh daily via pg_cron
SELECT cron.schedule('refresh-dashboard', '0 6 * * *', 'REFRESH MATERIALIZED VIEW CONCURRENTLY memory_dashboard');
```

**Why this matters:** Dashboards and status queries become instant. `pai status` doesn't scan files — it reads a pre-computed view.

### Built-in: LISTEN/NOTIFY (Real-Time Event Stream)

Already in Phase 3a for cross-machine sync, but the capability is broader. LISTEN/NOTIFY is a **pub/sub system built into Postgres.** Any connected client can subscribe to channels and get real-time notifications when data changes.

**What this enables beyond cross-machine sync:**

```sql
-- Notify on any new learning
CREATE OR REPLACE FUNCTION notify_new_learning()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.key LIKE 'MEMORY/LEARNING/%' THEN
        PERFORM pg_notify('new_learning', json_build_object(
            'key', NEW.key,
            'domain', NEW.metadata->>'domain',
            'session_id', NEW.session_id
        )::text);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

**Subscribers can be anything:**
- A Slack bot that posts new learnings to a channel
- A dashboard that updates in real-time
- Another AI agent that reacts to new data
- A webhook dispatcher that triggers external workflows
- A monitoring system that alerts on failure spikes

### Built-in: Foreign Data Wrappers (FDW)

FDWs let Postgres query external data sources as if they were local tables. You write SQL, Postgres fetches from the external source transparently.

**What this enables:**

```sql
-- Query GitHub issues alongside PAI memory
CREATE EXTENSION postgres_fdw;

-- Connect to another Postgres database (or use specialized FDWs for other sources)
-- Example: cross-reference PAI learnings with external project data
SELECT l.key as learning, l.metadata->>'domain' as domain,
       ext.issue_title, ext.status
FROM memory_objects l
JOIN external_project_data ext ON ext.project_id = l.metadata->>'project_id'
WHERE l.key LIKE 'MEMORY/LEARNING/%';
```

**Available FDWs:**
- `postgres_fdw` — query other Postgres databases
- `mysql_fdw` — query MySQL databases
- `redis_fdw` — query Redis
- `file_fdw` — query CSV/log files as tables
- `oracle_fdw` — query Oracle databases

**Why this matters:** PAI memory can be enriched with or joined to external data without ETL pipelines. The data stays where it is; Postgres reaches out to it at query time.

### Built-in: Row-Level Security (RLS)

If PAI memory ever needs to be shared — with a team, with other AI agents, with a dashboard that's accessible to others — RLS controls who sees what at the database level.

**What this enables:**

```sql
-- Enable RLS on memory tables
ALTER TABLE memory_objects ENABLE ROW LEVEL SECURITY;

-- Policy: each user only sees their own data
CREATE POLICY user_isolation ON memory_objects
    USING (metadata->>'owner' = current_setting('app.current_user'));

-- Policy: shared learnings visible to all, personal notes private
CREATE POLICY learning_sharing ON memory_objects
    USING (
        metadata->>'owner' = current_setting('app.current_user')
        OR (key LIKE 'MEMORY/LEARNING/%' AND metadata->>'shared' = 'true')
    );
```

**Why this matters now:** Maybe it doesn't — PAI is single-user today. But the moment you want to share curated learnings with a team, or let another AI agent query a subset of your memory, or expose a read-only dashboard, RLS means you don't have to build access control. Postgres does it.

### Built-in: Logical Replication

Postgres can stream every change (INSERT, UPDATE, DELETE) to subscribers in real time. Not just notifications (LISTEN/NOTIFY) — the actual data.

**What this enables:**
- **Stream to a data warehouse** — replicate PAI memory to Redshift, BigQuery, or Snowflake for heavy analytics
- **Stream to Elasticsearch** — full-text search with more advanced NLP features
- **Stream to Kafka** — feed PAI memory changes into any event-driven architecture
- **Stream to another Postgres** — geographic replication, disaster recovery
- **Change Data Capture (CDC)** — any system that can consume a Postgres WAL stream can react to PAI memory changes

```sql
-- Create a publication for all memory changes
CREATE PUBLICATION pai_memory_changes FOR TABLE memory_objects, memory_lines;

-- Any subscriber can now receive real-time changes
-- Debezium, AWS DMS, pglogical, or native logical replication
```

**Why this matters:** PAI memory becomes a **data source** that other systems can subscribe to. It's not a silo — it's a publisher.

### Extension: pg_trgm (Trigram Fuzzy Matching)

Built-in trigram similarity for fuzzy text matching. Handles typos, partial matches, and approximate string comparison.

**What this enables:**

```sql
CREATE EXTENSION pg_trgm;

-- Create trigram index on content
CREATE INDEX idx_objects_trgm ON memory_objects USING GIN (content gin_trgm_ops);

-- Fuzzy search: find learnings even with typos or partial terms
SELECT key, similarity(content, 'typesript error handlling') as sim
FROM memory_objects
WHERE content % 'typesript error handlling'  -- % operator uses similarity threshold
ORDER BY sim DESC
LIMIT 10;

-- Find files with similar names
SELECT key FROM memory_objects
WHERE key % 'MEMEORY/LERNING/typescript'
ORDER BY similarity(key, 'MEMEORY/LERNING/typescript') DESC;
```

**Search stack with pg_trgm:**
```
Grep:       exact literal match
pg_trgm:    fuzzy/approximate match (handles typos)
FTS:        language-aware keyword search with stemming and ranking
pgvector:   semantic meaning search (no keyword overlap needed)
AGE graph:  relationship/causal chain traversal
```

Five levels of retrieval sophistication, all in one database, all queryable in a single SQL statement if needed.

### Extension: ltree (Hierarchical Path Queries)

PAI's memory is organized hierarchically: `MEMORY/LEARNING/SIGNALS/ratings.jsonl`. The `ltree` extension makes path hierarchies a first-class queryable data type.

**What this enables:**

```sql
CREATE EXTENSION ltree;

-- Add an ltree column derived from the key
ALTER TABLE memory_objects ADD COLUMN path_tree ltree
    GENERATED ALWAYS AS (replace(replace(key, '/', '.'), '.jsonl', '')) STORED;

CREATE INDEX idx_objects_ltree ON memory_objects USING GIST (path_tree);

-- Find everything under LEARNING
SELECT key FROM memory_objects WHERE path_tree <@ 'MEMORY.LEARNING';

-- Find all immediate children of WORK
SELECT key FROM memory_objects WHERE path_tree ~ 'MEMORY.WORK.*{1}';

-- Find all files at any depth that contain "typescript" in their path
SELECT key FROM memory_objects WHERE path_tree ~ '*.typescript.*';

-- Ancestor query: what's the parent structure of this file?
SELECT subpath(path_tree, 0, nlevel(path_tree) - 1) as parent
FROM memory_objects WHERE key = 'MEMORY/LEARNING/SIGNALS/ratings.jsonl';
```

**Why this matters:** PAI's directory structure is meaningful — it encodes type, category, and organization. ltree makes that structure queryable as a hierarchy, not just a string prefix match.

### Extension: pgcrypto (Encryption at Rest)

If PAI memory contains sensitive data — API keys seen in transcripts, personal notes, security audit trails — pgcrypto encrypts it at the column level inside Postgres.

**What this enables:**

```sql
CREATE EXTENSION pgcrypto;

-- Encrypt sensitive content before storage
UPDATE memory_objects
SET content = pgp_sym_encrypt(content, current_setting('app.encryption_key'))
WHERE key LIKE 'MEMORY/SECURITY/%';

-- Decrypt on read
SELECT pgp_sym_decrypt(content::bytea, current_setting('app.encryption_key'))
FROM memory_objects WHERE key = 'MEMORY/SECURITY/security-events.jsonl';
```

**Why this matters:** EBS volumes can be encrypted at the storage level (AES-256). pgcrypto adds **application-level encryption** — even a DBA with full database access can't read encrypted columns without the application key. Defense in depth for the security audit trail.

### Extension: pg_cron (Scheduled Jobs)

Cron jobs that run inside Postgres. No external scheduler needed.

**What this enables:**

```sql
CREATE EXTENSION pg_cron;

-- Weekly: cluster similar failures
SELECT cron.schedule('failure-clustering', '0 2 * * 0',
    $$SELECT cluster_similar_failures()$$);

-- Daily: refresh materialized views
SELECT cron.schedule('refresh-views', '0 6 * * *',
    $$REFRESH MATERIALIZED VIEW CONCURRENTLY memory_dashboard$$);

-- Daily: flag potentially stale learnings (no references in 90 days)
SELECT cron.schedule('stale-learning-check', '0 7 * * *',
    $$UPDATE memory_objects SET metadata = metadata || '{"potentially_stale": true}'
      WHERE key LIKE 'MEMORY/LEARNING/%'
      AND updated_at < NOW() - INTERVAL '90 days'
      AND NOT (metadata ? 'potentially_stale')$$);

-- Weekly: compute and store learning-to-failure correlation stats
SELECT cron.schedule('correlation-stats', '0 3 * * 1',
    $$INSERT INTO memory_analytics (metric, value, computed_at)
      SELECT 'learning_to_failure_ratio',
             (SELECT COUNT(*) FROM memory_objects WHERE key LIKE '%LEARNING%')::float /
             NULLIF((SELECT COUNT(*) FROM memory_objects WHERE key LIKE '%FAILURE%'), 0),
             NOW()$$);
```

**Why this matters:** Maintenance, analysis, and enrichment happen automatically inside the database. No external cron, no Lambda functions, no orchestration layer. The database takes care of itself.

### Extension: pg_net (HTTP Requests FROM Postgres)

Make HTTP calls directly from SQL. Postgres becomes an event source that can call external APIs.

**What this enables:**

```sql
-- On new failure: POST to a webhook
CREATE OR REPLACE FUNCTION notify_failure_webhook()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.key LIKE 'MEMORY/LEARNING/FAILURES/%' THEN
        PERFORM net.http_post(
            url := 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL',
            body := json_build_object(
                'text', format('New failure captured: %s', NEW.metadata->>'summary')
            )::text,
            headers := '{"Content-Type": "application/json"}'
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- On learning milestone: notify external system
-- Could be: update a Notion dashboard, post to Discord, trigger a CI pipeline, etc.
```

**Why this matters:** The database doesn't just store and query — it **acts**. Postgres can call any HTTP endpoint when data changes. No middleware, no Lambda, no message queue. Trigger → HTTP call → done.

### Extension: plv8 / plpython3u (JavaScript and Python in Postgres)

Run JavaScript or Python code directly inside Postgres stored procedures and triggers.

**What this enables:**

```sql
-- plv8: parse PAI's YAML frontmatter in JavaScript
CREATE OR REPLACE FUNCTION parse_frontmatter(content text)
RETURNS jsonb AS $$
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    const lines = match[1].split('\n');
    const result = {};
    for (const line of lines) {
        const [key, ...val] = line.split(':');
        if (key && val.length) result[key.trim()] = val.join(':').trim();
    }
    return result;
$$ LANGUAGE plv8;

-- plpython3u: call external AI APIs for enrichment
CREATE OR REPLACE FUNCTION summarize_failure(content text)
RETURNS text AS $$
    import requests
    response = requests.post('https://api.anthropic.com/v1/messages', ...)
    return response.json()['content'][0]['text']
$$ LANGUAGE plpython3u;
```

**Why this matters:** Complex metadata extraction, data transformation, and even AI API calls can run inside the database on triggers. The enrichment pipeline lives entirely in Postgres — no external services to deploy or manage.

### The External Access Pattern

This is the capability that changes the architectural picture entirely. Once PAI's memory is in Postgres, **anything that can connect to a database can query it.**

**Direct SQL access:**
- Any BI tool (Metabase, Grafana, Tableau, Looker) can visualize PAI memory trends
- Any script in any language can query PAI memory via a Postgres driver
- Another Claude Code instance on another machine can query the same database
- A mobile app could surface learnings on your phone

**API layer (PostgREST / pg_graphql):**

```
PostgreSQL
    |
    |-- PostgREST → instant REST API over any table/view
    |       GET /memory_objects?key=like.MEMORY/LEARNING/*&deleted=is.false
    |       GET /memory_lines?file_key=like.*ratings*&order=created_at.desc
    |
    |-- pg_graphql → instant GraphQL API over any table/view
    |       query { memoryObjects(filter: {key: {like: "MEMORY/LEARNING/%"}}) { key content metadata } }
```

**PostgREST** generates a full REST API from your Postgres schema with zero code. Every table, view, and function becomes an HTTP endpoint. Filtering, pagination, ordering, and embedding of related data — all automatic.

**What this unlocks:**
- **Other AI agents can query PAI memory.** A coding agent, a research agent, a planning agent — all can hit the REST/GraphQL API to retrieve relevant context. PAI's memory becomes a shared knowledge service, not a local file store.
- **Dashboards without a backend.** Point Grafana at the REST API. Instant visualization of rating trends, failure patterns, learning accumulation, everything.
- **Mobile/web interfaces.** A simple web app that shows your PAI memory, searchable and browsable, from any device.
- **Webhook consumers.** LISTEN/NOTIFY + pg_net means external systems get notified when PAI memory changes and can query back for details.
- **Multi-agent architectures.** Agent A (Claude Code) writes learnings. Agent B (a research agent) queries those learnings via the API before starting research. Agent C (a review agent) checks failure patterns before approving code. All reading from the same Postgres, none aware of each other.

### Capability Stack Summary

Everything below runs in a single self-hosted PostgreSQL 16+ instance. No external services except the sync daemon.

```
Layer 5: External Access
  PostgREST (REST API), pg_graphql (GraphQL API), Postgres drivers (any language),
  LISTEN/NOTIFY (pub/sub), logical replication (CDC/streaming), pg_net (outbound HTTP)

Layer 4: Intelligence
  pgml (in-database ML), pgvector (embeddings + similarity), Apache AGE (graph/Cypher)

Layer 3: Analysis
  Window functions (trends), materialized views (dashboards), pg_cron (scheduled jobs),
  temporal queries (version history correlation)

Layer 2: Search
  Full-text search (tsvector/tsquery), pg_trgm (fuzzy matching), JSONB operators (structured queries),
  ltree (hierarchical path queries)

Layer 1: Storage (System of Record)
  ACID transactions, pgBackRest to S3, PITR, automated backups,
  version history, soft deletes, compression, chunking

Layer 0: Security
  RLS (row-level security), pgcrypto (column-level encryption), SSL/TLS,
  IAM authentication, audit logging
```

**Total Postgres extensions used:** pgvector, Apache AGE, pgml, pg_cron, pg_trgm, ltree, pgcrypto, pg_net, plv8, PostgREST
**Total external services:** 1 (the sync daemon)
**Total lines of application backend code for the API layer:** 0 (PostgREST generates it from the schema)

---

## Capability Roadmap

| Phase | What | Postgres Feature | PAI Impact |
|-------|------|-----------------|------------|
| **1a** | Sync daemon + Postgres (system of record) | Core tables, version history, ACID, S3 backups | None — fully additive sidecar |
| **1b** | Full-text search + structured queries | tsvector, JSONB operators, ltree | New `pai memory find` (keyword) command |
| **1c** | Analytics + dashboard views | Window functions, materialized views, pg_cron | New `pai analyze trends` command |
| **2a** | Hybrid semantic search | pgvector + temporal metadata | New `pai memory search` (semantic) command |
| **2b** | Knowledge graph + causal retrieval | Apache AGE (Cypher in Postgres) | New `pai knowledge` commands |
| **2c** | In-database embeddings + classification | pgml | Automatic enrichment on insert |
| **2d** | Failure pattern clustering | pgvector + pg_cron | New `pai failures analyze` command |
| **2e** | Predictive failure prevention | pgvector + AGE hybrid | New `pai predict` command |
| **2f** | Config A/B analysis | Temporal queries on version history | New `pai analyze config` command |
| **3a** | Cross-machine real-time sync | LISTEN/NOTIFY | Opt-in auto-pull |
| **3b** | REST/GraphQL API layer | PostgREST, pg_graphql | External systems can query PAI memory |
| **3c** | PAI Knowledge MCP Server | MCP server + `assemble_context()` + Postgres functions + enforcement | Any MCP-compatible model reads methodology + knowledge, writes learnings back; server-side session gating via enforcement rules |
| **3c.1** | Full PAI component sync | All PAI docs (hooks, notifications, delegation, memory, flows, pipelines) + enforcement rules + hook rules + fabric registry synced to `pai_system` | Complete PAI methodology available to every model, not just Algorithm + skills |
| **3d** | Event-driven integrations | pg_net, logical replication | Webhooks, Slack notifications, CDC streams |
| **3e** | Security hardening | pgcrypto, RLS, pgaudit | Column-level encryption, access control, audit trail |
| **4a** | Windmill autonomous workflows (filesystem) | N/A — runs PAI tools on schedule | SessionHarvester, LearningPatternSynthesis, WisdomCrossFrameSynthesizer run autonomously |
| **4b** | Windmill autonomous workflows (Postgres) | Postgres queries + `assemble_context()` | Entity resolution batches, failure clustering, SteeringRuleProposal — closed learning loop |
| **4c** | Windmill PAI context integration | `assemble_context()` in agentic scripts | All Windmill agentic workflows get PAI institutional knowledge |

**Every phase is additive.** Each adds new `pai` commands, automatic enrichment, or external access. None modifies existing PAI hooks, tools, or file formats.

---

## Context Assembly: Embedding PAI Principles Into Any Model

Phase 3c describes multi-agent knowledge sharing — other models query PAI memory for data. But data without methodology is just retrieval. The Algorithm, Wisdom Frames, learnings, and PAI's accumulated operational principles aren't just data — they're **how PAI thinks.** If another model gets raw learnings without the Algorithm's decision framework, it has facts without judgment.

The insight: the Algorithm and all PAI principles already sync to Postgres as `memory_objects`. Postgres can assemble them into structured context. Any model that queries Postgres gets not just relevant data but the methodology to interpret it — assembled by the database, not hardcoded into any model's system prompt.

### The problem this solves

Today, PAI's intelligence is bound to Claude Code on Imladris. The Algorithm lives in CLAUDE.md. Wisdom Frames live in `~/.claude/MEMORY/WISDOM/`. Learnings live in `~/.claude/MEMORY/LEARNING/`. If you point Bedrock Opus at a task via Windmill's agentic orchestrator, it gets none of this. It's a capable model with no institutional memory and no methodology.

The current Windmill agentic pattern:
```
Bedrock Opus → tool-use loop → Windmill scripts → results
```

What it's missing:
```
Bedrock Opus → ??? → no Algorithm, no learnings, no wisdom frames, no failure history
```

### What Postgres adds: context assembly functions

Postgres functions that assemble structured context from PAI's stored principles, tailored to a task. Any LLM client calls a function and gets back a complete context block — methodology + relevant memory + domain knowledge — ready to inject into a system prompt.

> **Implementation:** The definitive `assemble_context()` function queries both `pai_system` (GitHub-sourced methodology) and `memory_objects` (sync daemon-sourced knowledge). See the [Three-Tier Implementation](#updated-assemble_context--now-reads-from-both-tables) section for the complete SQL function.

### How any model uses it

**Windmill agentic orchestrator (Bedrock Opus):**

The Windmill script that launches a Bedrock tool-use loop calls `assemble_context()` first. The returned methodology and relevant memory go into the system prompt. Bedrock Opus now has the Algorithm's decision framework, relevant learnings, domain wisdom, and failure history — assembled by Postgres from PAI's actual accumulated knowledge.

```python
# Windmill script: agentic_investigator with PAI context
import boto3, psycopg2

# 1. Ask Postgres to assemble context for this task
conn = psycopg2.connect(POSTGRES_URL)
ctx = conn.execute(
    "SELECT assemble_context(%s, 'standard')",
    [task_description]
).fetchone()[0]

# 2. Build system prompt with PAI methodology
system_prompt = f"""You are operating with the following methodology and institutional knowledge.

## Methodology
{ctx['methodology']}

## Relevant Learnings
{format_learnings(ctx['learnings'])}

## Domain Knowledge
{format_wisdom(ctx['wisdom_frames'])}

## Similar Past Failures (avoid these)
{format_failures(ctx['similar_failures'])}

Apply this methodology and knowledge to the task at hand."""

# 3. Bedrock Opus runs with full PAI context
bedrock = boto3.client('bedrock-runtime')
# ... tool-use loop with system_prompt injected
```

**PAI Knowledge MCP Server (any MCP-compatible model):**

Models connect to the PAI Knowledge MCP server and call `get_context` as a native tool — no HTTP glue code, no URL construction. The model discovers the tool, calls it, and gets assembled context. See the **PAI Knowledge MCP Server** section below for full tool definitions.

**PostgREST (non-model clients — dashboards, scripts, GitHub Actions):**
```
POST /rpc/assemble_context
{"task_description": "investigate why Lambda cold starts increased", "context_level": "standard"}
```

PostgREST remains for HTTP clients that aren't MCP-compatible. Dashboards, monitoring scripts, and the GitHub Action sync pipeline use REST. Models use MCP.

### Context levels

Not every query needs the full Algorithm. Context levels control the weight of what's returned:

| Level | Algorithm | Learnings | Wisdom Frames | Failures | Use case |
|-------|-----------|-----------|---------------|----------|----------|
| `minimal` | No | Top 5 | None | None | Quick lookups, simple queries |
| `standard` | Yes | Top 15 | Top 5 | Top 5 | Most agentic tasks, investigations |
| `full` | Yes | Top 30 | All relevant | Top 10 | Complex multi-step work, architecture decisions |

### What this means architecturally

```
Before:
  Claude Code (has Algorithm + memory)     →  PAI-aware
  Bedrock Opus via Windmill                →  no PAI context
  Any future model                         →  no PAI context

After:
  Claude Code (has Algorithm + memory)     →  PAI-aware (unchanged, + Knowledge MCP)
  Bedrock Opus via Windmill                →  connects to Knowledge MCP → PAI-aware
  Any future model                         →  connects to Knowledge MCP → PAI-aware
```

**The principles live in the database, not in any model.** The Algorithm evolves in one place (the file on disk, synced to Postgres). Wisdom Frames accumulate in one place. Learnings grow in one place. Any model pointed at Postgres inherits all of it — not by training, not by fine-tuning, but by context assembly at query time.

### What this breaks in PAI (and why it's worth it)

PAI's design assumes Claude Code is the only consumer of its memory. The Algorithm is instructions *to Claude*. Wisdom Frames are structured for Claude's context window. Making these available to other models means:

1. **The Algorithm becomes a protocol, not a prompt.** Today it's Claude-specific instructions. Once it's assembled into context for any model, it's a methodology specification that any sufficiently capable model can follow. This is a philosophical shift — PAI's methodology becomes transferable.

2. **Learnings become shared institutional memory.** Today, only Claude benefits from past failures and learnings. With context assembly, Bedrock Opus running an investigation also knows "don't retry this API more than 3 times — we learned that the hard way." The knowledge compounds across models.

3. **Wisdom Frames become a domain knowledge API.** Today they're files Claude reads. With context assembly, they're structured domain expertise that any model can query. The cross-frame synthesis that WisdomCrossFrameSynthesizer does on files? The graph version (Phase 2b) does it across models.

### Implementation

Phase 3c (PAI Knowledge MCP Server). Depends on:
- Phase 1a (data in Postgres)
- Phase 2a (pgvector embeddings for semantic matching)
- Phase 2c (pgml for embedding generation in the function)

The SQL functions live in schema migrations. The PAI Knowledge MCP Server (see below) exposes them as tools any model can discover and call. PostgREST (Phase 3b) provides HTTP access for non-model clients.

---

## PAI Principle Transferability Analysis

PAI is an interconnected system of 15+ component types. Not all of them can live in Postgres and be served to other models. This section classifies every PAI component by transferability — what moves cleanly into `assemble_context()`, what transfers partially, and what is permanently bound to Claude Code's runtime.

### Fully transferable (pure text/data — already syncs to Postgres)

These components are methodology, knowledge, or structured data. They work as context for any sufficiently capable model. No runtime dependency.

| Component | What it is | How it transfers |
|-----------|-----------|-----------------|
| **The Algorithm** | 7-phase execution framework (Observe → Think → Plan → Build → Execute → Verify → Learn) | Injected as methodology text via `assemble_context()`. Any model can follow the phases. |
| **AI Steering Rules** | 15+ behavioral rules (surgical fixes only, verify before asserting, read before modifying, etc.) | Injected as behavioral constraints. Model-agnostic — these are instructions any model can follow. |
| **Founding Principles** | 7 core philosophy statements (Scaffolding > Model, Code Before Prompts, Spec/Test/Evals First, etc.) | Injected as decision-making framework. Guides architectural choices regardless of model. |
| **Wisdom Frames** | Structured domain knowledge across expertise areas | Semantic search via pgvector finds relevant frames for the task. Pure knowledge transfer. |
| **Learnings** | Accumulated insights from past sessions, categorized by domain (SYSTEM, ALGORITHM, FAILURES) | Semantic search returns relevant learnings. Institutional memory, model-agnostic. |
| **TELOS** | Life operating system — goals, beliefs, challenges, mental models, wisdom | Personal context. Any model receiving this knows what matters to you and why. |
| **Failure history** | Context dumps from low-rated sessions with root cause analysis | Preventive knowledge — "here's what went wrong before in similar situations." |
| **PRD format specification** | How to structure work (frontmatter schema, ISC criteria format, verification evidence) | Work methodology. Any model can produce PRDs following this spec. |
| **Fabric patterns** | 237 reusable prompt patterns (`extract_wisdom`, `create_threat_model`, `analyze_claims`, etc.) | Each pattern is a `system.md` file — pure prompt text. Any model can execute any pattern. |
| **ISC decomposition methodology** | How to break requests into atomic, binary-testable criteria | Analytical methodology. Pure text instruction any model can follow. |
| **Context routing table** | Which PAI documents to load for which topic categories | Metadata about knowledge organization. Helps `assemble_context()` select relevant material. |
| **Agent personas** | Named agents with expertise, personality traits, and specialization definitions | Character definitions. Any model can adopt Serena Blackwood's architect perspective if given her definition. |

**Fabric deserves special attention.** The 237 patterns are the single most transferable PAI component. Each pattern is a self-contained `system.md` prompt — no Claude Code dependency, no runtime requirement. Store them in Postgres, add a function:

```sql
-- Get a Fabric pattern by name
CREATE OR REPLACE FUNCTION get_fabric_pattern(pattern_name TEXT)
RETURNS TEXT AS $$
    SELECT content FROM memory_objects
    WHERE key LIKE '%Fabric%' || pattern_name || '%'
      AND metadata->>'type' = 'fabric_pattern'
      AND NOT deleted
    ORDER BY updated_at DESC LIMIT 1;
$$ LANGUAGE sql;

-- Find relevant Fabric patterns for a task
CREATE OR REPLACE FUNCTION suggest_fabric_patterns(task_description TEXT, max_results INT DEFAULT 5)
RETURNS TABLE(pattern_name TEXT, relevance FLOAT, content TEXT) AS $$
DECLARE
    task_embedding vector(1536);
BEGIN
    task_embedding := pgml.embed('intfloat/e5-small-v2', task_description);

    RETURN QUERY
    SELECT
        mo.metadata->>'pattern_name',
        1 - (mv.embedding <=> task_embedding)::FLOAT,
        mo.content
    FROM memory_vectors mv
    JOIN memory_objects mo ON mv.source_key = mo.key
    WHERE mo.metadata->>'type' = 'fabric_pattern' AND NOT mo.deleted
    ORDER BY mv.embedding <=> task_embedding
    LIMIT max_results;
END;
$$ LANGUAGE plpgsql;
```

Now any model can ask Postgres: "what Fabric pattern should I use for this task?" and get the pattern content back, ready to apply. Bedrock Opus running an investigation through Windmill can use `extract_wisdom` or `create_threat_model` without knowing Fabric exists as a PAI skill — it just gets the prompt.

### Partially transferable (concept transfers, implementation doesn't)

These components have transferable ideas but Claude Code-specific implementations. The methodology moves; the machinery stays behind.

| Component | What transfers | What doesn't | How to bridge |
|-----------|---------------|-------------|---------------|
| **Skill routing** | The concept of matching task patterns to specialized workflows. The routing tables (trigger words → skill selection). | The Skill tool, SkillGuard hook, slash-command invocation, settings.json skill registry. | Store routing tables in Postgres. `assemble_context()` can include "for this type of task, use this approach" guidance. Not skill invocation — methodology guidance. |
| **Agent delegation model** | When to parallelize, model selection guidance (haiku for grunt work, sonnet for implementation, opus for reasoning), timing scopes. | Task tool spawning, Claude Code's agent team system, `run_in_background` parameter, agent lifecycle management. | Windmill handles its own orchestration. The *decision framework* for when to parallelize and which model to use transfers as methodology text. |
| **Rating/feedback system** | The concept of capturing satisfaction signals and learning from them. Rating history data. | RatingCapture hook intercepting UserPromptSubmit, stdin parsing for rating patterns, the hook's sentiment detection logic. | Other models write ratings back via `record_feedback()` (see write-back section below). The signal accumulation works regardless of capture mechanism. |
| **Context routing** | The principle of loading only relevant context for the current task. The routing table mapping topics to document sets. | The implementation (LoadContext hook reading files, CLAUDE.md template generation, BuildCLAUDE.ts). | This IS what `assemble_context()` does — context routing implemented as a Postgres function instead of a file-loading hook. The concept already transferred. |
| **PRD workflow** | The practice of maintaining a single source of truth document with ISC criteria, progress tracking, and verification evidence. | PRD file creation/update via Write/Edit tools, PRDSync hook, frontmatter parsing, work.json state tracking. | Other models can write PRD-structured data back to Postgres. The PRD *practice* is methodology; the PRD *file management* is Claude Code. |

### Not transferable (bound to Claude Code runtime)

These components depend on Claude Code's execution model — its tool pipeline, session lifecycle, hook system, or terminal integration. They cannot be extracted into Postgres or served to other models.

| Component | Why it's bound | What it provides that's lost |
|-----------|---------------|----------------------------|
| **Skills (execution)** | The Skill tool is a Claude Code primitive. Skills invoke via slash commands processed by Claude Code's prompt system. SkillGuard validates invocations via PreToolUse hooks. The entire skill *execution* pipeline is Claude Code's runtime. | Ability to say "/research deep" and get a multi-agent research workflow. Other models would need their own orchestration (Windmill provides this). |
| **Hooks (all 21)** | Hooks intercept Claude Code's session lifecycle events (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd). They receive event payloads via stdin and return decisions via stdout/exit codes. This is Claude Code's plugin architecture. | Automatic rating capture, security validation, tab management, session naming, learning extraction, integrity checks — all the "between the lines" automation. |
| **Service MCP servers** | Claude Code's existing MCP servers for external services (Cloudflare, Bright Data, Apify). The tool-use loop, permission model, and server lifecycle are Claude Code internals. **Note:** this refers to *service-specific* MCP servers, not the PAI Knowledge MCP Server — which is specifically designed to be model-agnostic. | Direct tool access to external services. Other models need their own tool integration (Windmill scripts, Bedrock tool-use) for these specific services. |
| **Settings.json** | Claude Code configuration format. Controls permissions, hooks, environment variables, MCP servers, experimental features. | Centralized configuration. Other models need their own config (Windmill workspace settings, Bedrock invocation parameters). |
| **Terminal integration** | Kitty terminal tab colors, titles, environment persistence. Hooks that manipulate the terminal are meaningless outside Claude Code on a local machine. | Visual feedback during work. Irrelevant for headless/API model execution. |
| **Voice/notification hooks** | VoiceCompletion, UpdateTabTitle hooks that call localhost:8888 for TTS. Tied to the local ElevenLabs/Qwen3-TTS server running on Imladris. | Audible status updates. Could be reimplemented in Windmill (call the same TTS endpoint), but the hook trigger mechanism doesn't transfer. |
| **Session lifecycle** | The concept of a "session" with start/end events, context injection at start, learning extraction at end. Claude Code manages this lifecycle. | Automatic context loading and learning capture. Other models need explicit orchestration for session boundaries. |

### The hierarchy of what matters

Not all components are equally important for making another model "PAI-aware." Here's what matters most, ranked:

```
Critical (makes the model think like PAI):
  1. The Algorithm           — decision framework, the HOW of everything
  2. AI Steering Rules       — behavioral constraints, the BOUNDARIES
  3. Relevant learnings      — institutional memory, what WORKED and DIDN'T
  4. Relevant wisdom frames  — domain expertise, the WHAT about this topic
  5. Failure history         — predictive avoidance, what to WATCH OUT FOR

Valuable (enriches context):
  6. Founding Principles     — philosophical orientation
  7. TELOS                   — personal goals and values
  8. Fabric patterns         — reusable analytical lenses
  9. Agent personas          — specialized perspectives
 10. ISC methodology         — work decomposition approach

Nice to have (operational detail):
 11. PRD format spec         — work structure convention
 12. Context routing table   — knowledge organization metadata
 13. Skill routing tables    — task-pattern matching guidance
 14. Delegation framework    — parallelization decisions
```

Items 1-5 are what `assemble_context('standard')` returns. Items 6-10 are added at `assemble_context('full')`. Items 11-14 are metadata that helps the function itself make better selections.

### Write-back: other models contributing to PAI memory

The context assembly section describes one direction — Postgres serves PAI knowledge to other models. But the real power is bidirectional: **other models write back.** Bedrock Opus discovers something during a Windmill investigation. That learning should flow back into Postgres so that Claude Code — and every other model — benefits on the next query.

#### Write-back functions

```sql
-- Record a learning from any model
CREATE OR REPLACE FUNCTION record_learning(
    learning_content TEXT,
    domain TEXT,              -- 'SYSTEM', 'ALGORITHM', 'INFRASTRUCTURE', etc.
    source_model TEXT,        -- 'bedrock-opus', 'claude-code', 'gemini', etc.
    source_context TEXT,      -- what task produced this learning
    confidence TEXT DEFAULT 'medium'  -- 'low', 'medium', 'high'
) RETURNS TEXT AS $$
DECLARE
    learning_key TEXT;
    learning_embedding vector(1536);
BEGIN
    learning_key := 'learning/' || domain || '/' || NOW()::DATE || '/' || gen_random_uuid();

    -- Generate embedding for semantic dedup and retrieval
    learning_embedding := pgml.embed('intfloat/e5-small-v2', learning_content);

    -- Check for semantic duplicates (>0.92 similarity = likely duplicate)
    IF EXISTS (
        SELECT 1 FROM memory_vectors mv
        JOIN memory_objects mo ON mv.source_key = mo.key
        WHERE mv.source_type = 'learning'
          AND NOT mo.deleted
          AND 1 - (mv.embedding <=> learning_embedding) > 0.92
    ) THEN
        RETURN 'duplicate_detected';
    END IF;

    -- Insert the learning
    INSERT INTO memory_objects (key, content, metadata, source, created_at, updated_at)
    VALUES (
        learning_key,
        learning_content,
        jsonb_build_object(
            'domain', domain,
            'confidence', confidence,
            'source_model', source_model,
            'source_context', source_context,
            'status', 'active',
            'origin', 'model_writeback'
        ),
        source_model,
        NOW(), NOW()
    );

    -- Store embedding
    INSERT INTO memory_vectors (source_key, source_type, embedding)
    VALUES (learning_key, 'learning', learning_embedding);

    RETURN learning_key;
END;
$$ LANGUAGE plpgsql;

-- Record a failure from any model
CREATE OR REPLACE FUNCTION record_failure(
    failure_summary TEXT,
    failure_context TEXT,     -- what was being attempted
    root_cause TEXT,          -- why it failed
    source_model TEXT,
    task_description TEXT DEFAULT NULL
) RETURNS TEXT AS $$
DECLARE
    failure_key TEXT;
BEGIN
    failure_key := 'failure/' || NOW()::DATE || '/' || gen_random_uuid();

    INSERT INTO memory_objects (key, content, metadata, source, created_at, updated_at)
    VALUES (
        failure_key,
        failure_context,
        jsonb_build_object(
            'summary', failure_summary,
            'root_cause', root_cause,
            'source_model', source_model,
            'task', task_description,
            'origin', 'model_writeback'
        ),
        source_model,
        NOW(), NOW()
    );

    INSERT INTO memory_vectors (source_key, source_type, embedding)
    VALUES (failure_key, 'failure', pgml.embed('intfloat/e5-small-v2', failure_summary || ' ' || failure_context));

    RETURN failure_key;
END;
$$ LANGUAGE plpgsql;

-- Record feedback/rating from any interaction
CREATE OR REPLACE FUNCTION record_feedback(
    rating INTEGER,           -- 1-10
    context TEXT,             -- what was being done
    source_model TEXT,
    feedback_text TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    INSERT INTO memory_objects (key, content, metadata, source, created_at, updated_at)
    VALUES (
        'signal/rating/' || NOW()::DATE || '/' || gen_random_uuid(),
        COALESCE(feedback_text, ''),
        jsonb_build_object(
            'type', 'rating',
            'rating', rating,
            'context', context,
            'source_model', source_model,
            'origin', 'model_writeback'
        ),
        source_model,
        NOW(), NOW()
    );
END;
$$ LANGUAGE plpgsql;
```

#### The virtuous cycle

```
                    ┌─────────────────────┐
                    │      Postgres       │
                    │  (PAI knowledge)    │
                    │                     │
          ┌────────┤  assemble_context()  ├────────┐
          │        │  record_learning()   │        │
          │        │  record_failure()    │        │
          │        └──────────┬──────────┘        │
          │                   │                    │
     READ │              READ │ WRITE         READ │ WRITE
          │                   │                    │
          ▼                   ▼                    ▼
   ┌─────────────┐   ┌──────────────┐    ┌──────────────┐
   │ Claude Code │   │ Bedrock Opus │    │  Future      │
   │ (Imladris)  │   │ (Windmill)   │    │  Model N     │
   └─────────────┘   └──────────────┘    └──────────────┘
          │                   │                    │
          └───── WRITE ───────┴──── WRITE ─────────┘
```

Claude Code discovers a pattern. Writes it to Postgres (via the sync daemon). Bedrock Opus picks it up next time `assemble_context()` runs. Bedrock Opus discovers something else. Writes it back via `record_learning()`. Claude Code's next sync pulls it into the local memory files. Every model teaches every other model, Postgres is the shared knowledge base.

#### Write-back provenance

Every write-back record includes `origin: 'model_writeback'` and `source_model` in metadata. This matters for:

- **Trust weighting.** Claude Code learnings (from direct human-supervised sessions) might carry higher confidence than unsupervised Bedrock learnings. `assemble_context()` can weight by source when ranking results.
- **Audit trail.** You can see which model contributed what knowledge. Query `WHERE metadata->>'source_model' = 'bedrock-opus'` to see what Bedrock has learned independently.
- **Dedup across models.** The semantic similarity check (>0.92) in `record_learning()` prevents two models from recording the same insight independently. First one in wins.
- **Sync direction.** The sync daemon needs to handle write-back records: Postgres → local files for Claude Code to see model-contributed learnings. This is the reverse of the normal sync direction but uses the same mechanism.

#### PostgREST endpoints for write-back

```
POST /rpc/record_learning
{"learning_content": "Lambda cold starts increase 3x when...",
 "domain": "INFRASTRUCTURE", "source_model": "bedrock-opus",
 "source_context": "investigating Lambda latency spike"}

POST /rpc/record_failure
{"failure_summary": "Assumed SQS FIFO ordering was per-queue",
 "failure_context": "...", "root_cause": "Ordering is per-message-group-id",
 "source_model": "bedrock-opus"}

POST /rpc/record_feedback
{"rating": 8, "context": "infrastructure investigation",
 "source_model": "bedrock-opus"}
```

Any Windmill script, any API client, any model wrapper. One HTTP call to contribute back to PAI's knowledge base.

### What this means for skills specifically

Skills **cannot** transfer as executable capabilities. But the intelligence inside them can:

| Skill aspect | Transferable via Postgres? | Mechanism |
|-------------|--------------------------|-----------|
| SKILL.md trigger definitions | Yes — as task-pattern matching guidance | Store routing tables, include in `assemble_context()` as "for X type of task, consider Y approach" |
| Workflow instructions (the actual methodology in each SKILL.md) | Yes — as procedural knowledge | The step-by-step instructions in each skill are text. A model receiving "for security recon, follow these steps: 1. enumerate subdomains..." can execute those steps using its own tool-use. |
| Fabric patterns (237 system.md files) | Yes — fully, as reusable prompts | `get_fabric_pattern()` and `suggest_fabric_patterns()` functions serve them directly. |
| Skill invocation (`/research deep`) | No | Claude Code's Skill tool. Other models need their own invocation mechanism (Windmill workflow triggers, API parameters). |
| SkillGuard validation | No | PreToolUse hook. Other models need their own validation (Windmill input validation, API-level checks). |
| Sub-skill routing (parent → child skill dispatch) | Partially — as decision guidance | The routing *logic* (if task matches pattern X, use approach Y) transfers as text. The routing *mechanism* (Skill tool dispatching to sub-skill files) doesn't. |

The practical implication: a Bedrock Opus agent running via Windmill won't "invoke the Research skill." But it can receive the Research skill's methodology ("for extensive research: 1. formulate key questions, 2. search across N sources, 3. cross-reference findings, 4. synthesize with counter-evidence...") as part of its assembled context and follow that methodology with its own tool-use loop.

**Skills become methodology documentation, not executable capabilities.** The capability execution shifts to whatever orchestration layer the model uses (Windmill, Bedrock tool-use, custom scripts). The *how to think about the task* stays in Postgres.

---

## Three-Tier Implementation: How PAI Principles Actually Land in Postgres

The transferability analysis identifies *what* transfers. This section specifies *how* — the schema, the sync pipelines, and the GitHub integration that keeps Postgres current as PAI evolves.

### The two data flows

PAI has two fundamentally different kinds of data, and they come from different places:

```
Data Flow 1: User-generated memory (already designed)
  ~/.claude/MEMORY/ → inotify → sync daemon → memory_objects table
  Learnings, wisdom frames, ratings, session artifacts, PRDs, TELOS
  Changes: every session, driven by user activity
  Source of truth: filesystem (written by hooks), backed by Postgres

Data Flow 2: System methodology (NEW — this section)
  GitHub PAI repo → webhook/action → pai_system table
  Algorithm, Steering Rules, Founding Principles, Fabric patterns,
  skill methodologies, agent personas, ISC spec, context routing
  Changes: on PAI releases, driven by development
  Source of truth: GitHub repo
```

Data Flow 1 is the sync daemon. It's fully designed in this spec. Data Flow 2 is new — PAI's own operating principles, versioned in GitHub, need to land in Postgres so `assemble_context()` can serve them to any model.

### Schema: `pai_system` table

User-generated memory lives in `memory_objects`. System methodology lives in a dedicated table — different lifecycle, different source, different access patterns.

```sql
-- PAI system methodology — the principles, patterns, and practices
-- that define how PAI thinks. Synced from GitHub, not from user sessions.
CREATE TABLE pai_system (
    -- Identity
    key             TEXT PRIMARY KEY,        -- e.g., 'algorithm/v3.7.0', 'fabric/extract_wisdom'
    component_type  TEXT NOT NULL,           -- see component_type enum below
    name            TEXT NOT NULL,           -- human-readable: 'The Algorithm v3.7.0'

    -- Content
    content         TEXT NOT NULL,           -- full text of the component
    content_hash    TEXT NOT NULL,           -- SHA-256 for change detection

    -- Metadata
    metadata        JSONB DEFAULT '{}'::jsonb,  -- component-specific metadata
    --   algorithm:     {version, phases, phase_count}
    --   fabric:        {category, pattern_name, description}
    --   skill:         {category, parent_skill, triggers, sub_skills}
    --   steering_rule: {rule_number, severity}
    --   principle:     {principle_number}
    --   agent_persona: {expertise, personality_traits}

    -- Provenance
    repo_path       TEXT NOT NULL,           -- path in GitHub repo: '.claude/PAI/Algorithm/v3.7.0.md'
    commit_sha      TEXT,                    -- Git commit that introduced this version
    repo_version    TEXT,                    -- PAI release version: 'v4.0.3'

    -- Lifecycle
    is_active       BOOLEAN DEFAULT TRUE,    -- FALSE for superseded versions
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Component types
COMMENT ON COLUMN pai_system.component_type IS
    'Valid types: algorithm, steering_rule, founding_principle, fabric_pattern, '
    'skill_methodology, agent_persona, isc_spec, context_routing, prd_spec, telos_framework, '
    'hook_system, enforcement_rules, hook_rules, fabric_registry, notification_system, '
    'memory_system, delegation_system, flow_system, pipeline_system';

-- Indexes for common access patterns
CREATE INDEX idx_pai_system_type ON pai_system(component_type);
CREATE INDEX idx_pai_system_active ON pai_system(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_pai_system_type_active ON pai_system(component_type, is_active) WHERE is_active = TRUE;
CREATE INDEX idx_pai_system_metadata ON pai_system USING GIN(metadata);

-- Embeddings for semantic search across system components
-- Uses the existing memory_vectors table with source_type = 'system'
-- Populated by the same embedding pipeline (Phase 2a/2c)
```

### What goes where: component mapping

Every transferable PAI component maps to a specific `component_type` and a specific path in the GitHub repo.

```
GitHub repo path                                    → component_type        → key pattern
─────────────────────────────────────────────────────────────────────────────────────────────
.claude/PAI/Algorithm/v3.7.0.md                     → algorithm             → algorithm/v3.7.0
.claude/PAI/AISteeringRules.md (each rule)          → steering_rule         → steering_rule/001..015
.claude/PAI/FoundingPrinciples.md (each principle)  → founding_principle    → founding_principle/001..007
.claude/skills/*/SKILL.md (methodology text)        → skill_methodology     → skill/Security, skill/Research, ...
.claude/skills/Utilities/Fabric/Patterns/*/system.md→ fabric_pattern        → fabric/extract_wisdom, fabric/summarize, ...
.claude/PAI/PAIAGENTSYSTEM.md (persona definitions) → agent_persona         → agent/serena_blackwood, agent/kai_chen, ...
.claude/PAI/ISCDecomposition.md                     → isc_spec              → isc_spec/current
.claude/PAI/ContextRouting.md                       → context_routing       → context_routing/current
.claude/PAI/PRDFormat.md                            → prd_spec              → prd_spec/current
.claude/PAI/TELOS/ (framework, not personal data)   → telos_framework       → telos_framework/current
.claude/PAI/THEHOOKSYSTEM.md                        → hook_system           → hook_system/current
gateway/enforcement.yaml (or PAI repo equivalent)   → enforcement_rules     → enforcement/current
gateway/hooks.yaml (declarative hook rules)         → hook_rules            → hook_rules/current
fabric/registry.yaml (repo & relationship map)      → fabric_registry       → fabric_registry/current
.claude/PAI/THENOTIFICATIONSYSTEM.md                → notification_system   → notification_system/current
.claude/PAI/MEMORYSYSTEM.md                         → memory_system         → memory_system/current
.claude/PAI/THEDELEGATIONSYSTEM.md                  → delegation_system     → delegation_system/current
.claude/PAI/FLOWS.md                                → flow_system           → flow_system/current
.claude/PAI/PIPELINES.md                            → pipeline_system       → pipeline_system/current
```

### Version management

PAI evolves. The Algorithm goes from v3.5.0 to v3.7.0. Fabric gets new patterns. Skills get refined. Postgres needs to track this:

```sql
-- Version history for system components (parallel to memory_object_versions)
CREATE TABLE pai_system_versions (
    key             TEXT NOT NULL,
    version         INTEGER NOT NULL,
    content         TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    commit_sha      TEXT,
    repo_version    TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (key, version)
);

-- Trigger: before UPDATE on pai_system, copy old row to versions
CREATE OR REPLACE FUNCTION pai_system_version_trigger()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.content_hash != NEW.content_hash THEN
        INSERT INTO pai_system_versions (key, version, content, content_hash, commit_sha, repo_version)
        SELECT OLD.key,
               COALESCE((SELECT MAX(version) FROM pai_system_versions WHERE key = OLD.key), 0) + 1,
               OLD.content, OLD.content_hash, OLD.commit_sha, OLD.repo_version;
        NEW.updated_at := NOW();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pai_system_version_on_update
    BEFORE UPDATE ON pai_system
    FOR EACH ROW EXECUTE FUNCTION pai_system_version_trigger();
```

Every update to a system component preserves the previous version. You can see how the Algorithm evolved, when a Fabric pattern was refined, what a skill's methodology looked like three releases ago.

### GitHub → Postgres sync pipeline

This is the mechanism that keeps Postgres current as PAI evolves. Three options, in order of preference:

#### Option 1: GitHub Action (recommended)

A GitHub Action in the PAI repo that runs on every push to `main`. It reads changed files, determines component types, and upserts to Postgres via PostgREST.

```yaml
# .github/workflows/sync-to-postgres.yml
name: Sync PAI System to Postgres

on:
  push:
    branches: [main]
    paths:
      - '.claude/PAI/**'
      - '.claude/skills/**'

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2  # Need previous commit for diff

      - name: Identify changed components
        id: changes
        run: |
          # Get changed files
          git diff --name-only HEAD~1 HEAD > changed_files.txt

          # Categorize changes
          echo "algorithm=$(grep -c 'PAI/Algorithm/' changed_files.txt || true)" >> $GITHUB_OUTPUT
          echo "steering=$(grep -c 'AISteeringRules' changed_files.txt || true)" >> $GITHUB_OUTPUT
          echo "principles=$(grep -c 'FoundingPrinciples' changed_files.txt || true)" >> $GITHUB_OUTPUT
          echo "skills=$(grep -c 'skills/.*/SKILL.md' changed_files.txt || true)" >> $GITHUB_OUTPUT
          echo "fabric=$(grep -c 'Fabric/Patterns/.*/system.md' changed_files.txt || true)" >> $GITHUB_OUTPUT

      - name: Sync changed components to Postgres
        env:
          POSTGREST_URL: ${{ secrets.POSTGREST_URL }}
          POSTGREST_TOKEN: ${{ secrets.POSTGREST_TOKEN }}
          COMMIT_SHA: ${{ github.sha }}
        run: |
          #!/bin/bash
          # Sync script: reads changed files, upserts to Postgres via PostgREST

          REPO_VERSION=$(grep 'version:' .claude/PAI/VERSION || echo "unknown")

          sync_component() {
            local file_path="$1"
            local component_type="$2"
            local key="$3"
            local name="$4"
            local metadata="$5"

            local content
            content=$(cat "$file_path")
            local content_hash
            content_hash=$(sha256sum "$file_path" | cut -d' ' -f1)

            # Upsert via PostgREST (ON CONFLICT UPDATE)
            curl -s -X POST "${POSTGREST_URL}/pai_system" \
              -H "Authorization: Bearer ${POSTGREST_TOKEN}" \
              -H "Content-Type: application/json" \
              -H "Prefer: resolution=merge-duplicates" \
              -d "$(jq -n \
                --arg key "$key" \
                --arg type "$component_type" \
                --arg name "$name" \
                --arg content "$content" \
                --arg hash "$content_hash" \
                --argjson meta "$metadata" \
                --arg path "$file_path" \
                --arg sha "$COMMIT_SHA" \
                --arg ver "$REPO_VERSION" \
                '{key: $key, component_type: $type, name: $name,
                  content: $content, content_hash: $hash,
                  metadata: $meta, repo_path: $path,
                  commit_sha: $sha, repo_version: $ver, is_active: true}'
              )"
          }

          # Sync Algorithm
          for f in .claude/PAI/Algorithm/v*.md; do
            [ -f "$f" ] || continue
            ver=$(basename "$f" .md)
            sync_component "$f" "algorithm" "algorithm/$ver" "The Algorithm $ver" '{"version":"'"$ver"'"}'
          done

          # Sync Fabric patterns
          for f in .claude/skills/Utilities/Fabric/Patterns/*/system.md; do
            [ -f "$f" ] || continue
            pattern=$(basename "$(dirname "$f")")
            sync_component "$f" "fabric_pattern" "fabric/$pattern" "$pattern" \
              '{"pattern_name":"'"$pattern"'","category":"fabric"}'
          done

          # Sync skill methodologies
          for f in .claude/skills/*/SKILL.md; do
            [ -f "$f" ] || continue
            skill=$(basename "$(dirname "$f")")
            sync_component "$f" "skill_methodology" "skill/$skill" "$skill Skill" \
              '{"category":"'"$skill"'"}'
          done

          echo "Sync complete: $(date -u)"
```

**Why GitHub Action is the right choice:**
- Runs in the PAI repo's CI/CD pipeline — no additional infrastructure
- Triggers on the exact paths that matter (`.claude/PAI/**`, `.claude/skills/**`)
- Uses `fetch-depth: 2` to diff only changed files — doesn't re-sync unchanged components
- PostgREST upsert with `resolution=merge-duplicates` — idempotent, safe to re-run
- The version trigger captures old content before overwriting — automatic version history

#### Option 2: Windmill webhook receiver (alternative)

If PostgREST isn't exposed to GitHub Actions (security concern — it's on a private network), use Windmill as the intermediary:

```
GitHub push → GitHub webhook → Windmill webhook endpoint → Windmill script → Postgres
```

```python
# Windmill script: pai_system_sync (triggered by GitHub webhook)
import psycopg2, hashlib, json

def main(payload: dict):
    """Receives GitHub push webhook, syncs changed PAI components to Postgres."""
    conn = psycopg2.connect(POSTGRES_URL)
    cur = conn.cursor()

    commits = payload.get('commits', [])
    changed_files = set()
    for commit in commits:
        changed_files.update(commit.get('added', []))
        changed_files.update(commit.get('modified', []))

    commit_sha = payload.get('after', '')
    repo_version = get_repo_version(payload)

    for file_path in changed_files:
        component = classify_file(file_path)
        if component is None:
            continue  # not a PAI system file

        content = fetch_file_from_github(file_path, commit_sha)
        content_hash = hashlib.sha256(content.encode()).hexdigest()

        cur.execute("""
            INSERT INTO pai_system (key, component_type, name, content, content_hash,
                                    metadata, repo_path, commit_sha, repo_version)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (key) DO UPDATE SET
                content = EXCLUDED.content,
                content_hash = EXCLUDED.content_hash,
                commit_sha = EXCLUDED.commit_sha,
                repo_version = EXCLUDED.repo_version
            WHERE pai_system.content_hash != EXCLUDED.content_hash
        """, [component['key'], component['type'], component['name'],
              content, content_hash, json.dumps(component['metadata']),
              file_path, commit_sha, repo_version])

    conn.commit()
    return {"synced": len(changed_files), "commit": commit_sha}


def classify_file(path: str) -> dict | None:
    """Maps a repo file path to a pai_system component."""
    if 'PAI/Algorithm/' in path and path.endswith('.md'):
        ver = path.split('/')[-1].replace('.md', '')
        return {'key': f'algorithm/{ver}', 'type': 'algorithm',
                'name': f'The Algorithm {ver}', 'metadata': {'version': ver}}

    if 'Fabric/Patterns/' in path and path.endswith('system.md'):
        pattern = path.split('/')[-2]
        return {'key': f'fabric/{pattern}', 'type': 'fabric_pattern',
                'name': pattern, 'metadata': {'pattern_name': pattern}}

    if '/skills/' in path and path.endswith('SKILL.md'):
        skill = path.split('/skills/')[1].split('/')[0]
        return {'key': f'skill/{skill}', 'type': 'skill_methodology',
                'name': f'{skill} Skill', 'metadata': {'category': skill}}

    if 'AISteeringRules' in path:
        return {'key': 'steering_rules/current', 'type': 'steering_rule',
                'name': 'AI Steering Rules', 'metadata': {}}

    if 'FoundingPrinciples' in path:
        return {'key': 'founding_principles/current', 'type': 'founding_principle',
                'name': 'Founding Principles', 'metadata': {}}

    return None  # not a synced component
```

#### Option 3: pg_cron polling (fallback)

If neither GitHub Actions nor webhooks are viable, a `pg_cron` job can poll the GitHub API periodically. This is the least elegant option — it introduces polling latency and API rate limit concerns — but it works without any external trigger.

```sql
-- pg_cron: check GitHub for PAI changes every 15 minutes
SELECT cron.schedule('pai-github-sync', '*/15 * * * *', $$
    SELECT net.http_post(
        url := 'https://windmill.imladris.local/api/w/pai/jobs/run/f/pai/sync_from_github',
        headers := '{"Authorization": "Bearer " || current_setting(''app.windmill_token'')}'::jsonb,
        body := '{}'::jsonb
    );
$$);
```

### Embedding generation on sync

When a system component lands in `pai_system`, it needs an embedding in `memory_vectors` so `assemble_context()` can find it via semantic search. This uses the same Phase 2c pgml pipeline:

```sql
-- Trigger: generate embedding when pai_system content changes
CREATE OR REPLACE FUNCTION pai_system_embed_trigger()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' OR OLD.content_hash != NEW.content_hash THEN
        -- Delete old embedding if exists
        DELETE FROM memory_vectors WHERE source_key = NEW.key AND source_type = 'system';

        -- Generate and store new embedding
        INSERT INTO memory_vectors (source_key, source_type, embedding)
        VALUES (
            NEW.key,
            'system',
            pgml.embed('intfloat/e5-small-v2', LEFT(NEW.content, 8000))
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pai_system_embed_on_change
    AFTER INSERT OR UPDATE ON pai_system
    FOR EACH ROW EXECUTE FUNCTION pai_system_embed_trigger();
```

### Updated `assemble_context()` — now reads from both tables

The original `assemble_context()` only queried `memory_objects`. With `pai_system` in place, it pulls methodology from the system table and user-generated knowledge from the memory table:

```sql
CREATE OR REPLACE FUNCTION assemble_context(
    task_description TEXT,
    context_level TEXT DEFAULT 'standard'
) RETURNS JSONB AS $$
DECLARE
    result JSONB;
    task_embedding vector(1536);
BEGIN
    task_embedding := pgml.embed('intfloat/e5-small-v2', task_description);

    result := jsonb_build_object(
        -- TIER 1 METHODOLOGY: from pai_system (GitHub-sourced)
        'algorithm', (
            SELECT content FROM pai_system
            WHERE component_type = 'algorithm' AND is_active
            ORDER BY updated_at DESC LIMIT 1
        ),
        'steering_rules', (
            SELECT content FROM pai_system
            WHERE component_type = 'steering_rule' AND is_active
            ORDER BY updated_at DESC LIMIT 1
        ),
        'founding_principles', CASE WHEN context_level IN ('standard', 'full') THEN (
            SELECT content FROM pai_system
            WHERE component_type = 'founding_principle' AND is_active
            ORDER BY updated_at DESC LIMIT 1
        ) END,

        -- TIER 1 METHODOLOGY: relevant skills and Fabric patterns
        'relevant_skills', (
            SELECT jsonb_agg(jsonb_build_object(
                'skill', ps.name,
                'methodology', LEFT(ps.content, 2000),
                'relevance', 1 - (mv.embedding <=> task_embedding)::FLOAT
            ))
            FROM memory_vectors mv
            JOIN pai_system ps ON mv.source_key = ps.key
            WHERE mv.source_type = 'system'
              AND ps.component_type = 'skill_methodology'
              AND ps.is_active
              AND 1 - (mv.embedding <=> task_embedding) > 0.5
            ORDER BY mv.embedding <=> task_embedding
            LIMIT CASE context_level
                WHEN 'minimal' THEN 2
                WHEN 'standard' THEN 5
                WHEN 'full' THEN 10
            END
        ),
        'suggested_fabric_patterns', (
            SELECT jsonb_agg(jsonb_build_object(
                'pattern', ps.metadata->>'pattern_name',
                'relevance', 1 - (mv.embedding <=> task_embedding)::FLOAT
                -- content NOT included here; call get_fabric_pattern() to load
            ))
            FROM memory_vectors mv
            JOIN pai_system ps ON mv.source_key = ps.key
            WHERE mv.source_type = 'system'
              AND ps.component_type = 'fabric_pattern'
              AND ps.is_active
              AND 1 - (mv.embedding <=> task_embedding) > 0.55
            ORDER BY mv.embedding <=> task_embedding
            LIMIT 5
        ),

        -- TIER 2 USER KNOWLEDGE: from memory_objects (sync daemon-sourced)
        'learnings', (
            SELECT jsonb_agg(jsonb_build_object(
                'content', mo.content,
                'domain', mo.metadata->>'domain',
                'confidence', mo.metadata->>'confidence',
                'source_model', COALESCE(mo.metadata->>'source_model', 'claude-code')
            ))
            FROM memory_vectors mv
            JOIN memory_objects mo ON mv.source_key = mo.key
            WHERE mv.source_type = 'learning'
              AND NOT mo.deleted
              AND 1 - (mv.embedding <=> task_embedding) > 0.6
            ORDER BY mv.embedding <=> task_embedding
            LIMIT CASE context_level
                WHEN 'minimal' THEN 5
                WHEN 'standard' THEN 15
                WHEN 'full' THEN 30
            END
        ),
        'wisdom_frames', CASE WHEN context_level IN ('standard', 'full') THEN (
            SELECT jsonb_agg(jsonb_build_object(
                'domain', mo.metadata->>'domain',
                'content', mo.content
            ))
            FROM memory_vectors mv
            JOIN memory_objects mo ON mv.source_key = mo.key
            WHERE mv.source_type = 'wisdom_frame'
              AND NOT mo.deleted
              AND 1 - (mv.embedding <=> task_embedding) > 0.5
            ORDER BY mv.embedding <=> task_embedding
            LIMIT 5
        ) END,
        'similar_failures', (
            SELECT jsonb_agg(jsonb_build_object(
                'summary', mo.metadata->>'summary',
                'root_cause', mo.metadata->>'root_cause',
                'source_model', COALESCE(mo.metadata->>'source_model', 'claude-code')
            ))
            FROM memory_vectors mv
            JOIN memory_objects mo ON mv.source_key = mo.key
            WHERE mv.source_type = 'failure'
              AND NOT mo.deleted
              AND 1 - (mv.embedding <=> task_embedding) > 0.65
            ORDER BY mv.embedding <=> task_embedding
            LIMIT 5
        ),

        -- META
        'assembled_at', NOW(),
        'context_level', context_level,
        'data_sources', jsonb_build_object(
            'methodology', 'pai_system (GitHub-synced)',
            'knowledge', 'memory_objects (sync daemon)',
            'write_back', 'memory_objects (model-contributed)'
        )
    );

    RETURN result;
END;
$$ LANGUAGE plpgsql;
```

### The complete data flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         GitHub PAI Repo                         │
│  Algorithm, Steering Rules, Skills, Fabric, Principles, etc.   │
└─────────────┬──────────────────────────────────────┬────────────┘
              │ push to main                         │
              ▼                                      │
┌──────────────────────┐                             │
│  GitHub Action        │                             │
│  (or Windmill webhook)│                             │
│  classify + upsert    │                             │
└──────────┬───────────┘                             │
           │ PostgREST                               │ git pull (normal dev)
           ▼                                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                      PostgreSQL                           │
│                                                                  │
│  ┌─────────────────┐              ┌────────────────────┐        │
│  │   pai_system     │              │  memory_objects     │        │
│  │                  │              │                     │        │
│  │ Algorithm  v3.7  │    JOIN      │ Learnings           │        │
│  │ Steering Rules   │◄───────────►│ Wisdom Frames       │        │
│  │ Fabric (237)     │  via         │ Failures            │        │
│  │ Skill methods    │  assemble_   │ Ratings             │        │
│  │ Principles       │  context()   │ Session artifacts   │        │
│  │ Agent personas   │              │ TELOS (personal)    │        │
│  └────────┬────────┘              └─────────┬──────────┘        │
│           │                                  │                   │
│           │         memory_vectors           │                   │
│           └────►  (embeddings for both) ◄────┘                   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐       │
│  │  assemble_context(task, level)                        │       │
│  │  → reads pai_system for methodology                   │       │
│  │  → reads memory_objects for knowledge                 │       │
│  │  → semantic search across both via memory_vectors     │       │
│  │  → returns unified JSONB context block                │       │
│  └──────────────────────────────────────────────────────┘       │
└──────────┬───────────────────────────┬──────────────────────────┘
           │                           │                    ▲
      READ │                      READ │ WRITE              │ WRITE
           ▼                           ▼                    │
┌─────────────────┐          ┌──────────────────┐    ┌─────┴────────┐
│  Claude Code     │          │  Bedrock Opus    │    │  sync daemon  │
│  (Imladris)      │          │  (Windmill)      │    │  (inotify)    │
│                  │          │                  │    │               │
│  Full runtime    │          │  assemble_context│    │ ~/.claude/ →  │
│  + Postgres ctx  │          │  + own tool-use  │    │ memory_objects│
└─────────────────┘          └──────────────────┘    └───────────────┘
```

### Bootstrap: initial load

When Postgres is first provisioned, the full PAI system needs to be loaded — not just changed files. A one-time bootstrap script walks the repo and loads everything:

```bash
#!/bin/bash
# pai-system-bootstrap.sh — one-time load of all PAI system components into Postgres
# Run once after Postgres provisioning, then GitHub Action handles incremental updates

POSTGREST_URL="${POSTGREST_URL}"
POSTGREST_TOKEN="${POSTGREST_TOKEN}"
PAI_REPO="${PAI_REPO:-.}"
COMMIT_SHA=$(git -C "$PAI_REPO" rev-parse HEAD)
REPO_VERSION=$(cat "$PAI_REPO/.claude/PAI/VERSION" 2>/dev/null || echo "unknown")

sync_file() {
    local file="$1" type="$2" key="$3" name="$4" metadata="$5"
    local content hash
    content=$(cat "$file")
    hash=$(sha256sum "$file" | cut -d' ' -f1)

    curl -s -X POST "${POSTGREST_URL}/pai_system" \
      -H "Authorization: Bearer ${POSTGREST_TOKEN}" \
      -H "Content-Type: application/json" \
      -H "Prefer: resolution=merge-duplicates" \
      -d "$(jq -n \
        --arg key "$key" --arg type "$type" --arg name "$name" \
        --arg content "$content" --arg hash "$hash" --argjson meta "$metadata" \
        --arg path "$file" --arg sha "$COMMIT_SHA" --arg ver "$REPO_VERSION" \
        '{key:$key, component_type:$type, name:$name, content:$content,
          content_hash:$hash, metadata:$meta, repo_path:$path,
          commit_sha:$sha, repo_version:$ver, is_active:true}')"
}

echo "=== Bootstrap: Algorithm ==="
for f in "$PAI_REPO"/.claude/PAI/Algorithm/v*.md; do
    [ -f "$f" ] || continue
    ver=$(basename "$f" .md)
    sync_file "$f" "algorithm" "algorithm/$ver" "The Algorithm $ver" "{\"version\":\"$ver\"}"
    echo "  ✓ $ver"
done

echo "=== Bootstrap: Fabric patterns ==="
count=0
for f in "$PAI_REPO"/.claude/skills/Utilities/Fabric/Patterns/*/system.md; do
    [ -f "$f" ] || continue
    pattern=$(basename "$(dirname "$f")")
    sync_file "$f" "fabric_pattern" "fabric/$pattern" "$pattern" \
      "{\"pattern_name\":\"$pattern\",\"category\":\"fabric\"}"
    count=$((count + 1))
done
echo "  ✓ $count patterns"

echo "=== Bootstrap: Skill methodologies ==="
for f in "$PAI_REPO"/.claude/skills/*/SKILL.md; do
    [ -f "$f" ] || continue
    skill=$(basename "$(dirname "$f")")
    sync_file "$f" "skill_methodology" "skill/$skill" "$skill Skill" \
      "{\"category\":\"$skill\"}"
    echo "  ✓ $skill"
done

echo "=== Bootstrap: Steering Rules ==="
f="$PAI_REPO/.claude/PAI/AISteeringRules.md"
[ -f "$f" ] && sync_file "$f" "steering_rule" "steering_rules/current" "AI Steering Rules" '{}'

echo "=== Bootstrap: Founding Principles ==="
f="$PAI_REPO/.claude/PAI/FoundingPrinciples.md"
[ -f "$f" ] && sync_file "$f" "founding_principle" "founding_principles/current" "Founding Principles" '{}'

echo "=== Bootstrap: Agent personas ==="
f="$PAI_REPO/.claude/PAI/PAIAGENTSYSTEM.md"
[ -f "$f" ] && sync_file "$f" "agent_persona" "agent_system/current" "PAI Agent System" '{}'

echo "=== Bootstrap complete ==="
echo "Commit: $COMMIT_SHA"
echo "Version: $REPO_VERSION"
```

### Keeping both directions in sync

With two data flows, the sync picture is:

| Data | Source of truth | Sync direction | Mechanism | Trigger |
|------|----------------|---------------|-----------|---------|
| Algorithm, skills, Fabric, principles | GitHub repo | GitHub → Postgres | GitHub Action / webhook | Push to main |
| Learnings, wisdom, ratings, sessions | Filesystem | Filesystem → Postgres | Sync daemon (inotify) | Any file write |
| Model write-back (learnings, failures) | Postgres | Postgres → Filesystem | Sync daemon (reverse) | `record_learning()` / `record_failure()` |
| Fabric pattern updates (upstream) | GitHub (fabric repo) | GitHub → PAI repo → Postgres | PAI's UpdatePatterns skill + GitHub Action | Manual or scheduled |

**No conflicts possible.** The two data flows touch different tables (`pai_system` vs `memory_objects`) populated by different sources (GitHub vs filesystem/models). The only bidirectional flow is model write-back, and that's mediated by the sync daemon which already handles conflict resolution for `memory_objects`.

### What this enables

With this implementation, here's the concrete timeline when a PAI component improves:

```
1. Developer pushes Algorithm v3.8.0 to GitHub         (t=0)
2. GitHub Action fires, upserts to pai_system           (t=30s)
3. Embedding trigger generates new vector               (t=35s)
4. Next assemble_context() call serves v3.8.0           (t=35s+)
5. Bedrock Opus picks up new methodology on next task   (automatic)
6. Claude Code picks it up on next git pull + session   (next session)
```

A new Fabric pattern follows the same path. An improved skill methodology follows the same path. **One push to GitHub updates every model's context.** No manual deployment, no per-model configuration, no prompt engineering across multiple systems. Push once, serve everywhere.

---

## Comprehensive PAI Evolution: Hooks, Enforcement, and Fabric Registry

The previous sections cover the core sync pipeline for methodology (Algorithm, skills, Fabric patterns, principles) and user-generated knowledge (learnings, failures, ratings). But PAI is more than methodology and memory. It includes:

- **Hook definitions** — the event-driven automation rules that make PAI reactive
- **Enforcement rules** — the session-level gating that controls what actions models can take and when
- **Fabric registry** — the interconnected map of repositories, their relationships, and metadata
- **System documentation** — the hook system, notification system, delegation system, memory system, flow/pipeline definitions

All of these evolve in the GitHub repo and need to propagate to Postgres so the MCP server can serve them. The mechanism is identical to what's already designed — `pai_system` table, GitHub Action sync, embedding generation — but the component types and their specific uses warrant explicit specification.

### Why everything must land in Postgres

The guiding principle: **if a PAI component influences how any model should behave, it belongs in `pai_system`.** The MCP server is the sole interface for non-local models. If a component isn't in Postgres, it's invisible to Bedrock Opus, Gemini, ChatGPT, and any future model. Only Claude Code on the local machine (which reads files directly) can see it.

```
PAI Component          In GitHub Repo?    In Postgres?    Visible to MCP clients?
─────────────────────  ─────────────────  ──────────────  ───────────────────────
Algorithm              ✓                  ✓               ✓ (via get_context)
Steering Rules         ✓                  ✓               ✓ (via get_context)
Fabric patterns        ✓                  ✓               ✓ (via get_fabric_pattern)
Skill methodologies    ✓                  ✓               ✓ (via get_context)
Hook system docs       ✓                  ✗ (BEFORE)      ✗ — invisible to MCP models
Enforcement rules      ✓ (NEW)            ✗ (BEFORE)      ✗ — no server-side gating
Fabric registry        ✓ (NEW)            ✗ (BEFORE)      ✗ — models don't know what repos exist
Notification system    ✓                  ✗ (BEFORE)      ✗ — models can't route notifications
Memory system docs     ✓                  ✗ (BEFORE)      ✗ — models don't know memory structure
Delegation patterns    ✓                  ✗ (BEFORE)      ✗ — models can't plan delegation
```

After this section, every row gets a ✓ in the Postgres and MCP columns.

### Hook Definitions in Postgres

PAI's hook system (22 hooks across 7 event types) is Claude Code-specific runtime machinery — the actual execution of hooks via stdin/stdout in response to session events cannot transfer to other models. But the **knowledge of what hooks exist and what they do** is valuable context that any model should have access to.

More importantly, when hooks change — a new hook is added, a hook's behavior is modified, the hook system architecture evolves — that change should automatically propagate to the MCP server so that `assemble_context()` can include it when relevant.

**What goes in `pai_system`:**

```sql
-- The hook system specification document
INSERT INTO pai_system (key, component_type, name, content, content_hash, repo_path)
VALUES (
    'hook_system/current',
    'hook_system',
    'Hook System',
    -- Content: the full THEHOOKSYSTEM.md
    (content of the file),
    sha256(content),
    '.claude/PAI/THEHOOKSYSTEM.md'
);
```

The GitHub Action sync already handles this — `THEHOOKSYSTEM.md` is in `.claude/PAI/`, and the sync pipeline classifies any file in that directory. The `classify_file()` function in the Windmill webhook handler (Option 2) or the GitHub Action shell script (Option 1) needs entries for these new file paths:

```python
# Add to classify_file() in the sync pipeline
if 'THEHOOKSYSTEM' in path:
    return {'key': 'hook_system/current', 'type': 'hook_system',
            'name': 'Hook System', 'metadata': {'hook_count': 22, 'event_types': 7}}

if 'THENOTIFICATIONSYSTEM' in path:
    return {'key': 'notification_system/current', 'type': 'notification_system',
            'name': 'Notification System', 'metadata': {}}

if 'MEMORYSYSTEM' in path:
    return {'key': 'memory_system/current', 'type': 'memory_system',
            'name': 'Memory System', 'metadata': {}}

if 'THEDELEGATIONSYSTEM' in path:
    return {'key': 'delegation_system/current', 'type': 'delegation_system',
            'name': 'Delegation System', 'metadata': {}}

if 'FLOWS.md' in path and 'PAI/' in path:
    return {'key': 'flow_system/current', 'type': 'flow_system',
            'name': 'Flow System', 'metadata': {}}

if 'PIPELINES.md' in path and 'PAI/' in path:
    return {'key': 'pipeline_system/current', 'type': 'pipeline_system',
            'name': 'Pipeline System', 'metadata': {}}
```

**How `assemble_context()` uses it:**

When a task involves building or modifying hooks, or when a model needs to understand PAI's event-driven architecture, `assemble_context()` includes the hook system specification alongside the Algorithm and steering rules. The embedding on `hook_system/current` ensures it's returned when the task description is semantically related to "hooks," "events," "automation," or "session lifecycle."

### Enforcement Rules: Postgres-Native Session Gating

The PAI Knowledge MCP Server needs to enforce behavioral rules — "call `get_context` before write tools," "investigation tools before ticket creation," etc. Instead of building a custom enforcement engine, we lean into Postgres.

**Enforcement rules are JSONB rows in `pai_system`:**

```sql
INSERT INTO pai_system (key, component_type, name, content, content_hash, repo_path, metadata)
VALUES (
    'enforcement/current',
    'enforcement_rules',
    'MCP Enforcement Rules',
    -- Content: human-readable documentation of the rules
    '# MCP Session Enforcement Rules\n\n## Rules\n\n1. get_context must be called before any write tool...',
    sha256(content),
    'gateway/enforcement.yaml',
    -- Metadata: machine-readable rules the MCP server evaluates
    '{
        "rules": [
            {
                "name": "require_get_context",
                "description": "get_context must be called before any write tool",
                "prerequisite": "get_context",
                "applies_to": ["record_learning", "record_failure", "record_feedback"],
                "action": "reject",
                "message": "Call get_context before using write tools. This ensures you have PAI methodology loaded."
            },
            {
                "name": "require_investigation_before_ticket",
                "description": "At least one search tool before creating tickets (future tool)",
                "prerequisite_any": ["search_memory", "get_context", "query_knowledge_graph"],
                "applies_to": ["create_ticket"],
                "action": "reject",
                "message": "Search existing knowledge before creating a ticket."
            }
        ],
        "auto_approve": ["get_context", "search_memory", "get_fabric_pattern", "suggest_fabric_patterns", "get_failure_history", "get_version_history"],
        "require_get_context": ["record_learning", "record_failure", "record_feedback", "query_knowledge_graph"]
    }'::jsonb
);
```

**The MCP server enforces rules by reading from Postgres — not by parsing config files:**

```typescript
// pai-knowledge-mcp/src/enforcement.ts
import { Pool } from "pg";

interface SessionState {
  tools_called: string[];
  get_context_called: boolean;
}

const sessions = new Map<string, SessionState>();

export async function checkEnforcement(
  pool: Pool,
  sessionId: string,
  toolName: string
): Promise<{ allowed: boolean; message?: string }> {
  // Get current enforcement rules from Postgres
  const result = await pool.query(
    `SELECT metadata->'rules' AS rules,
            metadata->'require_get_context' AS gated_tools
     FROM pai_system
     WHERE key = 'enforcement/current' AND is_active
     LIMIT 1`
  );

  if (result.rows.length === 0) {
    return { allowed: true }; // No rules = no enforcement
  }

  const rules = result.rows[0].rules || [];
  const gatedTools = result.rows[0].gated_tools || [];
  const session = sessions.get(sessionId) || { tools_called: [], get_context_called: false };

  // Check if this tool requires get_context first
  if (gatedTools.includes(toolName) && !session.get_context_called) {
    return {
      allowed: false,
      message: "Call get_context before using write tools. This ensures you have PAI methodology loaded."
    };
  }

  // Check specific rules
  for (const rule of rules) {
    if (!rule.applies_to?.includes(toolName)) continue;

    // Check prerequisite
    if (rule.prerequisite && !session.tools_called.includes(rule.prerequisite)) {
      return { allowed: false, message: rule.message };
    }

    // Check prerequisite_any
    if (rule.prerequisite_any) {
      const hasAny = rule.prerequisite_any.some((t: string) => session.tools_called.includes(t));
      if (!hasAny) {
        return { allowed: false, message: rule.message };
      }
    }
  }

  // Record this tool call
  session.tools_called.push(toolName);
  if (toolName === "get_context") session.get_context_called = true;
  sessions.set(sessionId, session);

  return { allowed: true };
}
```

**Why this is better than a config file or in-memory cache:**

1. **One source of truth.** Rules live in `pai_system`, versioned, with history.
2. **Hot-update without restart.** Push new rules to GitHub → GitHub Action updates `pai_system` → next tool call reads the new rules. No MCP server restart.
3. **Queryable.** `SELECT * FROM pai_system WHERE component_type = 'enforcement_rules'` shows current rules. `SELECT * FROM pai_system_versions WHERE key = 'enforcement/current'` shows rule history.
4. **The rules are also context.** `assemble_context()` can include enforcement rules in the context payload so models understand what's expected of them *before* they hit a wall.

### Declarative Hook Rules for MCP Session Behavior

Distinct from the hook system documentation (which describes Claude Code's local hooks), **declarative hook rules** define per-tool behaviors that the MCP server enforces. These are the equivalent of Claude Code's PreToolUse/PostToolUse hooks, but running server-side in the MCP layer.

```sql
INSERT INTO pai_system (key, component_type, name, content, content_hash, repo_path, metadata)
VALUES (
    'hook_rules/current',
    'hook_rules',
    'MCP Hook Rules',
    '# MCP Server Hook Rules\n\nDeclarative pre/post hooks for MCP tool calls...',
    sha256(content),
    'gateway/hooks.yaml',
    '{
        "pre_call": [
            {
                "name": "log_all_calls",
                "trigger": {"tools": "*"},
                "action": "log",
                "fields": ["tool_name", "session_id", "timestamp"]
            },
            {
                "name": "rate_limit_writes",
                "trigger": {"tools": ["record_learning", "record_failure"]},
                "condition": "call_count > 10 per 5m",
                "action": "reject",
                "message": "Rate limit: max 10 write operations per 5 minutes."
            }
        ],
        "post_call": [
            {
                "name": "notify_on_learning",
                "trigger": {"tools": ["record_learning"]},
                "action": "pg_notify",
                "channel": "new_learning"
            },
            {
                "name": "enrich_session_on_context",
                "trigger": {"tools": ["get_context"]},
                "action": "set_session",
                "set": {"has_context": true, "context_fetched_at": "now()"}
            }
        ]
    }'::jsonb
);
```

**The MCP server interprets these rules, not executes arbitrary code.** The action vocabulary is fixed and safe:

| Action | What it does | Where it runs |
|--------|-------------|---------------|
| `log` | Append to `events.jsonl` or Postgres log table | MCP server |
| `reject` | Return error, block tool call | MCP server |
| `pg_notify` | `PERFORM pg_notify(channel, payload)` | Postgres (via SQL) |
| `set_session` | Update in-memory session state | MCP server |
| `webhook` | POST to a URL (via `pg_net`) | Postgres |

**No `eval()`, no arbitrary code execution.** The hook rules are declarative — they express conditions and actions from a fixed set. The MCP server has a small interpreter that maps actions to implementations. New action types require a code change to the MCP server; new rules using existing action types are just data.

### Fabric Registry: The Repository and Relationship Map

PAI operates across multiple repositories. The fabric registry maps what exists, how things relate, and where to look for context. Today this knowledge lives implicitly in the user's head and partially in CLAUDE.md. Making it explicit and queryable means any model can understand the project landscape.

```sql
INSERT INTO pai_system (key, component_type, name, content, content_hash, repo_path, metadata)
VALUES (
    'fabric_registry/current',
    'fabric_registry',
    'PAI Fabric Registry',
    '# Fabric Registry\n\nThe interconnected map of repositories, services, and relationships...',
    sha256(content),
    'fabric/registry.yaml',
    '{
        "repos": {
            "pai-core": {
                "purpose": "Core methodology, algorithm, principles",
                "url": "github.com/org/pai-core",
                "type": "methodology",
                "contains": ["algorithm", "principles", "telos", "fabric"]
            },
            "arbol": {
                "purpose": "Cloudflare Workers execution platform",
                "url": "github.com/org/arbol",
                "type": "infrastructure",
                "tech_stack": ["typescript", "cloudflare-workers"],
                "depends_on": ["pai-core"]
            },
            "windmill-scripts": {
                "purpose": "DevOps pipeline, triage, investigation",
                "url": "github.com/org/windmill",
                "type": "operations",
                "tech_stack": ["typescript", "python"],
                "depends_on": ["pai-core"],
                "observability": {
                    "logs": "cloudwatch",
                    "metrics": "grafana"
                }
            }
        },
        "relationships": [
            {"type": "methodology_source", "from": "pai-core", "to": "*"},
            {"type": "deploys_actions", "from": "arbol", "to": "cloudflare"},
            {"type": "runs_investigations", "from": "windmill-scripts", "to": "arbol"}
        ]
    }'::jsonb
);
```

**How models use it:**

The `get_context` tool already returns relevant skills and patterns. With the fabric registry in `pai_system`, it can also return:

```sql
-- Add to assemble_context(): relevant repos and relationships
'fabric_registry', (
    SELECT content FROM pai_system
    WHERE component_type = 'fabric_registry' AND is_active
    ORDER BY updated_at DESC LIMIT 1
),
```

A model investigating a production issue can now see: "this service runs on Cloudflare Workers (arbol), the scripts are in windmill-scripts, logs are in CloudWatch." Without the fabric registry, the model has to ask or guess.

### How Changes Propagate: The Complete Picture

With all component types registered, here's what happens when any part of PAI evolves:

**Hook system changes:**
```
Developer updates THEHOOKSYSTEM.md → push to main
  → GitHub Action classifies as hook_system → upserts to pai_system
  → Embedding regenerated → assemble_context() serves updated hook docs
  → Any model asking about hooks/events/automation gets current info
  Timeline: ~35 seconds from push to available
```

**Enforcement rule changes:**
```
Developer updates gateway/enforcement.yaml → push to main
  → GitHub Action classifies as enforcement_rules → upserts pai_system metadata
  → MCP server reads new rules on next tool call (no restart)
  → New enforcement behavior active immediately
  Timeline: ~35 seconds from push to enforced
```

**Hook rule changes (MCP session behavior):**
```
Developer updates gateway/hooks.yaml → push to main
  → GitHub Action classifies as hook_rules → upserts pai_system metadata
  → MCP server reads new hook rules on next pre/post call check
  → New rate limits, logging, notifications active immediately
  Timeline: ~35 seconds from push to active
```

**Fabric registry changes (new repo, changed relationships):**
```
Developer updates fabric/registry.yaml → push to main
  → GitHub Action classifies as fabric_registry → upserts pai_system metadata
  → get_context() includes updated registry on next call
  → Models know about new repos and relationships
  Timeline: ~35 seconds from push to available
```

**Any PAI system doc changes (notification, delegation, memory, flows, pipelines):**
```
Developer updates THENOTIFICATIONSYSTEM.md → push to main
  → GitHub Action classifies by filename → upserts to pai_system
  → Embedding regenerated → semantic search finds it when relevant
  Timeline: ~35 seconds from push to available
```

### Updated GitHub Action Sync

The `sync_component()` calls in the GitHub Action need entries for all new component types:

```bash
# Add to the GitHub Action or bootstrap script

echo "=== Sync: Hook System ==="
f="$PAI_REPO/.claude/PAI/THEHOOKSYSTEM.md"
[ -f "$f" ] && sync_file "$f" "hook_system" "hook_system/current" "Hook System" '{}'

echo "=== Sync: Notification System ==="
f="$PAI_REPO/.claude/PAI/THENOTIFICATIONSYSTEM.md"
[ -f "$f" ] && sync_file "$f" "notification_system" "notification_system/current" "Notification System" '{}'

echo "=== Sync: Memory System ==="
f="$PAI_REPO/.claude/PAI/MEMORYSYSTEM.md"
[ -f "$f" ] && sync_file "$f" "memory_system" "memory_system/current" "Memory System" '{}'

echo "=== Sync: Delegation System ==="
f="$PAI_REPO/.claude/PAI/THEDELEGATIONSYSTEM.md"
[ -f "$f" ] && sync_file "$f" "delegation_system" "delegation_system/current" "Delegation System" '{}'

echo "=== Sync: Flows ==="
f="$PAI_REPO/.claude/PAI/FLOWS.md"
[ -f "$f" ] && sync_file "$f" "flow_system" "flow_system/current" "Flow System" '{}'

echo "=== Sync: Pipelines ==="
f="$PAI_REPO/.claude/PAI/PIPELINES.md"
[ -f "$f" ] && sync_file "$f" "pipeline_system" "pipeline_system/current" "Pipeline System" '{}'

echo "=== Sync: Enforcement Rules ==="
f="$PAI_REPO/gateway/enforcement.yaml"
[ -f "$f" ] && sync_file "$f" "enforcement_rules" "enforcement/current" "MCP Enforcement Rules" '{}'

echo "=== Sync: Hook Rules ==="
f="$PAI_REPO/gateway/hooks.yaml"
[ -f "$f" ] && sync_file "$f" "hook_rules" "hook_rules/current" "MCP Hook Rules" '{}'

echo "=== Sync: Fabric Registry ==="
f="$PAI_REPO/fabric/registry.yaml"
[ -f "$f" ] && sync_file "$f" "fabric_registry" "fabric_registry/current" "Fabric Registry" '{}'
```

The GitHub Action's `paths` trigger also needs updating:

```yaml
on:
  push:
    branches: [main]
    paths:
      - '.claude/PAI/**'
      - '.claude/skills/**'
      - 'gateway/**'        # NEW: enforcement rules, hook rules
      - 'fabric/**'          # NEW: fabric registry
```

### Updated bootstrap script sync count

After bootstrap, the expected component count:

```
Component Type           Expected Count
─────────────────────    ──────────────
algorithm                1-2 (active versions)
steering_rule            1
founding_principle       1
fabric_pattern           237
skill_methodology        20+ (one per skill)
agent_persona            1 (agent system doc)
isc_spec                 1
context_routing          1
prd_spec                 1
telos_framework          1
hook_system              1    ← NEW
enforcement_rules        1    ← NEW
hook_rules               1    ← NEW
fabric_registry          1    ← NEW
notification_system      1    ← NEW
memory_system            1    ← NEW
delegation_system        1    ← NEW
flow_system              1    ← NEW
pipeline_system          1    ← NEW
────────────────────────────────
Total:                   ~280 rows in pai_system
```

### What this means for the "gateway" concept

In our architectural discussions, we explored a ContentManager pattern — an in-process cache that hot-reloads YAML files from GitHub via webhooks, with a HookEngine that interprets declarative rules. **Postgres eliminates the need for all of that.**

The "gateway" IS the combination of:
1. **Postgres** (`pai_system` table) — stores everything, versions everything, indexes everything
2. **GitHub Action** — pushes changes to Postgres on every commit
3. **MCP server** — thin translation layer that reads from Postgres and enforces rules

There is no ContentManager. Postgres IS the content manager. There is no separate HookEngine. The MCP server reads `hook_rules` from `pai_system` and interprets the fixed action vocabulary. There is no webhook receiver. The GitHub Action writes directly to Postgres via PostgREST.

```
BEFORE (ContentManager pattern):
  GitHub → webhook → ContentManager (in-memory cache)
         → cache invalidation → cache refresh
         → HookEngine reads from cache
         → enforcement engine reads from cache
  Complexity: webhook server, cache TTL, cache invalidation, in-memory state

AFTER (Postgres-native):
  GitHub → GitHub Action → PostgREST → pai_system table
  MCP server reads from pai_system on every tool call
  Complexity: one SQL query per tool call
```

The Postgres approach is simpler, more durable, and already designed. The database is the cache, the version store, the search engine, and the enforcement rules store — all in one.

---

## Postgres-Native Design: Why Not a Custom Gateway

This section directly addresses the question: are we overcomplicating this? Should we lean more into Postgres's native capabilities?

**The answer is yes — and the spec already does.** The architecture avoids building custom middleware by using Postgres as the platform:

### What Postgres replaces (things we don't need to build)

| Custom component | Postgres-native replacement | Why it's better |
|-----------------|---------------------------|-----------------|
| ContentManager (in-memory cache) | `pai_system` table | Durable, versioned, queryable. No cache invalidation logic. |
| HookEngine (YAML interpreter) | JSONB metadata in `pai_system` + fixed action vocabulary in MCP server | Rules are data, not code. Add rules by pushing to GitHub, not redeploying. |
| Webhook receiver | GitHub Action → PostgREST | No server to run. GitHub Action is free CI/CD. PostgREST generates API from schema. |
| Enforcement engine | `checkEnforcement()` reads JSONB from `pai_system` | One SQL query. Rules update without restart. |
| API server | PostgREST (zero code) | Full REST API generated from schema. Filtering, pagination, ordering — all automatic. |
| Event bus | `pg_notify` / LISTEN/NOTIFY | Built into Postgres. No Kafka, no Redis, no message queue. |
| Cron scheduler | `pg_cron` | Jobs run inside the database. No external scheduler. |
| Full-text search | `tsvector` / `tsquery` | Built into Postgres. No Elasticsearch. |
| Fuzzy matching | `pg_trgm` | Extension, not external service. |
| Embedding generation | `pgml` | Models run inside Postgres. No external embedding API. |
| Graph database | Apache AGE | Cypher queries inside Postgres. No Neo4j. |
| HTTP outbound | `pg_net` | HTTP calls from triggers. No middleware Lambda. |

### The Postgres capability surface for PAI

See the [Capability Stack Summary](#capability-stack-summary) in the Postgres Capability Surface section for the full layered architecture. In summary: ~500 lines (MCP server) + ~200 lines (sync daemon) + ~100 lines (GitHub Action). Everything else is Postgres doing what Postgres does.

### What we explicitly chose NOT to build

| Rejected approach | Why rejected | What we use instead |
|------------------|-------------|-------------------|
| Redis for caching | Adds infrastructure. Postgres query cache is sufficient for our read patterns (< 100 concurrent sessions). | Read directly from `pai_system`. |
| Kafka for event streaming | Overkill. PAI produces ~100 events/day, not millions. | `pg_notify` + `events.jsonl` for local, LISTEN/NOTIFY for cross-machine. |
| Elasticsearch for search | Another database to manage. Full-text search in Postgres (tsvector) handles our corpus size. pgvector handles semantic. | Postgres FTS + pgvector — both in the same database. |
| Neo4j for graph | Another database to deploy, backup, manage. AGE gives us Cypher queries inside Postgres. | Apache AGE extension. Same Postgres instance, same backups. |
| Custom REST API | PostgREST generates one from the schema. Zero lines of API code. | PostgREST. |
| Lambda functions for enrichment | External compute, cold starts, deployment pipeline. | `pgml` for embeddings, `plv8`/`plpython3u` for enrichment — all inside Postgres. |
| Custom scheduler | Another service. | `pg_cron` — cron jobs inside the database. |
| Custom gateway server | Adds a stateful caching layer between GitHub and models. | Postgres IS the gateway. GitHub Action → `pai_system` table → MCP server reads directly. |

### The low-friction deployment

The entire system requires:

1. **One PostgreSQL 16+ instance** (self-hosted on EC2, pgBackRest to S3 for backups)
2. **One sync daemon** (systemd service on each machine, watches `~/.claude/`)
3. **One MCP server** (Node.js process, ~500 lines, connects to Postgres)
4. **One GitHub Action** (YAML file in the PAI repo, runs on push)

No containers to orchestrate. No microservices to manage. No message queues, no cache layers, no separate search engines, no separate graph databases. Postgres is the platform.

```
                    ┌─────────────────┐
                    │  GitHub Action   │  (runs in CI, free)
                    └────────┬────────┘
                             │ PostgREST upsert
                             ▼
                    ┌─────────────────┐
 sync daemon ─────►│   PostgreSQL    │◄───── MCP server
 (systemd)         │   PostgreSQL    │       (Node.js, ~500 LOC)
                   │                 │
                   │ pai_system      │ methodology (GitHub-sourced)
                   │ memory_objects  │ knowledge (filesystem-sourced)
                   │ memory_vectors  │ embeddings (pgml-generated)
                   │ AGE graph       │ relationships (trigger-populated)
                   │ enforcement     │ rules (JSONB in pai_system)
                   └─────────────────┘
```

**If Postgres goes down:** PAI continues working locally (filesystem + hooks). Sync queues in the WAL. MCP queries fail gracefully. When Postgres returns, everything catches up.

**If the MCP server goes down:** Claude Code continues working (it has local files). Remote models lose knowledge access until it's restarted. Enforcement rules are not enforced, but no data is lost.

**If the GitHub Action fails:** Methodology in Postgres stays at the last successful sync. A manual `pai sync push` or re-running the action catches up.

Every failure mode is graceful. Nothing is catastrophic. The system degrades to "PAI as it works today" — local filesystem, no cross-model sharing — and recovers automatically when the failed component returns.

---

## The PAI Knowledge MCP Server

The previous sections describe what goes into Postgres and how it stays current. This section describes how models actually connect to it. The answer is MCP — the Model Context Protocol.

PostgREST remains useful for non-model clients (dashboards, scripts, GitHub Actions). But for model-to-knowledge communication, MCP is the native protocol. Models already speak it. Claude Code already consumes MCP servers. Windmill can host MCP servers. An MCP server in front of Postgres becomes the single interface through which any model reads PAI's institutional knowledge and writes discoveries back.

### Why MCP, not just PostgREST

| | PostgREST | MCP Server |
|--|-----------|------------|
| **Protocol** | HTTP REST — generic, model-agnostic | MCP — purpose-built for model ↔ tool communication |
| **Discovery** | Model needs to know endpoint URLs and payload shapes | Model discovers available tools and their schemas automatically |
| **Context** | Returns raw JSON; model must know how to interpret it | Tool descriptions explain what each function does and when to use it |
| **Integration** | Requires wrapper code to call from model's tool-use loop | Native tool in Claude Code, native tool in any MCP-compatible agent |
| **Write-back** | Model calls HTTP POST; needs URL, auth headers, JSON body | Model calls `record_learning` tool; MCP handles the rest |
| **Auth** | Bearer tokens, JWT | MCP transport-level auth + per-tool permissions |
| **State** | Stateless HTTP | MCP session maintains context across tool calls |

The key difference: with PostgREST, someone has to write glue code that teaches each model how to call the API. With MCP, the model **discovers the knowledge server's capabilities as tools** and uses them naturally within its tool-use loop. No glue code. No per-model integration.

### Server architecture

```
┌──────────────────────────────────────────────────────────┐
│                   PAI Knowledge MCP Server                    │
│               (Node.js / Python, runs on Imladris)        │
│                                                           │
│  Tools (model-facing):              Resources (context):  │
│  ┌────────────────────────┐        ┌───────────────────┐ │
│  │ get_context             │        │ pai://algorithm    │ │
│  │ record_learning         │        │ pai://principles   │ │
│  │ record_failure          │        │ pai://steering     │ │
│  │ record_feedback         │        │ pai://fabric/{name}│ │
│  │ search_memory           │        │ pai://skills/{name}│ │
│  │ get_fabric_pattern      │        │ pai://telos        │ │
│  │ suggest_fabric_patterns │        └───────────────────┘ │
│  │ query_knowledge_graph   │                               │
│  │ get_failure_history     │        Prompts (reusable):    │
│  │ get_version_history     │        ┌───────────────────┐ │
│  └────────────────────────┘        │ investigate        │ │
│                                     │ research           │ │
│         ┌──────────┐               │ security_review    │ │
│         │ Postgres  │               │ architecture       │ │
│         │ connection│               └───────────────────┘ │
│         │ pool      │                                      │
│         └─────┬─────┘                                      │
└───────────────┼──────────────────────────────────────────┘
                │ SQL
                ▼
┌──────────────────────────────────────────────────────────┐
│              PostgreSQL                             │
│  pai_system + memory_objects + memory_vectors              │
│  assemble_context() + record_learning() + all functions    │
└──────────────────────────────────────────────────────────┘
```

The MCP server is a thin layer — it translates MCP tool calls into Postgres function calls. The intelligence stays in the SQL functions. The MCP server handles transport, auth, and tool descriptions.

### MCP Tools

Each tool maps directly to a Postgres function. The tool descriptions are what models see when they connect — they tell the model what's available and when to use each tool.

```typescript
// pai-knowledge-mcp/src/tools.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.POSTGRES_URL });

export function registerTools(server: McpServer) {

  // === READING: Get assembled context for a task ===
  server.tool(
    "get_context",
    `Get PAI methodology and relevant institutional knowledge for a task.
     Returns: the Algorithm (execution framework), relevant learnings,
     wisdom frames, similar past failures, and suggested Fabric patterns.
     Call this FIRST when starting any significant task.`,
    {
      task_description: z.string().describe("What you're about to work on"),
      context_level: z.enum(["minimal", "standard", "full"]).default("standard")
        .describe("minimal: quick lookups. standard: most tasks. full: complex/architectural work")
    },
    async ({ task_description, context_level }) => {
      const result = await pool.query(
        "SELECT assemble_context($1, $2) AS context",
        [task_description, context_level]
      );
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result.rows[0].context, null, 2)
        }]
      };
    }
  );

  // === READING: Search memory semantically ===
  server.tool(
    "search_memory",
    `Search PAI's institutional memory using semantic similarity.
     Finds learnings, wisdom frames, failures, and system methodology
     that are conceptually related to your query — even without keyword overlap.`,
    {
      query: z.string().describe("What you're looking for"),
      memory_types: z.array(z.enum([
        "learning", "wisdom_frame", "failure", "system", "all"
      ])).default(["all"]).describe("Types of memory to search"),
      limit: z.number().default(10).describe("Max results to return")
    },
    async ({ query, memory_types, limit }) => {
      const result = await pool.query(
        "SELECT * FROM search_memory($1, $2, $3)",
        [query, memory_types, limit]
      );
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result.rows, null, 2)
        }]
      };
    }
  );

  // === READING: Get a specific Fabric pattern ===
  server.tool(
    "get_fabric_pattern",
    `Get a Fabric prompt pattern by name. Fabric patterns are reusable
     analytical lenses — structured prompts for tasks like extract_wisdom,
     create_threat_model, analyze_claims, summarize, etc. Use suggest_fabric_patterns
     first if you're not sure which pattern to use.`,
    {
      pattern_name: z.string().describe("Pattern name, e.g. 'extract_wisdom', 'create_threat_model'")
    },
    async ({ pattern_name }) => {
      const result = await pool.query(
        "SELECT content, metadata FROM pai_system WHERE key = $1 AND is_active",
        [`fabric/${pattern_name}`]
      );
      if (result.rows.length === 0) {
        return { content: [{ type: "text", text: `Pattern '${pattern_name}' not found.` }] };
      }
      return {
        content: [{ type: "text", text: result.rows[0].content }]
      };
    }
  );

  // === READING: Suggest Fabric patterns for a task ===
  server.tool(
    "suggest_fabric_patterns",
    `Given a task description, suggest the most relevant Fabric patterns.
     Returns pattern names and relevance scores — call get_fabric_pattern
     to load the full pattern content.`,
    {
      task_description: z.string().describe("What you need to analyze or create"),
      max_results: z.number().default(5)
    },
    async ({ task_description, max_results }) => {
      const result = await pool.query(
        "SELECT * FROM suggest_fabric_patterns($1, $2)",
        [task_description, max_results]
      );
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result.rows, null, 2)
        }]
      };
    }
  );

  // === READING: Query the knowledge graph ===
  server.tool(
    "query_knowledge_graph",
    `Query PAI's knowledge graph for causal chains, relationships between
     learnings, failure-to-fix paths, and concept clusters. Uses Cypher
     query language via Apache AGE.`,
    {
      query: z.string().describe("Natural language question about relationships in PAI's knowledge"),
    },
    async ({ query }) => {
      // Translate natural language to Cypher, execute via AGE
      const result = await pool.query(
        "SELECT * FROM graph_query_nl($1)",
        [query]
      );
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result.rows, null, 2)
        }]
      };
    }
  );

  // === READING: Get the fabric registry (repos, relationships, metadata) ===
  server.tool(
    "get_fabric_registry",
    `Get the PAI fabric registry — the map of all repositories, services,
     their relationships, tech stacks, and observability endpoints.
     Use this to understand the project landscape before investigating
     or working across multiple systems.`,
    {},
    async () => {
      const result = await pool.query(
        `SELECT content, metadata FROM pai_system
         WHERE component_type = 'fabric_registry' AND is_active
         ORDER BY updated_at DESC LIMIT 1`
      );
      if (result.rows.length === 0) {
        return { content: [{ type: "text", text: "No fabric registry found." }] };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result.rows[0].metadata, null, 2)
        }]
      };
    }
  );

  // === READING: Get enforcement rules (what's required before write tools) ===
  server.tool(
    "get_enforcement_rules",
    `Get the current MCP session enforcement rules. Shows what prerequisites
     are required before calling write tools, rate limits, and session gating.
     Useful for understanding what you need to do before recording learnings
     or failures.`,
    {},
    async () => {
      const result = await pool.query(
        `SELECT metadata FROM pai_system
         WHERE component_type = 'enforcement_rules' AND is_active
         ORDER BY updated_at DESC LIMIT 1`
      );
      if (result.rows.length === 0) {
        return { content: [{ type: "text", text: "No enforcement rules configured." }] };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result.rows[0].metadata, null, 2)
        }]
      };
    }
  );

  // === WRITING: Record a learning ===
  server.tool(
    "record_learning",
    `Record something you learned during this task. This gets stored in
     PAI's institutional memory and will be available to ALL models
     (including Claude Code) on future tasks via get_context.
     Call this whenever you discover something non-obvious.`,
    {
      learning: z.string().describe("What you learned — be specific and actionable"),
      domain: z.string().describe("Category: SYSTEM, INFRASTRUCTURE, ALGORITHM, SECURITY, etc."),
      context: z.string().describe("What task or situation produced this learning"),
      confidence: z.enum(["low", "medium", "high"]).default("medium")
    },
    async ({ learning, domain, context, confidence }) => {
      const model = server.getClientInfo()?.name || "unknown";
      const result = await pool.query(
        "SELECT record_learning($1, $2, $3, $4, $5) AS key",
        [learning, domain, model, context, confidence]
      );
      const key = result.rows[0].key;
      return {
        content: [{
          type: "text",
          text: key === "duplicate_detected"
            ? "Already known — duplicate of existing learning."
            : `Learning recorded: ${key}`
        }]
      };
    }
  );

  // === WRITING: Record a failure ===
  server.tool(
    "record_failure",
    `Record a failure or mistake that occurred during this task.
     Include what you were trying to do, what went wrong, and why.
     This helps ALL future models avoid the same mistake.`,
    {
      summary: z.string().describe("One-line summary of what failed"),
      context: z.string().describe("What you were trying to do when it failed"),
      root_cause: z.string().describe("Why it failed — the actual underlying reason"),
      task_description: z.string().optional().describe("The broader task this failure occurred within")
    },
    async ({ summary, context, root_cause, task_description }) => {
      const model = server.getClientInfo()?.name || "unknown";
      const result = await pool.query(
        "SELECT record_failure($1, $2, $3, $4, $5) AS key",
        [summary, context, root_cause, model, task_description]
      );
      return {
        content: [{
          type: "text",
          text: `Failure recorded: ${result.rows[0].key}`
        }]
      };
    }
  );

  // === WRITING: Record feedback/rating ===
  server.tool(
    "record_feedback",
    `Record a satisfaction rating and optional feedback for the current
     interaction. Ratings accumulate across all models and drive
     trend analysis.`,
    {
      rating: z.number().min(1).max(10).describe("1-10 satisfaction rating"),
      context: z.string().describe("What was being done"),
      feedback: z.string().optional().describe("Optional text feedback")
    },
    async ({ rating, context, feedback }) => {
      const model = server.getClientInfo()?.name || "unknown";
      await pool.query(
        "SELECT record_feedback($1, $2, $3, $4)",
        [rating, context, model, feedback]
      );
      return {
        content: [{ type: "text", text: `Feedback recorded: ${rating}/10` }]
      };
    }
  );
}
```

### Enforcement integration in the MCP server

Every tool call goes through the enforcement check before execution. The MCP server wraps each tool handler:

```typescript
// pai-knowledge-mcp/src/index.ts
import { checkEnforcement } from "./enforcement.js";

// Wrap tool registration to add enforcement
function registerToolWithEnforcement(
  server: McpServer,
  name: string,
  description: string,
  schema: any,
  handler: Function
) {
  server.tool(name, description, schema, async (args, context) => {
    const sessionId = context?.sessionId || "unknown";

    // Check enforcement rules from pai_system
    const check = await checkEnforcement(pool, sessionId, name);
    if (!check.allowed) {
      return {
        content: [{
          type: "text",
          text: `Blocked: ${check.message}\n\nCall get_enforcement_rules to see current requirements.`
        }],
        isError: true
      };
    }

    // Execute the actual tool handler
    return handler(args, context);
  });
}
```

Read-only tools (`get_context`, `search_memory`, `get_fabric_pattern`, etc.) are auto-approved by the enforcement rules and pass through immediately. Write tools (`record_learning`, `record_failure`, `record_feedback`) are gated — the enforcement check reads the current rules from `pai_system` and validates session state.

**Rules update without restart.** Push new enforcement rules to the GitHub repo → GitHub Action upserts to `pai_system` → the next tool call reads the updated rules. The MCP server process never needs to restart for rule changes.

### MCP Resources

Resources provide direct access to specific PAI components — useful when a model needs the full text of a principle rather than a semantic search result.

```typescript
// pai-knowledge-mcp/src/resources.ts
export function registerResources(server: McpServer) {

  // The Algorithm — current active version
  server.resource(
    "pai://algorithm",
    "The Algorithm — PAI's core execution framework (current version)",
    async () => {
      const result = await pool.query(
        "SELECT content, metadata FROM pai_system WHERE component_type = 'algorithm' AND is_active ORDER BY updated_at DESC LIMIT 1"
      );
      return {
        contents: [{
          uri: "pai://algorithm",
          mimeType: "text/markdown",
          text: result.rows[0]?.content || "Algorithm not found"
        }]
      };
    }
  );

  // AI Steering Rules
  server.resource(
    "pai://steering-rules",
    "AI Steering Rules — behavioral constraints and operational principles",
    async () => {
      const result = await pool.query(
        "SELECT content FROM pai_system WHERE component_type = 'steering_rule' AND is_active"
      );
      return {
        contents: [{
          uri: "pai://steering-rules",
          mimeType: "text/markdown",
          text: result.rows[0]?.content || "Steering rules not found"
        }]
      };
    }
  );

  // Founding Principles
  server.resource(
    "pai://founding-principles",
    "PAI Founding Principles — core philosophy guiding all decisions",
    async () => {
      const result = await pool.query(
        "SELECT content FROM pai_system WHERE component_type = 'founding_principle' AND is_active"
      );
      return {
        contents: [{
          uri: "pai://founding-principles",
          mimeType: "text/markdown",
          text: result.rows[0]?.content || "Founding principles not found"
        }]
      };
    }
  );

  // Dynamic Fabric pattern resources
  server.resource(
    "pai://fabric/*",
    "Fabric prompt pattern — reusable analytical lens",
    async (uri) => {
      const patternName = uri.pathname.replace(/^\//, "");
      const result = await pool.query(
        "SELECT content FROM pai_system WHERE key = $1 AND is_active",
        [`fabric/${patternName}`]
      );
      return {
        contents: [{
          uri: uri.toString(),
          mimeType: "text/markdown",
          text: result.rows[0]?.content || `Pattern '${patternName}' not found`
        }]
      };
    }
  );

  // Fabric registry — the repository and relationship map
  server.resource(
    "pai://fabric-registry",
    "Fabric registry — map of all repos, services, relationships, and metadata",
    async () => {
      const result = await pool.query(
        "SELECT content, metadata FROM pai_system WHERE component_type = 'fabric_registry' AND is_active ORDER BY updated_at DESC LIMIT 1"
      );
      return {
        contents: [{
          uri: "pai://fabric-registry",
          mimeType: "application/json",
          text: JSON.stringify(result.rows[0]?.metadata || {}, null, 2)
        }]
      };
    }
  );

  // Hook system documentation
  server.resource(
    "pai://hook-system",
    "Hook system — PAI's event-driven automation infrastructure (22 hooks, 7 event types)",
    async () => {
      const result = await pool.query(
        "SELECT content FROM pai_system WHERE component_type = 'hook_system' AND is_active ORDER BY updated_at DESC LIMIT 1"
      );
      return {
        contents: [{
          uri: "pai://hook-system",
          mimeType: "text/markdown",
          text: result.rows[0]?.content || "Hook system not found"
        }]
      };
    }
  );

  // Enforcement rules
  server.resource(
    "pai://enforcement-rules",
    "Enforcement rules — session gating, prerequisites, rate limits for MCP tool calls",
    async () => {
      const result = await pool.query(
        "SELECT content, metadata FROM pai_system WHERE component_type = 'enforcement_rules' AND is_active ORDER BY updated_at DESC LIMIT 1"
      );
      return {
        contents: [{
          uri: "pai://enforcement-rules",
          mimeType: "application/json",
          text: JSON.stringify(result.rows[0]?.metadata || {}, null, 2)
        }]
      };
    }
  );

  // Dynamic skill methodology resources
  server.resource(
    "pai://skills/*",
    "Skill methodology — step-by-step approach for a domain",
    async (uri) => {
      const skillName = uri.pathname.replace(/^\//, "");
      const result = await pool.query(
        "SELECT content FROM pai_system WHERE key = $1 AND is_active",
        [`skill/${skillName}`]
      );
      return {
        contents: [{
          uri: uri.toString(),
          mimeType: "text/markdown",
          text: result.rows[0]?.content || `Skill '${skillName}' not found`
        }]
      };
    }
  );
}
```

### MCP Prompts

Prompts are reusable templates that combine methodology + context for common task types. A model can invoke a prompt to get a pre-assembled system prompt for a specific kind of work.

```typescript
// pai-knowledge-mcp/src/prompts.ts
export function registerPrompts(server: McpServer) {

  server.prompt(
    "investigate",
    "Launch an investigation with full PAI methodology and relevant context",
    {
      topic: z.string().describe("What to investigate"),
      depth: z.enum(["quick", "standard", "deep"]).default("standard")
    },
    async ({ topic, depth }) => {
      const contextLevel = depth === "quick" ? "minimal" : depth === "deep" ? "full" : "standard";
      const ctx = await pool.query(
        "SELECT assemble_context($1, $2) AS context",
        [topic, contextLevel]
      );
      const context = ctx.rows[0].context;

      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `Investigate: ${topic}

Use the following methodology and institutional knowledge:

## Methodology
${context.algorithm || "Use systematic investigation approach."}

## Relevant Learnings
${JSON.stringify(context.learnings || [], null, 2)}

## Domain Knowledge
${JSON.stringify(context.wisdom_frames || [], null, 2)}

## Similar Past Failures (avoid these)
${JSON.stringify(context.similar_failures || [], null, 2)}

## Suggested Fabric Patterns
${JSON.stringify(context.suggested_fabric_patterns || [], null, 2)}

Record any new learnings or failures you discover using the record_learning and record_failure tools.`
          }
        }]
      };
    }
  );

  server.prompt(
    "research",
    "Research a topic with PAI's research methodology and accumulated knowledge",
    {
      topic: z.string().describe("Research topic"),
      mode: z.enum(["quick", "extensive", "deep"]).default("extensive")
    },
    async ({ topic, mode }) => {
      // Similar pattern — assemble context, build prompt
      // Includes Research skill methodology from pai_system
      const ctx = await pool.query(
        "SELECT assemble_context($1, 'full') AS context", [topic]
      );
      const researchSkill = await pool.query(
        "SELECT content FROM pai_system WHERE key = 'skill/Research' AND is_active"
      );
      // ... build research-specific prompt with methodology
    }
  );
}
```

> **Trust boundary: prompt injection risk.** The `investigate` and `research` prompts inject context from `assemble_context()` directly into prompt text — including learnings written by model write-back (`record_learning`). A misbehaving model could write a learning containing adversarial prompt instructions, which would be injected verbatim into future prompts for other models. Mitigations:
> - Sanitize learnings on write: strip known prompt injection patterns (system prompt overrides, role reassignment) in `record_learning()` before persisting.
> - Tag context provenance: include `source: "model_writeback"` vs `source: "github_sync"` metadata so the consuming model (or its system prompt) can apply different trust levels.
> - Content-length limits: cap individual learning content to prevent token-flooding attacks that push real methodology out of the context window.

### How each model connects

**Claude Code (Imladris):**

Add the PAI Knowledge MCP server to `settings.json` alongside the existing MCP servers:

```json
{
  "mcpServers": {
    "pai-knowledge": {
      "command": "node",
      "args": ["/home/seth/.claude/mcp/pai-knowledge-mcp/dist/index.js"],
      "env": {
        "POSTGRES_URL": "postgresql://pai_mcp@localhost:5432/pai"
      }
    }
  }
}
```

Claude Code now has `get_context`, `record_learning`, `search_memory`, etc. as native tools — alongside its existing local file access. It can use both: local files for speed, MCP tools for semantic search and cross-model knowledge.

**Bedrock Opus via Windmill:**

Windmill's agentic orchestrator connects to the MCP server as a client. The Bedrock tool-use loop gets PAI Knowledge tools alongside Windmill's own tools:

```python
# Windmill script: agentic task with PAI Knowledge MCP
from mcp import ClientSession, StdioServerParameters
import subprocess, json

async def main(task_description: str):
    # Connect to PAI Knowledge MCP server
    server_params = StdioServerParameters(
        command="node",
        args=["/opt/pai-knowledge-mcp/dist/index.js"],
        env={"POSTGRES_URL": POSTGRES_URL}
    )

    async with ClientSession(*server_params) as session:
        await session.initialize()

        # List available tools — model discovers knowledge server capabilities
        tools = await session.list_tools()
        # Returns: get_context, record_learning, record_failure,
        #          search_memory, get_fabric_pattern, etc.

        # Get context for this task
        context = await session.call_tool("get_context", {
            "task_description": task_description,
            "context_level": "standard"
        })

        # Build Bedrock tool-use loop with PAI Knowledge tools available
        # Model can call record_learning, record_failure during execution
        bedrock_tools = convert_mcp_tools_to_bedrock_format(tools)
        run_bedrock_agent_loop(
            model="anthropic.claude-opus-4-6-20250610-v1:0",
            system_prompt=build_system_prompt(context),
            tools=bedrock_tools,
            mcp_session=session  # for executing tool calls
        )
```

**Any future MCP-compatible model:**

The MCP spec is open. Any model runtime that implements MCP client protocol connects to the PAI Knowledge server and immediately has access to all tools, resources, and prompts. No per-model integration code for tool discovery. However, each new model still requires a platform-specific boot instruction (system prompt, Gem config, GPT instructions) telling it to call `get_context` and follow the methodology — see [Deployment Pattern: Enforcement](#deployment-pattern-enforcement-is-the-orchestrators-responsibility). Tool access is zero-config; behavioral enforcement is not.

### The PAI Knowledge MCP server vs. existing MCP servers

PAI already uses MCP servers in Claude Code — Cloudflare, Bright Data, Apify, etc. Those are **service-specific** MCP servers: they give Claude Code tools for specific external services.

The PAI Knowledge MCP server is different:

| | Existing MCP servers | PAI Knowledge MCP server |
|--|---------------------|---------------------|
| **Purpose** | Access external services (CDN, proxies, scrapers) | Access PAI's institutional knowledge |
| **Direction** | Claude Code → external world | Any model → PAI's knowledge |
| **State** | Stateless per-call | Stateful (accumulated knowledge, cross-model learning) |
| **Consumer** | Claude Code only | Any MCP-compatible model |
| **Writes** | To external services | To PAI's shared memory (learnings, failures) |
| **Content** | Service-specific (DNS records, scraping results) | Methodology, learnings, wisdom, patterns |

The existing MCP servers give Claude Code hands to touch the outside world. The PAI Knowledge MCP server gives any model institutional knowledge to think with.

### Retrieval paths: local models vs. remote models

Claude Code on the CLI has two retrieval paths — fast local grep for simple lookups, and the MCP server for advanced queries. A remote model (ChatGPT, Gemini, Bedrock Opus via Windmill) has one retrieval path: MCP. There is no other option. The remote model has no filesystem, no shell, no `~/.claude/`, no grep. The MCP server is the sole pipe to PAI's knowledge.

This means the MCP server must handle the full retrieval spectrum — from simple keyword lookups (that grep handles locally) to semantic search and graph traversal. `search_memory` isn't just the advanced tier for remote models; it's the *only* tier.

| Query | Claude Code (local CLI) | Remote model (ChatGPT, Gemini, etc.) |
|-------|------------------------|--------------------------------------|
| "Find TypeScript learnings" | `grep -r "TypeScript" MEMORY/LEARNING/` | `search_memory({ query: "TypeScript" })` → Postgres full-text search |
| "Read the Algorithm" | `cat ~/.claude/PAI/Algorithm/v3.5.0.md` | `get_context()` → reads `pai_system` table |
| "Current Wisdom Frame for React" | `cat MEMORY/WISDOM/react.md` | `search_memory({ query: "React", type: "wisdom_frame" })` |
| "Semantically related failures" | Also uses MCP — grep can't do this | `search_memory({ query: "deployment", semantic: true })` → pgvector |
| "Causal chain of failures" | Also uses MCP — grep can't do this | `query_knowledge_graph(...)` → AGE traversal |
| "Version 3 of this PRD from two weeks ago" | Impossible — filesystem has current version only | `search_memory({ key: "...", version: 3 })` → version history |

**The design consequence:** `search_memory` must be fast and effective for simple keyword queries, not just semantic ones. A remote model calling `search_memory({ query: "TypeScript" })` should get results as fast and relevant as Claude Code running `grep -r "TypeScript"` locally. Postgres full-text search (`tsvector`) handles this — it's the middle tier between literal grep and embedding similarity, and it's what remote models hit for everyday keyword lookups.

```
Claude Code (local CLI):
  ┌─────────────┐     ┌──────────────────┐
  │ Filesystem   │     │ MCP Server       │
  │ grep, cat    │     │ (Postgres)       │
  │              │     │                  │
  │ Simple       │     │ Semantic search  │
  │ lookups      │     │ Graph traversal  │
  │ (fast, local)│     │ Version history  │
  └──────────────┘     └──────────────────┘
        ↑                      ↑
        │ most queries         │ when grep can't answer
        └──────── Claude Code uses both ──────┘

Remote model (ChatGPT, Gemini, Bedrock, etc.):
                       ┌──────────────────┐
                       │ MCP Server       │
                       │ (Postgres)       │
                       │                  │
                       │ ALL retrieval:   │
                       │ keyword search   │
                       │ semantic search  │
                       │ graph traversal  │
                       │ version history  │
                       └──────────────────┘
                              ↑
                              │ every query, no alternative
                              │
                        Remote model
                     (no filesystem access)
```

### Updated architecture diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         GitHub PAI Repo                         │
│  Algorithm, Steering Rules, Skills, Fabric, Principles          │
└─────────────┬───────────────────────────────────────────────────┘
              │ GitHub Action (on push)
              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      PostgreSQL                           │
│  pai_system (methodology) + memory_objects (knowledge)           │
│  assemble_context() + record_learning() + search_memory()       │
│  memory_vectors (embeddings) + knowledge graph (AGE)            │
└──────────────────────────────┬──────────────────────────────────┘
                               │ SQL
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PAI Knowledge MCP Server                          │
│                                                                  │
│  Tools: get_context, search_memory, record_learning,             │
│         record_failure, get_fabric_pattern, suggest_patterns,    │
│         query_knowledge_graph, record_feedback,                  │
│         get_fabric_registry, get_enforcement_rules               │
│                                                                  │
│  Resources: pai://algorithm, pai://steering-rules,               │
│             pai://fabric/*, pai://skills/*,                       │
│             pai://fabric-registry, pai://hook-system,             │
│             pai://enforcement-rules                               │
│                                                                  │
│  Prompts: investigate, research, security_review                 │
└──────┬──────────────────┬───────────────────┬───────────────────┘
       │ MCP              │ MCP               │ MCP
       ▼                  ▼                   ▼
┌─────────────┐  ┌───────────────┐  ┌──────────────────┐
│ Claude Code  │  │ Bedrock Opus  │  │ Any Future Model │
│ (Imladris)   │  │ (Windmill)    │  │ (MCP-compatible) │
│              │  │               │  │                  │
│ Full PAI     │  │ Knowledge tools + │  │ Knowledge tools +    │
│ runtime +    │  │ own tool-use  │  │ own capabilities │
│ Knowledge MCP    │  │               │  │                  │
└─────────────┘  └───────────────┘  └──────────────────┘
       │                  │                   │
       └──── all models read AND write ───────┘
              to the same shared knowledge base
```

### Updated Phase 3c roadmap entry

Phase 3c becomes: **PAI Knowledge MCP Server** — not just "multi-agent knowledge sharing" but a concrete MCP server that makes PAI's institutional knowledge accessible to any model.

Dependencies:
- Phase 1a (data in Postgres)
- Phase 2a (pgvector for semantic search)
- Phase 2c (pgml for in-database embedding generation)
- `pai_system` table and GitHub sync (this spec)
- Write-back functions (`record_learning`, `record_failure`, `record_feedback`)

Implementation: ~500 lines of TypeScript. Thin translation layer over Postgres functions. The intelligence stays in SQL; the MCP server handles transport and tool descriptions.

### Deployment Pattern: Enforcement Is the Orchestrator's Responsibility

MCP is a transport protocol. It delivers tools, resources, and data. It cannot constrain how a model behaves after receiving that data. A model that calls `get_context` and receives the Algorithm is free to ignore it — MCP has no enforcement mechanism.

**This is by design.** Enforcement belongs to the layer that controls the system prompt — the orchestrator, not the protocol. Each platform has its own system prompt mechanism:

| Platform | Enforcement layer | What it says |
|----------|------------------|--------------|
| **Claude Code** | `CLAUDE.md` | "You MUST call `get_context` before responding. Follow the methodology it returns." |
| **Gemini** | Gem instructions | Same — system instructions for a custom Gem |
| **ChatGPT** | Custom GPT instructions | Same — system instructions for a custom GPT |
| **Windmill** | Script preamble | Agentic script hardcodes `get_context` call before task execution |
| **Open WebUI** | Model file / system prompt | Same pattern |
| **Any agent framework** | System prompt config | Same pattern |

The deployment pattern is always:

1. **Connect** the PAI Knowledge MCP server to the platform
2. **Configure** the platform's native system prompt to enforce the methodology ("call `get_context` first, follow what it returns")
3. **The Algorithm lives in the MCP tool output**, not the system prompt — so it stays centralized and version-controlled in Postgres

The system prompt is the boot instruction — it just says "use the knowledge server." The knowledge server says *how*. This is a clean separation of concerns:

- **Boot instruction** (platform-specific): Gem config, CLAUDE.md, GPT instructions — each platform has its own format. These are small, static, and rarely change.
- **Methodology and knowledge** (platform-agnostic): Algorithm, steering rules, learnings, patterns — all served by the MCP server from Postgres. These are large, dynamic, and updated continuously.

Update the Algorithm in one place (push to GitHub → GitHub Action syncs to Postgres → MCP server serves new version) and every connected model gets it. No per-model prompt engineering. No manual deployment across platforms.

**What about models that connect without a configured system prompt?** They can still call `get_context` and receive the Algorithm — but nothing forces them to follow it. The PAI Knowledge MCP server can gate write-back (refuse `record_learning` from sessions that never called `get_context`), but it cannot gate behavior. This is the correct tradeoff: knowledge is open, methodology is recommended, enforcement is the orchestrator's job.

```
┌─────────────────────────────────────────────────────────────┐
│                    Platform Orchestrator                      │
│                                                              │
│  System prompt: "Call get_context. Follow the Algorithm."    │
│  (CLAUDE.md / Gem / Custom GPT / Script preamble)           │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                     Model Runtime                      │  │
│  │                                                        │  │
│  │  1. Discovers PAI Knowledge tools via MCP                  │  │
│  │  2. Calls get_context (enforced by system prompt)      │  │
│  │  3. Receives Algorithm + context + learnings           │  │
│  │  4. Follows methodology (guided by system prompt)      │  │
│  │  5. Writes learnings back via record_learning          │  │
│  └──────────────────────┬─────────────────────────────────┘  │
└─────────────────────────┼────────────────────────────────────┘
                          │ MCP
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    PAI Knowledge MCP Server                       │
│                                                              │
│  Serves: Algorithm, methodology, learnings, patterns         │
│  Accepts: new learnings, failures, feedback                  │
│  Gates: write-back requires prior get_context call           │
│  Does NOT enforce: model behavior after receiving context    │
└─────────────────────────────────────────────────────────────┘
```

---

## Domain Separation and Multi-User Expansion

The PAI Knowledge MCP Server is designed for one user on one machine. This section defines how it extends — first to separate home and work contexts for one user, then to multiple users within an organization. Each layer is additive: domain separation adds a column and a filter; multi-user adds identity, row-level security, and scope.

### Domain Separation (single user): Separate Databases

A single user operates across domains — personal projects at home, professional work at the office. Some knowledge is universal (the Algorithm, founding principles, Wisdom Frames), some is domain-specific (work PRDs don't belong in personal context, home automation learnings don't belong in work context).

**The right boundary is the database, not a column.** Personal and work data have different ownership, retention, backup, and legal exposure profiles. A `domain` column with row-level filtering keeps everything in one database — which means one set of backup policies, one admin surface, one subpoena scope. If the work database is subject to employer retention policies, corporate audits, or legal holds, personal data in the same database is caught in the same net.

Separate databases on the same Postgres instance give clean isolation with minimal overhead:

```
PostgreSQL instance
├── pai_personal   ← personal domain, personal backups, personal retention
├── pai_work       ← work domain, company policies apply
└── windmill       ← unchanged
```

**Each database is a complete, independent PAI memory store** — its own `memory_objects`, `memory_vectors`, `pai_system`, knowledge graph. Same schema, same Postgres functions, same `assemble_context()`. The only difference is connection string.

**Shared methodology (the Algorithm, principles, Wisdom Frames)** lives in both databases — synced from the same GitHub repo via the same GitHub Action, writing to `pai_system` in each. Update the Algorithm once, both databases get it. The methodology is identical; the accumulated knowledge is separate.

**MCP server configuration:** two approaches, both valid:

*Option A — one MCP server, two connection strings:*

```
get_context({ task: "deploy feature", domain: "work" })
  → MCP server connects to pai_work, assembles context from work knowledge

get_context({ task: "fix home assistant", domain: "home" })
  → MCP server connects to pai_personal, assembles context from personal knowledge
```

The `domain` parameter selects which database to query. The MCP server maintains two connection pools. Simple routing, one process.

*Option B — two MCP server instances:*

```json
{
  "pai-knowledge-work": {
    "command": "node",
    "args": ["/home/seth/.claude/mcp/pai-knowledge-mcp/dist/index.js"],
    "env": { "POSTGRES_URL": "postgresql://pai_mcp@localhost:5432/pai_work" }
  },
  "pai-knowledge-personal": {
    "command": "node",
    "args": ["/home/seth/.claude/mcp/pai-knowledge-mcp/dist/index.js"],
    "env": { "POSTGRES_URL": "postgresql://pai_mcp@localhost:5432/pai_personal" }
  }
}
```

Complete process isolation. CLAUDE.md or project-level `.claude/CLAUDE.md` specifies which server to use:

```
# In ~/work/ projects:
Use pai-knowledge-work for all get_context and record_learning calls.

# In ~/personal/ projects:
Use pai-knowledge-personal for all get_context and record_learning calls.
```

**Recommended default: Option B (two instances).** For a single user, Option B is simpler — no routing logic, no domain parameter, complete process isolation. Option A adds complexity (two connection pools, domain validation, routing bugs) that only pays off if you need cross-domain queries in a single MCP call, which is an uncommon use case. Start with Option B; collapse to Option A only if managing two processes becomes a burden.

**Write-back isolation:** learnings recorded during work go to `pai_work`. Learnings recorded during personal projects go to `pai_personal`. No cross-contamination. If you discover something at work that's genuinely universal, you manually promote it — push to the shared GitHub methodology repo, and both databases pick it up on the next sync.

**What this gives you:**
- Work data stays under work governance — backups, retention, audit, legal holds
- Personal data stays personal — your backup schedule, your retention, your control
- Either database can be deleted, migrated, or handed over independently
- No RLS complexity — isolation is physical, not logical
- The Algorithm and methodology stay shared via GitHub, not database-level sharing

**What stays the same:**
- One Postgres instance (two databases is a config-level separation, not infrastructure)
- Same MCP server code — connection string is the only difference
- Same Postgres functions, same schema, same `assemble_context()`
- GitHub sync writes methodology to both databases
- The enforcement model — CLAUDE.md directs which server/database to use

**What lives where:**

| Content type | `pai_personal` | `pai_work` | How it gets there |
|-------------|:-:|:-:|-------------------|
| Algorithm (all versions) | Yes | Yes | GitHub sync writes to both |
| Founding principles | Yes | Yes | GitHub sync writes to both |
| Wisdom Frames | Yes | Yes | GitHub sync writes to both |
| Fabric patterns | Yes | Yes | GitHub sync writes to both |
| Skills methodology | Yes | Yes | GitHub sync writes to both |
| Steering rules | Some | Some | Universal rules sync to both; domain-specific rules sync to one |
| Learnings | Personal only | Work only | Written by `record_learning()` to the active database |
| PRDs | — | Work only | Professional deliverables |
| Failure captures | Personal only | Work only | Written to the database active during the session |

Each database is a complete, self-contained domain. The methodology layer (Algorithm, principles, patterns) is replicated to both via GitHub sync. The knowledge layer (learnings, failures, PRDs) is domain-specific and never crosses.

### Multi-User Expansion (company deployment)

Domain separation uses separate databases — physical isolation, no shared tables, no filtering logic. Multi-user adds identity, row-level security, and scope *within* a single domain database (e.g., `pai_work` becomes multi-user when coworkers join). The architecture stays the same — one Postgres instance, same MCP server code, same Postgres functions — but every query now runs through row-level security.

#### Identity and authentication

The MCP server needs to know who is calling. Today it's implicitly one user. Multi-user adds:

- **MCP transport-level auth:** each connection authenticates via API key, SSO token, or mTLS certificate
- **User identity extraction:** the MCP server resolves the authenticated connection to a `user_id`
- **Every tool call carries identity:** `get_context`, `record_learning`, `search_memory` — all execute in the context of the authenticated user

No anonymous access. Every read and write is attributed.

#### Schema changes

```sql
-- User and team tables
CREATE TABLE pai_users (
    user_id    TEXT PRIMARY KEY,       -- 'seth', 'alice', 'bob'
    team_id    TEXT,                    -- nullable, for team grouping
    role       TEXT DEFAULT 'member',   -- 'admin', 'member'
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE pai_teams (
    team_id    TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Extend memory_objects
ALTER TABLE memory_objects ADD COLUMN user_id TEXT NOT NULL DEFAULT 'seth';
ALTER TABLE memory_objects ADD COLUMN scope   TEXT NOT NULL DEFAULT 'private';
-- scope values: 'private' (only me), 'team' (my team), 'org' (everyone)
ALTER TABLE memory_objects ADD COLUMN team_id TEXT;
```

#### Row-level security

```sql
ALTER TABLE memory_objects ENABLE ROW LEVEL SECURITY;

-- Users see: their own content + their team's shared content + org-wide content
CREATE POLICY user_read_policy ON memory_objects FOR SELECT USING (
    user_id = current_setting('app.current_user')
    OR (scope = 'team' AND team_id = current_setting('app.current_team'))
    OR scope = 'org'
);

-- Users write only their own content
CREATE POLICY user_write_policy ON memory_objects FOR INSERT WITH CHECK (
    user_id = current_setting('app.current_user')
);
```

The MCP server sets `app.current_user` and `app.current_team` on each connection before executing any query. Postgres enforces isolation — the MCP server doesn't need to filter manually.

#### Context assembly with scoped knowledge

`assemble_context()` returns layered context, from broadest to most specific:

```
┌─────────────────────────────────────────────┐
│  Org methodology (company Algorithm, shared  │
│  steering rules, org-promoted learnings)     │
├─────────────────────────────────────────────┤
│  Team knowledge (team learnings, team        │
│  patterns, team failure history)             │
├─────────────────────────────────────────────┤
│  Personal knowledge (my learnings, my        │
│  patterns, my domain-specific context)       │
└─────────────────────────────────────────────┘
```

RLS handles this automatically — `assemble_context()` queries `memory_objects` and Postgres returns only rows the user is authorized to see. The function doesn't change; the security policy does the work.

#### Knowledge promotion

Learnings start as `private`. A curation workflow promotes them:

| Transition | Who can do it | Mechanism |
|-----------|--------------|-----------|
| `private` → `team` | Author or team admin | `promote_learning(learning_id, 'team')` |
| `team` → `org` | Org admin | `promote_learning(learning_id, 'org')` |
| `org` → `team`/`private` | Org admin | `demote_learning(learning_id, 'team')` |

New MCP tools for multi-user:

```
promote_learning({ learning_id, target_scope })  -- requires appropriate role
list_team_learnings({ team_id })                  -- scoped by RLS
list_org_learnings()                              -- org-scope only
```

#### What changes vs. what doesn't

| Component | Single-user | Multi-user change |
|-----------|------------|-------------------|
| Postgres instance | One | Same one — RLS handles isolation |
| MCP server | No auth | Auth middleware, user context on each connection |
| `assemble_context()` | No user filter | RLS applies automatically |
| `record_learning()` | No attribution | Writes with `user_id`, defaults to `private` scope |
| GitHub sync | One repo → Postgres | One repo for org methodology, syncs to `scope = 'org'` |
| CLAUDE.md enforcement | One user's CLAUDE.md | Each user's CLAUDE.md (or company-managed template) |
| Postgres functions | No RLS | RLS policies on all tables |
| MCP tools | 7 existing tools | +3 promotion/team tools |

#### Deployment model

```
┌─────────────────────────────────────────────────────────────────┐
│                        PostgreSQL                          │
│                                                                  │
│  pai_personal database (single-user, Seth only)                  │
│  ├── memory_objects, memory_vectors, knowledge graph             │
│  ├── pai_system (methodology via GitHub sync)                    │
│  └── No RLS needed — one user                                   │
│                                                                  │
│  pai_work database (multi-user when team joins)                  │
│  ├── memory_objects (RLS: user_id, scope, team_id)               │
│  ├── memory_vectors (RLS inherits from memory_objects)           │
│  ├── pai_system (methodology via GitHub sync)                    │
│  ├── pai_users / pai_teams                                       │
│  └── knowledge graph (AGE, RLS on edges/nodes)                  │
│                                                                  │
│  windmill database (unchanged)                                   │
└────────────┬────────────────────────────┬────────────────────────┘
             │ SQL                        │ SQL (with RLS context)
             ▼                            ▼
┌────────────────────────┐  ┌──────────────────────────────────────┐
│ PAI Knowledge MCP      │  │ PAI Knowledge MCP                     │
│ (personal instance)    │  │ (work instance)                       │
│                        │  │                                       │
│ Same code, different   │  │ Auth middleware: token → user_id      │
│ connection string      │  │ RLS context: SET app.current_user     │
│ No auth needed         │  │ + promote_learning, list_team/org     │
└──────────┬─────────────┘  └──────┬──────────────┬────────────────┘
           │ MCP                   │ MCP          │ MCP
           ▼                       ▼              ▼
┌─────────────────┐  ┌───────────┐  ┌───────────┐     ┌───────────┐
│ Seth (personal)  │  │ Seth       │  │ Alice      │     │ Bob        │
│ Claude Code      │  │ (work)     │  │ (Claude    │     │ (Gemini    │
│ ~/personal/*     │  │ Claude     │  │  Code)     │     │  Gem)      │
│                  │  │ Code       │  │            │     │            │
│ Full personal    │  │ ~/work/*   │  │ Sees: org  │     │ Sees: org  │
│ knowledge        │  │            │  │ + team     │     │ + team     │
│                  │  │ Sees: org  │  │ + private  │     │ + private  │
│                  │  │ + team     │  │            │     │            │
│                  │  │ + private  │  │            │     │            │
└─────────────────┘  └───────────┘  └───────────┘     └───────────┘
```

#### The progression

1. **Today:** One user, one database. Everything is Seth's.
2. **Domain separation:** Separate databases (`pai_personal`, `pai_work`). Physical isolation — different backup policies, different retention, different legal exposure. Shared methodology via GitHub sync to both. No auth changes, no RLS, no filtering logic.
3. **Multi-user (within a domain):** Identity layer, RLS, scope column *within* `pai_work`. Coworkers join the work domain. Personal database stays single-user. Same Postgres instance, same MCP server code, same Postgres functions.

Each layer builds on the previous without rearchitecting. Domain separation is infrastructure-level (separate databases). Multi-tenancy is database-level (RLS within a shared database). The MCP server stays thin — connection string picks the domain, RLS picks the user.

---

## Windmill Database Consolidation

Windmill uses PostgreSQL as its backend database — job history, script versions, schedule state, workspace configuration, and audit logs all live in Postgres. In the current Imladris Docker stack, this is a separate Postgres container running alongside the Windmill server and workers.

Once PostgreSQL exists for PAI memory, Windmill's backend database moves to that same Postgres instance. One config change: point Windmill's `DATABASE_URL` at the self-hosted Postgres instead of the local container.

### What this changes

| Before | After |
|--------|-------|
| Windmill Postgres container on EC2 | Self-hosted Postgres (pgBackRest to S3) |
| Job history lost if container dies | Job history durable with PITR |
| Script versions in local container storage | Script versions replicated across AZs |
| Separate backup strategy (or none) | Covered by pgBackRest automated backups to S3 |
| Two Postgres instances to manage | One Postgres instance, schema-isolated |

### What this doesn't change

Windmill continues working identically. Credential vault, MCP tool execution, cron scheduling, agentic Bedrock orchestration, worker containers — all unchanged. This is a backend database swap, not a Windmill migration.

### Schema isolation

PAI memory and Windmill use separate databases on the same Postgres instance:

```
PostgreSQL instance
├── pai_memory     ← sync daemon, memory_objects, memory_vectors, knowledge graph
└── windmill       ← Windmill's internal schema (job queue, scripts, schedules, audit)
```

Separate databases means separate connection strings, separate permissions, no table collisions. Postgres handles both workloads — PAI memory is write-light/read-heavy, Windmill is write-moderate with short-lived job records. No contention.

### What this enables (not required, but free)

Once Windmill's job history and PAI memory share an Postgres instance, cross-database queries become possible via `postgres_fdw` or application-level joins:

- **Correlate PAI sessions with Windmill job executions.** "Which Windmill tools did Claude call during the session that produced this learning?"
- **Audit trail unification.** One place to query both what PAI learned and what actions Windmill executed.
- **Windmill job failure analysis.** Surface Windmill execution failures alongside PAI failure captures — are they related?

These are optional. The primary value is simpler: one fewer container, one fewer thing to back up, one fewer Postgres to manage.

### Implementation

Phase 1a (sync daemon + Postgres setup). When Postgres is provisioned:

1. Create the `windmill` database on the Postgres instance
2. Update Windmill's `docker-compose.yml`: change `DATABASE_URL` to the Postgres endpoint
3. Remove the Windmill Postgres container from the Docker stack
4. Verify Windmill starts cleanly against Postgres (Windmill runs its own migrations on startup)

No data migration needed — Windmill's historical job data in the old container is ephemeral. Fresh start against Postgres is fine.

---

## Operational Data Consolidation: SQLite → Postgres

The Windmill Database Consolidation section above covers Windmill's **internal** Postgres (job queue, script versions, audit). This section covers the **operational data** that drives the DevOps pipeline — the triage/investigation pipeline data that currently lives in a SQLite database on NVMe at `/local/cache/triage/index.db`, managed by `cache_lib.ts`.

This is the most active data in Imladris. Every email, Slack message, and SDP ticket flows through it. Every investigation result lives in it. Every SDP task creation reads from it. Moving it to Postgres is not just a durability upgrade — it's the prerequisite for cross-system correlation between DevOps operations and PAI institutional knowledge.

### What currently lives in SQLite

The `cache_lib.ts` module manages seven tables in a single SQLite database:

```sql
-- Core item store with full-text search
CREATE TABLE items (
    key TEXT PRIMARY KEY,
    value TEXT,
    metadata TEXT,          -- JSON string
    created_at TEXT,
    updated_at TEXT,
    expires_at TEXT
);
CREATE VIRTUAL TABLE items_fts USING fts5(key, value, content=items);

-- Entity extraction index (populated by entity_extract.ts)
CREATE TABLE entity_index (
    entity_id TEXT PRIMARY KEY,
    entity_type TEXT,       -- 'person', 'service', 'host', 'ip', etc.
    entity_value TEXT,
    source_key TEXT,        -- references items.key
    confidence REAL,
    extracted_at TEXT
);

-- Rule-based triage classification
CREATE TABLE triage_rules (
    rule_id TEXT PRIMARY KEY,
    source TEXT,            -- 'email', 'slack', 'sdp'
    pattern TEXT,           -- regex or keyword pattern
    action TEXT,            -- 'NOTIFY', 'QUEUE', 'AUTO'
    priority INTEGER,
    created_at TEXT
);

-- Main pipeline state: every triaged item and its investigation status
CREATE TABLE triage_results (
    id TEXT PRIMARY KEY,
    source TEXT,            -- 'email', 'slack', 'sdp'
    source_id TEXT,         -- original message/ticket ID
    subject TEXT,
    summary TEXT,           -- AI-generated triage summary
    action TEXT,            -- 'NOTIFY', 'QUEUE', 'AUTO'
    priority TEXT,          -- 'critical', 'high', 'medium', 'low'
    investigated INTEGER DEFAULT 0,
    investigation_result TEXT,   -- JSON: { severity, confidence, root_cause, evidence, criteria_status }
    investigation_job_id TEXT,
    sdp_task_id TEXT,       -- SDP task created from investigation
    retry_count INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
);

-- Async investigation job tracking
CREATE TABLE investigation_jobs (
    job_id TEXT PRIMARY KEY,
    triage_id TEXT,         -- references triage_results.id
    status TEXT,            -- 'pending', 'running', 'completed', 'failed'
    windmill_job_id TEXT,   -- Windmill's own job ID
    started_at TEXT,
    completed_at TEXT,
    error TEXT
);

-- AWS resource inventory (populated by discover_resources.ts)
CREATE TABLE resource_inventory (
    resource_id TEXT PRIMARY KEY,
    resource_type TEXT,     -- 'ec2', 'rds', 'lambda', 's3', etc.
    account_id TEXT,
    region TEXT,
    name TEXT,
    metadata TEXT,          -- JSON string
    discovered_at TEXT,
    updated_at TEXT
);

-- Tracking missing tool capabilities identified during investigations
CREATE TABLE capability_gaps (
    gap_id TEXT PRIMARY KEY,
    tool_name TEXT,
    description TEXT,
    frequency INTEGER DEFAULT 1,
    first_seen TEXT,
    last_seen TEXT
);
```

### Why move to Postgres

| Property | SQLite on NVMe | PostgreSQL |
|----------|---------------|-------------------|
| Durability | Single disk, single machine — NVMe failure = total data loss | Multi-AZ, automated snapshots, PITR |
| Concurrency | Single-writer lock — Windmill workers contend on writes | MVCC — concurrent reads and writes without blocking |
| Querying | SQLite FTS5 for text search, no joins across databases | Full-text search (tsvector), JSONB operators, joins to PAI memory |
| Cross-correlation | Impossible — SQLite is isolated from PAI knowledge | Direct SQL joins: "find PAI learnings related to this investigation" |
| Analytics | Manual queries via `query_cache` MCP tool | Window functions, materialized views, pg_cron scheduled analytics |
| Embedding search | Not available | pgvector: "find similar past investigations by embedding similarity" |
| Graph traversal | Not available | AGE: "trace the causal chain from this alert to previous incidents" |

The concurrency issue is real today. Windmill runs 16 worker slots (4 workers × 4 each). When `batch_triage_emails.ts`, `batch_triage_slack.ts`, and `batch_triage_sdp.ts` run on their cron schedules, they compete for the SQLite write lock. `process_actionable.ts` phases also contend when updating investigation status. PostgreSQL eliminates this with MVCC.

### Postgres schema for operational data

The operational data gets its own schema within the `windmill` database (not `pai_memory`) — it's operational state, not institutional knowledge. The two databases share an Postgres instance but maintain separate concerns.

```
PostgreSQL instance
├── pai_memory     ← sync daemon, memory_objects, memory_vectors, knowledge graph
├── windmill       ← Windmill internals (job queue, scripts, schedules, audit)
│   └── pai_ops schema ← operational data (triage, investigations, resources)
└── (optional: pai_work, pai_personal for domain separation)
```

```sql
-- Within the windmill database, separate schema for operational data
CREATE SCHEMA pai_ops;

-- Core item store (replaces SQLite items + items_fts)
CREATE TABLE pai_ops.items (
    key           TEXT PRIMARY KEY,
    value         TEXT,
    metadata      JSONB,        -- native JSONB instead of JSON string
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    expires_at    TIMESTAMPTZ
);

-- Full-text search via tsvector (replaces FTS5)
ALTER TABLE pai_ops.items ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(key, '') || ' ' || coalesce(value, ''))) STORED;
CREATE INDEX items_fts_idx ON pai_ops.items USING gin(search_vector);

-- Triage pipeline state
CREATE TABLE pai_ops.triage_results (
    id                   TEXT PRIMARY KEY,
    source               TEXT NOT NULL,      -- 'email', 'slack', 'sdp'
    source_id            TEXT NOT NULL,       -- original message/ticket ID
    subject              TEXT,
    summary              TEXT,
    action               TEXT NOT NULL,       -- 'NOTIFY', 'QUEUE', 'AUTO'
    priority             TEXT DEFAULT 'medium',
    investigated         BOOLEAN DEFAULT FALSE,
    investigation_result JSONB,              -- structured: { severity, confidence, root_cause, evidence, criteria_status }
    investigation_job_id TEXT,
    sdp_task_id          TEXT,
    retry_count          INTEGER DEFAULT 0,
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at           TIMESTAMPTZ DEFAULT NOW(),

    -- Dedup constraint: one entry per source + source_id
    UNIQUE (source, source_id)
);

-- Indexes for the queries process_actionable.ts actually runs
CREATE INDEX triage_uninvestigated_idx ON pai_ops.triage_results (action, investigated)
    WHERE action IN ('QUEUE', 'NOTIFY') AND investigated = FALSE;
CREATE INDEX triage_pending_tasks_idx ON pai_ops.triage_results (investigated, sdp_task_id)
    WHERE investigated = TRUE AND sdp_task_id IS NULL;

-- Investigation jobs (async tracking)
-- Diagnosis data lives in triage_results.investigation_result (JSONB) — single source of truth.
-- This table tracks job execution state only. Query diagnosis via triage_results.
CREATE TABLE pai_ops.investigation_jobs (
    job_id          TEXT PRIMARY KEY,
    triage_id       TEXT NOT NULL REFERENCES pai_ops.triage_results(id),
    status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'running', 'completed', 'failed'
    windmill_job_id TEXT,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    error           TEXT
);

-- Entity extraction index
CREATE TABLE pai_ops.entity_index (
    entity_id    TEXT PRIMARY KEY,
    entity_type  TEXT NOT NULL,     -- 'person', 'service', 'host', 'ip', 'account'
    entity_value TEXT NOT NULL,
    source_key   TEXT,
    confidence   REAL,
    extracted_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX entity_type_value_idx ON pai_ops.entity_index (entity_type, entity_value);

-- AWS resource inventory
CREATE TABLE pai_ops.resource_inventory (
    resource_id   TEXT PRIMARY KEY,
    resource_type TEXT NOT NULL,
    account_id    TEXT,
    region        TEXT,
    name          TEXT,
    metadata      JSONB,
    discovered_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX resource_type_idx ON pai_ops.resource_inventory (resource_type);
CREATE INDEX resource_account_region_idx ON pai_ops.resource_inventory (account_id, region);

-- Capability gaps (tracks what investigation tools are missing)
CREATE TABLE pai_ops.capability_gaps (
    gap_id      TEXT PRIMARY KEY,
    tool_name   TEXT NOT NULL,
    description TEXT,
    frequency   INTEGER DEFAULT 1,
    first_seen  TIMESTAMPTZ DEFAULT NOW(),
    last_seen   TIMESTAMPTZ DEFAULT NOW()
);

-- Triage rules (deterministic classification)
CREATE TABLE pai_ops.triage_rules (
    rule_id    TEXT PRIMARY KEY,
    source     TEXT NOT NULL,
    pattern    TEXT NOT NULL,
    action     TEXT NOT NULL,
    priority   INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### The investigation diagnosis shape

The `agentic_investigator.ts` produces a structured output after its multi-round tool-use loop (up to 8 rounds using Bedrock Converse API with Claude Opus). The diagnosis is stored as `investigation_result` JSONB in `triage_results`:

```jsonc
{
    "severity": "high",           // critical | high | medium | low | info
    "confidence": "high",         // high | medium | low — only "high" is accepted
    "root_cause": "SSL certificate on api.example.com expired 2 days ago, causing cascading 502s from the load balancer",
    "evidence": [
        {
            "tool": "get_cloudwatch_alarms",
            "finding": "ALARM state on TargetResponseTime for ALB prod-api since 2026-03-04T14:30Z",
            "relevance": "Confirms elevated latency began at same time as user report"
        },
        {
            "tool": "check_network",
            "finding": "TLS handshake failure to api.example.com:443 — certificate expired 2026-03-04",
            "relevance": "Root cause: expired certificate"
        },
        {
            "tool": "get_sdp_tickets",
            "finding": "3 other tickets in last 48h mentioning 502 errors on prod-api",
            "relevance": "Corroborates: multiple users affected by same issue"
        }
    ],
    "criteria_status": {
        "root_cause_identified": true,
        "evidence_corroborated": true,
        "affected_scope_determined": true,
        "remediation_suggested": true
    },
    "remediation": "Renew SSL certificate via ACM. Set up CloudWatch alarm on DaysToExpiry < 30.",
    "rounds_used": 4,
    "tools_called": ["get_cloudwatch_alarms", "check_network", "get_sdp_tickets", "get_ec2_instances"]
}
```

**Confidence gating:** The investigator rejects medium/low confidence results early — if after 4+ rounds it can't reach "high" confidence, it reports what it found and flags the item for manual review rather than producing a speculative diagnosis. This gating logic stays in the Windmill script; Postgres stores the result regardless.

### Cross-system correlation: the real payoff

With both operational data and PAI institutional knowledge in Postgres (different databases, same instance), `postgres_fdw` enables queries that are impossible today:

```sql
-- Connect PAI memory from the windmill database
CREATE EXTENSION postgres_fdw;
CREATE SERVER pai_memory_server FOREIGN DATA WRAPPER postgres_fdw
    OPTIONS (dbname 'pai_memory');
CREATE USER MAPPING FOR windmill_ops SERVER pai_memory_server
    OPTIONS (user 'pai_readonly');

-- Import the memory tables we need
CREATE FOREIGN TABLE pai_ops.pai_learnings (
    key TEXT, content TEXT, metadata JSONB, created_at TIMESTAMPTZ
) SERVER pai_memory_server OPTIONS (schema_name 'public', table_name 'memory_objects');

-- Now: "Find PAI learnings related to recent high-severity investigations"
SELECT t.subject, t.investigation_result->>'root_cause' AS root_cause,
       l.content AS related_learning
FROM pai_ops.triage_results t
JOIN pai_ops.pai_learnings l ON l.content ILIKE '%' || (t.investigation_result->>'root_cause') || '%'
WHERE t.investigation_result->>'severity' IN ('critical', 'high')
  AND t.created_at > NOW() - INTERVAL '7 days';

-- "Which investigation tools correlate with successful high-confidence diagnoses?"
-- Diagnosis fields are queried from triage_results.investigation_result JSONB (single source of truth)
SELECT tool, COUNT(*) AS uses,
       AVG(CASE WHEN t.investigation_result->>'confidence' = 'high' THEN 1 ELSE 0 END) AS high_confidence_rate
FROM pai_ops.triage_results t,
     jsonb_array_elements_text(t.investigation_result->'tools_called') AS tool
WHERE t.investigated = TRUE
  AND t.investigation_result IS NOT NULL
GROUP BY tool
ORDER BY uses DESC;

-- "Are we seeing the same root causes repeatedly?"
SELECT investigation_result->>'root_cause' AS root_cause,
       COUNT(*) AS occurrences,
       array_agg(source || ':' || source_id) AS affected_items
FROM pai_ops.triage_results
WHERE investigation_result->>'confidence' = 'high'
  AND created_at > NOW() - INTERVAL '30 days'
GROUP BY investigation_result->>'root_cause'
HAVING COUNT(*) > 1
ORDER BY occurrences DESC;
```

> **Performance note on `postgres_fdw` cross-database joins.** Foreign table scans don't push complex predicates to the remote side — the `ILIKE '%' || root_cause || '%'` join above will pull all rows from `pai_learnings` and filter locally. This is fine for batch analytics (nightly correlation reports, periodic reviews) but not for sub-second interactive queries. For real-time correlation, use application-level queries (two separate queries joined in code), or pre-compute correlations via a materialized view refreshed by `pg_cron`. The `correlate_ops_knowledge` MCP tool described below should use the application-level approach.

### SDP integration touchpoints

`process_actionable.ts` runs a 3-phase pipeline that bridges triage results to SDP (Service Desk Plus Cloud). The Postgres migration changes how state is tracked but not how SDP is called:

| Phase | Current (SQLite) | After (Postgres) |
|-------|-----------------|----------------|
| **Phase 1: INVESTIGATE** | `SELECT * FROM triage_results WHERE action IN ('QUEUE','NOTIFY') AND investigated = 0` | Same query, Postgres syntax: `WHERE investigated = FALSE` |
| **Phase 2: CREATE TASKS** | Reads `investigation_result` JSON string, parses in TypeScript, creates SDP task via API, writes `sdp_task_id` back | Reads `investigation_result` JSONB natively, same SDP API call, same write-back |
| **Phase 3: ESCALATE** | `SELECT * FROM triage_results WHERE retry_count >= 3 AND sdp_task_id IS NULL` | Same query, same escalation logic |

**What changes in the scripts:**
- `cache_lib.ts`: Replace `better-sqlite3` with `pg` (already a dependency in `windmill/package.json`). Connection pool instead of single-file handle. JSONB instead of `JSON.stringify`/`JSON.parse`.
- `process_actionable.ts`: No change — it calls `cache_lib` functions, not SQLite directly.
- `agentic_investigator.ts`: No change — it returns a diagnosis object. The caller (`process_actionable.ts`) stores it.
- `batch_triage_*.ts`: No change — they call `cache_lib` functions to insert triage results.

**The adapter pattern works here.** `cache_lib.ts` already acts as an abstraction layer between the pipeline scripts and the database. Swapping SQLite for Postgres happens entirely within `cache_lib.ts`. Callers are unchanged.

### MCP server consolidation

The existing Windmill MCP server (`mcp_server.ts`) exposes 5 hardcoded tools plus dynamic tool discovery:

| Existing tool | What it queries | After consolidation |
|--------------|----------------|-------------------|
| `query_cache` | SQLite directly | Queries `pai_ops.*` tables in Postgres |
| `query_vendors` | JSON file on disk | Same (or optionally migrate to `pai_ops.vendor_inventory`) |
| `query_resources` | `resource_inventory` in SQLite | Queries `pai_ops.resource_inventory` in Postgres |
| `triage_overview` | Multiple SQLite tables | Queries `pai_ops.triage_results` + `pai_ops.investigation_jobs` in Postgres |
| `run_windmill_script` | Windmill API | Unchanged — proxies to Windmill execution engine |

The Windmill MCP server and the PAI Knowledge MCP server remain **separate servers** with separate concerns:

```
┌──────────────────────────────────────┐    ┌──────────────────────────────────────┐
│  Windmill MCP Server                  │    │  PAI Knowledge MCP Server             │
│  (mcp_server.ts, runs on Imladris)   │    │  (pai-knowledge-mcp, runs on Imladris)│
│                                       │    │                                       │
│  Tools:                               │    │  Tools:                               │
│  - query_cache (pai_ops data)          │    │  - get_context (methodology)          │
│  - query_resources (AWS inventory)    │    │  - search_memory (institutional)      │
│  - triage_overview (pipeline state)   │    │  - record_learning (write-back)       │
│  - run_windmill_script (execution)    │    │  - record_failure (write-back)        │
│  - [dynamic: all Windmill scripts]    │    │  - query_knowledge_graph (AGE)        │
│                                       │    │                                       │
│  Queries: windmill.pai_ops.* (Postgres)  │    │  Queries: pai_memory.* (Postgres)       │
│  Purpose: operational state + actions │    │  Purpose: institutional knowledge     │
└──────────────────────────────────────┘    └──────────────────────────────────────┘
         │                                            │
         │ Both connect to same Postgres instance        │
         └────────────────┬───────────────────────────┘
                          ▼
         ┌──────────────────────────────────────┐
         │          PostgreSQL             │
         │  pai_memory │ windmill (+ pai_ops schema) │
         └──────────────────────────────────────┘
```

Claude Code on Imladris connects to both. The Windmill MCP server gives it operational awareness ("what's in the triage queue? what did the last investigation find?"). The PAI Knowledge MCP server gives it institutional knowledge ("what methodology should I follow? what did we learn last time this happened?").

**Future opportunity (not Phase 1):** A `correlate_ops_knowledge` tool that joins across both databases — "find PAI learnings relevant to this investigation" or "did we record a learning about this root cause before?" This is the cross-system correlation described above, exposed as an MCP tool rather than raw SQL.

### Implementation sequence

This consolidation is **Phase 1a** — it happens alongside the sync daemon and Postgres setup, because it requires Postgres to exist but does not require Phase 2 capabilities (vectors, graph, ML).

1. **Postgres provisioned** (same step as sync daemon setup)
2. **Create `pai_ops` schema** in the `windmill` database
3. **Run table creation DDL** (the schema above)
4. **Update `cache_lib.ts`**: swap `better-sqlite3` for `pg` connection pool, JSONB instead of JSON strings, Postgres SQL syntax
5. **Dual-write verification** (1-2 days): configure `cache_lib.ts` to write to both SQLite and Postgres simultaneously, read from SQLite. Run all pipeline crons normally. Compare outputs between the two stores to catch SQL translation bugs. The adapter pattern makes this easy — add a `DUAL_WRITE=true` env var that writes to both backends, log any divergences.
6. **Cut over**: flip `cache_lib.ts` to read from Postgres. Leave SQLite writes on for one more day as a safety net, then disable.
7. **Verify all callers** (`batch_triage_*.ts`, `process_actionable.ts`, `agentic_investigator.ts`) work without changes — they call `cache_lib` functions, not SQLite directly
8. **Update `mcp_server.ts`**: change `query_cache` and `triage_overview` to query Postgres instead of SQLite
9. **Backfill** (optional): if existing SQLite data has value, one-time `sqlite3 .dump | psql` style migration. If not, fresh start is fine — triage data is operational, not archival.
10. **Remove SQLite dependency**: delete `better-sqlite3` from Windmill dependencies, remove NVMe cache directory setup from bootstrap

**No Windmill pipeline scripts change** (other than `cache_lib.ts` and `mcp_server.ts`). The adapter pattern means the database swap is invisible to the 50+ scripts that use `cache_lib`.

### What this does NOT change

| Component | Why unchanged |
|-----------|--------------|
| Triage classification logic (`batch_triage_*.ts`) | Calls `cache_lib` functions — database is abstracted |
| Investigation orchestration (`agentic_investigator.ts`) | Returns a diagnosis object — doesn't touch the database |
| SDP API integration (`process_actionable.ts`, `create_ticket.ts`, `add_note.ts`) | Calls `cache_lib` + SDP REST API — database is abstracted |
| Bedrock AI calls | Bedrock Converse API is unchanged — model, prompts, tool definitions all stay the same |
| Windmill cron schedules | Schedule configs don't reference the database |
| Investigation tools (`windmill/f/investigate/*.ts`) | Read-only tools that query external systems (AWS, Azure, SDP, Securonix) — no SQLite dependency |
| McpSecurityValidator hook | Validates MCP tool names — doesn't care about the backing database |

---

## Design Decision: Development Skill (Extracted from Superpowers)

The `obra/superpowers` project (81k+ GitHub stars, officially in Anthropic's plugin marketplace) is a software development methodology enforcer for coding agents. It provides 14 skills covering brainstorming, planning, TDD, debugging, code review, and subagent coordination.

**Evaluation:** 11 of 14 Superpowers skills duplicate what PAI's Algorithm already does (planning, verification, execution, reflection). The Algorithm's ISC decomposition is more rigorous than Superpowers' Socratic brainstorming. PAI's VERIFY phase with per-ISC evidence is more granular than Superpowers' general verification. And critically, Superpowers has **no memory, no learning, no feedback loop** — every project starts from zero.

**What was extracted:** Three specific practices that PAI lacked:

1. **TDD (Test-Driven Development)** — RED-GREEN-REFACTOR cycle with hard gates. No production code without a failing test first. PAI's Algorithm enforces structured work but doesn't enforce test-first discipline.
2. **Systematic Debugging** — 4-phase root cause investigation (investigate → gather evidence → hypothesize and test → fix). PAI's steering rules say "one change when debugging" but don't encode the full methodology.
3. **Code Review** — Two-stage automated review (spec compliance, then code quality) with subagent dispatch. PAI has delegation but no dedicated review workflow.

**Implementation:** Native PAI skill at `~/.claude/skills/Development/` with three workflows (`TDD.md`, `SystematicDebugging.md`, `CodeReview.md`). ~190 lines of markdown total. No session-start hook, no context competition with the Algorithm, no framework dependency.

### Postgres integration

When the sync daemon and Postgres are running, the Development skill's outputs flow into institutional knowledge:

| Development output | Postgres destination | What it enables |
|---|---|---|
| TDD failure patterns | `memory_objects` (type: learning) → `memory_vectors` | Semantic search: "what testing anti-patterns have we seen?" |
| Debugging root causes | `memory_objects` (type: failure) with evidence chain | Knowledge graph: causal chains from symptoms to root causes (AGE Phase 2b) |
| Code review findings | `memory_objects` (type: learning) | Pattern detection: recurring quality issues become steering rule candidates |
| Three-Strike escalations | `memory_objects` (type: failure, severity: architectural) | Predictive: "this codebase area has a history of architectural bugs" |

The skill writes to PAI's filesystem (learnings, failures). The sync daemon pushes to Postgres. `assemble_context()` serves relevant debugging history and TDD patterns to any model. A remote model investigating a bug via the MCP server gets: "Similar root causes found in past investigations" — institutional debugging knowledge that Superpowers, with its fresh-start-every-project design, can never provide.

---

## Design Decision: Why Not DSPy

DSPy (Stanford NLP) is a framework for programmatically optimizing LLM prompts via compilation — defining signatures, running optimizers against training data, and producing "compiled" programs with optimized prompt templates and curated few-shot examples. It was evaluated and rejected for PAI.

### Why PAI already covers this

PAI has a complete feedback-driven optimization loop that overlaps heavily with what DSPy compilation provides:

| DSPy capability | PAI equivalent |
|---|---|
| Chain-of-thought reasoning | Algorithm v3.5.0 — 7-phase workflow (OBSERVE→THINK→PLAN→BUILD→EXECUTE→VERIFY→LEARN) |
| Training data from good outputs | RatingCapture (explicit 1-10 + implicit sentiment via Haiku) + SessionHarvester |
| Domain-specific learned examples | Wisdom Frames — `[CRYSTAL]` verified principles, anti-patterns, predictive models per domain |
| Cross-domain pattern synthesis | WisdomCrossFrameSynthesizer — aggregates principles appearing in 2+ frames |
| Failure pattern detection | FailureCapture (full context dumps) + LearningPatternSynthesis (recommendations from patterns) |
| Behavioral adjustment from feedback | Steering rules + OpinionTracker (explicit contradictions, confidence adjustment) |
| Self-reflection | Algorithm LEARN phase — "what should I have done differently?" written to `algorithm-reflections.jsonl` |

The one gap: PAI captures everything and surfaces patterns, but the final step — compiling learnings into prompt changes — is **intentionally manual**. You review synthesis reports and update steering rules yourself. This is a feature: "Permission to change yourself is permission to break yourself." The human quality gate prevents overfitting to recent failures, losing proven behaviors, and cascading errors from bad auto-compilations.

### Why DSPy's value diminishes as models improve

DSPy's value is **inversely correlated with model quality**. As foundation models get better at instruction-following and multi-step reasoning:

- Over-constraining with compiled few-shot examples can *degrade* performance — the model already knows how to do the task
- Compiled prompts don't transfer between models — upgrade Claude → recompile everything
- Research shows 2-38% improvement range (highly task-dependent), with compilation costing $3-50 per run (1,000+ LLM calls, 2.7M+ tokens)
- DSPy's own documentation acknowledges simple prompts sometimes beat compiled programs

PAI's approach — better model = PAI gets better automatically — aligns with the trajectory. DSPy's approach — better model = recompile everything — fights it.

### The better path: SteeringRuleProposal

Instead of automated compilation, PAI's feedback loop closes more naturally through a lightweight addition to existing tooling:

1. **LearningPatternSynthesis** already detects recurring failure patterns and generates recommendations
2. A periodic **SteeringRuleProposal** step reads synthesis reports and *proposes* new steering rules — specific, actionable behavioral changes derived from accumulated evidence
3. You review and accept/reject proposals. The human quality gate stays intact.
4. Accepted rules flow into steering rules → loaded at session start → immediate behavioral change

This is ~50 lines of TypeScript in an existing PAI tool, not a Python sidecar with FastAPI, Postgres tables, systemd services, and a compilation pipeline. Same outcome (learnings become behavioral changes), dramatically simpler path.

---

## Design Decision: Retrieval Techniques Extracted from Hindsight

[Hindsight](https://github.com/vectorize-io/hindsight) (vectorize-io, 3.5k GitHub stars, backed by $3.6M in funding, academic paper with Virginia Tech) is a Python-based agent memory system with 4-way parallel retrieval, entity resolution, and observation synthesis. Pre-1.0 (v0.4.18), PostgreSQL + pgvector backend, MCP server with 26+ tools.

### Why PAI's spec already covers ~85%

Hindsight's core retrieval architecture maps directly to capabilities already designed in this spec:

| Hindsight capability | PAI spec equivalent | Coverage |
|---|---|---|
| Semantic search (pgvector) | Phase 2a — same extension, same cosine similarity | 100% |
| BM25 keyword search | tsvector/tsquery (Phase 1b) — Postgres FTS is BM25-equivalent | 95% |
| Graph traversal | Apache AGE with Cypher (Phase 2b) — same concept | 100% |
| Temporal filtering | Hybrid query recency decay + metadata filters (Phase 2a) | 85% |
| Observation synthesis | Wisdom Frames + LearningPatternSynthesis | 80% |
| MCP server integration | Phase 3c — same approach, similar tool count | 100% |
| PostgreSQL backend | Same tech stack | 100% |

Hindsight independently arrived at the same architecture PAI is building: PostgreSQL as the unified backend, pgvector for semantic search, graph queries for relational context, temporal filtering for currency, and MCP for model-agnostic access. This validates the design rather than challenging it.

### What's NOT worth adding

**Mental models and disposition traits** — Hindsight models behavioral patterns and personality characteristics of entities. Designed for multi-user CRM-like scenarios. PAI is a single-user personal system. Modeling principal behavior is already handled by Wisdom Frames (domain knowledge) and steering rules (behavioral constraints). Adding entity-level personality modeling adds complexity for a use case that doesn't exist.

**The full Hindsight system as a dependency** — Another Python service to run alongside a Postgres-native architecture. Pre-1.0 API means breaking changes. Requires external LLM calls for fact extraction on every memory write (API cost + latency). Anthropic is building native memory features (competitive, not complementary). Architectural mismatch: PAI puts everything in Postgres (pgml, AGE, triggers); Hindsight is a Python application that uses Postgres as storage.

### What was extracted: Two retrieval techniques

Two specific techniques from Hindsight genuinely improve PAI's retrieval quality and are implementable as native Postgres functions — no external dependency:

#### 1. Entity Resolution

**The problem PAI doesn't solve today:** When PAI writes "the payment refactor" in session 47, "payment module rewrite" in session 112, and "the big refactor" in session 203, nothing links them. Each is an independent string in `memory_objects`. A search for "payment refactor" might miss the other two — different words, same entity.

**The technique:** On `memory_objects` INSERT, identify whether the new content references entities (projects, tools, people, codebases) that already exist in the knowledge graph. Use a combination of embedding similarity (pgvector — "payment refactor" and "payment module rewrite" are semantically close) and fuzzy name matching (pg_trgm — already in the spec's extension list) to find candidate matches. When confidence exceeds a threshold, merge into a canonical entity node and create `REFERS_TO` edges.

```sql
-- Entity resolution: find or create canonical entity, link memory object
CREATE OR REPLACE FUNCTION resolve_entities()
RETURNS TRIGGER AS $$
DECLARE
    entity_candidates RECORD;
BEGIN
    -- Extract entity mentions from content (via pgml NER or pattern matching)
    -- For each mention, check knowledge graph for existing entities:
    --   1. Embedding similarity (pgvector) against entity name embeddings
    --   2. Trigram similarity (pg_trgm) against entity names
    --   3. Exact match on known aliases
    -- If match found: create REFERS_TO edge from this memory object to canonical entity
    -- If no match: create new entity node, this mention becomes the canonical name
    -- Store aliases on entity node for future matching

    -- This runs inside Postgres using existing extensions:
    -- pgvector (similarity), pg_trgm (fuzzy matching), AGE (graph nodes/edges)
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_resolve_entities
    AFTER INSERT ON memory_objects
    FOR EACH ROW EXECUTE FUNCTION resolve_entities();
```

**What this enables:** `pai memory search "payment refactor"` finds ALL references — regardless of phrasing — because they're linked to the same canonical entity in the knowledge graph. `assemble_context()` can follow `REFERS_TO` edges to pull in all related context. Recall improves without requiring exact keyword overlap or relying solely on embedding similarity.

**New node type:** `Entity` (added to Phase 2b's node types: Learning, Failure, WisdomFrame, Project, Session, Tool, Language, Pattern, **Entity**)
**New edge types:** `REFERS_TO` (memory object → canonical entity), `ALIAS_OF` (alternate name → canonical entity)

#### 2. Reciprocal Rank Fusion (RRF) in `assemble_context()`

**The problem:** PAI's hybrid queries (Phase 2a) combine vector similarity, temporal decay, and graph traversal, but the combination uses ad-hoc SQL weighting:

```sql
-- Current approach: hand-tuned multiplication
ORDER BY (1 - (mv.embedding <=> $query_embedding))
    * (1.0 / (1 + EXTRACT(EPOCH FROM NOW() - mo.updated_at) / 86400 / 30))
```

This works but is fragile — the weights need manual tuning and don't generalize across query types.

**The technique:** Reciprocal Rank Fusion (RRF) is a proven algorithm for combining ranked lists from multiple retrieval systems. Instead of multiplying scores (which requires comparable scales), RRF ranks results from each retrieval path independently and combines ranks:

```
RRF_score(doc) = Σ (1 / (k + rank_in_path_i))  for each retrieval path i
```

Where `k` is a constant (typically 60) that prevents top-ranked documents from dominating.

**Implementation in `assemble_context()`:**

```sql
-- RRF: combine vector, FTS, and graph results
-- Each CTE ranks results independently within its retrieval path
WITH vector_results AS (
    SELECT source_key, ROW_NUMBER() OVER (
        ORDER BY embedding <=> $query_embedding
    ) as rank
    FROM memory_vectors
    WHERE source_type = ANY($types)
    LIMIT 50
),
fts_results AS (
    SELECT key as source_key, ROW_NUMBER() OVER (
        ORDER BY ts_rank(search_vector, $tsquery) DESC
    ) as rank
    FROM memory_objects
    WHERE search_vector @@ $tsquery AND deleted = FALSE
    LIMIT 50
),
graph_results AS (
    -- Entity-resolved graph neighbors of query-relevant entities
    SELECT source_key, ROW_NUMBER() OVER (
        ORDER BY graph_distance
    ) as rank
    FROM entity_graph_neighbors($query_entities)
    LIMIT 50
),
temporal_results AS (
    SELECT key as source_key, ROW_NUMBER() OVER (
        ORDER BY updated_at DESC
    ) as rank
    FROM memory_objects
    WHERE key = ANY(SELECT source_key FROM vector_results
                    UNION SELECT source_key FROM fts_results)
    LIMIT 50
)
-- Reciprocal Rank Fusion across all four paths
SELECT source_key,
    COALESCE(1.0 / (60 + v.rank), 0) +
    COALESCE(1.0 / (60 + f.rank), 0) +
    COALESCE(1.0 / (60 + g.rank), 0) +
    COALESCE(1.0 / (60 + t.rank), 0) as rrf_score
FROM vector_results v
FULL OUTER JOIN fts_results f USING (source_key)
FULL OUTER JOIN graph_results g USING (source_key)
FULL OUTER JOIN temporal_results t USING (source_key)
ORDER BY rrf_score DESC
LIMIT $limit;
```

**Why RRF over ad-hoc weighting:**
- No scale normalization needed — works on ranks, not scores
- Robust to missing signals — a document found by only one path still gets a score
- Research-proven — consistently outperforms single-path retrieval and is more robust than learned fusion weights
- Self-tuning — the `k=60` constant works across query types without per-query adjustment

**Integration:** RRF replaces the ad-hoc weighting in `assemble_context()`'s retrieval step. The four retrieval paths (semantic, keyword, graph, temporal) already exist in the spec as Phases 1b, 2a, and 2b. RRF is the fusion algorithm that combines them properly. This is a SQL change inside an existing function, not new infrastructure.

### The honest bottom line

Hindsight validates this spec's architectural direction — they independently built the same thing (PostgreSQL + pgvector + graph + temporal + MCP). The two extracted techniques (entity resolution, RRF) meaningfully improve retrieval quality using infrastructure already in the spec. The full system isn't worth the dependency: another service, pre-1.0, LLM cost on every write, and 85% overlap with what's already designed.

---

## Design Decision: Why Not Letta (formerly MemGPT)

[Letta](https://github.com/letta-ai/letta) (21.5k GitHub stars, $10M seed at $70M valuation, UC Berkeley/NeurIPS 2023) is an agent runtime built around self-editing memory. The core innovation from the MemGPT paper: treat the LLM context window like OS virtual memory — core memory (in-context blocks), recall memory (conversation history), archival memory (vector store) — and let the agent manage its own paging via tool calls. Pre-1.0 (v0.16.6), PostgreSQL + pgvector backend, Apache 2.0.

### The architectural mismatch

Letta is an **agent runtime** — it replaces your agent execution environment. PAI is an **agent infrastructure layer** — it enhances an existing runtime (Claude Code). This is fundamentally different from DSPy (prompt optimizer), Superpowers (methodology enforcer), and Hindsight (retrieval system), which are composable with PAI. Adopting Letta means replacing Claude Code — losing hooks, the Algorithm, skills, IDE integration, and the entire PAI stack.

### Capability overlap (~90%)

| Letta capability | PAI equivalent | Notes |
|---|---|---|
| Core memory (in-context blocks) | CLAUDE.md + LoadContext hook + context routing + auto memory | Same outcome: relevant context in system prompt |
| Recall memory (conversation history) | Claude Code `projects/` (native 30-day transcripts) + SessionHarvester | Claude Code handles natively |
| Archival memory (vector store) | Phase 2a pgvector + `memory_objects` | Same tech |
| Agent self-edits memory via tools | Auto memory + Algorithm LEARN phase + Wisdom Frames | PAI uses hooks (deterministic) vs Letta's tool calls (model-dependent) |
| Context window summarization | Claude Code native context compression | Handled by runtime |
| Sleep-time consolidation | LearningPatternSynthesis + WisdomCrossFrameSynthesizer + Phase 2d pg_cron | Same pattern, different scheduling |
| Multi-agent communication | PAI Delegation system + Agent subagents | Different model (server pools vs CLI subagents) |
| MCP integration | Claude Code native MCP client + Phase 3c MCP server | Full coverage |
| PostgreSQL + pgvector | Same tech stack | Identical |

### Why PAI's approach is stronger for this use case

**Hook-driven capture is more reliable than agent-initiated memory.** Letta's core design asks the LLM to manage its own memory via tool calls — the agent must remember to call `memory_replace` or `archival_memory_insert` at the right moments. Community reports indicate this "struggles" with non-frontier models (GitHub issue #1776: "90% of requests produce stacktraces"), and even frontier models can forget to save important context. PAI's hooks fire deterministically: a rating always triggers RatingCapture, a session end always triggers WorkCompletionLearning, regardless of model behavior. Deterministic capture beats voluntary capture for reliability.

**Claude Code is the better runtime.** Letta runs agents behind a FastAPI server with REST APIs — designed for multi-agent cloud deployments. PAI enhances Claude Code, which provides: native IDE integration, direct filesystem access, tool sandboxing, automatic context compression, native MCP client, and Anthropic-optimized agent behavior. Replacing Claude Code with Letta trades a first-party, continuously-improving runtime for a third-party, pre-1.0 one.

**Letta's own benchmarks validate simpler approaches.** Their evaluation found filesystem-based agents (74.0% on LoCoMo) outperformed Mem0's specialized memory system (68.5%). This supports PAI's file-based architecture — the complexity of agent-managed memory blocks doesn't reliably outperform simpler storage with good retrieval.

### Nothing to extract

Unlike the previous evaluations (Superpowers → TDD/debugging/review skills; Hindsight → entity resolution/RRF), Letta's innovations are inseparable from its runtime. "Self-editing memory via tool calls" isn't a technique you can implement as a Postgres function — it's an agent loop architecture. PAI's consolidation tools (SessionHarvester, LearningPatternSynthesis, WisdomCrossFrameSynthesizer) already implement Letta's "sleep-time" pattern through periodic execution, and the spec's pg_cron jobs (Phase 2d) formalize the scheduling.

### What Letta validates

Letta confirms three design choices already in this spec:

1. **Tiered memory matters** — core (in-context) vs recall (searchable history) vs archival (semantic search). PAI's architecture mirrors this: CLAUDE.md/context routing (core), `projects/` transcripts (recall), Postgres + pgvector (archival).
2. **PostgreSQL + pgvector is the right backend** — Letta chose the same stack independently.
3. **Memory consolidation improves quality** — Letta's sleep-time agents and PAI's harvesting/synthesis tools solve the same problem: raw observations need periodic consolidation into higher-quality knowledge.

---

## Design Rationale: The Retrieval Problem

The dominant retrieval paradigm in AI (RAG — chunk, embed, vector search) breaks at scale for three specific reasons:

1. **Can't handle relational queries across time.** "Find the chain of decisions that led to this bug" requires understanding temporal sequence and causation. Vector similarity finds documents that mention similar words, not documents that are causally connected.

2. **Can't distinguish current context from superseded context.** An older learning that said "always use pattern X" may have been superseded by a newer learning that says "use pattern Y instead." Vector search treats both equally — same keywords, same embeddings.

3. **Performance degrades as the corpus grows.** As memory accumulates, the ratio of relevant to irrelevant results for any query gets worse. More false positives, more near-miss retrievals.

Our hybrid approach addresses all three:
- **Apache AGE** (Phase 2b) handles causal and relational queries via graph traversal
- **Version history + metadata filtering** handles temporal currency — filter out superseded content, weight by recency
- **Type-filtered vector search** keeps the relevant/irrelevant ratio manageable as the corpus grows

This is why the graph is in Phase 2 (not Phase 3) — it's not an advanced feature, it's a core retrieval requirement.

---

## Summary: What Changes vs What Doesn't

### Changes (new code)

| Component | Description |
|-----------|-------------|
| `pai-sync` daemon | systemd service, inotify watcher, WAL, push/pull |
| `PAI/Sync/` directory | Sync engine source code |
| Postgres database | System of record: tables, version history, indexes, triggers, extensions |
| New `pai sync` commands | CLI for sync operations, history, restore |
| New `pai memory/knowledge/predict` commands (Phase 2+) | CLI for AI-powered queries |

### Does NOT change

| Component | Why |
|-----------|-----|
| SessionHarvester.ts | Continues writing learnings to filesystem |
| FailureCapture.ts | Continues writing failure dumps to filesystem |
| OpinionTracker.ts | Continues tracking explicit contradictions |
| WisdomFrameUpdater.ts | Continues updating Wisdom Frames on filesystem |
| WisdomCrossFrameSynthesizer.ts | Continues cross-frame synthesis on filesystem |
| LearningPatternSynthesis.ts | Continues pattern aggregation on filesystem |
| RatingCapture.hook.ts | Continues capturing ratings |
| WorkCompletionLearning.hook.ts | Continues capturing work insights |
| Algorithm (v3.5.0) | Continues operating exactly as-is |
| CLAUDE.md | No modifications |
| All file formats | No schema changes |
| All MEMORY/ directory structures | No reorganization |

**PAI writes to the filesystem. The daemon pushes to Postgres. Postgres is where nothing is ever lost. New capabilities read from Postgres. The circle is complete and PAI never knows it exists.**

