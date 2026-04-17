#!/bin/bash
set -euo pipefail

echo "=== dbt debug ==="
dbt debug --profiles-dir /dbt || echo "dbt debug had warnings (non-fatal)"

echo "=== dbt deps ==="
dbt deps --profiles-dir /dbt || true

echo "=== dbt docs generate ==="
dbt docs generate --profiles-dir /dbt --target prod || echo "docs generate had errors (non-fatal, serving partial docs)"

echo "=== serving dbt docs on port 8080 ==="
# dbt docs serve binds to localhost by default which fails in Fargate
# Use python http.server instead, serving the generated target/ directory
cd /dbt/target && python3 -m http.server 8080 --bind 0.0.0.0
