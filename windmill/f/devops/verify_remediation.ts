// Windmill Script: Verify Remediation
// Re-runs the same read-only Steampipe probes from the original investigation
// to confirm whether a remediation action actually fixed the issue.
//
// RULES:
//   1. ALL operations are READ-ONLY — this is verification, not remediation
//   2. Re-runs the SAME queries that investigate.ts ran originally
//   3. Uses claude CLI for AI synthesis of before/after comparison
//   4. Never modifies any resource — strictly observational
//
// Requires:
//   Steampipe service running on host (port 9193, postgres protocol)
//   Windmill variables: f/devops/steampipe_password
//   claude CLI available (native worker, not Docker)

import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";

// -- Windmill variable access --

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

// -- Steampipe Connection --

const STEAMPIPE_HOST = process.env.STEAMPIPE_HOST || "172.17.0.1";
const STEAMPIPE_PORT = process.env.STEAMPIPE_PORT || "9193";
let _steampipePassword: string | null = null;

async function getSteampipePassword(): Promise<string> {
  if (_steampipePassword) return _steampipePassword;
  const fromVar = await getVariable("f/devops/steampipe_password");
  if (fromVar) {
    _steampipePassword = fromVar;
    return fromVar;
  }
  throw new Error(
    "f/devops/steampipe_password not configured in Windmill variables",
  );
}

