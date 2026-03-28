// Windmill Script: SigNoz Query Logs
// Investigation tool — searches logs via SigNoz v3 query_range API.

import { signozFetch } from "./signoz_helper.ts";

export async function main(
  query: string = "",
  minutes: number = 60,
  limit: number = 100,
  severity_text?: string,
  service_name?: string,
) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - minutes * 60;

  // Build composite query filter
  const filters: any[] = [];

  if (query) {
    filters.push({
      key: { key: "body", dataType: "string", type: "tag", isColumn: true },
      op: "contains",
      value: query,
    });
  }

  if (severity_text) {
    filters.push({
      key: { key: "severity_text", dataType: "string", type: "tag", isColumn: true },
      op: "=",
      value: severity_text,
    });
  }

  if (service_name) {
    filters.push({
      key: { key: "serviceName", dataType: "string", type: "tag", isColumn: true },
      op: "=",
      value: service_name,
    });
  }

  const body = {
    start: start * 1000000000, // nanoseconds
    end: now * 1000000000,
    compositeQuery: {
      queryType: "builder",
      panelType: "list",
      builderQueries: {
        A: {
          dataSource: "logs",
          queryName: "A",
          aggregateOperator: "noop",
          aggregateAttribute: {},
          filters: { items: filters, op: "AND" },
          orderBy: [{ columnName: "timestamp", order: "desc" }],
          limit,
          offset: 0,
        },
      },
    },
  };

  const data = await signozFetch("/api/v3/query_range", {
    method: "POST",
    body,
  });

  // Extract log entries from result
  const series = data?.result?.[0]?.series || data?.result?.A?.series || [];
  const logs = series.flatMap((s: any) =>
    (s.values || []).map((v: any) => {
      const record = v.data || v;
      return {
        timestamp: record.timestamp,
        severity: record.severity_text,
        body: record.body?.substring(0, 500),
        service: record.serviceName || record.service_name,
        trace_id: record.traceId || record.trace_id,
        span_id: record.spanId || record.span_id,
      };
    })
  );

  return {
    query,
    timerange: `${minutes} minutes`,
    returned: logs.length,
    logs,
  };
}
