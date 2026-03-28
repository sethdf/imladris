// Windmill Script: Sophos Get Alerts
// Investigation tool — retrieves security alerts from Sophos Central.

import { sophosFetch } from "./sophos_helper.ts";

export async function main(
  category?: "azure" | "adSync" | "applicationControl" | "appReputation" | "blockListed" | "connectivity" | "encryption" | "denc" | "downloadReputation" | "endpointFirewall" | "fakeAV" | "general" | "iaas" | "iaasAzure" | "isolation" | "malware" | "mtr" | "mobiles" | "policy" | "protection" | "pua" | "runtimeDetections" | "security" | "smc" | "systemHealth" | "uav" | "utm" | "wireless" | "xgEmail",
  severity?: "high" | "medium" | "low",
  limit: number = 50,
) {
  const params: Record<string, string | number | boolean | undefined> = {
    pageSize: limit,
    sort: "raisedAt:desc",
  };

  if (category) params.category = category;

  const data = await sophosFetch("/common/v1/alerts", { params });

  let alerts = (data.items || []).map((a: any) => ({
    id: a.id,
    severity: a.severity,
    category: a.category,
    type: a.type,
    description: a.description,
    raised_at: a.raisedAt,
    managed_agent: a.managedAgent?.name,
    managed_agent_id: a.managedAgent?.id,
    person: a.person?.name,
    tenant: a.tenant?.name,
    product: a.product,
    allowedActions: a.allowedActions,
  }));

  if (severity) {
    alerts = alerts.filter((a: any) => a.severity === severity);
  }

  return {
    total: data.pages?.total ?? alerts.length,
    returned: alerts.length,
    alerts,
  };
}
