// Windmill Script: Triage Pipeline Orchestrator
// Central coordinator for the triage pipeline. Receives a single incoming item
// (email, ticket, alert) and orchestrates: classify -> investigate -> propose fix.
//
// Pipeline steps:
//   1. CLASSIFY — inline AI classification via claude -p (NOTIFY/QUEUE/AUTO)
//   2. INVESTIGATE — call f/devops/investigate via Windmill internal API (read-only)
//   3. PROPOSE — format fixable items for human approval
//   4. RETURN — complete pipeline result with next-step guidance
//
// Rules:
//   - All investigation is READ-ONLY — no modifications
//   - Classification uses claude CLI pipe mode, not Anthropic API
//   - AUTO items are cached and returned immediately
//   - QUEUE/NOTIFY items get full investigation

import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();

// ── Types ──

type TriageAction = "NOTIFY" | "QUEUE" | "AUTO";

interface TriageClassification {
  action: TriageAction;
  urgency: "critical" | "high" | "medium" | "low";
  summary: string;
  reasoning: string;
  domain: "work" | "personal";
}

type PipelineStatus =
  | "auto_resolved"
  | "investigation_complete"
  | "fix_proposed"
  | "needs_escalation"
  | "needs_credential";

interface ProposedAction {
  action: string;
  commands: string[];
  risk_level: string;
  requires_access: string;
}

interface PipelineResult {
  item_id: string;
  source: string;
  event_type: string;
  classification: TriageClassification;
  investigation: any | null;
  proposed_action: ProposedAction | null;
  pipeline_status: PipelineStatus;
  next_step: string;
  timestamp: string;
  duration_ms: number;
}

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

// ── Windmill internal API: run script and wait for result ──

async function runWindmillScript(path: string, args: Record<string, any>): Promise<any> {
  const base = process.env.BASE_INTERNAL_URL || "http://windmill_server:8000";
  const token = process.env.WM_TOKEN;
  const workspace = process.env.WM_WORKSPACE || "imladris";

  if (!token) {
    throw new Error("WM_TOKEN not available — cannot call internal scripts");
  }

  const resp = await fetch(
    `${base}/api/w/${workspace}/jobs/run_wait_result/p/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    },
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Script ${path} failed: ${resp.status} ${body.slice(0, 500)}`);
  }

  return resp.json();
}

// ── Step 1: Classify (inline via claude -p) ──

function classify(
  source: string,
  event_type: string,
  content: string,
): TriageClassification {
  // Load calibration data if available (same pattern as auto_triage.ts)
  let calibrationContext = "";
  try {
    const calibrationPath = join(HOME, ".claude", "state", "triage-calibration.json");
    if (existsSync(calibrationPath)) {
      const calibration = JSON.parse(readFileSync(calibrationPath, "utf-8"));
      if (calibration && calibration.accuracy_rate !== undefined) {
        const autoAccuracy = calibration.by_source?.AUTO?.accuracy ?? "N/A";
        const recs = Array.isArray(calibration.recommendations)
          ? calibration.recommendations.join("; ")
          : "none";
        const adjustments = Array.isArray(calibration.threshold_adjustments)
          ? calibration.threshold_adjustments
              .map((a: any) => `${a.action}: ${a.direction} (${a.reason})`)
              .join("; ")
          : "none";
        calibrationContext = `

Calibration data from past triage outcomes:
- Overall accuracy: ${calibration.accuracy_rate}%
- AUTO accuracy: ${autoAccuracy}%
- Over-triage rate: ${calibration.over_triage_rate ?? "N/A"}%
- Under-triage rate: ${calibration.under_triage_rate ?? "N/A"}%
- Threshold adjustments: ${adjustments}
- Recommendations: ${recs}

Use this calibration data to adjust your classification. If AUTO accuracy is low, be more conservative (prefer QUEUE over AUTO). If over-triage rate is high, be less aggressive with NOTIFY.`;
      }
    }
  } catch {
    // Calibration unavailable — proceed without
  }

  const prompt = `You are an event triage system. Classify this event.

Source: ${source}
Event type: ${event_type}
Payload:
${content.slice(0, 2000)}

Respond with ONLY valid JSON (no markdown):
{
  "action": "NOTIFY|QUEUE|AUTO",
  "urgency": "critical|high|medium|low",
  "summary": "one sentence summary",
  "reasoning": "why this classification",
  "domain": "work|personal"
}

Rules:
- NOTIFY: Security alerts, service down, P1 incidents, anything needing immediate human attention
- QUEUE: New tickets, feature requests, non-urgent tasks — add to workstream for later
- AUTO: Informational, resolved alerts, routine maintenance — log and move on
- critical/high -> NOTIFY, medium -> QUEUE or AUTO, low -> AUTO${calibrationContext}`;

  try {
    const tmpFile = `/tmp/triage-pipeline-classify-${Date.now()}.txt`;
    writeFileSync(tmpFile, prompt);
    const result = execSync(
      `cat ${tmpFile} | claude -p --output-format json 2>/dev/null`,
      { encoding: "utf-8", timeout: 30000 },
    ).trim();
    try { unlinkSync(tmpFile); } catch { /* cleanup best-effort */ }

    // claude -p --output-format json may wrap in envelope
    const parsed = JSON.parse(result);
    const text = typeof parsed === "string"
      ? parsed
      : parsed.result || parsed.content || JSON.stringify(parsed);
    const inner = typeof text === "string" ? JSON.parse(text) : text;

    // Validate the classification
    const validActions: TriageAction[] = ["NOTIFY", "QUEUE", "AUTO"];
    if (!validActions.includes(inner.action)) {
      inner.action = "QUEUE"; // safe fallback
    }

    return inner as TriageClassification;
  } catch (err: any) {
    // Fallback: could not classify — queue for manual review
    return {
      action: "QUEUE" as TriageAction,
      urgency: "medium" as const,
      summary: `Classification failed for ${source}/${event_type} — queued for manual review`,
      reasoning: `claude -p classification error: ${err.message?.slice(0, 200)}`,
      domain: "work" as const,
    };
  }
}

