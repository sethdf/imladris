import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const HOOK_PATH = join(__dirname, '..', '..', 'pai-config', 'hooks', 'McpSecurityValidator.hook.ts');

describe('McpSecurityValidator.hook.ts', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'mcp-security-test-'));
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

  test('Read-only MCP tools return {continue: true}', () => {
    const readOnlyTools = [
      'mcp__windmill__list_scripts',
      'mcp__windmill__get_resource',
      'mcp__steampipe__describe_instances',
      'mcp__sdp__fetch_tickets',
      'mcp__github__search_repos',
      'mcp__aws__query_resources',
    ];

    for (const toolName of readOnlyTools) {
      const payload = {
        session_id: 'test-session',
        tool_name: toolName,
        tool_input: {},
      };

      const result = runHook(payload);
      const output = JSON.parse(result.stdout.trim());
      expect(output.continue).toBe(true);
    }
  });

  test('Write/destructive MCP tools return decision "ask"', () => {
    const writeTools = [
      { name: 'mcp__windmill__create_script', pattern: 'create' },
      { name: 'mcp__windmill__update_resource', pattern: 'update' },
      { name: 'mcp__windmill__delete_script', pattern: 'delete' },
      { name: 'mcp__sdp__close_ticket', pattern: 'close' },
      { name: 'mcp__aws__terminate_instance', pattern: 'terminate' },
      { name: 'mcp__sdp__add_note', pattern: 'add' },
      { name: 'mcp__github__send_notification', pattern: 'send' },
    ];

    for (const { name, pattern } of writeTools) {
      const payload = {
        session_id: 'test-session',
        tool_name: name,
        tool_input: { id: 'test-123' },
      };

      const result = runHook(payload);
      const output = JSON.parse(result.stdout.trim());
      expect(output.decision).toBe('ask');
      expect(output.message).toContain('MCP SECURITY');
      expect(output.message).toContain(pattern);
    }
  });

  test('Safe pattern takes precedence over write pattern in compound names', () => {
    // "get_update_status" contains both "get" (safe) and "update" (write)
    // Safe patterns take precedence
    const payload = {
      session_id: 'test-session',
      tool_name: 'mcp__windmill__get_update_status',
      tool_input: {},
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

  test('Malformed JSON returns {continue: true} (fail-open)', () => {
    const result = runHook('this is not json {{{');
    const output = JSON.parse(result.stdout.trim());
    expect(output.continue).toBe(true);
  });

  test('Tool name with no action part returns {continue: true}', () => {
    const payload = {
      session_id: 'test-session',
      tool_name: 'mcp__windmill',
      tool_input: {},
    };

    const result = runHook(payload);
    const output = JSON.parse(result.stdout.trim());
    expect(output.continue).toBe(true);
  });
});
