import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const HOOK_PATH = join(__dirname, '..', '..', 'pai-config', 'hooks', 'PrdSync.hook.ts');

describe('PrdSync.hook.ts', () => {
  let tempHome: string;
  let stateDir: string;
  let workDir: string;
  let currentWorkPath: string;
  let prdPath: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'prd-sync-test-'));
    stateDir = join(tempHome, '.claude', 'state');
    workDir = join(tempHome, '.claude', 'MEMORY', 'WORK', 'test-ws');
    currentWorkPath = join(stateDir, 'current-work.json');
    prdPath = join(workDir, 'PRD-20260224-test-workstream.md');

    mkdirSync(stateDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  function writeInitialPrd(content: string): void {
    writeFileSync(prdPath, content);
  }

  function writeInitialState(): void {
    const state = {
      last_updated: new Date().toISOString(),
      session_id: 'prev-session',
      active_workstreams: [
        {
          name: 'test-workstream',
          prd: prdPath,
          domain: 'work',
          status: 'IN_PROGRESS',
          phase: 'BUILD',
          last_action: null,
          last_updated: new Date().toISOString(),
          priority: 'medium',
          criteria_summary: '0/0',
          archived: false,
        },
      ],
      foreground: 'test-workstream',
    };
    writeFileSync(currentWorkPath, JSON.stringify(state, null, 2));
  }

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

  test('TaskCreate with ISC- subject appends to PRD IDEAL STATE CRITERIA section', () => {
    const prdContent = `# Test PRD

## IDEAL STATE CRITERIA

- [ ] ISC-001 Existing criterion

## CONTEXT

Some context here.
`;
    writeInitialPrd(prdContent);
    writeInitialState();

    const payload = {
      session_id: 'test-session-001',
      tool_name: 'TaskCreate',
      tool_input: {
        subject: 'ISC-002 New test criterion',
        description: 'A new criterion for testing',
      },
      tool_output: {
        taskId: 'task-abc-123',
      },
    };

    const result = runHook(payload);
    const output = JSON.parse(result.stdout.trim());
    expect(output.continue).toBe(true);

    const updatedPrd = readFileSync(prdPath, 'utf-8');
    expect(updatedPrd).toContain('ISC-001 Existing criterion');
    expect(updatedPrd).toContain('ISC-002 New test criterion');
  });

  test('TaskUpdate with status=completed marks criterion as [x]', () => {
    const prdContent = `# Test PRD

## IDEAL STATE CRITERIA

- [ ] ISC-001 First criterion
- [ ] ISC-002 Second criterion

## CONTEXT

Some context here.
`;
    writeInitialPrd(prdContent);
    writeInitialState();

    const payload = {
      session_id: 'test-session-002',
      tool_name: 'TaskUpdate',
      tool_input: {
        taskId: 'task-abc-123',
        status: 'completed',
        subject: 'ISC-001',
      },
    };

    const result = runHook(payload);
    const output = JSON.parse(result.stdout.trim());
    expect(output.continue).toBe(true);

    const updatedPrd = readFileSync(prdPath, 'utf-8');
    expect(updatedPrd).toContain('- [x] ISC-001 First criterion');
    expect(updatedPrd).toContain('- [ ] ISC-002 Second criterion');
  });

  test('Non-ISC TaskCreate is ignored', () => {
    const prdContent = `# Test PRD

## IDEAL STATE CRITERIA

- [ ] ISC-001 Existing criterion

## CONTEXT
`;
    writeInitialPrd(prdContent);
    writeInitialState();

    const payload = {
      session_id: 'test-session-003',
      tool_name: 'TaskCreate',
      tool_input: {
        subject: 'Regular task without ISC prefix',
        description: 'This should be ignored',
      },
    };

    const result = runHook(payload);
    const output = JSON.parse(result.stdout.trim());
    expect(output.continue).toBe(true);

    const updatedPrd = readFileSync(prdPath, 'utf-8');
    expect(updatedPrd).not.toContain('Regular task without ISC prefix');
    expect(updatedPrd).toContain('ISC-001 Existing criterion');
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

  test('Non-Task tool names are ignored', () => {
    writeInitialState();
    writeInitialPrd('# PRD\n## IDEAL STATE CRITERIA\n');

    const payload = {
      session_id: 'test-session-004',
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
    };

    const result = runHook(payload);
    const output = JSON.parse(result.stdout.trim());
    expect(output.continue).toBe(true);
  });

  test('TaskCreate appends ISC section if none exists', () => {
    const prdContent = `# Test PRD

Some content without ISC section.
`;
    writeInitialPrd(prdContent);
    writeInitialState();

    const payload = {
      session_id: 'test-session-005',
      tool_name: 'TaskCreate',
      tool_input: {
        subject: 'ISC-001 First criterion ever',
      },
    };

    const result = runHook(payload);
    const output = JSON.parse(result.stdout.trim());
    expect(output.continue).toBe(true);

    const updatedPrd = readFileSync(prdPath, 'utf-8');
    expect(updatedPrd).toContain('## IDEAL STATE CRITERIA');
    expect(updatedPrd).toContain('ISC-001 First criterion ever');
  });

  test('current-work.json criteria_summary is updated after TaskCreate', () => {
    const prdContent = `# Test PRD

## IDEAL STATE CRITERIA

- [ ] ISC-001 Existing criterion
`;
    writeInitialPrd(prdContent);
    writeInitialState();

    const payload = {
      session_id: 'test-session-006',
      tool_name: 'TaskCreate',
      tool_input: {
        subject: 'ISC-002 Second criterion',
      },
    };

    runHook(payload);

    const updatedState = JSON.parse(readFileSync(currentWorkPath, 'utf-8'));
    const fg = updatedState.active_workstreams.find((w: any) => w.name === 'test-workstream');
    // After adding ISC-002, there should be 0 checked out of 2 total
    expect(fg.criteria_summary).toBe('0/2');
  });
});