// ── Step 3: Propose fix (format for human approval) ──

function formatProposal(diagnosis: any): {
  proposed_action: ProposedAction | null;
  summary: string;
} {
  if (!diagnosis || diagnosis.status !== "FIXABLE" || !diagnosis.proposed_fix) {
    return { proposed_action: null, summary: "" };
  }

  const fix = diagnosis.proposed_fix;
  const proposal: ProposedAction = {
    action: fix.action || "Unknown action",
    commands: Array.isArray(fix.commands) ? fix.commands : [],
    risk_level: fix.risk_level || "unknown",
    requires_access: fix.requires_access || "unknown",
  };

  const evidenceSummary = Array.isArray(diagnosis.evidence_citations)
    ? diagnosis.evidence_citations.join("; ")
    : "No evidence cited";

  const summary = [
    `ROOT CAUSE: ${diagnosis.root_cause || "Unknown"}`,
    `CONFIDENCE: ${diagnosis.confidence || "Unknown"}`,
    `PROPOSED FIX: ${proposal.action}`,
    `RISK: ${proposal.risk_level}`,
    `EVIDENCE: ${evidenceSummary}`,
    `COMMANDS: ${proposal.commands.length > 0 ? proposal.commands.join(" && ") : "None specified"}`,
  ].join("\n");

  return { proposed_action: proposal, summary };
}

// ── Determine pipeline status and next step ──

function determinePipelineOutcome(
  classification: TriageClassification,
  investigation: any | null,
  proposedAction: ProposedAction | null,
): { pipeline_status: PipelineStatus; next_step: string } {
  // AUTO items are resolved immediately
  if (classification.action === "AUTO") {
    return {
      pipeline_status: "auto_resolved",
      next_step: "No action needed. Item logged to cache.",
    };
  }

  // No investigation result — should not happen for QUEUE/NOTIFY, but handle gracefully
  if (!investigation) {
    return {
      pipeline_status: "needs_escalation",
      next_step: "Investigation failed to run. Manual review required.",
    };
  }

  const diagnosis = investigation.diagnosis;

  // Check for credential gaps
  if (
    diagnosis?.status === "NEEDS-CREDENTIAL" ||
    (investigation.needs_credential && investigation.needs_credential.length > 0)
  ) {
    const gaps = investigation.needs_credential || [];
    const gapList = gaps
      .map((g: any) => `${g.needed} (${g.description})`)
      .join(", ");
    return {
      pipeline_status: "needs_credential",
      next_step: `Add credentials for: ${gapList || "see investigation details"}. Then re-run pipeline.`,
    };
  }

  // Fixable with proposed remediation
  if (diagnosis?.status === "FIXABLE" && proposedAction) {
    const riskNote =
      proposedAction.risk_level === "high"
        ? " (HIGH RISK — review carefully)"
        : proposedAction.risk_level === "medium"
          ? " (medium risk)"
          : "";
    return {
      pipeline_status: "fix_proposed",
      next_step: `Approve fix via Windmill approval flow${riskNote}: ${proposedAction.action}`,
    };
  }

  // Needs escalation
  if (diagnosis?.status === "NEEDS-ESCALATION") {
    return {
      pipeline_status: "needs_escalation",
      next_step: `Manual review required. ${diagnosis.status_reason || "AI could not determine a fix."}`,
    };
  }

  // Default: investigation complete but no automated fix
  return {
    pipeline_status: "investigation_complete",
    next_step: "Investigation complete. Review findings and decide on action.",
  };
}

// ── Cache pipeline result ──

async function cachePipelineResult(result: PipelineResult): Promise<void> {
  try {
    const { store, isAvailable, init } = await import("./cache_lib.ts");
    if (!isAvailable()) return;
    init();

    const cacheId = result.item_id || `pipeline-${Date.now()}`;
    const title = `Pipeline [${result.pipeline_status}]: ${result.classification.summary}`;
    const body = [
      `source=${result.source}`,
      `event_type=${result.event_type}`,
      `action=${result.classification.action}`,
      `urgency=${result.classification.urgency}`,
      `status=${result.pipeline_status}`,
      `next_step=${result.next_step}`,
      result.proposed_action ? `fix=${result.proposed_action.action}` : "",
    ]
      .filter(Boolean)
      .join(" | ");

    store("triage", "pipeline", cacheId, title, body, result);
  } catch {
    // Cache write failed — non-fatal
  }
}

