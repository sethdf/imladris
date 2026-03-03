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
//   AWS Bedrock access (us-east-1) for AI synthesis and entity extraction
//   Run on native worker (not Docker) for Steampipe access

import { execSync } from "child_process";
import { bedrockInvoke, MODELS } from "./bedrock.ts";
import { extractEntities, ENTITY_PATTERNS, type Entity } from "./entity_extract.ts";

// ── Windmill variable access ──

async function getVariable(path: string): Promise<string | undefined> {
  // Try Windmill internal API first (when running inside Windmill worker)
  const base = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
  const token = process.env.WM_TOKEN;
  const workspace = process.env.WM_WORKSPACE || "imladris";
  if (token) {
    try {
      const resp = await fetch(
        `${base}/api/w/${workspace}/variables/get_value/${path}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (resp.ok) {
        const val = await resp.text();
        const parsed = val.startsWith('"') ? JSON.parse(val) : val;
        return parsed.trim();
      }
    } catch { /* fall through to CLI */ }
  }
  // Fallback: CLI (when running from terminal / batch scripts)
  try {
    const raw = execSync(`wmill variable get ${path} 2>/dev/null`, { encoding: "utf-8", timeout: 10000 });
    const match = raw.match(/Value:\s*([\s\S]*?)(?:\n|$)/);
    if (match) return match[1].replace(/\x1b\[[0-9;]*m/g, "").trim();
  } catch { /* ignore */ }
  return undefined;
}

// ── Entity Extraction (imported from entity_extract.ts) ──

// ── Entity filtering — remove noise before spending probe/synthesis calls ──

const NOREPLY_DOMAINS = new Set([
  "noreply", "no-reply", "mailer-daemon", "postmaster", "donotreply",
  "notifications", "notification", "alert", "alerts", "bounce",
]);

const EXTERNAL_HOSTNAME_SUFFIXES = [
  ".google.com", ".microsoft.com", ".office.com", ".office365.com",
  ".amazonaws.com", ".azure.com", ".site24x7.com", ".manageengine.com",
  ".zoho.com", ".github.com", ".cloudflare.com", ".okta.com",
  ".pagerduty.com", ".opsgenie.com", ".slack.com", ".teams.ms",
];

function isPrivateIp(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 127) return true;
  return false;
}

function isNoreplyEmail(email: string): boolean {
  const local = email.split("@")[0].toLowerCase();
  return NOREPLY_DOMAINS.has(local) || local.startsWith("noreply") || local.startsWith("no-reply");
}

function isExternalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return EXTERNAL_HOSTNAME_SUFFIXES.some(suffix => lower.endsWith(suffix));
}

function filterEntities(entities: Entity[]): { filtered: Entity[]; dropped: string[] } {
  const filtered: Entity[] = [];
  const dropped: string[] = [];

  for (const entity of entities) {
    // Skip private IPs — they don't resolve in Steampipe
    if (entity.type === "ip_address" && isPrivateIp(entity.value)) {
      dropped.push(`${entity.type}:${entity.value} (private IP)`);
      continue;
    }
    // Skip noreply emails — not investigable
    if (entity.type === "email" && isNoreplyEmail(entity.value)) {
      dropped.push(`${entity.type}:${entity.value} (noreply)`);
      continue;
    }
    // Skip external service hostnames — not our infrastructure
    if (entity.type === "hostname" && isExternalHostname(entity.value)) {
      dropped.push(`${entity.type}:${entity.value} (external service)`);
      continue;
    }
    // Skip aws_region and aws_service — informational context, not directly probeable entities
    if (entity.type === "aws_region" || entity.type === "aws_service") {
      // Keep these — they inform probes but don't generate wasteful queries on their own
      filtered.push(entity);
      continue;
    }
    filtered.push(entity);
  }

  return { filtered, dropped };
}



// ── Input validation ──

function validateInput(content: string): { valid: boolean; reason?: string } {
  if (!content || content.trim().length < 20) {
    return { valid: false, reason: "Content too short (< 20 chars)" };
  }
  // Check for pure boilerplate — if the content is just email headers/footers with no substance
  const stripped = content
    .replace(/^(from|to|cc|bcc|date|subject|sent|received|reply-to):.*$/gmi, "")
    .replace(/[-=_]{3,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length < 15) {
    return { valid: false, reason: "Content is only email headers/boilerplate (< 15 chars after stripping)" };
  }
  return { valid: true };
}

// ── Synthesis output validation ──

const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
const VALID_STATUS = new Set(["FIXABLE", "NEEDS-ESCALATION", "NEEDS-CREDENTIAL", "NEEDS-INFO", "INFO-ONLY"]);

function validateDiagnosis(diagnosis: any): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!diagnosis || typeof diagnosis !== "object") {
    return { valid: false, issues: ["diagnosis is not an object"] };
  }
  if (!diagnosis.root_cause || typeof diagnosis.root_cause !== "string") {
    issues.push("missing or invalid root_cause");
  }
  if (!VALID_CONFIDENCE.has(diagnosis.confidence)) {
    issues.push(`invalid confidence: "${diagnosis.confidence}" (expected: high|medium|low)`);
  }
  if (!VALID_STATUS.has(diagnosis.status)) {
    issues.push(`invalid status: "${diagnosis.status}" (expected: FIXABLE|NEEDS-ESCALATION|NEEDS-CREDENTIAL|INFO-ONLY)`);
  }
  if (!Array.isArray(diagnosis.evidence_citations)) {
    issues.push("evidence_citations is not an array");
  }
  return { valid: issues.length === 0, issues };
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
    query: (id) => `SELECT instance_id,
      instance_status -> 'InstanceStatus' ->> 'Status' as instance_check,
      instance_status -> 'SystemStatus' ->> 'Status' as system_check,
      instance_status -> 'AvailabilityZone' as az
      FROM aws_ec2_instance WHERE instance_id = '${id}'`,
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
  // CloudWatch Alarm (by name)
  {
    entity_type: "cloudwatch_alarm",
    name: "alarm_details",
    requires: "aws",
    query: (name) => `SELECT name, state_value, state_reason,
      state_updated_timestamp, metric_name, namespace,
      dimensions, comparison_operator, threshold, period,
      evaluation_periods, statistic
      FROM aws_cloudwatch_alarm
      WHERE name LIKE '%${name.replace(/'/g, "''")}%'
      ORDER BY state_updated_timestamp DESC LIMIT 10`,
  },
  // AWS Service — search alarms and resources related to a service
  {
    entity_type: "aws_service",
    name: "service_alarms",
    requires: "aws",
    query: (svc) => `SELECT name, state_value, state_reason,
      state_updated_timestamp, metric_name, namespace
      FROM aws_cloudwatch_alarm
      WHERE LOWER(namespace) LIKE '%${svc.toLowerCase().replace(/'/g, "''")}%'
        OR LOWER(name) LIKE '%${svc.toLowerCase().replace(/'/g, "''")}%'
      ORDER BY state_updated_timestamp DESC LIMIT 15`,
  },
  // AWS Region — recent alarms in a region
  {
    entity_type: "aws_region",
    name: "region_alarms",
    requires: "aws",
    query: (region) => {
      // Map friendly names to API region codes
      const friendlyMap: Record<string, string> = {
        "us east (n. virginia)": "us-east-1", "us east (ohio)": "us-east-2",
        "us west (oregon)": "us-west-2", "us west (n. california)": "us-west-1",
        "eu (ireland)": "eu-west-1", "eu (frankfurt)": "eu-central-1",
        "eu (london)": "eu-west-2", "eu (paris)": "eu-west-3",
        "eu (stockholm)": "eu-north-1",
        "asia pacific (tokyo)": "ap-northeast-1", "asia pacific (seoul)": "ap-northeast-2",
        "asia pacific (singapore)": "ap-southeast-1", "asia pacific (sydney)": "ap-southeast-2",
        "asia pacific (mumbai)": "ap-south-1",
      };
      const code = friendlyMap[region.toLowerCase()] || region.toLowerCase();
      return `SELECT name, state_value, state_reason,
        state_updated_timestamp, metric_name, namespace
        FROM aws_cloudwatch_alarm
        WHERE region = '${code.replace(/'/g, "''")}'
          AND state_value = 'ALARM'
        ORDER BY state_updated_timestamp DESC LIMIT 10`;
    },
  },

  // ── Azure AD Probes ──

  // Look up user by email in Azure AD
  {
    entity_type: "email",
    name: "azuread_user_lookup",
    requires: "azuread",
    query: (email) => `SELECT display_name, user_principal_name, mail,
      account_enabled, user_type, department, job_title, company_name,
      created_date_time, on_premises_sync_enabled,
      sign_in_activity ->> 'LastSignInDateTime' as last_sign_in,
      sign_in_activity ->> 'LastNonInteractiveSignInDateTime' as last_noninteractive_sign_in
      FROM azuread_user
      WHERE user_principal_name ILIKE '${email.replace(/'/g, "''")}'
        OR mail ILIKE '${email.replace(/'/g, "''")}'
      LIMIT 5`,
  },
  // Check recent sign-in activity for a user
  {
    entity_type: "email",
    name: "azuread_sign_ins",
    requires: "azuread",
    query: (email) => `SELECT created_date_time, app_display_name,
      status ->> 'errorCode' as error_code,
      status ->> 'failureReason' as failure_reason,
      ip_address, location ->> 'city' as city,
      location ->> 'countryOrRegion' as country,
      conditional_access_status, risk_level_during_sign_in, risk_state
      FROM azuread_sign_in_report
      WHERE user_principal_name ILIKE '${email.replace(/'/g, "''")}'
      ORDER BY created_date_time DESC LIMIT 10`,
  },
  // Check directory audit for admin actions related to a user
  {
    entity_type: "email",
    name: "azuread_directory_audit",
    requires: "azuread",
    query: (email) => `SELECT activity_display_name, activity_date_time,
      category, result, result_reason,
      initiated_by::text as initiated_by
      FROM azuread_directory_audit_report
      WHERE target_resources::text ILIKE '%${email.replace(/'/g, "''")}%'
      ORDER BY activity_date_time DESC LIMIT 10`,
  },
  // Look up Azure AD group membership for a user
  {
    entity_type: "email",
    name: "azuread_group_membership",
    requires: "azuread",
    query: (email) => `SELECT g.display_name, g.description, g.mail,
      g.group_types, g.security_enabled
      FROM azuread_user u, jsonb_array_elements(u.member_of) m
      JOIN azuread_group g ON g.id = m ->> 'id'
      WHERE u.user_principal_name ILIKE '${email.replace(/'/g, "''")}'
        OR u.mail ILIKE '${email.replace(/'/g, "''")}'
      LIMIT 20`,
  },

  // ── Microsoft 365 Probes ──

  // Look up M365 user profile
  {
    entity_type: "email",
    name: "m365_user_profile",
    requires: "microsoft365",
    query: (email) => `SELECT display_name, mail, user_type, given_name,
      surname, job_title, department, company_name
      FROM microsoft365_user
      WHERE mail ILIKE '${email.replace(/'/g, "''")}'
        OR user_principal_name ILIKE '${email.replace(/'/g, "''")}'
      LIMIT 5`,
  },

  // ── Net Probes ──

  // DNS resolution for hostnames
  {
    entity_type: "hostname",
    name: "dns_resolution",
    requires: "net",
    query: (host) => `SELECT domain, type, ip, target, ttl
      FROM net_dns_record
      WHERE domain = '${host.replace(/'/g, "''")}'`,
  },
  // TLS certificate check for hostnames
  {
    entity_type: "hostname",
    name: "tls_certificate",
    requires: "net",
    query: (host) => `SELECT common_name, issuer_name,
      not_before, not_after, serial_number,
      dns_names, public_key_algorithm
      FROM net_certificate
      WHERE address = '${host.replace(/'/g, "''")}:443'`,
  },
  // IP reverse DNS
  {
    entity_type: "ip_address",
    name: "reverse_dns",
    requires: "net",
    query: (ip) => `SELECT ip_address, domains
      FROM net_dns_reverse
      WHERE ip_address = '${ip.replace(/'/g, "''")}'`,
  },

  // ── Azure AD User Probes (by display name) ──

  // Look up user by display name in Azure AD / Entra
  {
    entity_type: "username",
    name: "azuread_user_by_name",
    requires: "azuread",
    query: (name) => `SELECT display_name, user_principal_name, mail,
      account_enabled, department, job_title,
      created_date_time,
      sign_in_activity ->> 'LastSignInDateTime' as last_sign_in
      FROM azuread_user
      WHERE display_name ILIKE '${name.replace(/'/g, "''")}'
      LIMIT 5`,
  },
  // Note: sign-in queries by name removed — too slow (JOIN on sign_in_report).
  // Sign-in data is available via the email entity type probes instead.

  // ── Hostname Probes (Azure AD device lookup) ──

  // Look up device by hostname in Azure AD / Entra
  {
    entity_type: "hostname",
    name: "azuread_device_by_name",
    requires: "azuread",
    query: (host) => {
      // Strip domain suffix for device name matching
      const shortName = host.split(".")[0];
      return `SELECT display_name, operating_system, operating_system_version,
        is_compliant, is_managed, trust_type,
        approximate_last_sign_in_date_time as last_sign_in
        FROM azuread_device
        WHERE display_name ILIKE '${shortName.replace(/'/g, "''")}'
        LIMIT 5`;
    },
  },
];

