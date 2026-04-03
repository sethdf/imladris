#!/usr/bin/env bun
/**
 * pai-config-check.ts — PAI config integrity checker
 *
 * Checks that all Imladris-managed PAI additions are properly wired:
 *   1. Every hook in pai-config/hooks/ has a valid symlink in ~/.claude/hooks/
 *   2. Every symlink in ~/.claude/hooks/ that targets pai-config points to an existing file
 *   3. No hook files in ~/.claude/hooks/ that look Imladris-authored are plain files (orphans)
 *
 * Exit codes: 0 = clean, 1 = issues found
 * Use: bun pai-config-check.ts  OR  bun pai-config-check.ts --fix
 */

import { readdirSync, readlinkSync, existsSync, lstatSync, symlinkSync, unlinkSync, copyFileSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

const HOME = homedir();
const PAI_CONFIG_HOOKS = join(HOME, "repos/imladris/pai-config/hooks");
const CLAUDE_HOOKS = join(HOME, ".claude/hooks");
const FIX_MODE = process.argv.includes("--fix");

type Issue = { kind: "broken_symlink" | "missing_symlink" | "orphaned_file"; file: string; detail: string };

const issues: Issue[] = [];
const ok: string[] = [];

// ── 1. Every hook in pai-config/hooks/ must have a valid symlink in ~/.claude/hooks/ ──

const paiHooks = readdirSync(PAI_CONFIG_HOOKS).filter(f => f.endsWith(".hook.ts"));

for (const hook of paiHooks) {
  const claudePath = join(CLAUDE_HOOKS, hook);
  const paiPath = join(PAI_CONFIG_HOOKS, hook);

  if (!existsSync(claudePath)) {
    issues.push({ kind: "missing_symlink", file: hook, detail: `No symlink in ~/.claude/hooks/ → ${paiPath}` });
    if (FIX_MODE) {
      symlinkSync(paiPath, claudePath);
      console.log(`  ✅ FIXED: Created symlink ${hook}`);
    }
    continue;
  }

  const stat = lstatSync(claudePath);
  if (!stat.isSymbolicLink()) {
    // It's a real file — probably an orphan copy
    issues.push({ kind: "orphaned_file", file: hook, detail: `${claudePath} is a plain file, not a symlink to pai-config` });
    if (FIX_MODE) {
      unlinkSync(claudePath);
      symlinkSync(paiPath, claudePath);
      console.log(`  ✅ FIXED: Replaced orphaned file with symlink: ${hook}`);
    }
    continue;
  }

  const target = readlinkSync(claudePath);
  if (!existsSync(claudePath)) {
    issues.push({ kind: "broken_symlink", file: hook, detail: `Symlink target missing: ${target}` });
    continue;
  }

  ok.push(hook);
}

// ── 2. Every symlink in ~/.claude/hooks/ targeting pai-config must resolve ──

const claudeHookFiles = readdirSync(CLAUDE_HOOKS);
for (const file of claudeHookFiles) {
  if (!file.endsWith(".hook.ts")) continue;
  const claudePath = join(CLAUDE_HOOKS, file);
  const stat = lstatSync(claudePath);
  if (!stat.isSymbolicLink()) continue;

  const target = readlinkSync(claudePath);
  if (!target.includes("pai-config")) continue; // not our symlink

  if (!existsSync(claudePath)) {
    issues.push({ kind: "broken_symlink", file, detail: `Target gone: ${target}` });
  }
}

// ── 3. Plain files in ~/.claude/hooks/ that look Imladris-authored (not PAI base) ──
// Heuristic: PAI base hooks use known names. Anything not in that set that's a plain file is suspect.

const PAI_BASE_HOOKS = new Set([
  "AgentExecutionGuard.hook.ts", "AgentOutputCapture.hook.ts", "AlgorithmTracker.hook.ts",
  "AutoWorkCreation.hook.ts", "CheckVersion.hook.ts", "DocIntegrity.hook.ts",
  "ExplicitRatingCapture.hook.ts", "FormatEnforcer.hook.ts", "FormatReminder.hook.ts",
  "ImplicitSentimentCapture.hook.ts", "IntegrityCheck.hook.ts", "KittyEnvPersist.hook.ts",
  "LastResponseCache.hook.ts", "LoadContext.hook.ts", "QuestionAnswered.hook.ts",
  "RatingCapture.hook.ts", "RelationshipMemory.hook.ts", "ResponseTabReset.hook.ts",
  "SecurityValidator.hook.ts", "SessionAutoName.hook.ts", "SessionCleanup.hook.ts",
  "SessionSummary.hook.ts", "SetQuestionTab.hook.ts", "SkillGuard.hook.ts",
  "StartupGreeting.hook.ts", "StopOrchestrator.hook.ts", "UpdateCounts.hook.ts",
  "UpdateTabTitle.hook.ts", "VoiceCompletion.hook.ts", "VoiceGate.hook.ts",
  "WorkCompletionLearning.hook.ts",
  "PRDSync.hook.ts",  // PAI base — reads PRD.md Write/Edit → syncs work.json (distinct from PrdSync)
]);

for (const file of claudeHookFiles) {
  if (!file.endsWith(".hook.ts")) continue;
  const claudePath = join(CLAUDE_HOOKS, file);
  const stat = lstatSync(claudePath);
  if (stat.isSymbolicLink()) continue; // already handled above

  if (!PAI_BASE_HOOKS.has(file)) {
    issues.push({
      kind: "orphaned_file",
      file,
      detail: `Plain file in ~/.claude/hooks/ not in pai-config and not a known PAI base hook — should it live in pai-config/hooks/?`
    });
  }
}

// ── Report ──

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";

console.log(`\n${BOLD}PAI Config Integrity Check${RESET}`);
console.log(`  pai-config/hooks: ${PAI_CONFIG_HOOKS}`);
console.log(`  ~/.claude/hooks:  ${CLAUDE_HOOKS}\n`);

if (ok.length > 0) {
  console.log(`${GREEN}✓ ${ok.length} hooks correctly symlinked:${RESET}`);
  for (const h of ok) console.log(`    ${h}`);
}

if (issues.length === 0) {
  console.log(`\n${GREEN}${BOLD}All clear — no issues found.${RESET}\n`);
  process.exit(0);
}

console.log(`\n${RED}${BOLD}${issues.length} issue(s) found:${RESET}`);
for (const issue of issues) {
  const icon = issue.kind === "broken_symlink" ? "🔗" : issue.kind === "missing_symlink" ? "❌" : "⚠️";
  console.log(`  ${icon} ${YELLOW}${issue.file}${RESET}: ${issue.detail}`);
}

if (!FIX_MODE) {
  console.log(`\n${YELLOW}Run with --fix to auto-repair symlink issues.${RESET}\n`);
}

process.exit(issues.length > 0 ? 1 : 0);
