// Windmill Script: Tag Triage Emails
// Tags substantial investigation results as Outlook categories on the original emails.
// Categories: "Triage: {urgency}" + "Finding: {root_cause}" for quick scanning.
// Only adds categories — never modifies email content, moves, or deletes.

import { Database } from "bun:sqlite";

const DB_PATH = "/local/cache/triage/index.db";

// ── Windmill variable helper ──

async function getVariable(path: string): Promise<string | undefined> {
  const base = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
  const token = process.env.WM_TOKEN;
  const workspace = process.env.WM_WORKSPACE || "imladris";
  if (!token) return undefined;
  try {
    const resp = await fetch(
      `${base}/api/w/${workspace}/variables/get_value/${path}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) return undefined;
    const val = await resp.text();
    const parsed = val.startsWith('"') ? JSON.parse(val) : val;
    return parsed.trim();
  } catch {
    return undefined;
  }
}

// ── Graph API auth ──

async function getGraphToken(): Promise<string> {
  const tenantId = await getVariable("f/devops/m365_tenant_id");
  const clientId = await getVariable("f/devops/m365_client_id");
  const clientSecret = await getVariable("f/devops/m365_client_secret");
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("M365 credentials not configured in Windmill variables");
  }
  const resp = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }),
    },
  );
  if (!resp.ok) throw new Error(`Token request failed: ${resp.status}`);
  return (await resp.json()).access_token;
}

// ── Tag email via Graph API ──

async function tagEmail(
  token: string,
  userId: string,
  messageId: string,
  categories: string[],
): Promise<{ ok: boolean; status: number; error?: string }> {
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${userId}/messages/${messageId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ categories }),
    },
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return { ok: false, status: resp.status, error: body.slice(0, 200) };
  }
  return { ok: true, status: resp.status };
}

// ── Main ──

export async function main(
  status_filter: string = "substantial",
  dry_run: boolean = false,
  clear_tags: boolean = false,
) {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");

  // Get items with investigation results, grouped by unique message_id
  const rows = db.prepare(`
    SELECT message_id, subject, sender, urgency, investigation_result,
           GROUP_CONCAT(DISTINCT action) as actions
    FROM triage_results
    WHERE investigation_status = ?
      AND source = 'm365'
      AND message_id != ''
    GROUP BY message_id
    ORDER BY
      CASE urgency WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END
  `).all(status_filter) as any[];

  if (rows.length === 0) {
    db.close();
    return { tagged: 0, message: `No ${status_filter} m365 items found` };
  }

  const userId = "sfoley@buxtonco.com";

  // Build tag plan
  const tagPlan: Array<{
    messageId: string;
    subject: string;
    categories: string[];
  }> = [];

  for (const row of rows) {
    const categories: string[] = [];

    if (clear_tags) {
      // Empty categories array clears all tags
      tagPlan.push({ messageId: row.message_id, subject: row.subject, categories: [] });
      continue;
    }

    // Urgency category
    const urg = (row.urgency || "medium").charAt(0).toUpperCase() + (row.urgency || "medium").slice(1);
    categories.push(`Triage: ${urg}`);

    // Root cause as finding
    try {
      const inv = JSON.parse(row.investigation_result || "{}");
      if (inv.diagnosis?.root_cause) {
        const cause = inv.diagnosis.root_cause
          .replace(/\s+/g, " ")
          .replace(/,/g, ";")  // commas break Outlook categories
          .trim()
          .slice(0, 80);
        categories.push(`Finding: ${cause}`);
      }
    } catch { /* no investigation result */ }

    tagPlan.push({ messageId: row.message_id, subject: row.subject, categories });
  }

  if (dry_run) {
    db.close();
    return {
      dry_run: true,
      count: tagPlan.length,
      plan: tagPlan.map(p => ({
        subject: (p.subject || "").slice(0, 80),
        categories: p.categories,
      })),
    };
  }

  // Authenticate and tag
  const graphToken = await getGraphToken();
  let tagged = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const plan of tagPlan) {
    const result = await tagEmail(graphToken, userId, plan.messageId, plan.categories);
    if (result.ok) {
      tagged++;
    } else {
      failed++;
      errors.push(`${(plan.subject || "").slice(0, 50)}: ${result.status} ${result.error || ""}`);
    }
  }

  db.close();

  return {
    status_filter,
    total_unique_emails: tagPlan.length,
    tagged,
    failed,
    errors: errors.slice(0, 10),
    clear_tags,
  };
}
