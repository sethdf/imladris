// ============================================================
// embeddings.ts — Bedrock Titan embedding generation
// Processes unembedded memory_objects, generates vectors,
// stores in core.memory_vectors.
//
// Called by daemon on a schedule (every 60s) and by CLI on demand.
// ============================================================

import pg from "pg";
import * as fs from "fs";

const BEDROCK_MODEL = "amazon.titan-embed-text-v2:0";
const EMBEDDING_DIMENSIONS = 1024;
const BATCH_SIZE = 20; // process N objects per cycle
const MAX_TEXT_LENGTH = 8000; // Titan v2 limit is ~8k tokens

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
  "VOICE/": "voice",
};

// Keys that should NOT be embedded (too noisy or structural)
const SKIP_PATTERNS = [
  /\.jsonl$/,        // JSONL files are line-synced, not embedded as whole files
  /\/tasks\//,       // Task subagent output (too verbose)
  /\/subagents\//,   // Subagent artifacts
  /MEMORY\.md$/,     // Index file, not content
  /README\.md$/,     // Structural, not knowledge
];

function classifySourceType(key: string): string | null {
  // Check skip patterns first
  for (const pat of SKIP_PATTERNS) {
    if (pat.test(key)) return null;
  }
  // Match longest prefix first (ARCHIVE-FROM-OLD/RESEARCH/ before ARCHIVE-FROM-OLD/)
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

  // Use temp file for outfile — aws CLI requires a file path, not stdout
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

  // Find memory_objects that don't have embeddings yet
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
  // Build a rich text representation for embedding quality
  const parts: string[] = [];

  // Add key as context (e.g., "LEARNING/SYSTEM/2026-03/...")
  parts.push(`File: ${key}`);

  // Add metadata fields if present
  if (metadata) {
    const m = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
    if (m.domain) parts.push(`Domain: ${m.domain}`);
    if (m.confidence) parts.push(`Confidence: ${m.confidence}`);
    if (m.source_model) parts.push(`Source: ${m.source_model}`);
  }

  // Add content (the main text)
  parts.push(content);

  return parts.join("\n").slice(0, MAX_TEXT_LENGTH);
}

export { generateEmbedding, classifySourceType, BEDROCK_MODEL, EMBEDDING_DIMENSIONS };
