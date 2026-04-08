// entity_triage_integration.ts — Phase 3a: Entity Extraction + Triage Feedback Loop
//
// Wires entity extraction into the triage pipeline so every triage result
// gets entity-tagged, and the feedback loop calibrates per entity type.
//
// This is the glue between:
//   - entity_extract.ts (canonical extraction patterns)
//   - cache_lib.ts (triage_results + entity_index tables)
//   - triage_feedback.ts (accuracy calibration)
//
// Two modes:
//   "tag" — Extract entities from all untagged triage results and store in entity_index
//   "calibrate" — Aggregate feedback data per entity type for accuracy steering
//   "report" — Generate entity-aware triage quality report

import { Database } from "bun:sqlite";
import { extractEntities as canonicalExtract } from "./entity_extract.ts";

const SQLITE_PATH = (process.env.CACHE_DIR || "/local/cache/triage") + "/index.db";

function getDb(): Database {
  return new Database(SQLITE_PATH);
}

export async function main(
  action: string = "tag",
  limit: number = 500,
) {
  const db = getDb();
  try {
    switch (action) {
      case "tag":
        return await tagUntaggedResults(db, limit);
      case "calibrate":
        return await calibratePerEntity(db);
      case "report":
        return await entityQualityReport(db);
      default:
        return { error: `Unknown action: ${action}. Use 'tag', 'calibrate', or 'report'` };
    }
  } finally {
    db.close();
  }
}

/** Extract entities from triage results that haven't been tagged yet */
async function tagUntaggedResults(db: Database, limit: number) {
  // Find results where entities column is empty or '[]'
  const rows = db.query(`
    SELECT id, subject, body, sender, source
    FROM triage_results
    WHERE entities IS NULL OR entities = '[]' OR entities = ''
    ORDER BY classified_at DESC
    LIMIT ?
  `).all(limit) as any[];

  let tagged = 0;
  let entitiesFound = 0;

  for (const row of rows) {
    // Combine text fields for entity extraction
    const text = [row.subject, row.body, row.sender].filter(Boolean).join("\n");
    const entities = canonicalExtract(text);

    if (entities.length > 0) {
      // Store entities in the entity_index table
      const insertEntity = db.prepare(`
        INSERT OR IGNORE INTO entity_index (entity, item_id, entity_type)
        VALUES (?, ?, ?)
      `);

      for (const e of entities) {
        insertEntity.run(e.value, String(row.id), e.type);
        entitiesFound++;
      }

      // Update the entities column on the triage_result
      db.prepare(`UPDATE triage_results SET entities = ? WHERE id = ?`)
        .run(JSON.stringify(entities.map(e => ({ type: e.type, value: e.value }))), row.id);
    } else {
      // Mark as tagged but empty so we don't re-process
      db.prepare(`UPDATE triage_results SET entities = '[]' WHERE id = ?`).run(row.id);
    }
    tagged++;
  }

  return {
    action: "tag",
    results_processed: tagged,
    entities_extracted: entitiesFound,
    remaining: db.query(`
      SELECT count(*) as cnt FROM triage_results
      WHERE entities IS NULL OR entities = ''
    `).get() as any,
  };
}

/** Aggregate feedback data per entity type for accuracy steering */
async function calibratePerEntity(db: Database) {
  // Join feedback with entity_index to get per-entity-type accuracy
  const stats = db.query(`
    SELECT
      ei.entity_type,
      ei.entity,
      COUNT(DISTINCT f.dedup_hash) as feedback_count,
      AVG(f.rating) as avg_rating,
      SUM(CASE WHEN f.misdiagnosis_type IS NOT NULL THEN 1 ELSE 0 END) as misdiagnoses,
      GROUP_CONCAT(DISTINCT f.misdiagnosis_type) as misdiagnosis_types
    FROM investigation_feedback f
    JOIN triage_results tr ON f.dedup_hash = tr.dedup_hash
    JOIN entity_index ei ON CAST(tr.id AS TEXT) = ei.item_id
    GROUP BY ei.entity_type, ei.entity
    HAVING feedback_count > 1
    ORDER BY avg_rating ASC
    LIMIT 50
  `).all() as any[];

  // Entity type aggregates
  const byType = db.query(`
    SELECT
      ei.entity_type,
      COUNT(DISTINCT ei.entity) as unique_entities,
      COUNT(DISTINCT ei.item_id) as triage_items,
      AVG(f.rating) as avg_rating
    FROM entity_index ei
    LEFT JOIN triage_results tr ON CAST(tr.id AS TEXT) = ei.item_id
    LEFT JOIN investigation_feedback f ON f.dedup_hash = tr.dedup_hash
    GROUP BY ei.entity_type
    ORDER BY triage_items DESC
  `).all() as any[];

  return {
    action: "calibrate",
    entity_type_summary: byType,
    low_quality_entities: stats.filter((s: any) => s.avg_rating && s.avg_rating < 3),
    high_quality_entities: stats.filter((s: any) => s.avg_rating && s.avg_rating >= 4),
    total_entity_types: byType.length,
  };
}

/** Generate a report on triage quality segmented by entity */
async function entityQualityReport(db: Database) {
  const totalResults = db.query(`SELECT count(*) as cnt FROM triage_results`).get() as any;
  const taggedResults = db.query(`
    SELECT count(*) as cnt FROM triage_results WHERE entities IS NOT NULL AND entities != '[]' AND entities != ''
  `).get() as any;
  const totalEntities = db.query(`SELECT count(*) as cnt FROM entity_index`).get() as any;
  const uniqueEntities = db.query(`SELECT count(DISTINCT entity) as cnt FROM entity_index`).get() as any;

  // Top entities by occurrence
  const topEntities = db.query(`
    SELECT entity, entity_type, count(*) as occurrences
    FROM entity_index
    GROUP BY entity, entity_type
    ORDER BY occurrences DESC
    LIMIT 20
  `).all() as any[];

  // Entities appearing in high-urgency items
  const highUrgencyEntities = db.query(`
    SELECT ei.entity, ei.entity_type, count(*) as high_urgency_count
    FROM entity_index ei
    JOIN triage_results tr ON CAST(tr.id AS TEXT) = ei.item_id
    WHERE tr.urgency IN ('high', 'critical')
    GROUP BY ei.entity, ei.entity_type
    ORDER BY high_urgency_count DESC
    LIMIT 15
  `).all() as any[];

  return {
    action: "report",
    total_triage_results: totalResults.cnt,
    tagged_results: taggedResults.cnt,
    tagging_coverage: totalResults.cnt > 0 ? `${((taggedResults.cnt / totalResults.cnt) * 100).toFixed(1)}%` : "0%",
    total_entity_references: totalEntities.cnt,
    unique_entities: uniqueEntities.cnt,
    top_entities: topEntities,
    high_urgency_entities: highUrgencyEntities,
  };
}
