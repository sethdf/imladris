#!/usr/bin/env bun
// mcp_server.ts — Unified MCP server for Imladris data access.
// Exposes triage cache, vendor inventory, resource inventory, and
// Windmill script execution through a single stdio connection.
//
// Run: bun run f/devops/mcp_server.ts
// Config: Add to ~/.claude/settings.json under mcpServers

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";

// ── Config ──

const CACHE_DB = process.env.CACHE_DB || "/local/cache/triage/index.db";
const VENDOR_JSON = process.env.VENDOR_JSON ||
  `${process.env.HOME}/.claude/MEMORY/WORK/vendor-inventory/vendors.json`;
const WINDMILL_BASE = process.env.WINDMILL_BASE || "http://localhost:8000";
const WINDMILL_TOKEN = process.env.WINDMILL_TOKEN || "";
const WINDMILL_WORKSPACE = process.env.WINDMILL_WORKSPACE || "imladris";

// ── Helpers ──

function getDb(): Database | null {
  try {
    if (!existsSync(CACHE_DB)) return null;
    const db = new Database(CACHE_DB, { readonly: true });
    db.exec("PRAGMA journal_mode=WAL");
    return db;
  } catch {
    return null;
  }
}

function loadVendors(): any[] {
  try {
    if (!existsSync(VENDOR_JSON)) return [];
    const data = JSON.parse(readFileSync(VENDOR_JSON, "utf-8"));
    // Support both { vendors: [...] } and plain array formats
    if (Array.isArray(data)) return data;
    if (data?.vendors && Array.isArray(data.vendors)) return data.vendors;
    return [];
  } catch {
    return [];
  }
}

// ── MCP Server ──

const server = new McpServer({
  name: "imladris",
  version: "1.0.0",
});

// ── Tool 1: query_cache ──
// Direct SQLite read from NVMe triage cache

server.tool(
  "query_cache",
  "Search the triage cache — emails, tickets, Slack threads cached on NVMe. Actions: entity (find by ID like i-xxx, CVE-xxx), search (full-text), recent (latest items), stats (counts/size).",
  {
    action: z.enum(["entity", "search", "recent", "stats", "raw"]).describe(
      "entity=find by entity ID, search=full-text, recent=latest, stats=overview, raw=full JSON"
    ),
    query: z.string().optional().describe("Search term or entity ID"),
    source: z.string().optional().describe("Filter by source: m365, slack, sdp"),
    limit: z.number().optional().default(20).describe("Max results"),
  },
  async ({ action, query, source, limit }) => {
    const db = getDb();
    if (!db) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Cache DB not available" }) }] };
    }
    try {
      let result: any;
      switch (action) {
        case "entity": {
          if (!query) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "query required" }) }] };
          const rows = db.query(`
            SELECT DISTINCT i.id, i.source, i.type, i.title,
                   SUBSTR(i.body, 1, 500) as body, i.cached_at
            FROM items i JOIN entity_index e ON i.id = e.item_id
            WHERE e.entity = $query COLLATE NOCASE
            ORDER BY i.cached_at DESC LIMIT $limit
          `).all({ $query: query, $limit: limit });
          result = { action: "entity", query, count: rows.length, items: rows };
          break;
        }
        case "search": {
          if (!query) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "query required" }) }] };
          const like = `%${query}%`;
          const rows = source
            ? db.query(`SELECT id, source, type, title, SUBSTR(body,1,500) as body, cached_at
                        FROM items WHERE (title LIKE $like OR body LIKE $like) AND source = $src
                        ORDER BY cached_at DESC LIMIT $limit`).all({ $like: like, $src: source, $limit: limit })
            : db.query(`SELECT id, source, type, title, SUBSTR(body,1,500) as body, cached_at
                        FROM items WHERE title LIKE $like OR body LIKE $like
                        ORDER BY cached_at DESC LIMIT $limit`).all({ $like: like, $limit: limit });
          result = { action: "search", query, count: rows.length, items: rows };
          break;
        }
        case "recent": {
          const rows = source
            ? db.query("SELECT id, source, type, title, cached_at FROM items WHERE source = $src ORDER BY cached_at DESC LIMIT $limit")
                .all({ $src: source, $limit: limit })
            : db.query("SELECT id, source, type, title, cached_at FROM items ORDER BY cached_at DESC LIMIT $limit")
                .all({ $limit: limit });
          result = { action: "recent", count: rows.length, items: rows };
          break;
        }
        case "stats": {
          const total = (db.query("SELECT COUNT(*) as c FROM items").get() as any)?.c || 0;
          const entities = (db.query("SELECT COUNT(*) as c FROM entity_index").get() as any)?.c || 0;
          const bySrc = db.query("SELECT source, COUNT(*) as c FROM items GROUP BY source").all();
          result = { action: "stats", total, entities, by_source: bySrc };
          break;
        }
        case "raw": {
          if (!query) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "query required (item ID)" }) }] };
          const row = db.query("SELECT file_path FROM items WHERE id = $id").get({ $id: query }) as any;
          if (row?.file_path && existsSync(row.file_path)) {
            const data = JSON.parse(readFileSync(row.file_path, "utf-8"));
            result = { action: "raw", id: query, data };
          } else {
            result = { error: `No raw data for: ${query}` };
          }
          break;
        }
      }
      db.close();
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      db.close();
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }] };
    }
  }
);

