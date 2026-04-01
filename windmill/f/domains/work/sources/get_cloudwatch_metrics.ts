// Windmill Script: Get CloudWatch Metrics (Read-Only)
// Investigation tool — queries CloudWatch for EC2 instance metrics.
// Returns time-series data for CPU, status checks, disk, network.

import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";
import { getAwsCredentials, AWS_ACCOUNTS, resolveAccounts } from "./aws_helper.ts";

export async function main(
  instance_id: string = "",
  account: string = "prod",
  metrics: string = "CPUUtilization,StatusCheckFailed",
  hours_back: number = 24,
  period_minutes: number = 5,
) {
  if (!instance_id) {
    return { error: "instance_id required (e.g., i-0abc123)" };
  }

  const targets = resolveAccounts(account);
  if (targets.length === 0) return { error: `Unknown account: ${account}` };
  const acct = targets[0];

  const creds = await getAwsCredentials(acct);
  const region = AWS_ACCOUNTS[acct]?.region || "us-east-1";
  const cw = new CloudWatchClient({ region, credentials: creds });

  const metricNames = metrics.split(",").map(m => m.trim()).filter(Boolean);
  const endTime = new Date();
  const startTime = new Date(Date.now() - hours_back * 3600 * 1000);
  const periodSec = period_minutes * 60;

  // Map metric names to their CloudWatch namespace and statistic
  const metricConfig: Record<string, { namespace: string; stat: string }> = {
    CPUUtilization:           { namespace: "AWS/EC2", stat: "Average" },
    StatusCheckFailed:        { namespace: "AWS/EC2", stat: "Maximum" },
    StatusCheckFailed_Instance: { namespace: "AWS/EC2", stat: "Maximum" },
    StatusCheckFailed_System: { namespace: "AWS/EC2", stat: "Maximum" },
    NetworkIn:                { namespace: "AWS/EC2", stat: "Sum" },
    NetworkOut:               { namespace: "AWS/EC2", stat: "Sum" },
    DiskReadOps:              { namespace: "AWS/EC2", stat: "Sum" },
    DiskWriteOps:             { namespace: "AWS/EC2", stat: "Sum" },
    NetworkPacketsIn:         { namespace: "AWS/EC2", stat: "Sum" },
    NetworkPacketsOut:        { namespace: "AWS/EC2", stat: "Sum" },
  };

  const queries: MetricDataQuery[] = metricNames.map((name, idx) => {
    const config = metricConfig[name] || { namespace: "AWS/EC2", stat: "Average" };
    return {
      Id: `m${idx}`,
      Label: name,
      MetricStat: {
        Metric: {
          Namespace: config.namespace,
          MetricName: name,
          Dimensions: [{ Name: "InstanceId", Value: instance_id }],
        },
        Period: periodSec,
        Stat: config.stat,
      },
    };
  });

  const resp = await cw.send(new GetMetricDataCommand({
    MetricDataQueries: queries,
    StartTime: startTime,
    EndTime: endTime,
  }));

  const results: Record<string, any> = {};
  for (const r of resp.MetricDataResults || []) {
    const label = r.Label || "unknown";
    const timestamps = (r.Timestamps || []).map(t => t?.toISOString());
    const values = r.Values || [];

    // Pair and sort by time ascending
    const pairs = timestamps.map((t, i) => ({ time: t, value: values[i] }))
      .sort((a, b) => (a.time || "").localeCompare(b.time || ""));

    results[label] = {
      status: r.StatusCode,
      datapoints: pairs.length,
      min: pairs.length > 0 ? Math.min(...pairs.map(p => p.value ?? Infinity)) : null,
      max: pairs.length > 0 ? Math.max(...pairs.map(p => p.value ?? -Infinity)) : null,
      avg: pairs.length > 0 ? pairs.reduce((s, p) => s + (p.value ?? 0), 0) / pairs.length : null,
      latest: pairs.length > 0 ? pairs[pairs.length - 1] : null,
      series: pairs,
    };
  }

  return {
    instance_id,
    account: acct,
    hours_back,
    period_minutes,
    start_time: startTime.toISOString(),
    end_time: endTime.toISOString(),
    metrics: results,
  };
}
