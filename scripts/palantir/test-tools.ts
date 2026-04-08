#!/usr/bin/env bun
// test-tools.ts — Direct test of Palantir MCP tool logic (bypasses MCP protocol)
// Run: bun run test-tools.ts
// Tests database connectivity, assemble_context, vector search, Fabric patterns, and session gating.

import pg from "pg";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

function getPostgresUrl(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const envFile = "/etc/pai-sync/env";
  if (existsSync(envFile)) {
    const content = readFileSync(envFile, "utf-8");
    const match = content.match(/POSTGRES_URL=(.+)/);
    if (match) return match[1].trim();
  }
  throw new Error("POSTGRES_URL not set and /etc/pai-sync/env not found");
}

const FABRIC_PATTERNS_DIR =
  process.env.FABRIC_PATTERNS_DIR ||
  `${process.env.HOME}/.claude/skills/Fabric/Patterns`;

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function main() {
  const pool = new pg.Pool({ connectionString: getPostgresUrl() });

  // ── Test 1: Database connectivity ──
  console.log("\n--- Test 1: Database connectivity ---");
  try {
    const { rows } = await pool.query("SELECT COUNT(*) as count FROM core.memory_objects WHERE deleted = FALSE");
    const count = parseInt(rows[0].count);
    assert("memory_objects accessible", count > 0, `${count} objects`);
  } catch (err: any) {
    assert("memory_objects accessible", false, err.message);
  }

  // ── Test 2: Palantir schema exists ──
  console.log("\n--- Test 2: Palantir schema ---");
  try {
    await pool.query("SELECT 1 FROM palantir.session_state LIMIT 0");
    assert("palantir.session_state table exists", true);
  } catch (err: any) {
    assert("palantir.session_state table exists", false, err.message);
  }
  try {
    await pool.query("SELECT 1 FROM palantir.tool_calls LIMIT 0");
    assert("palantir.tool_calls table exists", true);
  } catch (err: any) {
    assert("palantir.tool_calls table exists", false, err.message);
  }

  // ── Test 3: assemble_context function ──
  console.log("\n--- Test 3: assemble_context SQL function ---");
  try {
    const { rows } = await pool.query(
      "SELECT core.assemble_context($1, $2) as ctx",
      ["test: building MCP server", "minimal"],
    );
    const ctx = rows[0].ctx;
    assert("assemble_context returns JSONB", typeof ctx === "object");
    assert("context_level is 'minimal'", ctx.context_level === "minimal");
    assert("stats.total_learnings > 0", ctx.stats?.total_learnings > 0, `${ctx.stats?.total_learnings}`);
    assert("stats.total_objects > 0", ctx.stats?.total_objects > 0, `${ctx.stats?.total_objects}`);
    assert("has methodology field", Array.isArray(ctx.methodology) || typeof ctx.methodology === "object");
    assert("has recent_learnings field", ctx.recent_learnings !== undefined);
    assert("has recent_failures field", ctx.recent_failures !== undefined);
  } catch (err: any) {
    assert("assemble_context executes", false, err.message);
  }

  // ── Test 4: search_memory_by_vector function exists ──
  console.log("\n--- Test 4: search_memory_by_vector SQL function ---");
  try {
    const { rows } = await pool.query(`
      SELECT proname FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'core' AND p.proname = 'search_memory_by_vector'
    `);
    assert("search_memory_by_vector function exists", rows.length > 0);
  } catch (err: any) {
    assert("search_memory_by_vector function exists", false, err.message);
  }

  // ── Test 5: Fabric patterns ──
  console.log("\n--- Test 5: Fabric patterns ---");
  assert("Fabric patterns directory exists", existsSync(FABRIC_PATTERNS_DIR));
  if (existsSync(FABRIC_PATTERNS_DIR)) {
    const patterns = readdirSync(FABRIC_PATTERNS_DIR).filter((name) => {
      return statSync(join(FABRIC_PATTERNS_DIR, name)).isDirectory();
    });
    assert("patterns found", patterns.length > 200, `${patterns.length} patterns`);

    // Check a known pattern
    const ewPath = join(FABRIC_PATTERNS_DIR, "extract_wisdom", "system.md");
    assert("extract_wisdom pattern has system.md", existsSync(ewPath));
  }

  // ── Test 6: Session state operations ──
  console.log("\n--- Test 6: Session state operations ---");
  const testSessionId = `test-${Date.now()}`;
  try {
    await pool.query(
      `INSERT INTO palantir.session_state (session_id) VALUES ($1)
       ON CONFLICT (session_id) DO UPDATE SET last_activity_at = NOW()`,
      [testSessionId],
    );
    assert("session insert works", true);

    const { rows } = await pool.query(
      "SELECT context_loaded FROM palantir.session_state WHERE session_id = $1",
      [testSessionId],
    );
    assert("session defaults to context_loaded=false", rows[0].context_loaded === false);

    await pool.query(
      `UPDATE palantir.session_state SET context_loaded = TRUE, context_loaded_at = NOW()
       WHERE session_id = $1`,
      [testSessionId],
    );
    const { rows: rows2 } = await pool.query(
      "SELECT context_loaded FROM palantir.session_state WHERE session_id = $1",
      [testSessionId],
    );
    assert("context_loaded updated to true", rows2[0].context_loaded === true);

    // Cleanup
    await pool.query("DELETE FROM palantir.session_state WHERE session_id = $1", [testSessionId]);
  } catch (err: any) {
    assert("session operations", false, err.message);
  }

  // ── Test 7: Tool call logging ──
  console.log("\n--- Test 7: Tool call logging ---");
  try {
    await pool.query(
      `INSERT INTO palantir.tool_calls (session_id, tool_name, arguments, result_status)
       VALUES ($1, 'test_tool', '{"foo": "bar"}', 'ok')`,
      [testSessionId],
    );
    assert("tool call insert works", true);

    const { rows } = await pool.query(
      "SELECT tool_name, arguments FROM palantir.tool_calls WHERE session_id = $1",
      [testSessionId],
    );
    assert("tool call retrievable", rows.length > 0);
    assert("tool call arguments stored as JSONB", rows[0]?.arguments?.foo === "bar");

    // Cleanup
    await pool.query("DELETE FROM palantir.tool_calls WHERE session_id = $1", [testSessionId]);
  } catch (err: any) {
    assert("tool call logging", false, err.message);
  }

  // ── Test 8: Memory vectors accessible ──
  console.log("\n--- Test 8: Memory vectors ---");
  try {
    const { rows } = await pool.query(
      "SELECT COUNT(*) as count FROM core.memory_vectors",
    );
    const count = parseInt(rows[0].count);
    assert("memory_vectors has embeddings", count > 1000, `${count} vectors`);
  } catch (err: any) {
    assert("memory_vectors accessible", false, err.message);
  }

  // ── Summary ──
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test suite error:", err);
  process.exit(1);
});