// ── Tool 2: query_vendors ──
// Reads vendor inventory JSON

server.tool(
  "query_vendors",
  "Search the vendor inventory (~280 Buxton/Elevar/Audiense vendors). Filter by name, department, criticality, SSO/MFA status, or list all.",
  {
    action: z.enum(["search", "list", "stats"]).describe(
      "search=find vendors by keyword, list=all vendors (paginated), stats=summary"
    ),
    query: z.string().optional().describe("Search term (matches name, department, description)"),
    criticality: z.enum(["High", "Med", "Low", ""]).optional().describe("Filter by criticality"),
    has_login: z.boolean().optional().describe("Filter to vendors with logins only"),
    limit: z.number().optional().default(20).describe("Max results"),
    offset: z.number().optional().default(0).describe("Pagination offset"),
  },
  async ({ action, query, criticality, has_login, limit, offset }) => {
    const vendors = loadVendors();
    if (!vendors.length) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Vendor data not found", path: VENDOR_JSON }) }] };
    }

    let filtered = vendors;
    if (has_login) filtered = filtered.filter((v: any) => v.has_login);
    if (criticality) filtered = filtered.filter((v: any) => v.criticality === criticality);

    let result: any;
    switch (action) {
      case "search": {
        if (!query) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "query required" }) }] };
        const q = query.toLowerCase();
        const matches = filtered.filter((v: any) =>
          (v.name || "").toLowerCase().includes(q) ||
          (v.department || "").toLowerCase().includes(q) ||
          (v.description || "").toLowerCase().includes(q) ||
          (v.notes || "").toLowerCase().includes(q)
        );
        result = {
          action: "search", query, count: matches.length,
          vendors: matches.slice(offset, offset + limit).map(vendorSummary),
        };
        break;
      }
      case "list": {
        result = {
          action: "list",
          total: filtered.length,
          offset,
          limit,
          vendors: filtered.slice(offset, offset + limit).map(vendorSummary),
        };
        break;
      }
      case "stats": {
        const byDept: Record<string, number> = {};
        const byCrit: Record<string, number> = {};
        let withLogin = 0, withSso = 0, withMfa = 0;
        for (const v of vendors) {
          byDept[v.department || "Unknown"] = (byDept[v.department || "Unknown"] || 0) + 1;
          byCrit[v.criticality || "Unknown"] = (byCrit[v.criticality || "Unknown"] || 0) + 1;
          if (v.has_login) withLogin++;
          if (v.sso) withSso++;
          if (v.mfa) withMfa++;
        }
        result = {
          action: "stats", total: vendors.length,
          with_login: withLogin, with_sso: withSso, with_mfa: withMfa,
          by_department: byDept, by_criticality: byCrit,
        };
        break;
      }
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

