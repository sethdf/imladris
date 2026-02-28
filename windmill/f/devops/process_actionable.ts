// Windmill Script: Process Actionable Triage Items
// Reads unprocessed QUEUE/NOTIFY items from triage_results, creates SDP Tasks,
// optionally runs investigation pipeline, attaches findings as task notes.
// Only work-domain items flow to SDP (Decision 37).
//
// NOTE: SDP API calls are inlined (not via nested Windmill jobs) to avoid
// single-worker deadlock when process_actionable occupies the only bun worker.
// Investigation uses async job submission + polling to allow other workers to pick it up.

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

// ── SDP API (direct calls — no nested Windmill jobs) ──

const SDP_HEADERS = {
  Accept: "application/vnd.manageengine.sdp.v3+json",
  "Content-Type": "application/x-www-form-urlencoded",
};

async function createSdpTask(
  title: string,
  description: string,
  priority: string,
  owner: string,
  status: string,
  baseUrl: string,
  apiKey: string,
): Promise<{ success: boolean; task_id?: string; error?: string }> {
  try {
    const task: Record<string, unknown> = {
      title,
      description,
      priority: { name: priority },
      status: { name: status },
    };
    if (owner) task.owner = { name: owner };

    const inputData = JSON.stringify({ task });
    const response = await fetch(`${baseUrl}/tasks`, {
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
    const t = data.task || {};
    return { success: true, task_id: String(t.id || "") };
  } catch (err: any) {
    return { success: false, error: err.message?.slice(0, 300) };
  }
}

async function addTaskNote(
  taskId: string,
  noteContent: string,
  baseUrl: string,
  apiKey: string,
): Promise<{ success: boolean; note_id?: string; error?: string }> {
  try {
    // SDP Tasks use worklogs (not notes) for annotations
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

// ── Investigation via async Windmill job (avoids single-worker deadlock) ──

async function runInvestigation(
  source: string,
  content: string,
  itemId: string,
  classification: string,
): Promise<{ success: boolean; result: any; error?: string }> {
  const base = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
  const token = process.env.WM_TOKEN;
  const workspace = process.env.WM_WORKSPACE || "imladris";
  if (!token) return { success: false, result: null, error: "No WM_TOKEN" };

  try {
    // Submit job async (doesn't block the current worker)
    const submitResp = await fetch(
      `${base}/api/w/${workspace}/jobs/run/p/f/devops/investigate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ source, content, item_id: itemId, triage_classification: classification }),
      },
    );

    if (!submitResp.ok) {
      const body = await submitResp.text().catch(() => "");
      return { success: false, result: null, error: `Submit HTTP ${submitResp.status}: ${body.slice(0, 200)}` };
    }

    const jobId = await submitResp.text();
    const cleanJobId = jobId.replace(/"/g, "").trim();
    console.log(`[process_actionable] Investigation job submitted: ${cleanJobId}`);

    // Poll for result (max 180s) using get_result_maybe (always returns 200)
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));

      const statusResp = await fetch(
        `${base}/api/w/${workspace}/jobs_u/completed/get_result_maybe/${cleanJobId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!statusResp.ok) {
        const body = await statusResp.text().catch(() => "");
        console.log(`[process_actionable] Poll HTTP ${statusResp.status}: ${body.slice(0, 100)}`);
        continue; // retry on transient errors
      }

      const data = await statusResp.json();
      if (data.completed) {
        if (data.success === false) {
          return { success: false, result: data.result, error: String(data.result?.error || "Job failed") };
        }
        return { success: true, result: data.result };
      }
      // not completed yet, keep polling
    }

    return { success: false, result: null, error: "Investigation timed out after 180s" };
  } catch (err: any) {
    return { success: false, result: null, error: err.message?.slice(0, 300) };
  }
}

// ── Urgency → SDP Priority mapping ──

function mapUrgencyToPriority(urgency: string): string {
  switch (urgency.toLowerCase()) {
    case "critical": return "High";
    case "high": return "High";
    case "medium": return "Medium";
    case "low": return "Low";
    default: return "Medium";
  }
}

// ── Investigation result formatting ──

function formatInvestigationNote(investigation: any): string {
  if (!investigation) return "Investigation returned no results.";

  const sections: string[] = [];
  sections.push("## Investigation Report\n");

  if (investigation.diagnosis) {
    const d = investigation.diagnosis;
    sections.push(`**Root Cause:** ${d.root_cause || "UNKNOWN"}`);
    sections.push(`**Confidence:** ${d.confidence || "unknown"}`);
    sections.push(`**Impact:** ${d.impact || "Not assessed"}`);
    sections.push(`**Status:** ${d.status || "UNKNOWN"}`);

    if (d.evidence_citations?.length) {
      sections.push("\n**Evidence:**");
      for (const cite of d.evidence_citations) {
        sections.push(`- ${cite}`);
      }
    }

    if (d.proposed_fix) {
      sections.push("\n**Proposed Fix:**");
      sections.push(`- Action: ${d.proposed_fix.action || "None"}`);
      sections.push(`- Risk: ${d.proposed_fix.risk_level || "unknown"}`);
      if (d.proposed_fix.commands?.length) {
        sections.push("- Commands:");
        for (const cmd of d.proposed_fix.commands) {
          sections.push(`  \`${cmd}\``);
        }
      }
    }

    if (d.credential_gaps?.length) {
      sections.push("\n**Credential Gaps:**");
      for (const gap of d.credential_gaps) {
        sections.push(`- ${gap}`);
      }
    }
  }

  sections.push(`\n**Entities Found:** ${investigation.entities_found || 0}`);
  sections.push(`**Probes Run:** ${investigation.probes_run || 0} (${investigation.probes_successful || 0} successful)`);
  sections.push(`\n*Generated: ${investigation.timestamp || new Date().toISOString()}*`);

  return sections.join("\n");
}

// ── Main ──

export async function main(
  max_items: number = 20,
  priority_filter: string = "",
  skip_investigation: boolean = false,
  dry_run: boolean = false,
  delay_ms: number = 3000,
) {
  const startTime = Date.now();
  console.log(`[process_actionable] Starting: max_items=${max_items}, priority_filter="${priority_filter}", skip_investigation=${skip_investigation}, dry_run=${dry_run}`);

  // Load cache_lib for database access
  let cacheLib: any;
  try {
    cacheLib = await import("./cache_lib.ts");
    if (!cacheLib.isAvailable()) {
      return { error: "Cache not available — triage_results database required" };
    }
    cacheLib.init();
  } catch (err: any) {
    return { error: `Failed to load cache_lib: ${err.message?.slice(0, 200)}` };
  }

  // Get SDP credentials
  const baseUrl = (await getVariable("f/devops/sdp_base_url"))?.replace(/\/+$/, "");
  const apiKey = await getVariable("f/devops/sdp_api_key");
  if (!baseUrl || !apiKey) {
    return {
      error: "SDP credentials not configured",
      setup: "Set f/devops/sdp_base_url and f/devops/sdp_api_key in Windmill variables",
    };
  }

  // Query unprocessed actionable items
  const filter = priority_filter && ["QUEUE", "NOTIFY"].includes(priority_filter.toUpperCase())
    ? priority_filter.toUpperCase()
    : undefined;
  const items = cacheLib.getUnprocessedActionable(max_items * 3, filter);
  console.log(`[process_actionable] Found ${items.length} unprocessed actionable items`);

  if (items.length === 0) {
    return {
      tasks_created: 0, investigations_run: 0, notes_added: 0, errors: 0,
      message: "No unprocessed actionable items found",
    };
  }

  // Group by dedup_hash — pick the most recent per hash
  const grouped = new Map<string, typeof items[0]>();
  for (const item of items) {
    if (!grouped.has(item.dedup_hash)) {
      grouped.set(item.dedup_hash, item);
    }
  }

  const uniqueItems = Array.from(grouped.values()).slice(0, max_items);
  console.log(`[process_actionable] ${uniqueItems.length} unique items after dedup (from ${items.length} total)`);

  if (dry_run) {
    const preview = uniqueItems.map((item) => ({
      subject: item.subject,
      action: item.action,
      urgency: item.urgency,
      source: item.source,
      summary: item.summary,
      dedup_hash: item.dedup_hash.slice(0, 12) + "...",
      would_create_task: true,
      would_investigate: !skip_investigation,
      sdp_priority: mapUrgencyToPriority(item.urgency),
    }));
    return { dry_run: true, tasks_would_create: uniqueItems.length, items: preview };
  }

  // Process each unique item
  let tasksCreated = 0, investigationsRun = 0, notesAdded = 0, errorCount = 0;
  const results: Array<{
    subject: string; task_id?: string; investigated: boolean; note_added: boolean; error?: string;
  }> = [];

  for (let i = 0; i < uniqueItems.length; i++) {
    const item = uniqueItems[i];
    console.log(`\n[process_actionable] [${i + 1}/${uniqueItems.length}] Processing: ${item.subject.slice(0, 60)}`);

    if (i > 0 && delay_ms > 0) {
      await new Promise((r) => setTimeout(r, delay_ms));
    }

    const taskTitle = `[${item.action}/${item.urgency}] ${item.subject}`.slice(0, 200);
    const taskDescription = [
      `**Source:** ${item.source}`,
      `**Sender:** ${item.sender}`,
      `**Summary:** ${item.summary}`,
      `**Received:** ${item.received_at}`,
      `**Classified by:** ${item.classified_by}`,
      `**Urgency:** ${item.urgency}`,
      `**Domain:** ${item.domain}`,
    ].join("\n");
    const sdpPriority = mapUrgencyToPriority(item.urgency);

    // Step 1: Create SDP Task (direct API call — no nested job)
    let taskId: string | undefined;
    const taskResult = await createSdpTask(
      taskTitle, taskDescription, sdpPriority, "Seth Foley", "Open", baseUrl, apiKey,
    );

    if (taskResult.success && taskResult.task_id) {
      taskId = taskResult.task_id;
      tasksCreated++;
      console.log(`[process_actionable] Created task #${taskId}: ${taskTitle.slice(0, 60)}`);
    } else {
      errorCount++;
      console.error(`[process_actionable] Task creation failed: ${taskResult.error}`);
      results.push({
        subject: item.subject.slice(0, 100), investigated: false, note_added: false,
        error: `Task creation: ${taskResult.error}`,
      });
      continue;
    }

    // Step 2: Optionally run investigation (async job + poll)
    let investigated = false;
    let noteAdded = false;

    if (!skip_investigation && taskId) {
      let content = item.subject;
      try {
        const meta = JSON.parse(item.metadata || "{}");
        if (meta.preview) content = `${item.subject}\n\n${meta.preview}`;
      } catch { /* use subject as fallback */ }

      console.log(`[process_actionable] Running investigation for task #${taskId}...`);
      const invResult = await runInvestigation(
        item.source, content, `task-${taskId}`, item.action,
      );

      if (invResult.success) {
        investigated = true;
        investigationsRun++;

        // Step 3: Add investigation note to task
        const noteContent = formatInvestigationNote(invResult.result);
        const noteResult = await addTaskNote(taskId, noteContent, baseUrl, apiKey);
        if (noteResult.success) {
          noteAdded = true;
          notesAdded++;
          console.log(`[process_actionable] Note added to task #${taskId}`);
        } else {
          console.error(`[process_actionable] Note failed for task #${taskId}: ${noteResult.error}`);
        }
      } else {
        console.error(`[process_actionable] Investigation failed: ${invResult.error?.slice(0, 200)}`);
      }
    }

    // Step 4: Update triage_results with task_id
    if (taskId) {
      try {
        const updated = cacheLib.updateTaskId(item.dedup_hash, taskId);
        console.log(`[process_actionable] Updated ${updated} triage_results rows with task_id=${taskId}`);
      } catch (err: any) {
        console.error(`[process_actionable] Failed to update task_id: ${err.message?.slice(0, 100)}`);
      }
    }

    results.push({ subject: item.subject.slice(0, 100), task_id: taskId, investigated, note_added: noteAdded });
  }

  const duration = Date.now() - startTime;
  console.log(`\n[process_actionable] Complete in ${(duration / 1000).toFixed(1)}s`);
  console.log(`[process_actionable] Tasks: ${tasksCreated}, Investigations: ${investigationsRun}, Notes: ${notesAdded}, Errors: ${errorCount}`);

  return { tasks_created: tasksCreated, investigations_run: investigationsRun, notes_added: notesAdded, errors: errorCount, duration_s: Math.round(duration / 1000), results };
}
