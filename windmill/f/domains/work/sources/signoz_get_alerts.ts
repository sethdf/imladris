// Windmill Script: SigNoz Get Alerts
// Investigation tool — retrieves alert rules and their firing status.

import { signozFetch } from "./signoz_helper.ts";

export async function main(
  status?: "firing" | "inactive" | "disabled",
) {
  const data = await signozFetch("/api/v1/rules");

  let rules = (data?.data?.rules || data?.data || []).map((r: any) => ({
    id: r.id,
    name: r.name || r.alert,
    state: r.state,
    severity: r.labels?.severity,
    condition: r.condition,
    type: r.ruleType || r.type,
    last_fired: r.lastFiredAt,
    created_at: r.createAt || r.createdAt,
    updated_at: r.updateAt || r.updatedAt,
    annotations: r.annotations,
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
