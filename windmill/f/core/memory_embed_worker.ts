// Windmill Script: PAI Memory Embed Worker
//
// Receives a batch of memory_object keys, opens ONE persistent DB connection,
// warms up the pgml model (first call loads it into the backend process),
// then embeds all objects at ~100ms/call instead of ~6s/call.
//
// This is the key design: one Client per worker, not one per query.

const PGML_MODEL = "intfloat/e5-small-v2";
const CHUNK_SIZE = 8000;    // chars — embed as single chunk if ≤ this
const CHUNK_OVERLAP = 200;  // chars overlap between chunks

function inferSourceType(key: string): string {
  if (key.startsWith("MEMORY/LEARNING/FAILURES/")) return "failure";
  if (key.startsWith("MEMORY/LEARNING/"))           return "learning";
  if (key.startsWith("MEMORY/WORK/"))               return "prd";
  if (key.startsWith("WISDOM/"))                    return "wisdom_frame";
  if (key.startsWith("skills/"))                    return "skill";
  return "other";
}

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, Math.min(start + CHUNK_SIZE, text.length)));
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

export async function main(
  keys: string[],
  batch_index: number = 0,
  dry_run: boolean = false
) {
  const { Client } = (await import("pg")) as any;

  const dbUrl = new URL(process.env.DATABASE_URL!);
  dbUrl.pathname = "/pai_memory";

  // Single client — holds one PG backend process with cached model
  const client = new Client({ connectionString: dbUrl.toString() });
  await client.connect();

  let embedded = 0;
  let failed = 0;
  let chunksTotal = 0;
  const errors: string[] = [];

  try {
    if (dry_run) {
      console.log(
        `[worker ${batch_index}] DRY RUN — would process ${keys.length} objects`
      );
      return { batch_index, embedded: 0, failed: 0, chunks_total: 0, dry_run: true };
    }

    // Warm-up: first pgml.embed() call in a fresh connection loads the model (~6s).
    // All subsequent calls in this same connection use the cached model (~100ms).
    console.log(`[worker ${batch_index}] Loading model...`);
    const warmStart = Date.now();
    await client.query(`SELECT pgml.embed($1, 'warmup') IS NOT NULL AS ok`, [
      PGML_MODEL,
    ]);
    console.log(
      `[worker ${batch_index}] Model ready (${Date.now() - warmStart}ms). Processing ${keys.length} objects...`
    );

    const batchStart = Date.now();

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      try {
        // Fetch current content
        const { rows } = await client.query(
          `SELECT content FROM memory_objects WHERE key = $1 AND deleted = FALSE`,
          [key]
        );
        if (!rows[0]?.content) {
          failed++;
          continue;
        }

        const content = rows[0].content as string;
        const sourceType = inferSourceType(key);
        const chunks = chunkText(content);

        // Embed each chunk — pgml.embed() runs inside PG, model is warm
        for (let ci = 0; ci < chunks.length; ci++) {
          await client.query(
            `INSERT INTO memory_vectors
               (source_key, chunk_index, source_type, chunk_text, embedding, updated_at)
             VALUES ($1, $2, $3, $4, pgml.embed($5, $4)::vector, NOW())
             ON CONFLICT (source_key, chunk_index) DO UPDATE SET
               chunk_text = EXCLUDED.chunk_text,
               embedding  = EXCLUDED.embedding,
               updated_at = NOW()`,
            [key, ci, sourceType, chunks[ci], PGML_MODEL]
          );
          chunksTotal++;
        }

        // Remove stale extra chunks if file got shorter since last embed
        if (chunks.length > 0) {
          await client.query(
            `DELETE FROM memory_vectors WHERE source_key = $1 AND chunk_index >= $2`,
            [key, chunks.length]
          );
        }

        embedded++;
        if ((i + 1) % 100 === 0 || i + 1 === keys.length) {
          const elapsed = ((Date.now() - batchStart) / 1000).toFixed(0);
          const rate = (embedded / ((Date.now() - batchStart) / 1000)).toFixed(
            1
          );
          console.log(
            `[worker ${batch_index}] ${i + 1}/${keys.length} (${chunksTotal} chunks, ${rate} obj/s, ${elapsed}s)`
          );
        }
      } catch (err) {
        failed++;
        const msg = (err as Error).message.slice(0, 120);
        if (errors.length < 5) errors.push(`${key}: ${msg}`);
      }
    }

    const totalSec = ((Date.now() - batchStart) / 1000).toFixed(1);
    console.log(
      `[worker ${batch_index}] Complete: ${embedded} embedded, ${chunksTotal} chunks, ${failed} failed (${totalSec}s)`
    );

    return { batch_index, embedded, failed, chunks_total: chunksTotal, errors };
  } finally {
    await client.end();
  }
}
