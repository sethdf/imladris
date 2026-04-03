#!/usr/bin/env bun
/**
 * PRDStateSync.hook.ts - Track Active PRD Path (PostToolUse Write+Edit)
 *
 * PURPOSE:
 * Updates the session-scoped current-work file whenever the Algorithm
 * writes or edits a PRD.md file. This keeps PreCompact pointing at the
 * CURRENT PRD — not the first task written at session start.
 *
 * Without this hook, context compaction saves checkpoints to the wrong
 * WORK directory (the session's first task, months ago). With it, the
 * compaction checkpoint always lands next to the active PRD.
 *
 * TRIGGER: PostToolUse (matcher: Write | Edit)
 *
 * INPUT (stdin JSON):
 * - tool_name: "Write" | "Edit"
 * - tool_input: { file_path: string, ... }
 * - session_id: Current session identifier
 *
 * OUTPUT:
 * - stdout: {"continue": true} (always)
 *
 * SIDE EFFECTS:
 * - Updates MEMORY/STATE/current-work-{sessionId}.json
 *   (session_dir, task_title, prd_path, current_task, last_updated)
 *
 * PERFORMANCE:
 * - Fast path: non-PRD.md files exit in <1ms (path check only)
 * - PRD writes: <30ms (frontmatter parse + atomic file write)
 *
 * ERROR HANDLING:
 * - All errors fail-open (log stderr, exit 0, return continue)
 * - Never blocks the AI's Write or Edit operation
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

// ─── Types ────────────────────────────────────────────────────────────────────

interface HookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; [key: string]: unknown };
}

interface SessionWork {
  session_id: string;
  session_dir: string;
  current_task: string;
  task_title: string;
  task_count: number;
  created_at: string;
  prd_path: string;
  last_updated: string;
  [key: string]: unknown; // preserve unknown fields from AutoWorkCreation
}

// ─── Constants ────────────────────────────────────────────────────────────────

const HOME = homedir();
const CLAUDE_DIR = process.env.PAI_DIR || join(HOME, '.claude');
const STATE_DIR = join(CLAUDE_DIR, 'MEMORY', 'STATE');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${Date.now()}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, filePath);
}

function sessionWorkPath(sessionId: string): string {
  return join(STATE_DIR, `current-work-${sessionId}.json`);
}

function readSessionWork(sessionId: string): SessionWork | null {
  const paths = [
    sessionWorkPath(sessionId),
    join(STATE_DIR, 'current-work.json'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { /* skip */ }
    }
  }
  return null;
}

/**
 * Parse YAML frontmatter between --- delimiters.
 * Returns a flat key→value map (values are strings).
 * Fast and dependency-free — no yaml library needed.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return result;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key && value) result[key] = value;
  }
  return result;
}

/**
 * Extract slug from a PRD path.
 * e.g. "/home/user/.claude/MEMORY/WORK/20260402-020000_phase-2a/PRD.md"
 *   →  "20260402-020000_phase-2a"
 */
function slugFromPath(filePath: string): string {
  const parts = filePath.split('/');
  const prdIdx = parts.indexOf('WORK');
  if (prdIdx !== -1 && parts[prdIdx + 1]) {
    return parts[prdIdx + 1];
  }
  // Fallback: parent directory name
  return parts[parts.length - 2] || 'unknown';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const respond = () => process.stdout.write(JSON.stringify({ continue: true }) + '\n');

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of Bun.stdin.stream()) {
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) { respond(); return; }

    const input: HookInput = JSON.parse(raw);
    const sessionId = input.session_id || 'unknown';
    const filePath = input.tool_input?.file_path || '';

    // Fast path: only care about PRD.md writes
    if (!filePath.endsWith('/PRD.md') && !filePath.endsWith('PRD.md')) {
      respond();
      return;
    }

    // Read the PRD file
    if (!existsSync(filePath)) {
      process.stderr.write(`[PRDStateSync] PRD not found at ${filePath} — skipping\n`);
      respond();
      return;
    }

    const content = readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(content);

    const taskTitle = fm['task'] || 'unknown task';
    const slug = fm['slug'] || slugFromPath(filePath);

    // Read existing session work (preserve fields from AutoWorkCreation)
    const existing = readSessionWork(sessionId);
    const now = new Date().toISOString();

    const updated: SessionWork = {
      // Preserve existing fields, then overwrite the ones we manage
      ...(existing || {
        task_count: 1,
        created_at: now,
      }),
      session_id: sessionId,
      session_dir: slug,
      current_task: slug,
      task_title: taskTitle,
      prd_path: filePath,
      last_updated: now,
    };

    atomicWrite(sessionWorkPath(sessionId), JSON.stringify(updated, null, 2));
    process.stderr.write(`[PRDStateSync] Updated session ${sessionId.slice(0, 8)}… → ${slug}\n`);

  } catch (err) {
    process.stderr.write(`[PRDStateSync] Error (non-fatal): ${err}\n`);
  }

  respond();
}

main();