// Map of which Steampipe plugins we have installed
const INSTALLED_PLUGINS = new Set([
  "aws", "azuread", "azuredevops", "cloudflare", "github",
  "microsoft365", "net", "tailscale",
]);

// Entity types that need plugins we don't have yet
// NOTE: slack plugin installed but token missing scopes (search:read, users:read).
// Removed from INSTALLED_PLUGINS until token is reissued at api.slack.com/apps.
// Once fixed, add "slack" back to INSTALLED_PLUGINS above.
const PLUGIN_REQUIREMENTS: Record<string, { plugin: string; description: string }> = {
  cve: { plugin: "cve", description: "CVE plugin for vulnerability details" },
  gcp_service: { plugin: "gcp", description: "GCP plugin for Google Cloud resource investigation" },
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
7. ALWAYS list needed_data_sources — what specific data (logs, metrics, configs) would help diagnose further
8. If the ticket/alert itself lacks key info (who is affected, when it started, what they were doing), set status to NEEDS-INFO and populate user_questions with specific questions to ask the requester
9. Use NEEDS-INFO when: the content is vague, no entities could be extracted, or the diagnosis is UNKNOWN due to missing context rather than missing credentials

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
  "status": "FIXABLE|NEEDS-ESCALATION|NEEDS-CREDENTIAL|NEEDS-INFO|INFO-ONLY",
  "status_reason": "why this status was chosen",
  "credential_gaps": ["what we couldn't investigate and why"],
  "needed_data_sources": ["specific data sources that would enable deeper investigation (e.g., 'CloudWatch logs for i-abc123', 'VPN connection logs for 10.0.1.x subnet')"],
  "user_questions": ["specific questions to ask the ticket requester if info is insufficient (e.g., 'When did the issue first occur?', 'Which application were you using?')"]
}`;

  try {
    const inner = await bedrockInvoke(prompt, {
      model: MODELS.SONNET,
      maxTokens: 1024,
      timeoutMs: 90000,
      parseJson: true,
    });
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

// ── Opus Deep Synthesis (conditional escalation) ──

async function deepSynthesize(
  content: string,
  entities: Entity[],
  probes: ProbeResult[],
  relatedItems: any[],
  needsCredential: any[],
  sonnetDiagnosis: any,
): Promise<any> {
  const successfulProbes = probes.filter(p => p.success && p.data);
  const failedProbes = probes.filter(p => !p.success);

  const evidenceSummary = successfulProbes.map(p =>
    `[${p.source}/${p.query}] Entity: ${p.entity}\nResult: ${JSON.stringify(p.data).slice(0, 1500)}`
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

  const prompt = `You are an elite infrastructure diagnostic analyst performing a DEEP ANALYSIS. A previous analyst (Sonnet) provided an initial diagnosis. Your job is to go deeper — find nuances, connections, and root causes that the initial pass missed.

