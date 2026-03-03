// Windmill Script: Process Actionable Triage Items — Investigate-First Pipeline
// Three-phase pipeline:
//   Phase 1 (INVESTIGATE): Run investigations on uninvestigated + retry-eligible items
//   Phase 2 (CREATE TASKS): Create SDP Tasks only for substantial investigation findings
//   Phase 3 (ESCALATE): Create tasks for stale items that exhausted retry attempts
// Nothing is ever lost — items get tasks with findings or escalation tasks explaining gaps.
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
  pollTimeoutMs: number = 600000,
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
    console.log(`[process_actionable] Investigation job submitted: ${cleanJobId} (timeout ${Math.round(pollTimeoutMs / 1000)}s)`);

    // Poll for result using get_result_maybe (always returns 200)
    const deadline = Date.now() + pollTimeoutMs;
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

    return { success: false, result: null, error: `Investigation timed out after ${Math.round(pollTimeoutMs / 1000)}s` };
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

// ── AI Risk Evaluation ──

function evaluateRisk(investigation: any): {
  interruption_risk: string;
  fix_likelihood: string;
  ai_fixable: string;
  rollback_steps: string[];
} {
  const defaults = {
    interruption_risk: "Unknown — no investigation data",
    fix_likelihood: "Unknown — no investigation data",
    ai_fixable: "Unknown — insufficient context",
    rollback_steps: ["Review the original alert/notification for context", "Assess current system state manually", "Escalate to team lead if unclear"],
  };
  if (!investigation?.diagnosis) return defaults;

  const d = investigation.diagnosis;
  const fix = d.proposed_fix;

  // Interruption risk — based on proposed fix risk level and status
  let interruptionRisk = "Low — no remediation action proposed";
  if (fix) {
    const riskLevel = (fix.risk_level || "").toLowerCase();
    if (riskLevel === "high") {
      interruptionRisk = "High — proposed fix involves high-risk changes that could disrupt services";
    } else if (riskLevel === "medium") {
      interruptionRisk = "Medium — proposed fix may cause brief interruption during application";
    } else if (riskLevel === "low") {
      interruptionRisk = "Low — proposed fix is low-risk with minimal disruption expected";
    }
  }
  if (d.status === "NEEDS-ESCALATION") {
    interruptionRisk = "High — issue requires escalation, potential for wider impact";
  }

  // Fix likelihood — based on confidence and evidence
  let fixLikelihood = "Low — insufficient evidence for reliable fix";
  const confidence = (d.confidence || "").toLowerCase();
  if (confidence === "high" && fix?.action) {
    fixLikelihood = "High — diagnosis is high-confidence with specific remediation steps";
  } else if (confidence === "medium" && fix?.action) {
    fixLikelihood = "Medium — diagnosis has moderate confidence, fix may need iteration";
  } else if (confidence === "low") {
    fixLikelihood = "Low — diagnosis is low-confidence, fix is speculative";
  } else if (!fix?.action) {
    fixLikelihood = "N/A — no specific fix proposed";
  }

  // AI fixable — can automation handle this?
  let aiFix = "No — requires manual investigation";
  if (fix?.commands?.length > 0 && confidence !== "low") {
    if ((fix.risk_level || "").toLowerCase() === "low" && fix.commands.length <= 3) {
      aiFix = "Yes — specific low-risk commands identified, automatable";
    } else if ((fix.risk_level || "").toLowerCase() === "medium") {
      aiFix = "Possibly — commands identified but medium risk, recommend human review";
    } else {
      aiFix = "No — high-risk or complex remediation, requires human oversight";
    }
  } else if (d.status === "INFO-ONLY") {
    aiFix = "N/A — informational item, no fix needed";
  }

  // Rollback steps — derived from proposed fix
  const rollbackSteps: string[] = [];
  if (fix?.commands?.length > 0) {
    rollbackSteps.push("Document current state before applying any changes");
    for (const cmd of fix.commands) {
      rollbackSteps.push(`If \`${cmd}\` was run, verify the change and revert if needed`);
    }
    rollbackSteps.push("Verify service health after rollback");
  } else {
    rollbackSteps.push("Review the original alert/notification for context");
    rollbackSteps.push("Check current resource state in AWS Console or via Steampipe");
    rollbackSteps.push("Assess whether any automated changes were applied");
    rollbackSteps.push("Escalate to team lead if system state is unclear");
  }

  return { interruption_risk: interruptionRisk, fix_likelihood: fixLikelihood, ai_fixable: aiFix, rollback_steps: rollbackSteps };
}

