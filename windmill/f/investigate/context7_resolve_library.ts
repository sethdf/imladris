// Windmill Script: Context7 Resolve Library
// Maps a vendor/library name to a Context7 library ID for documentation lookups.
// Calls Context7 REST API directly (no MCP).
//
// Usage: Opus calls this first to find the library ID, then context7_query_docs.

const C7_BASE = "https://context7.com/api";

export async function main(
  library_name: string,
  query: string = "documentation",
): Promise<{
  libraries: { id: string; title: string; description: string; snippets: number; score: number }[];
  recommended_id: string | null;
}> {
  const params = new URLSearchParams({
    libraryName: library_name,
    query,
  });

  const resp = await fetch(`${C7_BASE}/v2/libs/search?${params}`);

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Context7 API error ${resp.status}: ${body.slice(0, 500)}`);
  }

  const data = await resp.json();
  const results = (data.results || []).slice(0, 10);

  const libraries = results.map((r: any) => ({
    id: r.id,
    title: r.title || "",
    description: (r.description || "").slice(0, 200),
    snippets: r.totalSnippets || 0,
    score: r.benchmarkScore || 0,
  }));

  // Recommend the highest-scoring result with substantial snippets
  const recommended = libraries
    .filter((l: any) => l.snippets > 100)
    .sort((a: any, b: any) => b.score - a.score)[0];

  return {
    libraries,
    recommended_id: recommended?.id || libraries[0]?.id || null,
  };
}
