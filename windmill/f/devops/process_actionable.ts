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

/** Post investigation result back to the originating SDP item as a comment */
async function postSdpInvestigationComment(
  item: any,
  investigationFull: any,
  baseUrl: string,
  apiKey: string,
): Promise<{ success: boolean; error?: string }> {
  let meta: any = {};
  try { meta = JSON.parse(item.metadata || "{}"); } catch { /* empty */ }

  const sdpType = meta.sdp_type;
  const sdpId = meta.sdp_id;
  if (!sdpType || !sdpId) return { success: false, error: "No sdp_type/sdp_id in metadata" };

  const noteContent = formatInvestigationNote(investigationFull);

  if (sdpType === "request") {
    return addRequestNote(sdpId, noteContent, baseUrl, apiKey);
  } else if (sdpType === "task") {
    return addTaskNote(sdpId, noteContent, baseUrl, apiKey);
  }
  return { success: false, error: `Unknown sdp_type: ${sdpType}` };
}

// ── Investigation submission (fire-and-forget, no polling) ──

async function submitInvestigation(
  source: string,
  subject: string,
  body: string,
  sender: string,
  itemId: string,
  classification: string,
  dedupHash: string,
  relatedAlerts: string[] = [],
): Promise<{ success: boolean; jobId?: string; error?: string }> {
  const base = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
  const token = process.env.WM_TOKEN;
  const workspace = process.env.WM_WORKSPACE || "imladris";
  if (!token) return { success: false, error: "No WM_TOKEN" };

  try {
    const submitResp = await fetch(
      `${base}/api/w/${workspace}/jobs/run/p/f/devops/agentic_investigator`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source, subject, body, sender, item_id: itemId,
          triage_classification: classification, related_alerts: relatedAlerts,
          dedup_hash: dedupHash,
        }),
      },
    );

    if (!submitResp.ok) {
      const respBody = await submitResp.text().catch(() => "");
      return { success: false, error: `Submit HTTP ${submitResp.status}: ${respBody.slice(0, 200)}` };
    }

    const jobId = (await submitResp.text()).replace(/"/g, "").trim();
    return { success: true, jobId };
  } catch (err: any) {
    return { success: false, error: err.message?.slice(0, 300) };
  }
}

// ── Investigation status check (one-shot, no polling loop) ──

