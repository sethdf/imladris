// Windmill Script: Sophos List Endpoints
// Investigation tool — lists managed endpoints with health and status.

import { sophosFetch } from "./sophos_helper.ts";

export async function main(
  search?: string,
  health_status?: "good" | "suspicious" | "bad",
  type?: "computer" | "server",
  limit: number = 50,
) {
  const params: Record<string, string | number | boolean | undefined> = {
    pageSize: limit,
    sort: "lastSeenAt:desc",
  };

  if (health_status) params.healthStatus = health_status;
  if (type) params.type = type;
  if (search) params.search = search;

  const data = await sophosFetch("/endpoint/v1/endpoints", { params });

  const endpoints = (data.items || []).map((ep: any) => ({
    id: ep.id,
    hostname: ep.hostname,
    os_name: ep.os?.name,
    os_platform: ep.os?.platform,
    health: ep.health?.overall,
    health_threats: ep.health?.threats?.status,
    ip_addresses: ep.ipv4Addresses?.slice(0, 3),
    mac_addresses: ep.macAddresses?.slice(0, 2),
    last_seen: ep.lastSeenAt,
    type: ep.type,
    tamper_protection: ep.tamperProtectionEnabled,
    group_name: ep.associatedPerson?.viaLogin,
  }));

  return {
    total: data.pages?.total ?? endpoints.length,
    returned: endpoints.length,
    endpoints,
  };
}
