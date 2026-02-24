#!/usr/bin/env bun
/**
 * StateSnapshot.hook.ts - Session State Tracker (PostToolUse)
 *
 * PURPOSE:
 * Updates current-work.json with Algorithm phase transitions and
 * environment state. Enables cold-start recovery (Decision 7) by
 * maintaining a persistent record of what the session was doing.
 *
 * TRIGGER: PostToolUse (matcher: Bash)
 * Detects phase transitions from voice curl commands.
 *
 * INPUT (stdin JSON):
 * - tool_name: "Bash"
 * - tool_input: { command: "curl ... notify ... phase" }
 * - session_id: Current session identifier
 *
 * OUTPUT:
 * - stdout: {"continue": true} (always — tracking never blocks)
 *
 * SIDE EFFECTS:
 * - Updates ~/.claude/state/current-work.json
 *
 * ERROR HANDLING:
 * - All errors fail-open
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { tmpdir } from 'os';

// ========================================
// Types
// ========================================

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_output?: Record<string, unknown>;
}

interface CurrentWork {
  last_updated: string;
  session_id: string;
  active_prd: string | null;
  active_workstream: string | null;
  last_phase: string | null;
  last_action: string | null;
  criteria_summary: string;
}

// ========================================
// Constants
// ========================================

const HOME = homedir();
const STATE_DIR = join(HOME, '.claude', 'state');
const CURRENT_WORK_PATH = join(STATE_DIR, 'current-work.json');

// Phase detection patterns from voice curl messages
const PHASE_PATTERNS: [RegExp, string][] = [
  [/Observe phase/i, 'OBSERVE'],
  [/Think phase/i, 'THINK'],
  [/Plan phase/i, 'PLAN'],
  [/Build phase/i, 'BUILD'],
  [/Execute phase/i, 'EXECUTE'],
  [/Verify phase/i, 'VERIFY'],
  [/Learn phase/i, 'LEARN'],
];

// ========================================
// Helpers
// ========================================

function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmpPath = join(tmpdir(), `state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filePath);
}

function readCurrentWork(): CurrentWork {
  if (!existsSync(CURRENT_WORK_PATH)) {
    return {
      last_updated: new Date().toISOString(),
      session_id: '',
      active_prd: null,
      active_workstream: null,
      last_phase: null,
      last_action: null,
      criteria_summary: '0/0',
    };
  }
  try {
    return JSON.parse(readFileSync(CURRENT_WORK_PATH, 'utf-8'));
  } catch {
    return {
      last_updated: new Date().toISOString(),
      session_id: '',
      active_prd: null,
      active_workstream: null,
      last_phase: null,
      last_action: null,
      criteria_summary: '0/0',
    };
  }
}

function detectPhase(command: string): string | null {
  for (const [pattern, phase] of PHASE_PATTERNS) {
    if (pattern.test(command)) return phase;
  }
  return null;
}

// ========================================
// Main
// ========================================

async function main(): Promise<void> {
  try {
    // Read stdin
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

    // Only process Bash commands
    if (input.tool_name !== 'Bash') {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    const command = (input.tool_input?.command as string) || '';

    // Check if this is a voice curl (phase announcement)
    if (!command.includes('localhost:8888/notify')) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    // Extract phase from the curl message
    const phase = detectPhase(command);
    if (!phase) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    // Update current-work.json
    const cw = readCurrentWork();
    cw.last_updated = new Date().toISOString();
    cw.session_id = input.session_id || cw.session_id;
    cw.last_phase = phase;
    cw.last_action = `Entered ${phase} phase`;

    atomicWrite(CURRENT_WORK_PATH, JSON.stringify(cw, null, 2));

    console.log(JSON.stringify({ continue: true }));
  } catch (err) {
    process.stderr.write(`[StateSnapshot] Error: ${err}\n`);
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
