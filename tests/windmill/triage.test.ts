import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// These scripts use `const HOME = homedir()` at module level, so Bun's import
// cache freezes HOME. We use subprocess execution to get fresh HOME per test.

const HELPER = join(__dirname, '_run-helper.ts');
const TRIAGE_SCRIPT = join(__dirname, '..', '..', 'windmill', 'f', 'devops', 'auto_triage.ts');
const FEEDBACK_SCRIPT = join(__dirname, '..', '..', 'windmill', 'f', 'devops', 'triage_feedback.ts');

function runScript(scriptPath: string, args: unknown[], tempHome: string): any {
  const result = spawnSync('bun', ['run', HELPER, scriptPath, JSON.stringify(args)], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: tempHome },
    timeout: 30000,
  });
  const stdout = (result.stdout || '').trim();
  if (!stdout) {
    throw new Error(`Script produced no output. stderr: ${result.stderr}`);
  }
  return JSON.parse(stdout);
}

describe('auto_triage', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'triage-test-'));
    mkdirSync(join(tempHome, '.claude', 'logs'), { recursive: true });
    mkdirSync(join(tempHome, '.claude', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  test('returns error when source is missing', () => {
    const result = runScript(TRIAGE_SCRIPT, ['', 'alert', 'some payload'], tempHome);
    expect(result.error).toBe('source and payload are required');
  });

  test('returns error when payload is missing', () => {
    const result = runScript(TRIAGE_SCRIPT, ['slack', 'alert', ''], tempHome);
    expect(result.error).toBe('source and payload are required');
  });

  test('dry_run returns triage result or fallback without executing actions', () => {
    // auto_triage calls execSync('claude -p ...') which won't be available.
    // It should fall back to the error/fallback path.
    const result = runScript(
      TRIAGE_SCRIPT,
      ['test-source', 'test-event', 'A test payload for triage testing', true],
      tempHome,
    );

    // Without claude CLI, it hits the catch block and returns fallback
    if (result.error) {
      expect(result.fallback).toBeTruthy();
      expect(result.fallback.action).toBe('QUEUE');
      expect(result.fallback.source).toBe('test-source');
    } else if (result.dry_run) {
      expect(result.dry_run).toBe(true);
      expect(result.triage).toBeTruthy();
    }
  });
});

describe('triage_feedback', () => {
  let tempHome: string;
  let feedbackLog: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'triage-feedback-test-'));
    mkdirSync(join(tempHome, '.claude', 'logs'), { recursive: true });
    mkdirSync(join(tempHome, '.claude', 'state'), { recursive: true });
    feedbackLog = join(tempHome, '.claude', 'logs', 'triage-feedback.jsonl');
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  test('record action appends to JSONL', () => {
    const result = runScript(
      FEEDBACK_SCRIPT,
      ['record', 'evt-001', 'NOTIFY', 'critical', 'correct', 'Triage was accurate'],
      tempHome,
    );

    expect(result.recorded).toBe(true);
    expect(result.entry.event_id).toBe('evt-001');
    expect(result.entry.original_action).toBe('NOTIFY');
    expect(result.entry.actual_outcome).toBe('correct');

    // Verify JSONL file was written
    expect(existsSync(feedbackLog)).toBe(true);
    const logContent = readFileSync(feedbackLog, 'utf-8').trim();
    const entry = JSON.parse(logContent);
    expect(entry.event_id).toBe('evt-001');
  });

  test('record action requires event_id and actual_outcome', () => {
    const result = runScript(
      FEEDBACK_SCRIPT,
      ['record', '', 'NOTIFY', 'critical', '', ''],
      tempHome,
    );
    expect(result.error).toContain('event_id and actual_outcome are required');
  });

  test('stats returns calibration data with entries', () => {
    // Record several entries by running the script multiple times
    runScript(FEEDBACK_SCRIPT, ['record', 'evt-001', 'NOTIFY', 'critical', 'correct', ''], tempHome);
    runScript(FEEDBACK_SCRIPT, ['record', 'evt-002', 'QUEUE', 'medium', 'correct', ''], tempHome);
    runScript(FEEDBACK_SCRIPT, ['record', 'evt-003', 'AUTO', 'low', 'under_triaged', ''], tempHome);
    runScript(FEEDBACK_SCRIPT, ['record', 'evt-004', 'NOTIFY', 'high', 'over_triaged', ''], tempHome);

    const stats = runScript(FEEDBACK_SCRIPT, ['stats'], tempHome);

    expect(stats.total_events).toBe(4);
    expect(stats.accuracy_rate).toBe(50); // 2 correct out of 4
    expect(stats.recommendations).toBeTruthy();
    expect(stats.by_source).toBeTruthy();
  });

  test('stats with no entries returns informational message', () => {
    const result = runScript(FEEDBACK_SCRIPT, ['stats'], tempHome);
    expect(result.message).toContain('No triage feedback recorded');
  });
});