async function checkInvestigationJobStatus(
  windmillJobId: string,
): Promise<{ completed: boolean; success?: boolean; cancelled?: boolean; result?: any }> {
  const base = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
  const token = process.env.WM_TOKEN;
  const workspace = process.env.WM_WORKSPACE || "imladris";
  if (!token) return { completed: false };

  try {
    const resp = await fetch(
      `${base}/api/w/${workspace}/jobs_u/completed/get_result_maybe/${windmillJobId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) return { completed: false };
    const data = await resp.json();
    if (!data.completed) return { completed: false };
    return { completed: true, success: data.success !== false, result: data.result };
  } catch {
    return { completed: false };
  }
}

// ── HTML formatting helpers for SDP ──

function esc(text: string): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#dc3545",
  high: "#fd7e14",
  medium: "#ffc107",
  low: "#28a745",
  informational: "#17a2b8",
  unknown: "#6c757d",
};

function severityBadge(severity: string): string {
  const s = (severity || "unknown").toLowerCase();
  const color = SEVERITY_COLORS[s] || SEVERITY_COLORS.unknown;
  const textColor = s === "medium" ? "#000" : "#fff";
  return `<span style="display:inline-block;padding:2px 8px;border-radius:3px;background:${color};color:${textColor};font-weight:bold;font-size:11px;text-transform:uppercase">${esc(severity)}</span>`;
}

function confidenceBadge(confidence: string): string {
  const colors: Record<string, string> = { high: "#28a745", medium: "#ffc107", low: "#dc3545" };
  const c = (confidence || "unknown").toLowerCase();
  const color = colors[c] || "#6c757d";
  const textColor = c === "medium" ? "#000" : "#fff";
  return `<span style="display:inline-block;padding:2px 8px;border-radius:3px;background:${color};color:${textColor};font-weight:bold;font-size:11px;text-transform:uppercase">${esc(confidence)}</span>`;
}

function sectionHeader(title: string, emoji: string = ""): string {
  return `<h3 style="margin:16px 0 8px 0;padding-bottom:4px;border-bottom:1px solid #dee2e6;color:#333">${emoji ? emoji + " " : ""}${esc(title)}</h3>`;
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
  const severity = (d.severity || "").toLowerCase();
  const confidence = (d.confidence || "").toLowerCase();
  const actions = d.recommended_actions || [];

  // Interruption risk — based on severity and recommended actions
  let interruptionRisk = "Low — no remediation action proposed";
  if (severity === "critical" || severity === "high") {
    interruptionRisk = "High — critical/high severity issue may require urgent remediation";
  } else if (severity === "medium") {
    interruptionRisk = "Medium — issue may require attention but is not immediately impactful";
  } else if (severity === "low") {
    interruptionRisk = "Low — low severity, likely informational or self-resolving";
  }

  // Fix likelihood — based on confidence and evidence
  let fixLikelihood = "Low — insufficient evidence for reliable fix";
  if (confidence === "high" && actions.length > 0) {
    fixLikelihood = "High — diagnosis is high-confidence with specific recommendations";
  } else if (confidence === "medium" && actions.length > 0) {
    fixLikelihood = "Medium — diagnosis has moderate confidence, recommendations may need iteration";
  } else if (confidence === "low") {
    fixLikelihood = "Low — diagnosis is low-confidence, recommendations are speculative";
  } else if (actions.length === 0) {
    fixLikelihood = "N/A — no specific actions proposed";
  }

  // AI fixable — read-only investigation, actions are recommendations
  let aiFix = "No — investigation is read-only, actions require human review";
  if (severity === "low" && confidence === "high") {
    aiFix = "N/A — low severity, likely informational or self-resolving";
  }

  // Rollback steps — generic since agentic investigator is read-only
  const rollbackSteps: string[] = [
    "Review the recommended actions from the investigation",
    "Verify current system state before taking any action",
    "Apply recommended actions one at a time with verification",
    "Escalate to team lead if situation is unclear",
  ];

  return { interruption_risk: interruptionRisk, fix_likelihood: fixLikelihood, ai_fixable: aiFix, rollback_steps: rollbackSteps };
}

function formatRiskSection(evaluation: ReturnType<typeof evaluateRisk>): string {
  const rows = [
    `<tr><td style="padding:4px 8px;font-weight:bold;white-space:nowrap">Interruption Risk</td><td style="padding:4px 8px">${esc(evaluation.interruption_risk)}</td></tr>`,
    `<tr><td style="padding:4px 8px;font-weight:bold;white-space:nowrap">Fix Likelihood</td><td style="padding:4px 8px">${esc(evaluation.fix_likelihood)}</td></tr>`,
    `<tr><td style="padding:4px 8px;font-weight:bold;white-space:nowrap">AI-Fixable</td><td style="padding:4px 8px">${esc(evaluation.ai_fixable)}</td></tr>`,
  ].join("");

  const steps = evaluation.rollback_steps
    .map((s) => `<li style="margin:2px 0">${esc(s)}</li>`)
    .join("");

  return [
    sectionHeader("AI Risk Evaluation", "\uD83D\uDD0D"),
    `<table style="border-collapse:collapse;width:100%;margin:8px 0">${rows}</table>`,
    sectionHeader("Manual Rollback Steps", "\uD83D\uDD04"),
    `<ol style="margin:4px 0;padding-left:24px">${steps}</ol>`,
  ].join("");
}

// ── Investigation result formatting ──

function formatInvestigationNote(investigation: any): string {
  if (!investigation) return "<p>Investigation returned no results.</p>";

  const parts: string[] = [];
  parts.push(sectionHeader("Investigation Report", "\uD83D\uDCCB"));

  if (investigation.diagnosis) {
    const d = investigation.diagnosis;

    // Key metrics row
    parts.push(`<table style="border-collapse:collapse;margin:8px 0;width:100%">`);
    parts.push(`<tr><td style="padding:6px 12px;font-weight:bold;width:120px">Severity</td><td style="padding:6px 12px">${severityBadge(d.severity || "unknown")}</td></tr>`);
    parts.push(`<tr><td style="padding:6px 12px;font-weight:bold">Confidence</td><td style="padding:6px 12px">${confidenceBadge(d.confidence || "unknown")}</td></tr>`);
    parts.push(`<tr><td style="padding:6px 12px;font-weight:bold;vertical-align:top">Root Cause</td><td style="padding:6px 12px">${esc(d.root_cause || "UNKNOWN")}</td></tr>`);
    parts.push(`</table>`);

    if (d.summary) {
      parts.push(`<div style="margin:12px 0;padding:10px 14px;background:#f8f9fa;border-left:4px solid #6c757d;border-radius:2px">${esc(d.summary)}</div>`);
    }

    if (d.evidence?.length) {
      parts.push(sectionHeader("Evidence"));
      parts.push(`<ul style="margin:4px 0;padding-left:24px">`);
      for (const e of d.evidence) {
        parts.push(`<li style="margin:4px 0">${esc(String(e))}</li>`);
      }
      parts.push(`</ul>`);
    }

    if (d.criteria_status?.length) {
      parts.push(sectionHeader("Investigation Criteria"));
      const statusColors: Record<string, string> = {
        verified: "#28a745", needs_data_source: "#ffc107", unresolvable: "#ffc107", unverified: "#dc3545", partial: "#fd7e14",
      };
      parts.push(`<table style="border-collapse:collapse;width:100%;margin:8px 0">`);
      parts.push(`<tr style="background:#f1f3f5"><th style="padding:6px 8px;text-align:left;border-bottom:2px solid #dee2e6">Status</th><th style="padding:6px 8px;text-align:left;border-bottom:2px solid #dee2e6">Criterion</th><th style="padding:6px 8px;text-align:left;border-bottom:2px solid #dee2e6">Evidence</th></tr>`);
      for (const c of d.criteria_status) {
        const statusColor = statusColors[(c.status || "").toLowerCase()] || "#6c757d";
        parts.push(`<tr><td style="padding:4px 8px;border-bottom:1px solid #eee"><span style="color:${statusColor};font-weight:bold">${esc(c.status)}</span></td><td style="padding:4px 8px;border-bottom:1px solid #eee">${esc(c.criterion)}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:12px;color:#666">${esc((c.evidence || "N/A").slice(0, 200))}</td></tr>`);
      }
      parts.push(`</table>`);
    }

    if (d.affected_systems?.length) {
      parts.push(`<p style="margin:8px 0"><b>Affected Systems:</b> ${d.affected_systems.map((s: string) => `<span style="display:inline-block;padding:2px 8px;margin:2px;background:#e9ecef;border-radius:3px;font-size:12px">${esc(s)}</span>`).join(" ")}</p>`);
    }

    if (d.recommended_actions?.length) {
      parts.push(sectionHeader("Recommended Actions", "\u2705"));
      parts.push(`<ol style="margin:4px 0;padding-left:24px">`);
      for (const action of d.recommended_actions) {
        parts.push(`<li style="margin:4px 0">${esc(String(action))}</li>`);
      }
      parts.push(`</ol>`);
    }

    if (d.missing_data_sources?.length) {
      parts.push(sectionHeader("Missing Data Sources", "\u26A0\uFE0F"));
      parts.push(`<ul style="margin:4px 0;padding-left:24px">`);
      for (const ds of d.missing_data_sources) {
        parts.push(`<li style="margin:4px 0"><b>${esc(ds.name)}</b>: ${esc(ds.reason)}</li>`);
      }
      parts.push(`</ul>`);
    }
  }

  // Needs review banner
  if (investigation.needs_review) {
    parts.push(`<div style="margin:12px 0;padding:10px 14px;background:#fff3cd;border-left:4px solid #ffc107;border-radius:2px;color:#856404"><b>Needs Human Review:</b> This investigation did not achieve high confidence. Please review the criteria and data source gaps above.</div>`);
  }

  // Footer
  parts.push(`<hr style="margin:16px 0;border:none;border-top:1px solid #dee2e6">`);
  parts.push(`<p style="margin:4px 0;color:#999;font-size:11px">`);
  parts.push(`Rounds: ${investigation.rounds || 0}`);
  if (investigation.usage) {
    parts.push(` | Tokens: ${investigation.usage.input_tokens || 0} in / ${investigation.usage.output_tokens || 0} out`);
  }
  parts.push(` | Generated: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`);
  parts.push(`</p>`);

  return parts.join("");
}

