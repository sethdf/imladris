// pai-ruflo-bridge.ts — Translates PAI Algorithm BUILD phase into Ruflo swarm tasks
//
// When PAI's Algorithm reaches the BUILD phase with multi-file work,
// this bridge takes the ISC criteria and delegates to Ruflo's swarm.
//
// Flow:
//   PAI PLAN → ISC criteria (checkboxes in PRD.md)
//   PAI BUILD → calls this bridge
//   Bridge → parses ISC criteria → creates Ruflo tasks
//   Ruflo → assigns agents, executes in parallel
//   Bridge → collects results → returns to PAI
//   PAI VERIFY → checks ISC criteria against results
//
// Usage from Claude Code:
//   import { delegateToRuflo } from "./scripts/pai-ruflo-bridge.ts";
//   const result = await delegateToRuflo(prdContent, workDir);
//
// Or via CLI:
//   bun run scripts/pai-ruflo-bridge.ts --prd MEMORY/WORK/slug/PRD.md

import { readFileSync } from "fs";
import { join } from "path";

interface ISCCriterion {
  id: string;
  text: string;
  checked: boolean;
}

interface RufloTask {
  description: string;
  agent_type: string;
  criteria: string[];
  priority: number;
}

function parseISCFromPRD(prdContent: string): ISCCriterion[] {
  const criteria: ISCCriterion[] = [];
  const lines = prdContent.split("\n");

  for (const line of lines) {
    // Match: - [ ] ISC-1: some text  OR  - [x] ISC-1: some text
    const match = line.match(/^-\s*\[([ x])\]\s*(ISC-[A]?\d+):\s*(.+)$/);
    if (match) {
      criteria.push({
        id: match[2],
        text: match[3].trim(),
        checked: match[1] === "x",
      });
    }
  }

  return criteria;
}

function classifyCriterion(text: string): string {
  const lower = text.toLowerCase();

  if (lower.includes("test") || lower.includes("spec") || lower.includes("assert")) return "tester";
  if (lower.includes("review") || lower.includes("check") || lower.includes("verify")) return "reviewer";
  if (lower.includes("security") || lower.includes("vulnerab") || lower.includes("inject")) return "security";
  if (lower.includes("document") || lower.includes("readme") || lower.includes("comment")) return "documenter";
  if (lower.includes("deploy") || lower.includes("ci") || lower.includes("pipeline")) return "devops";
  if (lower.includes("refactor") || lower.includes("rename") || lower.includes("move")) return "coder";
  if (lower.includes("create") || lower.includes("implement") || lower.includes("add") || lower.includes("write")) return "coder";
  if (lower.includes("fix") || lower.includes("bug") || lower.includes("error")) return "debugger";

  return "coder"; // default
}

function buildRufloTasks(criteria: ISCCriterion[]): RufloTask[] {
  // Group unchecked criteria by agent type
  const unchecked = criteria.filter(c => !c.checked);
  const grouped: Record<string, ISCCriterion[]> = {};

  for (const c of unchecked) {
    const agentType = classifyCriterion(c.text);
    if (!grouped[agentType]) grouped[agentType] = [];
    grouped[agentType].push(c);
  }

  // Create one Ruflo task per agent type
  return Object.entries(grouped).map(([agentType, items], index) => ({
    description: `${agentType}: ${items.map(i => i.text).join("; ")}`,
    agent_type: agentType,
    criteria: items.map(i => `${i.id}: ${i.text}`),
    priority: index,
  }));
}

export async function delegateToRuflo(prdContent: string, workDir: string): Promise<{
  delegated: boolean;
  tasks: RufloTask[];
  swarm_id?: string;
  error?: string;
}> {
  const criteria = parseISCFromPRD(prdContent);
  const unchecked = criteria.filter(c => !c.checked);

  if (unchecked.length === 0) {
    return { delegated: false, tasks: [], error: "All criteria already checked" };
  }

  if (unchecked.length < 2) {
    return { delegated: false, tasks: [], error: "Single criterion — handle directly, not worth swarm overhead" };
  }

  const tasks = buildRufloTasks(criteria);

  console.log(`[pai-ruflo] Delegating ${unchecked.length} unchecked criteria to Ruflo swarm`);
  console.log(`[pai-ruflo] ${tasks.length} agent groups: ${tasks.map(t => `${t.agent_type}(${t.criteria.length})`).join(", ")}`);

  // Call Ruflo CLI to create swarm
  try {
    const taskSpecs = tasks.map(t => ({
      title: `${t.agent_type}: ${t.criteria.length} criteria`,
      description: t.description,
      type: t.agent_type,
      acceptance_criteria: t.criteria,
    }));

    const proc = Bun.spawn([
      "ruflo", "swarm", "init",
      "--topology", "hierarchical-mesh",
      "--tasks", JSON.stringify(taskSpecs),
      "--work-dir", workDir,
    ], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: workDir,
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return { delegated: false, tasks, error: `Ruflo swarm init failed: ${stderr.slice(0, 200)}` };
    }

    // Parse swarm ID from output
    const swarmMatch = output.match(/swarm[_-]id[:\s]+([a-zA-Z0-9-]+)/i);
    const swarmId = swarmMatch?.[1] || `swarm-${Date.now()}`;

    console.log(`[pai-ruflo] Swarm ${swarmId} started with ${tasks.length} agent groups`);

    return { delegated: true, tasks, swarm_id: swarmId };
  } catch (err: any) {
    return { delegated: false, tasks, error: err.message };
  }
}

// ── CLI entry point ──
if (import.meta.main) {
  const args = process.argv.slice(2);
  const prdIdx = args.indexOf("--prd");
  const prdPath = prdIdx !== -1 ? args[prdIdx + 1] : null;

  if (!prdPath) {
    console.log("Usage: bun run pai-ruflo-bridge.ts --prd <path-to-PRD.md>");
    process.exit(1);
  }

  const HOME = process.env.HOME || "/home/ec2-user";
  const fullPath = prdPath.startsWith("/") ? prdPath : join(HOME, ".claude", prdPath);
  const prdContent = readFileSync(fullPath, "utf8");
  const workDir = join(fullPath, "..");

  const result = await delegateToRuflo(prdContent, workDir);
  console.log(JSON.stringify(result, null, 2));
}
