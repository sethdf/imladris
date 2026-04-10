// Windmill Script: Integrity Audit
// memory-sync spec Phase 4a
//
// Wraps ~/.claude/PAI/Tools/IntegrityMaintenance.ts — runs 16 parallel checks
// for broken references, orphaned files, schema violations across ~/.claude/.
//
// Runs on the NATIVE worker group. Scheduled daily.

import { spawnSync } from "child_process";

export async function main() {
  const HOME = process.env.HOME || "/home/ec2-user";
  const toolPath = `${HOME}/.claude/PAI/Tools/IntegrityMaintenance.ts`;
  const startedAt = new Date().toISOString();

  const result = spawnSync("bun", ["run", toolPath], {
    encoding: "utf-8",
    timeout: 15 * 60 * 1000,
    env: { ...process.env, NO_COLOR: "1" },
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const status = result.status === 0 ? "success" : "failed";

  // Best-effort extraction of issue counts
  const issuesMatch = stdout.match(/(\d+)\s+issues?\s+(?:found|detected)/i);
  const checksMatch = stdout.match(/(\d+)\s+checks?\s+(?:passed|complete)/i);
  const issues_found = issuesMatch ? parseInt(issuesMatch[1], 10) : null;
  const checks_passed = checksMatch ? parseInt(checksMatch[1], 10) : null;

  return {
    status,
    exit_code: result.status,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    issues_found,
    checks_passed,
    stdout_tail: stdout.slice(-3000),
    stderr_tail: stderr.slice(-1000),
  };
}