ORIGINAL CONTENT:
${content.slice(0, 5000)}

ENTITIES FOUND:
${entities.map(e => `${e.type}: ${e.value}`).join("\n")}

EVIDENCE FROM PROBES (Steampipe read-only queries):
${evidenceSummary || "No successful probes"}

FAILED PROBES:
${failedSummary || "None"}

RELATED ITEMS FROM OTHER SOURCES:
${relatedSummary || "None found"}

CREDENTIAL GAPS:
${credentialGaps || "None"}

INITIAL DIAGNOSIS (from Sonnet — use as starting point, improve upon it):
${JSON.stringify(sonnetDiagnosis, null, 2)}

YOUR MISSION — Go beyond the initial diagnosis:
1. Look for PATTERNS across multiple probe results that the initial analysis may have missed
2. Consider TEMPORAL correlations — do timestamps across probes suggest a sequence of events?
3. Identify the TRUE ROOT CAUSE — not just symptoms. What chain of events led here?
4. Assess BLAST RADIUS more precisely — which downstream systems and users are affected?
5. Propose SPECIFIC remediation with exact commands, not generic advice
6. Identify what data sources would unlock the next level of understanding
7. If info is insufficient for diagnosis, formulate precise questions for the requester

RULES — STRICTLY ENFORCED:
1. EVERY conclusion MUST cite a specific probe result. Format: [probe_name: finding]
2. "UNKNOWN" is always valid — never fabricate
3. Your diagnosis should be MORE specific and MORE actionable than the initial one
4. Include needed_data_sources — what specific logs, metrics, or configs would help
5. Include user_questions if the ticket itself lacks context

