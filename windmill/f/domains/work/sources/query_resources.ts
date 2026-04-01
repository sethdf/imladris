// Windmill Script: Query Resources (Read-Only)
// Investigation tool — searches the AWS resource inventory (auto-discovered).
// Ports query_resources logic from mcp_server.ts.

import { Database } from "bun:sqlite";
import { existsSync } from "fs";

const CACHE_DB = "/local/cache/triage/index.db";

export async function main(
  action: "search" | "list" | "stats" = "search",
  query?: string,
  resource_type?: string,
  limit: number = 20,
) {
  if (!existsSync(CACHE_DB)) {
    return { error: "Cache DB not available", path: CACHE_DB };
  }

  const db = new Database(CACHE_DB, { readonly: true });
  db.exec("PRAGMA journal_mode=WAL");

  try {
    switch (action) {
      case "search": {
        if (!query) return { error: "query required" };
        const like = `%${query.toLowerCase()}%`;
        const rows = resource_type
          ? db.query(`
              SELECT resource_id, resource_name, resource_type, cloud, account_id, region, state
              FROM resource_inventory
              WHERE is_stale = 0 AND resource_type = $type
                AND (LOWER(resource_name) LIKE $like OR name_tokens LIKE $like)
              LIMIT $limit
            `).all({ $type: resource_type, $like: like, $limit: limit })
          : db.query(`
              SELECT resource_id, resource_name, resource_type, cloud, account_id, region, state
              FROM resource_inventory
              WHERE is_stale = 0
                AND (LOWER(resource_name) LIKE $like OR name_tokens LIKE $like)
              LIMIT $limit
            `).all({ $like: like, $limit: limit });
        return { action: "search", query, count: (rows as any[]).length, resources: rows };
      }

      case "list": {
        const rows = resource_type
          ? db.query(`
              SELECT resource_id, resource_name, resource_type, cloud, account_id, region, state
              FROM resource_inventory WHERE is_stale = 0 AND resource_type = $type LIMIT $limit
            `).all({ $type: resource_type, $limit: limit })
          : db.query(`
              SELECT resource_id, resource_name, resource_type, cloud, account_id, region, state
              FROM resource_inventory WHERE is_stale = 0 LIMIT $limit
            `).all({ $limit: limit });
        return { action: "list", count: (rows as any[]).length, resources: rows };
      }

      case "stats": {
        const total = (db.query("SELECT COUNT(*) as c FROM resource_inventory WHERE is_stale = 0").get() as any)?.c || 0;
        const stale = (db.query("SELECT COUNT(*) as c FROM resource_inventory WHERE is_stale = 1").get() as any)?.c || 0;
        const byType = db.query(
          "SELECT resource_type, COUNT(*) as c FROM resource_inventory WHERE is_stale = 0 GROUP BY resource_type"
        ).all();
        return { action: "stats", total, stale, by_type: byType };
      }
    }
  } finally {
    db.close();
  }
}
