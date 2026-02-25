// Windmill Script: SDP-AWS Correlation
// Phase 6 Gap #2 applied: Fetch SDP ticket, extract AWS entities,
// enrich via Steampipe, post enrichment as ticket note
//
// Requires Windmill variables:
//   f/devops/sdp_base_url   — e.g., https://sdpondemand.manageengine.com/app/itdesk/api/v3
//   f/devops/sdp_api_key    — Zoho OAuth access token (refreshed by refresh_sdp_token cron)

import { execSync } from "child_process";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();
const CORRELATE_LOG = join(HOME, ".claude", "logs", "sdp-aws-correlations.jsonl");

const SDP_HEADERS = {
  Accept: "application/vnd.manageengine.sdp.v3+json",
  "Content-Type": "application/x-www-form-urlencoded",
};

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

// Entity patterns (from entity_extract.ts)
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

interface ExtractedEntity {
  type: string;
  value: string;
  enrichment?: Record<string, unknown>;
}

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
      entities.push({ type, value });
    }
  }

  return entities;
}

function enrichWithSteampipe(entity: ExtractedEntity): ExtractedEntity {
  try {
    execSync("which steampipe", { encoding: "utf-8", timeout: 2000 });
  } catch {
    return entity;
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
      case "aws_volume":
        query = `select volume_id, volume_type, size, state, tags ->> 'Name' as name from aws_ebs_volume where volume_id = '${entity.value}'`;
        break;
      case "aws_subnet":
        query = `select subnet_id, vpc_id, cidr_block, availability_zone, tags ->> 'Name' as name from aws_vpc_subnet where subnet_id = '${entity.value}'`;
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
  } catch {
    // Enrichment failed
  }

  return entity;
}

function formatEnrichmentNote(
  ticketId: string,
  entities: ExtractedEntity[],
): string {
  let note = `AWS Infrastructure Correlation for Ticket #${ticketId}\n`;
  note += `Generated: ${new Date().toISOString().slice(0, 16).replace("T", " ")}\n`;
  note += `Entities found: ${entities.length}\n\n`;

  for (const entity of entities) {
    note += `[${entity.type}] ${entity.value}\n`;
    if (entity.enrichment) {
      for (const [key, val] of Object.entries(entity.enrichment)) {
        if (val !== null && val !== undefined) {
          note += `  ${key}: ${val}\n`;
        }
      }
    }
    note += "\n";
  }

  if (entities.length === 0) {
    note += "No AWS entities detected in ticket content.\n";
  }

  return note;
}

function ensureDirs(): void {
  const logDir = join(HOME, ".claude", "logs");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
}

export async function main(
  ticket_id: string,
  dry_run: boolean = false,
) {
  const baseUrl = await getVariable("f/devops/sdp_base_url");
  const apiKey = await getVariable("f/devops/sdp_api_key");

  if (!baseUrl || !apiKey) {
    return {
      error: "SDP credentials not configured",
      setup: "Set f/devops/sdp_base_url and f/devops/sdp_api_key in Windmill variables",
    };
  }

  if (!ticket_id) {
    return { error: "ticket_id is required" };
  }

  ensureDirs();

  // Fetch ticket details
  const ticketResp = await fetch(`${baseUrl}/requests/${ticket_id}`, {
    headers: {
      ...SDP_HEADERS,
      Authorization: `Zoho-oauthtoken ${apiKey}`,
    },
  });

  if (!ticketResp.ok) {
    return {
      error: `Failed to fetch ticket: ${ticketResp.status} ${ticketResp.statusText}`,
      body: await ticketResp.text(),
    };
  }

  const ticketData = await ticketResp.json();
  const request = ticketData.request || {};

  // Build searchable text from ticket fields
  const searchText = [
    request.subject,
    request.description,
    request.resolution?.content,
    ...(request.notes || []).map((n: Record<string, unknown>) => n.description),
  ]
    .filter(Boolean)
    .join("\n");

  // Extract and enrich
  let entities = extractEntities(searchText);
  entities = entities.map(enrichWithSteampipe);

  const noteContent = formatEnrichmentNote(ticket_id, entities);

  let noteResult: { note_id?: string; message: string } | null = null;

  if (!dry_run && entities.length > 0) {
    const inputData = JSON.stringify({
      request_note: {
        description: noteContent,
        show_to_requester: false,
      },
    });

    const noteResp = await fetch(`${baseUrl}/requests/${ticket_id}/notes`, {
      method: "POST",
      headers: {
        ...SDP_HEADERS,
        Authorization: `Zoho-oauthtoken ${apiKey}`,
      },
      body: `input_data=${encodeURIComponent(inputData)}`,
    });

    if (noteResp.ok) {
      const noteData = await noteResp.json();
      noteResult = {
        note_id: noteData.request_note?.id,
        message: `Enrichment note added to ticket #${ticket_id}`,
      };
    } else {
      noteResult = {
        message: `Failed to add note: ${noteResp.status} ${noteResp.statusText}`,
      };
    }
  } else if (dry_run) {
    noteResult = { message: "Dry run — note not posted" };
  } else {
    noteResult = { message: "No entities found — note not posted" };
  }

  // Log
  appendFileSync(
    CORRELATE_LOG,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      ticket_id,
      entity_count: entities.length,
      types: [...new Set(entities.map((e) => e.type))],
      enriched: entities.filter((e) => !!e.enrichment).length,
      dry_run,
      note_posted: !!noteResult?.note_id,
    }) + "\n",
  );

  return {
    ticket_id,
    subject: request.subject,
    entity_count: entities.length,
    entities,
    types_found: [...new Set(entities.map((e) => e.type))],
    enriched_count: entities.filter((e) => !!e.enrichment).length,
    note: noteResult,
    dry_run,
  };
}