Respond with ONLY valid JSON (same schema as initial diagnosis):
{
  "root_cause": "deep evidence-backed diagnosis",
  "confidence": "high|medium|low",
  "impact": "precise blast radius assessment",
  "evidence_citations": ["[probe_name: specific finding]", ...],
  "related_pattern": "cross-probe pattern analysis (or null)",
  "proposed_fix": {
    "action": "specific remediation",
    "commands": ["exact commands"],
    "risk_level": "low|medium|high",
    "requires_access": "permissions needed"
  },
  "status": "FIXABLE|NEEDS-ESCALATION|NEEDS-CREDENTIAL|NEEDS-INFO|INFO-ONLY",
  "status_reason": "why this status",
  "credential_gaps": ["what we couldn't investigate"],
  "needed_data_sources": ["specific data that would help"],
  "user_questions": ["questions for the requester if info is insufficient"]
}`;

  return await bedrockInvoke(prompt, {
    model: MODELS.OPUS,
    maxTokens: 4096,
    timeoutMs: 300000,
    parseJson: true,
  });
}

// ── Main Entry Point ──

export async function main(
  source: string = "m365",
  content: string = "",
  item_id: string = "",
  triage_classification: string = "QUEUE",
) {
  // ── Input validation ──
  const inputCheck = validateInput(content);
  if (!inputCheck.valid) {
    return {
      item_id: item_id || `inv-${Date.now()}`,
      source,
      triage_classification,
      entities_found: 0,
      entities: [],
      probes_run: 0,
      probes_successful: 0,
      probes_failed: 0,
      evidence: [],
      failed_probes: [],
      needs_credential: [],
      related_items: [],
      diagnosis: {
        root_cause: "SKIPPED — input validation failed",
        confidence: "low",
        impact: "Unable to assess",
        evidence_citations: [],
        proposed_fix: null,
        status: "INFO-ONLY",
        status_reason: inputCheck.reason,
        credential_gaps: [],
      },
      validation_checks: {
        input: { passed: false, reason: inputCheck.reason },
        entities: { passed: false, reason: "skipped — input invalid" },
        probes: { passed: false, reason: "skipped — input invalid" },
        diagnosis: { passed: false, reason: "skipped — input invalid" },
      },
      timestamp: new Date().toISOString(),
    };
  }

  // Step 1: Extract entities via regex patterns
  const rawEntities = extractEntities(content);
  const { filtered: entities, dropped: droppedEntities } = filterEntities(rawEntities);
  if (droppedEntities.length > 0) {
    console.log(`[investigate] Filtered ${droppedEntities.length} noise entities: ${droppedEntities.slice(0, 5).join(", ")}${droppedEntities.length > 5 ? "..." : ""}`);
  }

  // Step 1.5: AI entity extraction when regex finds sparse results
  if (entities.length < 3) {
    try {
      const aiEntities = await bedrockInvoke(
        `Extract entities from this IT alert/email. Return ONLY a JSON array of {type, value} objects.
