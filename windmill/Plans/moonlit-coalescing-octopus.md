# Auto-Discovery Resource Lookup Table

## Context

The investigation pipeline's entity extraction relies on regex patterns (EC2 IDs like `i-xxxx`, ARNs, etc.) to identify AWS resources. This misses resources referenced by friendly names — "DailyLionsCluster", "Alteryx-AM", "prd-buxton-nexus-alteryx-10-6-wiz". These names exist in AWS as tags, cluster names, queue names, etc. but the regex can't know them.

**Solution:** A `resource_inventory` table in the SQLite cache, auto-populated by a scheduled discovery script that queries Steampipe for all named resources. During investigation, entity extraction checks unmatched text tokens against this table via fuzzy lookup. "DailyLionsCluster" resolves to EMR cluster → probes run → substantial findings.

**Current constraint:** Steampipe connects to account `767448074758` (BuxtonIT/Imladris). Production Buxton resources live in other account(s). Discovery will find what's accessible now and automatically expand when cross-account access is configured in `~/.steampipe/config/aws.spc`.

## Files to Modify

1. **`f/devops/cache_lib.ts`** — Add `resource_inventory` table schema + lookup functions
2. **NEW: `f/devops/discover_resources.ts`** — Scheduled discovery script
3. **NEW: `f/devops/discover_resources.script.yaml`** — Windmill metadata
4. **`f/devops/investigate.ts`** — Integrate resource lookup into entity extraction

## Plan

### 1. Schema (`cache_lib.ts`)

Add `resource_inventory` table in `init()`:

```sql
CREATE TABLE IF NOT EXISTS resource_inventory (
  resource_id TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  resource_type TEXT NOT NULL,   -- ec2_instance, emr_cluster, sqs_queue, etc.
  cloud TEXT NOT NULL DEFAULT 'aws',
  account_id TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',  -- running, terminated, active, etc.
  metadata TEXT DEFAULT '{}',     -- JSON blob of extra attributes
  discovered_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  is_stale INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (cloud, resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_resource_inv_name ON resource_inventory(resource_name);
CREATE INDEX IF NOT EXISTS idx_resource_inv_type ON resource_inventory(resource_type);
CREATE INDEX IF NOT EXISTS idx_resource_inv_stale ON resource_inventory(is_stale);
```

Also add a `name_tokens` column — lowercased, hyphen/underscore-split tokens for fuzzy matching:
```sql
ALTER TABLE resource_inventory ADD COLUMN name_tokens TEXT DEFAULT '';
-- e.g., "DailyLionsCluster" → "dailylionscluster daily lions cluster"
-- e.g., "prd-buxton-nexus-alteryx-10-6-wiz" → "prd buxton nexus alteryx 10 6 wiz"
```

### 2. Cache Functions (`cache_lib.ts`)

- **`upsertResource(resource)`** — Insert or update. Sets `last_seen_at = now`, `is_stale = 0`. Generates `name_tokens` from resource_name.
- **`markStaleResources(olderThanSeconds)`** — Set `is_stale = 1` WHERE `last_seen_at < cutoff AND is_stale = 0`.
- **`lookupResourceByName(text, limit?)`** — The key function. Strategy:
  1. Extract candidate tokens from text (words ≥ 3 chars, alphanumeric, not stop words)
  2. Query: `SELECT * FROM resource_inventory WHERE is_stale = 0 AND (resource_name = :token OR name_tokens LIKE '%' || :token || '%')` for each candidate
  3. Returns matched resources with their IDs and types
  4. Also try: `SELECT * FROM resource_inventory WHERE is_stale = 0 AND :fulltext LIKE '%' || resource_name || '%'` — catches cases where the resource name appears as a substring in the alert
- **`resourceInventoryStats()`** — Count by type, cloud, stale count.

### 3. Discovery Script (`discover_resources.ts`)

Queries Steampipe for named resources across all available AWS services. Runs on native worker (needs Steampipe access at 172.17.0.1:9193).

**Discovery queries (all SELECT, read-only):**

