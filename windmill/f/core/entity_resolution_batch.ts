// Windmill Script: Entity Resolution Batch (v0.1-draft)
//
// Deduplicates entities across shared/work/personal schemas by matching
// entity_id and display_name similarity. Merges duplicates into
// shared.entities_global by updating source_domains and metadata.
//
// Uses pg (node-postgres) parameterized queries against the PAI Postgres database.
// Runs on the NATIVE worker group. Scheduled weekly Monday 07:00 Denver.

// pg (node-postgres) client initialized inside main()

async function getVariable(path: string): Promise<string | undefined> {
  const base = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
  const token = process.env.WM_TOKEN;
  const workspace = process.env.WM_WORKSPACE || "imladris";
  if (!token) return undefined;
  try {
    const resp = await fetch(`${base}/api/w/${workspace}/variables/get_value/${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return undefined;
    const val = await resp.text();
    return (val.startsWith('"') ? JSON.parse(val) : val).trim();
  } catch { return undefined; }
}

async function connectPai() {
  const { Client } = (await import("pg")) as any;
  const password = await getVariable("f/core/pai_db_password");
  const client = new Client({ host: "windmill_db", port: 5432, database: "pai", user: "postgres", password: password || "" });
  await client.connect();
  return client;
}

interface EntityRow {
  schema_name: string;
  entity_type: string;
  entity_id: string;
  display_name: string;
  source_domains: string[];
  metadata: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
  instance_id: string | null;
}

interface MergeAction {
  canonical_id: string;
  canonical_type: string;
  merged_from: string[];
  display_name: string;
  combined_domains: string[];
  earliest_seen: string;
  latest_seen: string;
}

function normalizeForComparison(s: string): string {
  return s.toLowerCase().replace(/[\s\-_\.]+/g, "").trim();
}

function displayNameSimilarity(a: string, b: string): number {
  const na = normalizeForComparison(a);
  const nb = normalizeForComparison(b);
  if (na === nb) return 1.0;
  // Simple Dice coefficient on bigrams
  if (na.length < 2 || nb.length < 2) return 0;
  const bigramsA = new Set<string>();
  for (let i = 0; i < na.length - 1; i++) bigramsA.add(na.slice(i, i + 2));
  const bigramsB = new Set<string>();
  for (let i = 0; i < nb.length - 1; i++) bigramsB.add(nb.slice(i, i + 2));
  let intersection = 0;
  for (const b of bigramsA) if (bigramsB.has(b)) intersection++;
  return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

export async function main(
  name_similarity_threshold: number = 0.8,
  dry_run: boolean = true
) {
  const client = await connectPai();

  const startedAt = new Date().toISOString();

  // Pull entities from all three schemas
  const allEntities: EntityRow[] = [];
  for (const schema of ["shared", "work", "personal"] as const) {
    const table =
      schema === "shared" ? "shared.entities_global" :
      schema === "work" ? "work.entities_work" :
      "personal.entities_personal";

    // shared.entities_global has source_domains + instance_id; work/personal don't
    const extraCols = schema === "shared" ? "source_domains, " : "ARRAY[]::text[] AS source_domains, ";
    const idCol = schema === "shared" ? "instance_id" : "NULL AS instance_id";
    const result = await client.query(
      `SELECT
        '${schema}' AS schema_name,
        entity_type, entity_id, display_name,
        ${extraCols}metadata,
        first_seen_at::text, last_seen_at::text, ${idCol}
      FROM ${table}
      ORDER BY entity_type, entity_id`
    );
    allEntities.push(...result.rows);
  }

  if (allEntities.length === 0) {
    await client.end();
    return { status: "skipped", reason: "no entities found", started_at: startedAt };
  }

  // Group by entity_type for intra-type dedup
  const byType = new Map<string, EntityRow[]>();
  for (const e of allEntities) {
    const list = byType.get(e.entity_type) || [];
    list.push(e);
    byType.set(e.entity_type, list);
  }

  const mergeActions: MergeAction[] = [];

  for (const [entityType, entities] of byType) {
    const assigned = new Set<number>();

    for (let i = 0; i < entities.length; i++) {
      if (assigned.has(i)) continue;
      const group = [i];
      assigned.add(i);

      for (let j = i + 1; j < entities.length; j++) {
        if (assigned.has(j)) continue;
        const idMatch = entities[i].entity_id === entities[j].entity_id;
        const nameSim = displayNameSimilarity(
          entities[i].display_name,
          entities[j].display_name
        );
        if (idMatch || nameSim >= name_similarity_threshold) {
          group.push(j);
          assigned.add(j);
        }
      }

      if (group.length >= 2) {
        const members = group.map((idx) => entities[idx]);
        const allDomains = [...new Set(members.flatMap((m) => m.source_domains || []))];
        const timestamps = members.map((m) => m.first_seen_at).sort();

        mergeActions.push({
          canonical_id: members[0].entity_id,
          canonical_type: entityType,
          merged_from: members.map((m) => `${m.schema_name}:${m.entity_id}`),
          display_name: members[0].display_name,
          combined_domains: allDomains,
          earliest_seen: timestamps[0],
          latest_seen: members.map((m) => m.last_seen_at).sort().pop()!,
        });
      }
    }
  }

  let mergedCount = 0;

  if (!dry_run && mergeActions.length > 0) {
    for (const action of mergeActions) {
      await client.query(
        `INSERT INTO shared.entities_global (entity_type, entity_id, display_name, source_domains, metadata, first_seen_at, last_seen_at)
        VALUES (
          $1, $2, $3, $4::text[], $5::jsonb, $6::timestamptz, $7::timestamptz
        )
        ON CONFLICT (entity_type, entity_id) DO UPDATE SET
          source_domains = EXCLUDED.source_domains,
          metadata = shared.entities_global.metadata || EXCLUDED.metadata,
          last_seen_at = GREATEST(shared.entities_global.last_seen_at, EXCLUDED.last_seen_at)`,
        [
          action.canonical_type,
          action.canonical_id,
          action.display_name,
          action.combined_domains,
          JSON.stringify({ merged_from: action.merged_from, merge_date: startedAt }),
          action.earliest_seen,
          action.latest_seen,
        ]
      );
      mergedCount++;
    }
  }

  await client.end();

  return {
    status: "success",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    total_entities_scanned: allEntities.length,
    duplicate_groups_found: mergeActions.length,
    merges_applied: mergedCount,
    dry_run,
    actions: dry_run ? mergeActions.slice(0, 20) : undefined,
  };
}