// ── Quality Gate — classify investigation output ──

function assessInvestigationQuality(
  result: any,
  success: boolean,
): { quality: string; reason: string; needs_review: boolean } {
  // Priority: error > needs_review > substantial > waiting_context > empty
  if (!success || !result) {
    return { quality: "error", reason: "Investigation job failed or timed out", needs_review: false };
  }

  // Handle agentic_investigator error response
  if (result.error) {
    return { quality: "error", reason: result.error.slice(0, 200), needs_review: false };
  }

  const diag = result.diagnosis;
  if (!diag) {
    return { quality: "empty", reason: "No diagnosis returned", needs_review: false };
  }

  const needsReview = result.needs_review === true;
  const hasCoherentDiagnosis = diag.confidence !== "low"
    && diag.root_cause
    && !diag.root_cause.includes("UNKNOWN");

  // Substantial: coherent diagnosis with evidence (may still need review if not high confidence)
  if (hasCoherentDiagnosis && (diag.evidence?.length > 0 || diag.criteria_status?.length > 0)) {
    const criteriaResolved = diag.criteria_status?.filter((c: any) => c.status === "verified").length || 0;
    const criteriaTotal = diag.criteria_status?.length || 0;
    const missingDs = result.missing_data_sources?.length || 0;
    const quality = needsReview ? "needs_review" : "substantial";
    return {
      quality,
      reason: `${result.rounds} rounds, confidence: ${diag.confidence}, severity: ${diag.severity}, criteria: ${criteriaResolved}/${criteriaTotal} verified${missingDs > 0 ? `, ${missingDs} data source gaps` : ""}`,
      needs_review: needsReview,
    };
  }

  // Diagnosis exists but low confidence or no evidence — retry may help
  if (diag.root_cause && !hasCoherentDiagnosis) {
    return {
      quality: "waiting_context",
      reason: `Diagnosis incomplete: confidence=${diag.confidence}, root_cause=${(diag.root_cause || "").slice(0, 150)}`,
      needs_review: needsReview,
    };
  }

  return {
    quality: "empty",
    reason: `Investigation returned no actionable diagnosis after ${result.rounds || 0} rounds`,
    needs_review: false,
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
  max_concurrency: number = 2,
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
  let phase1Empty = 0, phase1Errors = 0, phase1Dismissed = 0;
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
    // ── Phase 1a: SUBMIT (fire-and-forget, no polling) ──
    console.log(`[process_actionable] ── Phase 1a: SUBMIT ──`);
    const MAX_CONCURRENT_INVESTIGATIONS = 2; // Must be < total default workers to avoid deadlock
    let submitted = 0;
    let skippedActive = 0;
    let skippedCrossSource = 0;
    let skippedConcurrency = 0;

    // Count currently running/submitted investigations
    const activeJobs = cacheLib.getPendingInvestigationJobs();
    const currentRunning = activeJobs.length;
    const slotsAvailable = Math.max(0, MAX_CONCURRENT_INVESTIGATIONS - currentRunning);
    console.log(`[process_actionable] Concurrency: ${currentRunning} active, ${slotsAvailable} slots available (max=${MAX_CONCURRENT_INVESTIGATIONS})`);

    for (let i = 0; i < toInvestigate.length; i++) {
      const item = toInvestigate[i];
      const hashShort = item.dedup_hash.slice(0, 12);

      // Concurrency guard: don't exceed max concurrent investigations
      if (submitted >= slotsAvailable) {
        console.log(`[process_actionable] [P1a] ${hashShort} SKIP: concurrency cap reached (${submitted + currentRunning}/${MAX_CONCURRENT_INVESTIGATIONS})`);
        skippedConcurrency++;
        continue;
      }

      // Skip items that already have a pending/running investigation job
      if (cacheLib.hasActiveInvestigationJob(item.dedup_hash)) {
        console.log(`[process_actionable] [P1a] ${hashShort} SKIP: active investigation job exists`);
        skippedActive++;
        continue;
      }

      // Cross-source dedup: check if same subject already investigated from another source
      const crossMatch = cacheLib.findCrossSourceMatch(item.subject, item.source);
      if (crossMatch.found && crossMatch.match) {
        console.log(`[process_actionable] [P1a] ${hashShort} CROSS-SOURCE: reusing from ${crossMatch.match.source}`);
        // Copy result directly — no need to re-investigate
        const existingResult = crossMatch.match.investigation_result
          ? JSON.parse(crossMatch.match.investigation_result) : null;
        const assessment = assessInvestigationQuality(existingResult, !!existingResult);
        cacheLib.updateInvestigationStatus(item.dedup_hash, assessment.quality,
          crossMatch.match.investigation_result, null);
        skippedCrossSource++;
        phase1Investigated++;
        phase1Substantial++;
        results.push({ phase: "investigate", subject: item.subject.slice(0, 100),
          dedup_hash_short: hashShort, quality: assessment.quality });
        continue;
      }

      // Build investigation body from metadata
      let body = item.subject;
      try {
        const meta = JSON.parse(item.metadata || "{}");
        if (meta.body_text) body = meta.body_text;
        else if (meta.preview) body = meta.preview;
      } catch { /* use subject as fallback */ }

      // Submit investigation as independent job (no parent tracking)
      const submission = await submitInvestigation(
        item.source, item.subject, body, item.sender || "unknown",
        `triage-${item.id}`, item.action, item.dedup_hash, [],
      );

      if (submission.success && submission.jobId) {
        cacheLib.recordInvestigationJob(submission.jobId, `triage-${item.id}`, item.dedup_hash);
        console.log(`[process_actionable] [P1a ${submitted + 1}] ${hashShort} → job ${submission.jobId.slice(0, 12)}`);
        submitted++;
      } else {
        console.error(`[process_actionable] [P1a] ${hashShort} SUBMIT FAILED: ${submission.error}`);
        phase1Errors++;
      }
    }

    console.log(`[process_actionable] Phase 1a complete: submitted=${submitted}, skipped_active=${skippedActive}, skipped_cross_source=${skippedCrossSource}, skipped_concurrency=${skippedConcurrency}, errors=${phase1Errors}`);

    // ── Phase 1b: COLLECT (check status of all pending investigation jobs) ──
    console.log(`\n[process_actionable] ── Phase 1b: COLLECT ──`);
    const pendingJobs = cacheLib.getPendingInvestigationJobs();
    console.log(`[process_actionable] Pending investigation jobs: ${pendingJobs.length}`);

    for (const job of pendingJobs) {
      const hashShort = job.dedup_hash.slice(0, 12);
      const jobShort = job.windmill_job_id.slice(0, 12);

      const status = await checkInvestigationJobStatus(job.windmill_job_id);

      if (!status.completed) {
        // Still running or queued — update to running if it was submitted
        if (job.status === "submitted") {
          cacheLib.updateInvestigationJobStatus(job.windmill_job_id, "running");
        }
        console.log(`[process_actionable] [P1b] ${hashShort} job=${jobShort} RUNNING`);
        continue;
      }

      // Job completed — the investigator already wrote results to cache (self-write)
      // Just update the tracking table status if the investigator didn't already
      if (status.success) {
        const result = status.result;
        const confidence = result?.diagnosis?.confidence || "unknown";
        const rounds = result?.rounds || "?";
        const summary = `${rounds} rounds, ${confidence} confidence`;
        cacheLib.updateInvestigationJobStatus(job.windmill_job_id, "completed", summary);

        // Count for summary
        phase1Investigated++;
        const quality = result?.needs_review ? "needs_review" : "substantial";
        if (quality === "needs_review" || quality === "substantial") phase1Substantial++;
        console.log(`[process_actionable] [P1b] ${hashShort} job=${jobShort} COMPLETED: ${summary}`);

        // Post SDP comment for SDP-sourced items
        // (Look up the item from cache to check source)
        try {
          const items = cacheLib.getUninvestigatedActionable(1, ""); // won't find it since it's investigated
          // SDP commenting is best-effort; investigator already wrote results to cache
        } catch { /* best-effort */ }

        results.push({ phase: "investigate", subject: job.item_id,
          dedup_hash_short: hashShort, quality });
      } else {
        // Job failed or was cancelled
        const errMsg = status.result?.error?.message || "Job failed";
        const isCancelled = errMsg.includes("cancel");
        const finalStatus = isCancelled ? "cancelled" : "failed";
        cacheLib.updateInvestigationJobStatus(job.windmill_job_id, finalStatus, errMsg.slice(0, 200));
        console.log(`[process_actionable] [P1b] ${hashShort} job=${jobShort} ${finalStatus.toUpperCase()}: ${errMsg.slice(0, 100)}`);
        phase1Errors++;
      }
    }
  } else {
    console.log(`[process_actionable] Skipping investigation (skip_investigation=true)`);
  }

  console.log(`[process_actionable] Phase 1 complete: investigated=${phase1Investigated}, substantial=${phase1Substantial}, dismissed=${phase1Dismissed}, waiting_context=${phase1WaitingContext}, empty=${phase1Empty}, errors=${phase1Errors}`);

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

    // Skip task creation for SDP-sourced items — they already exist in SDP,
    // investigation results were posted as comments in Phase 1
    if (item.source === "sdp") {
      console.log(`[process_actionable] [P2] Skipping SDP-sourced item (already exists in SDP, comment posted in P1)`);
      // Mark as processed so it doesn't reappear
      cacheLib.updateTaskId(item.dedup_hash, "sdp-native");
      results.push({
        phase: "create_task", subject: item.subject.slice(0, 100),
        dedup_hash_short: hashShort, task_id: "sdp-native",
      });
      continue;
    }

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
        const criteriaResolved = d.criteria_status?.filter((c: any) => c.status === "verified").length || 0;
        const criteriaTotal = d.criteria_status?.length || 0;
        investigationSummary = [
          sectionHeader("Investigation Summary", "\uD83D\uDD2C"),
          `<table style="border-collapse:collapse;width:100%;margin:8px 0">`,
          `<tr><td style="padding:4px 8px;font-weight:bold;width:100px">Severity</td><td style="padding:4px 8px">${severityBadge(d.severity || "unknown")}</td></tr>`,
          `<tr><td style="padding:4px 8px;font-weight:bold">Confidence</td><td style="padding:4px 8px">${confidenceBadge(d.confidence || "unknown")}</td></tr>`,
          `<tr><td style="padding:4px 8px;font-weight:bold">Rounds</td><td style="padding:4px 8px">${investigationFull.rounds || 0}</td></tr>`,
          `<tr><td style="padding:4px 8px;font-weight:bold">Criteria</td><td style="padding:4px 8px">${criteriaResolved}/${criteriaTotal} verified</td></tr>`,
          `</table>`,
          `<div style="margin:8px 0;padding:10px 14px;background:#f8f9fa;border-left:4px solid #6c757d;border-radius:2px"><b>Root Cause:</b> ${esc(d.root_cause || "UNKNOWN")}</div>`,
        ].join("");
      }
      // AI risk evaluation + rollback steps
      const riskEval = evaluateRisk(investigationFull);
      riskSection = formatRiskSection(riskEval);
    } catch { /* no investigation result to parse */ }

    // Determine if this is a needs_review item
    const isNeedsReview = (item as any).investigation_status === "needs_review";
    const titlePrefix = isNeedsReview ? "** [NEEDS REVIEW]" : "**";
    const taskTitle = `${titlePrefix} [${item.action}/${item.urgency}] ${item.subject}`.slice(0, 200);

    // Build missing data sources section if applicable
    let dataSourceGapSection = "";
    if (investigationFull?.missing_data_sources?.length) {
      const gaps = investigationFull.missing_data_sources as Array<{ name: string; reason: string }>;
      const gapRows = gaps.map((g: { name: string; reason: string }) =>
        `<tr><td style="padding:4px 8px;font-weight:bold">${esc(g.name)}</td><td style="padding:4px 8px">${esc(g.reason)}</td></tr>`
      ).join("");
      dataSourceGapSection = [
        sectionHeader("Missing Data Sources", "\u26A0\uFE0F"),
        `<p style="margin:4px 0;color:#856404;background:#fff3cd;padding:8px 12px;border-radius:4px">This investigation was incomplete because the following data sources were unavailable:</p>`,
        `<table style="border-collapse:collapse;width:100%;margin:8px 0"><tr style="background:#f1f3f5"><th style="padding:6px 8px;text-align:left">Data Source</th><th style="padding:6px 8px;text-align:left">Why Needed</th></tr>${gapRows}</table>`,
      ].join("");
    }

    const taskDescription = [
      sectionHeader("Triage Details"),
      `<table style="border-collapse:collapse;width:100%;margin:8px 0">`,
      `<tr><td style="padding:4px 8px;font-weight:bold;width:100px">Source</td><td style="padding:4px 8px">${esc(item.source)}</td></tr>`,
      `<tr><td style="padding:4px 8px;font-weight:bold">Sender</td><td style="padding:4px 8px">${esc(item.sender)}</td></tr>`,
      `<tr><td style="padding:4px 8px;font-weight:bold">Received</td><td style="padding:4px 8px">${esc(item.received_at)}</td></tr>`,
      `<tr><td style="padding:4px 8px;font-weight:bold">Urgency</td><td style="padding:4px 8px">${severityBadge(item.urgency)}</td></tr>`,
      `<tr><td style="padding:4px 8px;font-weight:bold">Classified by</td><td style="padding:4px 8px">${esc(item.classified_by)}</td></tr>`,
      `</table>`,
      `<div style="margin:8px 0;padding:10px 14px;background:#f8f9fa;border-left:4px solid #6c757d;border-radius:2px">${esc(item.summary)}</div>`,
      investigationSummary,
      dataSourceGapSection,
      riskSection,
    ].join("");
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
    const attempts = (item as any).investigation_attempts || max_retry_attempts;

    if (invStatus === "waiting_context") {
      let credentials: any[] = [];
      try {
        credentials = JSON.parse((item as any).waiting_context_reason || "[]");
      } catch { /* use empty */ }

      const credRows = credentials.length > 0
        ? credentials.map((c: any) =>
            `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee"><b>${esc(c.needed)}</b></td><td style="padding:4px 8px;border-bottom:1px solid #eee">${esc(c.description || c.entity_type)}</td><td style="padding:4px 8px;border-bottom:1px solid #eee">${esc(c.action || "Install plugin")}</td></tr>`
          ).join("")
        : `<tr><td colspan="3" style="padding:4px 8px">Unknown (see waiting_context_reason in triage DB)</td></tr>`;

      escalationNote = [
        `<div style="margin:12px 0;padding:12px;background:#fff3cd;border:1px solid #ffc107;border-radius:4px">`,
        `<b>\u26A0\uFE0F Investigation Blocked — Missing Credentials/Plugins</b>`,
        `<p style="margin:8px 0">This item could not be fully investigated after ${attempts} attempts.</p>`,
        `<table style="border-collapse:collapse;width:100%;margin:8px 0"><tr style="background:#f1f3f5"><th style="padding:4px 8px;text-align:left">Credential</th><th style="padding:4px 8px;text-align:left">Description</th><th style="padding:4px 8px;text-align:left">Action</th></tr>${credRows}</table>`,
        `<p style="margin:8px 0;font-size:12px;color:#666">Configure credentials in Bitwarden Secrets (BWS) and sync to Windmill variables via sync-credentials.sh.</p>`,
        `</div>`,
      ].join("");
    } else if (invStatus === "empty") {
      escalationNote = [
        `<div style="margin:12px 0;padding:12px;background:#d1ecf1;border:1px solid #17a2b8;border-radius:4px">`,
        `<b>\u2139\uFE0F Investigation Inconclusive</b>`,
        `<p style="margin:8px 0">No actionable diagnosis after ${attempts} attempts. No missing credentials identified — manual review recommended.</p>`,
        `</div>`,
      ].join("");
    } else if (invStatus === "error") {
      escalationNote = [
        `<div style="margin:12px 0;padding:12px;background:#f8d7da;border:1px solid #dc3545;border-radius:4px">`,
        `<b>\u274C Investigation Failed</b>`,
        `<p style="margin:8px 0">The investigation pipeline encountered errors after ${attempts} attempts. This item requires manual investigation.</p>`,
        `</div>`,
      ].join("");
    }

    // Risk evaluation for escalated items (no investigation data available)
    const escalationRisk = evaluateRisk(null);
    const escalationRiskSection = formatRiskSection(escalationRisk);

    const taskTitle = `** [ESCALATED/${item.urgency}] ${item.subject}`.slice(0, 200);
    const taskDescription = [
      sectionHeader("Triage Details"),
      `<table style="border-collapse:collapse;width:100%;margin:8px 0">`,
      `<tr><td style="padding:4px 8px;font-weight:bold;width:100px">Source</td><td style="padding:4px 8px">${esc(item.source)}</td></tr>`,
      `<tr><td style="padding:4px 8px;font-weight:bold">Sender</td><td style="padding:4px 8px">${esc(item.sender)}</td></tr>`,
      `<tr><td style="padding:4px 8px;font-weight:bold">Received</td><td style="padding:4px 8px">${esc(item.received_at)}</td></tr>`,
      `<tr><td style="padding:4px 8px;font-weight:bold">Urgency</td><td style="padding:4px 8px">${severityBadge(item.urgency)}</td></tr>`,
      `</table>`,
      `<div style="margin:8px 0;padding:10px 14px;background:#f8f9fa;border-left:4px solid #6c757d;border-radius:2px">${esc(item.summary)}</div>`,
      escalationNote,
      escalationRiskSection,
    ].join("");
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
  console.log(`[process_actionable] P1: investigated=${phase1Investigated} (substantial=${phase1Substantial}, dismissed=${phase1Dismissed}, waiting=${phase1WaitingContext}, empty=${phase1Empty}, errors=${phase1Errors})`);
  console.log(`[process_actionable] P2: tasks=${phase2TasksCreated}, notes=${phase2NotesAdded}`);
  console.log(`[process_actionable] P3: escalated=${phase3Escalated}`);

  return {
    phase1_investigated: phase1Investigated,
    phase1_waiting_context: phase1WaitingContext,
    phase1_substantial: phase1Substantial,
    phase1_dismissed: phase1Dismissed,
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
