-- ============================================================
-- core schema DDL — PAI Memory Sync (Phase 1)
-- Required: every imladris installation
-- Idempotent: safe to re-run (CREATE ... IF NOT EXISTS)
-- ============================================================

CREATE SCHEMA IF NOT EXISTS core;

-- ============================================================
-- memory_objects — current state of every synced file
-- ============================================================
CREATE TABLE IF NOT EXISTS core.memory_objects (
    key           TEXT PRIMARY KEY,       -- relative path: "MEMORY/WORK/20260305_task/PRD.md"
    content       TEXT,                   -- file contents (possibly gzipped + base64)
    metadata      JSONB,                  -- extracted structured data (frontmatter, parsed JSON)
    content_hash  TEXT NOT NULL,          -- SHA-256 for fast diff
    version       INTEGER NOT NULL DEFAULT 1,
    compressed    BOOLEAN DEFAULT FALSE,  -- true if content is gzipped
    chunk_index   SMALLINT,              -- NULL for non-chunked, 0-based for chunks
    chunk_total   SMALLINT,              -- NULL for non-chunked, total chunk count
    session_id    TEXT,                   -- which session last wrote this
    machine_id    TEXT,                   -- which machine pushed this
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted       BOOLEAN NOT NULL DEFAULT FALSE  -- soft delete: content preserved forever
);

CREATE INDEX IF NOT EXISTS idx_objects_prefix  ON core.memory_objects (key text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_objects_metadata ON core.memory_objects USING GIN (metadata);
CREATE INDEX IF NOT EXISTS idx_objects_updated  ON core.memory_objects (updated_at);
CREATE INDEX IF NOT EXISTS idx_objects_machine  ON core.memory_objects (machine_id);

-- ============================================================
-- memory_object_versions — full version history of every file
-- ============================================================
CREATE TABLE IF NOT EXISTS core.memory_object_versions (
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

CREATE INDEX IF NOT EXISTS idx_versions_key_time ON core.memory_object_versions (key, created_at DESC);

-- ============================================================
-- Trigger: auto-archive previous version before update
-- ============================================================
CREATE OR REPLACE FUNCTION core.archive_object_version()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.content_hash IS DISTINCT FROM NEW.content_hash THEN
        INSERT INTO core.memory_object_versions
            (key, version, content, metadata, content_hash, compressed, session_id, machine_id)
        VALUES
            (OLD.key, OLD.version, OLD.content, OLD.metadata, OLD.content_hash,
             OLD.compressed, OLD.session_id, OLD.machine_id);
        NEW.version := OLD.version + 1;
        NEW.updated_at := NOW();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_archive_version'
          AND tgrelid = 'core.memory_objects'::regclass
    ) THEN
        CREATE TRIGGER trg_archive_version
            BEFORE UPDATE ON core.memory_objects
            FOR EACH ROW EXECUTE FUNCTION core.archive_object_version();
    END IF;
END;
$$;

-- ============================================================
-- memory_lines — line-level storage for JSONL files
-- Append-only, union across all machines — nothing lost
-- ============================================================
CREATE TABLE IF NOT EXISTS core.memory_lines (
    file_key      TEXT NOT NULL,          -- "MEMORY/LEARNING/SIGNALS/ratings.jsonl"
    line_hash     TEXT NOT NULL,          -- SHA-256 of line content
    content       TEXT NOT NULL,          -- the raw JSON line
    metadata      JSONB,                  -- parsed fields for queryability
    session_id    TEXT,
    machine_id    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (file_key, line_hash)     -- dedup: same line from multiple machines = one row
);

CREATE INDEX IF NOT EXISTS idx_lines_file_time ON core.memory_lines (file_key, created_at);
CREATE INDEX IF NOT EXISTS idx_lines_session   ON core.memory_lines (session_id);
CREATE INDEX IF NOT EXISTS idx_lines_machine   ON core.memory_lines (machine_id);
CREATE INDEX IF NOT EXISTS idx_lines_metadata  ON core.memory_lines USING GIN (metadata);

-- ============================================================
-- sessions — session metadata
-- ============================================================
CREATE TABLE IF NOT EXISTS core.sessions (
    session_id      TEXT PRIMARY KEY,
    machine_id      TEXT,
    work_dir        TEXT,                 -- MEMORY/WORK/{slug} if known
    task_title      TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at        TIMESTAMPTZ,
    context_tokens  INTEGER,              -- estimated token usage at end
    metadata        JSONB
);

CREATE INDEX IF NOT EXISTS idx_sessions_machine    ON core.sessions (machine_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started    ON core.sessions (started_at DESC);

-- ============================================================
-- compaction_checkpoints — PreCompact hook direct writes
-- Zero-loss at Claude Code context compaction events
-- ============================================================
CREATE TABLE IF NOT EXISTS core.compaction_checkpoints (
    id              BIGSERIAL PRIMARY KEY,
    session_id      TEXT NOT NULL,
    session_dir     TEXT,                 -- MEMORY/WORK/{slug} if known
    task_title      TEXT,
    trigger         TEXT DEFAULT 'auto',  -- 'auto' or 'manual'
    summary         TEXT NOT NULL,        -- Claude's auto-generated context summary
    checkpoint_path TEXT,                 -- filesystem path (may be null if disk unavailable)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON core.compaction_checkpoints (session_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_time    ON core.compaction_checkpoints (created_at DESC);
