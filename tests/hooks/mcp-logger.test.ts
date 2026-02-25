import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const HOOK_PATH = join(__dirname, '..', '..', 'pai-config', 'hooks', 'McpLogger.hook.ts');

describe('McpLogger.hook.ts', () => {
  let tempHome: string;
  let logDir: string;
  let logFile: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'mcp-logger-test-'));
    logDir = join(tempHome, '.claude', 'logs');
    logFile = join(logDir, 'mcp-calls.jsonl');
    mkdirSync(logDir, { recursive: true });
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

  test('Pre-call logs tool_name + direction "pre" to JSONL', () => {
    const payload = {
      session_id: 'test-session-001',
      tool_name: 'mcp__windmill__list_scripts',
      tool_input: { workspace: 'imladris' },
    };

    const result = runHook(payload);
    const output = JSON.parse(result.stdout.trim());
    expect(output.continue).toBe(true);

    // Verify log was written
    expect(existsSync(logFile)).toBe(true);
    const logContent = readFileSync(logFile, 'utf-8').trim();
    const entry = JSON.parse(logContent);

    expect(entry.tool_name).toBe('mcp__windmill__list_scripts');
    expect(entry.direction).toBe('pre');
    expect(entry.session_id).toBe('test-session-001');
    expect(entry.params).toEqual({ workspace: 'imladris' });
    expect(entry.timestamp).toBeTruthy();
  });

  test('Post-call logs tool_name + direction "post" to JSONL', () => {
    const payload = {
      session_id: 'test-session-002',
      tool_name: 'mcp__windmill__list_scripts',
      tool_result: '{"scripts": []}',
    };

    const result = runHook(payload);
    const output = JSON.parse(result.stdout.trim());
    expect(output.continue).toBe(true);

    expect(existsSync(logFile)).toBe(true);
    const logContent = readFileSync(logFile, 'utf-8').trim();
    const entry = JSON.parse(logContent);

    expect(entry.tool_name).toBe('mcp__windmill__list_scripts');
    expect(entry.direction).toBe('post');
    expect(entry.session_id).toBe('test-session-002');
    expect(entry.response_size).toBeGreaterThan(0);
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

  test('Non-MCP tool names are still processed', () => {
    const payload = {
      session_id: 'test-session-003',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
    };

    const result = runHook(payload);
    const output = JSON.parse(result.stdout.trim());
    expect(output.continue).toBe(true);

    // The hook logs all tools, not just MCP ones
    expect(existsSync(logFile)).toBe(true);
    const logContent = readFileSync(logFile, 'utf-8').trim();
    const entry = JSON.parse(logContent);
    expect(entry.tool_name).toBe('Bash');
    expect(entry.direction).toBe('pre');
  });
});