// ── Main Entry Point ──

export async function main(
  source: string = "m365",
  content: string = "",
  item_id: string = "",
  event_type: string = "alert",
): Promise<PipelineResult> {
  const startTime = Date.now();

  if (!content) {
    return {
      item_id: item_id || `err-${Date.now()}`,
      source,
      event_type,
      classification: {
        action: "QUEUE",
        urgency: "medium",
        summary: "No content provided — cannot triage",
        reasoning: "Empty content parameter",
        domain: "work",
      },
      investigation: null,
      proposed_action: null,
      pipeline_status: "needs_escalation",
      next_step: "Re-submit with content to triage.",
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    };
  }

  const resolvedItemId = item_id || `triage-${Date.now()}`;

  // ── Step 1: CLASSIFY ──
  console.log(`[pipeline] Step 1: Classifying ${source}/${event_type} item...`);
  const classification = classify(source, event_type, content);
  console.log(`[pipeline] Classification: ${classification.action} (${classification.urgency}) — ${classification.summary}`);

  // ── SHORT-CIRCUIT: AUTO items ──
  if (classification.action === "AUTO") {
    console.log(`[pipeline] AUTO — logging to cache and returning immediately.`);
    const result: PipelineResult = {
      item_id: resolvedItemId,
      source,
      event_type,
      classification,
      investigation: null,
      proposed_action: null,
      pipeline_status: "auto_resolved",
      next_step: "No action needed. Item logged to cache.",
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    };
    await cachePipelineResult(result);
    return result;
  }

  // ── Step 2: INVESTIGATE (QUEUE and NOTIFY items) ──
  console.log(`[pipeline] Step 2: Investigating via f/devops/investigate...`);
  let investigation: any = null;
  try {
    investigation = await runWindmillScript("f/devops/investigate", {
      source,
      content,
      item_id: resolvedItemId,
      triage_classification: classification.action,
    });
    console.log(
      `[pipeline] Investigation complete: ${investigation?.diagnosis?.status || "unknown"} ` +
      `(${investigation?.probes_run || 0} probes, ${investigation?.entities_found || 0} entities)`,
    );
  } catch (err: any) {
    console.error(`[pipeline] Investigation failed: ${err.message}`);
    investigation = {
      error: err.message,
      diagnosis: {
        status: "NEEDS-ESCALATION",
        status_reason: `Investigation script failed: ${err.message?.slice(0, 200)}`,
        root_cause: "UNKNOWN — investigation failed",
        confidence: "low",
      },
    };
  }

  // ── Step 3: PROPOSE (if fixable) ──
  let proposedAction: ProposedAction | null = null;
  let proposalSummary = "";

  if (investigation?.diagnosis?.status === "FIXABLE" && investigation?.diagnosis?.proposed_fix) {
    console.log(`[pipeline] Step 3: Formatting fix proposal...`);
    const proposal = formatProposal(investigation.diagnosis);
    proposedAction = proposal.proposed_action;
    proposalSummary = proposal.summary;

    if (proposedAction) {
      console.log(`[pipeline] Proposed fix: ${proposedAction.action} (risk: ${proposedAction.risk_level})`);
    }
  } else {
    console.log(`[pipeline] Step 3: No fix to propose (status: ${investigation?.diagnosis?.status || "N/A"})`);
  }

  // ── Step 4: Determine outcome and return ──
  const { pipeline_status, next_step } = determinePipelineOutcome(
    classification,
    investigation,
    proposedAction,
  );

  // Send voice notification for NOTIFY items
  if (classification.action === "NOTIFY") {
    try {
      const notifyMessage = proposedAction
        ? `Alert triaged. ${classification.summary}. Fix available: ${proposedAction.action}`
        : `Alert triaged. ${classification.summary}. ${next_step}`;

      await fetch("http://localhost:8888/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: notifyMessage.slice(0, 300),
          title: "Triage Pipeline",
        }),
      });
    } catch {
      // Voice server may not be running — non-fatal
    }
  }

  const result: PipelineResult = {
    item_id: resolvedItemId,
    source,
    event_type,
    classification,
    investigation: investigation
      ? {
          entities_found: investigation.entities_found || 0,
          probes_run: investigation.probes_run || 0,
          probes_successful: investigation.probes_successful || 0,
          diagnosis: investigation.diagnosis || null,
          needs_credential: investigation.needs_credential || [],
          related_items: investigation.related_items || [],
          evidence: investigation.evidence || [],
          error: investigation.error || undefined,
        }
      : null,
    proposed_action: proposedAction,
    pipeline_status,
    next_step,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
  };

  // Cache the complete pipeline result
  await cachePipelineResult(result);

  console.log(`[pipeline] Done. Status: ${pipeline_status} | Next: ${next_step}`);
  console.log(`[pipeline] Duration: ${result.duration_ms}ms`);

  return result;
}
