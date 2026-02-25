import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const HOOK_PATH = join(__dirname, '..', '..', 'pai-config', 'hooks', 'StateSnapshot.hook.ts');

describe('StateSnapshot.hook.ts', () => {
  let tempHome: string;
  let stateDir: string;
  let currentWorkPath: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'state-snapshot-test-'));
    stateDir = join(tempHome, '.claude', 'state');
    currentWorkPath = join(stateDir, 'current-work.json');
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  function runHook(input: Record<string, unknown> | string): { stdout: string; stderr: string; status: number | null } {
    const stdinData = typeof input === 'string' ? input : JSON.stringify(input);
    const result = spawnSync('bun', ['run', HOOK_PATH], {
      input: stdinData,
      encoding: 'utf-8',
      env: { ...process.env, HOME: tempHome },
      timeout: 10000,
    });
    return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
  }

  function writeInitialState(foregroundName: string = 'test-workstream'): void {
    const state = {
      last_updated: new Date().toISOString(),
      session_id: 'prev-session',
      active_workstreams: [
        {
          name: foregroundName,
          prd: join(tempHome, 'test-prd.md'),
          domain: 'work',
          status: 'IN_PROGRESS',
          phase: null,
          last_action: null,
          last_updated: new Date().toISOString(),
          priority: 'medium',
          criteria_summary: '0/0',
          archived: false,
        },
      ],
      foreground: foregroundName,
    };
    writeFileSync(currentWorkPath, JSON.stringify(state, null, 2));
  }

  test('Voice curl with "Observe phase" updates current-work.json phase to OBSERVE', () => {
    writeInitialState();

    const payload = {
      session_id: 'test-session-001',
      tool_name: 'Bash',
      tool_input: {
        command: 'curl -X POST http://localhost:8888/notify -H "Content-Type: application/json" -d \'{"message":"Observe phase - analyzing system state"}\'',
      },
    };

    const result = runHook(payload);
    const output = JSON.parse(result.stdout.trim());
    expect(output.continue).toBe(true);

    const updatedState = JSON.parse(readFileSync(currentWorkPath, 'utf-8'));
    const fg = updatedState.active_workstreams.find((w: any) => w.name === 'test-workstream');
    expect(fg.phase).toBe('OBSERVE');
    expect(fg.last_action).toBe('Entered OBSERVE phase');
    expect(updatedState.session_id).toBe('test-session-001');
  });

  test('Voice curl with "Build phase" updates phase to BUILD', () => {
    writeInitialState();

    const payload = {
      session_id: 'test-session-002',
      tool_name: 'Bash',
      tool_input: {
        command: 'curl -X POST http://localhost:8888/notify -H "Content-Type: application/json" -d \'{"message":"Build phase - implementing tests"}\'',
      },
    };

    const result = runHook(payload);
    const output = JSON.parse(result.stdout.trim());
    expect(output.continue).toBe(true);

    const updatedState = JSON.parse(readFileSync(currentWorkPath, 'utf-8'));
    const fg = updatedState.active_workstreams.find((w: any) => w.name === 'test-workstream');
    expect(fg.phase).toBe('BUILD');
  });

  test('Non-voice-curl Bash commands are ignored', () => {
    writeInitialState();

    const payload = {
      session_id: 'test-session-003',
      tool_name: 'Bash',
      tool_input: {
        command: 'ls -la /tmp',
      },
    };

    const result = runHook(payload);
    const output = JSON.parse(result.stdout.trim());
    expect(output.continue).toBe(true);

    // State should not have changed (phase should still be null)
    const updatedState = JSON.parse(readFileSync(currentWorkPath, 'utf-8'));
    const fg = updatedState.active_workstreams.find((w: any) => w.name === 'test-workstream');
    expect(fg.phase).toBeNull();
  });

  test('Non-Bash tools are ignored', () => {
    writeInitialState();

    const payload = {
      session_id: 'test-session-004',
      tool_name: 'Read',
      tool_input: {
        file_path: '/some/file.txt',
      },
    };

    const result = runHook(payload);
    const output = JSON.parse(result.stdout.trim());
    expect(output.continue).toBe(true);
  });

  test('Empty stdin returns {continue: true}', () => {
    const result = spawnSync('bun', ['run', HOOK_PATH], {
      input: '',
      encoding: 'utf-8',
      env: { ...process.env, HOME: tempHome },
      timeout: 10000,
    });

    const output = JSON.parse(result.stdout.trim());
    expect(output.continue).toBe(true);
  });

  test('Voice curl without phase keyword does not update state', () => {
    writeInitialState();

    const payload = {
      session_id: 'test-session-005',
      tool_name: 'Bash',
      tool_input: {
        command: 'curl -X POST http://localhost:8888/notify -H "Content-Type: application/json" -d \'{"message":"Completed test suite implementation"}\'',
      },
    };

    const result = runHook(payload);
    const output = JSON.parse(result.stdout.trim());
    expect(output.continue).toBe(true);

    const updatedState = JSON.parse(readFileSync(currentWorkPath, 'utf-8'));
    const fg = updatedState.active_workstreams.find((w: any) => w.name === 'test-workstream');
    expect(fg.phase).toBeNull();
  });
});
