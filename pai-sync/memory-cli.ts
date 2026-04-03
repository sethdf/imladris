/**
 * pai memory — Semantic search and embedding management
 *
 * Embeddings are generated in-DB via pgml.embed(intfloat/e5-small-v2) — 384 dims.
 * No external API keys needed.
 *
 * Usage:
 *   pai memory embed [--type learning|failure|prd|wisdom_frame|skill] [--limit N] [--dry-run]
 *   pai memory search "query" [--type TYPE] [--limit N]
 *   pai memory predict "task description"
 *   pai memory stats
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Pool } from 'pg';
import { shouldEmbed, inferSourceType, embedObject, embedQuery, PGML_MODEL } from './embedder.ts';

const CLAUDE_DIR = join(homedir(), '.claude');
const PG_URL = `postgresql://postgres:${process.env.WINDMILL_DB_PASSWORD}@127.0.0.1:5432/pai_memory`;

function makePool(): Pool {
  if (!process.env.WINDMILL_DB_PASSWORD) {
    console.error('Error: WINDMILL_DB_PASSWORD not set. Source /home/ec2-user/repos/imladris/.env first.');
    process.exit(1);
  }
  return new Pool({ connectionString: PG_URL, max: 3 });
}

function timeSince(date: Date): string {
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export async function handleMemoryCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {

    // ── embed ────────────────────────────────────────────────────────────────
    case 'embed': {
      const typeFilter = args.includes('--type') ? args[args.indexOf('--type') + 1] : null;
      const limitArg   = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : 0;
      const dryRun     = args.includes('--dry-run');

      const pool = makePool();
      try {
        // Fetch all memory_objects that are candidates for embedding
        let query = `SELECT key, content FROM memory_objects WHERE deleted = FALSE AND content IS NOT NULL`;
        const params: string[] = [];
        if (typeFilter) {
          // We infer type from key, so filter post-fetch for simplicity
        }

        const { rows } = await pool.query(query, params);

        // Filter to embeddable keys
        let candidates = rows.filter((r: { key: string }) => shouldEmbed(r.key));
        if (typeFilter) {
          candidates = candidates.filter((r: { key: string }) => inferSourceType(r.key) === typeFilter);
        }
        if (limitArg > 0) {
          candidates = candidates.slice(0, limitArg);
        }

        const total = candidates.length;
        console.log(`${dryRun ? '[DRY RUN] ' : ''}Embedding ${total} objects${typeFilter ? ` (type: ${typeFilter})` : ''}...`);

        let done = 0, failed = 0, totalChunks = 0;
        const startMs = Date.now();

        for (const row of candidates) {
          try {
            const result = await embedObject(pool, row.key, row.content, dryRun);
            done++;
            totalChunks += result.chunksWritten;
            if (done % 10 === 0 || done === total) {
              process.stdout.write(`\r  ${done}/${total} embedded (${totalChunks} chunks, ${failed} failed)...`);
            }
          } catch (err) {
            failed++;
            if (failed <= 3) console.error(`\n  Failed: ${row.key}`, (err as Error).message);
          }
        }

        const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
        console.log(`\nDone: ${done} objects, ${totalChunks} chunks, ${failed} failed (${elapsed}s)`);
      } finally {
        await pool.end();
      }
      break;
    }

    // ── search ───────────────────────────────────────────────────────────────
    case 'search': {
      const queryText = args[1];
      if (!queryText) { console.error('Usage: pai memory search "query"'); process.exit(1); }

      const typeFilter = args.includes('--type') ? args[args.indexOf('--type') + 1] : null;
      const limit      = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : 10;

      const pool = makePool();
      try {
        process.stdout.write('Embedding query...');
        const vectorStr = await embedQuery(pool, queryText);
        process.stdout.write(' done.\n');

        // Hybrid retrieval: cosine similarity + recency decay + currency filter
        const typeClause = typeFilter ? `AND mv.source_type = '${typeFilter}'` : '';
        const { rows } = await pool.query(
          `SELECT
             mv.source_key,
             mv.source_type,
             mv.chunk_index,
             mv.chunk_text,
             1 - (mv.embedding <=> $1::vector)  AS similarity,
             mo.updated_at,
             mo.metadata->>'status'              AS status
           FROM memory_vectors mv
           JOIN memory_objects mo ON mv.source_key = mo.key
           WHERE mo.deleted = FALSE
             ${typeClause}
             AND (mo.metadata->>'status' IS NULL OR mo.metadata->>'status' != 'superseded')
           ORDER BY
             (1 - (mv.embedding <=> $1::vector))
             * (1.0 / (1 + EXTRACT(EPOCH FROM NOW() - mo.updated_at) / 86400.0 / 30.0))
           DESC
           LIMIT $2`,
          [vectorStr, limit]
        );

        if (rows.length === 0) {
          console.log('No results. Run `pai memory embed` to generate embeddings first.');
          break;
        }

        console.log(`\nSearch: "${queryText}" — ${rows.length} results\n`);
        for (const row of rows) {
          const sim = (parseFloat(row.similarity) * 100).toFixed(0);
          const age = timeSince(new Date(row.updated_at));
          const excerpt = (row.chunk_text as string).replace(/\s+/g, ' ').slice(0, 160);
          const chunkLabel = row.chunk_index > 0 ? ` [chunk ${row.chunk_index}]` : '';
          console.log(`\x1b[32m${sim}%\x1b[0m \x1b[2m[${row.source_type}]\x1b[0m ${row.source_key}${chunkLabel} \x1b[2m(${age})\x1b[0m`);
          console.log(`  ${excerpt}`);
          console.log('');
        }
      } finally {
        await pool.end();
      }
      break;
    }

    // ── predict ──────────────────────────────────────────────────────────────
    case 'predict': {
      const taskText = args[1];
      if (!taskText) { console.error('Usage: pai memory predict "task description"'); process.exit(1); }

      const pool = makePool();
      try {
        process.stdout.write('Finding similar past failures...');
        const vectorStr = await embedQuery(pool, taskText);
        process.stdout.write(' done.\n\n');

        const { rows } = await pool.query(
          `SELECT
             mv.source_key,
             mv.chunk_text,
             1 - (mv.embedding <=> $1::vector) AS similarity,
             mo.updated_at
           FROM memory_vectors mv
           JOIN memory_objects mo ON mv.source_key = mo.key
           WHERE mv.source_type = 'failure'
             AND mo.deleted = FALSE
           ORDER BY mv.embedding <=> $1::vector
           LIMIT 5`,
          [vectorStr]
        );

        if (rows.length === 0) {
          console.log('No failure embeddings found. Run `pai memory embed --type failure` first.');
          break;
        }

        console.log(`Similar past failures for: "${taskText}"\n`);
        for (const row of rows) {
          const sim = (parseFloat(row.similarity) * 100).toFixed(0);
          const age = timeSince(new Date(row.updated_at));
          const excerpt = (row.chunk_text as string).replace(/\s+/g, ' ').slice(0, 200);
          console.log(`\x1b[31m${sim}%\x1b[0m ${row.source_key} \x1b[2m(${age})\x1b[0m`);
          console.log(`  ${excerpt}`);
          console.log('');
        }
      } finally {
        await pool.end();
      }
      break;
    }

    // ── stats ────────────────────────────────────────────────────────────────
    case 'stats': {
      const pool = makePool();
      try {
        const { rows: totalRows } = await pool.query(
          `SELECT COUNT(*) as total, SUM(CASE WHEN deleted THEN 0 ELSE 1 END) as active
           FROM memory_objects`
        );
        const { rows: vecRows } = await pool.query(
          `SELECT source_type, COUNT(DISTINCT source_key) as objects, COUNT(*) as chunks
           FROM memory_vectors GROUP BY source_type ORDER BY objects DESC`
        );
        const { rows: lineRows } = await pool.query(
          `SELECT COUNT(DISTINCT file_key) as files, COUNT(*) as lines FROM memory_lines`
        );

        const total   = parseInt(totalRows[0].total);
        const active  = parseInt(totalRows[0].active);
        const embedded = vecRows.reduce((s: number, r: { objects: string }) => s + parseInt(r.objects), 0);

        console.log(`\x1b[1mpai_memory stats\x1b[0m\n`);
        console.log(`  Model:     ${PGML_MODEL} (384 dims, in-DB via pgml)`);
        console.log(`  Objects:   ${active.toLocaleString()} active / ${total.toLocaleString()} total`);
        console.log(`  Lines:     ${parseInt(lineRows[0].lines).toLocaleString()} (${parseInt(lineRows[0].files).toLocaleString()} JSONL files)`);
        console.log(`  Embedded:  ${embedded.toLocaleString()} / ${active.toLocaleString()} (${Math.round(embedded/active*100)}%)`);
        if (vecRows.length > 0) {
          console.log('\n  Vectors by type:');
          for (const r of vecRows) {
            console.log(`    ${r.source_type.padEnd(16)} ${String(r.objects).padStart(5)} objects  ${String(r.chunks).padStart(6)} chunks`);
          }
        }
      } finally {
        await pool.end();
      }
      break;
    }

    default: {
      console.log(`pai memory commands:
  embed [--type TYPE] [--limit N] [--dry-run]
                    Generate embeddings for memory objects
  search "query" [--type TYPE] [--limit N]
                    Semantic search with hybrid retrieval
  predict "task"    Find similar past failures
  stats             Show embedding coverage stats`);
    }
  }
}