async function steampipeQueryJson(
  query: string,
): Promise<{ success: boolean; data: any; error?: string }> {
  try {
    const password = await getSteampipePassword();
    const { Client } = (await import("pg")) as any;
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

// -- Query Library (mirrored from investigate.ts) --
// These are the same read-only probes used during investigation.

interface QueryTemplate {
  entity_type: string;
  name: string;
  query: (entity: string) => string;
  requires: string;
}

const QUERY_LIBRARY: QueryTemplate[] = [
  // AWS EC2 Instance
  {
    entity_type: "ec2_instance",
    name: "instance_status",
    requires: "aws",
    query: (id) =>
      `SELECT instance_id, instance_state, instance_type,
      launch_time, public_ip_address, private_ip_address,
      vpc_id, subnet_id, tags ->> 'Name' as name,
      monitoring_state, state_transition_reason
      FROM aws_ec2_instance WHERE instance_id = '${id}'`,
  },
  {
    entity_type: "ec2_instance",
    name: "instance_status_checks",
    requires: "aws",
    query: (id) =>
      `SELECT instance_id, system_status, instance_status
      FROM aws_ec2_instance_availability WHERE instance_id = '${id}'`,
  },
  {
    entity_type: "ec2_instance",
    name: "cloudwatch_alarms",
    requires: "aws",
    query: (id) =>
      `SELECT name, state_value, state_reason,
      state_updated_timestamp, metric_name, namespace
      FROM aws_cloudwatch_alarm
      WHERE dimensions::text LIKE '%${id}%'
      ORDER BY state_updated_timestamp DESC LIMIT 10`,
  },
  {
    entity_type: "ec2_instance",
    name: "security_groups",
    requires: "aws",
    query: (id) =>
      `SELECT sg.group_id, sg.group_name, sg.description
      FROM aws_ec2_instance i, jsonb_array_elements(i.security_groups) sge
      JOIN aws_vpc_security_group sg ON sg.group_id = sge ->> 'GroupId'
      WHERE i.instance_id = '${id}'`,
  },
  {
    entity_type: "ec2_instance",
    name: "related_instances_by_name",
    requires: "aws",
    query: (id) =>
      `SELECT i2.instance_id, i2.tags ->> 'Name' as name,
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
    query: (id) =>
      `SELECT group_id, type, ip_protocol, from_port, to_port,
      cidr_ipv4, cidr_ipv6, referenced_group_id
      FROM aws_vpc_security_group_rule WHERE group_id = '${id}'`,
  },
  // IP Address
  {
    entity_type: "ip_address",
    name: "ip_to_instance",
    requires: "aws",
    query: (ip) =>
      `SELECT instance_id, tags ->> 'Name' as name,
      instance_state, public_ip_address, private_ip_address
      FROM aws_ec2_instance
      WHERE public_ip_address = '${ip}' OR private_ip_address = '${ip}'`,
  },
  {
    entity_type: "ip_address",
    name: "ip_to_eni",
    requires: "aws",
    query: (ip) =>
      `SELECT network_interface_id, description, status,
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
    query: (id) =>
      `SELECT vpc_id, state, cidr_block,
      tags ->> 'Name' as name, is_default
      FROM aws_vpc WHERE vpc_id = '${id}'`,
  },
  // Subnet
  {
    entity_type: "subnet",
    name: "subnet_details",
    requires: "aws",
    query: (id) =>
      `SELECT subnet_id, vpc_id, cidr_block,
      availability_zone, available_ip_address_count,
      tags ->> 'Name' as name
      FROM aws_vpc_subnet WHERE subnet_id = '${id}'`,
  },
];

const INSTALLED_PLUGINS = new Set(["aws"]);

// -- Types --

interface Entity {
  value: string;
  type: string;
}

interface ProbeResult {
  source: string;
  query: string;
  entity: string;
  entity_type: string;
  success: boolean;
  data: any;
  error?: string;
}

interface BeforeAfterEntry {
  probe: string;
  entity: string;
  before: any;
  after: any;
  changed: boolean;
}

interface VerificationResult {
  verified: boolean;
  confidence: "high" | "medium" | "low";
  before_after: BeforeAfterEntry[];
  summary: string;
  recommendation: "close" | "retry" | "escalate";
  approval_id: string;
}

// -- Probe Runner --
// Re-runs probes for specific entities using the same query library

async function rerunProbes(
  entities: Entity[],
  probeNames?: string[],
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const queriedKeys = new Set<string>();

  for (const entity of entities) {
    const key = `${entity.type}:${entity.value}`;
    if (queriedKeys.has(key)) continue;
    queriedKeys.add(key);

    const templates = QUERY_LIBRARY.filter(
      (q) => q.entity_type === entity.type,
    );

    for (const template of templates) {
      // If we have a specific probe name list, only run those
      if (probeNames && probeNames.length > 0 && !probeNames.includes(template.name)) {
        continue;
      }

      if (!INSTALLED_PLUGINS.has(template.requires)) continue;

      const sql = template.query(entity.value);
      const result = await steampipeQueryJson(sql);

      results.push({
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

  return results;
}

// -- Before/After Comparison --

function buildBeforeAfter(
  originalProbes: ProbeResult[],
  newProbes: ProbeResult[],
): BeforeAfterEntry[] {
  const entries: BeforeAfterEntry[] = [];

  for (const newProbe of newProbes) {
    // Find matching original probe by query name + entity
    const original = originalProbes.find(
      (p) => p.query === newProbe.query && p.entity === newProbe.entity,
    );

    const beforeData = original?.data ?? null;
    const afterData = newProbe.data ?? null;

    // Determine if state changed by comparing serialized data
    const beforeStr = JSON.stringify(beforeData);
    const afterStr = JSON.stringify(afterData);
    const changed = beforeStr !== afterStr;

    entries.push({
      probe: newProbe.query,
      entity: newProbe.entity,
      before: beforeData,
      after: afterData,
      changed,
    });
  }

  return entries;
}

// -- AI Synthesis --

async function synthesizeVerification(
  originalDiagnosis: any,
  playbookResult: any,
  beforeAfter: BeforeAfterEntry[],
): Promise<{
  verified: boolean;
  confidence: "high" | "medium" | "low";
  summary: string;
  recommendation: "close" | "retry" | "escalate";
}> {
  const changedEntries = beforeAfter.filter((e) => e.changed);
  const unchangedEntries = beforeAfter.filter((e) => !e.changed);

  const prompt = `You are a senior infrastructure verification analyst. Determine whether a remediation action successfully fixed the diagnosed issue.

ORIGINAL DIAGNOSIS:
${JSON.stringify(originalDiagnosis, null, 2).slice(0, 3000)}

PLAYBOOK EXECUTION RESULT:
${JSON.stringify(playbookResult, null, 2).slice(0, 2000)}

BEFORE/AFTER PROBE RESULTS (${beforeAfter.length} probes re-run):
Changed probes (${changedEntries.length}):
${changedEntries
  .map(
    (e) =>
      `  [${e.probe}] Entity: ${e.entity}
    BEFORE: ${JSON.stringify(e.before).slice(0, 500)}
    AFTER:  ${JSON.stringify(e.after).slice(0, 500)}`,
  )
  .join("\n\n")}

Unchanged probes (${unchangedEntries.length}):
${unchangedEntries
  .map((e) => `  [${e.probe}] Entity: ${e.entity} — NO CHANGE`)
  .join("\n")}

RULES:
1. Compare the BEFORE and AFTER states to determine if the remediation worked
2. "verified" means the specific issue from the diagnosis is now resolved
3. Confidence: HIGH if multiple probes confirm fix, MEDIUM if single probe suggests, LOW if ambiguous
4. Recommendation:
   - "close" if fix is verified with high/medium confidence
   - "retry" if fix partially worked or needs another attempt
   - "escalate" if fix failed or made things worse
5. Be precise — cite specific probe changes in your summary

Respond with ONLY valid JSON:
{
  "verified": true/false,
  "confidence": "high|medium|low",
  "summary": "Human-readable verification result citing specific probe evidence",
  "recommendation": "close|retry|escalate"
}`;

  try {
    const tmpFile = `/tmp/verify-prompt-${Date.now()}.txt`;
    writeFileSync(tmpFile, prompt);
    const result = execSync(
      `cat ${tmpFile} | claude -p --output-format json 2>/dev/null`,
      { encoding: "utf-8", timeout: 90000 },
    ).trim();
    try {
      unlinkSync(tmpFile);
    } catch {
      /* cleanup best-effort */
    }

    const parsed = JSON.parse(result);
    const text =
      typeof parsed === "string"
        ? parsed
        : parsed.result || parsed.content || JSON.stringify(parsed);
    const inner = typeof text === "string" ? JSON.parse(text) : text;

    return {
      verified: inner.verified === true,
      confidence: inner.confidence || "low",
      summary: inner.summary || "AI synthesis completed without summary",
      recommendation: inner.recommendation || "escalate",
    };
  } catch (err: any) {
    // Fallback: heuristic-based verification if AI is unavailable
    const anyChanged = changedEntries.length > 0;
    const playbookSuccess = playbookResult?.success === true;

    return {
      verified: anyChanged && playbookSuccess,
      confidence: "low",
      summary: `AI synthesis failed (${err.message?.slice(0, 100)}). Heuristic: ${changedEntries.length}/${beforeAfter.length} probes show state change. Playbook reported ${playbookSuccess ? "success" : "failure"}.`,
      recommendation: anyChanged && playbookSuccess ? "close" : "escalate",
    };
  }
}

// -- Cache Result --

async function cacheVerification(
  itemId: string,
  result: VerificationResult,
): Promise<void> {
  try {
    const { store, isAvailable, init } = await import("./cache_lib.ts");
    if (isAvailable()) {
      init();
      store(
        "triage",
        "verification",
        `${itemId}-verify-${Date.now()}`,
        `Verification: ${itemId} — ${result.verified ? "PASSED" : "FAILED"}`,
        `${result.summary} confidence:${result.confidence} recommendation:${result.recommendation}`,
        {
          item_id: itemId,
          verified: result.verified,
          confidence: result.confidence,
          recommendation: result.recommendation,
          before_after_count: result.before_after.length,
          changed_count: result.before_after.filter((e) => e.changed).length,
          approval_id: result.approval_id,
          timestamp: new Date().toISOString(),
        },
      );
    }
  } catch {
    /* cache write failed — non-fatal */
  }
}

// -- Main Entry Point --

export async function main(
  item_id: string,
  original_investigation: string,
  playbook_result: string,
  approval_id: string,
): Promise<VerificationResult> {
  // Validate inputs
  if (!item_id) {
    return {
      verified: false,
      confidence: "low",
      before_after: [],
      summary: "Missing required parameter: item_id",
      recommendation: "escalate",
      approval_id: approval_id || "",
    };
  }

  if (!original_investigation) {
    return {
      verified: false,
      confidence: "low",
      before_after: [],
      summary: "Missing required parameter: original_investigation",
      recommendation: "escalate",
      approval_id: approval_id || "",
    };
  }

  // Step 1: Parse original investigation
  let investigation: any;
  try {
    investigation = JSON.parse(original_investigation);
  } catch (err: any) {
    return {
      verified: false,
      confidence: "low",
      before_after: [],
      summary: `Failed to parse original_investigation JSON: ${err.message?.slice(0, 200)}`,
      recommendation: "escalate",
      approval_id: approval_id || "",
    };
  }

  let playbook: any;
  try {
    playbook = JSON.parse(playbook_result);
  } catch (err: any) {
    return {
      verified: false,
      confidence: "low",
      before_after: [],
      summary: `Failed to parse playbook_result JSON: ${err.message?.slice(0, 200)}`,
      recommendation: "escalate",
      approval_id: approval_id || "",
    };
  }

  // Step 2: Extract entities and original probe names from the investigation
  const entities: Entity[] = investigation.entities || [];
  const originalEvidence: ProbeResult[] = [];

  // Reconstruct original probe results from the evidence array
  if (investigation.evidence && Array.isArray(investigation.evidence)) {
    for (const ev of investigation.evidence) {
      originalEvidence.push({
        source: "steampipe/aws",
        query: ev.query,
        entity: ev.entity,
        entity_type:
          entities.find((e: Entity) => e.value === ev.entity)?.type ||
          "unknown",
        success: true,
        data: ev.data,
      });
    }
  }

  // Also include failed probes from original for completeness
  if (
    investigation.failed_probes &&
    Array.isArray(investigation.failed_probes)
  ) {
    for (const fp of investigation.failed_probes) {
      originalEvidence.push({
        source: "steampipe/aws",
        query: fp.query,
        entity: fp.entity,
        entity_type:
          entities.find((e: Entity) => e.value === fp.entity)?.type ||
          "unknown",
        success: false,
        data: null,
        error: fp.error,
      });
    }
  }

  // Determine which probe names were originally run
  const originalProbeNames = [
    ...new Set(originalEvidence.map((p) => p.query)),
  ];

  if (entities.length === 0) {
    return {
      verified: false,
      confidence: "low",
      before_after: [],
      summary:
        "No entities found in original investigation — cannot re-run probes",
      recommendation: "escalate",
      approval_id: approval_id || "",
    };
  }

  // Step 3: Re-run the SAME Steampipe probes
  const newProbes = await rerunProbes(entities, originalProbeNames);

  // Step 4: Build before/after comparison
  const beforeAfter = buildBeforeAfter(originalEvidence, newProbes);

  // Step 5: AI synthesis of before/after comparison
  const synthesis = await synthesizeVerification(
    investigation.diagnosis,
    playbook,
    beforeAfter,
  );

  // Step 6: Assemble final result
  const result: VerificationResult = {
    verified: synthesis.verified,
    confidence: synthesis.confidence,
    before_after: beforeAfter,
    summary: synthesis.summary,
    recommendation: synthesis.recommendation,
    approval_id: approval_id || "",
  };

  // Step 7: Cache the verification result
  await cacheVerification(item_id, result);

  return result;
}
