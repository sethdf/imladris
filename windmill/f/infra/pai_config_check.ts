// Windmill Script: PAI Config Integrity Check
// Verifies Imladris-managed PAI hooks are correctly symlinked.
// Returns a structured report; non-zero exit on issues triggers Windmill error alerting.

import { readdirSync, readlinkSync, existsSync, lstatSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();
const PAI_CONFIG_HOOKS = join(HOME, "repos/imladris/pai-config/hooks");
const CLAUDE_HOOKS = join(HOME, ".claude/hooks");

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
  "WorkCompletionLearning.hook.ts", "PRDSync.hook.ts",
]);

export async function main(): Promise<{
  status: "clean" | "issues_found";
  ok: string[];
  issues: Array<{ kind: string; file: string; detail: string }>;
  checked_at: string;
}> {
  const issues: Array<{ kind: string; file: string; detail: string }> = [];
  const ok: string[] = [];

  // 1. Every hook in pai-config must have a valid symlink in ~/.claude/hooks/
  const paiHooks = readdirSync(PAI_CONFIG_HOOKS).filter(f => f.endsWith(".hook.ts"));
  for (const hook of paiHooks) {
    const claudePath = join(CLAUDE_HOOKS, hook);
    const paiPath = join(PAI_CONFIG_HOOKS, hook);

    if (!existsSync(claudePath)) {
      issues.push({ kind: "missing_symlink", file: hook, detail: `No symlink in ~/.claude/hooks/ for ${hook}` });
      continue;
    }
    const stat = lstatSync(claudePath);
    if (!stat.isSymbolicLink()) {
      issues.push({ kind: "orphaned_file", file: hook, detail: `${hook} is a plain file in ~/.claude/hooks/ — should be a symlink to pai-config` });
      continue;
    }
    const target = readlinkSync(claudePath);
    if (!existsSync(claudePath)) {
      issues.push({ kind: "broken_symlink", file: hook, detail: `Symlink target missing: ${target}` });
      continue;
    }
    ok.push(hook);
  }

  // 2. Plain files in ~/.claude/hooks/ not in base PAI set = potential orphans
  for (const file of readdirSync(CLAUDE_HOOKS)) {
    if (!file.endsWith(".hook.ts")) continue;
    const claudePath = join(CLAUDE_HOOKS, file);
    if (lstatSync(claudePath).isSymbolicLink()) continue;
    if (!PAI_BASE_HOOKS.has(file)) {
      issues.push({
        kind: "orphaned_file",
        file,
        detail: `Plain file not in PAI base set — may need to be moved to pai-config/hooks/ and symlinked`,
      });
    }
  }

  const status = issues.length === 0 ? "clean" : "issues_found";

  if (issues.length > 0) {
    console.error(`[pai-config-check] ${issues.length} issue(s) found:`);
    for (const i of issues) console.error(`  ${i.kind}: ${i.file} — ${i.detail}`);
    // Throw to trigger Windmill error alerting
    throw new Error(`PAI config integrity: ${issues.length} issue(s). Run pai-config-check.ts --fix on the host.`);
  }

  console.log(`[pai-config-check] Clean — ${ok.length} hooks correctly symlinked`);
  return { status, ok, issues, checked_at: new Date().toISOString() };
}
