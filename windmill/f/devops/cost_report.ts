// Windmill Script: Daily Cost Report
// Decision 26: Automatic daily reports — AWS cost breakdown via Steampipe
//
// Requires: steampipe with aws plugin configured

import { execSync } from "child_process";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();
const COST_LOG = join(HOME, ".claude", "logs", "cost-reports.jsonl");

interface CostEntry {
  service: string;
  cost: number;
}

function ensureDirs(): void {
  const logDir = join(HOME, ".claude", "logs");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
}

function steampipeAvailable(): boolean {
  try {
    execSync("which steampipe", { encoding: "utf-8", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

export async function main(
  lookback_days: number = 1,
  format: string = "text",
) {
  ensureDirs();

  if (!steampipeAvailable()) {
    return {
      error: "steampipe not installed or not in PATH",
      setup: "Install steampipe and the aws plugin: steampipe plugin install aws",
    };
  }

  const query = `select service, unblended_cost_amount::numeric as cost from aws_cost_by_service_daily where period_start >= now() - interval '${lookback_days} day' group by service, cost order by cost desc limit 20`;

  let entries: CostEntry[] = [];
  let totalCost = 0;

  try {
    const result = execSync(
      `steampipe query --output json "${query}"`,
      { encoding: "utf-8", timeout: 30000 },
    );

    const parsed = JSON.parse(result);
    const rows = parsed.rows || parsed || [];

    entries = rows.map((r: Record<string, unknown>) => ({
      service: String(r.service || "Unknown"),
      cost: Number(r.cost || 0),
    }));

    totalCost = entries.reduce((sum, e) => sum + e.cost, 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: "Steampipe query failed",
      detail: message,
      query,
    };
  }

  const now = new Date();

  // Log
  appendFileSync(
    COST_LOG,
    JSON.stringify({
      timestamp: now.toISOString(),
      lookback_days,
      total_cost: Math.round(totalCost * 100) / 100,
      service_count: entries.length,
      top_service: entries[0]?.service || "none",
      top_cost: entries[0]?.cost || 0,
    }) + "\n",
  );

  const report = {
    generated: now.toISOString(),
    lookback_days,
    total_cost: Math.round(totalCost * 100) / 100,
    service_count: entries.length,
    services: entries.map((e) => ({
      service: e.service,
      cost: Math.round(e.cost * 100) / 100,
    })),
  };

  if (format === "text") {
    let text = `=== AWS Cost Report ===\n`;
    text += `Period: Last ${lookback_days} day(s)\n`;
    text += `Generated: ${now.toISOString().slice(0, 16).replace("T", " ")}\n\n`;
    text += `Total: $${report.total_cost.toFixed(2)}\n\n`;
    text += `Service Breakdown:\n`;

    for (const s of report.services) {
      const pct =
        totalCost > 0 ? ((s.cost / totalCost) * 100).toFixed(1) : "0.0";
      text += `  ${s.service}: $${s.cost.toFixed(2)} (${pct}%)\n`;
    }

    if (entries.length === 0) {
      text += `  No cost data found for the specified period.\n`;
    }

    return { report: text };
  }

  return report;
}
