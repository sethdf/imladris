// Windmill Script: Discover AWS Resources
// Auto-populates the resource_inventory table by querying Steampipe for all named resources.
// Runs on native worker (needs Steampipe access at 172.17.0.1:9193).
// Schedule: every 6 hours (0 */6 * * *)
//
// Queries are ALL read-only SELECTs. Each resource type is queried independently —
// failures in one type don't block others.

const STEAMPIPE_HOST = process.env.STEAMPIPE_HOST || "172.17.0.1";
const STEAMPIPE_PORT = process.env.STEAMPIPE_PORT || "9193";

async function getVariable(path: string): Promise<string | undefined> {
  const base = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
  const token = process.env.WM_TOKEN;
  const workspace = process.env.WM_WORKSPACE || "imladris";
  if (!token) return undefined;
  try {
    const resp = await fetch(
      `${base}/api/w/${workspace}/variables/get_value/${path}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) return undefined;
    const val = await resp.text();
    const parsed = val.startsWith('"') ? JSON.parse(val) : val;
    return parsed.trim();
  } catch {
    return undefined;
  }
}

interface DiscoveryQuery {
  resource_type: string;
  query: string;
  nameField: string;
  idField: string;
  stateField?: string;
}

const DISCOVERY_QUERIES: DiscoveryQuery[] = [
  {
    resource_type: "ec2_instance",
    query: `SELECT instance_id, tags ->> 'Name' as name, instance_state, region, account_id
            FROM aws_ec2_instance WHERE tags ->> 'Name' IS NOT NULL`,
    nameField: "name",
    idField: "instance_id",
    stateField: "instance_state",
  },
  {
    resource_type: "emr_cluster",
    query: `SELECT id, name, state, region, account_id
            FROM aws_emr_cluster WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "id",
    stateField: "state",
  },
  {
    resource_type: "rds_instance",
    query: `SELECT arn, db_instance_identifier, status, region, account_id
            FROM aws_rds_db_instance WHERE db_instance_identifier IS NOT NULL`,
    nameField: "db_instance_identifier",
    idField: "arn",
    stateField: "status",
  },
  {
    resource_type: "rds_cluster",
    query: `SELECT arn, db_cluster_identifier, status, region, account_id
            FROM aws_rds_db_cluster WHERE db_cluster_identifier IS NOT NULL`,
    nameField: "db_cluster_identifier",
    idField: "arn",
    stateField: "status",
  },
  {
    resource_type: "sqs_queue",
    query: `SELECT queue_url, region, account_id
            FROM aws_sqs_queue`,
    nameField: "_sqs_name",  // extracted from queue_url
    idField: "queue_url",
  },
  {
    resource_type: "sns_topic",
    query: `SELECT topic_arn, region, account_id
            FROM aws_sns_topic`,
    nameField: "_sns_name",  // extracted from topic_arn
    idField: "topic_arn",
  },
  {
    resource_type: "lambda_function",
    query: `SELECT arn, name, state, region, account_id
            FROM aws_lambda_function WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "arn",
    stateField: "state",
  },
  {
    resource_type: "ecs_cluster",
    query: `SELECT cluster_arn, cluster_name, status, region, account_id
            FROM aws_ecs_cluster WHERE cluster_name IS NOT NULL`,
    nameField: "cluster_name",
    idField: "cluster_arn",
    stateField: "status",
  },
  {
    resource_type: "ecs_service",
    query: `SELECT arn, service_name, status, region, account_id
            FROM aws_ecs_service WHERE service_name IS NOT NULL`,
    nameField: "service_name",
    idField: "arn",
    stateField: "status",
  },
  {
    resource_type: "s3_bucket",
    query: `SELECT name, region, account_id
            FROM aws_s3_bucket WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "name",
  },
  {
    resource_type: "cloudwatch_alarm",
    query: `SELECT arn, name, state_value, region, account_id
            FROM aws_cloudwatch_alarm WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "arn",
    stateField: "state_value",
  },
  {
    resource_type: "elb",
    query: `SELECT arn, name, state_code, region, account_id
            FROM aws_ec2_application_load_balancer WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "arn",
    stateField: "state_code",
  },
  // --- Networking & CDN ---
  {
    resource_type: "nlb",
    query: `SELECT arn, name, state_code, region, account_id
            FROM aws_ec2_network_load_balancer WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "arn",
    stateField: "state_code",
  },
  {
    resource_type: "classic_lb",
    query: `SELECT arn, name, region, account_id
            FROM aws_ec2_classic_load_balancer WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "arn",
  },
  {
    resource_type: "target_group",
    query: `SELECT target_group_arn, target_group_name, target_type, region, account_id
            FROM aws_ec2_target_group WHERE target_group_name IS NOT NULL`,
    nameField: "target_group_name",
    idField: "target_group_arn",
  },
  {
    resource_type: "security_group",
    query: `SELECT group_id, group_name, region, account_id
            FROM aws_vpc_security_group WHERE group_name IS NOT NULL AND group_name != 'default'`,
    nameField: "group_name",
    idField: "group_id",
  },
  {
    resource_type: "cloudfront_distribution",
    query: `SELECT arn, domain_name, status, region, account_id
            FROM aws_cloudfront_distribution WHERE domain_name IS NOT NULL`,
    nameField: "domain_name",
    idField: "arn",
    stateField: "status",
  },
  {
    resource_type: "route53_zone",
    query: `SELECT id, name, region, account_id
            FROM aws_route53_zone WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "id",
  },
  {
    resource_type: "vpn_connection",
    query: `SELECT vpn_connection_id, tags ->> 'Name' as name, state, region, account_id
            FROM aws_vpc_vpn_connection WHERE tags ->> 'Name' IS NOT NULL`,
    nameField: "name",
    idField: "vpn_connection_id",
    stateField: "state",
  },
  {
    resource_type: "nat_gateway",
    query: `SELECT nat_gateway_id, tags ->> 'Name' as name, state, region, account_id
            FROM aws_vpc_nat_gateway WHERE tags ->> 'Name' IS NOT NULL`,
    nameField: "name",
    idField: "nat_gateway_id",
    stateField: "state",
  },
  {
    resource_type: "waf_web_acl",
    query: `SELECT arn, name, region, account_id
            FROM aws_wafv2_web_acl WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "arn",
  },
  // --- Data & Analytics ---
  {
    resource_type: "dynamodb_table",
    query: `SELECT arn, name, table_status, region, account_id
            FROM aws_dynamodb_table WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "arn",
    stateField: "table_status",
  },
  {
    resource_type: "redshift_cluster",
    query: `SELECT arn, cluster_identifier, cluster_status, region, account_id
            FROM aws_redshift_cluster WHERE cluster_identifier IS NOT NULL`,
    nameField: "cluster_identifier",
    idField: "arn",
    stateField: "cluster_status",
  },
  {
    resource_type: "opensearch_domain",
    query: `SELECT arn, domain_name, region, account_id
            FROM aws_opensearch_domain WHERE domain_name IS NOT NULL`,
    nameField: "domain_name",
    idField: "arn",
  },
  {
    resource_type: "kinesis_stream",
    query: `SELECT stream_arn, stream_name, stream_status, region, account_id
            FROM aws_kinesis_stream WHERE stream_name IS NOT NULL`,
    nameField: "stream_name",
    idField: "stream_arn",
    stateField: "stream_status",
  },
  {
    resource_type: "glue_job",
    query: `SELECT name, region, account_id
            FROM aws_glue_job WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "name",
  },
  // --- Compute & Containers ---
  {
    resource_type: "eks_cluster",
    query: `SELECT arn, name, status, region, account_id
            FROM aws_eks_cluster WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "arn",
    stateField: "status",
  },
  {
    resource_type: "ecr_repository",
    query: `SELECT arn, repository_name, region, account_id
            FROM aws_ecr_repository WHERE repository_name IS NOT NULL`,
    nameField: "repository_name",
    idField: "arn",
  },
  {
    resource_type: "autoscaling_group",
    query: `SELECT autoscaling_group_arn, name, status, region, account_id
            FROM aws_ec2_autoscaling_group WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "autoscaling_group_arn",
    stateField: "status",
  },
  // --- Integration & Orchestration ---
  {
    resource_type: "api_gateway",
    query: `SELECT api_id, name, region, account_id
            FROM aws_api_gateway_rest_api WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "api_id",
  },
  {
    resource_type: "apigatewayv2",
    query: `SELECT api_id, name, protocol_type, region, account_id
            FROM aws_api_gatewayv2_api WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "api_id",
  },
  {
    resource_type: "stepfunction",
    query: `SELECT arn, name, status, region, account_id
            FROM aws_sfn_state_machine WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "arn",
    stateField: "status",
  },
  {
    resource_type: "eventbridge_rule",
    query: `SELECT arn, name, state, region, account_id
            FROM aws_cloudwatch_event_rule WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "arn",
    stateField: "state",
  },
  // --- Storage & Backup ---
  {
    resource_type: "efs_file_system",
    query: `SELECT file_system_id, tags ->> 'Name' as name, life_cycle_state, region, account_id
            FROM aws_efs_file_system WHERE tags ->> 'Name' IS NOT NULL`,
    nameField: "name",
    idField: "file_system_id",
    stateField: "life_cycle_state",
  },
  {
    resource_type: "backup_vault",
    query: `SELECT arn, name, region, account_id
            FROM aws_backup_vault WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "arn",
  },
  // --- Security & Config ---
  {
    resource_type: "secretsmanager_secret",
    query: `SELECT arn, name, region, account_id
            FROM aws_secretsmanager_secret WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "arn",
  },
  {
    resource_type: "kms_key",
    query: `SELECT arn, title, key_state, region, account_id
            FROM aws_kms_key WHERE title IS NOT NULL AND key_manager = 'CUSTOMER'`,
    nameField: "title",
    idField: "arn",
    stateField: "key_state",
  },
  {
    resource_type: "ssm_parameter",
    query: `SELECT name, region, account_id
            FROM aws_ssm_parameter WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "name",
  },
  // --- Identity ---
  {
    resource_type: "directory_service",
    query: `SELECT directory_id, name, stage, region, account_id
            FROM aws_directory_service_directory WHERE name IS NOT NULL`,
    nameField: "name",
    idField: "directory_id",
    stateField: "stage",
  },
];

function extractNameFromUrl(url: string, type: string): string {
  if (type === "sqs_queue") {
    // SQS URL: https://sqs.region.amazonaws.com/account/queue-name
    const parts = url.split("/");
    return parts[parts.length - 1] || url;
  }
  if (type === "sns_topic") {
    // SNS ARN: arn:aws:sns:region:account:topic-name
    const parts = url.split(":");
    return parts[parts.length - 1] || url;
  }
  return url;
}

export async function main(
  stale_after_hours: number = 48,
  resource_types: string = "",
) {
  const startTime = Date.now();
  const errors: string[] = [];
  const byType: Record<string, number> = {};
  let totalDiscovered = 0;
  let accountId = "";

  // Get Steampipe password
  const password = await getVariable("f/devops/steampipe_password");
  if (!password) {
    return { error: "f/devops/steampipe_password not configured in Windmill variables" };
  }

  // Import cache functions
  const { upsertResource, markStaleResources, resourceInventoryStats, init } = await import("./cache_lib.ts");
  init();

  // Filter resource types if specified
  const typeFilter = resource_types
    ? new Set(resource_types.split(",").map(t => t.trim()))
    : null;

  const queries = typeFilter
    ? DISCOVERY_QUERIES.filter(q => typeFilter.has(q.resource_type))
    : DISCOVERY_QUERIES;

  // Connect to Steampipe via pg
  const { Client } = await import("pg") as any;

  for (const dq of queries) {
    try {
      const client = new Client({
        host: STEAMPIPE_HOST,
        port: parseInt(STEAMPIPE_PORT),
        database: "steampipe",
        user: "steampipe",
        password,
        connectionTimeoutMillis: 5000,
        query_timeout: 30000,
      });
      await client.connect();
      const result = await client.query(dq.query);
      await client.end();

      const rows = result.rows || [];
      let typeCount = 0;

      for (const row of rows) {
        // Extract name — handle special cases for SQS/SNS
        let name: string;
        if (dq.nameField === "_sqs_name") {
          name = extractNameFromUrl(row.queue_url || "", "sqs_queue");
        } else if (dq.nameField === "_sns_name") {
          name = extractNameFromUrl(row.topic_arn || "", "sns_topic");
        } else {
          name = row[dq.nameField];
        }

        if (!name) continue;

        const resourceId = row[dq.idField];
        if (!resourceId) continue;

        const rowAccountId = row.account_id || "";
        if (rowAccountId && !accountId) accountId = rowAccountId;

        upsertResource({
          resource_id: resourceId,
          resource_name: name,
          resource_type: dq.resource_type,
          cloud: "aws",
          account_id: rowAccountId,
          region: row.region || "",
          state: dq.stateField ? (row[dq.stateField] || "") : "",
        });

        typeCount++;
      }

      if (typeCount > 0) {
        byType[dq.resource_type] = typeCount;
        totalDiscovered += typeCount;
      }
    } catch (err: any) {
      errors.push(`${dq.resource_type}: ${err.message?.slice(0, 200)}`);
    }
  }

  // Mark stale resources
  const staleSeconds = stale_after_hours * 3600;
  const staleMarked = markStaleResources(staleSeconds);

  const durationS = Math.round((Date.now() - startTime) / 1000);

  return {
    account_id: accountId,
    resources_discovered: totalDiscovered,
    by_type: byType,
    stale_marked: staleMarked,
    errors,
    duration_s: durationS,
    inventory_stats: resourceInventoryStats(),
  };
}
