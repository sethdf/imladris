-- =============================================================================
-- PAI Memory Sync — Phase 1 Schema
-- Idempotent: safe to run multiple times
-- =============================================================================

-- Current state of every synced file
CREATE TABLE IF NOT EXISTS memory_objects (
    key           TEXT PRIMARY KEY,
    content       TEXT,
    metadata      JSONB,
    content_hash  TEXT NOT NULL,
    version       INTEGER NOT NULL DEFAULT 1,
    compressed    BOOLEAN DEFAULT FALSE,
    chunk_index   SMALLINT,
    chunk_total   SMALLINT,
    session_id    TEXT,
    machine_id    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted       BOOLEAN NOT NULL DEFAULT FALSE,
    search_vector tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(content, ''))
    ) STORED
);

CREATE INDEX IF NOT EXISTS idx_objects_prefix   ON memory_objects (key text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_objects_metadata ON memory_objects USING GIN (metadata);
CREATE INDEX IF NOT EXISTS idx_objects_updated  ON memory_objects (updated_at);
CREATE INDEX IF NOT EXISTS idx_objects_machine  ON memory_objects (machine_id);
CREATE INDEX IF NOT EXISTS idx_objects_fts      ON memory_objects USING GIN (search_vector);

-- Full version history — every previous state of every file
CREATE TABLE IF NOT EXISTS memory_object_versions (
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

CREATE INDEX IF NOT EXISTS idx_versions_key_time ON memory_object_versions (key, created_at DESC);

-- Line-level storage for JSONL files (append-only, union across machines)
CREATE TABLE IF NOT EXISTS memory_lines (
    file_key      TEXT NOT NULL,
    line_hash     TEXT NOT NULL,
    content       TEXT NOT NULL,
    metadata      JSONB,
    session_id    TEXT,
    machine_id    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (file_key, line_hash)
);

CREATE INDEX IF NOT EXISTS idx_lines_file_time ON memory_lines (file_key, created_at);
CREATE INDEX IF NOT EXISTS idx_lines_session   ON memory_lines (session_id);
CREATE INDEX IF NOT EXISTS idx_lines_machine   ON memory_lines (machine_id);
CREATE INDEX IF NOT EXISTS idx_lines_metadata  ON memory_lines USING GIN (metadata);

-- Trigger: archive previous version before update
CREATE OR REPLACE FUNCTION archive_object_version()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.content_hash IS DISTINCT FROM NEW.content_hash THEN
        INSERT INTO memory_object_versions
            (key, version, content, metadata, content_hash, compressed, session_id, machine_id)
        VALUES
            (OLD.key, OLD.version, OLD.content, OLD.metadata, OLD.content_hash,
             OLD.compressed, OLD.session_id, OLD.machine_id)
        ON CONFLICT (key, version) DO NOTHING;
        NEW.version    := OLD.version + 1;
        NEW.updated_at := NOW();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_archive_version ON memory_objects;
CREATE TRIGGER trg_archive_version
    BEFORE UPDATE ON memory_objects
    FOR EACH ROW EXECUTE FUNCTION archive_object_version();
