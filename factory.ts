#!/usr/bin/env bun
/**
 * factory.ts — Code Factory for Imladris
 *
 * Thin orchestrator that reads a PRD, partitions ISC criteria into
 * work packages, spawns parallel Claude agents in git worktrees,
 * optionally runs a review agent, then merges and creates a PR.
 *
 * Usage:
 *   bun factory.ts <prd-path> [options]
 *
 * Options:
 *   --agents N        Number of parallel agents (default: 4)
 *   --dry-run         Parse and partition only, don't spawn agents
 *   --review          Spawn independent review agent after build
 *   --branch NAME     Branch name for the PR (default: factory/<prd-slug>)
 *   --budget USD      Max budget per agent in USD (default: 5)
 *   --model MODEL     Model alias to use (default: sonnet)
 *
 * Decision #36 in the Imladris architecture.
 */

import { $ } from "bun";

// ─── Types ───────────────────────────────────────────────────────────

interface Criterion {
  id: string;
  text: string;
  verify: string;
  domain: string;
  done: boolean;
}

interface WorkPackage {
  id: number;
  criteria: Criterion[];
  domain: string;
}

interface AgentResult {
  package: WorkPackage;
  worktree: string;
  branch: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ─── CLI Argument Parsing ────────────────────────────────────────────

function parseArgs(): {
  prdPath: string;
  agents: number;
  dryRun: boolean;
  review: boolean;
  branch: string | null;
  budget: number;
  model: string;
} {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
Usage: bun factory.ts <prd-path> [options]

Options:
  --agents N        Number of parallel agents (default: 4)
  --dry-run         Parse and partition only, don't spawn agents
  --review          Spawn independent review agent after build
  --branch NAME     Branch name for the PR (default: factory/<prd-slug>)
  --budget USD      Max budget per agent in USD (default: 5)
  --model MODEL     Model alias (default: sonnet)
`);
    process.exit(0);
  }

  const prdPath = args[0];
  let agents = 4;
  let dryRun = false;
  let review = false;
  let branch: string | null = null;
  let budget = 5;
  let model = "sonnet";

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--agents":
        agents = parseInt(args[++i], 10);
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--review":
        review = true;
        break;
      case "--branch":
        branch = args[++i];
        break;
      case "--budget":
        budget = parseFloat(args[++i]);
        break;
      case "--model":
        model = args[++i];
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  return { prdPath, agents, dryRun, review, branch, budget, model };
}

// ─── PRD Parsing ─────────────────────────────────────────────────────

function parsePRD(content: string): {
  title: string;
  context: string;
  criteria: Criterion[];
} {
  // Extract title (first # heading)
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1] ?? "Untitled";

  // Extract CONTEXT section
  const contextMatch = content.match(
    /## CONTEXT\s*\n([\s\S]*?)(?=\n## (?!CONTEXT))/
  );
  const context = contextMatch?.[1]?.trim() ?? "";

  // Extract ISC criteria: lines matching - [ ] ISC-{id}: {text} | Verify: {method}
  // Also handles - [x] for already-done criteria
  const criteria: Criterion[] = [];
  const criterionRegex =
    /^- \[([ x])\]\s+(ISC-[A-Z]?\d+|ISC-[A-Z]?-[\w]+-\d+):\s+(.+?)(?:\s*\|\s*Verify:\s*(.+))?$/gm;

  let match: RegExpExecArray | null;
  while ((match = criterionRegex.exec(content)) !== null) {
    const done = match[1] === "x";
    const id = match[2];
    const text = match[3].trim();
    const verify = match[4]?.trim() ?? "Custom: manual check";

    // Determine domain from nearest ### heading above this criterion
    const precedingContent = content.slice(0, match.index);
    const domainMatches = [...precedingContent.matchAll(/^###\s+(.+)$/gm)];
    const domain = domainMatches.length > 0
      ? domainMatches[domainMatches.length - 1][1].trim()
      : "General";

    criteria.push({ id, text, verify, domain, done });
  }

  return { title, context, criteria };
}

// ─── Partitioning ────────────────────────────────────────────────────

function partitionCriteria(
  criteria: Criterion[],
  agentCount: number
): WorkPackage[] {
  // Filter to only pending criteria
  const pending = criteria.filter((c) => !c.done);

  if (pending.length === 0) {
    console.log("All criteria already passing. Nothing to do.");
    process.exit(0);
  }

  // Group by domain
  const domains = new Map<string, Criterion[]>();
  for (const c of pending) {
    const existing = domains.get(c.domain) ?? [];
    existing.push(c);
    domains.set(c.domain, existing);
  }

  // If domains >= agentCount, one package per domain (merge smallest if too many)
  // If domains < agentCount, round-robin individual criteria
  const packages: WorkPackage[] = [];

  if (domains.size >= agentCount) {
    // Sort domains by size descending, assign to N packages
    const sortedDomains = [...domains.entries()].sort(
      (a, b) => b[1].length - a[1].length
    );
    for (let i = 0; i < sortedDomains.length; i++) {
      const pkgIdx = i % agentCount;
      if (!packages[pkgIdx]) {
        packages[pkgIdx] = {
          id: pkgIdx + 1,
          criteria: [],
          domain: sortedDomains[i][0],
        };
      }
      packages[pkgIdx].criteria.push(...sortedDomains[i][1]);
      if (i >= agentCount) {
        packages[pkgIdx].domain += ` + ${sortedDomains[i][0]}`;
      }
    }
  } else {
    // Round-robin criteria across packages
    const actual = Math.min(agentCount, pending.length);
    for (let i = 0; i < actual; i++) {
      packages.push({ id: i + 1, criteria: [], domain: `Package ${i + 1}` });
    }
    for (let i = 0; i < pending.length; i++) {
      packages[i % actual].criteria.push(pending[i]);
    }
  }

  return packages;
}

// ─── Agent Spawning ──────────────────────────────────────────────────

function buildAgentPrompt(
  pkg: WorkPackage,
  context: string,
  prdPath: string
): string {
  const criteriaList = pkg.criteria
    .map((c) => `- ${c.id}: ${c.text} | Verify: ${c.verify}`)
    .join("\n");

  return `You are a focused code factory worker. Your job is to make the following ISC criteria pass.

## Context
${context}

## PRD Location
${prdPath}

## Your Assigned Criteria
${criteriaList}

## Instructions
1. Read the PRD at ${prdPath} for full context
2. For each criterion, implement what's needed to make it pass
3. Run the verification method for each criterion
4. Only work on YOUR assigned criteria — do not touch other areas
5. Commit your changes with clear messages referencing the ISC IDs
6. When done, output a summary of what you built and which criteria pass`;
}

async function spawnAgent(
  pkg: WorkPackage,
  context: string,
  prdPath: string,
  opts: { model: string; budget: number; repoDir: string }
): Promise<AgentResult> {
  const worktreeName = `factory-pkg-${pkg.id}`;
  const branch = `factory/pkg-${pkg.id}`;
  const prompt = buildAgentPrompt(pkg, context, prdPath);

  console.log(
    `  [pkg-${pkg.id}] Spawning agent for ${pkg.criteria.length} criteria (${pkg.domain})`
  );

  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      "--worktree",
      worktreeName,
      "--model",
      opts.model,
      "--max-budget-usd",
      opts.budget.toString(),
      "--permission-mode",
      "default",
      prompt,
    ],
    {
      cwd: opts.repoDir,
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  console.log(
    `  [pkg-${pkg.id}] Agent finished (exit ${exitCode}, ${stdout.length} bytes output)`
  );

  return { package: pkg, worktree: worktreeName, branch, exitCode, stdout, stderr };
}

// ─── Review Agent ────────────────────────────────────────────────────

async function spawnReviewAgent(
  results: AgentResult[],
  prdPath: string,
  opts: { model: string; budget: number; repoDir: string }
): Promise<string> {
  const summaries = results
    .map(
      (r) =>
        `## Package ${r.package.id} (${r.package.domain})\nExit: ${r.exitCode}\nWorktree: ${r.worktree}\nCriteria: ${r.package.criteria.map((c) => c.id).join(", ")}\n\nOutput:\n${r.stdout.slice(0, 2000)}`
    )
    .join("\n\n---\n\n");

