// Windmill Script: Triage Overview (Read-Only)
// Investigation tool — pipeline statistics and recent actionable items.
// Ports triage_overview logic from mcp_server.ts.
// Actions: stats (pipeline counts), actionable (uninvestigated), investigated (ready), stale (exhausted).

import { Database } from "bun:sqlite";
import { existsSync } from "fs";

const CACHE_DB = "/local/cache/triage/index.db";

export async function main(
  action: "stats" | "actionable" | "investigated" | "stale" = "stats",
  limit: number = 20,
) {
  if (!existsSync(CACHE_DB)) {
    return { error: "Triage cache DB not available", path: CACHE_DB };
  }

  const db = new Database(CACHE_DB, { readonly: true });
  db.exec("PRAGMA journal_mode=WAL");

  try {
    switch (action) {
      case "stats": {
        const total = (db.query("SELECT COUNT(*) as c FROM triage_results").get() as any)?.c || 0;
        const byAction = db.query("SELECT action, COUNT(*) as c FROM triage_results GROUP BY action").all();
        const byLayer = db.query("SELECT classified_by, COUNT(*) as c FROM triage_results GROUP BY classified_by").all();
        const byStatus = db.query(
          "SELECT COALESCE(investigation_status, 'not_started') as status, COUNT(*) as c FROM triage_results WHERE action IN ('QUEUE','NOTIFY') GROUP BY investigation_status"
        ).all();
        return { action: "stats", total, by_action: byAction, by_layer: byLayer, investigation_status: byStatus };
      }

      case "actionable": {
        const rows = db.query(`
          SELECT id, subject, sender, urgency, action, summary, domain, classified_at
          FROM triage_results
          WHERE action IN ('QUEUE','NOTIFY') AND task_id IS NULL AND domain = 'work' AND investigation_status IS NULL
          ORDER BY CASE urgency WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, classified_at DESC
          LIMIT $limit
        `).all({ $limit: limit });
        return { action: "actionable", count: (rows as any[]).length, items: rows };
      }

      case "investigated": {
        const rows = db.query(`
          SELECT id, subject, sender, urgency, summary, investigation_status, SUBSTR(investigation_result,1,500) as result_preview
          FROM triage_results
          WHERE investigation_status = 'substantial' AND task_id IS NULL AND domain = 'work'
          GROUP BY dedup_hash
          ORDER BY classified_at DESC LIMIT $limit
        `).all({ $limit: limit });
        return { action: "investigated", count: (rows as any[]).length, items: rows };
      }

      case "stale": {
        const rows = db.query(`
          SELECT id, subject, sender, urgency, investigation_status, investigation_attempts, waiting_context_reason
          FROM triage_results
          WHERE investigation_status IN ('waiting_context','empty','error') AND investigation_attempts >= 5
            AND task_id IS NULL AND domain = 'work'
          GROUP BY dedup_hash
          ORDER BY classified_at DESC LIMIT $limit
        `).all({ $limit: limit });
        return { action: "stale", count: (rows as any[]).length, items: rows };
      }
    }
  } finally {
    db.close();
  }
}
