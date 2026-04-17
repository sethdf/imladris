-- =============================================================================
-- Audiense Customer Data Mart - Database Initialization Script
-- Sizing: db.m6g.large (2 vCPU, 8GB RAM), 100GB gp3, single-AZ
-- Scale: ~20k customers, ~50k prospects, activity history
-- =============================================================================
-- Run this script as the RDS master user after connecting to the instance.
-- Execute sections in order. Each section is idempotent where possible.
--
-- BEFORE RUNNING:
--   1. Apply parameter group (02_rds_parameter_group.json) and reboot instance
--   2. Replace all REPLACE_ME_* passwords in Section 4
--   3. Store passwords in AWS Secrets Manager - never in code or config files
-- =============================================================================

-- -----------------------------------------------------------------------------
-- SECTION 1: Create the database
-- -----------------------------------------------------------------------------
-- Run this while connected to the default 'postgres' database

CREATE DATABASE audiense_datamart
    ENCODING    'UTF8'
    LC_COLLATE  'en_US.UTF-8'
    LC_CTYPE    'en_US.UTF-8'
    TEMPLATE    template0;

COMMENT ON DATABASE audiense_datamart IS
    'Audiense unified customer data mart - Audiense, Elevar, Buxton divisions';

-- Now reconnect: \c audiense_datamart


-- -----------------------------------------------------------------------------
-- SECTION 2: Extensions
-- -----------------------------------------------------------------------------
-- Must be run as superuser (RDS master user)

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;   -- Query performance tracking (requires shared_preload_libraries in parameter group)
CREATE EXTENSION IF NOT EXISTS pgcrypto;             -- UUID generation, SHA-256 hashing for PII masking
CREATE EXTENSION IF NOT EXISTS btree_gin;            -- GIN indexes on scalar types
CREATE EXTENSION IF NOT EXISTS pg_trgm;              -- Trigram indexes for fuzzy text search

-- Verify extensions installed
SELECT name, default_version, installed_version
FROM pg_available_extensions
WHERE installed_version IS NOT NULL
ORDER BY name;


-- -----------------------------------------------------------------------------
-- SECTION 3: Schemas
-- -----------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS staging;
CREATE SCHEMA IF NOT EXISTS marts;
CREATE SCHEMA IF NOT EXISTS audit;

COMMENT ON SCHEMA raw     IS 'Landing zone: source data as-is from all division pipelines. No transformations.';
COMMENT ON SCHEMA staging IS 'Cleansed, conformed, and deduplicated data. Intermediate transformations.';
COMMENT ON SCHEMA marts   IS 'Business-facing denormalised tables. Query-optimised for BI tools and analysts.';
COMMENT ON SCHEMA audit   IS 'Pipeline run logs, row counts, data quality checks, and lineage metadata.';


-- -----------------------------------------------------------------------------
-- SECTION 4: Roles and Users
-- -----------------------------------------------------------------------------

-- Functional roles (no login - assigned to login users below)
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'raw_writer_role') THEN
        CREATE ROLE raw_writer_role;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'staging_etl_role') THEN
        CREATE ROLE staging_etl_role;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'marts_reader_role') THEN
        CREATE ROLE marts_reader_role;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'audit_writer_role') THEN
        CREATE ROLE audit_writer_role;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'datamart_admin_role') THEN
        CREATE ROLE datamart_admin_role;
    END IF;
END
$$;

-- Login users - REPLACE all passwords before running.
-- Connection limits are conservative for m6g.large (max_connections = 50).

-- ETL pipeline: lands raw data from Elevar, Audiense, Buxton sources
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_raw_loader') THEN
        CREATE USER svc_raw_loader WITH PASSWORD 'REPLACE_ME_raw_loader_password' CONNECTION LIMIT 5;
    END IF;
END
$$;

-- Transformation: reads raw, writes staging and marts
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_etl') THEN
        CREATE USER svc_etl WITH PASSWORD 'REPLACE_ME_etl_password' CONNECTION LIMIT 5;
    END IF;
END
$$;

-- BI tool read user: Tableau, Metabase, Looker, Power BI, etc.
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_bi_reader') THEN
        CREATE USER svc_bi_reader WITH PASSWORD 'REPLACE_ME_bi_reader_password' CONNECTION LIMIT 15;
    END IF;
END
$$;

-- Analyst user: data team with read access across all schemas
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_analyst') THEN
        CREATE USER svc_analyst WITH PASSWORD 'REPLACE_ME_analyst_password' CONNECTION LIMIT 10;
    END IF;
END
$$;


-- -----------------------------------------------------------------------------
-- SECTION 5: Grant schema-level permissions
-- -----------------------------------------------------------------------------

-- raw_writer_role: write to raw, log to audit
GRANT USAGE, CREATE ON SCHEMA raw   TO raw_writer_role;
GRANT USAGE         ON SCHEMA audit TO raw_writer_role;

