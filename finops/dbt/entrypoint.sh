#!/bin/bash
set -euo pipefail

echo "=== dbt debug ==="
dbt debug --profiles-dir /dbt || echo "dbt debug had warnings (non-fatal)"

echo "=== dbt deps ==="
dbt deps --profiles-dir /dbt || true

echo "=== dbt run ==="
dbt run --profiles-dir /dbt --target prod

echo "=== dbt test ==="
dbt test --profiles-dir /dbt --target prod

echo "=== dbt run complete ==="
