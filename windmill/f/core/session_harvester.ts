// Windmill Script: Session Harvester
// memory-sync spec Phase 4a
//
// Wraps ~/.claude/PAI/Tools/SessionHarvester.ts — extracts learnings from
// Claude Code session transcripts in ~/.claude/projects/ into ~/.claude/MEMORY/LEARNING/.
//
// Runs on the NATIVE worker group — requires host filesystem access to ~/.claude/.
// Scheduled nightly.

import { spawnSync } from "child_process";

export async function main(recent: number = 20) {
  const HOME = process.env.HOME || "/home/ec2-user";
  const toolPath = `${HOME}/.claude/PAI/Tools/SessionHarvester.ts`;
  const startedAt = new Date().toISOString();

  const result = spawnSync("bun", ["run", toolPath, "--recent", String(recent)], {
    encoding: "utf-8",
    timeout: 10 * 60 * 1000, // 10 minutes
    env: { ...process.env, NO_COLOR: "1" },
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const status = result.status === 0 ? "success" : "failed";

  // Extract harvested count from tool output (best-effort)
  const countMatch = stdout.match(/harvested[^\d]*(\d+)/i);
  const harvested = countMatch ? parseInt(countMatch[1], 10) : null;

  return {
    status,
    exit_code: result.status,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    recent_sessions: recent,
    harvested,
    stdout_tail: stdout.slice(-2000),
    stderr_tail: stderr.slice(-1000),
  };
}
