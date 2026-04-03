/**
 * Deterministic metadata extraction — no inference, pure parsing.
 */

/** Extract metadata from a file's content based on its key (path). */
export function extractMetadata(key: string, content: string): Record<string, unknown> {
  if (key.endsWith('.md')) {
    return extractFrontmatter(content);
  }
  if (key.endsWith('.jsonl')) {
    return { type: 'jsonl' };
  }
  if (key.endsWith('.json')) {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore parse errors
    }
    return {};
  }
  return { extension: key.split('.').pop() ?? '' };
}

/** Extract metadata from a single JSONL line. */
export function extractLineMetadata(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}

function extractFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const frontmatter = match[1];
  const result: Record<string, unknown> = {};

  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    // Coerce obvious types
    if (value === 'true') result[key] = true;
    else if (value === 'false') result[key] = false;
    else if (/^\d+$/.test(value)) result[key] = parseInt(value, 10);
    else result[key] = value;
  }

  return result;
}
