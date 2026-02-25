import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// These scripts use `const HOME = homedir()` at module level, so Bun's import
// cache freezes HOME. We use subprocess execution to get fresh HOME per test.

const HELPER = join(__dirname, '_run-helper.ts');
const ACTIVITY_REPORT = join(__dirname, '..', '..', 'windmill', 'f', 'devops', 'activity_report.ts');
const CONTEXTUAL_SURFACE = join(__dirname, '..', '..', 'windmill', 'f', 'devops', 'contextual_surface.ts');
const TREND_ENGINE = join(__dirname, '..', '..', 'windmill', 'f', 'devops', 'trend_engine.ts');

function runScript(scriptPath: string, args: unknown[], tempHome: string, extraEnv?: Record<string, string>): any {
  const result = spawnSync('bun', ['run', HELPER, scriptPath, JSON.stringify(args)], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: tempHome, ...extraEnv },
    timeout: 30000,
  });
  const stdout = (result.stdout || '').trim();
  if (!stdout) {
    throw new Error(`Script produced no output. stderr: ${result.stderr}`);
  }
  return JSON.parse(stdout);
}

describe('activity_report', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'activity-report-test-'));
    mkdirSync(join(tempHome, '.claude', 'logs'), { recursive: true });
    mkdirSync(join(tempHome, '.claude', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  test('returns text format report with data', () => {
    // Write mock MCP log
    const mcpLogPath = join(tempHome, '.claude', 'logs', 'mcp-calls.jsonl');
    const now = new Date().toISOString();
    const entries = [
      { timestamp: now, tool_name: 'mcp__windmill__list_scripts', direction: 'pre' },
      { timestamp: now, tool_name: 'mcp__windmill__list_scripts', direction: 'post' },
      { timestamp: now, tool_name: 'mcp__sdp__list_tickets', direction: 'pre' },
    ];
    writeFileSync(mcpLogPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

    // Write mock state
    const statePath = join(tempHome, '.claude', 'state', 'current-work.json');
    writeFileSync(statePath, JSON.stringify({
      active_workstreams: [
        {
          name: 'Security Audit',
          domain: 'work',
          status: 'IN_PROGRESS',
          phase: 'BUILD',
          last_action: 'Implementing tests',
          last_updated: now,
          criteria_summary: '3/5',
          archived: false,
        },
      ],
    }));

    const result = runScript(ACTIVITY_REPORT, ['daily', 'text'], tempHome);

    expect(result.report).toContain('Activity Report');
    expect(result.report).toContain('MCP calls');
    expect(result.report).toContain('Security Audit');
    expect(result.report).toContain('windmill');
  });

  test('handles missing log files gracefully', () => {
    const result = runScript(ACTIVITY_REPORT, ['daily', 'text'], tempHome);

    expect(result.report).toContain('Activity Report');
    expect(result.report).toContain('Tool Usage: 0 MCP calls');
    expect(result.report).toContain('Active Workstreams: 0');
  });

  test('json format returns structured data', () => {
    const result = runScript(ACTIVITY_REPORT, ['daily', 'json'], tempHome);

    expect(result.title).toBe('Daily Activity Report');
    expect(result.summary).toBeTruthy();
    expect(result.summary.mcp_calls_total).toBe(0);
    expect(result.summary.active_workstreams).toBe(0);
  });
});

describe('feed_collector', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'feed-collector-test-'));
    mkdirSync(join(tempHome, '.claude', 'logs'), { recursive: true });
    mkdirSync(join(tempHome, '.claude', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  test('dry_run does not write files', () => {
    // Write a helper that mocks fetch before importing
    const mockHelper = join(tempHome, '_feed-mock-runner.ts');
    const feedCollectorPath = join(__dirname, '..', '..', 'windmill', 'f', 'devops', 'feed_collector.ts');
    writeFileSync(mockHelper, `
      globalThis.fetch = async () => new Response('', { status: 404 });
      const mod = await import("${feedCollectorPath}");
      const result = await mod.main("", false, true);
      console.log(JSON.stringify(result));
    `);

    const proc = spawnSync('bun', ['run', mockHelper], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: tempHome, WM_TOKEN: '' },
      timeout: 30000,
    });

    const result = JSON.parse(proc.stdout.trim());
    expect(result.dry_run).toBe(true);

    const feedLog = join(tempHome, '.claude', 'logs', 'feed-events.jsonl');
    const seenFile = join(tempHome, '.claude', 'state', 'feed-seen.json');
    expect(existsSync(feedLog)).toBe(false);
    expect(existsSync(seenFile)).toBe(false);
  });
});

