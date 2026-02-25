// Windmill Script: Auto-Triage Incoming Events
// Decision 25: All inputs → Windmill auto-triage
//
// Receives events from: Slack webhooks, SDP webhooks, AWS EventBridge, GitHub
// Classifies into: NOTIFY (immediate alert), QUEUE (add to workstream), AUTO (handle autonomously)
//
// Requires: claude CLI available in PATH

import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();

type TriageAction = "NOTIFY" | "QUEUE" | "AUTO";

interface TriageResult {
  action: TriageAction;
  urgency: "critical" | "high" | "medium" | "low";
  summary: string;
  reasoning: string;
  domain: "work" | "personal";
}

export async function main(
  source: string,
  event_type: string,
  payload: string,
  dry_run: boolean = false,
) {
  if (!source || !payload) {
    return { error: "source and payload are required" };
  }

  // Read calibration data from feedback loop (Decision 25 + Phase 6 Gap #1)
  let calibrationContext = "";
  try {
    const calibrationPath = join(HOME, ".claude", "state", "triage-calibration.json");
    if (existsSync(calibrationPath)) {
      const calibration = JSON.parse(readFileSync(calibrationPath, "utf-8"));
      if (calibration && calibration.accuracy_rate !== undefined) {
        const autoAccuracy = calibration.by_source?.AUTO?.accuracy ?? "N/A";
        const recs = Array.isArray(calibration.recommendations) ? calibration.recommendations.join("; ") : "none";
        const adjustments = Array.isArray(calibration.threshold_adjustments)
          ? calibration.threshold_adjustments.map((a: any) => `${a.action}: ${a.direction} (${a.reason})`).join("; ")
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
    // Calibration file missing or invalid — proceed without it
  }

  // Build triage prompt
  const prompt = `You are an event triage system. Classify this event.

Source: ${source}
Event type: ${event_type || "unknown"}
Payload:
${payload.slice(0, 2000)}

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
- critical/high → NOTIFY, medium → QUEUE or AUTO, low → AUTO${calibrationContext}`;

  try {
    const result = execSync(
      `echo ${JSON.stringify(prompt)} | claude -p --output-format json 2>/dev/null`,
      { encoding: "utf-8", timeout: 30000 },
    ).trim();

    let triage: TriageResult;
    try {
      triage = JSON.parse(result);
    } catch {
      // Fallback: couldn't parse Claude response
      triage = {
        action: "QUEUE",
        urgency: "medium",
        summary: `Unparseable triage for ${source} event`,
        reasoning: "Claude response was not valid JSON, queuing for manual review",
        domain: "work",
      };
    }

    if (dry_run) {
      return { dry_run: true, triage };
    }

    // Execute the triage action
    switch (triage.action) {
      case "NOTIFY":
        // Send immediate notification via voice server + Slack
        try {
          execSync(
            `curl -sf -X POST http://localhost:8888/notify -H "Content-Type: application/json" -d ${JSON.stringify(JSON.stringify({ message: `ALERT [${triage.urgency}]: ${triage.summary}` }))} 2>/dev/null`,
            { timeout: 5000 },
          );
        } catch {
          // Voice server may not be running
        }
        break;

      case "AUTO":
        // Log and skip — the MCP logger already captures it
        break;

      case "QUEUE":
        // Will be picked up by workstream management
        break;
    }

    return {
      triage,
      source,
      event_type,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return {
      error: `Triage failed: ${err}`,
      fallback: {
        action: "QUEUE",
        urgency: "medium",
        summary: `Failed to triage ${source} event — queued for manual review`,
        source,
        event_type,
      },
    };
  }
}