function formatRiskSection(evaluation: ReturnType<typeof evaluateRisk>): string {
  const lines = [
    `\n\n**🔍 AI Risk Evaluation:**`,
    `- **Interruption Risk:** ${evaluation.interruption_risk}`,
    `- **Fix Likelihood:** ${evaluation.fix_likelihood}`,
    `- **AI-Fixable:** ${evaluation.ai_fixable}`,
    `\n**🔄 Manual Rollback Steps:**`,
    ...evaluation.rollback_steps.map((s, i) => `${i + 1}. ${s}`),
  ];
  return lines.join("\n");
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

// ── Quality Gate — classify investigation output ──

function assessInvestigationQuality(
  result: any,
  success: boolean,
): { quality: string; reason: string } {
  // Priority: error > substantial > waiting_context > empty
  // Substantial requires BOTH probe data AND a coherent diagnosis.
  // Probes alone (with failed/low-confidence synthesis) are not actionable.
  if (!success || !result) {
    return { quality: "error", reason: "Investigation job failed or timed out" };
  }

  const diag = result.diagnosis;
  const hasCoherentDiagnosis = diag
    && diag.confidence !== "low"
    && diag.root_cause
    && !diag.root_cause.includes("UNKNOWN")
    && !diag.root_cause.includes("AI synthesis failed");

  // Substantial: probes returned data AND diagnosis is coherent
  if (result.probes_successful > 0 && hasCoherentDiagnosis) {
    const credNote = result.needs_credential?.length > 0
      ? ` (also missing: ${result.needs_credential.map((c: any) => c.needed).join(", ")})`
      : "";
    return {
      quality: "substantial",
      reason: `${result.probes_successful || 0} probes successful, ${result.entities_found || 0} entities found, confidence: ${diag.confidence}${credNote}`,
    };
  }

  // Probes hit but diagnosis failed — not actionable yet, retry later
  if (result.probes_successful > 0 && !hasCoherentDiagnosis) {
    const reason = diag?.status_reason || diag?.root_cause || "diagnosis incomplete";
    return {
      quality: "waiting_context",
      reason: `Probes succeeded but diagnosis failed: ${reason.slice(0, 150)}`,
    };
  }

  if (result.needs_credential?.length > 0) {
    return {
      quality: "waiting_context",
      reason: `Missing credentials: ${result.needs_credential.map((c: any) => c.needed).join(", ")}`,
    };
  }

  return {
    quality: "empty",
    reason: "No entities found and no missing credentials — nothing to investigate",
  };
}

// ── Dedup helper — pick one per hash ──

function dedup<T extends { dedup_hash: string }>(items: T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    if (!seen.has(item.dedup_hash)) {
      seen.set(item.dedup_hash, item);
    }
  }
  return Array.from(seen.values());
}

// ── Main — Three-Phase Investigate-First Pipeline ──

