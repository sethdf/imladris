-- Intake System Database Schema
-- Universal intake for all information sources
-- Location: /data/.cache/intake/intake.sqlite

-- =============================================================================
-- Core Tables
-- =============================================================================

-- Primary intake units (threads for chat, individual for email/ticket)
CREATE TABLE IF NOT EXISTS intake (
    id TEXT PRIMARY KEY,                    -- UUID
    zone TEXT NOT NULL DEFAULT 'work',      -- work, home (zone differentiation)
    source TEXT NOT NULL,                   -- slack, telegram, email-ms365, email-gmail, sdp-ticket, sdp-task, capture
    source_id TEXT NOT NULL,                -- Original ID from source system
    type TEXT NOT NULL,                     -- conversation, email, ticket, task, note, file

    -- Content
    subject TEXT,                           -- Subject or AI-generated summary
    body TEXT,                              -- Full content (email body, latest message)
    context TEXT,                           -- For threads: recent message history as text
    content_hash TEXT,                      -- SHA256 for dedup

    -- Participants
    from_name TEXT,
    from_address TEXT,
    from_user_id TEXT,
    participants TEXT,                      -- JSON array for multi-party

    -- Timestamps
    created_at DATETIME,                    -- When thread/item started in source
    updated_at DATETIME,                    -- Last activity in source
    ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    -- State
    status TEXT DEFAULT 'new',              -- new, seen, actioned, archived
    read_status TEXT DEFAULT 'unread',      -- unread, read
    message_count INTEGER DEFAULT 1,

    -- Enrichment (computed)
    enrichment TEXT,                        -- JSON: sender_profile, urgency_cues, entities, etc.

    -- Embedding (for similarity search)
    embedding BLOB,                         -- Float32 array, 384 dimensions

    -- Metadata
    metadata TEXT,                          -- JSON blob for source-specific data

    UNIQUE(source, source_id)
);

-- Individual messages (for chat thread history)
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    intake_id TEXT NOT NULL REFERENCES intake(id) ON DELETE CASCADE,
    source_message_id TEXT,                 -- Original message ID
    timestamp DATETIME NOT NULL,
    sender_name TEXT,
    sender_address TEXT,
    content TEXT NOT NULL,
    metadata TEXT,                          -- JSON
    UNIQUE(intake_id, source_message_id)
);

