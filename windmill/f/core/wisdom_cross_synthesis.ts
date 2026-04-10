// Windmill Script: Wisdom Cross-Frame Synthesis
// memory-sync spec Phase 4a
//
// Wraps ~/.claude/PAI/Tools/WisdomCrossFrameSynthesizer.ts — finds cross-domain
// patterns by synthesizing across all Wisdom Frames in ~/.claude/MEMORY/WISDOM/.
//
// Runs on the NATIVE worker group. Scheduled weekly.

import { spawnSync } from "child_process";

export async function main() {
  const HOME = process.env.HOME || "/home/ec2-user";
  const toolPath = `${HOME}/.claude/PAI/Tools/WisdomCrossFrameSynthesizer.ts`;
  const startedAt = new Date().toISOString();

  const result = spawnSync("bun", ["run", toolPath], {
    encoding: "utf-8",
    timeout: 15 * 60 * 1000,
    env: { ...process.env, NO_COLOR: "1" },
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const status = result.status === 0 ? "success" : "failed";

  const patternsMatch = stdout.match(/(\d+)\s+cross-frame\s+patterns?/i);
  const cross_frame_patterns = patternsMatch ? parseInt(patternsMatch[1], 10) : null;

  return {
    status,
    exit_code: result.status,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    cross_frame_patterns,
    stdout_tail: stdout.slice(-2000),
    stderr_tail: stderr.slice(-1000),
  };
}
