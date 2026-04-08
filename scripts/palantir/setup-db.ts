#!/usr/bin/env bun
// setup-db.ts — Install SQL functions and tables for Palantir MCP Gateway
//
// This script requires superuser access to create schemas and functions.
// Preferred method: docker exec -i imladris-windmill_db-1 psql -U postgres -d pai < setup.sql
//
// This TypeScript version exists as an alternative if you have a superuser connection string:
//   POSTGRES_URL=postgresql://postgres:PASSWORD@127.0.0.1:5432/pai bun run setup-db.ts
//
// The pai_sync user (used by the server at runtime) has SELECT/INSERT/UPDATE but not DDL.

import pg from "pg";
import { readFileSync, existsSync } from "fs";

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

const POSTGRES_URL = getPostgresUrl();

async function main() {
  const pool = new pg.Pool({ connectionString: POSTGRES_URL });

  console.log("[setup-db] Connected to database");

  // -- 1. Create palantir schema and session tracking table --
  console.log("[setup-db] Creating palantir schema and tables...");
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS palantir;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS palantir.tool_calls (
      id            BIGSERIAL PRIMARY KEY,
      session_id    TEXT NOT NULL,
      tool_name     TEXT NOT NULL,
      arguments     JSONB DEFAULT '{}'::jsonb,
      result_status TEXT DEFAULT 'ok',
      error_message TEXT,
      called_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tool_calls_session
      ON palantir.tool_calls (session_id, called_at);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_tool
      ON palantir.tool_calls (tool_name, called_at);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS palantir.session_state (
      session_id        TEXT PRIMARY KEY,
      context_loaded    BOOLEAN NOT NULL DEFAULT FALSE,
      context_loaded_at TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // -- 2. Create assemble_context function --
  console.log("[setup-db] Creating assemble_context function...");
  await pool.query(`
    CREATE OR REPLACE FUNCTION core.assemble_context(
      p_task_description TEXT,
      p_context_level TEXT DEFAULT 'standard'
    )
    RETURNS JSONB
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_result JSONB;
      v_methodology JSONB;
      v_learnings JSONB;
      v_failures JSONB;
      v_limit INT;
      v_similarity_threshold FLOAT;
    BEGIN
      -- Set limits based on context level
      CASE p_context_level
        WHEN 'minimal' THEN
          v_limit := 3;
          v_similarity_threshold := 0.7;
        WHEN 'standard' THEN
          v_limit := 10;
          v_similarity_threshold := 0.5;
        WHEN 'deep' THEN
          v_limit := 25;
          v_similarity_threshold := 0.3;
        ELSE
          v_limit := 10;
          v_similarity_threshold := 0.5;
      END CASE;

      -- Fetch methodology/principles from pai_system
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'key', ps.key,
        'component_type', ps.component_type,
        'content', LEFT(ps.content, 2000)
      )), '[]'::jsonb)
      INTO v_methodology
      FROM core.pai_system ps
      WHERE ps.component_type IN ('algorithm', 'principle', 'methodology', 'system');

      -- If pai_system is empty, pull from memory_objects with system-like keys
      IF v_methodology = '[]'::jsonb THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'key', mo.key,
          'content', LEFT(mo.content, 2000)
        )), '[]'::jsonb)
        INTO v_methodology
        FROM core.memory_objects mo
        WHERE mo.deleted = FALSE
          AND (mo.key LIKE 'PAISYSTEMUPDATES/%' OR mo.key LIKE 'PAI/%')
        LIMIT 5;
      END IF;

      -- Semantic search for relevant learnings (requires pre-computed query embedding)
      -- This returns content from memory_objects joined to vectors
      -- The caller must pass an embedding or we fall back to text matching
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'key', mo.key,
        'content', LEFT(mo.content, 1500),
        'source_type', mv.source_type,
        'metadata', mo.metadata
      ) ORDER BY mo.updated_at DESC), '[]'::jsonb)
      INTO v_learnings
      FROM core.memory_vectors mv
      JOIN core.memory_objects mo ON mo.key = mv.source_key
      WHERE mv.source_type = 'learning'
        AND mo.deleted = FALSE
        AND mo.content IS NOT NULL
      ORDER BY mo.updated_at DESC
      LIMIT v_limit;

      -- Text-match failures related to the task
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'key', mo.key,
        'content', LEFT(mo.content, 1500),
        'metadata', mo.metadata
      ) ORDER BY mo.updated_at DESC), '[]'::jsonb)
      INTO v_failures
      FROM core.memory_objects mo
      WHERE mo.deleted = FALSE
        AND mo.key LIKE 'LEARNING/FAILURES/%'
        AND mo.metadata->'frontmatter'->>'capture_type' = 'FAILURE_ANALYSIS'
      ORDER BY mo.updated_at DESC
      LIMIT v_limit;

      -- Assemble the response
      v_result := jsonb_build_object(
        'task_description', p_task_description,
        'context_level', p_context_level,
        'methodology', v_methodology,
        'relevant_learnings', v_learnings,
        'similar_failures', v_failures,
        'stats', jsonb_build_object(
          'total_learnings', (SELECT COUNT(*) FROM core.memory_vectors WHERE source_type = 'learning'),
          'total_failures', (SELECT COUNT(*) FROM core.memory_objects WHERE key LIKE 'LEARNING/FAILURES/%' AND deleted = FALSE),
          'total_prds', (SELECT COUNT(*) FROM core.memory_vectors WHERE source_type = 'prd'),
          'total_objects', (SELECT COUNT(*) FROM core.memory_objects WHERE deleted = FALSE)
        ),
        'assembled_at', NOW()
      );

      RETURN v_result;
    END;
    $$;
  `);

  // -- 3. Create vector search function --
  console.log("[setup-db] Creating search_memory_by_vector function...");
  await pool.query(`
    CREATE OR REPLACE FUNCTION core.search_memory_by_vector(
      p_query_embedding vector(1024),
      p_type_filter TEXT DEFAULT NULL,
      p_limit INT DEFAULT 10,
      p_similarity_threshold FLOAT DEFAULT 0.3
    )
    RETURNS TABLE(
      source_key TEXT,
      source_type TEXT,
      chunk_text TEXT,
      content TEXT,
      metadata JSONB,
      similarity FLOAT
    )
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RETURN QUERY
      SELECT
        mv.source_key,
        mv.source_type,
        mv.chunk_text,
        LEFT(mo.content, 2000) AS content,
        mo.metadata,
        (1 - (mv.embedding <=> p_query_embedding))::FLOAT AS similarity
      FROM core.memory_vectors mv
      JOIN core.memory_objects mo ON mo.key = mv.source_key
      WHERE mo.deleted = FALSE
        AND (p_type_filter IS NULL OR mv.source_type = p_type_filter)
        AND (1 - (mv.embedding <=> p_query_embedding)) >= p_similarity_threshold
      ORDER BY mv.embedding <=> p_query_embedding
      LIMIT p_limit;
    END;
    $$;
  `);

  // -- 4. Create suggest patterns function --
  console.log("[setup-db] Creating suggest_fabric_patterns function...");
  await pool.query(`
    CREATE OR REPLACE FUNCTION core.suggest_fabric_patterns(
      p_query_embedding vector(1024),
      p_limit INT DEFAULT 5
    )
    RETURNS TABLE(
      source_key TEXT,
      chunk_text TEXT,
      similarity FLOAT
    )
    LANGUAGE plpgsql
    AS $$
    BEGIN
      -- Search for pattern-related content in memory vectors
      RETURN QUERY
      SELECT
        mv.source_key,
        mv.chunk_text,
        (1 - (mv.embedding <=> p_query_embedding))::FLOAT AS similarity
      FROM core.memory_vectors mv
      WHERE mv.source_type IN ('system', 'learning', 'prd')
      ORDER BY mv.embedding <=> p_query_embedding
      LIMIT p_limit;
    END;
    $$;
  `);

  // -- 5. Grant permissions to pai_sync --
  console.log("[setup-db] Granting permissions...");
  await pool.query(`
    GRANT USAGE ON SCHEMA palantir TO pai_sync;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA palantir TO pai_sync;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA palantir TO pai_sync;
    GRANT EXECUTE ON FUNCTION core.assemble_context(TEXT, TEXT) TO pai_sync;
    GRANT EXECUTE ON FUNCTION core.search_memory_by_vector(vector, TEXT, INT, FLOAT) TO pai_sync;
    GRANT EXECUTE ON FUNCTION core.suggest_fabric_patterns(vector, INT) TO pai_sync;
  `);

  console.log("[setup-db] Setup complete.");
  console.log("[setup-db]   - palantir.tool_calls table created");
  console.log("[setup-db]   - palantir.session_state table created");
  console.log("[setup-db]   - core.assemble_context() function created");
  console.log("[setup-db]   - core.search_memory_by_vector() function created");
  console.log("[setup-db]   - core.suggest_fabric_patterns() function created");
  console.log("[setup-db]   - Permissions granted to pai_sync");

  await pool.end();
}

main().catch((err) => {
  console.error("[setup-db] FATAL:", err);
  process.exit(1);
});
