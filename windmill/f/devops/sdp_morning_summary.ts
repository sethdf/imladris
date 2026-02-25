// Windmill Script: SDP Morning Summary
// Decision 26: Automatic daily reports — ticket-focused morning briefing
//
// Requires Windmill variables:
//   f/devops/sdp_base_url   — e.g., https://sdpondemand.manageengine.com/app/itdesk/api/v3
//   f/devops/sdp_api_key    — Zoho OAuth access token (refreshed by refresh_sdp_token cron)

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { shouldCatchUp, recordRun, type CatchupInfo } from "./catchup_lib.ts";

const HOME = homedir();
const SUMMARY_LOG = join(HOME, ".claude", "logs", "morning-summaries.jsonl");

const SDP_HEADERS = {
  Accept: "application/vnd.manageengine.sdp.v3+json",
  "Content-Type": "application/x-www-form-urlencoded",
};

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

interface Ticket {
  id: string;
  subject: string;
  status: { name: string };
  priority: { name: string };
  technician: { name: string } | null;
  created_time: { display_value: string; value: string };
  last_updated_time: { display_value: string; value: string };
}

async function fetchTickets(
  baseUrl: string,
  apiKey: string,
  criteria: Record<string, unknown>[],
  rowCount: number = 100,
): Promise<Ticket[]> {
  const listInfo: Record<string, unknown> = {
    list_info: {
      row_count: rowCount,
      sort_field: "created_time",
      sort_order: "desc",
      ...(criteria.length > 0 ? { search_criteria: criteria } : {}),
    },
  };

  const url = `${baseUrl}/requests?input_data=${encodeURIComponent(JSON.stringify(listInfo))}`;

  const response = await fetch(url, {
    headers: {
      ...SDP_HEADERS,
      Authorization: `Zoho-oauthtoken ${apiKey}`,
    },
  });

  if (!response.ok) return [];
  const data = await response.json();
  return data.requests || [];
}

function ensureDirs(): void {
  const logDir = join(HOME, ".claude", "logs");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
}

const TWENTY_FOUR_HOURS_MS = 24 * 3600000;

export async function main(
  technician: string = "",
  format: string = "text",
) {
  // Cron catchup: detect missed runs after instance downtime (weekday 8 AM schedule)
  const catchup = shouldCatchUp("sdp_morning_summary", TWENTY_FOUR_HOURS_MS);

  const baseUrl = await getVariable("f/devops/sdp_base_url");
  const apiKey = await getVariable("f/devops/sdp_api_key");

  if (!baseUrl || !apiKey) {
    return {
      error: "SDP credentials not configured",
      setup: "Set f/devops/sdp_base_url and f/devops/sdp_api_key in Windmill variables",
    };
  }

  ensureDirs();

  const openStatuses = ["Open", "In Progress", "On Hold", "Pending"];
  const openCriteria = openStatuses.map((s) => ({
    field: "status.name",
    condition: "is",
    value: s,
    logical_operator: "OR",
  }));

  const allOpen = await fetchTickets(baseUrl, apiKey, openCriteria);

  // Cache tickets for cross-source correlation
  try {
    const { store, isAvailable, init } = await import("./cache_lib.ts");
    if (isAvailable()) {
      init();
      for (const t of allOpen) {
        store(
          "sdp", "ticket", String(t.id),
          t.subject || "",
          `${t.subject || ""} ${t.status?.name || ""} ${t.priority?.name || ""} ${t.technician?.name || ""}`,
          t
        );
      }
    }
  } catch { /* cache unavailable */ }

  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 86400000);

  // Priority breakdown
  const byPriority: Record<string, number> = {};
  for (const t of allOpen) {
    const p = t.priority?.name || "Unset";
    byPriority[p] = (byPriority[p] || 0) + 1;
  }

  // Assigned to technician
  const assignedToTech = technician
    ? allOpen.filter(
        (t) =>
          t.technician?.name?.toLowerCase() === technician.toLowerCase(),
      )
    : [];

  // Critical/High
  const criticalHigh = allOpen.filter((t) => {
    const p = t.priority?.name?.toLowerCase() || "";
    return p === "critical" || p === "high";
  });

  // Updated in last 24h
  const recentlyUpdated = allOpen.filter((t) => {
    const updated = t.last_updated_time?.value;
    if (!updated) return false;
    return new Date(updated) >= twentyFourHoursAgo;
  });

  const summary = {
    generated: now.toISOString(),
    total_open: allOpen.length,
    by_priority: byPriority,
    critical_high: criticalHigh.map((t) => ({
      id: t.id,
      subject: t.subject,
      priority: t.priority?.name,
      status: t.status?.name,
      technician: t.technician?.name || "Unassigned",
    })),
    assigned_to_technician: technician
      ? {
          technician,
          count: assignedToTech.length,
          tickets: assignedToTech.map((t) => ({
            id: t.id,
            subject: t.subject,
            priority: t.priority?.name,
            status: t.status?.name,
          })),
        }
      : null,
    recently_updated: {
      count: recentlyUpdated.length,
      tickets: recentlyUpdated.slice(0, 10).map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status?.name,
        last_updated: t.last_updated_time?.display_value,
      })),
    },
  };

  // Log
  appendFileSync(
    SUMMARY_LOG,
    JSON.stringify({
      timestamp: now.toISOString(),
      total_open: summary.total_open,
      critical_high_count: criticalHigh.length,
      technician_count: assignedToTech.length,
    }) + "\n",
  );

  if (format === "text") {
    let text = `=== SDP Morning Summary ===\n`;
    text += `Generated: ${now.toISOString().slice(0, 16).replace("T", " ")}\n\n`;

    text += `Open Tickets: ${allOpen.length}\n`;
    text += `Priority Breakdown:\n`;
    for (const [priority, count] of Object.entries(byPriority).sort(
      ([, a], [, b]) => b - a,
    )) {
      text += `  ${priority}: ${count}\n`;
    }

    if (criticalHigh.length > 0) {
      text += `\nCritical/High Priority (${criticalHigh.length}):\n`;
      for (const t of criticalHigh) {
        text += `  #${t.id} [${t.priority?.name}] ${t.subject} (${t.status?.name}) — ${t.technician?.name || "Unassigned"}\n`;
      }
    } else {
      text += `\nNo critical/high priority tickets.\n`;
    }

    if (technician && assignedToTech.length > 0) {
      text += `\nAssigned to ${technician} (${assignedToTech.length}):\n`;
      for (const t of assignedToTech) {
        text += `  #${t.id} [${t.priority?.name}] ${t.subject} (${t.status?.name})\n`;
      }
    } else if (technician) {
      text += `\nNo tickets assigned to ${technician}.\n`;
    }

    text += `\nUpdated in Last 24h: ${recentlyUpdated.length}\n`;
    for (const t of recentlyUpdated.slice(0, 10)) {
      text += `  #${t.id} ${t.subject} — ${t.last_updated_time?.display_value}\n`;
    }

    recordRun("sdp_morning_summary");
    return { report: text, ...(catchup.catchup_triggered ? { catchup } : {}) };
  }

  recordRun("sdp_morning_summary");
  return { ...summary, ...(catchup.catchup_triggered ? { catchup } : {}) };
}
