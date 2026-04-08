-- phase2d-multi-schema.sql — Multi-Schema + Domain Separation + Hive Collective Prep
-- Phase 2d of the PAI Postgres infrastructure
--
-- Run via: docker exec -i imladris-windmill_db-1 psql -U postgres -d pai < scripts/palantir/schemas/phase2d-multi-schema.sql
--
-- Fully idempotent — safe to re-run at any time.
-- Depends on: core schema (already exists), pai_app role, pai_sync role, pgcrypto extension

BEGIN;

-- ============================================================================
-- 0. Ensure required extensions
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 1. CREATE SCHEMAS
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS work;
CREATE SCHEMA IF NOT EXISTS personal;
CREATE SCHEMA IF NOT EXISTS shared;

COMMENT ON SCHEMA work     IS 'Work domain operational data — triage, investigations, SDP snapshots, credentials';
COMMENT ON SCHEMA personal IS 'Personal domain data — personal triage, Telegram context, personal entities';
COMMENT ON SCHEMA shared   IS 'Cross-domain + cross-instance intelligence — insights, global entities, hive replication';

-- ============================================================================
-- 2. WORK SCHEMA TABLES
-- ============================================================================

-- 2a. work.triage_results — mirrors SQLite cache_lib triage_results (finalized records)
CREATE TABLE IF NOT EXISTS work.triage_results (
    id                      BIGSERIAL PRIMARY KEY,
    source                  TEXT NOT NULL DEFAULT 'm365',
    message_id              TEXT NOT NULL,
    subject                 TEXT NOT NULL DEFAULT '',
    sender                  TEXT NOT NULL DEFAULT '',
    received_at             TEXT DEFAULT '',
    action                  TEXT NOT NULL,
    urgency                 TEXT NOT NULL DEFAULT 'low',
    summary                 TEXT NOT NULL DEFAULT '',
    reasoning               TEXT NOT NULL DEFAULT '',
    domain                  TEXT NOT NULL DEFAULT 'work',
    classified_by           TEXT NOT NULL DEFAULT 'L2_ai',
    rule_id                 INTEGER DEFAULT NULL,
    dedup_hash              TEXT DEFAULT '',
    occurrence_count        INTEGER NOT NULL DEFAULT 1,
    human_override          TEXT DEFAULT NULL,
    override_notes          TEXT DEFAULT '',
    marked_read             BOOLEAN NOT NULL DEFAULT FALSE,
    metadata                JSONB DEFAULT '{}'::jsonb,
    task_id                 TEXT DEFAULT NULL,
    investigation_status    TEXT DEFAULT NULL,
    investigation_result    TEXT DEFAULT NULL,
    waiting_context_reason  TEXT DEFAULT NULL,
    investigation_attempts  INTEGER NOT NULL DEFAULT 0,
    last_investigated_at    TIMESTAMPTZ DEFAULT NULL,
    entities                JSONB DEFAULT '[]'::jsonb,
    alert_type              TEXT DEFAULT 'info',
    source_system           TEXT DEFAULT '',
    incident_id             TEXT DEFAULT NULL,
    classified_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    synced_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes matching SQLite + additions for Postgres query patterns
CREATE INDEX IF NOT EXISTS idx_work_triage_dedup      ON work.triage_results (dedup_hash, classified_at);
CREATE INDEX IF NOT EXISTS idx_work_triage_source     ON work.triage_results (source);
CREATE INDEX IF NOT EXISTS idx_work_triage_action     ON work.triage_results (action);
CREATE INDEX IF NOT EXISTS idx_work_triage_class_by   ON work.triage_results (classified_by);
CREATE INDEX IF NOT EXISTS idx_work_triage_message    ON work.triage_results (message_id);
CREATE INDEX IF NOT EXISTS idx_work_triage_task       ON work.triage_results (task_id);
CREATE INDEX IF NOT EXISTS idx_work_triage_inv_status ON work.triage_results (investigation_status);
CREATE INDEX IF NOT EXISTS idx_work_triage_incident   ON work.triage_results (incident_id);
CREATE INDEX IF NOT EXISTS idx_work_triage_alert_type ON work.triage_results (alert_type);
CREATE INDEX IF NOT EXISTS idx_work_triage_synced     ON work.triage_results (synced_at DESC);

COMMENT ON TABLE work.triage_results IS 'Finalized triage records synced from SQLite cache. SQLite is the hot cache; this is the system of record.';

-- 2b. work.investigation_log — investigation results per item
CREATE TABLE IF NOT EXISTS work.investigation_log (
    id                  BIGSERIAL PRIMARY KEY,
    windmill_job_id     TEXT NOT NULL,
    item_id             TEXT NOT NULL,
    dedup_hash          TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'submitted',
    confidence          TEXT DEFAULT NULL,           -- HIGH/MEDIUM/LOW from investigator
    diagnosis_summary   TEXT DEFAULT NULL,
    rounds_used         INTEGER DEFAULT NULL,
    tools_called        INTEGER DEFAULT NULL,
    model_id            TEXT DEFAULT NULL,
    cost_estimate       NUMERIC(8,4) DEFAULT NULL,
    submitted_at        TIMESTAMPTZ NOT NULL,
    completed_at        TIMESTAMPTZ DEFAULT NULL,
    result_summary      TEXT DEFAULT NULL,
    error_message       TEXT DEFAULT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_work_inv_log_dedup    ON work.investigation_log (dedup_hash);
CREATE INDEX IF NOT EXISTS idx_work_inv_log_status   ON work.investigation_log (status);
CREATE INDEX IF NOT EXISTS idx_work_inv_log_job      ON work.investigation_log (windmill_job_id);
CREATE INDEX IF NOT EXISTS idx_work_inv_log_created  ON work.investigation_log (created_at DESC);

COMMENT ON TABLE work.investigation_log IS 'Investigation execution log — one row per investigator run, linked to triage items via dedup_hash.';

-- 2c. work.entities_work — work-domain entities
CREATE TABLE IF NOT EXISTS work.entities_work (
    id              BIGSERIAL PRIMARY KEY,
    entity_type     TEXT NOT NULL,                  -- aws_account, azure_user, ip_address, service, hostname
    entity_id       TEXT NOT NULL,                  -- the identifier (account ID, UPN, IP, etc.)
    display_name    TEXT DEFAULT '',
    metadata        JSONB DEFAULT '{}'::jsonb,      -- flexible attributes per entity type
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_work_entities_type   ON work.entities_work (entity_type);
CREATE INDEX IF NOT EXISTS idx_work_entities_seen   ON work.entities_work (last_seen_at DESC);

COMMENT ON TABLE work.entities_work IS 'Work-domain entities — AWS accounts, Azure users, services, IPs. Populated by investigations and inventory scripts.';

-- 2d. work.sdp_snapshot — periodic SDP ticket state snapshots
CREATE TABLE IF NOT EXISTS work.sdp_snapshot (
    id              BIGSERIAL PRIMARY KEY,
    ticket_id       TEXT NOT NULL,                  -- SDP full-length ID
    display_id      TEXT DEFAULT '',                -- short display ID (e.g. 39421)
    status          TEXT NOT NULL,
    subject         TEXT DEFAULT '',
    requester       TEXT DEFAULT '',
    technician      TEXT DEFAULT '',
    priority        TEXT DEFAULT '',
    category        TEXT DEFAULT '',
    created_time    TIMESTAMPTZ DEFAULT NULL,
    due_by_time     TIMESTAMPTZ DEFAULT NULL,
    resolved_time   TIMESTAMPTZ DEFAULT NULL,
    metadata        JSONB DEFAULT '{}'::jsonb,
    snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_work_sdp_ticket      ON work.sdp_snapshot (ticket_id);
CREATE INDEX IF NOT EXISTS idx_work_sdp_display     ON work.sdp_snapshot (display_id);
CREATE INDEX IF NOT EXISTS idx_work_sdp_status      ON work.sdp_snapshot (status);
CREATE INDEX IF NOT EXISTS idx_work_sdp_snapshot    ON work.sdp_snapshot (snapshot_at DESC);

COMMENT ON TABLE work.sdp_snapshot IS 'Periodic snapshots of SDP ticket state — enables trend analysis and SLA tracking.';

-- 2e. work.credential_audit — credential freshness log
CREATE TABLE IF NOT EXISTS work.credential_audit (
    id              BIGSERIAL PRIMARY KEY,
    credential_name TEXT NOT NULL,                  -- BWS key or Windmill variable path
    credential_type TEXT DEFAULT 'windmill',        -- windmill, bws, aws_profile, sso
    status          TEXT NOT NULL,                  -- ok, stale, expired, error
    last_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_rotated_at TIMESTAMPTZ DEFAULT NULL,
    expires_at      TIMESTAMPTZ DEFAULT NULL,
    error_message   TEXT DEFAULT NULL,
    metadata        JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_work_cred_name       ON work.credential_audit (credential_name);
CREATE INDEX IF NOT EXISTS idx_work_cred_status     ON work.credential_audit (status);
CREATE INDEX IF NOT EXISTS idx_work_cred_checked    ON work.credential_audit (last_checked_at DESC);

COMMENT ON TABLE work.credential_audit IS 'Credential freshness log — populated by status_check runs to track stale/expired credentials.';

-- ============================================================================
-- 3. PERSONAL SCHEMA TABLES (stubs for Phase 2f)
-- ============================================================================

-- 3a. personal.triage_results — personal triage items
CREATE TABLE IF NOT EXISTS personal.triage_results (
    id                  BIGSERIAL PRIMARY KEY,
    source              TEXT NOT NULL DEFAULT 'telegram',
    message_id          TEXT NOT NULL,
    subject             TEXT NOT NULL DEFAULT '',
    sender              TEXT NOT NULL DEFAULT '',
    action              TEXT NOT NULL,
    urgency             TEXT NOT NULL DEFAULT 'low',
    summary             TEXT NOT NULL DEFAULT '',
    reasoning           TEXT NOT NULL DEFAULT '',
    domain              TEXT NOT NULL DEFAULT 'personal',
    classified_by       TEXT NOT NULL DEFAULT 'L2_ai',
    dedup_hash          TEXT DEFAULT '',
    metadata            JSONB DEFAULT '{}'::jsonb,
    classified_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_personal_triage_dedup  ON personal.triage_results (dedup_hash, classified_at);
CREATE INDEX IF NOT EXISTS idx_personal_triage_action ON personal.triage_results (action);

COMMENT ON TABLE personal.triage_results IS 'Personal triage items — separate from work, no cross-contamination. Phase 2f stub.';

-- 3b. personal.telegram_context — Telegram conversation context
CREATE TABLE IF NOT EXISTS personal.telegram_context (
    id              BIGSERIAL PRIMARY KEY,
    chat_id         TEXT NOT NULL,
    thread_id       TEXT DEFAULT NULL,
    role            TEXT NOT NULL DEFAULT 'user',   -- user, assistant, system
    content         TEXT NOT NULL DEFAULT '',
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_personal_tg_chat     ON personal.telegram_context (chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_personal_tg_thread   ON personal.telegram_context (thread_id);

COMMENT ON TABLE personal.telegram_context IS 'Personal Telegram conversation context, threaded. Phase 2f stub.';

-- 3c. personal.entities_personal — personal entities
CREATE TABLE IF NOT EXISTS personal.entities_personal (
    id              BIGSERIAL PRIMARY KEY,
    entity_type     TEXT NOT NULL,                  -- contact, project, topic, location
    entity_id       TEXT NOT NULL,
    display_name    TEXT DEFAULT '',
    metadata        JSONB DEFAULT '{}'::jsonb,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_personal_entities_type ON personal.entities_personal (entity_type);

COMMENT ON TABLE personal.entities_personal IS 'Personal entities — contacts, projects, recurring topics. Phase 2f stub.';

-- ============================================================================
-- 4. SHARED SCHEMA TABLES
-- ============================================================================

-- 4a. shared.insights — high-value learnings graduated from work or personal
CREATE TABLE IF NOT EXISTS shared.insights (
    id              BIGSERIAL PRIMARY KEY,
    insight_id      TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
    source_domain   TEXT NOT NULL,                  -- 'work' or 'personal'
    source_ref      TEXT DEFAULT NULL,              -- optional reference to source table/id
    category        TEXT NOT NULL DEFAULT 'general', -- pattern, playbook, entity_relationship, methodology
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,
    confidence      TEXT DEFAULT 'medium',          -- low, medium, high, verified
    tags            TEXT[] DEFAULT '{}',
    metadata        JSONB DEFAULT '{}'::jsonb,
    originated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when the insight was first observed
    graduated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when it was promoted to shared
    instance_id     TEXT DEFAULT NULL,              -- which imladris instance originated this
    UNIQUE (insight_id)
);

CREATE INDEX IF NOT EXISTS idx_shared_insights_domain   ON shared.insights (source_domain);
CREATE INDEX IF NOT EXISTS idx_shared_insights_category ON shared.insights (category);
CREATE INDEX IF NOT EXISTS idx_shared_insights_tags     ON shared.insights USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_shared_insights_grad     ON shared.insights (graduated_at DESC);

COMMENT ON TABLE shared.insights IS 'High-value learnings explicitly graduated from work or personal. Replicates between imladris instances.';

-- 4b. shared.entities_global — entities spanning domains
CREATE TABLE IF NOT EXISTS shared.entities_global (
    id              BIGSERIAL PRIMARY KEY,
    entity_type     TEXT NOT NULL,
    entity_id       TEXT NOT NULL,
    display_name    TEXT DEFAULT '',
    source_domains  TEXT[] DEFAULT '{}',            -- which domains reference this entity
    metadata        JSONB DEFAULT '{}'::jsonb,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    instance_id     TEXT DEFAULT NULL,
    UNIQUE (entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_shared_entities_type    ON shared.entities_global (entity_type);
CREATE INDEX IF NOT EXISTS idx_shared_entities_domains ON shared.entities_global USING gin (source_domains);

COMMENT ON TABLE shared.entities_global IS 'Entities spanning domains — a person or system appearing in both work and personal.';

-- 4c. shared.hive_log — replication event log
CREATE TABLE IF NOT EXISTS shared.hive_log (
    id              BIGSERIAL PRIMARY KEY,
    event_type      TEXT NOT NULL,                  -- insert, update, graduate, replicate
    table_name      TEXT NOT NULL,
    record_id       TEXT NOT NULL,
    source_instance TEXT DEFAULT NULL,
    detail          JSONB DEFAULT '{}'::jsonb,
    logged_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shared_hive_type    ON shared.hive_log (event_type);
CREATE INDEX IF NOT EXISTS idx_shared_hive_table   ON shared.hive_log (table_name);
CREATE INDEX IF NOT EXISTS idx_shared_hive_logged  ON shared.hive_log (logged_at DESC);

COMMENT ON TABLE shared.hive_log IS 'Replication event log for debugging and auditing cross-instance hive sync.';

-- ============================================================================
-- 5. ROLE-BASED ISOLATION
-- ============================================================================

-- 5a. Schema-level USAGE grants
GRANT USAGE ON SCHEMA work     TO pai_app;
GRANT USAGE ON SCHEMA work     TO pai_sync;
GRANT USAGE ON SCHEMA personal TO pai_app;
GRANT USAGE ON SCHEMA personal TO pai_sync;
GRANT USAGE ON SCHEMA shared   TO pai_app;
GRANT USAGE ON SCHEMA shared   TO pai_sync;

-- 5b. work schema: pai_app gets full CRUD (it's the work app role), pai_sync gets read-only
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA work TO pai_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA work TO pai_app;
GRANT SELECT ON ALL TABLES IN SCHEMA work TO pai_sync;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA work TO pai_sync;

-- 5c. personal schema: pai_app gets full CRUD, pai_sync gets read-only
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA personal TO pai_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA personal TO pai_app;
GRANT SELECT ON ALL TABLES IN SCHEMA personal TO pai_sync;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA personal TO pai_sync;

-- 5d. shared schema: both roles get read access; writes go through graduate_insight function only
GRANT SELECT ON ALL TABLES IN SCHEMA shared TO pai_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA shared TO pai_app;
GRANT SELECT ON ALL TABLES IN SCHEMA shared TO pai_sync;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA shared TO pai_sync;

-- 5e. Default privileges for future tables in each schema
ALTER DEFAULT PRIVILEGES IN SCHEMA work GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA work GRANT USAGE, SELECT ON SEQUENCES TO pai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA work GRANT SELECT ON TABLES TO pai_sync;
ALTER DEFAULT PRIVILEGES IN SCHEMA work GRANT USAGE, SELECT ON SEQUENCES TO pai_sync;

ALTER DEFAULT PRIVILEGES IN SCHEMA personal GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA personal GRANT USAGE, SELECT ON SEQUENCES TO pai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA personal GRANT SELECT ON TABLES TO pai_sync;
ALTER DEFAULT PRIVILEGES IN SCHEMA personal GRANT USAGE, SELECT ON SEQUENCES TO pai_sync;

ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT ON TABLES TO pai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT USAGE, SELECT ON SEQUENCES TO pai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT ON TABLES TO pai_sync;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT USAGE, SELECT ON SEQUENCES TO pai_sync;

-- 5f. Lock search_path per role (additive to existing core path)
ALTER ROLE pai_app SET search_path = core, work, personal, shared;
ALTER ROLE pai_sync SET search_path = core, public, pgml, ag_catalog;

-- ============================================================================
-- 6. GRADUATE_INSIGHT FUNCTION — controlled write path to shared schema
-- ============================================================================

CREATE OR REPLACE FUNCTION shared.graduate_insight(
    p_source_domain  TEXT,
    p_title          TEXT,
    p_content        TEXT,
    p_category       TEXT DEFAULT 'general',
    p_confidence     TEXT DEFAULT 'medium',
    p_tags           TEXT[] DEFAULT '{}',
    p_source_ref     TEXT DEFAULT NULL,
    p_instance_id    TEXT DEFAULT NULL,
    p_metadata       JSONB DEFAULT '{}'::jsonb
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER  -- runs as owner (postgres), so pai_app/pai_sync can call it without direct INSERT on shared
AS $$
DECLARE
    v_id BIGINT;
BEGIN
    -- Validate source_domain
    IF p_source_domain NOT IN ('work', 'personal') THEN
        RAISE EXCEPTION 'source_domain must be work or personal, got: %', p_source_domain;
    END IF;

    INSERT INTO shared.insights (
        source_domain, title, content, category, confidence, tags, source_ref, instance_id, metadata
    ) VALUES (
        p_source_domain, p_title, p_content, p_category, p_confidence, p_tags, p_source_ref, p_instance_id, p_metadata
    )
    RETURNING id INTO v_id;

    -- Log the graduation event in hive_log
    INSERT INTO shared.hive_log (event_type, table_name, record_id, source_instance, detail)
    VALUES (
        'graduate',
        'shared.insights',
        v_id::TEXT,
        p_instance_id,
        jsonb_build_object(
            'source_domain', p_source_domain,
            'category', p_category,
            'title', p_title
        )
    );

    RETURN v_id;
END;
$$;

-- Grant EXECUTE on graduate_insight to both roles — the SECURITY DEFINER handles write perms
GRANT EXECUTE ON FUNCTION shared.graduate_insight(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, JSONB) TO pai_app;
GRANT EXECUTE ON FUNCTION shared.graduate_insight(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, JSONB) TO pai_sync;

COMMENT ON FUNCTION shared.graduate_insight IS 'Controlled write path to shared.insights — the only way non-superuser roles can insert insights.';

-- ============================================================================
-- 7. COMPACTION PROTECTION — helper function for PreCompact hook
-- ============================================================================

CREATE OR REPLACE FUNCTION core.record_compaction(
    p_session_id      TEXT,
    p_summary         TEXT,
    p_task_title      TEXT DEFAULT NULL,
    p_session_dir     TEXT DEFAULT NULL,
    p_trigger         TEXT DEFAULT 'auto',
    p_checkpoint_path TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    v_id BIGINT;
BEGIN
    INSERT INTO core.compaction_checkpoints (
        session_id, summary, task_title, session_dir, trigger, checkpoint_path
    ) VALUES (
        p_session_id, p_summary, p_task_title, p_session_dir, p_trigger, p_checkpoint_path
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- Grant EXECUTE to both roles (PreCompact hook may use either)
GRANT EXECUTE ON FUNCTION core.record_compaction(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO pai_app;
GRANT EXECUTE ON FUNCTION core.record_compaction(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO pai_sync;

COMMENT ON FUNCTION core.record_compaction IS 'Helper for PreCompact hook — inserts a compaction checkpoint into core.compaction_checkpoints synchronously.';

-- ============================================================================
-- 8. HIVE COLLECTIVE PREP — publication for shared schema (not activated)
-- ============================================================================

-- Create publication for the shared schema (safe to re-run — DROP IF EXISTS first)
-- Note: CREATE PUBLICATION IF NOT EXISTS is not supported in PG16, so we drop-create
DO $$
BEGIN
    -- Drop existing publication if it exists
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'hive_shared_pub') THEN
        DROP PUBLICATION hive_shared_pub;
    END IF;
END;
$$;

CREATE PUBLICATION hive_shared_pub FOR TABLES IN SCHEMA shared;

COMMENT ON PUBLICATION hive_shared_pub IS 'Hive collective: publishes all shared schema tables for cross-instance logical replication via Tailscale.';

-- ============================================================================
-- 9. WAL level check — logical replication requires wal_level = logical
-- ============================================================================

-- This is informational only. If wal_level is not 'logical', log a notice.
-- Changing wal_level requires postgresql.conf edit + restart — cannot be done in SQL.
DO $$
DECLARE
    v_wal_level TEXT;
BEGIN
    SELECT setting INTO v_wal_level FROM pg_settings WHERE name = 'wal_level';
    IF v_wal_level != 'logical' THEN
        RAISE NOTICE 'HIVE PREP: wal_level is currently "%" — logical replication requires "logical". Update postgresql.conf and restart to enable.', v_wal_level;
    ELSE
        RAISE NOTICE 'HIVE PREP: wal_level is "logical" — ready for logical replication.';
    END IF;
END;
$$;

COMMIT;

-- ============================================================================
-- POST-TRANSACTION: Verify setup
-- ============================================================================

-- Schema listing
\echo '=== SCHEMAS ==='
SELECT schema_name FROM information_schema.schemata
WHERE schema_name IN ('core', 'work', 'personal', 'shared')
ORDER BY schema_name;

-- Table counts per schema
\echo '=== TABLE COUNTS PER SCHEMA ==='
SELECT table_schema, COUNT(*) AS table_count
FROM information_schema.tables
WHERE table_schema IN ('core', 'work', 'personal', 'shared')
  AND table_type = 'BASE TABLE'
GROUP BY table_schema
ORDER BY table_schema;

-- All tables
\echo '=== ALL TABLES ==='
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema IN ('work', 'personal', 'shared')
  AND table_type = 'BASE TABLE'
ORDER BY table_schema, table_name;

-- Role grants summary
\echo '=== ROLE GRANTS ==='
SELECT grantee, table_schema, COUNT(*) AS grant_count,
       string_agg(DISTINCT privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE grantee IN ('pai_app', 'pai_sync')
  AND table_schema IN ('work', 'personal', 'shared')
GROUP BY grantee, table_schema
ORDER BY grantee, table_schema;

-- Functions
\echo '=== FUNCTIONS ==='
SELECT routine_schema, routine_name
FROM information_schema.routines
WHERE routine_schema IN ('core', 'shared')
  AND routine_type = 'FUNCTION'
  AND routine_name IN ('record_compaction', 'graduate_insight', 'assemble_context', 'search_memory_by_vector')
ORDER BY routine_schema, routine_name;

-- Publication
\echo '=== PUBLICATIONS ==='
SELECT pubname, puballtables, pubinsert, pubupdate, pubdelete
FROM pg_publication
WHERE pubname = 'hive_shared_pub';
