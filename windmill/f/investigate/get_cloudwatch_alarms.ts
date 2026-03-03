// Windmill Script: Get CloudWatch Alarms (Read-Only)
// Investigation tool — lists CloudWatch alarms across AWS accounts.
// Supports filtering by alarm state (ALARM, OK, INSUFFICIENT_DATA).

import { CloudWatchClient, DescribeAlarmsCommand, type StateValue } from "@aws-sdk/client-cloudwatch";
import { getAwsCredentials, AWS_ACCOUNTS, resolveAccounts } from "./aws_helper.ts";

export async function main(
  account: string = "all",
  state?: "ALARM" | "OK" | "INSUFFICIENT_DATA",
  alarm_name_contains?: string,
  limit: number = 100,
) {
  const targets = resolveAccounts(account);
  const allAlarms: any[] = [];

  const results = await Promise.allSettled(
    targets.map(async (acct) => {
      const creds = await getAwsCredentials(acct);
      const region = AWS_ACCOUNTS[acct]?.region || "us-east-1";
      const cw = new CloudWatchClient({ region, credentials: creds });

      const resp = await cw.send(new DescribeAlarmsCommand({
        StateValue: state as StateValue | undefined,
        MaxRecords: Math.min(limit, 100),
      }));

      const alarms: any[] = [];
      for (const a of resp.MetricAlarms || []) {
        if (alarm_name_contains && !a.AlarmName?.toLowerCase().includes(alarm_name_contains.toLowerCase())) continue;
        alarms.push({
          account: acct,
          alarm_name: a.AlarmName,
          state: a.StateValue,
          state_reason: a.StateReason,
          state_updated: a.StateUpdatedTimestamp?.toISOString(),
          metric_name: a.MetricName,
          namespace: a.Namespace,
          statistic: a.Statistic,
          threshold: a.Threshold,
          comparison: a.ComparisonOperator,
          period: a.Period,
          evaluation_periods: a.EvaluationPeriods,
          actions: a.AlarmActions,
        });
      }

      for (const a of resp.CompositeAlarms || []) {
        if (alarm_name_contains && !a.AlarmName?.toLowerCase().includes(alarm_name_contains.toLowerCase())) continue;
        alarms.push({
          account: acct,
          alarm_name: a.AlarmName,
          state: a.StateValue,
          state_reason: a.StateReason,
          state_updated: a.StateUpdatedTimestamp?.toISOString(),
          type: "composite",
          alarm_rule: a.AlarmRule,
          actions: a.AlarmActions,
        });
      }
      return alarms;
    })
  );

  for (const r of results) {
    if (r.status === "fulfilled") allAlarms.push(...r.value);
  }

  return {
    count: allAlarms.length,
    accounts_queried: targets.length,
    alarms: allAlarms.slice(0, limit),
  };
}
