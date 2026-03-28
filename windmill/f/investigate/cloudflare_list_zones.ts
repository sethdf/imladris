// Windmill Script: Cloudflare List Zones
// Investigation tool — lists DNS zones with status and plan info.

import { cloudflareFetch } from "./cloudflare_helper.ts";

export async function main(
  search?: string,
  status?: "active" | "pending" | "initializing" | "moved" | "deleted" | "deactivated",
  limit: number = 50,
) {
  const params: Record<string, string | number | boolean | undefined> = {
    per_page: limit,
    order: "name",
    direction: "asc",
  };

  if (search) params.name = search;
  if (status) params.status = status;

  const data = await cloudflareFetch("/zones", { params });

  const zones = (data.result || []).map((z: any) => ({
    id: z.id,
    name: z.name,
    status: z.status,
    paused: z.paused,
    type: z.type,
    plan: z.plan?.name,
    name_servers: z.name_servers,
    created_on: z.created_on,
    modified_on: z.modified_on,
    ssl_status: z.ssl?.status,
  }));

  return {
    total: data.result_info?.total_count ?? zones.length,
    returned: zones.length,
    zones,
  };
}