Valid types: email, hostname, ip_address, ec2_instance, username, service_name, cloudwatch_alarm, s3_bucket, arn, security_group, ticket_id.
Only extract entities that are investigable — skip noreply/automated email addresses, private IPs (10.x, 172.16-31.x, 192.168.x), and external service hostnames (google.com, microsoft.com, etc.).
If no entities found, return an empty array [].

${content.slice(0, 3000)}`,
        { model: MODELS.HAIKU, maxTokens: 512, parseJson: true },
      );
      if (Array.isArray(aiEntities)) {
        const seen = new Set(entities.map(e => `${e.type}:${e.value.toLowerCase()}`));
        let added = 0;
        for (const ae of aiEntities) {
          if (ae.type && ae.value) {
            const key = `${ae.type}:${ae.value.toLowerCase()}`;
            if (!seen.has(key)) {
              seen.add(key);
              entities.push({ value: ae.value, type: ae.type });
              added++;
            }
          }
        }
        if (added > 0) {
          console.log(`[investigate] AI extraction added ${added} entities via Bedrock Haiku`);
        }
      }
    } catch (err: any) {
      console.log(`[investigate] AI entity extraction failed (non-fatal): ${err.message?.slice(0, 100)}`);
    }
  }

  // Step 1.75: Augment with resource inventory lookup (best-effort)
  if (entities.length < 3) {
    try {
      const { lookupResourceByName, isAvailable, init } = await import("./cache_lib.ts");
      if (isAvailable()) {
        init();
        const seen = new Set(entities.map(e => `${e.type}:${e.value.toLowerCase()}`));
        const inventoryMatches = lookupResourceByName(content);
        for (const match of inventoryMatches) {
          const key = `${match.resource_type}:${match.resource_id.toLowerCase()}`;
          if (!seen.has(key)) {
            seen.add(key);
            entities.push({ value: match.resource_id, type: match.resource_type });
          }
        }
      }
    } catch { /* non-fatal — inventory lookup is best-effort */ }
  }

  // Step 2: Run Steampipe probes for all accessible entities
  const { probes, needs_credential } = await runProbes(entities);

  // Step 3: Cross-source correlation from cache
  const relatedItems = await getRelatedItems(entities);

  // Step 4: AI synthesis — evidence-based diagnosis
  let diagnosis = await synthesize(
    content,
    entities,
    probes,
    relatedItems,
    needs_credential,
  );

  // ── Synthesis output validation ──
  const diagCheck = validateDiagnosis(diagnosis);
  if (!diagCheck.valid) {
    console.log(`[investigate] Diagnosis schema issues: ${diagCheck.issues.join(", ")}`);
    // Coerce invalid fields to safe defaults rather than discarding everything
    if (!VALID_CONFIDENCE.has(diagnosis?.confidence)) diagnosis.confidence = "low";
    if (!VALID_STATUS.has(diagnosis?.status)) diagnosis.status = "NEEDS-ESCALATION";
    if (!Array.isArray(diagnosis?.evidence_citations)) diagnosis.evidence_citations = [];
  }

  // Step 4b: Conditional Opus deep synthesis — maximum intelligence for actionable items
  // Gate: only when we have real evidence AND Sonnet found something worth escalating
  const successfulProbes = probes.filter(p => p.success && p.data);
  const shouldEscalateToOpus =
    successfulProbes.length > 0 &&
    diagnosis.confidence !== "low" &&
    diagnosis.status !== "INFO-ONLY" &&
    diagnosis.status !== "NEEDS-INFO" &&
    (triage_classification === "ACTIONABLE" || triage_classification === "NOTIFY" || triage_classification === "QUEUE");

  let opusUsed = false;
  if (shouldEscalateToOpus) {
    try {
      console.log(`[investigate] Escalating to Opus 4.6 for deep synthesis (${successfulProbes.length} probes, confidence: ${diagnosis.confidence})`);
      const opusDiagnosis = await deepSynthesize(
        content,
        entities,
        probes,
        relatedItems,
        needs_credential,
        diagnosis,
      );
      // Validate Opus output before replacing
      const opusCheck = validateDiagnosis(opusDiagnosis);
      if (opusCheck.valid) {
        diagnosis = opusDiagnosis;
        diagnosis._synthesized_by = "opus-4.6";
        opusUsed = true;
        console.log(`[investigate] Opus 4.6 synthesis complete — confidence: ${diagnosis.confidence}`);
      } else {
        console.log(`[investigate] Opus output invalid (${opusCheck.issues.join(", ")}), keeping Sonnet diagnosis`);
        diagnosis._synthesized_by = "sonnet-4";
      }
    } catch (err: any) {
      console.log(`[investigate] Opus synthesis failed (non-fatal): ${err.message?.slice(0, 100)}`);
      diagnosis._synthesized_by = "sonnet-4";
    }
  } else {
    diagnosis._synthesized_by = "sonnet-4";
    if (successfulProbes.length === 0) {
      console.log(`[investigate] Skipping Opus — no successful probes to synthesize`);
    }
  }

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

  // ── Build validation summary ──
  const successfulProbeCount = probes.filter(p => p.success).length;
  const probeSuccessRate = probes.length > 0 ? (successfulProbeCount / probes.length * 100).toFixed(0) : "N/A";

  const validationChecks = {
    input: { passed: true, content_length: content.length },
    entities: {
      passed: entities.length > 0,
      raw_count: rawEntities.length,
      after_filter: entities.length,
      dropped: droppedEntities.length,
      dropped_examples: droppedEntities.slice(0, 5),
    },
    probes: {
      passed: successfulProbeCount > 0,
      total: probes.length,
      successful: successfulProbeCount,
      failed: probes.length - successfulProbeCount,
      success_rate: probeSuccessRate + "%",
    },
    diagnosis: {
      passed: diagCheck.valid,
      issues: diagCheck.issues.length > 0 ? diagCheck.issues : undefined,
      confidence: diagnosis.confidence,
      has_root_cause: !!diagnosis.root_cause && !diagnosis.root_cause.includes("UNKNOWN"),
      has_evidence: (diagnosis.evidence_citations?.length || 0) > 0,
    },
  };

  return {
    item_id: item_id || `inv-${Date.now()}`,
    source,
    triage_classification,
    entities_found: entities.length,
    entities: entities.slice(0, 20),
    probes_run: probes.length,
    probes_successful: successfulProbeCount,
    probes_failed: probes.length - successfulProbeCount,
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
    needed_data_sources: diagnosis.needed_data_sources || [],
    user_questions: diagnosis.user_questions || [],
    model_pipeline: {
      entity_extraction: "haiku-3.5",
      initial_synthesis: "sonnet-4",
      deep_synthesis: opusUsed ? "opus-4.6" : "skipped",
      opus_gate: shouldEscalateToOpus ? "passed" : `blocked (probes: ${successfulProbes.length}, confidence: ${diagnosis.confidence}, status: ${diagnosis.status})`,
    },
    validation_checks: validationChecks,
    timestamp: new Date().toISOString(),
  };
}
