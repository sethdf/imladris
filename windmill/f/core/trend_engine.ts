// Windmill Script: Time-Series Trend Engine
// Phase 6 Gap #5: "Is this getting worse over 3 months?"
//
// Reads event/triage/feed logs, aggregates by time bucket,
// detects trends (increasing/decreasing/stable).

import { readFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const HOME = homedir();

interface LogEntry {
  timestamp?: string;
  collected_at?: string;
  [key: string]: unknown;
}

interface Bucket {
  period: string;
  count: number;
}

interface TrendResult {
  metric: string;
  period_type: string;
  buckets: Bucket[];
  trend: "increasing" | "decreasing" | "stable" | "insufficient_data";
  change_pct: number;
  description: string;
}

function readJsonlTimestamped(path: string): LogEntry[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((e): e is LogEntry => e !== null);
  } catch {
    return [];
  }
}

function getTimestamp(entry: LogEntry): Date | null {
  const ts = entry.timestamp || entry.collected_at;
  if (!ts) return null;
  try { return new Date(ts as string); } catch { return null; }
}

function bucketize(
  entries: LogEntry[],
  periodType: "day" | "week" | "month",
  lookbackDays: number,
): Bucket[] {
  const cutoff = new Date(Date.now() - lookbackDays * 86400000);
  const buckets: Record<string, number> = {};

  for (const entry of entries) {
    const ts = getTimestamp(entry);
    if (!ts || ts < cutoff) continue;

    let key: string;
    switch (periodType) {
      case "day":
        key = ts.toISOString().slice(0, 10);
        break;
      case "week": {
        const startOfWeek = new Date(ts);
        startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
        key = `W${startOfWeek.toISOString().slice(0, 10)}`;
        break;
      }
      case "month":
        key = ts.toISOString().slice(0, 7);
        break;
    }

    buckets[key] = (buckets[key] || 0) + 1;
  }

  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, count]) => ({ period, count }));
}

function detectTrend(buckets: Bucket[]): { trend: TrendResult["trend"]; change_pct: number } {
  if (buckets.length < 3) {
    return { trend: "insufficient_data", change_pct: 0 };
  }

  // Compare first half average to second half average
  const mid = Math.floor(buckets.length / 2);
  const firstHalf = buckets.slice(0, mid);
  const secondHalf = buckets.slice(mid);

  const avgFirst = firstHalf.reduce((s, b) => s + b.count, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((s, b) => s + b.count, 0) / secondHalf.length;

  if (avgFirst === 0 && avgSecond === 0) {
    return { trend: "stable", change_pct: 0 };
  }

  const changePct = avgFirst === 0
    ? 100
    : Math.round(((avgSecond - avgFirst) / avgFirst) * 100);

  if (changePct > 20) return { trend: "increasing", change_pct: changePct };
  if (changePct < -20) return { trend: "decreasing", change_pct: changePct };
  return { trend: "stable", change_pct: changePct };
}

interface AlertEntry {
  timestamp: string;
  metric: string;
  change_pct: number;
  threshold: number;
  trend: string;
  description: string;
}

function ensureLogDir(): string {
  const logDir = join(HOME, ".claude", "logs");
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
  return logDir;
}

function fireAlert(alert: AlertEntry): void {
  const logDir = ensureLogDir();
  const alertPath = join(logDir, "alerts.jsonl");
  appendFileSync(alertPath, JSON.stringify(alert) + "\n");

  try {
    const msg = `Trend alert: ${alert.metric} changed ${alert.change_pct}% exceeding ${alert.threshold}% threshold`;
    execSync(
      `curl -s -X POST http://localhost:8888/notify -H "Content-Type: application/json" -d '${JSON.stringify({ message: msg, title: "Trend Engine Alert" })}'`,
      { encoding: "utf-8", timeout: 5000 },
    );
  } catch {
    // Voice notification is best-effort — never block on failure
  }
}

export async function main(
  metric: string = "all",
  period: string = "week",
  lookback_days: number = 90,
  filter_field: string = "",
  filter_value: string = "",
  alert_threshold: number = 50,
  alert_on_increase: boolean = true,
) {
  const periodType = (["day", "week", "month"].includes(period) ? period : "week") as "day" | "week" | "month";

  // Available log sources
  const sources: Record<string, string> = {
    mcp_calls: join(HOME, ".claude", "logs", "mcp-calls.jsonl"),
    feed_events: join(HOME, ".claude", "logs", "feed-events.jsonl"),
    triage_feedback: join(HOME, ".claude", "logs", "triage-feedback.jsonl"),
    entity_extractions: join(HOME, ".claude", "logs", "entity-extractions.jsonl"),
  };

  const results: TrendResult[] = [];
  const metricsToAnalyze = metric === "all" ? Object.keys(sources) : [metric];

  for (const m of metricsToAnalyze) {
    const path = sources[m];
    if (!path) {
      results.push({
        metric: m,
        period_type: periodType,
        buckets: [],
        trend: "insufficient_data",
        change_pct: 0,
        description: `Unknown metric: ${m}. Available: ${Object.keys(sources).join(", ")}`,
      });
      continue;
    }

    let entries = readJsonlTimestamped(path);

    // Apply filter if specified
    if (filter_field && filter_value) {
      entries = entries.filter((e) => {
        const val = e[filter_field];
        return typeof val === "string" && val.toLowerCase().includes(filter_value.toLowerCase());
      });
    }

    const buckets = bucketize(entries, periodType, lookback_days);
    const { trend, change_pct } = detectTrend(buckets);

    let description: string;
    switch (trend) {
      case "increasing":
        description = `${m} is increasing (+${change_pct}% over ${lookback_days} days)`;
        break;
      case "decreasing":
        description = `${m} is decreasing (${change_pct}% over ${lookback_days} days)`;
        break;
      case "stable":
        description = `${m} is stable (${change_pct > 0 ? "+" : ""}${change_pct}% over ${lookback_days} days)`;
        break;
      default:
        description = `Not enough data for ${m} (need 3+ ${periodType}s of data)`;
    }

    results.push({ metric: m, period_type: periodType, buckets, trend, change_pct, description });
  }

  // Predictive alerting: check if any metric exceeds the alert threshold
  let alerts_fired = 0;
  for (const result of results) {
    const absChange = Math.abs(result.change_pct);
    if (absChange < alert_threshold) continue;

    // Check direction: alert_on_increase controls whether we alert on increases
    // We always alert on decreases (something dropping fast is worth knowing)
    if (result.trend === "increasing" && !alert_on_increase) continue;
    if (result.trend === "stable" || result.trend === "insufficient_data") continue;

    const alert: AlertEntry = {
      timestamp: new Date().toISOString(),
      metric: result.metric,
      change_pct: result.change_pct,
      threshold: alert_threshold,
      trend: result.trend,
      description: result.description,
    };
    fireAlert(alert);
    alerts_fired++;
  }

  return {
    lookback_days,
    period_type: periodType,
    metrics_analyzed: results.length,
    alerts_fired,
    trends: results,
  };
}