describe('contextual_surface', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'contextual-surface-test-'));
    mkdirSync(join(tempHome, '.claude', 'logs'), { recursive: true });
    mkdirSync(join(tempHome, '.claude', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  test('handles no active workstreams', () => {
    const statePath = join(tempHome, '.claude', 'state', 'current-work.json');
    writeFileSync(statePath, JSON.stringify({
      active_workstreams: [],
      foreground: null,
    }));

    const result = runScript(CONTEXTUAL_SURFACE, [24, 2, true], tempHome);
    expect(result.message).toContain('No active');
  });

  test('handles missing state file', () => {
    const result = runScript(CONTEXTUAL_SURFACE, [24, 2, true], tempHome);
    expect(result.message).toContain('No active workstreams');
  });

  test('processes active workstreams with feed data', () => {
    // Write state with a workstream
    const prdDir = join(tempHome, '.claude', 'MEMORY', 'WORK', 'test');
    mkdirSync(prdDir, { recursive: true });
    const prdPath = join(prdDir, 'PRD-test.md');
    writeFileSync(prdPath, '# AWS Security Audit\n\n## CONTEXT\n\nAuditing EC2 instances for compliance.\n');

    const statePath = join(tempHome, '.claude', 'state', 'current-work.json');
    writeFileSync(statePath, JSON.stringify({
      active_workstreams: [
        {
          name: 'AWS Audit',
          prd: prdPath,
          domain: 'work',
          status: 'IN_PROGRESS',
          archived: false,
        },
      ],
      foreground: 'AWS Audit',
    }));

    // Write feed events
    const feedLog = join(tempHome, '.claude', 'logs', 'feed-events.jsonl');
    const feedItems = [
      { id: 'cve-1', title: 'Critical AWS EC2 vulnerability found in production', source: 'nvd', severity: 'CRITICAL', collected_at: new Date().toISOString() },
      { id: 'cve-2', title: 'Unrelated Python library issue', source: 'nvd', severity: 'LOW', collected_at: new Date().toISOString() },
    ];
    writeFileSync(feedLog, feedItems.map(i => JSON.stringify(i)).join('\n') + '\n');

    const result = runScript(CONTEXTUAL_SURFACE, [24, 1, true], tempHome);

    expect(result.workstreams_checked).toBe(1);
    expect(result.feed_items_scanned).toBe(2);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].workstream).toBe('AWS Audit');
  });
});

describe('trend_engine', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'trend-engine-test-'));
    mkdirSync(join(tempHome, '.claude', 'logs'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  test('returns insufficient_data for empty logs', () => {
    const result = runScript(TREND_ENGINE, ['mcp_calls', 'week', 90], tempHome);

    expect(result.trends).toHaveLength(1);
    expect(result.trends[0].trend).toBe('insufficient_data');
    expect(result.trends[0].metric).toBe('mcp_calls');
  });

  test('detects trend with sufficient data', () => {
    // Create log entries across several weeks with increasing pattern
    const mcpLog = join(tempHome, '.claude', 'logs', 'mcp-calls.jsonl');
    const entries: string[] = [];

    // 4 weeks of data: first 2 weeks low, last 2 weeks high
    for (let week = 0; week < 4; week++) {
      const count = week < 2 ? 2 : 8;
      for (let i = 0; i < count; i++) {
        const date = new Date();
        date.setDate(date.getDate() - (3 - week) * 7 - i);
        entries.push(JSON.stringify({
          timestamp: date.toISOString(),
          tool_name: 'mcp__windmill__test',
          direction: 'pre',
        }));
      }
    }
    writeFileSync(mcpLog, entries.join('\n') + '\n');

    const result = runScript(TREND_ENGINE, ['mcp_calls', 'week', 90], tempHome);

    expect(result.trends).toHaveLength(1);
    // With data present, trend should not be insufficient_data
    expect(result.trends[0].buckets.length).toBeGreaterThan(0);
    expect(typeof result.trends[0].change_pct).toBe('number');
  });

  test('analyzes all metrics when metric="all"', () => {
    const result = runScript(TREND_ENGINE, ['all', 'week', 90], tempHome);

    expect(result.metrics_analyzed).toBe(4);
    expect(result.trends.map((t: any) => t.metric).sort()).toEqual([
      'entity_extractions',
      'feed_events',
      'mcp_calls',
      'triage_feedback',
    ]);
  });

  test('unknown metric returns insufficient_data with description', () => {
    const result = runScript(TREND_ENGINE, ['nonexistent_metric', 'week', 90], tempHome);

    expect(result.trends[0].trend).toBe('insufficient_data');
    expect(result.trends[0].description).toContain('Unknown metric');
  });
});
