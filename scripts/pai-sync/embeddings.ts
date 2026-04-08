// ============================================================
// embeddings.ts — Bedrock Titan Embed v2 embedding generation
// Uses AWS Bedrock (same account as imladris) for fast embedding.
// Embeddings stored locally in Postgres via pgvector — search is local.
//
// Called by daemon on a schedule and by CLI on demand.
// ============================================================

import pg from "pg";
import * as fs from "fs";

const BEDROCK_MODEL = "amazon.titan-embed-text-v2:0";
const EMBEDDING_DIMENSIONS = 1024;
const BATCH_SIZE = parseInt(process.env.PAI_EMBED_BATCH_SIZE ?? "20");
const MAX_TEXT_LENGTH = 8000;

// Content types that should be embedded
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

async function generateEmbedding(text: string): Promise<number[]> {
  const truncated = text.slice(0, MAX_TEXT_LENGTH);
  const body = JSON.stringify({
    inputText: truncated,
    dimensions: EMBEDDING_DIMENSIONS,
  });

  const tmpFile = `/tmp/pai-embed-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;

  const proc = Bun.spawn([
    "aws", "bedrock-runtime", "invoke-model",
    "--model-id", BEDROCK_MODEL,
    "--body", Buffer.from(body).toString("base64"),
    "--content-type", "application/json",
    "--accept", "application/json",
    "--region", "us-east-1",
    tmpFile,
  ], { stdout: "pipe", stderr: "pipe" });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    try { fs.unlinkSync(tmpFile); } catch {}
    throw new Error(`Bedrock call failed (exit ${exitCode}): ${stderr}`);
  }

  try {
    const result = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
    return result.embedding;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
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
      const embedding = await generateEmbedding(textToEmbed);
      const pgVector = `[${embedding.join(",")}]`;

      await pool.query(`
        INSERT INTO core.memory_vectors (source_key, source_type, embedding, chunk_text, model)
        VALUES ($1, $2, $3::vector, $4, $5)
        ON CONFLICT (source_key) DO UPDATE SET
          embedding = EXCLUDED.embedding,
          chunk_text = EXCLUDED.chunk_text,
          created_at = NOW()
      `, [row.key, sourceType, pgVector, textToEmbed.slice(0, 2000), BEDROCK_MODEL]);

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
  return parts.join("\n").slice(0, MAX_TEXT_LENGTH);
}

// For CLI search — embed query via Titan too
export async function generateQueryEmbedding(pool: pg.Pool, text: string): Promise<string> {
  const embedding = await generateEmbedding(text);
  return `[${embedding.join(",")}]`;
}

export { BEDROCK_MODEL, EMBEDDING_DIMENSIONS, classifySourceType };
