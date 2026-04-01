// Windmill Script: Compliance Scan via Steampipe PostgreSQL
// Runs targeted security queries against steampipe's PostgreSQL interface
// instead of shelling out to powerpipe CLI.

interface CheckDefinition {
  category: string;
  label: string;
  query: string;
}

interface Finding {
  category: string;
  status: "alarm" | "ok";
  count: number;
  details: any[];
}

interface ComplianceReport {
  generated: string;
  checks_run: number;
  findings: Finding[];
  summary: {
    alarm: number;
    ok: number;
    total_findings: number;
  };
}

const CHECKS: CheckDefinition[] = [
  {
    category: "config_noncompliant",
    label: "AWS Config non-compliant rules",
    query: `SELECT config_rule_name, compliance_type, count(*) as resources
            FROM aws_config_rule_compliance_detail
            WHERE compliance_type = 'NON_COMPLIANT'
            GROUP BY config_rule_name, compliance_type
            ORDER BY resources DESC
            LIMIT 20`,
  },
  {
    category: "public_s3",
    label: "Public S3 buckets",
    query: `SELECT name, region, account_id
            FROM aws_s3_bucket
            WHERE bucket_policy_is_public = true
               OR block_public_acls = false`,
  },
  {
    category: "unencrypted_ebs",
    label: "Unencrypted in-use EBS volumes",
    query: `SELECT volume_id, region, account_id, state
            FROM aws_ebs_volume
            WHERE encrypted = false AND state = 'in-use'`,
  },
  {
    category: "open_security_groups",
    label: "Open security groups (0.0.0.0/0 non-HTTP ingress)",
    query: `SELECT group_id, account_id, ip_protocol, from_port, to_port, region
            FROM aws_vpc_security_group_rule
            WHERE is_egress = false
              AND cidr_ipv4 = '0.0.0.0/0'
              AND (from_port IS NULL OR from_port NOT IN (443, 80))
            ORDER BY from_port`,
  },
  {
    category: "old_access_keys",
    label: "IAM access keys older than 90 days",
    query: `SELECT user_name, access_key_id, account_id, create_date
            FROM aws_iam_access_key
            WHERE create_date < now() - interval '90 days'
              AND status = 'Active'`,
  },
  {
    category: "root_access_keys",
    label: "Root account access keys",
    query: `SELECT account_id, user_name
            FROM aws_iam_access_key
            WHERE user_name = '<root_account>'`,
  },
];

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

async function runCheck(
  client: any,
  check: CheckDefinition,
): Promise<Finding> {
  const result = await client.query(check.query);
  const rows = result.rows || [];
  return {
    category: check.category,
    status: rows.length > 0 ? "alarm" : "ok",
    count: rows.length,
    details: rows.slice(0, 10),
  };
}

export async function main(
  benchmark: string = "",
  format: string = "json",
): Promise<ComplianceReport | { error: string }> {
  // Get steampipe password from Windmill variable
  const password = await getVariable("f/devops/steampipe_password");
  if (!password) {
    return { error: "Could not retrieve steampipe password from f/devops/steampipe_password" };
  }

  const { Client } = (await import("pg")) as any;
  const client = new Client({
    host: "172.17.0.1",
    port: 9193,
    database: "steampipe",
    user: "steampipe",
    password,
    connectionTimeoutMillis: 5000,
    query_timeout: 60000,
  });

  try {
    await client.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to connect to steampipe: ${message}` };
  }

  const findings: Finding[] = [];
  let checksRun = 0;

  for (const check of CHECKS) {
    try {
      const finding = await runCheck(client, check);
      findings.push(finding);
      checksRun++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push({
        category: check.category,
        status: "alarm",
        count: -1,
        details: [{ error: message, query: check.label }],
      });
      checksRun++;
    }
  }

  await client.end();

  const alarmCount = findings.filter((f) => f.status === "alarm" && f.count > 0).length;
  const okCount = findings.filter((f) => f.status === "ok").length;
  const totalFindings = findings.reduce(
    (sum, f) => sum + (f.count > 0 ? f.count : 0),
    0,
  );

  return {
    generated: new Date().toISOString(),
    checks_run: checksRun,
    findings,
    summary: {
      alarm: alarmCount,
      ok: okCount,
      total_findings: totalFindings,
    },
  };
}
