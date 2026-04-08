#!/usr/bin/env bun
// server.ts — Palantir MCP Gateway
// Serves PAI knowledge (learnings, failures, Fabric patterns, context assembly)
// to Claude Code agents via Model Context Protocol.
//
// Run: bun run server.ts
// Config: POSTGRES_URL, PORT (default 3200), FABRIC_PATTERNS_DIR

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";

// ── Config ──

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
const PORT = parseInt(process.env.PORT || "3200");
const FABRIC_PATTERNS_DIR =
  process.env.FABRIC_PATTERNS_DIR ||
  `${process.env.HOME}/.claude/skills/Fabric/Patterns`;

const BEDROCK_MODEL = "amazon.titan-embed-text-v2:0";
const EMBEDDING_DIMENSIONS = 1024;
const MAX_TEXT_LENGTH = 8000;

// ── Database Pool ──

const pool = new pg.Pool({
  connectionString: POSTGRES_URL,
  max: 5,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  console.error("[palantir] Pool error:", err.message);
});

// ── Embedding via Bedrock ──

async function generateEmbedding(text: string): Promise<number[]> {
  const truncated = text.slice(0, MAX_TEXT_LENGTH);
  const body = JSON.stringify({
    inputText: truncated,
    dimensions: EMBEDDING_DIMENSIONS,
  });

  const tmpFile = `/tmp/palantir-embed-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;

  const proc = Bun.spawn(
    [
      "aws", "bedrock-runtime", "invoke-model",
      "--model-id", BEDROCK_MODEL,
      "--body", Buffer.from(body).toString("base64"),
      "--content-type", "application/json",
      "--accept", "application/json",
      "--region", "us-east-1",
      tmpFile,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    try { unlinkSync(tmpFile); } catch {}
    throw new Error(`Bedrock embedding failed (exit ${exitCode}): ${stderr}`);
  }

  try {
    const result = JSON.parse(readFileSync(tmpFile, "utf8"));
    return result.embedding;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

// ── Session State Tracking ──

const sessionContextLoaded = new Map<string, boolean>();

async function ensureSession(sessionId: string): Promise<void> {
  await pool.query(
    `INSERT INTO palantir.session_state (session_id)
     VALUES ($1)
     ON CONFLICT (session_id) DO UPDATE SET last_activity_at = NOW()`,
    [sessionId],
  );
}

async function markContextLoaded(sessionId: string): Promise<void> {
  sessionContextLoaded.set(sessionId, true);
  await pool.query(
    `UPDATE palantir.session_state
     SET context_loaded = TRUE, context_loaded_at = NOW(), last_activity_at = NOW()
     WHERE session_id = $1`,
    [sessionId],
  );
}

function hasLoadedContext(sessionId: string): boolean {
  return sessionContextLoaded.get(sessionId) === true;
}

async function logToolCall(
  sessionId: string,
  toolName: string,
  args: any,
  status: string = "ok",
  errorMsg?: string,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO palantir.tool_calls (session_id, tool_name, arguments, result_status, error_message)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, toolName, JSON.stringify(args), status, errorMsg || null],
    );
  } catch (err: any) {
    console.error("[palantir] Failed to log tool call:", err.message);
  }
}

function requireContext(sessionId: string, toolName: string): string | null {
  if (!hasLoadedContext(sessionId)) {
    return JSON.stringify({
      error: "context_not_loaded",
      message: `Session ${sessionId} must call get_context before using ${toolName}. ` +
        "This ensures the model has loaded PAI methodology and relevant knowledge before writing back.",
    });
  }
  return null;
}

// ── Fabric Pattern Helpers ──

function listFabricPatterns(): string[] {
  if (!existsSync(FABRIC_PATTERNS_DIR)) return [];
  return readdirSync(FABRIC_PATTERNS_DIR).filter((name) => {
    const fullPath = join(FABRIC_PATTERNS_DIR, name);
    return statSync(fullPath).isDirectory();
  });
}

function getFabricPattern(patternName: string): { system: string; readme?: string } | null {
  const patternDir = join(FABRIC_PATTERNS_DIR, patternName);
  if (!existsSync(patternDir)) return null;

  const systemPath = join(patternDir, "system.md");
  const readmePath = join(patternDir, "README.md");

  if (!existsSync(systemPath)) return null;

  const result: { system: string; readme?: string } = {
    system: readFileSync(systemPath, "utf-8"),
  };

  if (existsSync(readmePath)) {
    result.readme = readFileSync(readmePath, "utf-8");
  }

  return result;
}

// ── MCP Server ──

const server = new McpServer(
  {
    name: "palantir",
    version: "1.0.0",
    instructions:
      "Palantir is the PAI knowledge gateway. IMPORTANT: Call get_context FIRST at the start of " +
      "every session to load PAI methodology, relevant learnings, and similar past failures. " +
      "record_learning and record_failure will be rejected if get_context has not been called. " +
      "This ensures all write-backs are informed by existing knowledge.",
  },
);

// ── Tool 1: get_context ──

server.tool(
  "get_context",
  "Load PAI methodology, relevant learnings, and similar past failures for a task. " +
    "MUST be called first in every session before any write-back tools. " +
    "Returns methodology/principles, semantically similar learnings, and related failure analyses.",
  {
    task_description: z.string().describe("Description of the current task or request"),
    context_level: z
      .enum(["minimal", "standard", "deep"])
      .default("standard")
      .describe("minimal=3 results, standard=10, deep=25"),
    session_id: z
      .string()
      .optional()
      .describe("Session ID for state tracking (auto-generated if not provided)"),
  },
  async ({ task_description, context_level, session_id }) => {
    const sid = session_id || `palantir-${Date.now()}`;

    try {
      await ensureSession(sid);

      // Generate embedding for the task description
      let queryEmbedding: number[] | null = null;
      try {
        queryEmbedding = await generateEmbedding(task_description);
      } catch (err: any) {
        console.error("[palantir] Embedding generation failed, falling back to SQL-only:", err.message);
      }

      // Call assemble_context for base context
      const { rows: ctxRows } = await pool.query(
        "SELECT core.assemble_context($1, $2) AS context",
        [task_description, context_level],
      );
      const baseContext = ctxRows[0]?.context || {};

      // If we have an embedding, do vector search for relevant learnings
      let semanticLearnings: any[] = [];
      let semanticFailures: any[] = [];
      if (queryEmbedding) {
        const pgVector = `[${queryEmbedding.join(",")}]`;
        const limit = context_level === "minimal" ? 3 : context_level === "deep" ? 25 : 10;
        const threshold = context_level === "minimal" ? 0.7 : context_level === "deep" ? 0.3 : 0.5;

        const { rows: learningRows } = await pool.query(
          `SELECT source_key, source_type, chunk_text, content, metadata, similarity
           FROM core.search_memory_by_vector($1::vector, 'learning', $2, $3)`,
          [pgVector, limit, threshold],
        );
        semanticLearnings = learningRows;

        // Search failures specifically
        const { rows: failureRows } = await pool.query(
          `SELECT
             mv.source_key,
             mv.source_type,
             mv.chunk_text,
             LEFT(mo.content, 1500) AS content,
             mo.metadata,
             (1 - (mv.embedding <=> $1::vector))::FLOAT AS similarity
           FROM core.memory_vectors mv
           JOIN core.memory_objects mo ON mo.key = mv.source_key
           WHERE mo.deleted = FALSE
             AND mo.key LIKE 'LEARNING/FAILURES/%'
             AND (1 - (mv.embedding <=> $1::vector)) >= $3
           ORDER BY mv.embedding <=> $1::vector
           LIMIT $2`,
          [pgVector, Math.min(limit, 5), threshold],
        );
        semanticFailures = failureRows;
      }

      // Merge semantic results into base context
      const result = {
        ...baseContext,
        session_id: sid,
        semantic_learnings:
          semanticLearnings.length > 0
            ? semanticLearnings.map((r) => ({
                key: r.source_key,
                type: r.source_type,
                similarity: Math.round(r.similarity * 1000) / 1000,
                content: r.content || r.chunk_text,
                metadata: r.metadata,
              }))
            : undefined,
        semantic_failures:
          semanticFailures.length > 0
            ? semanticFailures.map((r) => ({
                key: r.source_key,
                similarity: Math.round(r.similarity * 1000) / 1000,
                content: r.content || r.chunk_text,
                metadata: r.metadata,
              }))
            : undefined,
        embedding_available: queryEmbedding !== null,
      };

      await markContextLoaded(sid);
      await logToolCall(sid, "get_context", { task_description, context_level });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      await logToolCall(sid, "get_context", { task_description, context_level }, "error", err.message);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }],
      };
    }
  },
);

// ── Tool 2: search_memory ──

server.tool(
  "search_memory",
  "Semantic search across PAI knowledge base using pgvector cosine similarity. " +
    "Searches learnings, failures, PRDs, research, and system content.",
  {
    query: z.string().describe("Natural language search query"),
    type_filter: z
      .enum(["learning", "prd", "research", "system", "relationship", "wisdom", "security", "archive"])
      .optional()
      .describe("Filter to specific content type"),
    limit: z.number().default(10).describe("Max results (1-50)"),
    session_id: z.string().optional().describe("Session ID for tracking"),
  },
  async ({ query, type_filter, limit, session_id }) => {
    const sid = session_id || "anonymous";
    const safeLimit = Math.min(Math.max(limit, 1), 50);

    try {
      await ensureSession(sid);

      // Generate embedding for the query
      const embedding = await generateEmbedding(query);
      const pgVector = `[${embedding.join(",")}]`;

      const { rows } = await pool.query(
        `SELECT source_key, source_type, chunk_text, content, metadata, similarity
         FROM core.search_memory_by_vector($1::vector, $2, $3, 0.2)`,
        [pgVector, type_filter || null, safeLimit],
      );

      const result = {
        query,
        type_filter: type_filter || "all",
        count: rows.length,
        results: rows.map((r) => ({
          key: r.source_key,
          type: r.source_type,
          similarity: Math.round(r.similarity * 1000) / 1000,
          content: r.content || r.chunk_text,
          metadata: r.metadata,
        })),
      };

      await logToolCall(sid, "search_memory", { query, type_filter, limit: safeLimit });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      await logToolCall(sid, "search_memory", { query, type_filter, limit: safeLimit }, "error", err.message);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }],
      };
    }
  },
);

// ── Tool 3: record_learning ──

server.tool(
  "record_learning",
  "Write a new learning back to PAI knowledge base with full provenance. " +
    "Requires get_context to have been called first in this session.",
  {
    content: z.string().describe("The learning content (markdown)"),
    domain: z
      .string()
      .describe("Domain/category: e.g. 'aws', 'windmill', 'security', 'devops', 'pai-system'"),
    source_model: z.string().describe("Model that generated this learning, e.g. 'claude-opus-4-6'"),
    source_context: z
      .string()
      .describe("Brief description of the conversation/task that produced this learning"),
    confidence: z
      .enum(["low", "medium", "high"])
      .default("medium")
      .describe("Confidence level in this learning"),
    conversation_id: z.string().optional().describe("Conversation/session ID for traceability"),
    session_id: z.string().describe("Palantir session ID (must have called get_context)"),
  },
  async ({ content, domain, source_model, source_context, confidence, conversation_id, session_id }) => {
    // Enforce context gate
    const rejection = requireContext(session_id, "record_learning");
    if (rejection) {
      await logToolCall(session_id, "record_learning", { domain, source_model }, "rejected", "context_not_loaded");
      return { content: [{ type: "text" as const, text: rejection }] };
    }

    try {
      await ensureSession(session_id);

      const now = new Date();
      const dateStr = now.toISOString().replace(/T/, "-").replace(/[:.]/g, "").slice(0, 19);
      const slug = domain.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const key = `LEARNING/PALANTIR/${now.toISOString().slice(0, 7).replace("-", "-")}/${dateStr}_${slug}.md`;

      const frontmatter = [
        "---",
        "capture_type: LEARNING",
        `timestamp: ${now.toISOString()}`,
        `domain: ${domain}`,
        `source_model: ${source_model}`,
        `source_context: ${source_context}`,
        `confidence: ${confidence}`,
        `conversation_id: ${conversation_id || session_id}`,
        "source: palantir-mcp",
        "---",
        "",
      ].join("\n");

      const fullContent = frontmatter + content;
      const contentHash = Bun.hash(fullContent).toString(16);

      const metadata = {
        ext: "md",
        is_jsonl: false,
        size_bytes: Buffer.byteLength(fullContent),
        frontmatter: {
          capture_type: "LEARNING",
          domain,
          source_model,
          source_context,
          confidence,
          conversation_id: conversation_id || session_id,
          source: "palantir-mcp",
        },
      };

      // Insert into memory_objects
      await pool.query(
        `INSERT INTO core.memory_objects (key, content, metadata, content_hash, source, session_id)
         VALUES ($1, $2, $3, $4, 'palantir', $5)
         ON CONFLICT (key) DO UPDATE SET
           content = EXCLUDED.content,
           metadata = EXCLUDED.metadata,
           content_hash = EXCLUDED.content_hash,
           updated_at = NOW()`,
        [key, fullContent, JSON.stringify(metadata), contentHash, session_id],
      );

      // Generate and store embedding
      try {
        const embedding = await generateEmbedding(fullContent);
        const pgVector = `[${embedding.join(",")}]`;

        await pool.query(
          `INSERT INTO core.memory_vectors (source_key, source_type, embedding, chunk_text, model)
           VALUES ($1, 'learning', $2::vector, $3, $4)
           ON CONFLICT (source_key) DO UPDATE SET
             embedding = EXCLUDED.embedding,
             chunk_text = EXCLUDED.chunk_text,
             created_at = NOW()`,
          [key, pgVector, fullContent.slice(0, 2000), BEDROCK_MODEL],
        );
      } catch (embedErr: any) {
        console.error("[palantir] Embedding failed for learning, stored without vector:", embedErr.message);
      }

      await logToolCall(session_id, "record_learning", { domain, source_model, confidence, key });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "recorded",
              key,
              domain,
              confidence,
              source_model,
              message: "Learning stored in PAI knowledge base with provenance.",
            }),
          },
        ],
      };
    } catch (err: any) {
      await logToolCall(session_id, "record_learning", { domain, source_model }, "error", err.message);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }],
      };
    }
  },
);

// ── Tool 4: record_failure ──

server.tool(
  "record_failure",
  "Record a failure analysis for future prevention. " +
    "Requires get_context to have been called first in this session.",
  {
    summary: z.string().describe("One-line summary of what failed"),
    context: z.string().describe("What was being attempted when the failure occurred"),
    root_cause: z.string().describe("Root cause analysis of why it failed"),
    source_model: z.string().describe("Model that identified this failure, e.g. 'claude-opus-4-6'"),
    session_id: z.string().describe("Palantir session ID (must have called get_context)"),
  },
  async ({ summary, context, root_cause, source_model, session_id }) => {
    // Enforce context gate
    const rejection = requireContext(session_id, "record_failure");
    if (rejection) {
      await logToolCall(session_id, "record_failure", { summary, source_model }, "rejected", "context_not_loaded");
      return { content: [{ type: "text" as const, text: rejection }] };
    }

    try {
      await ensureSession(session_id);

      const now = new Date();
      const dateStr = now.toISOString().replace(/T/, "-").replace(/[:.]/g, "").slice(0, 19);
      const slugSummary = summary
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 60);
      const key = `LEARNING/FAILURES/${now.toISOString().slice(0, 7).replace("-", "-")}/${dateStr}_${slugSummary}/CONTEXT.md`;

      const fullContent = [
        "---",
        "capture_type: FAILURE_ANALYSIS",
        `timestamp: ${now.toISOString()}`,
        `summary: ${summary}`,
        `source_model: ${source_model}`,
        `session_id: ${session_id}`,
        "source: palantir-mcp",
        "---",
        "",
        "## Context",
        "",
        context,
        "",
        "## Root Cause",
        "",
        root_cause,
      ].join("\n");

      const contentHash = Bun.hash(fullContent).toString(16);

      const metadata = {
        ext: "md",
        is_jsonl: false,
        size_bytes: Buffer.byteLength(fullContent),
        frontmatter: {
          capture_type: "FAILURE_ANALYSIS",
          summary,
          source_model,
          session_id,
          source: "palantir-mcp",
        },
      };

      await pool.query(
        `INSERT INTO core.memory_objects (key, content, metadata, content_hash, source, session_id)
         VALUES ($1, $2, $3, $4, 'palantir', $5)
         ON CONFLICT (key) DO UPDATE SET
           content = EXCLUDED.content,
           metadata = EXCLUDED.metadata,
           content_hash = EXCLUDED.content_hash,
           updated_at = NOW()`,
        [key, fullContent, JSON.stringify(metadata), contentHash, session_id],
      );

      // Generate and store embedding
      try {
        const embedding = await generateEmbedding(fullContent);
        const pgVector = `[${embedding.join(",")}]`;

        await pool.query(
          `INSERT INTO core.memory_vectors (source_key, source_type, embedding, chunk_text, model)
           VALUES ($1, 'learning', $2::vector, $3, $4)
           ON CONFLICT (source_key) DO UPDATE SET
             embedding = EXCLUDED.embedding,
             chunk_text = EXCLUDED.chunk_text,
             created_at = NOW()`,
          [key, pgVector, fullContent.slice(0, 2000), BEDROCK_MODEL],
        );
      } catch (embedErr: any) {
        console.error("[palantir] Embedding failed for failure, stored without vector:", embedErr.message);
      }

      await logToolCall(session_id, "record_failure", { summary, source_model, key });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "recorded",
              key,
              summary,
              source_model,
              message: "Failure analysis stored in PAI knowledge base.",
            }),
          },
        ],
      };
    } catch (err: any) {
      await logToolCall(session_id, "record_failure", { summary, source_model }, "error", err.message);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }],
      };
    }
  },
);

// ── Tool 5: get_fabric_pattern ──

server.tool(
  "get_fabric_pattern",
  "Retrieve a Fabric pattern's system prompt and README. " +
    "Use suggest_fabric_patterns to find relevant patterns first.",
  {
    pattern_name: z
      .string()
      .describe("Pattern name (e.g. 'extract_wisdom', 'analyze_incident', 'create_threat_model')"),
    session_id: z.string().optional().describe("Session ID for tracking"),
  },
  async ({ pattern_name, session_id }) => {
    const sid = session_id || "anonymous";

    try {
      await ensureSession(sid);

      const pattern = getFabricPattern(pattern_name);
      if (!pattern) {
        const available = listFabricPatterns();
        const fuzzy = available.filter((p) =>
          p.includes(pattern_name) || pattern_name.includes(p),
        );

        await logToolCall(sid, "get_fabric_pattern", { pattern_name }, "not_found");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "pattern_not_found",
                pattern_name,
                suggestions: fuzzy.length > 0 ? fuzzy : available.slice(0, 20),
                total_patterns: available.length,
              }),
            },
          ],
        };
      }

      await logToolCall(sid, "get_fabric_pattern", { pattern_name });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              pattern_name,
              system_prompt: pattern.system,
              readme: pattern.readme || null,
              source: FABRIC_PATTERNS_DIR,
            }),
          },
        ],
      };
    } catch (err: any) {
      await logToolCall(sid, "get_fabric_pattern", { pattern_name }, "error", err.message);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }],
      };
    }
  },
);

// ── Tool 6: suggest_fabric_patterns ──

server.tool(
  "suggest_fabric_patterns",
  "Suggest relevant Fabric patterns for a task using keyword matching against pattern names " +
    "and descriptions. Returns pattern names and brief descriptions.",
  {
    task_description: z.string().describe("Description of what you need a pattern for"),
    limit: z.number().default(5).describe("Max suggestions (1-20)"),
    session_id: z.string().optional().describe("Session ID for tracking"),
  },
  async ({ task_description, limit, session_id }) => {
    const sid = session_id || "anonymous";
    const safeLimit = Math.min(Math.max(limit, 1), 20);

    try {
      await ensureSession(sid);

      const allPatterns = listFabricPatterns();
      const taskLower = task_description.toLowerCase();
      const taskWords = taskLower.split(/\s+/).filter((w) => w.length > 2);

      // Score patterns by keyword overlap with task description
      const scored = allPatterns.map((name) => {
        const nameParts = name.split("_");
        let score = 0;

        // Direct substring match in task
        if (taskLower.includes(name.replace(/_/g, " "))) score += 10;

        // Word overlap
        for (const word of taskWords) {
          for (const part of nameParts) {
            if (part.includes(word) || word.includes(part)) score += 2;
          }
        }

        // Check README for additional keyword matches
        const readmePath = join(FABRIC_PATTERNS_DIR, name, "README.md");
        if (existsSync(readmePath)) {
          try {
            const readme = readFileSync(readmePath, "utf-8").toLowerCase();
            for (const word of taskWords) {
              if (readme.includes(word)) score += 1;
            }
          } catch {}
        }

        return { name, score };
      });

      // Also try vector search if we have embeddings
      let vectorSuggestions: Array<{ name: string; similarity: number }> = [];
      try {
        const embedding = await generateEmbedding(task_description);
        const pgVector = `[${embedding.join(",")}]`;
        const { rows } = await pool.query(
          `SELECT source_key, (1 - (mv.embedding <=> $1::vector))::FLOAT AS similarity
           FROM core.memory_vectors mv
           WHERE mv.source_type IN ('system', 'learning')
           ORDER BY mv.embedding <=> $1::vector
           LIMIT 10`,
          [pgVector],
        );
        // Extract pattern-like names from high-similarity results
        for (const row of rows) {
          const key = row.source_key.toLowerCase();
          for (const pattern of allPatterns) {
            if (key.includes(pattern.replace(/_/g, "-")) || key.includes(pattern)) {
              vectorSuggestions.push({ name: pattern, similarity: row.similarity });
            }
          }
        }
      } catch (err: any) {
        // Vector search is best-effort
        console.error("[palantir] Vector search for patterns failed:", err.message);
      }

      // Combine keyword and vector scores
      const combined = new Map<string, { score: number; similarity?: number }>();
      for (const s of scored) {
        if (s.score > 0) combined.set(s.name, { score: s.score });
      }
      for (const vs of vectorSuggestions) {
        const existing = combined.get(vs.name);
        if (existing) {
          existing.score += 5;
          existing.similarity = vs.similarity;
        } else {
          combined.set(vs.name, { score: 5, similarity: vs.similarity });
        }
      }

      // Sort by score descending
      const suggestions = Array.from(combined.entries())
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, safeLimit)
        .map(([name, info]) => {
          const readmePath = join(FABRIC_PATTERNS_DIR, name, "README.md");
          let description = "";
          if (existsSync(readmePath)) {
            try {
              const readme = readFileSync(readmePath, "utf-8");
              // Extract first meaningful line as description
              const lines = readme.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
              description = lines[0]?.trim().slice(0, 200) || "";
            } catch {}
          }
          return {
            pattern_name: name,
            relevance_score: info.score,
            similarity: info.similarity ? Math.round(info.similarity * 1000) / 1000 : undefined,
            description: description || undefined,
          };
        });

      await logToolCall(sid, "suggest_fabric_patterns", { task_description, limit: safeLimit });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              task_description,
              suggestions,
              total_patterns_available: allPatterns.length,
            }, null, 2),
          },
        ],
      };
    } catch (err: any) {
      await logToolCall(sid, "suggest_fabric_patterns", { task_description }, "error", err.message);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }],
      };
    }
  },
);

// ── Start ──

async function main() {
  // Verify database connection
  try {
    const { rows } = await pool.query("SELECT COUNT(*) as count FROM core.memory_objects WHERE deleted = FALSE");
    const count = rows[0]?.count || 0;
    console.error(`[palantir] Connected to PAI database (${count} memory objects)`);
  } catch (err: any) {
    console.error(`[palantir] WARNING: Database connection issue: ${err.message}`);
  }

  // Verify Fabric patterns
  const patterns = listFabricPatterns();
  console.error(`[palantir] Fabric patterns loaded: ${patterns.length} patterns from ${FABRIC_PATTERNS_DIR}`);

  // Start MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[palantir] MCP server started on stdio transport");
}

main().catch((err) => {
  console.error("[palantir] FATAL:", err);
  process.exit(1);
});
