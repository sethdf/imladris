// Windmill Script: Investigate SDP Tickets
// Batch-investigates open SDP requests/tasks assigned to a technician.
// For each ticket: submits to agentic_investigator (async), polls for result,
// posts investigation findings as a private note on the ticket.
// Respects worker concurrency: max 2 concurrent investigations.

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
}

async function fetchSdpRequests(
  baseUrl: string,
  apiKey: string,
  technicianName: string,
  rowCount: number = 100,
): Promise<SdpItem[]> {
  // Fetch open requests, then filter by technician client-side
  // (SDP search_criteria can be finicky with nested object fields)
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
    console.error(`[investigate_sdp] Requests API error: ${response.status}`);
    return [];
  }
  const data = await response.json();
  const all = data.requests || [];

  // Filter by technician name (case-insensitive)
  const techLower = technicianName.toLowerCase();
  return all.filter((r: SdpItem) =>
    r.technician?.name?.toLowerCase() === techLower,
  );
}

async function fetchSdpTasks(
  baseUrl: string,
  apiKey: string,
  ownerName: string,
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
    console.error(`[investigate_sdp] Tasks API error: ${response.status}`);
    return [];
  }
  const data = await response.json();
  const all = data.tasks || [];

  const ownerLower = ownerName.toLowerCase();
  return all.filter((t: SdpItem) =>
    t.owner?.name?.toLowerCase() === ownerLower,
  );
}

// ── Investigation job management ──

const WM_BASE = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
const WM_TOKEN = process.env.WM_TOKEN;
const WM_WORKSPACE = process.env.WM_WORKSPACE || "imladris";

async function submitInvestigation(
  sdpType: string,
  sdpId: string,
  subject: string,
  body: string,
  sender: string,
): Promise<{ success: boolean; jobId?: string; error?: string }> {
  if (!WM_TOKEN) return { success: false, error: "No WM_TOKEN" };

  try {
    const resp = await fetch(
      `${WM_BASE}/api/w/${WM_WORKSPACE}/jobs/run/p/f/devops/agentic_investigator`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WM_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source: "sdp",
          subject,
          body: `CONTEXT: This is an open SDP ${sdpType} (ticket #${sdpId}) assigned to a technician. It is NOT an alert or monitoring event — it is an actionable work item requiring investigation and resolution. Your job is to investigate the technical details, identify what needs to be done, assess complexity/risk, and recommend specific next steps. Severity should reflect the urgency and impact of the work item (never "informational" — these are real tasks).\n\nTICKET DESCRIPTION:\n${body}`,
          sender,
          item_id: `sdp-${sdpType}-${sdpId}`,
          triage_classification: "QUEUE",
          related_alerts: [],
          dedup_hash: "", // no cache write needed — we're posting directly to SDP
        }),
      },
    );

    if (!resp.ok) {
      const respBody = await resp.text().catch(() => "");
      return { success: false, error: `HTTP ${resp.status}: ${respBody.slice(0, 200)}` };
    }

    const jobId = (await resp.text()).replace(/"/g, "").trim();
    return { success: true, jobId };
  } catch (err: any) {
    return { success: false, error: err.message?.slice(0, 300) };
  }
}

async function checkJobStatus(
  jobId: string,
): Promise<{ completed: boolean; success?: boolean; result?: any }> {
  if (!WM_TOKEN) return { completed: false };

  try {
    const resp = await fetch(
      `${WM_BASE}/api/w/${WM_WORKSPACE}/jobs_u/completed/get_result_maybe/${jobId}`,
      { headers: { Authorization: `Bearer ${WM_TOKEN}` } },
    );
    if (!resp.ok) return { completed: false };
    const data = await resp.json();
    if (!data.completed) return { completed: false };
    return { completed: true, success: data.success !== false, result: data.result };
  } catch {
    return { completed: false };
  }
}

