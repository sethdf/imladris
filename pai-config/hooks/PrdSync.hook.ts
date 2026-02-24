#!/usr/bin/env bun
/**
 * PrdSync.hook.ts - PRD Continuous Sync (PostToolUse)
 *
 * PURPOSE:
 * Syncs ISC criteria to the active PRD on disk immediately after
 * TaskCreate or TaskUpdate. This is the deterministic layer of
 * Decision 24: PRD continuous sync via hook + prompt.
 *
 * The PRD is the "saved game state" — working memory dies with the
 * session, but the PRD survives on disk. This hook ensures every
 * ISC change hits disk within milliseconds.
 *
 * TRIGGER: PostToolUse (matcher: TaskCreate|TaskUpdate)
 *
 * INPUT (stdin JSON):
 * - tool_name: "TaskCreate" or "TaskUpdate"
 * - tool_input: { subject, description, ... } or { taskId, status, ... }
 * - tool_output: { taskId, ... }
 * - session_id: Current session identifier
 *
 * OUTPUT:
 * - stdout: {"continue": true} (always — sync never blocks)
 *
 * SIDE EFFECTS:
 * - Updates active PRD's IDEAL STATE CRITERIA section
 * - Updates current-work.json with latest task state
 *
 * ERROR HANDLING:
 * - All errors fail-open: log to stderr, return continue
 * - Missing PRD or state dir: skip silently
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

// ========================================
// Helpers
// ========================================

function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Use same directory as target to avoid cross-device rename failures (NVMe vs EBS)
  const tmpPath = join(dir, `.tmp-prdsync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function findActivePrd(): string | null {
  const cw = readCurrentWork();
  // Check foreground workstream first
  const fg = getForegroundWorkstream(cw);
  if (fg?.prd && existsSync(fg.prd)) return fg.prd;
  // Legacy compat
  if (cw.active_prd && existsSync(cw.active_prd)) return cw.active_prd;

  // Scan for most recently modified PRD
  const workDir = join(HOME, '.claude', 'MEMORY', 'WORK');
  if (!existsSync(workDir)) return null;

  try {
    const { execSync } = require('child_process');
    // Find most recent PRD file
    const result = execSync(
      `find ${workDir} -name 'PRD-*.md' -type f -printf '%T@ %p\\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-`,
      { encoding: 'utf-8', timeout: 2000 }
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

function updatePrdIsc(prdPath: string, input: HookInput): void {
  if (!existsSync(prdPath)) return;

  let content = readFileSync(prdPath, 'utf-8');
  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};
  const toolOutput = input.tool_output || {};

  if (toolName === 'TaskCreate') {
    const subject = toolInput.subject as string || '';
    if (!subject.startsWith('ISC-')) return; // Only sync ISC criteria

    // Append to IDEAL STATE CRITERIA section
    const iscHeader = /^## IDEAL STATE CRITERIA/m;
    const nextHeader = /\n## [A-Z]/;

    if (iscHeader.test(content)) {
      // Find end of ISC section (next ## header or end of file)
      const iscMatch = content.match(iscHeader);
      if (iscMatch && iscMatch.index !== undefined) {
        const afterIsc = content.slice(iscMatch.index);
        const nextMatch = afterIsc.slice(1).match(nextHeader);
        const insertPos = nextMatch && nextMatch.index !== undefined
          ? iscMatch.index + 1 + nextMatch.index
          : content.length;

        // Build the criterion line
        const desc = toolInput.description as string || subject;
        const line = `- [ ] ${subject}\n`;

        // Insert before next section
        content = content.slice(0, insertPos) + line + content.slice(insertPos);
      }
    } else {
      // No ISC section yet — append one
      content += `\n## IDEAL STATE CRITERIA\n\n- [ ] ${subject}\n`;
    }

    atomicWrite(prdPath, content);
  }

  if (toolName === 'TaskUpdate') {
    const taskId = (toolInput.taskId as string) || '';
    const status = (toolInput.status as string) || '';
    const subject = (toolInput.subject as string) || '';

    if (status === 'completed') {
      // Mark criterion as checked: - [ ] ISC-... → - [x] ISC-...
      // Match by ISC prefix in the line
      const pattern = /^- \[ \] (ISC-\S+.*)/gm;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        // We can't easily match by taskId (it's internal), so we match all
        // TaskUpdate calls. The Algorithm typically updates one at a time.
        // If a subject is provided, match on that.
        if (subject && match[1].includes(subject)) {
          content = content.replace(match[0], `- [x] ${match[1]}`);
          break;
        }
      }
      atomicWrite(prdPath, content);
    }

    if (status === 'deleted') {
      // Remove the criterion line
      if (subject) {
        const lines = content.split('\n');
        const filtered = lines.filter(l => !l.includes(subject));
        content = filtered.join('\n');
        atomicWrite(prdPath, content);
      }
    }
  }
}

function countCriteria(prdPath: string): string {
  if (!existsSync(prdPath)) return '0/0';
  try {
    const content = readFileSync(prdPath, 'utf-8');
    const checked = (content.match(/^- \[x\]/gm) || []).length;
    const unchecked = (content.match(/^- \[ \]/gm) || []).length;
    return `${checked}/${checked + unchecked}`;
  } catch {
    return '0/0';
  }
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

    // Only process TaskCreate and TaskUpdate
    if (!['TaskCreate', 'TaskUpdate'].includes(input.tool_name)) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    // Find active PRD
    const prdPath = findActivePrd();

    if (prdPath) {
      // Sync ISC to PRD
      updatePrdIsc(prdPath, input);

      // Update current-work.json (multi-workstream aware)
      const cw = readCurrentWork();
      cw.last_updated = new Date().toISOString();
      cw.session_id = input.session_id || cw.session_id;

      const summary = countCriteria(prdPath);
      const actionDesc = input.tool_name === 'TaskCreate'
        ? `Created: ${(input.tool_input?.subject as string) || 'criterion'}`
        : `Updated: ${(input.tool_input?.status as string) || 'criterion'}`;

      // Find or create the workstream entry
      let fg = getForegroundWorkstream(cw);
      if (fg) {
        fg.criteria_summary = summary;
        fg.last_action = actionDesc;
        fg.last_updated = new Date().toISOString();
        fg.prd = prdPath;
      } else {
        // No foreground — add one
        const ws: Workstream = {
          name: 'default',
          prd: prdPath,
          domain: 'work',
          status: 'IN_PROGRESS',
          phase: null,
          last_action: actionDesc,
          last_updated: new Date().toISOString(),
          priority: 'medium',
          criteria_summary: summary,
          archived: false,
        };
        cw.active_workstreams.push(ws);
        cw.foreground = 'default';
      }

      atomicWrite(CURRENT_WORK_PATH, JSON.stringify(cw, null, 2));
    }

    console.log(JSON.stringify({ continue: true }));
  } catch (err) {
    process.stderr.write(`[PrdSync] Error: ${err}\n`);
    console.log(JSON.stringify({ continue: true }));
  }
}

main();
