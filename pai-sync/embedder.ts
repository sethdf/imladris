/**
 * PAI Memory Sync — Embedder
 *
 * Generates vector embeddings via pgml.embed() in-DB.
 * Model: intfloat/e5-small-v2 (384 dims, fast, multilingual-capable)
 * No external API calls — embeddings run entirely inside PostgreSQL.
 *
 * Source type inference from key path:
 *   MEMORY/LEARNING/FAILURES/ → failure
 *   MEMORY/LEARNING/           → learning
 *   MEMORY/WORK/               → prd
 *   WISDOM/                    → wisdom_frame
 *   skills/                    → skill
 */

import type { Pool } from 'pg';

export const PGML_MODEL   = 'intfloat/e5-small-v2';
export const EMBED_DIMS   = 384;
const CHUNK_SIZE    = 8000;   // chars — embed as single chunk if ≤ this
const CHUNK_OVERLAP = 200;    // chars overlap between chunks

// Paths that are worth embedding (text-semantic content)
const EMBEDDABLE_PREFIXES = [
  'MEMORY/LEARNING/',
  'MEMORY/WORK/',
  'WISDOM/',
  'skills/',
];
const EMBEDDABLE_EXTENSIONS = ['.md', '.txt', '.ts'];

export function shouldEmbed(key: string): boolean {
  const lower = key.toLowerCase();
  const hasPrefix = EMBEDDABLE_PREFIXES.some(p => key.startsWith(p));
  if (!hasPrefix) return false;
  const hasExt = EMBEDDABLE_EXTENSIONS.some(e => lower.endsWith(e));
  if (!hasExt) return false;
  if (key.includes('node_modules')) return false;
  if (key.includes('sync-wal') || key.includes('sync-log')) return false;
  return true;
}

export function inferSourceType(key: string): string {
  if (key.startsWith('MEMORY/LEARNING/FAILURES/')) return 'failure';
  if (key.startsWith('MEMORY/LEARNING/'))           return 'learning';
  if (key.startsWith('MEMORY/WORK/'))               return 'prd';
  if (key.startsWith('WISDOM/'))                    return 'wisdom_frame';
  if (key.startsWith('skills/'))                    return 'skill';
  return 'other';
}

export function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

export interface EmbedResult {
  sourceKey: string;
  chunksWritten: number;
  skipped: boolean;
}

/**
 * Embed a single object and upsert all chunks into memory_vectors.
 * Uses pgml.embed() — the model runs entirely inside PostgreSQL.
 */
export async function embedObject(
  pool: Pool,
  key: string,
  content: string,
  dryRun = false
): Promise<EmbedResult> {
  const sourceType = inferSourceType(key);
  const chunks = chunkText(content);

  if (dryRun) {
    return { sourceKey: key, chunksWritten: chunks.length, skipped: false };
  }

  let written = 0;
  for (let i = 0; i < chunks.length; i++) {
    await pool.query(
      `INSERT INTO memory_vectors (source_key, chunk_index, source_type, chunk_text, embedding, updated_at)
       VALUES ($1, $2, $3, $4, pgml.embed($5, $4)::vector, NOW())
       ON CONFLICT (source_key, chunk_index) DO UPDATE SET
         chunk_text = EXCLUDED.chunk_text,
         embedding  = EXCLUDED.embedding,
         updated_at = NOW()`,
      [key, i, sourceType, chunks[i], PGML_MODEL]
    );
    written++;
  }

  return { sourceKey: key, chunksWritten: written, skipped: false };
}

/**
 * Embed a query string for search. Returns the vector as a Postgres-compatible
 * string '[x,y,z,...]' for use in WHERE/ORDER BY clauses.
 */
export async function embedQuery(pool: Pool, queryText: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT pgml.embed($1, $2)::vector::text AS vec`,
    [PGML_MODEL, queryText.slice(0, CHUNK_SIZE)]
  );
  return rows[0].vec as string;
}
