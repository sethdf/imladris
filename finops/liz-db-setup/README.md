# Audiense Customer Data Mart — Setup Guide
### Sizing: db.m6g.large · 100GB gp3 · Single-AZ
### Scale: ~20k customers · ~50k prospects · activity history

---

## Files in this package

| File | Purpose |
|------|---------|
| `01_datamart_init.sql` | Run once: creates database, schemas, roles, tables, indexes |
| `02_rds_parameter_group.json` | Parameter group settings tuned for m6g.large analytical workload |
| `README.md` | This file |

---

## Recommended Instance Specification

| Setting | Value | Notes |
|---------|-------|-------|
| Engine | PostgreSQL 16 | |
| Instance class | db.m6g.large | 2 vCPU, 8GB RAM. Non-burstable — predictable performance |
| Multi-AZ | No (start) | Enable later if BI becomes customer-facing or SLA tightens |
| Storage type | gp3 | |
| Storage size | 100GB initial | |
| gp3 IOPS | 3,000 | Default baseline — sufficient at this scale |
| gp3 Throughput | 125 MB/s | Default — sufficient at this scale |
| Storage autoscaling | Enabled | Ceiling: 500GB |
| Backup retention | 14 days | |
| Maintenance window | Sun 02:00-03:00 UTC | Low-traffic window |
| Deletion protection | Enabled | |
| Performance Insights | Enabled, 7 days | Free tier |
| Enhanced Monitoring | 60s granularity | |

**Why m6g.large over t3.medium or t3.large:**
t3 instances use CPU credits. When credits are exhausted during an ETL run while analysts are querying, the instance throttles to roughly 20% CPU with no warning or visible error. m6g.large has fixed CPU — slightly slower at burst peak, but completely predictable. For a data mart, predictability beats occasional speed.

---

## Step 1: Apply Parameter Group

Apply `02_rds_parameter_group.json` BEFORE running the init SQL.
`shared_preload_libraries` (needed for `pg_stat_statements`) requires a reboot.

```bash
# Create the parameter group
aws rds create-db-parameter-group \
  --db-parameter-group-name audiense-datamart-pg16 \
  --db-parameter-group-family postgres16 \
  --description "Audiense data mart - m6g.large small scale"

# Apply reboot-required parameters first
aws rds modify-db-parameter-group \
  --db-parameter-group-name audiense-datamart-pg16 \
  --parameters \
    "ParameterName=shared_preload_libraries,ParameterValue=pg_stat_statements,ApplyMethod=pending-reboot" \
    "ParameterName=max_connections,ParameterValue=50,ApplyMethod=pending-reboot"

# Apply immediate parameters
aws rds modify-db-parameter-group \
  --db-parameter-group-name audiense-datamart-pg16 \
  --parameters \
    "ParameterName=work_mem,ParameterValue=16384,ApplyMethod=immediate" \
    "ParameterName=max_parallel_workers,ParameterValue=2,ApplyMethod=immediate" \
    "ParameterName=max_parallel_workers_per_gather,ParameterValue=2,ApplyMethod=immediate" \
    "ParameterName=random_page_cost,ParameterValue=1.1,ApplyMethod=immediate" \
    "ParameterName=effective_io_concurrency,ParameterValue=200,ApplyMethod=immediate" \
    "ParameterName=log_min_duration_statement,ParameterValue=2000,ApplyMethod=immediate" \
    "ParameterName=autovacuum_vacuum_scale_factor,ParameterValue=0.05,ApplyMethod=immediate" \
    "ParameterName=autovacuum_analyze_scale_factor,ParameterValue=0.02,ApplyMethod=immediate"

# Attach to instance and reboot
aws rds modify-db-instance \
  --db-instance-identifier audiense-datamart \
  --db-parameter-group-name audiense-datamart-pg16

aws rds reboot-db-instance \
  --db-instance-identifier audiense-datamart
```

---

## Step 2: Run the Initialization SQL

Before running, replace all four REPLACE_ME_* passwords in Section 4 of the init script. Store the real values in AWS Secrets Manager — never in code or config files.

```bash
# Connect as master user to the default postgres database
psql -h <rds-endpoint> -U <master-username> -d postgres

# Run the init script
\i 01_datamart_init.sql
```

---

## Step 3: Seed the Date Dimension

The `staging.dim_date` table is a static reference table that needs to be populated once after the init script runs.

```sql
\c audiense_datamart

INSERT INTO staging.dim_date (
    date_sk, full_date, year, quarter, month, month_name,
    week_of_year, day_of_month, day_of_week, day_name, is_weekend
)
SELECT
    TO_CHAR(d, 'YYYYMMDD')::INTEGER,
    d::DATE,
    EXTRACT(YEAR    FROM d)::SMALLINT,
    EXTRACT(QUARTER FROM d)::SMALLINT,
    EXTRACT(MONTH   FROM d)::SMALLINT,
    TO_CHAR(d, 'Month'),
    EXTRACT(WEEK    FROM d)::SMALLINT,
    EXTRACT(DAY     FROM d)::SMALLINT,
    EXTRACT(DOW     FROM d)::SMALLINT,
    TO_CHAR(d, 'Day'),
    EXTRACT(DOW FROM d) IN (0, 6)
FROM generate_series('2020-01-01'::DATE, '2035-12-31'::DATE, '1 day') AS d
ON CONFLICT (date_sk) DO NOTHING;

-- Verify: should return 5844
SELECT COUNT(*) FROM staging.dim_date;
```