function vendorSummary(v: any) {
  return {
    name: v.name,
    org: v.org,
    department: v.department,
    criticality: v.criticality,
    has_login: v.has_login,
    sso: v.sso,
    mfa: v.mfa,
    user_count: v.user_count,
    cost_annual: v.cost_annual,
    description: v.description,
    url: v.url,
  };
}

// ── Tool 3: query_resources ──
// Direct SQLite read from resource_inventory table

server.tool(
  "query_resources",
  "Search the AWS resource inventory (auto-discovered EC2, EMR, RDS, SQS, Lambda, etc.). Find resources by name, type, or region.",
  {
    action: z.enum(["search", "list", "stats"]).describe(
      "search=find by name/keyword, list=all resources, stats=counts by type"
    ),
    query: z.string().optional().describe("Resource name or keyword to search"),
    resource_type: z.string().optional().describe("Filter by type: ec2_instance, emr_cluster, sqs_queue, etc."),
    limit: z.number().optional().default(20).describe("Max results"),
  },
  async ({ action, query, resource_type, limit }) => {
    const db = getDb();
    if (!db) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Cache DB not available" }) }] };
    }
    try {
      let result: any;
      switch (action) {
        case "search": {
          if (!query) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "query required" }) }] };
          const like = `%${query.toLowerCase()}%`;
          let rows;
          if (resource_type) {
            rows = db.query(`
              SELECT resource_id, resource_name, resource_type, cloud, account_id, region, state
              FROM resource_inventory
              WHERE is_stale = 0 AND resource_type = $type
                AND (LOWER(resource_name) LIKE $like OR name_tokens LIKE $like)
              LIMIT $limit
            `).all({ $type: resource_type, $like: like, $limit: limit });
          } else {
            rows = db.query(`
              SELECT resource_id, resource_name, resource_type, cloud, account_id, region, state
              FROM resource_inventory
              WHERE is_stale = 0
                AND (LOWER(resource_name) LIKE $like OR name_tokens LIKE $like)
              LIMIT $limit
            `).all({ $like: like, $limit: limit });
          }
          result = { action: "search", query, count: (rows as any[]).length, resources: rows };
          break;
        }
        case "list": {
          const rows = resource_type
            ? db.query(`SELECT resource_id, resource_name, resource_type, cloud, account_id, region, state
                        FROM resource_inventory WHERE is_stale = 0 AND resource_type = $type LIMIT $limit`)
                .all({ $type: resource_type, $limit: limit })
            : db.query(`SELECT resource_id, resource_name, resource_type, cloud, account_id, region, state
                        FROM resource_inventory WHERE is_stale = 0 LIMIT $limit`)
                .all({ $limit: limit });
          result = { action: "list", count: (rows as any[]).length, resources: rows };
          break;
        }
        case "stats": {
          const total = (db.query("SELECT COUNT(*) as c FROM resource_inventory WHERE is_stale = 0").get() as any)?.c || 0;
          const stale = (db.query("SELECT COUNT(*) as c FROM resource_inventory WHERE is_stale = 1").get() as any)?.c || 0;
          const byType = db.query(
            "SELECT resource_type, COUNT(*) as c FROM resource_inventory WHERE is_stale = 0 GROUP BY resource_type"
          ).all();
          result = { action: "stats", total, stale, by_type: byType };
          break;
        }
      }
      db.close();
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      db.close();
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }] };
    }
  }
);

// ── Tool 4: triage_overview ──
// Pipeline statistics and recent actionable items

