// Windmill Script: SigNoz Query Metrics
// Investigation tool — queries metrics via SigNoz v3 query_range API.

import { signozFetch } from "./signoz_helper.ts";

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

  const filters: any[] = [];

  if (service_name) {
    filters.push({
      key: { key: "service_name", dataType: "string", type: "resource", isColumn: false },
      op: "=",
      value: service_name,
    });
  }

  const groupByItems = group_by
    ? [{ key: { key: group_by, dataType: "string", type: "tag", isColumn: false }, isColumn: false }]
    : [];

  const body = {
    start: start * 1000000000,
    end: now * 1000000000,
    step,
    compositeQuery: {
      queryType: "builder",
      panelType: "graph",
      builderQueries: {
        A: {
          dataSource: "metrics",
          queryName: "A",
          aggregateOperator: aggregate,
          aggregateAttribute: {
            key: metric_name,
            dataType: "float64",
            type: "Gauge",
            isColumn: false,
          },
          filters: { items: filters, op: "AND" },
          groupBy: groupByItems,
          expression: "A",
          disabled: false,
        },
      },
    },
  };

  const data = await signozFetch("/api/v3/query_range", {
    method: "POST",
    body,
  });

  const series = data?.result?.[0]?.series || data?.result?.A?.series || [];
  const formattedSeries = series.map((s: any) => ({
    labels: s.labels || {},
    values: (s.values || []).slice(-20).map((v: any) => ({
      timestamp: v.timestamp ? new Date(v.timestamp / 1000000).toISOString() : undefined,
      value: v.value,
    })),
    point_count: (s.values || []).length,
  }));

  return {
    metric: metric_name,
    aggregate,
    timerange: `${minutes} minutes`,
    step_seconds: step,
    series_count: formattedSeries.length,
    series: formattedSeries,
  };
}
