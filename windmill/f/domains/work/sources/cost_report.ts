// Windmill Script: Daily Cost Report
// Decision 26: Automatic daily reports — AWS cost breakdown via Steampipe
//
// Connects to Steampipe's PostgreSQL interface at 172.17.0.1:9193

interface CostEntry {
  service: string;
  cost: number;
}

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

export async function main(
  lookback_days: number = 1,
  format: string = "text",
) {
  const password = await getVariable("f/devops/steampipe_password");
  if (!password) {
    return { error: "Could not retrieve steampipe_password from Windmill variables" };
  }

  const query = `
    SELECT service, SUM(unblended_cost_amount::numeric) AS cost
    FROM aws_cost_by_service_daily
    WHERE period_start >= now() - interval '${lookback_days} day'
    GROUP BY service
    ORDER BY cost DESC
    LIMIT 20
  `;

  let entries: CostEntry[] = [];
  let totalCost = 0;

  try {
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
    await client.connect();
    const result = await client.query(query);
    await client.end();

    entries = (result.rows || []).map((r: Record<string, unknown>) => ({
      service: String(r.service || "Unknown"),
      cost: Number(r.cost || 0),
    }));

    totalCost = entries.reduce((sum, e) => sum + e.cost, 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Steampipe query failed: ${message}` };
  }

  const now = new Date();

  const report = {
    generated: now.toISOString(),
    lookback_days,
    total_cost: Math.round(totalCost * 100) / 100,
    service_count: entries.length,
    services: entries.map((e) => ({
      service: e.service,
      cost: Math.round(e.cost * 100) / 100,
    })),
  };

  if (format === "text") {
    let text = `=== AWS Cost Report ===\n`;
    text += `Period: Last ${lookback_days} day(s)\n`;
    text += `Generated: ${now.toISOString().slice(0, 16).replace("T", " ")}\n\n`;
    text += `Total: $${report.total_cost.toFixed(2)}\n\n`;
    text += `Service Breakdown:\n`;

    for (const s of report.services) {
      const pct =
        totalCost > 0 ? ((s.cost / totalCost) * 100).toFixed(1) : "0.0";
      text += `  ${s.service}: $${s.cost.toFixed(2)} (${pct}%)\n`;
    }

    if (entries.length === 0) {
      text += `  No cost data found for the specified period.\n`;
    }

    return { report: text };
  }

  return report;
}
