// Windmill Script: Query Steampipe (Read-Only)
// Investigation tool — run SQL queries against steampipe for cross-account AWS resource lookups.

async function getVariable(path: string): Promise<string | undefined> {
  const base = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
  const token = process.env.WM_TOKEN;
  const workspace = process.env.WM_WORKSPACE || "imladris";
  if (!token) return undefined;
  try {
    const resp = await fetch(
      `${base}/api/w/${workspace}/variables/get_value/${path}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) return undefined;
    const val = await resp.text();
    const parsed = val.startsWith('"') ? JSON.parse(val) : val;
    return parsed.trim();
  } catch {
    return undefined;
  }
}

const WRITE_OPS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i;

export async function main(query: string) {
  if (!query?.trim()) return { error: "query is required" };

  if (WRITE_OPS.test(query)) {
    return { error: "Write operations are not allowed (read-only tool)", query };
  }

  const password = await getVariable("f/devops/steampipe_password");
  if (!password) return { error: "Could not retrieve steampipe_password variable" };

  let finalQuery = query.trim().replace(/;$/, "");
  if (!/\bLIMIT\b/i.test(finalQuery)) {
    finalQuery += " LIMIT 100";
  }

  const { Client } = (await import("pg")) as any;
  const client = new Client({
    host: "172.17.0.1",
    port: 9193,
    database: "steampipe",
    user: "steampipe",
    password,
    connectionTimeoutMillis: 5000,
    query_timeout: 30000,
  });

  try {
    await client.connect();
    const result = await client.query(finalQuery);
    const columns = result.fields.map((f: any) => f.name);
    const truncated = result.rows.length >= 100;
    return {
      columns,
      rows: result.rows,
      row_count: result.rows.length,
      truncated,
    };
  } catch (e: any) {
    return { error: e.message, query: finalQuery };
  } finally {
    await client.end().catch(() => {});
  }
}
