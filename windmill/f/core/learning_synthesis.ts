// Windmill Script: Learning Pattern Synthesis
// memory-sync spec Phase 4a
//
// Wraps ~/.claude/PAI/Tools/LearningPatternSynthesis.ts — aggregates ratings
// from ~/.claude/MEMORY/SIGNALS/ into pattern reports under SYNTHESIS/.
//
// Runs on the NATIVE worker group. Scheduled weekly.

import { spawnSync } from "child_process";

export async function main(window_days: number = 7) {
  const HOME = process.env.HOME || "/home/ec2-user";
  const toolPath = `${HOME}/.claude/PAI/Tools/LearningPatternSynthesis.ts`;
  const startedAt = new Date().toISOString();

  const result = spawnSync("bun", ["run", toolPath, "--window", String(window_days)], {
    encoding: "utf-8",
    timeout: 15 * 60 * 1000,
    env: { ...process.env, NO_COLOR: "1" },
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const status = result.status === 0 ? "success" : "failed";

  // Best-effort extraction of reports written
  const reportMatch = stdout.match(/(\d+)\s+reports?\s+(?:written|generated|created)/i);
  const reports_written = reportMatch ? parseInt(reportMatch[1], 10) : null;

  return {
    status,
    exit_code: result.status,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    window_days,
    reports_written,
    stdout_tail: stdout.slice(-2000),
    stderr_tail: stderr.slice(-1000),
  };
}
