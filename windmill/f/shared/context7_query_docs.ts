// Windmill Script: Context7 Query Documentation
// Retrieves vendor documentation snippets for a specific library.
// Calls Context7 REST API directly (no MCP).
//
// Usage: Opus calls context7_resolve_library first to get the library_id,
// then this script to get relevant documentation for the investigation.

const C7_BASE = "https://context7.com/api";
const MAX_RESPONSE_CHARS = 30_000;

export async function main(
  library_id: string,
  query: string,
): Promise<{
  documentation: string;
  library_id: string;
  query: string;
  truncated: boolean;
}> {
  if (!library_id.startsWith("/")) {
    throw new Error(
      `Invalid library_id format: "${library_id}". Must start with "/" (e.g., "/websites/aws_amazon"). Call context7_resolve_library first.`
    );
  }

  const params = new URLSearchParams({
    libraryId: library_id,
    query,
  });

  const resp = await fetch(`${C7_BASE}/v2/context?${params}`);

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Context7 API error ${resp.status}: ${body.slice(0, 500)}`);
  }

  const text = await resp.text();
  const truncated = text.length > MAX_RESPONSE_CHARS;
  const documentation = truncated ? text.slice(0, MAX_RESPONSE_CHARS) + "\n\n[...truncated]" : text;

  return {
    documentation,
    library_id,
    query,
    truncated,
  };
}
