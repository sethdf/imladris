-- =============================================================================
-- 02-create-extensions.sql
-- Enable extensions in the pai database.
-- Runs after 01-create-pai-database.sql (alphabetical order).
-- =============================================================================

\connect pai

-- pgvector — semantic search via embeddings (Phase 2a)
CREATE EXTENSION IF NOT EXISTS vector;

-- pg_trgm — fuzzy/typo-tolerant text matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ltree — hierarchical path queries on memory keys
CREATE EXTENSION IF NOT EXISTS ltree;

-- pgcrypto — hashing, encryption utilities
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Apache AGE — graph database via Cypher queries (Phase 2b)
CREATE EXTENSION IF NOT EXISTS age;
-- Load AGE into search path for Cypher syntax
ALTER DATABASE pai SET search_path = ag_catalog, "$user", public, core;

-- pg_cron — scheduled jobs inside Postgres (Phase 2+)
-- Note: pg_cron can only be created in the postgres database by default,
-- but can schedule jobs that run in other databases via cron.schedule_in_database()
\connect postgres
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- =============================================================================
-- Also enable vector in windmill database for future cross-db queries
-- =============================================================================
\connect windmill
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
