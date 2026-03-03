// Windmill Script: Search Alert History (Read-Only)
// Investigation tool — searches the triage cache (NVMe SQLite).
// Ports query_cache logic from mcp_server.ts.
// Actions: entity (find by ID), search (text), recent (latest), stats (overview).

import { Database } from "bun:sqlite";
import { existsSync } from "fs";

const CACHE_DB = "/local/cache/triage/index.db";

export async function main(
  action: "entity" | "search" | "recent" | "stats" = "search",
  query?: string,
  source?: "m365" | "slack" | "sdp",
  hours_back: number = 168,
  limit: number = 20,
) {
  if (!existsSync(CACHE_DB)) {
    return { error: "Triage cache DB not available", path: CACHE_DB };
  }

  const db = new Database(CACHE_DB, { readonly: true });
  db.exec("PRAGMA journal_mode=WAL");

  try {
    switch (action) {
      case "entity": {
        if (!query) return { error: "query required — provide entity ID (e.g., i-xxx, CVE-xxx)" };
        const rows = db.query(`
          SELECT DISTINCT i.id, i.source, i.type, i.title,
                 SUBSTR(i.body, 1, 500) as body, i.cached_at
          FROM items i JOIN entity_index e ON i.id = e.item_id
          WHERE e.entity = $query COLLATE NOCASE
          ORDER BY i.cached_at DESC LIMIT $limit
        `).all({ $query: query, $limit: limit });
        return { action: "entity", query, count: (rows as any[]).length, items: rows };
      }

      case "search": {
        if (!query) return { error: "query required — provide search term" };
        const like = `%${query}%`;
        const sinceDate = new Date(Date.now() - hours_back * 60 * 60 * 1000).toISOString();
        const rows = source
          ? db.query(`
              SELECT id, source, type, title, SUBSTR(body,1,500) as body, cached_at
              FROM items
              WHERE (title LIKE $like OR body LIKE $like) AND source = $src AND cached_at >= $since
              ORDER BY cached_at DESC LIMIT $limit
            `).all({ $like: like, $src: source, $limit: limit, $since: sinceDate })
          : db.query(`
              SELECT id, source, type, title, SUBSTR(body,1,500) as body, cached_at
              FROM items
              WHERE (title LIKE $like OR body LIKE $like) AND cached_at >= $since
              ORDER BY cached_at DESC LIMIT $limit
            `).all({ $like: like, $limit: limit, $since: sinceDate });
        return { action: "search", query, count: (rows as any[]).length, items: rows };
      }

      case "recent": {
        const rows = source
          ? db.query(`
              SELECT id, source, type, title, cached_at
              FROM items WHERE source = $src
              ORDER BY cached_at DESC LIMIT $limit
            `).all({ $src: source, $limit: limit })
          : db.query(`
              SELECT id, source, type, title, cached_at
              FROM items ORDER BY cached_at DESC LIMIT $limit
            `).all({ $limit: limit });
        return { action: "recent", count: (rows as any[]).length, items: rows };
      }

      case "stats": {
        const total = (db.query("SELECT COUNT(*) as c FROM items").get() as any)?.c || 0;
        const entities = (db.query("SELECT COUNT(*) as c FROM entity_index").get() as any)?.c || 0;
        const bySrc = db.query("SELECT source, COUNT(*) as c FROM items GROUP BY source").all();
        const oldest = (db.query("SELECT MIN(cached_at) as t FROM items").get() as any)?.t;
        const newest = (db.query("SELECT MAX(cached_at) as t FROM items").get() as any)?.t;
        return { action: "stats", total, entities, by_source: bySrc, oldest, newest };
      }
    }
  } finally {
    db.close();
  }
}
