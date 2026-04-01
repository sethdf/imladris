// Windmill Script: Get AWS Resources (Read-Only)
// Investigation tool — queries RDS, Lambda, S3, or ECS resources across accounts.
// Migrated from AWS SDK to Steampipe (read-only by enforcement).

import { steampipeQuery, awsSchema } from "./steampipe_helper.ts";

export async function main(
  resource_type: "rds" | "lambda" | "s3" | "ecs",
  account: string = "all",
  name_contains?: string,
  limit: number = 100,
) {
  const schema = awsSchema(account);

  switch (resource_type) {
    case "rds":    return await queryRds(schema, name_contains, limit);
    case "lambda": return await queryLambda(schema, name_contains, limit);
    case "s3":     return await queryS3(schema, name_contains, limit);
    case "ecs":    return await queryEcs(schema, name_contains, limit);
    default:       return { error: `Unknown resource_type: ${resource_type}` };
  }
}

async function queryRds(schema: string, nameFilter?: string, limit: number = 100) {
  const conditions = nameFilter ? [`db_instance_identifier ILIKE $1`] : [];
  const params = nameFilter ? [`%${nameFilter}%`] : [];
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await steampipeQuery(`
    SELECT
      arn,
      db_instance_identifier  AS identifier,
      engine,
      engine_version,
      class                   AS instance_class,
      status,
      allocated_storage       AS storage_gb,
      multi_az,
      vpc_id,
      endpoint_address        AS endpoint,
      endpoint_port           AS port,
      account_id
    FROM ${schema}.aws_rds_db_instance
    ${where}
    LIMIT ${limit}
  `, params.length ? params : undefined);

  return { resource_type: "rds", count: rows.length, account: schema, resources: rows };
}

async function queryLambda(schema: string, nameFilter?: string, limit: number = 100) {
  const conditions = nameFilter ? [`name ILIKE $1`] : [];
  const params = nameFilter ? [`%${nameFilter}%`] : [];
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await steampipeQuery(`
    SELECT
      arn,
      name                    AS function_name,
      runtime,
      memory_size             AS memory_mb,
      timeout                 AS timeout_sec,
      handler,
      last_modified,
      code_size               AS code_size_bytes,
      role,
      account_id
    FROM ${schema}.aws_lambda_function
    ${where}
    LIMIT ${limit}
  `, params.length ? params : undefined);

  return { resource_type: "lambda", count: rows.length, account: schema, resources: rows };
}

async function queryS3(schema: string, nameFilter?: string, limit: number = 100) {
  const conditions = nameFilter ? [`name ILIKE $1`] : [];
  const params = nameFilter ? [`%${nameFilter}%`] : [];
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await steampipeQuery(`
    SELECT
      name                    AS bucket_name,
      creation_date           AS created,
      region,
      account_id
    FROM ${schema}.aws_s3_bucket
    ${where}
    LIMIT ${limit}
  `, params.length ? params : undefined);

  return { resource_type: "s3", count: rows.length, account: schema, resources: rows };
}

async function queryEcs(schema: string, nameFilter?: string, limit: number = 100) {
  const conditions = nameFilter ? [`c.cluster_name ILIKE $1`] : [];
  const params = nameFilter ? [`%${nameFilter}%`] : [];
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  // Cluster list with service count via subquery
  const rows = await steampipeQuery(`
    SELECT
      c.cluster_arn,
      c.cluster_name,
      c.status,
      c.account_id,
      (
        SELECT COUNT(*)
        FROM ${schema}.aws_ecs_service s
        WHERE s.cluster_arn = c.cluster_arn
      ) AS service_count,
      ARRAY(
        SELECT s.service_name
        FROM ${schema}.aws_ecs_service s
        WHERE s.cluster_arn = c.cluster_arn
        LIMIT 20
      ) AS services
    FROM ${schema}.aws_ecs_cluster c
    ${where}
    LIMIT ${limit}
  `, params.length ? params : undefined);

  return { resource_type: "ecs", count: rows.length, account: schema, resources: rows };
}
