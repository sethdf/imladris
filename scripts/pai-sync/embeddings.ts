// ============================================================
// embeddings.ts — Local embedding generation via pgml
// Uses intfloat/e5-large-v2 (384-dim) running inside Postgres.
// Zero external dependencies — no API calls, no network.
//
// Called by daemon on a schedule (every 60s) and by CLI on demand.
// ============================================================

import pg from "pg";

const EMBEDDING_MODEL = "intfloat/e5-large-v2";
const EMBEDDING_DIMENSIONS = 1024;
const BATCH_SIZE = 20;

// Content types that should be embedded — match any key prefix
const EMBEDDABLE_TYPES: Record<string, string> = {
  "LEARNING/": "learning",
  "WORK/": "prd",
  "WISDOM/": "wisdom",
  "RESEARCH/": "research",
  "SECURITY/": "security",
  "ARCHIVE-FROM-OLD/RESEARCH/": "research",
  "ARCHIVE-FROM-OLD/": "archive",
  "PAISYSTEMUPDATES/": "system",
  "RELATIONSHIP/": "relationship",
};

// Keys that should NOT be embedded
const SKIP_PATTERNS = [
  /\.jsonl$/,
  /\/tasks\//,
  /\/subagents\//,
  /MEMORY\.md$/,
  /README\.md$/,
];

function classifySourceType(key: string): string | null {
  for (const pat of SKIP_PATTERNS) {
    if (pat.test(key)) return null;
  }
  const sorted = Object.entries(EMBEDDABLE_TYPES).sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, type] of sorted) {
    if (key.startsWith(prefix)) return type;
  }
  return null;
}

export async function processUnembedded(pool: pg.Pool): Promise<{
  processed: number;
  skipped: number;
  errors: number;
}> {
  let processed = 0, skipped = 0, errors = 0;

  const { rows } = await pool.query(`
    SELECT mo.key, mo.content, mo.metadata
    FROM core.memory_objects mo
    LEFT JOIN core.memory_vectors mv ON mo.key = mv.source_key
    WHERE mv.source_key IS NULL
      AND mo.deleted = FALSE
      AND mo.content IS NOT NULL
      AND length(mo.content) > 50
    ORDER BY mo.updated_at DESC
    LIMIT $1
  `, [BATCH_SIZE]);

  for (const row of rows) {
    const sourceType = classifySourceType(row.key);
    if (!sourceType) {
      skipped++;
      continue;
    }

    try {
      const textToEmbed = buildEmbeddingText(row.key, row.content, row.metadata);
      // Truncate to ~8000 chars for the model
      const truncated = textToEmbed.slice(0, 8000);

      // Generate embedding locally via pgml — single SQL call, no network
      const { rows: embedRows } = await pool.query(`
        INSERT INTO core.memory_vectors (source_key, source_type, embedding, chunk_text, model)
        VALUES (
          $1, $2,
          pgml.embed($3, $4)::vector(1024),
          $5, $3
        )
        ON CONFLICT (source_key) DO UPDATE SET
          embedding = EXCLUDED.embedding,
          chunk_text = EXCLUDED.chunk_text,
          created_at = NOW()
        RETURNING source_key
      `, [row.key, sourceType, EMBEDDING_MODEL, truncated, truncated.slice(0, 2000)]);

      processed++;
    } catch (err) {
      console.error(`[embeddings] error embedding ${row.key}: ${err}`);
      errors++;
    }
  }

  return { processed, skipped, errors };
}

function buildEmbeddingText(key: string, content: string, metadata: any): string {
  const parts: string[] = [];
  parts.push(`File: ${key}`);

  if (metadata) {
    const m = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
    if (m.domain) parts.push(`Domain: ${m.domain}`);
    if (m.confidence) parts.push(`Confidence: ${m.confidence}`);
    if (m.source_model) parts.push(`Source: ${m.source_model}`);
  }

  parts.push(content);
  return parts.join("\n");
}

// Export for CLI search command
export async function generateQueryEmbedding(pool: pg.Pool, text: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT pgml.embed($1, $2)::vector(1024)::text as vec`,
    [EMBEDDING_MODEL, text.slice(0, 8000)]
  );
  return rows[0].vec;
}

export { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, classifySourceType };
