// Windmill Script: Get CloudWatch Alarms (Read-Only)
// Investigation tool — lists CloudWatch metric and composite alarms across AWS accounts.
// Migrated from AWS SDK to Steampipe (read-only by enforcement).

import { steampipeQuery, awsSchema } from "./steampipe_helper.ts";

export async function main(
  account: string = "all",
  state?: "ALARM" | "OK" | "INSUFFICIENT_DATA",
  alarm_name_contains?: string,
  limit: number = 100,
) {
  const schema = awsSchema(account);
  const alarms: any[] = [];

  // --- Metric alarms ---
  {
    const conditions: string[] = [];
    const params: any[] = [];

    if (state) {
      params.push(state);
      conditions.push(`state_value = $${params.length}`);
    }
    if (alarm_name_contains) {
      params.push(`%${alarm_name_contains}%`);
      conditions.push(`name ILIKE $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = await steampipeQuery(`
      SELECT
        arn,
        name                    AS alarm_name,
        state_value             AS state,
        state_reason,
        state_updated_timestamp AS state_updated,
        metric_name,
        namespace,
        statistic,
        threshold,
        comparison_operator     AS comparison,
        period,
        evaluation_periods,
        alarm_actions           AS actions,
        account_id
      FROM ${schema}.aws_cloudwatch_alarm
      ${where}
      LIMIT ${limit}
    `, params.length ? params : undefined);

    alarms.push(...rows);
  }

  // --- Composite alarms (best-effort — table may not exist in all plugin versions) ---
  try {
    const conditions: string[] = [];
    const params: any[] = [];

    if (state) {
      params.push(state);
      conditions.push(`state_value = $${params.length}`);
    }
    if (alarm_name_contains) {
      params.push(`%${alarm_name_contains}%`);
      conditions.push(`name ILIKE $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = await steampipeQuery(`
      SELECT
        arn,
        name                    AS alarm_name,
        state_value             AS state,
        state_reason,
        state_updated_timestamp AS state_updated,
        'composite'             AS type,
        alarm_rule,
        alarm_actions           AS actions,
        account_id
      FROM ${schema}.aws_cloudwatch_composite_alarm
      ${where}
      LIMIT ${limit}
    `, params.length ? params : undefined);

    alarms.push(...rows);
  } catch {
    // composite alarm table absent in this plugin version — metric alarms only
  }

  return {
    count: alarms.length,
    accounts_queried: account === "all" ? "all" : 1,
    alarms: alarms.slice(0, limit),
  };
}