export async function main(
  max_items: number = 20,
  priority_filter: string = "",
  skip_investigation: boolean = false,
  dry_run: boolean = false,
  delay_ms: number = 3000,
  retry_interval_hours: number = 6,
  max_retry_attempts: number = 5,
  max_concurrency: number = 20,
) {
  const startTime = Date.now();
  console.log(`[process_actionable] Starting: max_items=${max_items}, priority_filter="${priority_filter}", skip_investigation=${skip_investigation}, dry_run=${dry_run}, max_concurrency=${max_concurrency}, retry_interval_hours=${retry_interval_hours}, max_retry_attempts=${max_retry_attempts}`);

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

  const retryAfterSeconds = retry_interval_hours * 3600;
  const filter = priority_filter && ["QUEUE", "NOTIFY"].includes(priority_filter.toUpperCase())
    ? priority_filter.toUpperCase()
    : undefined;

  // Counters
  let phase1Investigated = 0, phase1WaitingContext = 0, phase1Substantial = 0;
  let phase1Empty = 0, phase1Errors = 0;
  let phase2TasksCreated = 0, phase2NotesAdded = 0;
  let phase3Escalated = 0;
  let errorCount = 0;
  const results: Array<{
    phase: string; subject: string; dedup_hash_short: string;
    quality?: string; task_id?: string; error?: string;
  }> = [];

  // ════════════════════════════════════════════════════
  // PHASE 1: INVESTIGATE
  // ════════════════════════════════════════════════════
  console.log(`\n[process_actionable] ═══ PHASE 1: INVESTIGATE ═══`);

  // Fetch uninvestigated items
  const uninvestigated = dedup(cacheLib.getUninvestigatedActionable(max_items * 3, filter));
  console.log(`[process_actionable] Uninvestigated items: ${uninvestigated.length}`);

  // Fetch retry-eligible waiting_context items
  const waitingRetry = dedup(cacheLib.getWaitingContextItems(retryAfterSeconds, max_retry_attempts, max_items * 3));
  console.log(`[process_actionable] Retry-eligible waiting_context items: ${waitingRetry.length}`);

  // Combine and cap at max_items
  const toInvestigate = [...uninvestigated, ...waitingRetry].slice(0, max_items);
  console.log(`[process_actionable] Total to investigate: ${toInvestigate.length}`);

  if (dry_run) {
    // Preview mode — show what would happen across all phases
    const readyForTask = dedup(cacheLib.getInvestigatedReadyForTask(max_items));
    const stale = dedup(cacheLib.getStaleItems(max_retry_attempts, max_items));

    const preview = {
      dry_run: true,
      phase1_would_investigate: toInvestigate.length,
      phase1_items: toInvestigate.map((item: any) => ({
        subject: item.subject, action: item.action, urgency: item.urgency,
        source: item.source, dedup_hash: item.dedup_hash.slice(0, 12) + "...",
        is_retry: waitingRetry.some((w: any) => w.dedup_hash === item.dedup_hash),
      })),
      phase2_would_create_tasks: readyForTask.length,
      phase2_items: readyForTask.map((item: any) => ({
        subject: item.subject, urgency: item.urgency,
        sdp_priority: mapUrgencyToPriority(item.urgency),
      })),
      phase3_would_escalate: stale.length,
      phase3_items: stale.map((item: any) => ({
        subject: item.subject, investigation_status: item.investigation_status,
        attempts: item.investigation_attempts,
      })),
    };
    return preview;
  }

  if (!skip_investigation) {
    const concurrency = Math.min(toInvestigate.length, max_concurrency);
    const totalBatches = Math.ceil(toInvestigate.length / concurrency);
    console.log(`[process_actionable] Running ${toInvestigate.length} investigations with concurrency=${concurrency} (${totalBatches} batch${totalBatches > 1 ? "es" : ""})`);

    // Poll timeout scales with concurrency to account for Windmill job queue wait time
    const pollTimeout = Math.max(600000, concurrency * 30000);

    for (let batchStart = 0; batchStart < toInvestigate.length; batchStart += concurrency) {
      const batch = toInvestigate.slice(batchStart, batchStart + concurrency);
      const batchNum = Math.floor(batchStart / concurrency) + 1;
      console.log(`\n[process_actionable] [P1] ── Batch ${batchNum}/${totalBatches}: launching ${batch.length} investigations in parallel ──`);

      const promises = batch.map(async (item: any, idx: number) => {
        const globalIdx = batchStart + idx;
        const hashShort = item.dedup_hash.slice(0, 12);
        console.log(`[process_actionable] [P1 ${globalIdx + 1}/${toInvestigate.length}] Submitting: ${item.subject.slice(0, 60)}`);

        // Build investigation content
        let content = item.subject;
        try {
          const meta = JSON.parse(item.metadata || "{}");
          if (meta.preview) content = `${item.subject}\n\n${meta.preview}`;
        } catch { /* use subject as fallback */ }

        // Run investigation (async job + poll — avoids single-worker deadlock)
        const invResult = await runInvestigation(
          item.source, content, `triage-${item.id}`, item.action, pollTimeout,
        );

        return { item, hashShort, invResult, globalIdx };
      });

      const settled = await Promise.allSettled(promises);

      // Process batch results
      for (const outcome of settled) {
        if (outcome.status === "rejected") {
          phase1Errors++;
          console.error(`[process_actionable] [P1] Investigation promise rejected: ${String(outcome.reason).slice(0, 200)}`);
          continue;
        }

        const { item, hashShort, invResult } = outcome.value;

        // Assess quality
        const assessment = assessInvestigationQuality(invResult.result, invResult.success);
        console.log(`[process_actionable] [P1] ${hashShort} Quality: ${assessment.quality} — ${assessment.reason.slice(0, 120)}`);

        // Update investigation status in DB
        const invResultJson = invResult.success ? JSON.stringify(invResult.result) : null;
        const waitingReason = assessment.quality === "waiting_context" && invResult.result?.needs_credential
          ? JSON.stringify(invResult.result.needs_credential)
          : null;

        cacheLib.updateInvestigationStatus(
          item.dedup_hash, assessment.quality, invResultJson, waitingReason,
        );

        phase1Investigated++;
        switch (assessment.quality) {
          case "substantial": phase1Substantial++; break;
          case "waiting_context":
            phase1WaitingContext++;
            break;
          case "empty": phase1Empty++; break;
          case "error": phase1Errors++; break;
        }

        results.push({
          phase: "investigate", subject: item.subject.slice(0, 100),
          dedup_hash_short: hashShort, quality: assessment.quality,
        });
      }

      console.log(`[process_actionable] [P1] Batch ${batchNum} complete: ${settled.length} results processed`);
    }
  } else {
    console.log(`[process_actionable] Skipping investigation (skip_investigation=true)`);
  }

  console.log(`[process_actionable] Phase 1 complete: investigated=${phase1Investigated}, substantial=${phase1Substantial}, waiting_context=${phase1WaitingContext}, empty=${phase1Empty}, errors=${phase1Errors}`);

  // ════════════════════════════════════════════════════
  // PHASE 2: CREATE TASKS (for substantial findings)
  // ════════════════════════════════════════════════════
  console.log(`\n[process_actionable] ═══ PHASE 2: CREATE TASKS ═══`);

  const readyItems = dedup(cacheLib.getInvestigatedReadyForTask(max_items));
  console.log(`[process_actionable] Items ready for task creation: ${readyItems.length}`);

  for (let i = 0; i < readyItems.length; i++) {
    const item = readyItems[i];
    const hashShort = item.dedup_hash.slice(0, 12);
    console.log(`\n[process_actionable] [P2 ${i + 1}/${readyItems.length}] Creating task: ${item.subject.slice(0, 60)}`);

    if (i > 0 && delay_ms > 0) {
      await new Promise((r) => setTimeout(r, delay_ms));
    }

    // Parse investigation result for task description
    let investigationSummary = "";
    let riskSection = "";
    let investigationFull: any = null;
    try {
      investigationFull = JSON.parse((item as any).investigation_result || "null");
      if (investigationFull?.diagnosis) {
        const d = investigationFull.diagnosis;
        investigationSummary = `\n\n**Investigation Summary:**\n- Root Cause: ${d.root_cause || "UNKNOWN"}\n- Confidence: ${d.confidence || "unknown"}\n- Impact: ${d.impact || "Not assessed"}\n- Probes: ${investigationFull.probes_successful || 0}/${investigationFull.probes_run || 0} successful`;
      }
      // AI risk evaluation + rollback steps
      const riskEval = evaluateRisk(investigationFull);
      riskSection = formatRiskSection(riskEval);
    } catch { /* no investigation result to parse */ }

    const taskTitle = `[${item.action}/${item.urgency}] ${item.subject}`.slice(0, 200);
    const taskDescription = [
      `**Source:** ${item.source}`,
      `**Sender:** ${item.sender}`,
      `**Summary:** ${item.summary}`,
      `**Received:** ${item.received_at}`,
      `**Classified by:** ${item.classified_by}`,
      `**Urgency:** ${item.urgency}`,
      `**Domain:** ${item.domain}`,
      investigationSummary,
      riskSection,
    ].join("\n");
    const sdpPriority = mapUrgencyToPriority(item.urgency);

    // Create SDP Task
    const taskResult = await createSdpTask(
      taskTitle, taskDescription, sdpPriority, "Seth Foley", "Open", baseUrl, apiKey,
    );

    if (taskResult.success && taskResult.task_id) {
      phase2TasksCreated++;
      console.log(`[process_actionable] Created task #${taskResult.task_id}`);

      // Add investigation worklog
      if (investigationFull) {
        const noteContent = formatInvestigationNote(investigationFull);
        const noteResult = await addTaskNote(taskResult.task_id, noteContent, baseUrl, apiKey);
        if (noteResult.success) {
          phase2NotesAdded++;
          console.log(`[process_actionable] Worklog added to task #${taskResult.task_id}`);
        } else {
          console.error(`[process_actionable] Worklog failed: ${noteResult.error}`);
        }
      }

      // Update task_id in triage_results
      cacheLib.updateTaskId(item.dedup_hash, taskResult.task_id);

      results.push({
        phase: "create_task", subject: item.subject.slice(0, 100),
        dedup_hash_short: hashShort, task_id: taskResult.task_id,
      });
    } else {
      errorCount++;
      console.error(`[process_actionable] Task creation failed: ${taskResult.error}`);
      results.push({
        phase: "create_task", subject: item.subject.slice(0, 100),
        dedup_hash_short: hashShort, error: `Task creation: ${taskResult.error}`,
      });
    }
  }

  console.log(`[process_actionable] Phase 2 complete: tasks_created=${phase2TasksCreated}, notes_added=${phase2NotesAdded}`);

  // ════════════════════════════════════════════════════
  // PHASE 3: ESCALATE STALE (items that exhausted retries)
  // ════════════════════════════════════════════════════
  console.log(`\n[process_actionable] ═══ PHASE 3: ESCALATE STALE ═══`);

  const staleItems = dedup(cacheLib.getStaleItems(max_retry_attempts, max_items));
  console.log(`[process_actionable] Stale items to escalate: ${staleItems.length}`);

  for (let i = 0; i < staleItems.length; i++) {
    const item = staleItems[i];
    const hashShort = item.dedup_hash.slice(0, 12);
    console.log(`\n[process_actionable] [P3 ${i + 1}/${staleItems.length}] Escalating: ${item.subject.slice(0, 60)}`);

    if (i > 0 && delay_ms > 0) {
      await new Promise((r) => setTimeout(r, delay_ms));
    }

    // Build escalation description based on why investigation failed
    let escalationNote = "";
    const invStatus = (item as any).investigation_status;

    if (invStatus === "waiting_context") {
      let credentials: any[] = [];
      try {
        credentials = JSON.parse((item as any).waiting_context_reason || "[]");
      } catch { /* use empty */ }

      const credList = credentials.map((c: any) =>
        `- **${c.needed}**: ${c.description || c.entity_type} (Action: ${c.action || "Install plugin"})`
      ).join("\n");

      escalationNote = [
        `\n\n**⚠️ Investigation Blocked — Missing Credentials/Plugins**`,
        `This item could not be fully investigated after ${(item as any).investigation_attempts || max_retry_attempts} attempts.`,
        `\n**Required credentials/plugins:**`,
        credList || "- Unknown (see waiting_context_reason in triage DB)",
        `\n**Setup instructions:**`,
        `Configure credentials in Bitwarden Secrets (BWS) and install the required Steampipe plugin(s).`,
        `See: https://hub.steampipe.io/plugins for plugin installation.`,
      ].join("\n");
    } else if (invStatus === "empty") {
      escalationNote = [
        `\n\n**ℹ️ Investigation Inconclusive**`,
        `No entities could be extracted from this item after ${(item as any).investigation_attempts || max_retry_attempts} attempts.`,
        `No missing credentials were identified — the item may need manual review.`,
      ].join("\n");
    } else if (invStatus === "error") {
      escalationNote = [
        `\n\n**❌ Investigation Failed**`,
        `The investigation pipeline encountered errors after ${(item as any).investigation_attempts || max_retry_attempts} attempts.`,
        `This item requires manual investigation.`,
      ].join("\n");
    }

    // Risk evaluation for escalated items (no investigation data available)
    const escalationRisk = evaluateRisk(null);
    const escalationRiskSection = formatRiskSection(escalationRisk);

    const taskTitle = `[ESCALATED/${item.urgency}] ${item.subject}`.slice(0, 200);
    const taskDescription = [
      `**Source:** ${item.source}`,
      `**Sender:** ${item.sender}`,
      `**Summary:** ${item.summary}`,
      `**Received:** ${item.received_at}`,
      `**Classified by:** ${item.classified_by}`,
      `**Urgency:** ${item.urgency}`,
      `**Domain:** ${item.domain}`,
      escalationNote,
      escalationRiskSection,
    ].join("\n");
    const sdpPriority = mapUrgencyToPriority(item.urgency);

    // Create escalation task
    const taskResult = await createSdpTask(
      taskTitle, taskDescription, sdpPriority, "Seth Foley", "Open", baseUrl, apiKey,
    );

    if (taskResult.success && taskResult.task_id) {
      phase3Escalated++;
      console.log(`[process_actionable] Escalated to task #${taskResult.task_id}`);

      // Mark as escalated and set task_id
      cacheLib.updateInvestigationStatus(item.dedup_hash, "escalated");
      cacheLib.updateTaskId(item.dedup_hash, taskResult.task_id);

      results.push({
        phase: "escalate", subject: item.subject.slice(0, 100),
        dedup_hash_short: hashShort, task_id: taskResult.task_id,
      });
    } else {
      errorCount++;
      console.error(`[process_actionable] Escalation task creation failed: ${taskResult.error}`);
      results.push({
        phase: "escalate", subject: item.subject.slice(0, 100),
        dedup_hash_short: hashShort, error: `Escalation: ${taskResult.error}`,
      });
    }
  }

  console.log(`[process_actionable] Phase 3 complete: escalated=${phase3Escalated}`);

  // ═══ SUMMARY ═══
  const duration = Date.now() - startTime;
  console.log(`\n[process_actionable] Complete in ${(duration / 1000).toFixed(1)}s`);
  console.log(`[process_actionable] P1: investigated=${phase1Investigated} (substantial=${phase1Substantial}, waiting=${phase1WaitingContext}, empty=${phase1Empty}, errors=${phase1Errors})`);
  console.log(`[process_actionable] P2: tasks=${phase2TasksCreated}, notes=${phase2NotesAdded}`);
  console.log(`[process_actionable] P3: escalated=${phase3Escalated}`);

  return {
    phase1_investigated: phase1Investigated,
    phase1_waiting_context: phase1WaitingContext,
    phase1_substantial: phase1Substantial,
    phase1_empty: phase1Empty,
    phase1_errors: phase1Errors,
    phase1_concurrency: max_concurrency,
    phase2_tasks_created: phase2TasksCreated,
    phase2_notes_added: phase2NotesAdded,
    phase3_escalated: phase3Escalated,
    errors: errorCount,
    duration_s: Math.round(duration / 1000),
    results,
  };
}
