#!/usr/bin/env bun
/**
 * ContextCompaction.hook.ts - Proactive Compaction Warning (UserPromptSubmit)
 *
 * PURPOSE:
 * Monitors approximate context window usage and warns when approaching
 * compaction threshold (~70%). Implements the "proactive compaction"
 * layer from the cloud-workstation-vision context persistence model.
 *
 * TRIGGER: UserPromptSubmit
 *
 * INPUT (stdin JSON):
 * - session_id: Current session identifier
 * - tool_input: { prompt: "user's message" }
 *
 * OUTPUT:
 * - stdout: {"continue": true} (always — never blocks)
 *
 * SIDE EFFECTS:
 * - Updates ~/.claude/state/context-estimate.json with running token estimate
 * - Logs warning to stderr when threshold exceeded
 *
 * ERROR HANDLING:
 * - All errors fail-open
 *
 * NOTE: This is a heuristic estimator. Claude Code doesn't expose actual
 * token counts, so we estimate from cumulative prompt/response sizes.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

// ========================================
// Types
// ========================================

interface HookInput {
  session_id: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface ContextEstimate {
  session_id: string;
  prompt_count: number;
  estimated_tokens: number;
  last_warning_at: number; // token count at last warning
  last_updated: string;
}

// ========================================
// Constants
// ========================================

const HOME = homedir();
const STATE_DIR = join(HOME, '.claude', 'state');
const ESTIMATE_PATH = join(STATE_DIR, 'context-estimate.json');

// Approximate context window for Claude (200k tokens)
const CONTEXT_WINDOW = 200_000;
const WARNING_THRESHOLD = 0.70; // 70%
const WARNING_TOKENS = Math.floor(CONTEXT_WINDOW * WARNING_THRESHOLD);
// Don't warn more than once per 20k tokens
const WARNING_COOLDOWN = 20_000;

// Rough chars-to-tokens ratio (English text ~4 chars per token)
const CHARS_PER_TOKEN = 4;

// ========================================
// Helpers
// ========================================

function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmpPath = join(dir, `.tmp-compact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filePath);
}

function readEstimate(sessionId: string): ContextEstimate {
  if (existsSync(ESTIMATE_PATH)) {
    try {
      const data = JSON.parse(readFileSync(ESTIMATE_PATH, 'utf-8'));
      // Reset if different session
      if (data.session_id === sessionId) return data;
    } catch {
      // Fall through to default
    }
  }
  return {
    session_id: sessionId,
    prompt_count: 0,
    estimated_tokens: 0,
    last_warning_at: 0,
    last_updated: new Date().toISOString(),
  };
}

// ========================================
// Main
// ========================================

async function main(): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of Bun.stdin.stream()) {
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    const input: HookInput = JSON.parse(raw);
    const sessionId = input.session_id || 'unknown';
    const prompt = (input.tool_input?.prompt as string) || '';

    // Update running estimate
    const est = readEstimate(sessionId);
    est.prompt_count += 1;
    // Each prompt adds tokens for the prompt itself plus estimated response
    // Rough heuristic: prompt tokens + ~2x for response
    const promptTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
    est.estimated_tokens += promptTokens * 3; // prompt + response estimate
    est.last_updated = new Date().toISOString();

    // Check threshold
    if (
      est.estimated_tokens >= WARNING_TOKENS &&
      est.estimated_tokens - est.last_warning_at >= WARNING_COOLDOWN
    ) {
      const pct = Math.round((est.estimated_tokens / CONTEXT_WINDOW) * 100);
      process.stderr.write(
        `[ContextCompaction] WARNING: Estimated context usage ~${pct}% ` +
        `(~${est.estimated_tokens} tokens, ${est.prompt_count} prompts). ` +
        `Consider saving key context to PRD/MEMORY before compaction.\n`
      );
      est.last_warning_at = est.estimated_tokens;
    }

    atomicWrite(ESTIMATE_PATH, JSON.stringify(est, null, 2));

    console.log(JSON.stringify({ continue: true }));
  } catch (err) {
    process.stderr.write(`[ContextCompaction] Error: ${err}\n`);
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
