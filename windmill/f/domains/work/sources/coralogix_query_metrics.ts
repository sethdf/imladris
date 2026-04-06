// Windmill Script: Coralogix Query Metrics
// Investigation tool — queries metrics via Coralogix Prometheus-compatible API.

import { coralogixFetch } from "./coralogix_helper.ts";

// Map SigNoz aggregate operators to PromQL functions
const AGGREGATE_TO_PROMQL: Record<string, string> = {
  avg: "avg_over_time",
  sum: "sum_over_time",
  min: "min_over_time",
  max: "max_over_time",
  count: "count_over_time",
  rate: "rate",
};

export async function main(
  metric_name: string,
  minutes: number = 60,
  aggregate: "avg" | "sum" | "min" | "max" | "count" | "rate" = "avg",
  group_by?: string,
  service_name?: string,
) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - minutes * 60;

  // Calculate step based on timerange (aim for ~60 data points)
  const step = Math.max(60, Math.floor((minutes * 60) / 60));

  // Build PromQL expression
  // Coralogix uses standard PromQL on its Prometheus-compatible endpoint
  const labelFilters: string[] = [];
  if (service_name) {
    // Coralogix maps applicationName/subsystemName to these labels
    labelFilters.push(`application="${service_name}"`);
  }

  const labelSelector = labelFilters.length > 0 ? `{${labelFilters.join(",")}}` : "";

  let promql: string;
  if (aggregate === "rate") {
    promql = `rate(${metric_name}${labelSelector}[${step}s])`;
  } else {
    const fn = AGGREGATE_TO_PROMQL[aggregate] ?? "avg_over_time";
    promql = `${fn}(${metric_name}${labelSelector}[${step}s])`;
  }

  // Optionally wrap in group_by aggregation
  if (group_by) {
    const aggFn = aggregate === "sum" ? "sum" : "avg";
    promql = `${aggFn} by (${group_by}) (${promql})`;
  }

  const data = await coralogixFetch("/metrics/api/v1/query_range", {
    method: "GET",
    params: {
      query: promql,
      start: String(start),
      end: String(now),
      step: String(step),
    },
  });

  // Prometheus-compatible response: { status, data: { resultType, result: [...] } }
  const series = data?.data?.result ?? [];
  const formattedSeries = series.map((s: any) => ({
    labels: s.metric ?? {},
    values: (s.values ?? []).slice(-20).map((v: any) => ({
      timestamp: new Date(v[0] * 1000).toISOString(),
      value: v[1],
    })),
    point_count: (s.values ?? []).length,
  }));

  return {
    metric: metric_name,
    promql,
    aggregate,
    timerange: `${minutes} minutes`,
    step_seconds: step,
    series_count: formattedSeries.length,
    series: formattedSeries,
  };
}
