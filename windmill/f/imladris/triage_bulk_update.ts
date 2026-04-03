// Windmill Script: Triage Bulk Update
// Handles bulk actions on triage items that require Windmill access:
//   - "investigate": triggers investigation pipeline for each item
//   - "ticket": creates SDP ticket for each item
// "dismiss" and "escalate" are handled directly in server.ts via SQLite.

import { Database } from "bun:sqlite";

const CACHE_DB = process.env.CACHE_DIR
  ? `${process.env.CACHE_DIR}/index.db`
  : "/local/cache/triage/index.db";

const BASE = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
const TOKEN = process.env.WM_TOKEN;
const WS = process.env.WM_WORKSPACE || "imladris";

async function runWindmillScript(scriptPath: string, args: Record<string, unknown>): Promise<string | null> {
  if (!TOKEN) return null;
  try {
    const resp = await fetch(
      `${BASE}/api/w/${WS}/jobs/run/p/${scriptPath}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      },
    );
    if (!resp.ok) return null;
    return (await resp.text()).trim().replace(/^"|"$/g, "");
  } catch {
    return null;
  }
}

type TriageItem = {
  id: number;
  source: string;
  message_id: string;
  subject: string;
  sender: string;
  body?: string;
  summary: string;
  action: string;
  urgency: string;
  domain: string;
  metadata: string;
};

export async function main(args: {
  ids: number[];
  bulk_action: "investigate" | "ticket";
  notes?: string;
}): Promise<{ ok: boolean; processed: number; results: Array<{ id: number; job_id?: string | null; error?: string }> }> {
  const { ids, bulk_action, notes } = args;

  if (!ids || ids.length === 0) {
    return { ok: true, processed: 0, results: [] };
  }

  // Load items from SQLite
  let items: TriageItem[] = [];
  try {
    const db = new Database(CACHE_DB, { readonly: true });
    const placeholders = ids.map(() => "?").join(",");
    items = db.query<TriageItem, number[]>(
      `SELECT id, source, message_id, subject, sender, summary, action, urgency, domain, metadata
       FROM triage_results WHERE id IN (${placeholders})`,
    ).all(...ids);
    db.close();
  } catch (e: any) {
    return { ok: false, processed: 0, results: [{ id: -1, error: `DB error: ${e.message}` }] };
  }

  const results: Array<{ id: number; job_id?: string | null; error?: string }> = [];

  for (const item of items) {
    if (bulk_action === "investigate") {
      const jobId = await runWindmillScript("f/core/investigate", {
        source: item.source,
        message_id: item.message_id,
        subject: item.subject,
        sender: item.sender,
        content: item.summary,
        urgency: item.urgency,
        domain: item.domain,
        triage_id: item.id,
        notes: notes || "",
      });
      results.push({ id: item.id, job_id: jobId });

    } else if (bulk_action === "ticket") {
      const jobId = await runWindmillScript("f/domains/work/actions/close_ticket", {
        triage_id: item.id,
        subject: item.subject,
        summary: item.summary,
        sender: item.sender,
        urgency: item.urgency,
        notes: notes || "",
      });
      results.push({ id: item.id, job_id: jobId });
    }
  }

  const processed = results.filter((r) => !r.error).length;
  return { ok: true, processed, results };
}
