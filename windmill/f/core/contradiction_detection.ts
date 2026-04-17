// Windmill Script: Contradiction Detection (v0.1-draft)
//
// Finds memory_objects with conflicting content: same key prefix, different
// content_hash, overlapping time windows. Reports contradictions as a summary
// memory_object for human review.
//
// Uses pg (node-postgres) parameterized queries against the PAI Postgres database.
// Runs on the NATIVE worker group. Scheduled daily at 09:00 Denver.

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

interface MemoryRow {
  key: string;
  content: string;
  content_hash: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted: boolean;
  source: string | null;
}

interface Contradiction {
  key_prefix: string;
  objects: Array<{
    key: string;
    content_hash: string;
    version: number;
    updated_at: string;
    content_preview: string;
  }>;
  reason: string;
}

function keyPrefix(key: string, depth: number = 3): string {
  return key.split("/").slice(0, depth).join("/");
}

function contentOverview(content: string, maxLen: number = 200): string {
  const clean = content.replace(/\s+/g, " ").trim();
  return clean.length > maxLen ? clean.slice(0, maxLen) + "..." : clean;
}

export async function main(
  lookback_days: number = 14,
  prefix_depth: number = 3,
  min_group_size: number = 2
) {
  const client = await connectPai();

  const startedAt = new Date().toISOString();
  const cutoff = new Date(Date.now() - lookback_days * 86400000).toISOString();

  // Fetch active memory objects updated within the lookback window
  const result = await client.query(
    `SELECT key, content, content_hash, version,
           created_at::text, updated_at::text, deleted, source
    FROM core.memory_objects
    WHERE deleted = false
      AND updated_at >= $1
    ORDER BY key`,
    [cutoff]
  );
  const rows: MemoryRow[] = result.rows;

  if (rows.length === 0) {
    await client.end();
    return { status: "skipped", reason: "no recent memory objects", started_at: startedAt };
  }

  // Group by key prefix
  const groups = new Map<string, MemoryRow[]>();
  for (const row of rows) {
    const prefix = keyPrefix(row.key, prefix_depth);
    const list = groups.get(prefix) || [];
    list.push(row);
    groups.set(prefix, list);
  }

  const contradictions: Contradiction[] = [];

  for (const [prefix, members] of groups) {
    if (members.length < min_group_size) continue;

    // Check for different content_hashes within the same prefix
    const uniqueHashes = new Set(members.map((m) => m.content_hash));
    if (uniqueHashes.size <= 1) continue;

    // Check for temporal overlap: any two objects updated within 24h of each other
    const sorted = [...members].sort(
      (a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
    );

    let hasOverlap = false;
    for (let i = 0; i < sorted.length - 1; i++) {
      const gap =
        new Date(sorted[i + 1].updated_at).getTime() -
        new Date(sorted[i].updated_at).getTime();
      if (gap < 86400000) {
        hasOverlap = true;
        break;
      }
    }

    if (!hasOverlap && uniqueHashes.size > 1) {
      // Still a contradiction if different hashes exist regardless of timing
      contradictions.push({
        key_prefix: prefix,
        objects: members.map((m) => ({
          key: m.key,
          content_hash: m.content_hash,
          version: m.version,
          updated_at: m.updated_at,
          content_preview: contentOverview(m.content),
        })),
        reason: "different content_hash under same prefix",
      });
    } else if (hasOverlap) {
      contradictions.push({
        key_prefix: prefix,
        objects: members.map((m) => ({
          key: m.key,
          content_hash: m.content_hash,
          version: m.version,
          updated_at: m.updated_at,
          content_preview: contentOverview(m.content),
        })),
        reason: "different content_hash with temporal overlap (<24h)",
      });
    }
  }

  // Write contradictions summary as a memory_object
  const summaryKey = `MEMORY/SYNTHESIS/contradictions_${startedAt.slice(0, 10)}`;
  const summaryContent = JSON.stringify({
    generated_at: startedAt,
    lookback_days,
    objects_analyzed: rows.length,
    prefix_groups: groups.size,
    contradictions_found: contradictions.length,
    contradictions: contradictions.slice(0, 50),
  }, null, 2);

  const contentHash = Bun.hash(summaryContent).toString(16);

  await client.query(
    `INSERT INTO core.memory_objects (key, content, metadata, content_hash, compressed, chunk_index, chunk_total, source, version, created_at, updated_at, deleted)
    VALUES (
      $1, $2, $3::jsonb, $4, false, 0, 1, 'f/core/contradiction_detection', 1, NOW(), NOW(), false
    )
    ON CONFLICT (key) DO UPDATE SET
      content = EXCLUDED.content,
      content_hash = EXCLUDED.content_hash,
      metadata = EXCLUDED.metadata,
      version = core.memory_objects.version + 1,
      updated_at = NOW()`,
    [summaryKey, summaryContent, JSON.stringify({ type: "contradiction_detection", version: "0.1-draft" }), contentHash]
  );

  await client.end();

  return {
    status: "success",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    objects_analyzed: rows.length,
    prefix_groups_checked: groups.size,
    contradictions_found: contradictions.length,
    summary_key: summaryKey,
  };
}
