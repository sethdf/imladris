// Windmill Script: Coralogix Get Alerts
// Investigation tool — retrieves alert rules and their state.

import { coralogixFetch } from "./coralogix_helper.ts";

export async function main(
  status?: "firing" | "inactive" | "disabled",
) {
  const data = await coralogixFetch("/api/v2/external/alerts");

  // Coralogix /api/v2/external/alerts returns { alerts: [...] }
  let rules = (data?.alerts ?? data?.data ?? []).map((r: any) => ({
    id: r.uniqueIdentifier?.value ?? r.id,
    name: r.name ?? r.alert,
    // Coralogix uses isActive; map to SigNoz-compatible state
    state: r.isActive === false ? "disabled" : (r.notificationPayloadFilter?.length > 0 ? "firing" : "inactive"),
    severity: r.severity,
    condition: r.condition,
    type: r.alertType ?? r.type,
    last_fired: r.lastTriggered,
    created_at: r.createdAt ?? r.meta?.createTime,
    updated_at: r.updatedAt ?? r.meta?.updateTime,
    labels: r.labels,
  }));

  if (status) {
    rules = rules.filter((r: any) => r.state === status);
  }

  const summary = {
    total: rules.length,
    firing: rules.filter((r: any) => r.state === "firing").length,
    inactive: rules.filter((r: any) => r.state === "inactive").length,
    disabled: rules.filter((r: any) => r.state === "disabled").length,
  };

  return { summary, rules };
}
