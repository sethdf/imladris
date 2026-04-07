-- =============================================================================
-- 01-create-pai-database.sql
-- Creates the pai database and core schema on first container start.
-- Idempotent — safe to re-run (CREATE IF NOT EXISTS throughout).
--
-- The windmill database is created by POSTGRES_DB env var in docker-compose.yml.
-- This script creates the ADDITIONAL pai database for PAI memory sync.
-- =============================================================================

-- Create the pai database (only if it doesn't exist)
SELECT 'CREATE DATABASE pai'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'pai')\gexec

-- Connect to pai database and create core schema
\connect pai

-- Core schema — PAI cognitive memory (always required)
CREATE SCHEMA IF NOT EXISTS core;

-- =============================================================================
-- memory_objects — current state of every synced file
-- =============================================================================
CREATE TABLE IF NOT EXISTS core.memory_objects (
    key           TEXT PRIMARY KEY,
    content       TEXT,
    metadata      JSONB DEFAULT '{}',
    content_hash  TEXT NOT NULL,
    compressed    BOOLEAN DEFAULT FALSE,
    chunk_index   INTEGER,
    chunk_total   INTEGER,
    source        TEXT DEFAULT 'daemon',
    session_id    TEXT,
    machine_id    TEXT,
    version       INTEGER DEFAULT 1,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted       BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_memory_objects_prefix
    ON core.memory_objects (key text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_memory_objects_metadata
    ON core.memory_objects USING GIN (metadata);
CREATE INDEX IF NOT EXISTS idx_memory_objects_source
    ON core.memory_objects (source);
CREATE INDEX IF NOT EXISTS idx_memory_objects_updated
    ON core.memory_objects (updated_at DESC);

-- =============================================================================
-- memory_object_versions — full version history of every file
-- =============================================================================
CREATE TABLE IF NOT EXISTS core.memory_object_versions (
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

-- =============================================================================
-- memory_lines — individual lines from append-only JSONL files
-- Sub-agent safe: dedup by (file_key, line_hash)
-- =============================================================================
CREATE TABLE IF NOT EXISTS core.memory_lines (
    file_key      TEXT NOT NULL,
    line_hash     TEXT NOT NULL,
    content       TEXT NOT NULL,
    metadata      JSONB DEFAULT '{}',
    session_id    TEXT,
    machine_id    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (file_key, line_hash)
);

CREATE INDEX IF NOT EXISTS idx_memory_lines_file
    ON core.memory_lines (file_key, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_lines_session
    ON core.memory_lines (session_id);

-- =============================================================================
-- pai_system — methodology synced from GitHub (Algorithm, principles, skills, etc.)
-- =============================================================================
CREATE TABLE IF NOT EXISTS core.pai_system (
    key            TEXT PRIMARY KEY,
    component_type TEXT NOT NULL,  -- 'algorithm', 'steering_rules', 'fabric_pattern', etc.
    content        TEXT,
    metadata       JSONB DEFAULT '{}',
    content_hash   TEXT NOT NULL,
    version        INTEGER DEFAULT 1,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pai_system_type
    ON core.pai_system (component_type);

-- =============================================================================
-- sessions — session metadata for cross-session intelligence
-- =============================================================================
CREATE TABLE IF NOT EXISTS core.sessions (
    session_id     TEXT PRIMARY KEY,
    machine_id     TEXT,
    task_title     TEXT,
    work_dir       TEXT,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at       TIMESTAMPTZ,
    context_tokens INTEGER,
    metadata       JSONB DEFAULT '{}'
);

-- =============================================================================
-- compaction_checkpoints — PreCompact hook writes directly here
-- =============================================================================
CREATE TABLE IF NOT EXISTS core.compaction_checkpoints (
    id              BIGSERIAL PRIMARY KEY,
    session_id      TEXT NOT NULL,
    session_dir     TEXT,
    task_title      TEXT,
    trigger         TEXT DEFAULT 'auto',
    summary         TEXT NOT NULL,
    checkpoint_path TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compaction_session
    ON core.compaction_checkpoints (session_id);
CREATE INDEX IF NOT EXISTS idx_compaction_created
    ON core.compaction_checkpoints (created_at DESC);

-- =============================================================================
-- Roles — sync daemon and MCP app get separate roles with locked search_path
-- Council Decision 2026-04-07: schema isolation via roles, not separate databases
-- =============================================================================

-- Sync daemon role: writes to core only
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pai_sync') THEN
        CREATE ROLE pai_sync LOGIN PASSWORD 'changeme-via-bws';
    END IF;
END
$$;
ALTER ROLE pai_sync SET search_path TO core;
GRANT USAGE ON SCHEMA core TO pai_sync;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA core TO pai_sync;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core TO pai_sync;

-- MCP application role: reads core, reads/writes domain schemas when they exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pai_app') THEN
        CREATE ROLE pai_app LOGIN PASSWORD 'changeme-via-bws';
    END IF;
END
$$;
ALTER ROLE pai_app SET search_path TO core;
GRANT USAGE ON SCHEMA core TO pai_app;
GRANT SELECT ON ALL TABLES IN SCHEMA core TO pai_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core TO pai_app;

-- Default privileges for future tables in core
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT SELECT, INSERT, UPDATE ON TABLES TO pai_sync;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT SELECT ON TABLES TO pai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT USAGE, SELECT ON SEQUENCES TO pai_sync;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT USAGE, SELECT ON SEQUENCES TO pai_app;
