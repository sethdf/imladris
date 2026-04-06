// Windmill Script: Coralogix Query Logs
// Investigation tool — searches logs via Coralogix DataPrime query API.

import { coralogixFetch } from "./coralogix_helper.ts";

export async function main(
  query: string = "",
  minutes: number = 60,
  limit: number = 100,
  severity_text?: string,
  service_name?: string,
) {
  const now = new Date();
  const start = new Date(now.getTime() - minutes * 60 * 1000);

  // Build DataPrime query filter clauses
  const filters: string[] = [];

  if (query) {
    // DataPrime: text contains search
    filters.push(`$l.text ~ /.*${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*/`);
  }

  if (severity_text) {
    filters.push(`$l.severity == "${severity_text.toLowerCase()}"`);
  }

  if (service_name) {
    // applicationName or subsystemName depending on how logs were shipped
    filters.push(`($l.applicationName == "${service_name}" || $l.subsystemName == "${service_name}")`);
  }

  // Build the DataPrime query string
  // Base: "source logs" then filter then limit
  let dpQuery = "source logs";
  if (filters.length > 0) {
    dpQuery += ` | filter ${filters.join(" && ")}`;
  }
  dpQuery += ` | limit ${limit}`;

  const body = {
    query: dpQuery,
    metadata: {
      syntax: "QUERY_SYNTAX_DATAPRIME",
      startDate: start.toISOString(),
      endDate: now.toISOString(),
      limit,
      defaultSource: "logs",
    },
  };

  const data = await coralogixFetch("/api/v1/dataprime/query", {
    method: "POST",
    body,
  });

  // Extract log entries from DataPrime response
  const results = data?.results ?? [];
  const logs = results.map((r: any) => {
    const labels = r.labels ?? {};
    const userData = r.userData ?? {};
    return {
      timestamp: r.metadata?.timestamp ?? labels.timestamp,
      severity: labels.severity ?? userData.severity,
      body: (userData.text ?? userData.message ?? userData.body ?? "")?.substring(0, 500),
      service: labels.applicationName ?? labels.subsystemName ?? userData.applicationName,
      trace_id: userData.traceId ?? userData.trace_id,
      span_id: userData.spanId ?? userData.span_id,
    };
  });

  return {
    query,
    timerange: `${minutes} minutes`,
    returned: logs.length,
    logs,
  };
}
