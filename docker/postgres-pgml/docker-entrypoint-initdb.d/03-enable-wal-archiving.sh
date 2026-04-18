#!/bin/bash
# Enable WAL archiving for pgBackRest continuous backup.
# Runs on first container init only (docker-entrypoint-initdb.d convention).
# pgBackRest S3 target must be configured before first backup runs.

set -e

cat >> "$PGDATA/postgresql.conf" <<WALCONF

# ── pgBackRest WAL archiving (added by 03-enable-wal-archiving.sh) ──
archive_mode = on
archive_command = 'pgbackrest --stanza=imladris archive-push %p || true'
archive_timeout = 60
wal_level = replica
max_wal_senders = 3
WALCONF

echo "pgBackRest WAL archiving enabled in postgresql.conf"
