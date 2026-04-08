// Minimal Bun server serving the status dashboard
// Proxies API calls to Windmill on localhost:8000
// Auth injected server-side so browser needs no token
// Triage endpoints query SQLite directly (DB is on host, not in Docker workers)
// Session/MCP/AI activity endpoints query Postgres + MCP log + Windmill API

import { Database } from "bun:sqlite";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import pg from "pg";

const WINDMILL = process.env.WINDMILL_URL || "http://127.0.0.1:8000";
const WM_TOKEN = "nPrsox6CPhsQuRBrCUSj2p9BmxgRMdpS";
const WS = "imladris";
const PORT = 3100;
const TRIAGE_DB = "/local/cache/triage/index.db";
const HOME = process.env.HOME || "/home/ec2-user";
const MCP_LOG = `${HOME}/.claude/logs/mcp-calls.jsonl`;
const MEMORY_WORK = `${HOME}/.claude/MEMORY/WORK`;
const POSTGRES_URL = process.env.POSTGRES_URL || "";

// Postgres pool for session/AI activity queries (lazy init)
let pgPool: pg.Pool | null = null;
function getPg(): pg.Pool | null {
  if (!POSTGRES_URL) return null;
  if (!pgPool) pgPool = new pg.Pool({ connectionString: POSTGRES_URL, max: 2 });
  return pgPool;
}

const HTML = await Bun.file(import.meta.dir + "/index.html").text();

