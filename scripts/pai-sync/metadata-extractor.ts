// ============================================================
// metadata-extractor.ts — deterministic metadata extraction
// Pure parsing only — no inference, no AI calls.
// Extracts structured metadata from file content for queryability.
// ============================================================

import { parse as parseYaml } from "yaml";

/** Extracted metadata — stored in Postgres JSONB column */
export interface FileMetadata {
  ext: string;
  size_bytes: number;
  is_jsonl: boolean;
  // YAML frontmatter fields (if present)
  frontmatter?: Record<string, unknown>;
  // For JSONL files: first line parsed fields (sample)
  first_line?: Record<string, unknown>;
}

/**
 * Extract metadata from a file's content and path.
 * Called before push — pure function, no I/O.
 */
export function extractMetadata(
  key: string,
  content: string
): FileMetadata {
  const ext = key.includes(".") ? key.split(".").pop()! : "";
  const size_bytes = new TextEncoder().encode(content).length;
  const is_jsonl = key.endsWith(".jsonl");

  const base: FileMetadata = { ext, size_bytes, is_jsonl };

  if (is_jsonl) {
    // Sample first non-empty line for queryability
    const firstLine = content.split("\n").find((l) => l.trim());
    if (firstLine) {
      try {
        base.first_line = JSON.parse(firstLine);
      } catch {
        // malformed JSONL line — skip
      }
    }
    return base;
  }

  // Try YAML frontmatter for markdown files
  if (ext === "md" || ext === "markdown") {
    const fm = extractYamlFrontmatter(content);
    if (fm) base.frontmatter = fm;
  }

  // Try JSON parse for .json files
  if (ext === "json") {
    try {
      base.frontmatter = JSON.parse(content);
    } catch {
      // not valid JSON — skip
    }
  }

  return base;
}

/**
 * Parse YAML frontmatter block from markdown content.
 * Returns null if no frontmatter is present.
 *
 * Frontmatter format:
 * ---
 * key: value
 * ---
 */
function extractYamlFrontmatter(content: string): Record<string, unknown> | null {
  if (!content.startsWith("---")) return null;

  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;

  const yaml = content.slice(3, end).trim();
  try {
    const parsed = parseYaml(yaml);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // malformed YAML — skip
  }
  return null;
}
