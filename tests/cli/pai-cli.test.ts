import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PAI_SCRIPT = join(__dirname, '..', '..', 'scripts', 'pai');

describe('pai CLI', () => {
  let tempHome: string;
  let stateDir: string;
  let workDir: string;
  let currentWorkPath: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'pai-cli-test-'));
    stateDir = join(tempHome, '.claude', 'state');
    workDir = join(tempHome, '.claude', 'MEMORY', 'WORK');
    currentWorkPath = join(stateDir, 'current-work.json');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  function runPai(...args: string[]): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync('bun', ['run', PAI_SCRIPT, ...args], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: tempHome,
        // PATH must include claude but we don't want it to actually run
        // The script calls execSync('claude -p ...') which will fail and be caught
      },
      timeout: 15000,
    });
    return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
  }

  function readState(): any {
    if (!existsSync(currentWorkPath)) return null;
    return JSON.parse(readFileSync(currentWorkPath, 'utf-8'));
  }

  function writeState(state: any): void {
    writeFileSync(currentWorkPath, JSON.stringify(state, null, 2));
  }

  test('jobs with no workstreams shows "No active workstreams"', () => {
    const result = runPai('jobs');
    expect(result.stdout).toContain('No active workstreams');
  });

  test('work "Test" creates workstream entry in current-work.json', () => {
    // The `pai work` command will try to call `claude -p ...` which will fail,
    // but the state should still be written before that call.
    const result = runPai('work', 'Test Task');

    // Despite claude failing, the state file should be created
    const state = readState();
    expect(state).toBeTruthy();
    expect(state.active_workstreams).toHaveLength(1);
    expect(state.active_workstreams[0].name).toBe('Test Task');
    expect(state.active_workstreams[0].status).toBe('DRAFT');
    expect(state.active_workstreams[0].domain).toBe('work');
    expect(state.foreground).toBe('Test Task');

    // PRD path should be set
    expect(state.active_workstreams[0].prd).toContain('test-task');
    expect(state.active_workstreams[0].prd).toContain('PRD-');
  });

  test('shelve sets foreground to null and status to SHELVED', () => {
    // Pre-populate state with an active workstream
    writeState({
      last_updated: new Date().toISOString(),
      session_id: 'test',
      active_workstreams: [
        {
          name: 'Active Task',
          prd: join(workDir, 'test', 'PRD-test.md'),
          domain: 'work',
          status: 'IN_PROGRESS',
          phase: 'BUILD',
          last_action: 'Building tests',
          last_updated: new Date().toISOString(),
          priority: 'medium',
          criteria_summary: '2/5',
          archived: false,
        },
      ],
      foreground: 'Active Task',
    });

    const result = runPai('shelve');
    expect(result.stdout).toContain('Shelved');

    const state = readState();
    expect(state.foreground).toBeNull();
    const ws = state.active_workstreams[0];
    expect(ws.status).toBe('SHELVED');
    expect(ws.last_action).toBe('Shelved by user');
  });

  test('archive "Test" marks workstream as archived', () => {
    writeState({
      last_updated: new Date().toISOString(),
      session_id: 'test',
      active_workstreams: [
        {
          name: 'Completed Task',
          prd: join(workDir, 'test', 'PRD-test.md'),
          domain: 'work',
          status: 'COMPLETE',
          phase: 'VERIFY',
          last_action: 'All criteria met',
          last_updated: new Date().toISOString(),
          priority: 'medium',
          criteria_summary: '5/5',
          archived: false,
        },
      ],
      foreground: 'Completed Task',
    });

    const result = runPai('archive', 'Completed Task');
    expect(result.stdout).toContain('Archived');

    const state = readState();
    expect(state.active_workstreams[0].archived).toBe(true);
    expect(state.active_workstreams[0].status).toBe('ARCHIVED');
    expect(state.foreground).toBeNull();
  });

  test('cleanup archives stale workstreams', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

    writeState({
      last_updated: new Date().toISOString(),
      session_id: 'test',
      active_workstreams: [
        {
          name: 'Stale Task',
          prd: join(workDir, 'stale', 'PRD-stale.md'),
          domain: 'work',
          status: 'IN_PROGRESS',
          phase: null,
          last_action: null,
          last_updated: eightDaysAgo,
          priority: 'medium',
          criteria_summary: '0/0',
          archived: false,
        },
        {
          name: 'Fresh Task',
          prd: join(workDir, 'fresh', 'PRD-fresh.md'),
          domain: 'work',
          status: 'IN_PROGRESS',
          phase: 'BUILD',
          last_action: 'Working',
          last_updated: oneDayAgo,
          priority: 'medium',
          criteria_summary: '1/3',
          archived: false,
        },
      ],
      foreground: 'Fresh Task',
    });

    const result = runPai('cleanup');
    expect(result.stdout).toContain('Stale Task');

    const state = readState();
    const staleWs = state.active_workstreams.find((w: any) => w.name === 'Stale Task');
    const freshWs = state.active_workstreams.find((w: any) => w.name === 'Fresh Task');

    expect(staleWs.archived).toBe(true);
    expect(staleWs.status).toBe('ARCHIVED');
    expect(freshWs.archived).toBe(false);
    expect(freshWs.status).toBe('IN_PROGRESS');
  });

  test('domain inference: "camera shopping" is personal', () => {
    runPai('work', 'camera shopping');

    const state = readState();
    expect(state.active_workstreams[0].domain).toBe('personal');
  });

  test('domain inference: "AWS audit" is work', () => {
    runPai('work', 'AWS audit');

    const state = readState();
    expect(state.active_workstreams[0].domain).toBe('work');
  });

  test('shelve with no active workstream shows message', () => {
    const result = runPai('shelve');
    expect(result.stdout).toContain('No active workstream');
  });

  test('archive non-existent workstream shows message', () => {
    writeState({
      last_updated: new Date().toISOString(),
      session_id: 'test',
      active_workstreams: [],
      foreground: null,
    });

    const result = runPai('archive', 'Nonexistent');
    expect(result.stdout).toContain('No active workstream');
  });

  test('no arguments shows usage', () => {
    const result = runPai();
    expect(result.stdout).toContain('pai work');
    expect(result.stdout).toContain('pai shelve');
    expect(result.stdout).toContain('pai jobs');
  });
});
