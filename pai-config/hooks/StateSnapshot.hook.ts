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

// ========================================
// Types
// ========================================

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_output?: Record<string, unknown>;
}

interface Workstream {
  name: string;
  prd: string;
  domain: string;
  status: string;
  phase: string | null;
  last_action: string | null;
  last_updated: string;
  priority: string;
  criteria_summary: string;
  archived: boolean;
}

interface CurrentWork {
  last_updated: string;
  session_id: string;
  active_workstreams: Workstream[];
  foreground: string | null;
  // Legacy fields for backward compat
  active_prd?: string | null;
  active_workstream?: string | null;
  last_phase?: string | null;
  last_action?: string | null;
  criteria_summary?: string;
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

  // Use same directory as target to avoid cross-device rename failures (NVMe vs EBS)
  const tmpPath = join(dir, `.tmp-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filePath);
}

function defaultState(): CurrentWork {
  return {
    last_updated: new Date().toISOString(),
    session_id: '',
    active_workstreams: [],
    foreground: null,
  };
}

function readCurrentWork(): CurrentWork {
  if (!existsSync(CURRENT_WORK_PATH)) return defaultState();
  try {
    const raw = JSON.parse(readFileSync(CURRENT_WORK_PATH, 'utf-8'));
    // Migrate old single-workstream format
    if (!Array.isArray(raw.active_workstreams)) {
      const state = defaultState();
      state.last_updated = raw.last_updated || state.last_updated;
      state.session_id = raw.session_id || '';
      if (raw.active_prd) {
        state.active_workstreams.push({
          name: raw.active_workstream || 'default',
          prd: raw.active_prd,
          domain: 'work',
          status: 'IN_PROGRESS',
          phase: raw.last_phase || null,
          last_action: raw.last_action || null,
          last_updated: raw.last_updated || new Date().toISOString(),
          priority: 'medium',
          criteria_summary: raw.criteria_summary || '0/0',
          archived: false,
        });
        state.foreground = raw.active_workstream || 'default';
      }
      return state;
    }
    return raw;
  } catch {
    return defaultState();
  }
}

function getForegroundWorkstream(cw: CurrentWork): Workstream | undefined {
  return cw.active_workstreams.find(w => w.name === cw.foreground && !w.archived);
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

    // Update current-work.json (multi-workstream aware)
    const cw = readCurrentWork();
    cw.last_updated = new Date().toISOString();
    cw.session_id = input.session_id || cw.session_id;

    const actionDesc = `Entered ${phase} phase`;

    // Update foreground workstream if one exists
    const fg = getForegroundWorkstream(cw);
    if (fg) {
      fg.phase = phase;
      fg.last_action = actionDesc;
      fg.last_updated = new Date().toISOString();
    }

    atomicWrite(CURRENT_WORK_PATH, JSON.stringify(cw, null, 2));

    console.log(JSON.stringify({ continue: true }));
  } catch (err) {
    process.stderr.write(`[StateSnapshot] Error: ${err}\n`);
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
