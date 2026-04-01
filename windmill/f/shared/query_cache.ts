// query_cache.ts — Windmill script to query the NVMe triage cache.
// Exposed via MCP so Claude can search cached SDP tickets, Slack
// threads, emails, and calendar events during sessions.
//
// Actions:
//   entity  — Find all items referencing a specific entity (instance ID, CVE, etc.)
//   search  — Full-text search across all cached sources
//   recent  — List recently cached items, optionally filtered by source
//   stats   — Cache statistics (counts, size, sources)
//   raw     — Get the full raw JSON for a specific cached item

import {
  queryEntity,
  search,
  recent,
  stats,
  getRaw,
  init,
  isAvailable,
} from "./cache_lib.ts";

export async function main(
  action: "entity" | "search" | "recent" | "stats" | "raw" = "stats",
  query: string = "",
  source: string = "",
  limit: number = 20
): Promise<unknown> {
  if (!isAvailable()) {
    return {
      error: "Cache not available (NVMe not mounted)",
      hint: "Cache requires /local/cache/triage/ on NVMe instance store",
    };
  }

  init();

  switch (action) {
    case "entity": {
      if (!query) return { error: "query parameter required for entity action" };
      const items = queryEntity(query, limit);
      return {
        action: "entity",
        query,
        count: items.length,
        items: items.map((i) => ({
          id: i.id,
          source: i.source,
          type: i.type,
          title: i.title,
          body: i.body.slice(0, 500) + (i.body.length > 500 ? "..." : ""),
          cached_at: new Date(i.cached_at * 1000).toISOString(),
        })),
      };
    }

    case "search": {
      if (!query) return { error: "query parameter required for search action" };
      const items = search(query, source || undefined, limit);
      return {
        action: "search",
        query,
        source: source || "all",
        count: items.length,
        items: items.map((i) => ({
          id: i.id,
          source: i.source,
          type: i.type,
          title: i.title,
          body: i.body.slice(0, 500) + (i.body.length > 500 ? "..." : ""),
          cached_at: new Date(i.cached_at * 1000).toISOString(),
        })),
      };
    }

    case "recent": {
      const items = recent(source || undefined, limit);
      return {
        action: "recent",
        source: source || "all",
        count: items.length,
        items: items.map((i) => ({
          id: i.id,
          source: i.source,
          type: i.type,
          title: i.title,
          cached_at: new Date(i.cached_at * 1000).toISOString(),
        })),
      };
    }

    case "stats": {
      return { action: "stats", ...stats() };
    }

    case "raw": {
      if (!query) return { error: "query parameter required (pass item ID)" };
      const raw = getRaw(query);
      if (raw === null) return { error: `No raw data found for item: ${query}` };
      return { action: "raw", id: query, data: raw };
    }

    default:
      return { error: `Unknown action: ${action}. Use: entity, search, recent, stats, raw` };
  }
}
