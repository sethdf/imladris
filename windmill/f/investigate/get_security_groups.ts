// Windmill Script: Get Security Groups (Read-Only)
// Investigation tool — lists VPC security groups and their rules across AWS accounts.
// Useful for investigating open ports, overly permissive rules, or VPC topology.

import {
  EC2Client,
  DescribeSecurityGroupsCommand,
  DescribeSecurityGroupRulesCommand,
  type Filter,
} from "@aws-sdk/client-ec2";
import { getAwsCredentials, AWS_ACCOUNTS, resolveAccounts } from "./aws_helper.ts";

export async function main(
  account: string = "all",
  vpc_id?: string,
  group_id?: string,
  group_name_contains?: string,
  include_rules: boolean = true,
  limit: number = 50,
) {
  const targets = resolveAccounts(account);
  const allGroups: any[] = [];

  const results = await Promise.allSettled(
    targets.map(async (acct) => {
      const creds = await getAwsCredentials(acct);
      const region = AWS_ACCOUNTS[acct]?.region || "us-east-1";
      const ec2 = new EC2Client({ region, credentials: creds });

      const filters: Filter[] = [];
      if (vpc_id) filters.push({ Name: "vpc-id", Values: [vpc_id] });
      if (group_id) filters.push({ Name: "group-id", Values: [group_id] });

      const sgResp = await ec2.send(new DescribeSecurityGroupsCommand({
        Filters: filters.length > 0 ? filters : undefined,
        MaxResults: Math.min(limit, 1000),
      }));

      const groups: any[] = [];
      for (const sg of sgResp.SecurityGroups || []) {
        if (group_name_contains && !sg.GroupName?.toLowerCase().includes(group_name_contains.toLowerCase())) continue;

        const group: any = {
          account: acct,
          group_id: sg.GroupId,
          group_name: sg.GroupName,
          description: sg.Description,
          vpc_id: sg.VpcId,
        };

        if (include_rules) {
          group.ingress_rules = (sg.IpPermissions || []).map(formatRule);
          group.egress_rules = (sg.IpPermissionsEgress || []).map(formatRule);
        }

        groups.push(group);
      }
      return groups;
    })
  );

  for (const r of results) {
    if (r.status === "fulfilled") allGroups.push(...r.value);
  }

  return {
    count: allGroups.length,
    accounts_queried: targets.length,
    security_groups: allGroups.slice(0, limit),
  };
}

function formatRule(perm: any) {
  return {
    protocol: perm.IpProtocol === "-1" ? "all" : perm.IpProtocol,
    from_port: perm.FromPort,
    to_port: perm.ToPort,
    ipv4_ranges: (perm.IpRanges || []).map((r: any) => ({
      cidr: r.CidrIp,
      description: r.Description,
    })),
    ipv6_ranges: (perm.Ipv6Ranges || []).map((r: any) => ({
      cidr: r.CidrIpv6,
      description: r.Description,
    })),
    source_groups: (perm.UserIdGroupPairs || []).map((g: any) => ({
      group_id: g.GroupId,
      description: g.Description,
    })),
  };
}
