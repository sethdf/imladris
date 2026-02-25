#!/usr/bin/env bash
set -euo pipefail

# cache-evict.sh — Size-based eviction for the NVMe triage cache.
# Runs daily via cron. Removes oldest items when cache exceeds 100GB.

CACHE_DIR="/local/cache/triage"

if [[ ! -d "${CACHE_DIR}" ]]; then
    exit 0  # NVMe not mounted or cache not initialized — nothing to do
fi

# Use bun to run eviction via cache_lib
SCRIPT_DIR="$(cd "$(dirname "$0")/../windmill/f/devops" && pwd)"
cd "${SCRIPT_DIR}"

bun -e "
const { evict, stats } = require('./cache_lib.ts');
const before = stats();
const result = evict(100);
if (result.removed > 0) {
  console.log('[' + new Date().toISOString() + '] Evicted ' + result.removed + ' items. Size: ' + before.size_mb + 'MB -> ' + result.size_mb_after + 'MB');
}
"
