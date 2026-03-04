// Windmill Script: Batch Triage SDP Items
// Ingests SDP requests and tasks into the triage pipeline.
// SDP items are always actionable (action="QUEUE"), skip actionability determination.
// Same triage + investigation flow as email/slack, just no AI classification for actionability.
// L1 dedup prevents re-ingesting unchanged items.

import { createHash } from "crypto";

// ── Windmill variable helper ──

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

// ── SDP API helpers ──

const SDP_HEADERS = {
  Accept: "application/vnd.manageengine.sdp.v3+json",
  "Content-Type": "application/x-www-form-urlencoded",
};

interface SdpItem {
  id: string;
  subject?: string;
  title?: string;
  status?: { name: string };
  priority?: { name: string };
  technician?: { name: string };
  requester?: { name: string };
  owner?: { name: string };
  created_time?: { display_value: string; value: string };
  last_updated_time?: { display_value: string; value: string };
  description?: string;
  task_type?: { name: string };
  // For tasks under projects/changes
  associated_entity?: { id: string; name: string; entity_type: string };
}

async function fetchSdpRequests(
  baseUrl: string,
  apiKey: string,
  rowCount: number = 100,
): Promise<SdpItem[]> {
  const openStatuses = ["Open", "In Progress", "On Hold", "Pending"];
  const criteria = openStatuses.map((s) => ({
    field: "status.name",
    condition: "is",
    value: s,
    logical_operator: "OR",
  }));

  const listInfo = {
    list_info: {
      row_count: rowCount,
      sort_field: "last_updated_time",
      sort_order: "desc",
      search_criteria: criteria,
    },
  };

  const url = `${baseUrl}/requests?input_data=${encodeURIComponent(JSON.stringify(listInfo))}`;
  const response = await fetch(url, {
    headers: {
      ...SDP_HEADERS,
      Authorization: `Zoho-oauthtoken ${apiKey}`,
    },
  });

  if (!response.ok) {
    console.error(`[batch_triage_sdp] Requests API error: ${response.status}`);
    return [];
  }
  const data = await response.json();
  return data.requests || [];
}

async function fetchSdpTasks(
  baseUrl: string,
  apiKey: string,
  rowCount: number = 100,
): Promise<SdpItem[]> {
  const openStatuses = ["Open", "In Progress", "On Hold", "Pending"];
  const criteria = openStatuses.map((s) => ({
    field: "status.name",
    condition: "is",
    value: s,
    logical_operator: "OR",
  }));

  const listInfo = {
    list_info: {
      row_count: rowCount,
      sort_field: "last_updated_time",
      sort_order: "desc",
      search_criteria: criteria,
    },
  };

  const url = `${baseUrl}/tasks?input_data=${encodeURIComponent(JSON.stringify(listInfo))}`;
  const response = await fetch(url, {
    headers: {
      ...SDP_HEADERS,
      Authorization: `Zoho-oauthtoken ${apiKey}`,
    },
  });

  if (!response.ok) {
    console.error(`[batch_triage_sdp] Tasks API error: ${response.status}`);
    return [];
  }
  const data = await response.json();
  return data.tasks || [];
}

async function fetchTaskParentContext(
  baseUrl: string,
  apiKey: string,
  entityType: string,
  entityId: string,
): Promise<string> {
  // Try to fetch parent entity (project or change) for additional context
  const endpoints: Record<string, string> = {
    project: "projects",
    change: "changes",
  };
  const endpoint = endpoints[entityType.toLowerCase()];
  if (!endpoint) return "";

  try {
    const url = `${baseUrl}/${endpoint}/${entityId}`;
    const response = await fetch(url, {
      headers: {
        ...SDP_HEADERS,
        Authorization: `Zoho-oauthtoken ${apiKey}`,
      },
    });
    if (!response.ok) return "";
    const data = await response.json();
    const entity = data[entityType.toLowerCase()] || {};
    return `Parent ${entityType}: ${entity.title || entity.name || entityId}`;
  } catch {
    return "";
  }
}

