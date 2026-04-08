// Windmill Script: Build Investigation Tool (Meta-Tool)
// Allows AI investigator to create new read-only investigation scripts at runtime.
// Creates a new Bun/TypeScript script in f/investigate/ via Windmill HTTP API.
// The new script becomes immediately available as an MCP tool.
//
// SAFETY: Only creates scripts in f/investigate/ (read-only tools).
// Rejects code containing write operations (POST, PUT, DELETE, INSERT, UPDATE).

export async function main(
  name: string,
  description: string,
  code: string,
) {
  // --- Validation ---
  if (!name || !description || !code) {
    return { error: "name, description, and code are all required" };
  }

  // Sanitize name: lowercase, underscores only, no path traversal
  const cleanName = name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_{2,}/g, "_");
  if (cleanName.length < 3 || cleanName.length > 60) {
    return { error: "name must be 3-60 characters (letters, numbers, underscores)" };
  }

  const scriptPath = `f/investigate/${cleanName}`;

  // Safety: reject code with write operations
  const writePatterns = [
    /\bfetch\s*\([^)]*method\s*:\s*["'](POST|PUT|DELETE|PATCH)["']/gi,
    /\.send\s*\(\s*new\s+(Put|Delete|Create|Update)/gi,
    /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE TABLE|TRUNCATE)\b/gi,
    /\bwriteFile\b/gi,
    /\bfs\.write\b/gi,
    /\bunlink\b/gi,
    /\brmdir\b/gi,
  ];

  for (const pattern of writePatterns) {
    if (pattern.test(code)) {
      return {
        error: `Code contains write operations (matched: ${pattern.source}). Investigation tools must be read-only.`,
      };
    }
  }

  // Ensure code exports async function main
  if (!/export\s+async\s+function\s+main\s*\(/.test(code)) {
    return { error: "Code must export an async function main() — Windmill convention" };
  }

  // --- Create script via Windmill API ---
  const base = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
  const token = process.env.WM_TOKEN;
  const workspace = process.env.WM_WORKSPACE || "imladris";

  if (!token) return { error: "WM_TOKEN not available — cannot create script" };

  // Check if script already exists
  const existsResp = await fetch(
    `${base}/api/w/${workspace}/scripts/get/p/${scriptPath}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (existsResp.ok) {
    // Script exists — update it by creating a new version
    const existingScript = await existsResp.json();
    const parentHash = existingScript.hash;

    const updateResp = await fetch(
      `${base}/api/w/${workspace}/scripts/create`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: scriptPath,
          summary: description.slice(0, 200),
          description: `Auto-generated investigation tool: ${description}`,
          content: code,
          language: "bun",
          parent_hash: parentHash,
          is_template: false,
          kind: "script",
        }),
      },
    );

    if (!updateResp.ok) {
      const err = await updateResp.text();
      return { error: `Failed to update script: ${updateResp.status} ${err}` };
    }

    return {
      action: "updated",
      path: scriptPath,
      message: `Updated investigation tool: ${cleanName}. It is now available as an MCP tool.`,
    };
  }

  // Script doesn't exist — create new
  const createResp = await fetch(
    `${base}/api/w/${workspace}/scripts/create`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: scriptPath,
        summary: description.slice(0, 200),
        description: `Auto-generated investigation tool: ${description}`,
        content: code,
        language: "bun",
        is_template: false,
        kind: "script",
      }),
    },
  );

  if (!createResp.ok) {
    const err = await createResp.text();
    return { error: `Failed to create script: ${createResp.status} ${err}` };
  }

  return {
    action: "created",
    path: scriptPath,
    message: `Created new investigation tool: ${cleanName}. It is now available as an MCP tool. Call it at path: ${scriptPath}`,
  };
}
