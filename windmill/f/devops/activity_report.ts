// Windmill Script: Activity Report Generator
// Decision 26: Automatic daily/weekly activity reports
//
// Reads mcp-calls.jsonl + current-work.json to produce
// a manager-friendly summary. No ISC jargon.

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

interface McpLogEntry {
  timestamp: string;
  tool_name: string;
  direction: string;
  params?: Record<string, unknown>;
  duration_ms?: number;
}

interface Workstream {
  name: string;
  domain: string;
  status: string;
  phase: string | null;
  last_action: string | null;
  last_updated: string;
  criteria_summary: string;
  archived: boolean;
}

export async function main(
  period: string = "daily",
  format: string = "text",
) {
  const HOME = homedir();
  const mcpLogPath = join(HOME, ".claude", "logs", "mcp-calls.jsonl");
  const statePath = join(HOME, ".claude", "state", "current-work.json");

  const now = new Date();
  const cutoff = new Date(
    now.getTime() - (period === "weekly" ? 7 * 86400000 : 86400000),
  );

  // --- MCP Activity ---
  let mcpCalls: McpLogEntry[] = [];
  if (existsSync(mcpLogPath)) {
    try {
      const lines = readFileSync(mcpLogPath, "utf-8").trim().split("\n");
      mcpCalls = lines
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(
          (e): e is McpLogEntry =>
            e !== null && new Date(e.timestamp) >= cutoff,
        );
    } catch {
      // Log file unreadable
    }
  }

  // Summarize MCP calls by server
  const serverCounts: Record<string, number> = {};
  for (const call of mcpCalls) {
    if (call.direction !== "pre") continue;
    const parts = call.tool_name.split("__");
    const server = parts[1] || "unknown";
    serverCounts[server] = (serverCounts[server] || 0) + 1;
  }

  // --- Workstream Activity ---
  let workstreams: Workstream[] = [];
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      workstreams = (state.active_workstreams || []).filter(
        (w: Workstream) => !w.archived,
      );
    } catch {
      // State file unreadable
    }
  }

  // --- Build Report ---
  const periodLabel = period === "weekly" ? "Weekly" : "Daily";
  const dateRange =
    period === "weekly"
      ? `${cutoff.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)}`
      : now.toISOString().slice(0, 10);

  const report = {
    title: `${periodLabel} Activity Report`,
    period: dateRange,
    generated: now.toISOString(),
    summary: {
      mcp_calls_total: mcpCalls.filter((c) => c.direction === "pre").length,
      mcp_calls_by_server: serverCounts,
      active_workstreams: workstreams.length,
      workstream_details: workstreams.map((w) => ({
        name: w.name,
        domain: w.domain,
        status: w.status,
        progress: w.criteria_summary,
        last_activity: w.last_action,
      })),
    },
  };

  if (format === "text") {
    let text = `=== ${report.title} ===\n`;
    text += `Period: ${dateRange}\n\n`;
    text += `Tool Usage: ${report.summary.mcp_calls_total} MCP calls\n`;
    for (const [server, count] of Object.entries(serverCounts)) {
      text += `  ${server}: ${count} calls\n`;
    }
    text += `\nActive Workstreams: ${workstreams.length}\n`;
    for (const w of report.summary.workstream_details) {
      text += `  ${w.name} [${w.domain}] — ${w.status} (${w.progress})\n`;
      if (w.last_activity) text += `    Last: ${w.last_activity}\n`;
    }
    return { report: text };
  }

  return report;
}