---

## Step 4: Verify Setup

Run the verification queries in Section 13 of `01_datamart_init.sql`. Expected results:

| Check | Expected |
|-------|----------|
| Schemas | audit, marts, raw, staging |
| Login users | svc_analyst, svc_bi_reader, svc_etl, svc_raw_loader |
| Functional roles | audit_writer_role, datamart_admin_role, marts_reader_role, raw_writer_role, staging_etl_role |
| Tables in staging | dim_date |


---

## Step 5: CloudWatch Alarms to Configure

| Metric | Threshold | Severity |
|--------|-----------|----------|
| CPUUtilization | > 70% for 10 min | Warning |
| FreeStorageSpace | < 20GB | Warning |
| FreeStorageSpace | < 5GB | Critical |
| DatabaseConnections | > 40 | Warning |
| FreeableMemory | < 1GB | Warning |
| ReadLatency | > 10ms | Warning |
| WriteLatency | > 10ms | Warning |
| DiskQueueDepth | > 5 | Warning |

---

## Step 6: Migration Tool Setup

All future DDL must go through a migration tool. No direct schema changes in production.

Recommended: **Flyway** (SQL-first, minimal setup overhead)

```
migrations/
  V1__init_schemas_roles.sql      <- 01_datamart_init.sql becomes V1
  V2__seed_dim_date.sql           <- date dimension seed (Step 3 above)
  V3__add_dim_products.sql        <- all future additions follow here
```

Create a dedicated migration user:

```sql
CREATE USER svc_migrations WITH PASSWORD 'REPLACE_ME' CONNECTION LIMIT 2;
GRANT datamart_admin_role TO svc_migrations;
```

---

## Scaling Triggers

These are the observable signals to act on, not arbitrary dates or row count targets:

| Signal | Action |
|--------|--------|
| `fct_activities` or `raw.elevar_events` exceeds ~1M rows | Add partitioning via Flyway migration. Tables are partition-ready (event_date column exists). |
| Sequential scans > 500ms in `pg_stat_statements` | Add partitioning or targeted indexes |
| CPU consistently > 60% during ETL and query overlap | Upgrade to db.m6g.xlarge (4 vCPU); raise `max_parallel_workers` to 4 in parameter group |
| Connection count regularly hitting 40+ | Deploy RDS Proxy; raise `max_connections` to 100 |
| Partitioning added | Set `enable_partitionwise_join=1` and `enable_partitionwise_aggregate=1` in parameter group |
| Downtime becomes unacceptable | Enable Multi-AZ in RDS console — zero schema changes required |

---

## Useful Operational Queries

Run these periodically, especially during the first few months after go-live.

```sql
-- Slowest queries by average execution time (run weekly)
SELECT
    LEFT(query, 80)                                      AS query_preview,
    calls,
    ROUND(total_exec_time::NUMERIC / calls, 1)           AS avg_ms,
    ROUND(total_exec_time::NUMERIC, 0)                   AS total_ms
FROM pg_stat_statements
ORDER BY avg_ms DESC
LIMIT 20;

-- Queries spilling to disk (work_mem too low for that query)
SELECT
    LEFT(query, 80)   AS query_preview,
    temp_blks_written AS disk_spill_blocks
FROM pg_stat_statements
WHERE temp_blks_written > 0
ORDER BY temp_blks_written DESC
LIMIT 10;

-- Table sizes across mart schemas (run monthly)
SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS total_size,
    pg_total_relation_size(schemaname || '.' || tablename)                  AS bytes
FROM pg_tables
WHERE schemaname IN ('raw', 'staging', 'marts')
ORDER BY bytes DESC;

-- Active connections vs limits per service account
SELECT
    r.rolname,
    r.rolconnlimit                                        AS conn_limit,
    COUNT(sa.pid)                                         AS active_now
FROM pg_roles r
LEFT JOIN pg_stat_activity sa ON sa.usename = r.rolname
WHERE r.rolname LIKE 'svc_%'
GROUP BY r.rolname, r.rolconnlimit
ORDER BY r.rolname;

-- Recent pipeline run summary (last 7 days)
SELECT
    pipeline_name,
    division,
    status,
    rows_loaded,
    ROUND(EXTRACT(EPOCH FROM (completed_at - started_at))::NUMERIC, 1) AS duration_secs,
    started_at
FROM audit.pipeline_runs
WHERE started_at > NOW() - INTERVAL '7 days'
ORDER BY started_at DESC;
```
