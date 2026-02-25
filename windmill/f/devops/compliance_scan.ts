// Windmill Script: Weekly Compliance Scan
// Decision 26: Automatic reports — CIS benchmark compliance via Powerpipe
//
// Requires: powerpipe with aws_compliance mod installed

import { execSync } from "child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();
const COMPLIANCE_LOG = join(HOME, ".claude", "logs", "compliance-scans.jsonl");
const LAST_RUN_PATH = join(HOME, ".claude", "state", "last-compliance.json");

interface ControlSummary {
  total: number;
  passing: number;
  failing: number;
  error: number;
  skip: number;
}

interface ComplianceResult {
  generated: string;
  benchmark: string;
  summary: ControlSummary;
  critical_failures: { title: string; status: string; reason?: string }[];
}

function ensureDirs(): void {
  for (const dir of [
    join(HOME, ".claude", "logs"),
    join(HOME, ".claude", "state"),
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function powerpipeAvailable(): boolean {
  try {
    execSync("which powerpipe", { encoding: "utf-8", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function parseResults(raw: Record<string, unknown>): {
  summary: ControlSummary;
  failures: { title: string; status: string; reason?: string }[];
} {
  const groups = (raw.groups || raw.children || []) as Record<string, unknown>[];
  let passing = 0;
  let failing = 0;
  let errorCount = 0;
  let skip = 0;
  const failures: { title: string; status: string; reason?: string }[] = [];

  function walk(node: Record<string, unknown>): void {
    const status = String(node.status || "").toLowerCase();
    if (status === "ok" || status === "pass") passing++;
    else if (status === "alarm" || status === "fail") {
      failing++;
      failures.push({
        title: String(node.title || node.name || "Unknown"),
        status,
        reason: node.reason ? String(node.reason) : undefined,
      });
    } else if (status === "error") errorCount++;
    else if (status === "skip") skip++;

    const children = (node.groups ||
      node.children ||
      node.controls ||
      []) as Record<string, unknown>[];
    for (const child of children) walk(child);
  }

  for (const group of groups) walk(group);

  // If no nested results, check top-level summary
  const total = passing + failing + errorCount + skip;
  if (total === 0 && raw.summary) {
    const s = raw.summary as Record<string, number>;
    return {
      summary: {
        total: (s.ok || 0) + (s.alarm || 0) + (s.error || 0) + (s.skip || 0),
        passing: s.ok || 0,
        failing: s.alarm || 0,
        error: s.error || 0,
        skip: s.skip || 0,
      },
      failures,
    };
  }

  return {
    summary: { total, passing, failing, error: errorCount, skip },
    failures,
  };
}

function loadLastRun(): ComplianceResult | null {
  if (!existsSync(LAST_RUN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(LAST_RUN_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export async function main(
  benchmark: string = "aws_compliance.benchmark.cis_v300",
  compare_last: boolean = true,
) {
  ensureDirs();

  if (!powerpipeAvailable()) {
    return {
      error: "powerpipe not installed or not in PATH",
      setup:
        "Install powerpipe and run: powerpipe mod install github.com/turbot/steampipe-mod-aws-compliance",
    };
  }

  let rawOutput: string;
  try {
    rawOutput = execSync(
      `powerpipe benchmark run ${benchmark} --output json`,
      { encoding: "utf-8", timeout: 300000 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: "Powerpipe benchmark failed",
      detail: message,
      benchmark,
    };
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawOutput);
  } catch {
    return { error: "Failed to parse powerpipe output", raw_length: rawOutput.length };
  }

  const { summary, failures } = parseResults(raw);
  const now = new Date();

  const result: ComplianceResult = {
    generated: now.toISOString(),
    benchmark,
    summary,
    critical_failures: failures.slice(0, 50),
  };

  // Compare against last run
  let comparison: {
    alert: boolean;
    new_failures: number;
    resolved: number;
    delta: Record<string, number>;
  } | null = null;

  if (compare_last) {
    const lastRun = loadLastRun();
    if (lastRun) {
      const lastFailTitles = new Set(
        lastRun.critical_failures.map((f) => f.title),
      );
      const currentFailTitles = new Set(failures.map((f) => f.title));

      const newFailures = failures.filter((f) => !lastFailTitles.has(f.title));
      const resolved = lastRun.critical_failures.filter(
        (f) => !currentFailTitles.has(f.title),
      );

      comparison = {
        alert: newFailures.length > 0,
        new_failures: newFailures.length,
        resolved: resolved.length,
        delta: {
          total: summary.total - lastRun.summary.total,
          passing: summary.passing - lastRun.summary.passing,
          failing: summary.failing - lastRun.summary.failing,
        },
      };
    }
  }

  // Save as last run
  writeFileSync(LAST_RUN_PATH, JSON.stringify(result, null, 2));

  // Log
  appendFileSync(
    COMPLIANCE_LOG,
    JSON.stringify({
      timestamp: now.toISOString(),
      benchmark,
      total: summary.total,
      passing: summary.passing,
      failing: summary.failing,
      new_failures: comparison?.new_failures || 0,
      alert: comparison?.alert || false,
    }) + "\n",
  );

  return {
    ...result,
    comparison,
    alert: comparison?.alert || false,
    pass_rate:
      summary.total > 0
        ? `${((summary.passing / summary.total) * 100).toFixed(1)}%`
        : "N/A",
  };
}
