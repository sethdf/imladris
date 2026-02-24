// Windmill Script: Triage Feedback Loop
// Phase 6 Gap #4: Measure triage quality, improve routing over time
//
// Records triage decisions + eventual outcomes, calculates accuracy,
// produces calibration data the triage agent can reference.

import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();
const FEEDBACK_LOG = join(HOME, ".claude", "logs", "triage-feedback.jsonl");
const CALIBRATION_FILE = join(HOME, ".claude", "state", "triage-calibration.json");

interface TriageFeedbackEntry {
  timestamp: string;
  event_id: string;
  original_action: "NOTIFY" | "QUEUE" | "AUTO";
  original_urgency: string;
  actual_outcome: "correct" | "over_triaged" | "under_triaged" | "missed";
  notes?: string;
}

interface CalibrationData {
  last_updated: string;
  total_events: number;
  accuracy_rate: number;
  over_triage_rate: number;
  under_triage_rate: number;
  by_source: Record<string, { total: number; correct: number; accuracy: number }>;
  recommendations: string[];
}

function ensureDirs(): void {
  const logDir = join(HOME, ".claude", "logs");
  const stateDir = join(HOME, ".claude", "state");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
}

function readFeedback(): TriageFeedbackEntry[] {
  if (!existsSync(FEEDBACK_LOG)) return [];
  try {
    return readFileSync(FEEDBACK_LOG, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean) as TriageFeedbackEntry[];
  } catch {
    return [];
  }
}

export async function main(
  action: string = "stats",
  event_id: string = "",
  original_action: string = "",
  original_urgency: string = "",
  actual_outcome: string = "",
  notes: string = "",
) {
  ensureDirs();

  if (action === "record") {
    // Record a feedback entry
    if (!event_id || !actual_outcome) {
      return { error: "event_id and actual_outcome are required for recording" };
    }

    const entry: TriageFeedbackEntry = {
      timestamp: new Date().toISOString(),
      event_id,
      original_action: (original_action || "QUEUE") as any,
      original_urgency: original_urgency || "medium",
      actual_outcome: actual_outcome as any,
      notes: notes || undefined,
    };

    appendFileSync(FEEDBACK_LOG, JSON.stringify(entry) + "\n");
    return { recorded: true, entry };
  }

  if (action === "stats" || action === "calibrate") {
    // Calculate calibration data
    const entries = readFeedback();

    if (entries.length === 0) {
      return {
        message: "No triage feedback recorded yet",
        setup: "Use action='record' to log triage outcomes",
      };
    }

    const total = entries.length;
    const correct = entries.filter((e) => e.actual_outcome === "correct").length;
    const overTriaged = entries.filter((e) => e.actual_outcome === "over_triaged").length;
    const underTriaged = entries.filter((e) => e.actual_outcome === "under_triaged").length;

    // Per-source accuracy (using urgency as proxy for source)
    const byAction: Record<string, { total: number; correct: number; accuracy: number }> = {};
    for (const entry of entries) {
      const key = entry.original_action;
      if (!byAction[key]) byAction[key] = { total: 0, correct: 0, accuracy: 0 };
      byAction[key].total++;
      if (entry.actual_outcome === "correct") byAction[key].correct++;
    }
    for (const key of Object.keys(byAction)) {
      byAction[key].accuracy = byAction[key].total > 0
        ? Math.round((byAction[key].correct / byAction[key].total) * 100)
        : 0;
    }

    // Generate recommendations
    const recommendations: string[] = [];
    const overRate = total > 0 ? overTriaged / total : 0;
    const underRate = total > 0 ? underTriaged / total : 0;

    if (overRate > 0.3) {
      recommendations.push("High over-triage rate (>30%). Consider relaxing NOTIFY threshold — many events classified as urgent were not.");
    }
    if (underRate > 0.1) {
      recommendations.push("Under-triage detected (>10%). Some important events were classified too low. Review QUEUE→NOTIFY boundary.");
    }
    if (byAction["AUTO"]?.accuracy < 80) {
      recommendations.push("AUTO classification accuracy below 80%. Some auto-dismissed events needed attention.");
    }
    if (recommendations.length === 0) {
      recommendations.push("Triage quality is good. No adjustments recommended.");
    }

    const calibration: CalibrationData = {
      last_updated: new Date().toISOString(),
      total_events: total,
      accuracy_rate: Math.round((correct / total) * 100),
      over_triage_rate: Math.round(overRate * 100),
      under_triage_rate: Math.round(underRate * 100),
      by_source: byAction,
      recommendations,
    };

    // Save calibration for triage agent to read
    if (action === "calibrate") {
      writeFileSync(CALIBRATION_FILE, JSON.stringify(calibration, null, 2));
    }

    return calibration;
  }

  return { error: `Unknown action: ${action}. Use 'record', 'stats', or 'calibrate'` };
}