server.tool(
  "triage_overview",
  "Get triage pipeline overview — classification stats, recent actionable items, investigation status. Useful for understanding current alert load.",
  {
    action: z.enum(["stats", "actionable", "investigated", "stale"]).describe(
      "stats=pipeline counts, actionable=uninvestigated items, investigated=ready for task, stale=exhausted retries"
    ),
    limit: z.number().optional().default(10).describe("Max results for list actions"),
  },
  async ({ action, limit }) => {
    const db = getDb();
    if (!db) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Cache DB not available" }) }] };
    }
    try {
      let result: any;
      switch (action) {
        case "stats": {
          const total = (db.query("SELECT COUNT(*) as c FROM triage_results").get() as any)?.c || 0;
          const byAction = db.query("SELECT action, COUNT(*) as c FROM triage_results GROUP BY action").all();
          const byLayer = db.query("SELECT classified_by, COUNT(*) as c FROM triage_results GROUP BY classified_by").all();
          const byStatus = db.query(
            "SELECT COALESCE(investigation_status, 'not_started') as status, COUNT(*) as c FROM triage_results WHERE action IN ('QUEUE','NOTIFY') GROUP BY investigation_status"
          ).all();
          result = { action: "stats", total, by_action: byAction, by_layer: byLayer, investigation_status: byStatus };
          break;
        }
        case "actionable": {
          const rows = db.query(`
            SELECT id, subject, sender, urgency, action, summary, domain, classified_at
            FROM triage_results
            WHERE action IN ('QUEUE','NOTIFY') AND task_id IS NULL AND domain = 'work' AND investigation_status IS NULL
            ORDER BY CASE urgency WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, classified_at DESC
            LIMIT $limit
          `).all({ $limit: limit });
          result = { action: "actionable", count: (rows as any[]).length, items: rows };
          break;
        }
        case "investigated": {
          const rows = db.query(`
            SELECT id, subject, sender, urgency, summary, investigation_status, SUBSTR(investigation_result,1,500) as result_preview
            FROM triage_results
            WHERE investigation_status = 'substantial' AND task_id IS NULL AND domain = 'work'
            GROUP BY dedup_hash
            ORDER BY classified_at DESC LIMIT $limit
          `).all({ $limit: limit });
          result = { action: "investigated", count: (rows as any[]).length, items: rows };
          break;
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
          result = { action: "stale", count: (rows as any[]).length, items: rows };
          break;
        }
      }
      db.close();
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      db.close();
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }] };
    }
  }
);

// ── Tool 5: run_windmill_script (fallback for scripts not auto-discovered) ──

server.tool(
  "run_windmill_script",
  "Execute any Windmill script by path. Use this for newly created scripts or scripts not auto-discovered at startup.",
  {
    script_path: z.string().describe("Script path in Windmill, e.g. f/investigate/test_tool"),
    args_json: z.string().optional().default("{}").describe("Script arguments as JSON string"),
  },
  async ({ script_path, args_json }) => {
    if (!WINDMILL_TOKEN) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "WINDMILL_TOKEN not set" }) }] };
    }
    let args: Record<string, any>;
    try {
      args = JSON.parse(args_json);
    } catch {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Invalid JSON in args_json" }) }] };
    }
    return await runWindmillScript(script_path, args);
  }
);

// ── Windmill Script Proxy ──

async function runWindmillScript(
  path: string,
  args: Record<string, any>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    const resp = await fetch(
      `${WINDMILL_BASE}/api/w/${WINDMILL_WORKSPACE}/jobs/run_wait_result/p/${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${WINDMILL_TOKEN}`,
        },
        body: JSON.stringify(args),
      },
    );
    if (!resp.ok) {
      const text = await resp.text();
      return { content: [{ type: "text", text: JSON.stringify({ error: `Windmill ${resp.status}: ${text}` }) }] };
    }
    const data = await resp.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }] };
  }
}

// ── Dynamic Windmill Tool Discovery ──
// At startup, queries Windmill API for scripts in f/investigate/ and f/devops/,
// then registers each as an individual MCP tool with typed parameters.

