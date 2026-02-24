// Windmill Script: Entity Extraction & Enrichment
// Phase 6 Gap #2: Auto-map incoming data to known infrastructure entities
//
// Extracts entity references (IPs, instance IDs, account IDs, ARNs,
// hostnames, security group IDs) from event payloads and enriches
// with Steampipe lookups.

import { execSync } from "child_process";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();
const ENTITY_LOG = join(HOME, ".claude", "logs", "entity-extractions.jsonl");

interface ExtractedEntity {
  type: string;
  value: string;
  context?: string;
  enrichment?: Record<string, unknown>;
}

// Entity patterns
const PATTERNS: [string, RegExp][] = [
  ["aws_instance", /\bi-[0-9a-f]{8,17}\b/gi],
  ["aws_account", /\b\d{12}\b/g],
  ["aws_arn", /arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[a-zA-Z0-9/._-]+/g],
  ["aws_sg", /\bsg-[0-9a-f]{8,17}\b/gi],
  ["aws_vpc", /\bvpc-[0-9a-f]{8,17}\b/gi],
  ["aws_subnet", /\bsubnet-[0-9a-f]{8,17}\b/gi],
  ["aws_eni", /\beni-[0-9a-f]{8,17}\b/gi],
  ["aws_volume", /\bvol-[0-9a-f]{8,17}\b/gi],
  ["ipv4", /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g],
  ["hostname", /\b[a-z][a-z0-9-]+\.(?:ec2\.internal|amazonaws\.com|compute\.internal)\b/gi],
  ["cve", /CVE-\d{4}-\d{4,}/gi],
];

function extractEntities(text: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();

  for (const [type, pattern] of PATTERNS) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const value = match[0];
      const key = `${type}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Get surrounding context (20 chars each side)
      const start = Math.max(0, (match.index || 0) - 20);
      const end = Math.min(text.length, (match.index || 0) + value.length + 20);
      const context = text.slice(start, end).replace(/\n/g, " ");

      entities.push({ type, value, context });
    }
  }

  return entities;
}

function enrichWithSteampipe(entity: ExtractedEntity): ExtractedEntity {
  // Only enrich AWS entities if steampipe is available
  try {
    execSync("which steampipe", { encoding: "utf-8", timeout: 2000 });
  } catch {
    return entity; // Steampipe not available
  }

  try {
    let query = "";
    switch (entity.type) {
      case "aws_instance":
        query = `select instance_id, instance_type, instance_state as state, private_ip_address, tags ->> 'Name' as name from aws_ec2_instance where instance_id = '${entity.value}'`;
        break;
      case "aws_sg":
        query = `select group_id, group_name, vpc_id, description from aws_vpc_security_group where group_id = '${entity.value}'`;
        break;
      case "aws_vpc":
        query = `select vpc_id, cidr_block, state, tags ->> 'Name' as name from aws_vpc where vpc_id = '${entity.value}'`;
        break;
      default:
        return entity; // No enrichment query for this type
    }

    const result = execSync(
      `steampipe query --output json "${query}"`,
      { encoding: "utf-8", timeout: 10000 },
    );

    const parsed = JSON.parse(result);
    if (parsed.rows && parsed.rows.length > 0) {
      entity.enrichment = parsed.rows[0];
    }
  } catch {
    // Enrichment failed — return entity without enrichment
  }

  return entity;
}

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

  // Extract entities
  let entities = extractEntities(payload);

  // Enrich with infrastructure context
  if (enrich) {
    entities = entities.map(enrichWithSteampipe);
  }

  // Log extraction
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
