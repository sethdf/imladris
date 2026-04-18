#!/usr/bin/env bash
# pgbackrest-backup.sh — Run pgBackRest backup from the Postgres container
# Usage:
#   ./pgbackrest-backup.sh              # incremental backup (default)
#   ./pgbackrest-backup.sh full         # full backup
#   ./pgbackrest-backup.sh diff         # differential backup
#   ./pgbackrest-backup.sh stanza-create # first-time stanza setup
#   ./pgbackrest-backup.sh info         # show backup info
#
# Runs inside the windmill_db container. S3 bucket configured via env var.

set -euo pipefail
CONTAINER="${PGBACKREST_CONTAINER:-imladris-windmill_db-1}"
COMMAND="${1:-incr}"

case "$COMMAND" in
  stanza-create)
    echo "Creating pgBackRest stanza..."
    docker exec "$CONTAINER" pgbackrest --stanza=imladris stanza-create
    ;;
  full|diff|incr)
    echo "Running $COMMAND backup..."
    docker exec "$CONTAINER" pgbackrest --stanza=imladris --type="$COMMAND" backup
    ;;
  info)
    docker exec "$CONTAINER" pgbackrest --stanza=imladris info
    ;;
  *)
    echo "Usage: $0 {stanza-create|full|diff|incr|info}" >&2
    exit 1
    ;;
esac
