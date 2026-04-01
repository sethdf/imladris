// Windmill Script: Get Azure AD Users (Read-Only)
// Investigation tool — queries Azure AD users via Steampipe azuread plugin.
// Migrated from direct Microsoft Graph API to Steampipe (read-only by enforcement).

import { steampipeQuery } from "./steampipe_helper.ts";

export async function main(
  email?: string,
  department?: string,
  name_contains?: string,
  enabled_only: boolean = true,
  limit: number = 50,
) {
  const conditions: string[] = [];
  const params: any[] = [];

  if (email) {
    params.push(email.toLowerCase());
    conditions.push(`LOWER(user_principal_name) = $${params.length}`);
  } else if (name_contains) {
    params.push(`%${name_contains}%`);
    conditions.push(`display_name ILIKE $${params.length}`);
  }
  if (department) {
    params.push(department);
    conditions.push(`department = $${params.length}`);
  }
  if (enabled_only) {
    conditions.push(`account_enabled = true`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await steampipeQuery(`
    SELECT
      display_name,
      user_principal_name,
      account_enabled,
      department,
      job_title,
      mail,
      mobile_phone,
      office_location,
      created_date_time           AS created_date_time,
      last_password_change_date_time
    FROM azuread.azuread_user
    ${where}
    LIMIT ${limit}
  `, params.length ? params : undefined);

  return {
    count: rows.length,
    users: rows,
  };
}
