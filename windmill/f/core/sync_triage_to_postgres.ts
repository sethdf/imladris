// sync_triage_to_postgres.ts — Sync finalized triage records from SQLite → Postgres work schema
//
// Phase 2e: Operational Data Consolidation
// SQLite remains the hot operational cache. This script periodically syncs
// finalized records (task_created, escalated, dismissed) to work.triage_results
// in Postgres for durable storage and cross-system queryability.
//
// Schedule: every 15 minutes via Windmill cron
// Idempotent: uses upsert on (source, message_id, dedup_hash)

import { Database } from "bun:sqlite";
import pg from "pg";

const SQLITE_PATH = (process.env.CACHE_DIR || "/local/cache/triage") + "/index.db";
const POSTGRES_URL = process.env.POSTGRES_URL || "";

// Terminal states — only sync records that are "done"
const TERMINAL_STATES = ["task_created", "escalated", "dismissed"];

export async function main() {
  if (!POSTGRES_URL) {
    return { error: "POSTGRES_URL not set", synced: 0 };
  }

  // Open SQLite (read-only)
  let sqlite: Database;
  try {
    sqlite = new Database(SQLITE_PATH, { readonly: true });
  } catch (e) {
    return { error: `Cannot open SQLite: ${e}`, synced: 0 };
  }

  // Connect to Postgres
  const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 3 });

  try {
    // Get finalized triage records from SQLite
    // Only sync records that reached a terminal investigation state OR have a task_id
    const rows = sqlite.query(`
      SELECT
        id, source, message_id, subject, sender, received_at,
        action, urgency, summary, reasoning, domain, classified_by,
        rule_id, dedup_hash, occurrence_count, human_override, override_notes,
        marked_read, metadata, task_id, classified_at,
        investigation_status, investigation_result, waiting_context_reason,
        investigation_attempts, last_investigated_at, entities,
        alert_type, source_system, incident_id
      FROM triage_results
      WHERE task_id IS NOT NULL
         OR investigation_status IN ('substantial', 'escalated', 'dismissed')
         OR action IN ('DISMISS', 'ARCHIVE')
      ORDER BY classified_at DESC
      LIMIT 1000
    `).all() as any[];

    let synced = 0;
    let skipped = 0;
    let errors = 0;

    for (const row of rows) {
      try {
        await pool.query(`
          INSERT INTO work.triage_results (
            sqlite_id, source, message_id, subject, sender, received_at,
            action, urgency, summary, reasoning, domain, classified_by,
            rule_id, dedup_hash, occurrence_count, human_override, override_notes,
            marked_read, metadata, task_id, classified_at,
            investigation_status, investigation_result, waiting_context_reason,
            investigation_attempts, last_investigated_at, entities,
            alert_type, source_system, incident_id,
            synced_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16, $17,
            $18, $19::jsonb, $20, to_timestamp($21),
            $22, $23::jsonb, $24::jsonb,
            $25, CASE WHEN $26::int > 0 THEN to_timestamp($26::int) ELSE NULL END, $27::jsonb,
            $28, $29, $30,
            NOW()
          )
          ON CONFLICT (source, message_id, dedup_hash) DO UPDATE SET
            investigation_status = EXCLUDED.investigation_status,
            investigation_result = EXCLUDED.investigation_result,
            investigation_attempts = EXCLUDED.investigation_attempts,
            last_investigated_at = EXCLUDED.last_investigated_at,
            task_id = EXCLUDED.task_id,
            human_override = EXCLUDED.human_override,
            synced_at = NOW()
        `, [
          row.id, row.source, row.message_id, row.subject, row.sender, row.received_at,
          row.action, row.urgency, row.summary, row.reasoning, row.domain, row.classified_by,
          row.rule_id, row.dedup_hash, row.occurrence_count, row.human_override, row.override_notes,
          row.marked_read ? true : false,
          row.metadata || '{}', row.task_id,
          row.classified_at,
          row.investigation_status,
          row.investigation_result || null,
          row.waiting_context_reason || null,
          row.investigation_attempts || 0,
          row.last_investigated_at || 0,
          row.entities || '[]',
          row.alert_type, row.source_system, row.incident_id,
        ]);
        synced++;
      } catch (e: any) {
        if (e?.message?.includes("does not exist")) {
          // work.triage_results table not yet created — Phase 2d pending
          return { error: "work.triage_results table does not exist yet (Phase 2d)", synced: 0 };
        }
        errors++;
        if (errors <= 3) console.error(`[sync] error on ${row.message_id}: ${e?.message?.slice(0, 200)}`);
      }
    }

    // Also sync entity_index
    const entityRows = sqlite.query(`
      SELECT entity, item_id, entity_type FROM entity_index
    `).all() as any[];

    let entitiesSynced = 0;
    for (const e of entityRows) {
      try {
        await pool.query(`
          INSERT INTO work.entities_work (entity, item_id, entity_type, first_seen)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (entity, item_id) DO NOTHING
        `, [e.entity, e.item_id, e.entity_type]);
        entitiesSynced++;
      } catch {
        // entities_work may not exist yet
      }
    }

    // Sync capability_gaps
    const gapRows = sqlite.query(`
      SELECT name, reason, first_seen, last_seen, occurrence_count FROM capability_gaps
    `).all() as any[];

    let gapsSynced = 0;
    for (const g of gapRows) {
      try {
        await pool.query(`
          INSERT INTO work.capability_gaps (name, reason, first_seen, last_seen, occurrence_count)
          VALUES ($1, $2, to_timestamp($3), to_timestamp($4), $5)
          ON CONFLICT (name) DO UPDATE SET
            last_seen = EXCLUDED.last_seen,
            occurrence_count = EXCLUDED.occurrence_count
        `, [g.name, g.reason, g.first_seen, g.last_seen, g.occurrence_count]);
        gapsSynced++;
      } catch {
        // capability_gaps may not exist yet
      }
    }

    return {
      triage_synced: synced,
      triage_skipped: skipped,
      triage_errors: errors,
      entities_synced: entitiesSynced,
      gaps_synced: gapsSynced,
      total_sqlite_rows: rows.length,
    };
  } finally {
    await pool.end();
    sqlite.close();
  }
}
