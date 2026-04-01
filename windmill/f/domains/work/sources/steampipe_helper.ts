// Steampipe PostgreSQL Helper
// Shared connection utility for all Steampipe-backed investigation scripts.
// Replaces per-script AWS SDK credential chains with a single read-only SQL interface.
//
// Connection: Steampipe at 172.17.0.1:9193 (Docker bridge host IP)
// Auth: password from Windmill variable f/devops/steampipe_password
//
// AWS multi-account schema routing:
//   account = "all"      → schema "aws"        (aggregated — all 16 accounts)
//   account = "prod"     → schema "aws_prod"   (single account)
//   account = "imladris" → schema "aws_imladris"
//   (normalized: hyphens → underscores, prefix "aws_" added)
//
// For non-AWS plugins use fully qualified table names directly in SQL:
//   SELECT ... FROM azuread.azuread_user WHERE ...
//   SELECT ... FROM cloudflare.cloudflare_zone WHERE ...
//   SELECT ... FROM slack.slack_conversation WHERE ...
//   SELECT ... FROM net.net_dns_record WHERE ...

const STEAMPIPE_HOST = process.env.STEAMPIPE_HOST || "172.17.0.1";
const STEAMPIPE_PORT = parseInt(process.env.STEAMPIPE_PORT || "9193");

// Map short account names to AWS account IDs (mirrors aws_helper.ts)
export const AWS_ACCOUNT_IDS: Record<string, string> = {
  imladris:        "767448074758",
  dev:             "899550195859",
  qat:             "481665097654",
  prod:            "945243322929",
  org:             "751182152181",
  buxton_qat:      "141017301520",
  data_collection: "156041442432",
  dev01:           "211125480617",
  testing:         "381491869908",
  logs:            "410382209500",
  uat:             "495599759895",
  dr:              "533267062671",
  ai_dev:          "533267201907",
  contractors:     "533267356553",
  audit:           "851725550259",
  log_archive:     "891377156740",
};

async function getVariable(path: string): Promise<string | undefined> {
  const base = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
  const token = process.env.WM_TOKEN;
  const workspace = process.env.WM_WORKSPACE || "imladris";
  if (!token) return undefined;
  try {
    const resp = await fetch(`${base}/api/w/${workspace}/variables/get_value/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return undefined;
    const val = await resp.text();
    return (val.startsWith('"') ? JSON.parse(val) : val).trim();
  } catch { return undefined; }
}

// Returns the Steampipe schema name for an AWS account parameter.
// "all" or "" → "aws" (aggregated connection).
// Named account → "aws_<name>" (individual connection).
export function awsSchema(account: string): string {
  if (!account || account === "all") return "aws";
  return `aws_${account.replace(/-/g, "_")}`;
}

// Resolves an account name to its numeric AWS account ID, or null for "all".
export function resolveAccountId(account: string): string | null {
  if (!account || account === "all") return null;
  return AWS_ACCOUNT_IDS[account.replace(/-/g, "_")] ?? null;
}

// Execute a SQL query against Steampipe. Returns result rows.
// Opens and closes a fresh pg client per call (Steampipe is stateless; no connection pooling).
export async function steampipeQuery(sql: string, params?: any[]): Promise<any[]> {
  const password = await getVariable("f/devops/steampipe_password");
  if (!password) throw new Error("f/devops/steampipe_password not configured in Windmill variables");

  const { Client } = await import("pg") as any;
  const client = new Client({
    host: STEAMPIPE_HOST,
    port: STEAMPIPE_PORT,
    database: "steampipe",
    user: "steampipe",
    password,
    connectionTimeoutMillis: 5000,
    query_timeout: 30000,
  });

  await client.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

// Windmill main — connectivity test
export async function main() {
  try {
    const rows = await steampipeQuery("SELECT version()");
    return { status: "connected", steampipe: rows[0]?.version };
  } catch (e) {
    return { status: "error", error: String(e) };
  }
}