function openDb(readonly: boolean): Database | null {
  try {
    return new Database(TRIAGE_DB, { readonly, create: false });
  } catch {
    return null;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // ── GET /triage/queue — live triage items from SQLite ──
    if (url.pathname === "/triage/queue" && req.method === "GET") {
      const action = url.searchParams.get("action") || "";
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
      const offset = parseInt(url.searchParams.get("offset") || "0");

      const db = openDb(true);
      if (!db) return json({ items: [], total: 0 });

      try {
        const hasFilter = action && action !== "all";
        const baseWhere = hasFilter
          ? "WHERE action = ? AND marked_read = 0"
          : "WHERE marked_read = 0";
        const filterArgs = hasFilter ? [action] : [];

        const total = (db.query<{ count: number }, unknown[]>(
          `SELECT COUNT(*) as count FROM triage_results ${baseWhere}`,
        ).get(...filterArgs) as { count: number } | null)?.count ?? 0;

        const items = db.query(
          `SELECT id, source, message_id, subject, sender, received_at, action, urgency,
                  summary, domain, classified_by, classified_at, investigation_status,
                  occurrence_count, entities, alert_type, source_system
           FROM triage_results ${baseWhere}
           ORDER BY classified_at DESC
           LIMIT ? OFFSET ?`,
        ).all(...filterArgs, limit, offset);

        db.close();
        return json({ items, total });
      } catch (e: any) {
        db.close();
        return json({ items: [], total: 0, error: e.message });
      }
    }

    // ── POST /triage/bulk — bulk actions on selected items ──
    if (url.pathname === "/triage/bulk" && req.method === "POST") {
      let body: { ids: number[]; bulk_action: string; notes?: string };
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, error: "invalid JSON" }, 400);
      }

      const { ids, bulk_action, notes } = body;
      if (!ids?.length) return json({ ok: true, affected: 0 });
      const placeholders = ids.map(() => "?").join(",");

      // dismiss + escalate: direct SQLite writes on host
      if (bulk_action === "dismiss" || bulk_action === "escalate") {
        const db = openDb(false);
        if (!db) return json({ ok: false, error: "DB not available" }, 503);
        try {
          if (bulk_action === "dismiss") {
            db.run(`UPDATE triage_results SET marked_read = 1 WHERE id IN (${placeholders})`, ids);
          } else {
            db.run(`UPDATE triage_results SET urgency = 'critical' WHERE id IN (${placeholders})`, ids);
          }
          db.close();
          return json({ ok: true, affected: ids.length });
        } catch (e: any) {
          db.close();
          return json({ ok: false, error: e.message }, 500);
        }
      }

      // investigate + ticket: delegate to Windmill job (async pipeline access)
      if (bulk_action === "investigate" || bulk_action === "ticket") {
        try {
          const resp = await fetch(
            `${WINDMILL}/api/w/${WS}/jobs/run/p/f/imladris/triage_bulk_update`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${WM_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ ids, bulk_action, notes }),
            },
          );
          if (!resp.ok) return json({ ok: false, error: `Windmill error: ${resp.status}` }, 502);
          const jobId = (await resp.text()).trim().replace(/^"|"$/g, "");
          return json({ ok: true, affected: ids.length, job_id: jobId });
        } catch (e: any) {
          return json({ ok: false, error: e.message }, 500);
        }
      }

      return json({ ok: false, error: `Unknown action: ${bulk_action}` }, 400);
    }

    // ── GET /integrations — All authenticated data sources ──
    if (url.pathname === "/integrations" && req.method === "GET") {
      const domain = url.searchParams.get("domain") || "";
      try {
        const body: any = { action: "list" };
        if (domain) body.domain_filter = domain;
        const resp = await fetch(
          `${WINDMILL}/api/w/${WS}/jobs/run_wait_result/p/f/infra/integration_registry`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${WM_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        );
        if (!resp.ok) return json({ error: `Windmill error: ${resp.status}` }, 502);
        return json(await resp.json());
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // ── GET /wip — Work-In-Progress limit status ──
    if (url.pathname === "/wip" && req.method === "GET") {
      try {
        const resp = await fetch(
          `${WINDMILL}/api/w/${WS}/jobs/run_wait_result/p/f/core/wip_gate`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${WM_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ action: "status" }),
          }
        );
        if (!resp.ok) return json({ error: `Windmill error: ${resp.status}` }, 502);
        return json(await resp.json());
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // ── GET /sessions — recent discussions/sessions ──
    if (url.pathname === "/sessions" && req.method === "GET") {
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
      try {
        // Read WORK directories (each is a session with a PRD)
        const dirs = readdirSync(MEMORY_WORK)
          .filter(d => statSync(join(MEMORY_WORK, d)).isDirectory())
          .sort().reverse()
          .slice(0, limit);

        const sessions = dirs.map(d => {
          const prdPath = join(MEMORY_WORK, d, "PRD.md");
          let title = d;
          let phase = "unknown";
          let effort = "unknown";
          if (existsSync(prdPath)) {
            const content = readFileSync(prdPath, "utf8").slice(0, 500);
            const taskMatch = content.match(/^task:\s*(.+)$/m);
            const phaseMatch = content.match(/^phase:\s*(.+)$/m);
            const effortMatch = content.match(/^effort:\s*(.+)$/m);
            if (taskMatch) title = taskMatch[1].trim();
            if (phaseMatch) phase = phaseMatch[1].trim();
            if (effortMatch) effort = effortMatch[1].trim();
          }
          const dateMatch = d.match(/^(\d{8})/);
          const date = dateMatch ? `${dateMatch[1].slice(0,4)}-${dateMatch[1].slice(4,6)}-${dateMatch[1].slice(6,8)}` : d;
          return { slug: d, title, phase, effort, date };
        });

        return json({ sessions, total: dirs.length });
      } catch (e: any) {
        return json({ sessions: [], error: e.message }, 500);
      }
    }

    // ── GET /mcp-calls — MCP tool call audit log ──
    if (url.pathname === "/mcp-calls" && req.method === "GET") {
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 500);
      const session = url.searchParams.get("session") || "";
      try {
        if (!existsSync(MCP_LOG)) return json({ calls: [], total: 0 });
        const lines = readFileSync(MCP_LOG, "utf8").trim().split("\n").filter(Boolean);
        let calls = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        if (session) calls = calls.filter((c: any) => c.session_id?.includes(session));
        calls.reverse(); // newest first
        const total = calls.length;
        calls = calls.slice(0, limit);
        return json({ calls, total });
      } catch (e: any) {
        return json({ calls: [], error: e.message }, 500);
      }
    }

    // ── GET /ai-activity — Windmill job history + Postgres AI stats ──
    if (url.pathname === "/ai-activity" && req.method === "GET") {
      const hours = parseInt(url.searchParams.get("hours") || "24");
      try {
        // Windmill job history
        const jobResp = await fetch(
          `${WINDMILL}/api/w/${WS}/jobs/completed/list?per_page=50&order_desc=true`,
          { headers: { Authorization: `Bearer ${WM_TOKEN}` } }
        );
        const jobs = jobResp.ok ? await jobResp.json() : [];

        // Postgres stats (if available)
        let pgStats: any = null;
        const pool = getPg();
        if (pool) {
          try {
            const { rows } = await pool.query(`
              SELECT
                (SELECT count(*) FROM core.memory_objects WHERE NOT deleted) as total_objects,
                (SELECT count(*) FROM core.memory_vectors) as total_embeddings,
                (SELECT count(*) FROM core.memory_lines) as total_lines,
                (SELECT count(*) FROM core.pai_system) as pai_components,
                (SELECT count(*) FROM palantir.tool_calls) as palantir_calls
            `);
            pgStats = rows[0];
          } catch { /* palantir schema may not exist yet */ }
        }

        // MCP call summary
        let mcpSummary: Record<string, number> = {};
        if (existsSync(MCP_LOG)) {
          const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
          const lines = readFileSync(MCP_LOG, "utf8").trim().split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.timestamp >= cutoff && entry.tool_name) {
                mcpSummary[entry.tool_name] = (mcpSummary[entry.tool_name] || 0) + 1;
              }
            } catch {}
          }
        }

        return json({
          windmill_jobs: (jobs as any[]).slice(0, 20).map((j: any) => ({
            script: j.script_path,
            started: j.created_at,
            duration_ms: j.duration_ms,
            success: j.success,
          })),
          mcp_calls_by_tool: mcpSummary,
          postgres: pgStats,
          period_hours: hours,
        });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // ── Proxy API calls to Windmill with server-side auth ──
    if (url.pathname.startsWith("/api/")) {
      const target = `${WINDMILL}${url.pathname}${url.search}`;
      const headers = new Headers(req.headers);
      headers.set("Authorization", `Bearer ${WM_TOKEN}`);
      const resp = await fetch(target, {
        method: req.method,
        headers,
        body: req.method !== "GET" ? await req.text() : undefined,
      });
      return new Response(resp.body, {
        status: resp.status,
        headers: {
          "Content-Type": resp.headers.get("Content-Type") || "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // ── Serve dashboard ──
    return new Response(HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`Status dashboard running on http://127.0.0.1:${PORT}`);
