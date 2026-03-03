// Windmill Script: Get AWS Resources (Read-Only)
// Investigation tool — queries RDS, Lambda, S3, or ECS resources across accounts.
// Takes a resource_type parameter to select which AWS service to query.

import { RDSClient, DescribeDBInstancesCommand } from "@aws-sdk/client-rds";
import { LambdaClient, ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";
import { ECSClient, ListClustersCommand, DescribeServicesCommand, ListServicesCommand } from "@aws-sdk/client-ecs";
import { getAwsCredentials, AWS_ACCOUNTS, resolveAccounts } from "./aws_helper.ts";

export async function main(
  resource_type: "rds" | "lambda" | "s3" | "ecs",
  account: string = "all",
  name_contains?: string,
  limit: number = 100,
) {
  const targets = resolveAccounts(account);
  const allResources: any[] = [];

  const results = await Promise.allSettled(
    targets.map(async (acct) => {
      const creds = await getAwsCredentials(acct);
      const region = AWS_ACCOUNTS[acct]?.region || "us-east-1";

      switch (resource_type) {
        case "rds": return await queryRds(creds, region, acct, name_contains);
        case "lambda": return await queryLambda(creds, region, acct, name_contains);
        case "s3": return await queryS3(creds, region, acct, name_contains);
        case "ecs": return await queryEcs(creds, region, acct, name_contains);
        default: return [];
      }
    })
  );

  for (const r of results) {
    if (r.status === "fulfilled") allResources.push(...r.value);
  }

  return {
    resource_type,
    count: allResources.length,
    accounts_queried: targets.length,
    resources: allResources.slice(0, limit),
  };
}

async function queryRds(creds: any, region: string, acct: string, nameFilter?: string) {
  const rds = new RDSClient({ region, credentials: creds });
  const resp = await rds.send(new DescribeDBInstancesCommand({}));
  const items: any[] = [];
  for (const db of resp.DBInstances || []) {
    if (nameFilter && !db.DBInstanceIdentifier?.toLowerCase().includes(nameFilter.toLowerCase())) continue;
    items.push({
      account: acct,
      type: "rds",
      identifier: db.DBInstanceIdentifier,
      engine: db.Engine,
      engine_version: db.EngineVersion,
      instance_class: db.DBInstanceClass,
      status: db.DBInstanceStatus,
      storage_gb: db.AllocatedStorage,
      multi_az: db.MultiAZ,
      vpc_id: db.DBSubnetGroup?.VpcId,
      endpoint: db.Endpoint?.Address,
      port: db.Endpoint?.Port,
    });
  }
  return items;
}

async function queryLambda(creds: any, region: string, acct: string, nameFilter?: string) {
  const lambda = new LambdaClient({ region, credentials: creds });
  const resp = await lambda.send(new ListFunctionsCommand({ MaxItems: 200 }));
  const items: any[] = [];
  for (const fn of resp.Functions || []) {
    if (nameFilter && !fn.FunctionName?.toLowerCase().includes(nameFilter.toLowerCase())) continue;
    items.push({
      account: acct,
      type: "lambda",
      function_name: fn.FunctionName,
      runtime: fn.Runtime,
      memory_mb: fn.MemorySize,
      timeout_sec: fn.Timeout,
      handler: fn.Handler,
      last_modified: fn.LastModified,
      code_size_bytes: fn.CodeSize,
      role: fn.Role,
    });
  }
  return items;
}

async function queryS3(creds: any, region: string, acct: string, nameFilter?: string) {
  const s3 = new S3Client({ region, credentials: creds });
  const resp = await s3.send(new ListBucketsCommand({}));
  const items: any[] = [];
  for (const b of resp.Buckets || []) {
    if (nameFilter && !b.Name?.toLowerCase().includes(nameFilter.toLowerCase())) continue;
    items.push({
      account: acct,
      type: "s3",
      bucket_name: b.Name,
      created: b.CreationDate?.toISOString(),
    });
  }
  return items;
}

async function queryEcs(creds: any, region: string, acct: string, nameFilter?: string) {
  const ecs = new ECSClient({ region, credentials: creds });
  const clustersResp = await ecs.send(new ListClustersCommand({}));
  const items: any[] = [];

  for (const clusterArn of clustersResp.clusterArns || []) {
    const clusterName = clusterArn.split("/").pop() || clusterArn;
    if (nameFilter && !clusterName.toLowerCase().includes(nameFilter.toLowerCase())) continue;

    const svcsResp = await ecs.send(new ListServicesCommand({ cluster: clusterArn, maxResults: 50 }));
    items.push({
      account: acct,
      type: "ecs_cluster",
      cluster_name: clusterName,
      cluster_arn: clusterArn,
      service_count: svcsResp.serviceArns?.length || 0,
      services: (svcsResp.serviceArns || []).map(arn => arn.split("/").pop()),
    });
  }
  return items;
}
