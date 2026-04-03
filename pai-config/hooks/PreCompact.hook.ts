#!/usr/bin/env bun
/**
 * PreCompact.hook.ts - Persist Context Summary Before Compaction (PreCompact)
 *
 * PURPOSE:
 * Saves Claude Code's auto-generated context summary to disk before context
 * is compacted. This preserves "what was I in the middle of" across compaction
 * events — the primary mechanism for zero-context-loss in long sessions.
 *
 * Without this hook, every compaction silently discards working context for
 * native-mode sessions (Algorithm sessions are already protected by PRD writes).
 *
 * TRIGGER: PreCompact
 *
 * INPUT (stdin JSON):
 * - session_id: Current session identifier
 * - summary: Auto-generated context summary from Claude Code (the valuable part)
 * - trigger: "auto" (always — only auto compaction fires this hook)
 *
 * OUTPUT:
 * - stdout: (none — PreCompact hooks don't need JSON response)
 *
 * SIDE EFFECTS:
 * - Writes MEMORY/WORK/{session_dir}/compaction-{timestamp}.md
 * - Writes MEMORY/STATE/last-compaction.json (fast-path for LoadContext)
 *
 * ERROR HANDLING:
 * - All errors fail-open (log to stderr, exit 0 — never block compaction)
 *
 * PERFORMANCE:
 * - Non-blocking: Yes (compaction waits for hook, so we exit immediately after write)
 * - Typical execution: <30ms (two file writes, no network)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

// ========================================
// Types
// ========================================

interface HookInput {
  session_id: string;
  summary?: string;
  trigger?: string;
}

interface CurrentWork {
  session_id: string;
  session_dir: string;
  task_title?: string;
  current_task?: string;
}

interface LastCompaction {
  session_id: string;
  session_dir: string | null;
  task_title: string;
  timestamp: string;
  checkpoint_path: string | null;
  summary_preview: string;
}

// ========================================
// Constants
// ========================================

const HOME = homedir();
const CLAUDE_DIR = process.env.PAI_DIR || join(HOME, '.claude');
const WORK_DIR = join(CLAUDE_DIR, 'MEMORY', 'WORK');
const STATE_DIR = join(CLAUDE_DIR, 'MEMORY', 'STATE');
const LAST_COMPACTION_PATH = join(STATE_DIR, 'last-compaction.json');

// ========================================
// Helpers
// ========================================

function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${Date.now()}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, filePath);
}

function readCurrentWork(sessionId: string): CurrentWork | null {
  const paths = [
    join(STATE_DIR, `current-work-${sessionId}.json`),
    join(STATE_DIR, 'current-work.json'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { /* skip */ }
    }
  }
  return null;
}

function getTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * Fallback: scan MEMORY/WORK/ for the most recently modified PRD.md.
 * Returns a CurrentWork-compatible object if found, null otherwise.
 * Used when session-scoped current-work file has no prd_path or points
 * to a non-existent file (e.g., stale AutoWorkCreation entry).
 */
function findMostRecentPrd(): CurrentWork | null {
  try {
    if (!existsSync(WORK_DIR)) return null;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h window
    let bestMtime = 0;
    let bestPath = '';

    const slugDirs = readdirSync(WORK_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const slug of slugDirs) {
      const prdPath = join(WORK_DIR, slug, 'PRD.md');
      if (!existsSync(prdPath)) continue;
      const mtime = statSync(prdPath).mtimeMs;
      if (mtime < cutoff) continue; // skip files older than 24h
      if (mtime > bestMtime) { bestMtime = mtime; bestPath = prdPath; }
    }

    if (!bestPath) return null;

    // Extract task title from frontmatter
    const content = readFileSync(bestPath, 'utf-8');
    const lines = content.split('\n');
    let taskTitle = 'active work';
    if (lines[0]?.trim() === '---') {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === '---') break;
        const colon = lines[i].indexOf(':');
        if (colon !== -1 && lines[i].slice(0, colon).trim() === 'task') {
          taskTitle = lines[i].slice(colon + 1).trim();
          break;
        }
      }
    }

    const slugName = bestPath.split('/').slice(-2, -1)[0] || 'unknown';
    process.stderr.write(`[PreCompact] Fallback scan found: ${slugName}\n`);
    return { session_id: 'unknown', session_dir: slugName, task_title: taskTitle };
  } catch (err) {
    process.stderr.write(`[PreCompact] Fallback scan error: ${err}\n`);
    return null;
  }
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
    if (!raw) return;

    const input: HookInput = JSON.parse(raw);
    const sessionId = input.session_id || 'unknown';
    const summary = input.summary?.trim() || '';

    if (!summary) {
      process.stderr.write('[PreCompact] No summary provided — skipping write\n');
      return;
    }

    // Find current work directory for this session.
    // Primary: session-scoped file written by AutoWorkCreation + PRDStateSync.
    // Fallback: scan MEMORY/WORK/ for most-recently-modified PRD.md (handles
    //   the case where PRDStateSync hasn't run yet or session file is stale).
    let currentWork = readCurrentWork(sessionId);
    const hasFreshPrdPath = currentWork?.prd_path && existsSync(currentWork.prd_path as string);
    if (!hasFreshPrdPath) {
      const fallback = findMostRecentPrd();
      if (fallback) {
        process.stderr.write(`[PreCompact] Session file stale/missing — using fallback scan\n`);
        currentWork = fallback;
      }
    }
    const sessionDir = currentWork?.session_dir || null;
    const taskTitle = currentWork?.task_title || 'unknown task';
    const timestamp = getTimestamp();

    // Write compaction checkpoint to session work dir (if it exists)
    let checkpointPath: string | null = null;
    if (sessionDir) {
      const workPath = join(WORK_DIR, sessionDir);
      if (existsSync(workPath)) {
        checkpointPath = join(workPath, `compaction-${timestamp}.md`);
        const content = `# Compaction Checkpoint

**Session:** ${sessionId}
**Task:** ${taskTitle}
**Timestamp:** ${new Date().toISOString()}
**Trigger:** ${input.trigger || 'auto'}

## Context Summary (auto-generated by Claude Code)

${summary}
`;
        atomicWrite(checkpointPath, content);
        process.stderr.write(`[PreCompact] Saved checkpoint: ${checkpointPath}\n`);
      }
    }

    // Always write last-compaction.json for fast LoadContext lookup
    const lastCompaction: LastCompaction = {
      session_id: sessionId,
      session_dir: sessionDir,
      task_title: taskTitle,
      timestamp: new Date().toISOString(),
      checkpoint_path: checkpointPath,
      summary_preview: summary.slice(0, 500),
    };
    atomicWrite(LAST_COMPACTION_PATH, JSON.stringify(lastCompaction, null, 2));
    process.stderr.write(`[PreCompact] Updated last-compaction.json\n`);

  } catch (err) {
    process.stderr.write(`[PreCompact] Error (non-fatal): ${err}\n`);
  }
  // Always exit cleanly — never block compaction
}

main();
