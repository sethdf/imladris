// Windmill Script: Securonix SIEM Investigation Tool
// Query incidents, violations, and threat activity from Securonix.
//
// Reads: f/devops/securonix_base_url, securonix_username, securonix_password
//
// Actions:
//   incidents    — List recent incidents (default: last 90 days, up to max)
//   incident     — Get details for a specific incident by ID
//   violations   — Search violations by entity/user
//   threats      — Get top threat indicators

import * as wmill from "windmill-client";

async function getToken(baseUrl: string, username: string, password: string): Promise<string> {
  const resp = await fetch(`${baseUrl}/ws/token/generate`, {
    headers: { username, password, validity: "1" },
  });
  if (!resp.ok) {
    throw new Error(`Token generation failed: ${resp.status} ${resp.statusText}`);
  }
  return (await resp.text()).trim();
}

export async function main(
  action: "incidents" | "incident" | "violations" | "threats" = "incidents",
  query?: string,
  max: number = 25,
  days: number = 90,
) {
  const baseUrl = await wmill.getVariable("f/devops/securonix_base_url");
  const username = await wmill.getVariable("f/devops/securonix_username");
  const password = await wmill.getVariable("f/devops/securonix_password");

  if (!baseUrl || !username || !password) {
    return { error: "Missing Securonix credentials in Windmill variables" };
  }

  const token = await getToken(baseUrl, username, password);
  const now = Date.now();
  const fromMs = now - days * 86400 * 1000;

  switch (action) {
    case "incidents": {
      const url = `${baseUrl}/ws/incident/get?type=list&max=${max}&offset=0&rangeType=updated&from=${fromMs}&to=${now}`;
      const resp = await fetch(url, { headers: { token } });
      if (!resp.ok) return { error: `Incidents API: ${resp.status}` };
      const data = await resp.json() as any;
      const items = data?.result?.data?.incidentItems || [];
      const total = data?.result?.data?.totalIncidents || 0;
      return {
        action: "incidents",
        total: Math.round(total),
        count: items.length,
        days,
        incidents: items.map((i: any) => ({
          id: i.incidentId,
          status: i.incidentStatus,
          priority: i.priority,
          type: i.incidentType,
          violator: i.violatorText,
          risk_score: i.riskscore,
          assigned_to: i.assignedUser,
          reasons: i.reason || [],
          entity: i.entity,
          url: i.url,
          created: i.casecreatetime ? new Date(i.casecreatetime).toISOString() : null,
          updated: i.lastUpdateDate ? new Date(i.lastUpdateDate).toISOString() : null,
        })),
      };
    }

    case "incident": {
      if (!query) return { error: "query parameter required: incident ID" };

      // Fetch workflow and status for the incident
      const [workflowResp, statusResp] = await Promise.all([
        fetch(`${baseUrl}/ws/incident/get?type=workflow&incidentId=${query}`, { headers: { token } }),
        fetch(`${baseUrl}/ws/incident/get?type=status&incidentId=${query}`, { headers: { token } }),
      ]);

      // Also find the incident in the list for full metadata
      const listUrl = `${baseUrl}/ws/incident/get?type=list&max=100&offset=0&rangeType=updated&from=0&to=${now}`;
      const listResp = await fetch(listUrl, { headers: { token } });
      const listData = await listResp.json() as any;
      const item = (listData?.result?.data?.incidentItems || [])
        .find((i: any) => i.incidentId === query);

      const workflow = workflowResp.ok ? ((await workflowResp.json()) as any)?.result?.workflow : null;
      const status = statusResp.ok ? ((await statusResp.json()) as any)?.result?.status : null;

      return {
        action: "incident",
        incident_id: query,
        status,
        workflow,
        detail: item ? {
          type: item.incidentType,
          priority: item.priority,
          violator: item.violatorText,
          risk_score: item.riskscore,
          assigned_to: item.assignedUser,
          entity: item.entity,
          reasons: item.reason || [],
          url: item.url,
          created: item.casecreatetime ? new Date(item.casecreatetime).toISOString() : null,
          updated: item.lastUpdateDate ? new Date(item.lastUpdateDate).toISOString() : null,
        } : null,
      };
    }

    case "violations": {
      if (!query) return { error: "query parameter required: entity name or account" };
      const url = `${baseUrl}/ws/incident/get?type=list&max=${max}&offset=0&rangeType=updated&from=${fromMs}&to=${now}`;
      const resp = await fetch(url, { headers: { token } });
      if (!resp.ok) return { error: `Violations search API: ${resp.status}` };
      const data = await resp.json() as any;
      const items = data?.result?.data?.incidentItems || [];
      const searchLower = query.toLowerCase();
      const matches = items.filter((i: any) =>
        i.violatorText?.toLowerCase().includes(searchLower) ||
        i.violatorId?.toLowerCase().includes(searchLower) ||
        i.assignedUser?.toLowerCase().includes(searchLower) ||
        (i.reason || []).some((r: string) => r.toLowerCase().includes(searchLower))
      );
      return {
        action: "violations",
        search: query,
        total_searched: items.length,
        matches: matches.length,
        incidents: matches.map((i: any) => ({
          id: i.incidentId,
          status: i.incidentStatus,
          priority: i.priority,
          type: i.incidentType,
          violator: i.violatorText,
          risk_score: i.riskscore,
          reasons: i.reason || [],
          url: i.url,
        })),
      };
    }

    case "threats": {
      const url = `${baseUrl}/ws/incident/get?type=list&max=${max}&offset=0&rangeType=updated&from=${fromMs}&to=${now}`;
      const resp = await fetch(url, { headers: { token } });
      if (!resp.ok) return { error: `Threats API: ${resp.status}` };
      const data = await resp.json() as any;
      const items = data?.result?.data?.incidentItems || [];

      // Extract and aggregate threat types from reasons
      const threatMap: Record<string, number> = {};
      const typeMap: Record<string, number> = {};
      const statusMap: Record<string, number> = {};
      for (const i of items) {
        typeMap[i.incidentType] = (typeMap[i.incidentType] || 0) + 1;
        statusMap[i.incidentStatus] = (statusMap[i.incidentStatus] || 0) + 1;
        for (const r of i.reason || []) {
          if (r.startsWith("Threat:")) {
            const t = r.replace("Threat:", "").trim();
            threatMap[t] = (threatMap[t] || 0) + 1;
          }
        }
      }

      return {
        action: "threats",
        total_incidents: items.length,
        days,
        by_threat: Object.entries(threatMap)
          .sort((a, b) => b[1] - a[1])
          .map(([name, count]) => ({ threat: name, count })),
        by_type: Object.entries(typeMap)
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => ({ type, count })),
        by_status: Object.entries(statusMap)
          .sort((a, b) => b[1] - a[1])
          .map(([status, count]) => ({ status, count })),
        open_incidents: items
          .filter((i: any) => i.incidentStatus !== "COMPLETED")
          .map((i: any) => ({
            id: i.incidentId,
            priority: i.priority,
            type: i.incidentType,
            violator: i.violatorText,
            risk_score: i.riskscore,
          })),
      };
    }
  }
}
