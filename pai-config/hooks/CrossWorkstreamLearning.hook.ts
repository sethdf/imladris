#!/usr/bin/env bun
/**
 * CrossWorkstreamLearning.hook.ts - Auto-Extract Patterns on Session End
 *
 * PURPOSE:
 * Extracts reusable patterns and insights when a session ends.
 * Scans the active workstream's PRD for completed ISC criteria and
 * logs learnings to a cross-workstream knowledge file.
 *
 * TRIGGER: SessionEnd
 *
 * INPUT (stdin JSON):
 * - session_id: Current session identifier
 *
 * OUTPUT:
 * - stdout: (none — SessionEnd hooks don't need to return JSON)
 *
 * SIDE EFFECTS:
 * - Appends to ~/.claude/MEMORY/LEARNING/cross-workstream-patterns.jsonl
 *
 * ERROR HANDLING:
 * - All errors fail-open (log to stderr, exit cleanly)
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ========================================
// Types
// ========================================

interface HookInput {
  session_id: string;
}

interface CurrentWork {
  session_id: string;
  foreground: string | null;
  active_workstreams: Array<{
    name: string;
    prd: string;
    domain: string;
    phase: string | null;
    criteria_summary: string;
    archived: boolean;
  }>;
}

interface LearningEntry {
  timestamp: string;
  session_id: string;
  workstream: string;
  domain: string;
  phase_reached: string | null;
  criteria_summary: string;
  completed_criteria: string[];
  failed_criteria: string[];
}

// ========================================
// Constants
// ========================================

const HOME = homedir();
const STATE_DIR = join(HOME, '.claude', 'state');
const CURRENT_WORK_PATH = join(STATE_DIR, 'current-work.json');
const LEARNING_DIR = join(HOME, '.claude', 'MEMORY', 'LEARNING');
const PATTERNS_PATH = join(LEARNING_DIR, 'cross-workstream-patterns.jsonl');

// ========================================
// Helpers
// ========================================

function readCurrentWork(): CurrentWork | null {
  if (!existsSync(CURRENT_WORK_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CURRENT_WORK_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function extractCriteriaFromPrd(prdPath: string): { completed: string[]; failed: string[] } {
  if (!existsSync(prdPath)) return { completed: [], failed: [] };

  try {
    const content = readFileSync(prdPath, 'utf-8');
    const completed: string[] = [];
    const failed: string[] = [];

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      // Match checked criteria: - [x] ISC-...
      const checkedMatch = trimmed.match(/^- \[x\] (ISC-\S+)/);
      if (checkedMatch) {
        completed.push(checkedMatch[1]);
        continue;
      }
      // Match unchecked criteria: - [ ] ISC-...
      const uncheckedMatch = trimmed.match(/^- \[ \] (ISC-\S+)/);
      if (uncheckedMatch) {
        failed.push(uncheckedMatch[1]);
      }
    }

    return { completed, failed };
  } catch {
    return { completed: [], failed: [] };
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
    const cw = readCurrentWork();
    if (!cw?.foreground) return;

    const fg = cw.active_workstreams.find(
      w => w.name === cw.foreground && !w.archived
    );
    if (!fg?.prd) return;

    const { completed, failed } = extractCriteriaFromPrd(fg.prd);

    // Only log if there's meaningful data (at least one criterion)
    if (completed.length === 0 && failed.length === 0) return;

    const entry: LearningEntry = {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      workstream: fg.name,
      domain: fg.domain,
      phase_reached: fg.phase,
      criteria_summary: fg.criteria_summary,
      completed_criteria: completed,
      failed_criteria: failed,
    };

    // Ensure directory exists
    if (!existsSync(LEARNING_DIR)) {
      mkdirSync(LEARNING_DIR, { recursive: true });
    }

    appendFileSync(PATTERNS_PATH, JSON.stringify(entry) + '\n');
  } catch (err) {
    process.stderr.write(`[CrossWorkstreamLearning] Error: ${err}\n`);
  }
}

main();