// ── Priority mapping ──

function mapSdpPriorityToUrgency(priority: string): string {
  switch (priority?.toLowerCase()) {
    case "critical": return "critical";
    case "high": return "high";
    case "medium": case "normal": return "medium";
    case "low": return "low";
    default: return "medium";
  }
}

// ── Dedup ──

function computeDedupHash(sdpType: string, sdpId: string): string {
  const normalized = `sdp|${sdpType}|${sdpId}`;
  return createHash("sha256").update(normalized).digest("hex");
}

// ── Main ──

export async function main(
  max_requests: number = 100,
  max_tasks: number = 100,
  dry_run: boolean = false,
): Promise<{
  requests_fetched: number;
  tasks_fetched: number;
  ingested: number;
  skipped_dedup: number;
  errors: number;
  results: Array<{
    sdp_type: string;
    sdp_id: string;
    subject: string;
    urgency: string;
    result: string;
  }>;
}> {
  const startTime = Date.now();
  console.log(`[batch_triage_sdp] Starting: max_requests=${max_requests}, max_tasks=${max_tasks}, dry_run=${dry_run}`);

  // Load cache_lib
  let cacheLib: any = null;
  try {
    cacheLib = await import("./cache_lib.ts");
    if (cacheLib.isAvailable()) {
      cacheLib.init();
      console.log("[batch_triage_sdp] Cache lib loaded");
    } else {
      console.log("[batch_triage_sdp] Cache not available");
      cacheLib = null;
    }
  } catch (e: any) {
    console.log(`[batch_triage_sdp] Cache lib not loaded: ${e.message?.slice(0, 100)}`);
    cacheLib = null;
  }

  // Get SDP credentials
  const baseUrl = (await getVariable("f/devops/sdp_base_url"))?.replace(/\/+$/, "");
  const apiKey = await getVariable("f/devops/sdp_api_key");

  if (!baseUrl || !apiKey) {
    return {
      requests_fetched: 0, tasks_fetched: 0, ingested: 0,
      skipped_dedup: 0, errors: 1,
      results: [{ sdp_type: "error", sdp_id: "", subject: "SDP credentials not configured", urgency: "", result: "error" }],
    };
  }

  const results: Array<{ sdp_type: string; sdp_id: string; subject: string; urgency: string; result: string }> = [];
  let ingested = 0, skippedDedup = 0, errorCount = 0;

  // ── Fetch SDP Requests ──
  console.log(`\n[batch_triage_sdp] Fetching SDP requests...`);
  let requests: SdpItem[] = [];
  try {
    requests = await fetchSdpRequests(baseUrl, apiKey, max_requests);
    console.log(`[batch_triage_sdp] Fetched ${requests.length} requests`);
  } catch (err: any) {
    console.error(`[batch_triage_sdp] Failed to fetch requests: ${err.message}`);
    errorCount++;
  }

  // ── Fetch SDP Tasks ──
  console.log(`\n[batch_triage_sdp] Fetching SDP tasks...`);
  let tasks: SdpItem[] = [];
  try {
    tasks = await fetchSdpTasks(baseUrl, apiKey, max_tasks);
    console.log(`[batch_triage_sdp] Fetched ${tasks.length} tasks`);
  } catch (err: any) {
    console.error(`[batch_triage_sdp] Failed to fetch tasks: ${err.message}`);
    errorCount++;
  }

  // ── Process all items ──
  const allItems: Array<{ item: SdpItem; sdpType: "request" | "task" }> = [
    ...requests.map((item) => ({ item, sdpType: "request" as const })),
    ...tasks.map((item) => ({ item, sdpType: "task" as const })),
  ];

  for (const { item, sdpType } of allItems) {
    const sdpId = String(item.id);
    const subject = (sdpType === "request" ? item.subject : item.title) || `SDP ${sdpType} #${sdpId}`;
    const sender = (sdpType === "request" ? item.requester?.name : item.owner?.name) || "SDP";
    const priority = item.priority?.name || "Medium";
    const urgency = mapSdpPriorityToUrgency(priority);
    const messageId = `sdp-${sdpType}-${sdpId}`;
    const dedupHash = computeDedupHash(sdpType, sdpId);
    const receivedAt = item.created_time?.value
      ? new Date(Number(item.created_time.value)).toISOString()
      : new Date().toISOString();

    // L1 dedup: check if already ingested
    if (cacheLib) {
      try {
        const dedup = cacheLib.checkDedup(dedupHash);
        if (dedup.found) {
          skippedDedup++;
          continue;
        }
      } catch { /* proceed with ingestion */ }
    }

    if (dry_run) {
      results.push({ sdp_type: sdpType, sdp_id: sdpId, subject: subject.slice(0, 100), urgency, result: "would_ingest" });
      continue;
    }

    // Fetch parent context for non-General tasks
    let parentContext = "";
    if (sdpType === "task" && item.associated_entity?.id) {
      const entityType = item.associated_entity.entity_type || "project";
      parentContext = await fetchTaskParentContext(baseUrl, apiKey, entityType, item.associated_entity.id);
    }

    // Determine task type
    const taskType = item.task_type?.name || "General";
    const isGeneral = taskType.toLowerCase() === "general";

    // Build description/body for investigation
    const descriptionText = item.description || subject;
    const modifiedEpoch = item.last_updated_time?.value
      ? Math.floor(Number(item.last_updated_time.value) / 1000)
      : Math.floor(Date.now() / 1000);

    // Store in triage_results
    if (cacheLib) {
      try {
        cacheLib.storeTriageResult({
          source: "sdp",
          message_id: messageId,
          subject: subject.slice(0, 500),
          sender,
          received_at: receivedAt,
          action: "QUEUE",
          urgency,
          summary: `SDP ${sdpType}: ${subject.slice(0, 200)}`,
          reasoning: `SDP ${sdpType} #${sdpId} — always actionable, priority=${priority}`,
          domain: "work",
          classified_by: "L1_rule",
          rule_id: null,
          dedup_hash: dedupHash,
          marked_read: 0,
          metadata: JSON.stringify({
            sdp_type: sdpType,
            sdp_id: sdpId,
            sdp_status: item.status?.name || "",
            sdp_priority: priority,
            sdp_technician: item.technician?.name || "",
            sdp_task_type: taskType,
            sdp_is_general: isGeneral,
            sdp_modified_epoch: modifiedEpoch,
            parent_context: parentContext || undefined,
            body_text: descriptionText.slice(0, 8000),
            preview: descriptionText.slice(0, 1000),
          }),
        });

        ingested++;
        results.push({ sdp_type: sdpType, sdp_id: sdpId, subject: subject.slice(0, 100), urgency, result: "ingested" });
        console.log(`[batch_triage_sdp] Ingested ${sdpType} #${sdpId}: ${subject.slice(0, 60)}`);
      } catch (err: any) {
        errorCount++;
        results.push({ sdp_type: sdpType, sdp_id: sdpId, subject: subject.slice(0, 100), urgency, result: `error: ${err.message?.slice(0, 100)}` });
        console.error(`[batch_triage_sdp] Error storing ${sdpType} #${sdpId}: ${err.message?.slice(0, 100)}`);
      }
    }
  }

  const duration = Date.now() - startTime;
  console.log(`\n[batch_triage_sdp] Complete in ${(duration / 1000).toFixed(1)}s`);
  console.log(`[batch_triage_sdp] Requests: ${requests.length}, Tasks: ${tasks.length}`);
  console.log(`[batch_triage_sdp] Ingested: ${ingested}, Skipped (dedup): ${skippedDedup}, Errors: ${errorCount}`);

  return {
    requests_fetched: requests.length,
    tasks_fetched: tasks.length,
    ingested,
    skipped_dedup: skippedDedup,
    errors: errorCount,
    results,
  };
}
