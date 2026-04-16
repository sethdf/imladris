#!/usr/bin/env bun
/**
 * SDPWorkSync.hook.ts — Auto-create SDP tasks for PAI work sessions
 *
 * PURPOSE: When a new PAI work task starts, create a corresponding SDP task
 * so adhoc PAI sessions surface in ServiceDesk Plus alongside triage-generated tasks.
 *
 * TRIGGER: UserPromptSubmit (fires after AutoWorkCreation.hook.ts)
 * DEDUP: sdp-sync-{session_id}.json tracks which tasks already have SDP entries
 * FAIL-SAFE: Always exits 0 — never blocks the user prompt
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const STATE_DIR = join(homedir(), '.claude', 'MEMORY', 'STATE');
const WINDMILL_BASE = 'http://127.0.0.1:8000';
const WORKSPACE = 'imladris';
const CREATE_TASK_PATH = 'f/domains/work/actions/create_task';

interface HookInput {
  session_id: string;
  prompt?: string;
  user_prompt?: string;
}

interface CurrentWork {
  session_id: string;
  current_task: string;
  task_title: string;
  task_count: number;
  prd_path?: string;
}

interface SdpSyncState {
  [taskSlug: string]: {
    triggered_at: string;
    job_id?: string;
    sdp_task_id?: string;
  };
}

function getWindmillToken(): string | null {
  try {
    const remotesFile = join(homedir(), '.config', 'windmill', 'remotes.ndjson');
    if (!existsSync(remotesFile)) return null;
    const lines = readFileSync(remotesFile, 'utf-8').split('\n').filter(l => l.trim());
    if (lines.length === 0) return null;
    const remote = JSON.parse(lines[0]);
    return remote.token || null;
  } catch {
    return null;
  }
}

async function triggerWindmillJob(
  token: string,
  scriptPath: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  try {
    const resp = await fetch(
      `${WINDMILL_BASE}/api/w/${WORKSPACE}/jobs/run/p/${scriptPath}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!resp.ok) return null;
    const jobId = await resp.text();
    return jobId.trim().replace(/^"|"$/g, '');
  } catch {
    return null;
  }
}

async function main() {
  try {
    // Read hook input
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) process.exit(0);

    const data: HookInput = JSON.parse(raw);
    const sessionId = data.session_id || 'unknown';

    // Read current work state (written by AutoWorkCreation.hook.ts)
    const currentWorkFile = join(STATE_DIR, `current-work-${sessionId}.json`);
    if (!existsSync(currentWorkFile)) process.exit(0);

    const currentWork: CurrentWork = JSON.parse(readFileSync(currentWorkFile, 'utf-8'));

    // Skip non-work sessions (no task title = question or conversational)
    if (!currentWork.task_title || currentWork.task_title.trim().length === 0) {
      process.exit(0);
    }

    const taskSlug = currentWork.current_task;
    if (!taskSlug) process.exit(0);

    // Check dedup state
    const sdpSyncFile = join(STATE_DIR, `sdp-sync-${sessionId}.json`);
    const sdpSync: SdpSyncState = existsSync(sdpSyncFile)
      ? JSON.parse(readFileSync(sdpSyncFile, 'utf-8'))
      : {};

    if (sdpSync[taskSlug]) {
      // Already triggered/created for this task — skip
      process.exit(0);
    }

    // Get Windmill token
    const token = getWindmillToken();
    if (!token) process.exit(0);

    // Build SDP task description
    const prdRef = currentWork.prd_path ? `\nPRD: ${currentWork.prd_path}` : '';
    const description = `PAI adhoc session task\nSession: ${sessionId}${prdRef}\n\nCreated automatically when PAI session started this task.`;

    // Trigger Windmill job (fire and forget — don't block)
    const jobId = await triggerWindmillJob(token, CREATE_TASK_PATH, {
      title: `[PAI] ${currentWork.task_title}`,
      description,
      priority: 'Medium',
      status: 'Open',
    });

    // Record trigger in dedup state (even if job_id is null — prevents retry spam)
    sdpSync[taskSlug] = {
      triggered_at: new Date().toISOString(),
      ...(jobId ? { job_id: jobId } : {}),
    };

    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(sdpSyncFile, JSON.stringify(sdpSync, null, 2), 'utf-8');

    if (jobId) {
      console.error(`[SDPWorkSync] Triggered SDP task creation: job ${jobId} for "${currentWork.task_title}"`);
    }
  } catch {
    // Silent fail — never block the user
  }

  process.exit(0);
}

main();
