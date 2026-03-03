// Windmill Script: Get EC2 Instances (Read-Only)
// Investigation tool — lists EC2 instances across AWS accounts.
// Supports filtering by state, instance ID, name, IP, or VPC.

import { EC2Client, DescribeInstancesCommand, type Filter } from "@aws-sdk/client-ec2";
import { getAwsCredentials, AWS_ACCOUNTS, resolveAccounts } from "./aws_helper.ts";

export async function main(
  account: string = "all",
  state?: "running" | "stopped" | "terminated" | "pending" | "shutting-down",
  instance_id?: string,
  name_contains?: string,
  private_ip?: string,
  vpc_id?: string,
  limit: number = 100,
) {
  const targets = resolveAccounts(account);
  const allInstances: any[] = [];

  const results = await Promise.allSettled(
    targets.map(async (acct) => {
      const creds = await getAwsCredentials(acct);
      const region = AWS_ACCOUNTS[acct]?.region || "us-east-1";
      const ec2 = new EC2Client({ region, credentials: creds });

      const filters: Filter[] = [];
      if (state) filters.push({ Name: "instance-state-name", Values: [state] });
      if (instance_id) filters.push({ Name: "instance-id", Values: [instance_id] });
      if (name_contains) filters.push({ Name: "tag:Name", Values: [`*${name_contains}*`] });
      if (private_ip) filters.push({ Name: "private-ip-address", Values: [private_ip] });
      if (vpc_id) filters.push({ Name: "vpc-id", Values: [vpc_id] });

      const resp = await ec2.send(new DescribeInstancesCommand({
        Filters: filters.length > 0 ? filters : undefined,
        MaxResults: Math.min(limit, 1000),
      }));

      const instances: any[] = [];
      for (const r of resp.Reservations || []) {
        for (const i of r.Instances || []) {
          instances.push({
            account: acct,
            instance_id: i.InstanceId,
            state: i.State?.Name,
            type: i.InstanceType,
            name: i.Tags?.find(t => t.Key === "Name")?.Value || "",
            private_ip: i.PrivateIpAddress,
            public_ip: i.PublicIpAddress,
            vpc_id: i.VpcId,
            subnet_id: i.SubnetId,
            az: i.Placement?.AvailabilityZone,
            launch_time: i.LaunchTime?.toISOString(),
            platform: i.PlatformDetails || i.Platform || "Linux",
            iam_role: i.IamInstanceProfile?.Arn,
          });
        }
      }
      return instances;
    })
  );

  for (const r of results) {
    if (r.status === "fulfilled") allInstances.push(...r.value);
  }

  return {
    count: allInstances.length,
    accounts_queried: targets.length,
    instances: allInstances.slice(0, limit),
  };
}
