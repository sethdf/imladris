// graduate_insight.ts — Promote a learning to the shared schema
//
// Part of the Hive Collective (Phase 2d). Moves a learning from
// core.memory_objects to shared.insights for cross-instance replication.
//
// Council Decision (2026-04-07): Graduation authority must be independent
// of content producer. Only human CLI or this explicit script can graduate.
// A model cannot graduate its own insights.
//
// Graduation is forward-only with soft-delete rollback.

import pg from "pg";

const POSTGRES_URL = process.env.POSTGRES_URL || "";

export async function main(
  learning_key: string,
  reason: string = "",
  graduated_by: string = "seth",
) {
  if (!POSTGRES_URL) return { error: "POSTGRES_URL not set" };
  if (!learning_key) return { error: "learning_key is required" };

  const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 2 });

  try {
    // Verify the learning exists in core.memory_objects
    const { rows: sourceRows } = await pool.query(`
      SELECT key, content, metadata, content_hash
      FROM core.memory_objects
      WHERE key = $1 AND NOT deleted
    `, [learning_key]);

    if (sourceRows.length === 0) {
      return { error: `Learning not found: ${learning_key}` };
    }

    const source = sourceRows[0];

    // Check if already graduated
    const { rows: existing } = await pool.query(`
      SELECT id FROM shared.insights WHERE source_key = $1 AND NOT revoked
    `, [learning_key]);

    if (existing.length > 0) {
      return { error: `Already graduated: ${learning_key}`, insight_id: existing[0].id };
    }

    // Graduate to shared.insights
    const { rows: inserted } = await pool.query(`
      INSERT INTO shared.insights (
        source_key, content, metadata, content_hash,
        graduated_by, graduation_reason, graduated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING id
    `, [
      learning_key,
      source.content,
      source.metadata,
      source.content_hash,
      graduated_by,
      reason || "Manually graduated via graduate_insight",
    ]);

    return {
      graduated: true,
      insight_id: inserted[0].id,
      source_key: learning_key,
      graduated_by,
      reason,
    };
  } finally {
    await pool.end();
  }
}
