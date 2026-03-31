// Windmill Script: Get Azure AD Devices (Read-Only)
// Investigation tool — queries Azure AD devices via Steampipe azuread plugin.
// Returns device compliance status, OS info, and ownership.
// Migrated from direct Microsoft Graph API to Steampipe (read-only by enforcement).

import { steampipeQuery } from "./steampipe_helper.ts";

export async function main(
  display_name_contains?: string,
  os_type?: string,
  is_compliant?: boolean,
  limit: number = 50,
) {
  const conditions: string[] = [];
  const params: any[] = [];

  if (display_name_contains) {
    params.push(`%${display_name_contains}%`);
    conditions.push(`display_name ILIKE $${params.length}`);
  }
  if (os_type) {
    params.push(os_type);
    conditions.push(`operating_system = $${params.length}`);
  }
  if (is_compliant !== undefined) {
    params.push(is_compliant);
    conditions.push(`is_compliant = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await steampipeQuery(`
    SELECT
      display_name,
      device_id,
      operating_system            AS os,
      operating_system_version    AS os_version,
      is_compliant,
      is_managed,
      trust_type,
      approximate_last_sign_in_date_time AS last_sign_in,
      account_enabled             AS enabled
    FROM azuread.azuread_device
    ${where}
    LIMIT ${limit}
  `, params.length ? params : undefined);

  return {
    count: rows.length,
    devices: rows,
  };
}