| Resource Type | Table | Name Source | ID |
|--|--|--|--|
| `ec2_instance` | `aws_ec2_instance` | `tags->>'Name'` | `instance_id` |
| `emr_cluster` | `aws_emr_cluster` | `name` | `id` |
| `rds_instance` | `aws_rds_db_instance` | `db_instance_identifier` | `arn` |
| `rds_cluster` | `aws_rds_db_cluster` | `db_cluster_identifier` | `arn` |
| `sqs_queue` | `aws_sqs_queue` | extract name from `queue_url` | `queue_url` |
| `sns_topic` | `aws_sns_topic` | extract name from `topic_arn` | `topic_arn` |
| `lambda_function` | `aws_lambda_function` | `name` | `arn` |
| `ecs_cluster` | `aws_ecs_cluster` | `cluster_name` | `cluster_arn` |
| `ecs_service` | `aws_ecs_service` | `service_name` | `service_arn` |
| `s3_bucket` | `aws_s3_bucket` | `name` | `name` |
| `cloudwatch_alarm` | `aws_cloudwatch_alarm` | `name` | `arn` |
| `elb` | `aws_ec2_load_balancer_listener` or `aws_ec2_application_load_balancer` | `name` | `arn` |

Each query returns (name, id, type, region, state, account_id). Discovery script calls `upsertResource()` for each result, then `markStaleResources()` at the end.

**Parameters:**
- `stale_after_hours` (default: 48) — mark resources not seen for this long as stale
- `resource_types` (default: "" = all) — comma-separated filter if you want to discover specific types only

**Return value:**
```json
{
  "account_id": "767448074758",
  "resources_discovered": 42,
  "by_type": { "ec2_instance": 2, "sqs_queue": 5, ... },
  "stale_marked": 3,
  "errors": [],
  "duration_s": 12
}
```

### 4. Investigate Integration (`investigate.ts`)

After existing regex patterns run, if entities are sparse, do a resource lookup:

```typescript
// After regex extraction, if we found few entities, try resource inventory lookup
if (entities.length < 3) {
  try {
    const { lookupResourceByName, isAvailable, init } = await import("./cache_lib.ts");
    if (isAvailable()) {
      init();
      const inventoryMatches = lookupResourceByName(content);
      for (const match of inventoryMatches) {
        const key = `${match.resource_type}:${match.resource_id.toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          entities.push({ value: match.resource_id, type: match.resource_type });
        }
      }
    }
  } catch { /* non-fatal — inventory lookup is best-effort */ }
}
```

This is non-invasive: it runs AFTER existing patterns, only when entities are sparse, and failures are non-fatal.

### 5. Token Generation

The `name_tokens` column enables fuzzy matching. Generation logic:

```typescript
function generateNameTokens(name: string): string {
  // Split on common delimiters: hyphens, underscores, dots, camelCase boundaries
  const tokens = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase split
    .replace(/[-_./]/g, ' ')               // delimiter split
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length >= 2);
  // Include the full lowercased name too
  return [name.toLowerCase(), ...tokens].join(' ');
}
// "DailyLionsCluster" → "dailylionscluster daily lions cluster"
// "prd-buxton-nexus-alteryx-10-6-wiz" → "prd-buxton-nexus-alteryx-10-6-wiz prd buxton nexus alteryx 10 6 wiz"
```

### 6. Schedule

- Run every 6 hours via Windmill cron: `0 */6 * * *`
- First run: manual trigger after deployment to populate initial inventory
- Lightweight: each query takes 2-5 seconds. Full discovery < 30 seconds.

## Cross-Account Awareness

Discovery documents what it found. When cross-account access is later configured:
1. Add aggregator connections in `~/.steampipe/config/aws.spc`
2. Discovery automatically discovers resources from all connected accounts
3. `account_id` column tracks which account each resource belongs to
4. No code changes needed — queries naturally span all connections

## Verification

1. `wmill sync push` — deploy
2. Restart workers
3. Run `discover_resources` manually — should find 2 EC2 instances (Imladris)
4. Check resource_inventory: `steampipe query "SELECT count(*) FROM resource_inventory"` (via cache_lib query)
5. Run `investigate.ts` on "Imladris is Down" — should now resolve "Imladris" via lookup table
6. Run `process_actionable dry_run=true` — items should show better entity extraction
7. Set up schedule: every 6 hours
