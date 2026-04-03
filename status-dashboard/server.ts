// Minimal Bun server serving the status dashboard
// Proxies API calls to Windmill on localhost:8000
// Auth injected server-side so browser needs no token
// Triage endpoints query SQLite directly (DB is on host, not in Docker workers)

import { Database } from "bun:sqlite";

const WINDMILL = process.env.WINDMILL_URL || "http://127.0.0.1:8000";
const WM_TOKEN = "nPrsox6CPhsQuRBrCUSj2p9BmxgRMdpS";
const WS = "imladris";
const PORT = 3100;
const TRIAGE_DB = "/local/cache/triage/index.db";

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
