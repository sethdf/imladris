// Windmill Script: Get EC2 Instances (Read-Only)
// Investigation tool — lists EC2 instances across AWS accounts.
// Supports filtering by state, instance ID, name, IP, or VPC.
// Migrated from AWS SDK to Steampipe (read-only by enforcement).

import { steampipeQuery, awsSchema } from "./steampipe_helper.ts";

export async function main(
  account: string = "all",
  state?: "running" | "stopped" | "terminated" | "pending" | "shutting-down",
  instance_id?: string,
  name_contains?: string,
  private_ip?: string,
  vpc_id?: string,
  limit: number = 100,
) {
  const schema = awsSchema(account);

  const conditions: string[] = [];
  const params: any[] = [];

  if (state) {
    params.push(state);
    conditions.push(`instance_state = $${params.length}`);
  }
  if (instance_id) {
    params.push(instance_id);
    conditions.push(`instance_id = $${params.length}`);
  }
  if (name_contains) {
    params.push(`%${name_contains}%`);
    conditions.push(`tags->>'Name' ILIKE $${params.length}`);
  }
  if (private_ip) {
    params.push(private_ip);
    conditions.push(`private_ip_address = $${params.length}`);
  }
  if (vpc_id) {
    params.push(vpc_id);
    conditions.push(`vpc_id = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT
      instance_id,
      instance_state          AS state,
      state_reason_message    AS state_reason,
      state_transition_reason,
      instance_type           AS type,
      tags->>'Name'           AS name,
      private_ip_address      AS private_ip,
      public_ip_address       AS public_ip,
      vpc_id,
      subnet_id,
      placement_availability_zone AS az,
      launch_time,
      platform_details        AS platform,
      iam_instance_profile_arn AS iam_role,
      account_id
    FROM ${schema}.aws_ec2_instance
    ${where}
    LIMIT ${limit}
  `;

  const rows = await steampipeQuery(sql, params.length > 0 ? params : undefined);

  return {
    count: rows.length,
    account,
    instances: rows,
  };
}
