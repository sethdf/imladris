// Windmill Script: PAI Memory Embed Planner
//
// Queries memory_objects for files not yet embedded (or stale since last embed),
// splits into N batches for parallel workers.
//
// Returns: { total, batches: string[][], dry_run }

const PGML_MODEL = 'intfloat/e5-small-v2';

const EMBEDDABLE_PREFIXES = [
  "MEMORY/LEARNING/",
  "MEMORY/WORK/",
  "WISDOM/",
  "skills/",
];
const EMBEDDABLE_EXTS = [".md", ".txt", ".ts"];

export async function main(
  num_workers: number = 4,
  dry_run: boolean = false
) {
  const { Client } = (await import("pg")) as any;

  // Derive `pai` DB URL from DATABASE_URL (workers have windmill DB URL in env).
  // memory_vectors lives in the `pai` database, not `pai_memory`. Fixed 2026-04-10.
  const dbUrl = new URL(process.env.DATABASE_URL!);
  dbUrl.pathname = "/pai";

  const client = new Client({ connectionString: dbUrl.toString() });
  await client.connect();

  try {
    const prefixClause = EMBEDDABLE_PREFIXES.map(
      (p) => `mo.key LIKE '${p}%'`
    ).join(" OR ");
    const extClause = EMBEDDABLE_EXTS.map(
      (e) => `mo.key LIKE '%${e}'`
    ).join(" OR ");

    const { rows } = await client.query(`
      SELECT mo.key
      FROM memory_objects mo
      WHERE mo.deleted = FALSE
        AND (${prefixClause})
        AND (${extClause})
        AND mo.key NOT LIKE '%node_modules%'
        AND mo.key NOT LIKE '%sync-wal%'
        AND mo.key NOT LIKE '%sync-log%'
        AND mo.content IS NOT NULL
        AND (
          -- not yet embedded
          NOT EXISTS (
            SELECT 1 FROM memory_vectors mv WHERE mv.source_key = mo.key
          )
          OR
          -- re-embed if object updated since last embed
          mo.updated_at > (
            SELECT mv.updated_at FROM memory_vectors mv
            WHERE mv.source_key = mo.key
            ORDER BY mv.chunk_index ASC LIMIT 1
          )
        )
      ORDER BY mo.key
    `);

    const keys: string[] = rows.map((r: { key: string }) => r.key);
    const total = keys.length;

    if (total === 0) {
      console.log("Nothing to embed — all objects are current.");
      return { total: 0, batches: [], dry_run };
    }

    // Split evenly across workers
    const workers = Math.min(num_workers, total);
    const batchSize = Math.ceil(total / workers);
    const batches: string[][] = [];
    for (let i = 0; i < total; i += batchSize) {
      batches.push(keys.slice(i, i + batchSize));
    }

    console.log(
      `Found ${total} objects to embed → ${batches.length} worker(s), ~${batchSize} objects each`
    );
    if (dry_run) {
      console.log("DRY RUN — workers will not call pgml.embed()");
    }

    return { total, batches, dry_run };
  } finally {
    await client.end();
  }
}