-- staging_etl_role: read raw, write staging and marts, log to audit
GRANT USAGE         ON SCHEMA raw     TO staging_etl_role;
GRANT USAGE, CREATE ON SCHEMA staging TO staging_etl_role;
GRANT USAGE, CREATE ON SCHEMA marts   TO staging_etl_role;
GRANT USAGE         ON SCHEMA audit   TO staging_etl_role;

-- marts_reader_role: read staging and marts (BI tools, APIs)
GRANT USAGE ON SCHEMA staging TO marts_reader_role;
GRANT USAGE ON SCHEMA marts   TO marts_reader_role;

-- datamart_admin_role: full access (DBA / senior engineers)
GRANT ALL ON SCHEMA raw, staging, marts, audit TO datamart_admin_role;

-- Assign roles to login users
GRANT raw_writer_role   TO svc_raw_loader;
GRANT staging_etl_role  TO svc_etl;
GRANT marts_reader_role TO svc_bi_reader;
GRANT staging_etl_role  TO svc_analyst;    -- analysts read raw + staging + marts
GRANT marts_reader_role TO svc_analyst;


-- -----------------------------------------------------------------------------
-- SECTION 6: Table-level grants on existing objects
-- -----------------------------------------------------------------------------

GRANT SELECT                         ON ALL TABLES IN SCHEMA raw     TO staging_etl_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA staging TO staging_etl_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA marts   TO staging_etl_role;
GRANT SELECT                         ON ALL TABLES IN SCHEMA staging TO marts_reader_role;
GRANT SELECT                         ON ALL TABLES IN SCHEMA marts   TO marts_reader_role;
GRANT SELECT, INSERT                 ON ALL TABLES IN SCHEMA audit   TO raw_writer_role;
GRANT SELECT, INSERT                 ON ALL TABLES IN SCHEMA audit   TO staging_etl_role;


-- -----------------------------------------------------------------------------
-- SECTION 7: Default privileges (applies to all FUTURE tables)
-- -----------------------------------------------------------------------------
-- CRITICAL: Without this, new tables created by migrations won't be accessible.

ALTER DEFAULT PRIVILEGES IN SCHEMA raw
    GRANT SELECT, INSERT, UPDATE ON TABLES TO raw_writer_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA raw
    GRANT SELECT ON TABLES TO staging_etl_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA staging
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO staging_etl_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA staging
    GRANT SELECT ON TABLES TO marts_reader_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA marts
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO staging_etl_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA marts
    GRANT SELECT ON TABLES TO marts_reader_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA audit
    GRANT SELECT, INSERT ON TABLES TO raw_writer_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA audit
    GRANT SELECT, INSERT ON TABLES TO staging_etl_role;


-- -----------------------------------------------------------------------------
-- SECTION 8: Per-role session settings
-- -----------------------------------------------------------------------------

ALTER ROLE svc_bi_reader  SET statement_timeout = '300s';    -- 5 min: prevents runaway dashboard queries
ALTER ROLE svc_analyst    SET statement_timeout = '1800s';   -- 30 min: ad-hoc queries can be long
ALTER ROLE svc_etl        SET statement_timeout = '0';       -- No cap: bulk transforms can be slow
ALTER ROLE svc_raw_loader SET statement_timeout = '0';       -- No cap: bulk loads can be slow

-- Lock timeouts prevent silent deadlock pile-ups across pipelines
ALTER ROLE svc_raw_loader  SET lock_timeout = '30s';
ALTER ROLE svc_etl         SET lock_timeout = '30s';
ALTER ROLE svc_bi_reader   SET lock_timeout = '10s';
ALTER ROLE svc_analyst     SET lock_timeout = '10s';


-- -----------------------------------------------------------------------------
-- SECTION 11: Staging schema - conformed dimensions
-- -----------------------------------------------------------------------------


-- Date dimension (seed once with 03_seed_dim_date.sql, never changes)
CREATE TABLE IF NOT EXISTS staging.dim_date (
    date_sk         INTEGER     PRIMARY KEY,            -- YYYYMMDD integer (e.g. 20260414)
    full_date       DATE        NOT NULL UNIQUE,
    year            SMALLINT    NOT NULL,
    quarter         SMALLINT    NOT NULL,
    month           SMALLINT    NOT NULL,
    month_name      TEXT        NOT NULL,
    week_of_year    SMALLINT    NOT NULL,
    day_of_month    SMALLINT    NOT NULL,
    day_of_week     SMALLINT    NOT NULL,               -- 0=Sunday, 6=Saturday
    day_name        TEXT        NOT NULL,
    is_weekend      BOOLEAN     NOT NULL,
    is_uk_holiday   BOOLEAN     NOT NULL DEFAULT FALSE,
    is_us_holiday   BOOLEAN     NOT NULL DEFAULT FALSE
);

COMMENT ON TABLE staging.dim_date IS
    'Standard date dimension. Covers 2020-01-01 to 2035-12-31.';
