// Windmill Script: Entity Extraction & Enrichment
// Canonical source for all entity regex patterns and extraction logic.
// ALL triage pipeline files import from here — no inline pattern copies.
//
// Also serves as a standalone Windmill script for manual entity extraction
// with optional Steampipe enrichment.

import { execSync } from "child_process";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();
const ENTITY_LOG = join(HOME, ".claude", "logs", "entity-extractions.jsonl");

// ── Shared types ──

export interface Entity {
  type: string;
  value: string;
  context?: string;
  enrichment?: Record<string, unknown>;
}

// ── Canonical entity patterns ──
// This is the SINGLE source of truth. All consumers import this array.
// Type names: lowercase, underscored, descriptive (ec2_instance not "instance").

export const ENTITY_PATTERNS: Array<{ type: string; regex: RegExp }> = [
  // AWS resource IDs
  { type: "ec2_instance", regex: /\bi-[0-9a-f]{8,17}\b/gi },
  { type: "security_group", regex: /\bsg-[0-9a-f]{8,17}\b/gi },
  { type: "subnet", regex: /\bsubnet-[0-9a-f]{8,17}\b/gi },
  { type: "vpc", regex: /\bvpc-[0-9a-f]{8,17}\b/gi },
  { type: "ami", regex: /\bami-[0-9a-f]{8,17}\b/gi },
  { type: "volume", regex: /\bvol-[0-9a-f]{8,17}\b/gi },
  { type: "eni", regex: /\beni-[0-9a-f]{8,17}\b/gi },
  { type: "arn", regex: /\barn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[a-zA-Z0-9/:._-]+\b/g },
  // AWS service name mentions
  { type: "aws_service", regex: /\b(?:sqs|sns|ec2|rds|lambda|ecs|eks|emr|s3|elb|alb|nlb|cloudfront|cloudwatch|dynamodb|redshift|elasticache|kinesis|glue|athena|route53|cloudformation|codepipeline|codebuild|codecommit|codedeploy|stepfunctions|eventbridge|api[- ]?gateway|waf|guardduty|inspector|macie|securityhub|config|ssm|secrets[- ]?manager|kms|acm|iam|sts|organizations|control[- ]?tower|auto[- ]?scaling|ebs)\b/gi },
  // CloudWatch alarm names (in quotes after ALARM:)
  { type: "cloudwatch_alarm", regex: /ALARM:\s*"([^"]+)"/gi },
  // AWS region references
  { type: "aws_region", regex: /\b(?:us-east-[12]|us-west-[12]|eu-west-[123]|eu-central-1|eu-north-1|ap-southeast-[12]|ap-northeast-[123]|ap-south-1|sa-east-1|ca-central-1|me-south-1|af-south-1)\b/gi },
  { type: "aws_region", regex: /\b(?:US East \((?:N\. Virginia|Ohio)\)|US West \((?:Oregon|N\. California)\)|EU \((?:Ireland|Frankfurt|London|Paris|Stockholm)\)|Asia Pacific \((?:Tokyo|Seoul|Singapore|Sydney|Mumbai)\))\b/gi },
  // GCP service name mentions
  { type: "gcp_service", regex: /\b(?:gke|gce|gcs|bigquery|cloud[- ]?run|cloud[- ]?functions|cloud[- ]?sql|pub[/ ]?sub|dataflow|dataproc|spanner|firestore|memorystore|cloud[- ]?cdn|cloud[- ]?armor|cloud[- ]?dns|compute[- ]?engine|app[- ]?engine|cloud[- ]?storage)\b/gi },
  // Network/infra
  { type: "ip_address", regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g },
  { type: "hostname", regex: /\b[A-Za-z][A-Za-z0-9-]+(?:\.[a-z]{2,})+\b/g },
  // Other
  { type: "cve", regex: /\bCVE-\d{4}-\d{4,}\b/gi },
  { type: "ticket_id", regex: /\b(?:ticket|request|SR)[- #]?(\d{4,})\b/gi },
  { type: "s3_bucket", regex: /\bs3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\b/gi },
  { type: "email", regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g },
  // Person names in structured ticket contexts
  { type: "username", regex: /(?:(?:Requester|Requested by|Created by|Assigned to|Technician|Tech|Reported by|From|Sender|User|Employee|New Hire|Departing)[: ]+)([A-Z][a-z]+ [A-Z][a-z]+(?:-[A-Z][a-z]+)?)/gm },
];

// ── Canonical extraction function ──
// Uses exec() loop to support capture groups (e.g., cloudwatch_alarm, ticket_id, username).

export function extractEntities(text: string): Entity[] {
  const results: Entity[] = [];
  const seen = new Set<string>();
  for (const { type, regex } of ENTITY_PATTERNS) {
    const re = new RegExp(regex.source, regex.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const value = match[1] || match[0];
      const key = `${type}:${value.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ value, type });
      }
    }
  }
  return results;
}

// ── Steampipe enrichment (standalone script only) ──

function enrichWithSteampipe(entity: Entity): Entity {
  try {
    execSync("which steampipe", { encoding: "utf-8", timeout: 2000 });
  } catch {
    return entity;
  }

  try {
    let query = "";
    switch (entity.type) {
      case "ec2_instance":
        query = `select instance_id, instance_type, instance_state as state, private_ip_address, tags ->> 'Name' as name from aws_ec2_instance where instance_id = '${entity.value}'`;
        break;
      case "security_group":
        query = `select group_id, group_name, vpc_id, description from aws_vpc_security_group where group_id = '${entity.value}'`;
        break;
      case "vpc":
        query = `select vpc_id, cidr_block, state, tags ->> 'Name' as name from aws_vpc where vpc_id = '${entity.value}'`;
        break;
      default:
        return entity;
    }

    const result = execSync(
      `steampipe query --output json "${query}"`,
      { encoding: "utf-8", timeout: 10000 },
    );

    const parsed = JSON.parse(result);
    if (parsed.rows && parsed.rows.length > 0) {
      entity.enrichment = parsed.rows[0];
    }
  } catch { /* enrichment failed — non-fatal */ }

  return entity;
}

// ── Windmill main (standalone invocation) ──

function ensureDirs(): void {
  const logDir = join(HOME, ".claude", "logs");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
}

export async function main(
  payload: string,
  source: string = "unknown",
  enrich: boolean = true,
) {
  if (!payload) {
    return { error: "payload is required" };
  }

  ensureDirs();

  let entities = extractEntities(payload);

  if (enrich) {
    entities = entities.map(enrichWithSteampipe);
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    source,
    entity_count: entities.length,
    entities: entities.map((e) => ({
      type: e.type,
      value: e.value,
      enriched: !!e.enrichment,
    })),
  };

  appendFileSync(ENTITY_LOG, JSON.stringify(logEntry) + "\n");

  return {
    source,
    entity_count: entities.length,
    entities,
    types_found: [...new Set(entities.map((e) => e.type))],
  };
}
