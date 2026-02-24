#!/usr/bin/env bun
/**
 * McpSecurityValidator.hook.ts - MCP Write Operation Gatekeeper (PreToolUse)
 *
 * PURPOSE:
 * Intercepts MCP tool calls that perform write/mutate operations and
 * prompts for user confirmation before execution.
 * Implements Decision 27: confirmation for write API calls.
 *
 * TRIGGER: PreToolUse (matcher: mcp__*)
 *
 * INPUT (stdin JSON):
 * - tool_name: "mcp__serverName__toolName"
 * - tool_input: { ... }
 * - session_id: Current session identifier
 *
 * OUTPUT:
 * - {"continue": true} → Read-only operation, allow
 * - {"decision": "ask", "message": "..."} → Write operation, prompt user
 *
 * DETECTION METHOD:
 * Examines the tool name (third segment after mcp__server__) for write
 * operation indicators: create, update, delete, put, post, set, add,
 * remove, modify, patch, insert, drop, execute, run, send.
 *
 * ERROR HANDLING:
 * - Fail-open on any error (log warning, return continue)
 */

// ========================================
// Types
// ========================================

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
}

// ========================================
// Write Operation Detection
// ========================================

// Patterns that indicate a write/mutate operation
// Matched against the tool name (case-insensitive)
const WRITE_PATTERNS = [
  'create',
  'update',
  'delete',
  'put',
  'post',
  'set',
  'add',
  'remove',
  'modify',
  'patch',
  'insert',
  'drop',
  'execute',
  'run',
  'send',
  'close',
  'resolve',
  'assign',
  'approve',
  'reject',
  'terminate',
  'destroy',
  'purge',
];

// Patterns that are explicitly safe (read-only)
// Takes precedence over write patterns
const SAFE_PATTERNS = [
  'get',
  'list',
  'describe',
  'read',
  'fetch',
  'query',
  'search',
  'find',
  'show',
  'view',
  'check',
  'count',
  'exists',
  'status',
  'version',
  'info',
  'metadata',
];

function isWriteOperation(toolName: string): { isWrite: boolean; matchedPattern?: string } {
  // Tool names look like: mcp__windmill__create_script
  // Extract the action part (everything after server name)
  const parts = toolName.split('__');
  // parts[0] = "mcp", parts[1] = server, parts[2+] = tool name
  const actionPart = parts.slice(2).join('_').toLowerCase();

  if (!actionPart) {
    return { isWrite: false };
  }

  // Check safe patterns first (read-only takes precedence)
  for (const pattern of SAFE_PATTERNS) {
    if (actionPart.includes(pattern)) {
      return { isWrite: false };
    }
  }

  // Check write patterns
  for (const pattern of WRITE_PATTERNS) {
    if (actionPart.includes(pattern)) {
      return { isWrite: true, matchedPattern: pattern };
    }
  }

  // Unknown operation — allow (fail-open)
  return { isWrite: false };
}

function formatToolInfo(toolName: string, toolInput?: Record<string, unknown>): string {
  const parts = toolName.split('__');
  const server = parts[1] || 'unknown';
  const action = parts.slice(2).join('_') || 'unknown';

  let info = `Server: ${server}\nAction: ${action}`;

  if (toolInput) {
    // Show key params without values that might be huge
    const keys = Object.keys(toolInput);
    if (keys.length > 0) {
      const paramSummary = keys.map(k => {
        const v = toolInput[k];
        if (typeof v === 'string' && v.length > 100) {
          return `${k}: <${v.length} chars>`;
        }
        return `${k}: ${JSON.stringify(v)}`;
      }).join('\n  ');
      info += `\nParams:\n  ${paramSummary}`;
    }
  }

  return info;
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

  // Check if this is a write operation
  const { isWrite, matchedPattern } = isWriteOperation(input.tool_name);

  if (isWrite) {
    const toolInfo = formatToolInfo(input.tool_name, input.tool_input);
    console.log(JSON.stringify({
      decision: 'ask',
      message: `[MCP SECURITY] Write operation detected (${matchedPattern})\n\n${toolInfo}\n\nAllow this MCP write operation?`
    }));
  } else {
    console.log(JSON.stringify({ continue: true }));
  }
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true }));
});