  const prompt = `You are an independent code reviewer for a factory build. Review the work done by ${results.length} agents.

## PRD
Read the PRD at ${prdPath} for the full criteria list.

## Agent Summaries
${summaries}

## Instructions
1. Read the PRD to understand all ISC criteria
2. For each agent's worktree, review the changes: \`git diff main...\`
3. Check that each criterion's verification method actually passes
4. Flag any issues, conflicts between packages, or missed criteria
5. Output a structured review with PASS/FAIL per criterion and any comments`;

  console.log("  [review] Spawning review agent...");

  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      "--model",
      opts.model,
      "--max-budget-usd",
      opts.budget.toString(),
      prompt,
    ],
    {
      cwd: opts.repoDir,
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  console.log(
    `  [review] Review complete (${stdout.length} bytes)`
  );

  return stdout;
}

// ─── Merge & PR ──────────────────────────────────────────────────────

async function mergeAndCreatePR(
  results: AgentResult[],
  branchName: string,
  title: string,
  repoDir: string
): Promise<string> {
  // Create the factory branch from main
  await $`git -C ${repoDir} checkout -b ${branchName} main`.quiet();

  // Merge each worktree's branch
  let mergeErrors: string[] = [];
  for (const result of results) {
    if (result.exitCode !== 0) {
      mergeErrors.push(
        `pkg-${result.package.id}: agent exited with ${result.exitCode}`
      );
      continue;
    }

    // The worktree branch name is the worktree name
    try {
      await $`git -C ${repoDir} merge --no-ff -m ${"factory: merge pkg-" + result.package.id} ${result.worktree}`.quiet();
      console.log(`  Merged ${result.worktree}`);
    } catch (e: any) {
      mergeErrors.push(`pkg-${result.package.id}: merge conflict`);
      // Abort the failed merge
      await $`git -C ${repoDir} merge --abort`.quiet().catch(() => {});
    }
  }

  if (mergeErrors.length > 0) {
    console.warn("Merge issues:", mergeErrors);
  }

  // Push and create PR
  await $`git -C ${repoDir} push -u origin ${branchName}`.quiet();

  const criteriaCount = results.reduce(
    (sum, r) => sum + r.package.criteria.length,
    0
  );

  const body = `## Summary
- Factory build from PRD: ${title}
- ${results.length} agents, ${criteriaCount} criteria
- ${mergeErrors.length > 0 ? `${mergeErrors.length} merge issues` : "All packages merged cleanly"}

## Packages
${results.map((r) => `- **pkg-${r.package.id}** (${r.package.domain}): ${r.package.criteria.map((c) => c.id).join(", ")} — exit ${r.exitCode}`).join("\n")}

${mergeErrors.length > 0 ? `## Merge Issues\n${mergeErrors.map((e) => `- ${e}`).join("\n")}` : ""}

Generated by Imladris Code Factory (Decision #36)`;

  const prResult =
    await $`gh pr create --repo sethdf/imladris --head ${branchName} --base main --title ${"factory: " + title} --body ${body}`.text();

  return prResult.trim();
}

// ─── Cleanup ─────────────────────────────────────────────────────────

async function cleanupWorktrees(repoDir: string) {
  try {
    const list = await $`git -C ${repoDir} worktree list --porcelain`.text();
    const worktrees = list
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.replace("worktree ", ""))
      .filter((p) => p.includes("factory-pkg-"));

    for (const wt of worktrees) {
      await $`git -C ${repoDir} worktree remove ${wt} --force`.quiet().catch(() => {});
    }
  } catch {
    // Worktree cleanup is best-effort
  }
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const repoDir = import.meta.dir;

  console.log(`\n  Code Factory — Imladris (Decision #36)`);
  console.log(`  ${"─".repeat(40)}`);

  // Step 1: Parse PRD
  console.log(`\n  [1/5] Parsing PRD: ${opts.prdPath}`);
  const prdContent = await Bun.file(opts.prdPath).text();
  const { title, context, criteria } = parsePRD(prdContent);

  console.log(`  Title: ${title}`);
  console.log(`  Total criteria: ${criteria.length}`);
  console.log(
    `  Pending: ${criteria.filter((c) => !c.done).length} | Done: ${criteria.filter((c) => c.done).length}`
  );

  if (criteria.length === 0) {
    console.error(
      "  No ISC criteria found in PRD. Expected format: - [ ] ISC-C{N}: {text}"
    );
    process.exit(1);
  }

  // Step 2: Partition
  console.log(`\n  [2/5] Partitioning into ${opts.agents} work packages`);
  const packages = partitionCriteria(criteria, opts.agents);

  for (const pkg of packages) {
    console.log(
      `  pkg-${pkg.id}: ${pkg.criteria.length} criteria (${pkg.domain})`
    );
    for (const c of pkg.criteria) {
      console.log(`    ${c.id}: ${c.text}`);
    }
  }

  if (opts.dryRun) {
    console.log("\n  --dry-run: stopping before agent spawn");
    process.exit(0);
  }

  // Step 3: Spawn agents
  console.log(`\n  [3/5] Spawning ${packages.length} agents in worktrees`);
  const agentOpts = { model: opts.model, budget: opts.budget, repoDir };
  const results = await Promise.all(
    packages.map((pkg) => spawnAgent(pkg, context, opts.prdPath, agentOpts))
  );

  const succeeded = results.filter((r) => r.exitCode === 0).length;
  const failed = results.length - succeeded;
  console.log(
    `\n  Agents complete: ${succeeded} succeeded, ${failed} failed`
  );

  // Step 4: Review (optional)
  if (opts.review) {
    console.log(`\n  [4/5] Running review agent`);
    const review = await spawnReviewAgent(results, opts.prdPath, agentOpts);
    console.log("\n  Review output:");
    console.log(review);
  } else {
    console.log(`\n  [4/5] Review skipped (use --review to enable)`);
  }

  // Step 5: Merge and PR
  const branchName =
    opts.branch ??
    `factory/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`;

  console.log(`\n  [5/5] Merging to ${branchName} and creating PR`);
  try {
    const prUrl = await mergeAndCreatePR(
      results,
      branchName,
      title,
      repoDir
    );
    console.log(`\n  PR created: ${prUrl}`);
  } catch (e: any) {
    console.error(`\n  PR creation failed: ${e.message}`);
    console.log("  Worktree branches are preserved for manual merge.");
  }

  // Cleanup worktrees
  await cleanupWorktrees(repoDir);

  console.log(`\n  Factory run complete.`);
}

main().catch((e) => {
  console.error("Factory error:", e);
  process.exit(1);
});