async function waitForJob(
  jobId: string,
  timeoutMs: number = 300_000,
  pollIntervalMs: number = 10_000,
): Promise<{ success: boolean; result?: any; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await checkJobStatus(jobId);
    if (status.completed) {
      return { success: status.success ?? false, result: status.result };
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return { success: false, error: "Timeout waiting for investigation" };
}

// ── Note formatting for SDP ──

function esc(text: string): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatInvestigationNote(investigation: any): string {
  if (!investigation) return "<p>Investigation returned no results.</p>";

  const parts: string[] = [];

  if (investigation.diagnosis) {
    const d = investigation.diagnosis;

    const sev = (d.severity || "unknown").toLowerCase();
    const rootCause = esc(d.root_cause || "Unknown");
    parts.push(`<p>Looked into this. ${sev !== "unknown" ? `Severity: ${sev}. ` : ""}Root cause: ${rootCause}</p>`);

    if (d.summary) {
      parts.push(`<p>${esc(d.summary)}</p>`);
    }

    if (d.evidence?.length) {
      parts.push(`<p><b>What I found:</b></p><ul>`);
      for (const e of d.evidence) {
        parts.push(`<li>${esc(String(e))}</li>`);
      }
      parts.push(`</ul>`);
    }

    if (d.affected_systems?.length) {
      parts.push(`<p><b>Affected systems:</b> ${esc(d.affected_systems.join(", "))}</p>`);
    }

    if (d.recommended_actions?.length) {
      parts.push(`<p><b>Next steps:</b></p><ol>`);
      for (const action of d.recommended_actions) {
        parts.push(`<li>${esc(String(action))}</li>`);
      }
      parts.push(`</ol>`);
    }

    if (d.missing_data_sources?.length) {
      parts.push(`<p><b>Couldn't check:</b></p><ul>`);
      for (const ds of d.missing_data_sources) {
        parts.push(`<li><b>${esc(ds.name)}</b>: ${esc(ds.reason)}</li>`);
      }
      parts.push(`</ul>`);
    }

    const conf = (d.confidence || "").toLowerCase();
    if (conf && conf !== "high") {
      parts.push(`<p>Note: confidence is ${conf} — may need further review.</p>`);
    }
  } else if (investigation.error) {
    parts.push(`<p>Error during investigation: ${esc(investigation.error)}</p>`);
  }

  return parts.join("\n");
}

// ── SDP note posting ──

async function addRequestNote(
  requestId: string,
  noteContent: string,
  baseUrl: string,
  apiKey: string,
): Promise<{ success: boolean; note_id?: string; error?: string }> {
  try {
    const inputData = JSON.stringify({
      request_note: {
        description: noteContent,
        show_to_requester: false,
      },
    });

    const response = await fetch(`${baseUrl}/requests/${requestId}/notes`, {
      method: "POST",
      headers: {
        ...SDP_HEADERS,
        Authorization: `Zoho-oauthtoken ${apiKey}`,
      },
      body: `input_data=${encodeURIComponent(inputData)}`,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { success: false, error: `HTTP ${response.status}: ${body.slice(0, 300)}` };
    }

    const data = await response.json();
    return { success: true, note_id: String(data.request_note?.id || "") };
  } catch (err: any) {
    return { success: false, error: err.message?.slice(0, 300) };
  }
}

async function addTaskWorklog(
  taskId: string,
  noteContent: string,
  baseUrl: string,
  apiKey: string,
): Promise<{ success: boolean; note_id?: string; error?: string }> {
  try {
    const inputData = JSON.stringify({
      worklog: {
        description: noteContent,
        owner: { name: "Seth Foley" },
      },
    });

    const response = await fetch(`${baseUrl}/tasks/${taskId}/worklogs`, {
      method: "POST",
      headers: {
        ...SDP_HEADERS,
        Authorization: `Zoho-oauthtoken ${apiKey}`,
      },
      body: `input_data=${encodeURIComponent(inputData)}`,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { success: false, error: `HTTP ${response.status}: ${body.slice(0, 300)}` };
    }

    const data = await response.json();
    return { success: true, note_id: String(data.worklog?.id || "") };
  } catch (err: any) {
    return { success: false, error: err.message?.slice(0, 300) };
  }
}

// ── Main ──

export async function main(
  technician_name: string = "Seth Foley",
  include_requests: boolean = true,
  include_tasks: boolean = true,
  max_concurrent: number = 2,
  investigation_timeout_ms: number = 300000,
  dry_run: boolean = false,
  specific_request_ids: string = "",
): Promise<{
  requests_found: number;
  tasks_found: number;
  investigated: number;
  notes_posted: number;
  errors: number;
  results: Array<{
    sdp_type: string;
    sdp_id: string;
    subject: string;
    status: string;
    detail?: string;
  }>;
}> {
  const startTime = Date.now();
  console.log(`[investigate_sdp] Starting: technician="${technician_name}", max_concurrent=${max_concurrent}, dry_run=${dry_run}`);

  // Get SDP credentials
  const baseUrl = (await getVariable("f/devops/sdp_base_url"))?.replace(/\/+$/, "");
  const apiKey = await getVariable("f/devops/sdp_api_key");

  if (!baseUrl || !apiKey) {
    return {
      requests_found: 0, tasks_found: 0, investigated: 0,
      notes_posted: 0, errors: 1,
      results: [{ sdp_type: "error", sdp_id: "", subject: "SDP credentials not configured", status: "error" }],
    };
  }

  const results: Array<{ sdp_type: string; sdp_id: string; subject: string; status: string; detail?: string }> = [];
  let investigated = 0, notesPosted = 0, errorCount = 0;

  // ── Fetch tickets ──
  // If specific_request_ids provided, use those instead of querying SDP
  const specificIds = specific_request_ids
    ? specific_request_ids.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  let requests: SdpItem[] = [];
  if (specificIds.length > 0) {
    console.log(`\n[investigate_sdp] Using ${specificIds.length} specific request IDs`);
    // Fetch each request individually to get subject/description
    for (const id of specificIds) {
      try {
        const url = `${baseUrl}/requests/${id}`;
        const resp = await fetch(url, {
          headers: {
            ...SDP_HEADERS,
            Authorization: `Zoho-oauthtoken ${apiKey}`,
          },
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data.request) {
            requests.push(data.request);
          }
        } else {
          console.warn(`[investigate_sdp] Could not fetch request ${id}: HTTP ${resp.status}`);
          // Still include it with minimal info so it gets investigated
          requests.push({ id, subject: `SDP request #${id}` });
        }
      } catch (err: any) {
        console.warn(`[investigate_sdp] Error fetching request ${id}: ${err.message}`);
        requests.push({ id, subject: `SDP request #${id}` });
      }
    }
    console.log(`[investigate_sdp] Fetched ${requests.length} specific requests`);
  } else if (include_requests) {
    console.log(`\n[investigate_sdp] Fetching open SDP requests for ${technician_name}...`);
    try {
      requests = await fetchSdpRequests(baseUrl, apiKey, technician_name);
      console.log(`[investigate_sdp] Found ${requests.length} open requests`);
    } catch (err: any) {
      console.error(`[investigate_sdp] Failed to fetch requests: ${err.message}`);
      errorCount++;
    }
  }

  let tasks: SdpItem[] = [];
  if (specificIds.length === 0 && include_tasks) {
    console.log(`[investigate_sdp] Fetching open SDP tasks for ${technician_name}...`);
    try {
      tasks = await fetchSdpTasks(baseUrl, apiKey, technician_name);
      console.log(`[investigate_sdp] Found ${tasks.length} open tasks`);
    } catch (err: any) {
      console.error(`[investigate_sdp] Failed to fetch tasks: ${err.message}`);
      errorCount++;
    }
  }

  // Build unified ticket list
  const allTickets: Array<{ item: SdpItem; sdpType: "request" | "task" }> = [
    ...requests.map((item) => ({ item, sdpType: "request" as const })),
    ...tasks.map((item) => ({ item, sdpType: "task" as const })),
  ];

  console.log(`[investigate_sdp] Total tickets to investigate: ${allTickets.length}`);

  if (dry_run) {
    for (const { item, sdpType } of allTickets) {
      const subject = (sdpType === "request" ? item.subject : item.title) || `SDP ${sdpType} #${item.id}`;
      results.push({
        sdp_type: sdpType,
        sdp_id: String(item.id),
        subject: subject.slice(0, 100),
        status: "would_investigate",
        detail: `${item.status?.name || "?"} | ${item.priority?.name || "?"}`,
      });
    }

    const duration = Date.now() - startTime;
    console.log(`\n[investigate_sdp] Dry run complete in ${(duration / 1000).toFixed(1)}s`);
    return {
      requests_found: requests.length,
      tasks_found: tasks.length,
      investigated: 0,
      notes_posted: 0,
      errors: errorCount,
      results,
    };
  }

  // ── Investigate in batches ──
  for (let i = 0; i < allTickets.length; i += max_concurrent) {
    const batch = allTickets.slice(i, i + max_concurrent);
    const batchNum = Math.floor(i / max_concurrent) + 1;
    const totalBatches = Math.ceil(allTickets.length / max_concurrent);
    console.log(`\n[investigate_sdp] ═══ Batch ${batchNum}/${totalBatches} (${batch.length} tickets) ═══`);

    // Submit all in this batch
    const jobs: Array<{
      sdpType: string;
      sdpId: string;
      subject: string;
      jobId?: string;
      error?: string;
    }> = [];

    for (const { item, sdpType } of batch) {
      const sdpId = String(item.id);
      const subject = (sdpType === "request" ? item.subject : item.title) || `SDP ${sdpType} #${sdpId}`;
      const description = item.description || subject;
      const sender = (sdpType === "request" ? item.requester?.name : item.owner?.name) || "SDP";

      console.log(`[investigate_sdp] Submitting ${sdpType} #${sdpId}: ${subject.slice(0, 60)}`);

      const submitResult = await submitInvestigation(
        sdpType,
        sdpId,
        subject,
        description.slice(0, 8000),
        sender,
      );

      if (submitResult.success && submitResult.jobId) {
        jobs.push({ sdpType, sdpId, subject, jobId: submitResult.jobId });
      } else {
        errorCount++;
        jobs.push({ sdpType, sdpId, subject, error: submitResult.error });
        results.push({
          sdp_type: sdpType, sdp_id: sdpId,
          subject: subject.slice(0, 100),
          status: "submit_failed",
          detail: submitResult.error,
        });
      }
    }

    // Wait for all jobs in this batch
    for (const job of jobs) {
      if (!job.jobId) continue;

      console.log(`[investigate_sdp] Waiting for ${job.sdpType} #${job.sdpId}...`);
      const jobResult = await waitForJob(job.jobId, investigation_timeout_ms);

      if (jobResult.success && jobResult.result) {
        investigated++;
        console.log(`[investigate_sdp] Investigation complete for ${job.sdpType} #${job.sdpId}`);

        // Format and post note
        const noteContent = formatInvestigationNote(jobResult.result);
        let noteResult: { success: boolean; note_id?: string; error?: string };

        if (job.sdpType === "request") {
          noteResult = await addRequestNote(job.sdpId, noteContent, baseUrl, apiKey);
        } else {
          noteResult = await addTaskWorklog(job.sdpId, noteContent, baseUrl, apiKey);
        }

        if (noteResult.success) {
          notesPosted++;
          console.log(`[investigate_sdp] Note posted to ${job.sdpType} #${job.sdpId} (note_id: ${noteResult.note_id})`);
          results.push({
            sdp_type: job.sdpType, sdp_id: job.sdpId,
            subject: job.subject.slice(0, 100),
            status: "note_posted",
            detail: `note_id=${noteResult.note_id}, severity=${jobResult.result.diagnosis?.severity || "?"}`,
          });
        } else {
          errorCount++;
          console.error(`[investigate_sdp] Note failed for ${job.sdpType} #${job.sdpId}: ${noteResult.error}`);
          results.push({
            sdp_type: job.sdpType, sdp_id: job.sdpId,
            subject: job.subject.slice(0, 100),
            status: "note_failed",
            detail: noteResult.error,
          });
        }
      } else {
        errorCount++;
        console.error(`[investigate_sdp] Investigation failed for ${job.sdpType} #${job.sdpId}: ${jobResult.error || "unknown"}`);
        results.push({
          sdp_type: job.sdpType, sdp_id: job.sdpId,
          subject: job.subject.slice(0, 100),
          status: "investigation_failed",
          detail: jobResult.error,
        });
      }
    }
  }

  const duration = Date.now() - startTime;
  console.log(`\n[investigate_sdp] Complete in ${(duration / 1000).toFixed(1)}s`);
  console.log(`[investigate_sdp] Requests: ${requests.length}, Tasks: ${tasks.length}`);
  console.log(`[investigate_sdp] Investigated: ${investigated}, Notes posted: ${notesPosted}, Errors: ${errorCount}`);

  return {
    requests_found: requests.length,
    tasks_found: tasks.length,
    investigated,
    notes_posted: notesPosted,
    errors: errorCount,
    results,
  };
}
