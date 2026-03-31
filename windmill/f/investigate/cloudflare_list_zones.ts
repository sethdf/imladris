// Windmill Script: Cloudflare List Zones
// Investigation tool — lists DNS zones with status and plan info.
// Migrated from direct Cloudflare API to Steampipe (read-only by enforcement).

import { steampipeQuery } from "./steampipe_helper.ts";

export async function main(
  search?: string,
  status?: "active" | "pending" | "initializing" | "moved" | "deleted" | "deactivated",
  limit: number = 50,
) {
  const conditions: string[] = [];
  const params: any[] = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`name ILIKE $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await steampipeQuery(`
    SELECT
      id,
      name,
      status,
      paused,
      zone_type               AS type,
      plan_name               AS plan,
      name_servers,
      created_on,
      modified_on
    FROM cloudflare.cloudflare_zone
    ${where}
    ORDER BY name ASC
    LIMIT ${limit}
  `, params.length ? params : undefined);

  return {
    total: rows.length,
    returned: rows.length,
    zones: rows,
  };
}
