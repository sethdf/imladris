#!/usr/bin/env bun
/**
 * McpLogger.hook.ts - MCP Call Audit Logger (PreToolUse + PostToolUse)
 *
 * PURPOSE:
 * Logs all MCP tool invocations for audit trail and determinism verification.
 * Implements Decision 2: all MCP calls logged.
 *
 * TRIGGER: PreToolUse + PostToolUse (matcher: mcp__*)
 *
 * INPUT (stdin JSON):
 * - tool_name: "mcp__serverName__toolName"
 * - tool_input: { ... } (PreToolUse) or tool_result (PostToolUse)
 * - session_id: Current session identifier
 *
 * OUTPUT:
 * - stdout: {"continue": true} (always — logging never blocks)
 * - Appends JSONL to ~/.claude/logs/mcp-calls.jsonl
 *
 * SIDE EFFECTS:
 * - Writes to: ~/.claude/logs/mcp-calls.jsonl
 *
 * ERROR HANDLING:
 * - All errors fail-open: log warning to stderr, return continue
 * - Missing log directory: auto-created
 */

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ========================================
// Types
// ========================================

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_result?: string;
}

interface McpLogEntry {
  timestamp: string;
  session_id: string;
  tool_name: string;
  direction: 'pre' | 'post';
  params?: Record<string, unknown>;
  response_size?: number;
  duration_ms?: number;
}

// ========================================
// State for duration tracking
// ========================================

const LOG_PATH = join(homedir(), '.claude', 'logs', 'mcp-calls.jsonl');
const TIMING_DIR = join(homedir(), '.claude', 'logs', '.mcp-timing');

// ========================================
// Logging
// ========================================

function ensureLogDir(): void {
  const dir = join(homedir(), '.claude', 'logs');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(TIMING_DIR)) {
    mkdirSync(TIMING_DIR, { recursive: true });
  }
}

function writeLogEntry(entry: McpLogEntry): void {
  try {
    ensureLogDir();
    appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
  } catch {
    console.error('Warning: Failed to write MCP log entry');
  }
}

function getTimingKey(sessionId: string, toolName: string): string {
  // Simple hash to avoid filesystem issues with long tool names
  const key = `${sessionId}-${toolName}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(TIMING_DIR, key);
}

// ========================================
// Hook Handlers
// ========================================

function handlePreToolUse(input: HookInput): void {
  // Log the call
  const entry: McpLogEntry = {
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    tool_name: input.tool_name,
    direction: 'pre',
    params: input.tool_input,
  };
  writeLogEntry(entry);

  // Save timing for duration calculation
  try {
    const timingPath = getTimingKey(input.session_id, input.tool_name);
    const { writeFileSync } = require('fs');
    writeFileSync(timingPath, Date.now().toString());
  } catch {
    // Non-critical — duration just won't be available
  }

  // Always continue
  console.log(JSON.stringify({ continue: true }));
}

function handlePostToolUse(input: HookInput): void {
  // Calculate duration if timing data exists
  let duration_ms: number | undefined;
  try {
    const timingPath = getTimingKey(input.session_id, input.tool_name);
    if (existsSync(timingPath)) {
      const { readFileSync, unlinkSync } = require('fs');
      const startTime = parseInt(readFileSync(timingPath, 'utf-8'), 10);
      duration_ms = Date.now() - startTime;
      unlinkSync(timingPath); // Clean up
    }
  } catch {
    // Non-critical
  }

  // Calculate response size
  const responseStr = typeof input.tool_result === 'string'
    ? input.tool_result
    : JSON.stringify(input.tool_result || '');
  const response_size = Buffer.byteLength(responseStr, 'utf-8');

  const entry: McpLogEntry = {
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    tool_name: input.tool_name,
    direction: 'post',
    response_size,
    duration_ms,
  };
  writeLogEntry(entry);

  // Always continue
  console.log(JSON.stringify({ continue: true }));
}

// ========================================
// Main
// ========================================

async function main(): Promise<void> {
  let input: HookInput;

  try {
    const reader = Bun.stdin.stream().getReader();
    let raw = '';
    const readLoop = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += new TextDecoder().decode(value, { stream: true });
      }
    })();

    const timeout = setTimeout(() => {
      if (!raw.trim()) {
        console.log(JSON.stringify({ continue: true }));
        process.exit(0);
      }
    }, 200);

    await Promise.race([readLoop, new Promise<void>(r => setTimeout(r, 200))]);
    clearTimeout(timeout);

    if (!raw.trim()) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    input = JSON.parse(raw);
  } catch {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  // Determine direction from hook type
  // Claude Code passes hook_type or we infer from presence of tool_result
  if (input.tool_result !== undefined) {
    handlePostToolUse(input);
  } else {
    handlePreToolUse(input);
  }
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true }));
});
