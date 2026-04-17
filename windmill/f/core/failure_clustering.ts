// Windmill Script: Failure Clustering (v0.1-draft)
//
// Groups similar failure patterns from core.memory_vectors (source_type='learning')
// using cosine similarity. Clusters failures that share >0.85 similarity and writes
// a summary memory_object with cluster descriptions.
//
// Uses pg (node-postgres) parameterized queries against the PAI Postgres database.
// Runs on the NATIVE worker group. Scheduled daily at 08:00 Denver.

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

interface VectorRow {
  source_key: string;
  chunk_text: string;
  embedding: string;
  created_at: string;
}

interface Cluster {
  id: number;
  members: string[];
  representative_text: string;
  size: number;
  earliest: string;
  latest: string;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function parseEmbedding(raw: string): number[] {
  // pgvector returns '[0.1,0.2,...]' format
  return JSON.parse(raw.replace(/^\[/, "[").replace(/\]$/, "]"));
}

export async function main(
  similarity_threshold: number = 0.85,
  lookback_days: number = 30,
  max_vectors: number = 500
) {
  const client = await connectPai();

  const startedAt = new Date().toISOString();
  const cutoff = new Date(Date.now() - lookback_days * 86400000).toISOString();

  // Fetch learning-type vectors with embeddings
  const result = await client.query(
    `SELECT source_key, chunk_text, embedding::text, created_at::text
    FROM core.memory_vectors
    WHERE source_type = 'learning'
      AND created_at >= $1
      AND embedding IS NOT NULL
    ORDER BY created_at DESC
    LIMIT $2`,
    [cutoff, max_vectors]
  );
  const rows: VectorRow[] = result.rows;

  if (rows.length === 0) {
    await client.end();
    return { status: "skipped", reason: "no learning vectors found", started_at: startedAt };
  }

  // Parse embeddings
  const parsed = rows.map((r) => ({
    ...r,
    vec: parseEmbedding(r.embedding),
  }));

  // Greedy single-linkage clustering
  const assigned = new Set<number>();
  const clusters: Cluster[] = [];
  let clusterId = 0;

  for (let i = 0; i < parsed.length; i++) {
    if (assigned.has(i)) continue;
    const members = [i];
    assigned.add(i);

    for (let j = i + 1; j < parsed.length; j++) {
      if (assigned.has(j)) continue;
      const sim = cosineSimilarity(parsed[i].vec, parsed[j].vec);
      if (sim >= similarity_threshold) {
        members.push(j);
        assigned.add(j);
      }
    }

    if (members.length >= 2) {
      const timestamps = members.map((m) => parsed[m].created_at).sort();
      clusters.push({
        id: clusterId++,
        members: members.map((m) => parsed[m].source_key),
        representative_text: parsed[members[0]].chunk_text.slice(0, 500),
        size: members.length,
        earliest: timestamps[0],
        latest: timestamps[timestamps.length - 1],
      });
    }
  }

  // Write summary as a memory_object
  const summaryKey = `MEMORY/SYNTHESIS/failure_clusters_${startedAt.slice(0, 10)}`;
  const summaryContent = JSON.stringify({
    generated_at: startedAt,
    lookback_days,
    similarity_threshold,
    vectors_analyzed: parsed.length,
    clusters_found: clusters.length,
    clusters: clusters.slice(0, 50),
  }, null, 2);

  const contentHash = Bun.hash(summaryContent).toString(16);

  await client.query(
    `INSERT INTO core.memory_objects (key, content, metadata, content_hash, compressed, chunk_index, chunk_total, source, version, created_at, updated_at, deleted)
    VALUES (
      $1, $2, $3::jsonb, $4, false, 0, 1, 'f/core/failure_clustering', 1, NOW(), NOW(), false
    )
    ON CONFLICT (key) DO UPDATE SET
      content = EXCLUDED.content,
      content_hash = EXCLUDED.content_hash,
      metadata = EXCLUDED.metadata,
      version = core.memory_objects.version + 1,
      updated_at = NOW()`,
    [summaryKey, summaryContent, JSON.stringify({ type: "failure_clustering", version: "0.1-draft" }), contentHash]
  );

  await client.end();

  return {
    status: "success",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    vectors_analyzed: parsed.length,
    clusters_found: clusters.length,
    largest_cluster: clusters.length > 0 ? Math.max(...clusters.map((c) => c.size)) : 0,
    summary_key: summaryKey,
  };
}
