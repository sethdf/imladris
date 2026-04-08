-- setup.sql — Palantir MCP Gateway database setup
-- Run via: docker exec imladris-windmill_db-1 psql -U postgres -d pai -f /dev/stdin < setup.sql

-- 1. Create palantir schema
CREATE SCHEMA IF NOT EXISTS palantir;

-- 2. Tool call log
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

-- 3. Session state tracking (context gate enforcement)
CREATE TABLE IF NOT EXISTS palantir.session_state (
  session_id        TEXT PRIMARY KEY,
  context_loaded    BOOLEAN NOT NULL DEFAULT FALSE,
  context_loaded_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. assemble_context function — returns methodology + learnings + failures
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
BEGIN
  -- Set limits based on context level
  CASE p_context_level
    WHEN 'minimal' THEN v_limit := 3;
    WHEN 'standard' THEN v_limit := 10;
    WHEN 'deep' THEN v_limit := 25;
    ELSE v_limit := 10;
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
      'key', sub.key,
      'content', LEFT(sub.content, 2000)
    )), '[]'::jsonb)
    INTO v_methodology
    FROM (
      SELECT mo.key, mo.content
      FROM core.memory_objects mo
      WHERE mo.deleted = FALSE
        AND (mo.key LIKE 'PAISYSTEMUPDATES/%')
      ORDER BY mo.updated_at DESC
      LIMIT 5
    ) sub;
  END IF;

  -- Recent learnings (non-semantic fallback)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'key', sub.source_key,
    'source_type', sub.source_type,
    'chunk_text', LEFT(sub.chunk_text, 1500)
  )), '[]'::jsonb)
  INTO v_learnings
  FROM (
    SELECT mv.source_key, mv.source_type, mv.chunk_text
    FROM core.memory_vectors mv
    JOIN core.memory_objects mo ON mo.key = mv.source_key
    WHERE mv.source_type = 'learning'
      AND mo.deleted = FALSE
    ORDER BY mo.updated_at DESC
    LIMIT v_limit
  ) sub;

  -- Recent failure analyses
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'key', sub.key,
    'content', LEFT(sub.content, 1500),
    'metadata', sub.metadata
  )), '[]'::jsonb)
  INTO v_failures
  FROM (
    SELECT mo.key, mo.content, mo.metadata
    FROM core.memory_objects mo
    WHERE mo.deleted = FALSE
      AND mo.key LIKE 'LEARNING/FAILURES/%'
      AND mo.metadata->'frontmatter'->>'capture_type' = 'FAILURE_ANALYSIS'
    ORDER BY mo.updated_at DESC
    LIMIT v_limit
  ) sub;

  -- Assemble the response
  v_result := jsonb_build_object(
    'task_description', p_task_description,
    'context_level', p_context_level,
    'methodology', v_methodology,
    'recent_learnings', v_learnings,
    'recent_failures', v_failures,
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

-- 5. Vector search function
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

-- 6. Grant permissions to pai_sync role
GRANT USAGE ON SCHEMA palantir TO pai_sync;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA palantir TO pai_sync;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA palantir TO pai_sync;
GRANT EXECUTE ON FUNCTION core.assemble_context(TEXT, TEXT) TO pai_sync;
GRANT EXECUTE ON FUNCTION core.search_memory_by_vector(vector, TEXT, INT, FLOAT) TO pai_sync;
