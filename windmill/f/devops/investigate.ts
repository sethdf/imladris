// Windmill Script: Investigate Triaged Item
// Evidence-based diagnostic engine using Steampipe (read-only) + cross-source correlation.
//
// RULES:
//   1. Every conclusion MUST cite a specific probe result
//   2. "Unknown" is always valid — never fabricate a diagnosis
//   3. ALL operations are READ-ONLY — no modifications to any resource
//   4. Inaccessible resources are tagged NEEDS-CREDENTIAL, not skipped
//
// Requires:
//   Steampipe service running on host (port 9193, postgres protocol)
//   Windmill variables: f/devops/steampipe_password
//   AWS credentials configured in Steampipe (~/.steampipe/config/aws.spc)
//   claude CLI available (run on native worker, not Docker worker)
//   AI synthesis uses `claude -p` pipe mode — requires Max or API subscription

import { execSync } from "child_process";

// ── Windmill variable access ──

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

// ── Entity Extraction ──

interface Entity {
  value: string;
  type: string;
}

const ENTITY_PATTERNS: Array<{ type: string; regex: RegExp }> = [
  { type: "ec2_instance", regex: /\bi-[0-9a-f]{8,17}\b/gi },
  { type: "security_group", regex: /\bsg-[0-9a-f]{8,17}\b/gi },
  { type: "subnet", regex: /\bsubnet-[0-9a-f]{8,17}\b/gi },
  { type: "vpc", regex: /\bvpc-[0-9a-f]{8,17}\b/gi },
  { type: "ami", regex: /\bami-[0-9a-f]{8,17}\b/gi },
  { type: "volume", regex: /\bvol-[0-9a-f]{8,17}\b/gi },
  { type: "arn", regex: /\barn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[a-zA-Z0-9/:._-]+\b/g },
  { type: "ip_address", regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g },
  { type: "cve", regex: /\bCVE-\d{4}-\d{4,}\b/gi },
  { type: "hostname", regex: /\b[A-Za-z][A-Za-z0-9-]+(?:\.[a-z]{2,})+\b/g },
  { type: "ticket_id", regex: /\b(?:ticket|request|SR)[- #]?(\d{4,})\b/gi },
  { type: "s3_bucket", regex: /\bs3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\b/gi },
  { type: "email", regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g },
];

function extractEntities(text: string): Entity[] {
  const results: Entity[] = [];
  const seen = new Set<string>();
  for (const { type, regex } of ENTITY_PATTERNS) {
    const matches = text.match(regex) || [];
    for (const m of matches) {
      const key = `${type}:${m.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ value: m, type });
      }
    }
  }
  return results;
}

// ── Steampipe Query Engine ──

interface ProbeResult {
  source: string;
  query: string;
  entity: string;
  entity_type: string;
  success: boolean;
  data: any;
  error?: string;
}

async function steampipeQuery(
  query: string,
  spHost: string,
  spPassword: string,
): Promise<{ success: boolean; data: any; error?: string }> {
  try {
    // Use Bun's postgres via fetch to Steampipe's postgres-compatible endpoint
    // Steampipe exposes a postgres wire protocol — use the pg npm package
    const connStr = `postgres://steampipe:${spPassword}@${spHost}:9193/steampipe`;

    // Shell out to steampipe query via the service connection
    // Using a lightweight approach: connect via the steampipe service's postgres port
    const result = execSync(
      `PGPASSWORD='${spPassword}' psql -h ${spHost} -p 9193 -U steampipe -d steampipe -t -A -F '|' -c ${JSON.stringify(query)} 2>&1`,
      { encoding: "utf-8", timeout: 30000 },
    ).trim();

    if (!result || result.includes("ERROR")) {
      return { success: false, data: null, error: result.slice(0, 500) };
    }

    // Parse psql tabular output into objects
    const lines = result.split("\n").filter(l => l.trim());
    return { success: true, data: lines };
  } catch (err: any) {
    return { success: false, data: null, error: err.message?.slice(0, 500) };
  }
}

// Query steampipe via postgres wire protocol (accessible from Docker via 172.17.0.1:9193)
// Uses Bun's built-in postgres support or falls back to psql CLI
const STEAMPIPE_HOST = process.env.STEAMPIPE_HOST || "172.17.0.1";
const STEAMPIPE_PORT = process.env.STEAMPIPE_PORT || "9193";
let _steampipePassword: string | null = null;

async function getSteampipePassword(): Promise<string> {
  if (_steampipePassword) return _steampipePassword;
  const fromVar = await getVariable("f/devops/steampipe_password");
  if (fromVar) { _steampipePassword = fromVar; return fromVar; }
  throw new Error("f/devops/steampipe_password not configured in Windmill variables");
}

async function steampipeQueryJson(
  query: string,
): Promise<{ success: boolean; data: any; error?: string }> {
  try {
    const password = await getSteampipePassword();
    // Use fetch to a lightweight query proxy, or direct pg connection
    // Bun supports postgres natively via bun:sql or pg package
    const { Client } = await import("pg") as any;
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
    const result = await client.query(query);
    await client.end();
    return { success: true, data: result.rows || [] };
  } catch (err: any) {
    return { success: false, data: null, error: err.message?.slice(0, 500) };
  }
}

// ── Investigation Query Library ──

interface QueryTemplate {
  entity_type: string;
  name: string;
  query: (entity: string) => string;
  requires: string; // steampipe plugin required
}

const QUERY_LIBRARY: QueryTemplate[] = [
  // AWS EC2 Instance
  {
    entity_type: "ec2_instance",
    name: "instance_status",
    requires: "aws",
    query: (id) => `SELECT instance_id, instance_state, instance_type,
      launch_time, public_ip_address, private_ip_address,
      vpc_id, subnet_id, tags ->> 'Name' as name,
      monitoring_state, state_transition_reason
      FROM aws_ec2_instance WHERE instance_id = '${id}'`,
  },
  {
    entity_type: "ec2_instance",
    name: "instance_status_checks",
    requires: "aws",
    query: (id) => `SELECT instance_id, system_status, instance_status
      FROM aws_ec2_instance_availability WHERE instance_id = '${id}'`,
  },
  {
    entity_type: "ec2_instance",
    name: "cloudwatch_alarms",
    requires: "aws",
    query: (id) => `SELECT name, state_value, state_reason,
      state_updated_timestamp, metric_name, namespace
      FROM aws_cloudwatch_alarm
      WHERE dimensions::text LIKE '%${id}%'
      ORDER BY state_updated_timestamp DESC LIMIT 10`,
  },
  {
    entity_type: "ec2_instance",
    name: "security_groups",
    requires: "aws",
    query: (id) => `SELECT sg.group_id, sg.group_name, sg.description
      FROM aws_ec2_instance i, jsonb_array_elements(i.security_groups) sge
      JOIN aws_vpc_security_group sg ON sg.group_id = sge ->> 'GroupId'
      WHERE i.instance_id = '${id}'`,
  },
  {
    entity_type: "ec2_instance",
    name: "related_instances_by_name",
    requires: "aws",
    query: (id) => `SELECT i2.instance_id, i2.tags ->> 'Name' as name,
      i2.instance_state, i2.instance_type
      FROM aws_ec2_instance i1
      JOIN aws_ec2_instance i2 ON
        split_part(i2.tags ->> 'Name', '-', 1) = split_part(i1.tags ->> 'Name', '-', 1)
      WHERE i1.instance_id = '${id}' AND i2.instance_id != '${id}'
      LIMIT 20`,
  },
  // Security Group
  {
    entity_type: "security_group",
    name: "sg_rules",
    requires: "aws",
    query: (id) => `SELECT group_id, type, ip_protocol, from_port, to_port,
      cidr_ipv4, cidr_ipv6, referenced_group_id
      FROM aws_vpc_security_group_rule WHERE group_id = '${id}'`,
  },
  // IP Address — check if it's an AWS resource
  {
    entity_type: "ip_address",
    name: "ip_to_instance",
    requires: "aws",
    query: (ip) => `SELECT instance_id, tags ->> 'Name' as name,
      instance_state, public_ip_address, private_ip_address
      FROM aws_ec2_instance
      WHERE public_ip_address = '${ip}' OR private_ip_address = '${ip}'`,
  },
  {
    entity_type: "ip_address",
    name: "ip_to_eni",
    requires: "aws",
    query: (ip) => `SELECT network_interface_id, description, status,
      private_ip_address, association_public_ip
      FROM aws_ec2_network_interface
      WHERE private_ip_address = '${ip}'
        OR association_public_ip = '${ip}'`,
  },
  // VPC
  {
    entity_type: "vpc",
    name: "vpc_details",
    requires: "aws",
    query: (id) => `SELECT vpc_id, state, cidr_block,
      tags ->> 'Name' as name, is_default
      FROM aws_vpc WHERE vpc_id = '${id}'`,
  },
  // Subnet
  {
    entity_type: "subnet",
    name: "subnet_details",
    requires: "aws",
    query: (id) => `SELECT subnet_id, vpc_id, cidr_block,
      availability_zone, available_ip_address_count,
      tags ->> 'Name' as name
      FROM aws_vpc_subnet WHERE subnet_id = '${id}'`,
  },
];

// Map of which Steampipe plugins we have installed
const INSTALLED_PLUGINS = new Set(["aws"]);

// Entity types that need plugins we don't have yet
const PLUGIN_REQUIREMENTS: Record<string, { plugin: string; description: string }> = {
  email: { plugin: "microsoft365", description: "M365 plugin for user/mail investigation" },
  hostname: { plugin: "net", description: "Net plugin for DNS/connectivity probes" },
  cve: { plugin: "cve", description: "CVE plugin for vulnerability details" },
};

// ── Core Investigation Engine ──

async function runProbes(
  entities: Entity[],
): Promise<{ probes: ProbeResult[]; needs_credential: any[] }> {
  const probes: ProbeResult[] = [];
  const needsCredential: any[] = [];
  const queriedEntities = new Set<string>();

  for (const entity of entities) {
    const key = `${entity.type}:${entity.value}`;
    if (queriedEntities.has(key)) continue;
    queriedEntities.add(key);

    // Find applicable queries
    const templates = QUERY_LIBRARY.filter(q => q.entity_type === entity.type);

    if (templates.length === 0) {
      // Check if this entity type needs a plugin we don't have
      const req = PLUGIN_REQUIREMENTS[entity.type];
      if (req) {
        needsCredential.push({
          entity: entity.value,
          entity_type: entity.type,
          needed: req.plugin,
          description: req.description,
          action: `Install steampipe plugin: steampipe plugin install ${req.plugin}`,
        });
      }
      continue;
    }

    // Run each query template
    for (const template of templates) {
      if (!INSTALLED_PLUGINS.has(template.requires)) {
        needsCredential.push({
          entity: entity.value,
          entity_type: entity.type,
          needed: `${template.requires} plugin`,
          description: `Required for ${template.name} query`,
          action: `steampipe plugin install ${template.requires}`,
        });
        continue;
      }

      const sql = template.query(entity.value);
      const result = await steampipeQueryJson(sql);

      probes.push({
        source: `steampipe/${template.requires}`,
        query: template.name,
        entity: entity.value,
        entity_type: entity.type,
        success: result.success,
        data: result.data,
        error: result.error,
      });
    }
  }

  return { probes, needs_credential: needsCredential };
}

// ── Cross-Source Correlation ──

async function getRelatedItems(entities: Entity[]): Promise<any[]> {
  try {
    const { search, queryEntity, isAvailable, init } = await import("./cache_lib.ts");
    if (!isAvailable()) return [];
    init();

    const related: any[] = [];
    const seen = new Set<string>();

    for (const entity of entities.slice(0, 5)) {
      const items = queryEntity(entity.value, 5);
      for (const item of items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          related.push({
            source: item.source,
            type: item.type,
            title: item.title,
            cached_at: item.cached_at,
          });
        }
      }
    }

    return related;
  } catch {
    return [];
  }
}

// ── AI Synthesis ──

async function synthesize(
  content: string,
  entities: Entity[],
  probes: ProbeResult[],
  relatedItems: any[],
  needsCredential: any[],
): Promise<any> {
  // Build evidence summary for AI
  const successfulProbes = probes.filter(p => p.success && p.data);
  const failedProbes = probes.filter(p => !p.success);

  const evidenceSummary = successfulProbes.map(p =>
    `[${p.source}/${p.query}] Entity: ${p.entity}\nResult: ${JSON.stringify(p.data).slice(0, 1000)}`
  ).join("\n\n");

  const failedSummary = failedProbes.map(p =>
    `[${p.source}/${p.query}] Entity: ${p.entity} — FAILED: ${p.error}`
  ).join("\n");

  const relatedSummary = relatedItems.map(r =>
    `[${r.source}/${r.type}] ${r.title}`
  ).join("\n");

  const credentialGaps = needsCredential.map(c =>
    `${c.entity_type}: ${c.entity} — needs ${c.needed} (${c.description})`
  ).join("\n");

  const prompt = `You are a senior infrastructure diagnostic analyst. Analyze this alert/item using ONLY the evidence provided.

ORIGINAL CONTENT:
${content.slice(0, 3000)}

ENTITIES FOUND:
${entities.map(e => `${e.type}: ${e.value}`).join("\n")}

EVIDENCE FROM PROBES (Steampipe read-only queries):
${evidenceSummary || "No successful probes"}

FAILED PROBES:
${failedSummary || "None"}

RELATED ITEMS FROM OTHER SOURCES:
${relatedSummary || "None found"}

CREDENTIAL GAPS (resources we cannot investigate):
${credentialGaps || "None — all resources accessible"}

RULES — STRICTLY ENFORCED:
1. EVERY conclusion MUST cite a specific probe result by name. Format: [probe_name: finding]
2. If you cannot determine something from the evidence, say "UNKNOWN — insufficient evidence"
3. NEVER guess, assume, or fabricate. "Unknown" is ALWAYS preferred over speculation.
4. Rate your confidence: HIGH (multiple probes confirm), MEDIUM (single probe suggests), LOW (indirect evidence only)
5. For remediation: only propose actions for which we have confirmed resource access
6. If credential gaps exist, note what additional investigation would be possible with access

Respond with ONLY valid JSON:
{
  "root_cause": "evidence-backed diagnosis or UNKNOWN",
  "confidence": "high|medium|low",
  "impact": "who/what is affected, based on evidence",
  "evidence_citations": ["[probe_name: specific finding]", ...],
  "related_pattern": "any pattern across related items (or null)",
  "proposed_fix": {
    "action": "specific remediation or null if unknown",
    "commands": ["exact commands to run"],
    "risk_level": "low|medium|high",
    "requires_access": "what permissions are needed"
  },
  "status": "FIXABLE|NEEDS-ESCALATION|NEEDS-CREDENTIAL|INFO-ONLY",
  "status_reason": "why this status was chosen",
  "credential_gaps": ["what we couldn't investigate and why"]
}`;

  try {
    // Use claude CLI in pipe mode — requires native worker (not Docker container)
    // Writes prompt to temp file to avoid shell escaping issues with large prompts
    const { writeFileSync, unlinkSync } = await import("fs");
    const tmpFile = `/tmp/investigate-prompt-${Date.now()}.txt`;
    writeFileSync(tmpFile, prompt);
    const result = execSync(
      `cat ${tmpFile} | claude -p --output-format json 2>/dev/null`,
      { encoding: "utf-8", timeout: 90000 },
    ).trim();
    try { unlinkSync(tmpFile); } catch { /* cleanup best-effort */ }

    // claude -p --output-format json wraps response in a JSON envelope
    const parsed = JSON.parse(result);
    // Extract the text content — claude returns {result: "...", ...} or raw text
    const text = typeof parsed === "string" ? parsed
      : parsed.result || parsed.content || JSON.stringify(parsed);
    // Parse the inner JSON from the AI response
    const inner = typeof text === "string" ? JSON.parse(text) : text;
    return inner;
  } catch (err: any) {
    return {
      root_cause: "UNKNOWN — AI synthesis failed",
      confidence: "low",
      impact: "Unable to assess",
      evidence_citations: [],
      proposed_fix: null,
      status: "NEEDS-ESCALATION",
      status_reason: `AI synthesis error: ${err.message?.slice(0, 200)}`,
      credential_gaps: needsCredential.map((c: any) => `${c.entity_type}: ${c.entity}`),
    };
  }
}

// ── Main Entry Point ──

export async function main(
  source: string = "m365",
  content: string = "",
  item_id: string = "",
  triage_classification: string = "QUEUE",
) {
  if (!content) {
    return { error: "content is required — provide the alert/email/ticket text to investigate" };
  }

  // Step 1: Extract entities
  const entities = extractEntities(content);

  // Step 2: Run Steampipe probes for all accessible entities
  const { probes, needs_credential } = await runProbes(entities);

  // Step 3: Cross-source correlation from cache
  const relatedItems = await getRelatedItems(entities);

  // Step 4: AI synthesis — evidence-based diagnosis
  const diagnosis = await synthesize(
    content,
    entities,
    probes,
    relatedItems,
    needs_credential,
  );

  // Step 5: Cache the investigation report
  try {
    const { store, isAvailable, init } = await import("./cache_lib.ts");
    if (isAvailable()) {
      init();
      const reportId = item_id || `inv-${Date.now()}`;
      store(
        "triage", "investigation", reportId,
        `Investigation: ${content.slice(0, 100)}`,
        `${diagnosis.root_cause || ""} ${diagnosis.impact || ""} ${entities.map(e => e.value).join(" ")}`,
        { source, content: content.slice(0, 2000), entities, diagnosis, probes: probes.length, needs_credential },
      );
    }
  } catch { /* cache write failed — non-fatal */ }

  return {
    item_id: item_id || `inv-${Date.now()}`,
    source,
    triage_classification,
    entities_found: entities.length,
    entities: entities.slice(0, 20),
    probes_run: probes.length,
    probes_successful: probes.filter(p => p.success).length,
    probes_failed: probes.filter(p => !p.success).length,
    evidence: probes.filter(p => p.success).map(p => ({
      query: p.query,
      entity: p.entity,
      data: p.data,
    })),
    failed_probes: probes.filter(p => !p.success).map(p => ({
      query: p.query,
      entity: p.entity,
      error: p.error?.slice(0, 200),
    })),
    needs_credential,
    related_items: relatedItems,
    diagnosis,
    timestamp: new Date().toISOString(),
  };
}
