// Windmill Script: Get Security Groups (Read-Only)
// Investigation tool — lists VPC security groups and their rules across AWS accounts.
// Useful for investigating open ports, overly permissive rules, or VPC topology.
// Migrated from AWS SDK to Steampipe (read-only by enforcement).

import { steampipeQuery, awsSchema } from "./steampipe_helper.ts";

export async function main(
  account: string = "all",
  vpc_id?: string,
  group_id?: string,
  group_name_contains?: string,
  include_rules: boolean = true,
  limit: number = 50,
) {
  const schema = awsSchema(account);

  const conditions: string[] = [];
  const params: any[] = [];

  if (vpc_id) {
    params.push(vpc_id);
    conditions.push(`vpc_id = $${params.length}`);
  }
  if (group_id) {
    params.push(group_id);
    conditions.push(`group_id = $${params.length}`);
  }
  if (group_name_contains) {
    params.push(`%${group_name_contains}%`);
    conditions.push(`group_name ILIKE $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rulesCols = include_rules
    ? `, ip_permissions AS ingress_rules, ip_permissions_egress AS egress_rules`
    : "";

  const rows = await steampipeQuery(`
    SELECT
      group_id,
      group_name,
      description,
      vpc_id,
      account_id
      ${rulesCols}
    FROM ${schema}.aws_vpc_security_group
    ${where}
    LIMIT ${limit}
  `, params.length ? params : undefined);

  // Normalize rule shape to match prior SDK output format
  const groups = rows.map((sg: any) => {
    const out: any = {
      account: sg.account_id,
      group_id: sg.group_id,
      group_name: sg.group_name,
      description: sg.description,
      vpc_id: sg.vpc_id,
    };
    if (include_rules) {
      out.ingress_rules = (sg.ingress_rules || []).map(formatRule);
      out.egress_rules  = (sg.egress_rules  || []).map(formatRule);
    }
    return out;
  });

  return {
    count: groups.length,
    accounts_queried: account === "all" ? "all" : 1,
    security_groups: groups,
  };
}

function formatRule(perm: any) {
  return {
    protocol:      perm.IpProtocol === "-1" ? "all" : perm.IpProtocol,
    from_port:     perm.FromPort,
    to_port:       perm.ToPort,
    ipv4_ranges:   (perm.IpRanges     || []).map((r: any) => ({ cidr: r.CidrIp,   description: r.Description })),
    ipv6_ranges:   (perm.Ipv6Ranges   || []).map((r: any) => ({ cidr: r.CidrIpv6, description: r.Description })),
    source_groups: (perm.UserIdGroupPairs || []).map((g: any) => ({ group_id: g.GroupId, description: g.Description })),
  };
}