async function discoverAndRegisterWindmillTools() {
  if (!WINDMILL_TOKEN) {
    console.error("[mcp] No WINDMILL_TOKEN — skipping dynamic discovery");
    return;
  }

  // Scripts to skip (this server itself, or already handled statically)
  const skipPaths = new Set([
    "f/devops/mcp_server",
  ]);
  // Only register tools from these folder prefixes
  const allowedPrefixes = ["f/investigate/", "f/devops/"];

  let registered = 0;

  try {
    const resp = await fetch(
      `${WINDMILL_BASE}/api/w/${WINDMILL_WORKSPACE}/scripts/list?per_page=200`,
      { headers: { Authorization: `Bearer ${WINDMILL_TOKEN}` } },
    );
    if (!resp.ok) {
      console.error(`[mcp] Failed to list scripts: ${resp.status}`);
      return;
    }

    const rawScripts = await resp.json() as Array<{
      path: string;
      summary: string;
      description: string;
    }>;

    // Deduplicate by path and filter to allowed folders
    const seen = new Set<string>();
    const scripts = rawScripts.filter((s) => {
      if (seen.has(s.path)) return false;
      seen.add(s.path);
      return allowedPrefixes.some((p) => s.path.startsWith(p));
    });

    // Fetch schemas in parallel (list endpoint doesn't include schemas)
    const schemaPromises = scripts
      .filter((s) => !skipPaths.has(s.path))
      .map(async (s) => {
        try {
          const r = await fetch(
            `${WINDMILL_BASE}/api/w/${WINDMILL_WORKSPACE}/scripts/get/p/${s.path}`,
            { headers: { Authorization: `Bearer ${WINDMILL_TOKEN}` } },
          );
          if (!r.ok) return { ...s, schema: null };
          const detail = await r.json() as { schema: any; summary: string; description: string };
          return { ...s, schema: detail.schema, summary: detail.summary || s.summary, description: detail.description || s.description };
        } catch {
          return { ...s, schema: null };
        }
      });

    const scriptsWithSchemas = await Promise.all(schemaPromises);

    for (const script of scriptsWithSchemas) {
      if (skipPaths.has(script.path)) continue;

        // Convert Windmill path to MCP tool name: f/investigate/get_ec2_instances → investigate_get_ec2_instances
        const parts = script.path.split("/");
        const toolName = parts.length >= 3 ? `${parts[1]}_${parts[2]}` : `wm_${parts.pop()}`;
        const description = script.summary || script.description || `Windmill script: ${script.path}`;

        // Convert Windmill JSON Schema to Zod schema for MCP
        const zodShape: Record<string, z.ZodTypeAny> = {};
        const props = script.schema?.properties || {};
        const required = new Set(script.schema?.required || []);

        for (const [name, prop] of Object.entries(props)) {
          let field: z.ZodTypeAny;

          if (prop.enum && Array.isArray(prop.enum)) {
            field = z.enum(prop.enum as [string, ...string[]]);
          } else {
            switch (prop.type) {
              case "number":
              case "integer":
                field = z.number();
                break;
              case "boolean":
                field = z.boolean();
                break;
              case "array":
                field = z.array(z.any());
                break;
              case "object":
                field = z.record(z.any());
                break;
              default:
                field = z.string();
            }
          }

          if (prop.description) field = field.describe(prop.description);
          if (prop.default !== undefined && prop.default !== null) {
            field = field.optional().default(prop.default);
          } else if (!required.has(name)) {
            field = field.optional();
          }

          zodShape[name] = field;
        }

        try {
          const scriptPath = script.path;
          server.tool(
            toolName,
            description,
            zodShape,
            async (args: Record<string, any>) => {
              // Pass validated args directly to Windmill
              return await runWindmillScript(scriptPath, args);
            },
          );
          registered++;
        } catch (e: any) {
          console.error(`[mcp] Failed to register ${toolName}: ${e.message}`);
        }
      }
  } catch (e: any) {
    console.error(`[mcp] Discovery error: ${e.message}`);
  }

  console.error(`[mcp] Registered ${registered} Windmill tools via auto-discovery`);
}

// ── Start ──

await discoverAndRegisterWindmillTools();
const transport = new StdioServerTransport();
await server.connect(transport);