-- Triage results (AI or rules classification)
CREATE TABLE IF NOT EXISTS triage (
    intake_id TEXT PRIMARY KEY REFERENCES intake(id) ON DELETE CASCADE,
    category TEXT,                          -- Action-Required, FYI, Delegatable, Spam, Archive
    priority TEXT,                          -- P0, P1, P2, P3
    confidence INTEGER,                     -- 1-10 confidence score
    quick_win BOOLEAN DEFAULT FALSE,
    quick_win_reason TEXT,
    estimated_time TEXT,                    -- 5min, 15min, 30min, 1hr, 2hr+
    reasoning TEXT,                         -- Why this classification
    suggested_action TEXT,
    triaged_by TEXT,                        -- 'rules', 'similarity', 'ai', 'user'
    triaged_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Triage corrections (for learning)
CREATE TABLE IF NOT EXISTS triage_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intake_id TEXT NOT NULL REFERENCES intake(id) ON DELETE CASCADE,
    original_category TEXT,
    original_priority TEXT,
    corrected_category TEXT,
    corrected_priority TEXT,
    correction_reason TEXT,
    corrected_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Contacts & VIP Management
-- =============================================================================

CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    slack_user_id TEXT,
    telegram_chat_id TEXT,
    ms365_user_id TEXT,
    is_vip BOOLEAN DEFAULT FALSE,
    vip_reason TEXT,
    relationship TEXT,                      -- manager, direct_report, peer, external, etc.
    organization TEXT,
    typical_urgency TEXT,                   -- high, normal, low
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Sync Tracking
-- =============================================================================

CREATE TABLE IF NOT EXISTS sync_state (
    source TEXT PRIMARY KEY,
    last_sync DATETIME,
    last_successful_sync DATETIME,
    cursor TEXT,                            -- Source-specific checkpoint
    status TEXT,                            -- success, error, in_progress
    error_message TEXT,
    items_synced INTEGER DEFAULT 0,
    consecutive_failures INTEGER DEFAULT 0,
    backoff_until DATETIME
);

-- =============================================================================
-- Rules Configuration
-- =============================================================================

CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    priority INTEGER DEFAULT 100,           -- Lower = runs first
    enabled BOOLEAN DEFAULT TRUE,
    conditions TEXT NOT NULL,               -- JSON for json-rules-engine
    event TEXT NOT NULL,                    -- JSON for action
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Indexes
-- =============================================================================

-- Core lookups
CREATE INDEX IF NOT EXISTS idx_intake_zone ON intake(zone);
CREATE INDEX IF NOT EXISTS idx_intake_source ON intake(source);
CREATE INDEX IF NOT EXISTS idx_intake_zone_source ON intake(zone, source);
CREATE INDEX IF NOT EXISTS idx_intake_status ON intake(status);
CREATE INDEX IF NOT EXISTS idx_intake_created ON intake(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intake_updated ON intake(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_intake_content_hash ON intake(content_hash);
CREATE INDEX IF NOT EXISTS idx_intake_from_address ON intake(from_address);

-- Triage lookups
CREATE INDEX IF NOT EXISTS idx_triage_category ON triage(category);
CREATE INDEX IF NOT EXISTS idx_triage_priority ON triage(priority);
CREATE INDEX IF NOT EXISTS idx_triage_quick_win ON triage(quick_win);

-- Messages
CREATE INDEX IF NOT EXISTS idx_messages_intake ON messages(intake_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);

-- Contacts
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_vip ON contacts(is_vip);

-- =============================================================================
-- Views
-- =============================================================================

-- Actionable items (unread, action-required, by priority)
CREATE VIEW IF NOT EXISTS v_actionable AS
SELECT
    i.*,
    t.category,
    t.priority,
    t.quick_win,
    t.estimated_time,
    t.suggested_action
FROM intake i
LEFT JOIN triage t ON i.id = t.intake_id
WHERE i.status IN ('new', 'seen')
  AND (t.category IS NULL OR t.category = 'Action-Required')
ORDER BY
    CASE t.priority
        WHEN 'P0' THEN 0
        WHEN 'P1' THEN 1
        WHEN 'P2' THEN 2
        WHEN 'P3' THEN 3
        ELSE 4
    END,
    i.updated_at DESC;

-- Quick wins
CREATE VIEW IF NOT EXISTS v_quick_wins AS
SELECT
    i.*,
    t.category,
    t.priority,
    t.quick_win_reason,
    t.estimated_time
FROM intake i
JOIN triage t ON i.id = t.intake_id
WHERE i.status IN ('new', 'seen')
  AND t.quick_win = TRUE
ORDER BY t.priority, i.updated_at DESC;

-- Untriaged items
CREATE VIEW IF NOT EXISTS v_untriaged AS
SELECT i.*
FROM intake i
LEFT JOIN triage t ON i.id = t.intake_id
WHERE t.intake_id IS NULL
  AND i.status = 'new'
ORDER BY i.ingested_at DESC;

-- Stats by source
CREATE VIEW IF NOT EXISTS v_stats_by_source AS
SELECT
    zone,
    source,
    COUNT(*) as total,
    SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_count,
    SUM(CASE WHEN status = 'seen' THEN 1 ELSE 0 END) as seen_count,
    SUM(CASE WHEN status = 'actioned' THEN 1 ELSE 0 END) as actioned_count,
    MAX(updated_at) as last_activity
FROM intake
GROUP BY zone, source;

-- Stats by zone
CREATE VIEW IF NOT EXISTS v_stats_by_zone AS
SELECT
    zone,
    COUNT(*) as total,
    SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_count,
    SUM(CASE WHEN status = 'seen' THEN 1 ELSE 0 END) as seen_count,
    SUM(CASE WHEN status = 'actioned' THEN 1 ELSE 0 END) as actioned_count,
    MAX(updated_at) as last_activity
FROM intake
GROUP BY zone;
