#!/bin/bash
set -euo pipefail

echo "=== dbt debug ==="
dbt debug --profiles-dir /dbt || echo "dbt debug had warnings (non-fatal)"

echo "=== dbt deps ==="
dbt deps --profiles-dir /dbt || true

echo "=== dbt docs generate ==="
dbt docs generate --profiles-dir /dbt --target prod

echo "=== serving dbt docs on port 8080 ==="
dbt docs serve --profiles-dir /dbt --port 8080 --no-browser
