// catchup_lib.ts — Cron catchup logic for Windmill scheduled scripts
// Tracks last successful run per script. When a script starts, it checks
// whether its expected interval was missed (e.g., instance was off).
// If missed, the script knows to run immediately and reports catchup metadata.
// Zero external dependencies — uses only Node stdlib.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

function getHome(): string { return process.env.HOME || "/root"; }

function getStatePath(): string {
  return join(getHome(), ".claude", "state", "cron-last-run.json");
}

interface LastRunMap {
  [scriptName: string]: { timestamp: string; epoch_ms: number };
}

function loadState(): LastRunMap {
  const path = getStatePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function saveState(state: LastRunMap): void {
  const path = getStatePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

export interface CatchupInfo {
  catchup_triggered: boolean;
  missed_duration_ms?: number;
  missed_duration_human?: string;
  last_run?: string;
  expected_interval_ms: number;
}

/**
 * Check if a scheduled script missed its expected run window.
 * Call at the start of main(). If catchup_triggered is true,
 * the script should run immediately (which it's already doing)
 * and include the CatchupInfo in its return value.
 *
 * @param scriptName - Unique identifier for this script (e.g., "feed_collector")
 * @param intervalMs - Expected cron interval in milliseconds (e.g., 6*3600000 for 6 hours)
 * @returns CatchupInfo with catchup_triggered flag and timing details
 */
export function shouldCatchUp(scriptName: string, intervalMs: number): CatchupInfo {
  const state = loadState();
  const entry = state[scriptName];

  if (!entry) {
    // First run ever — not a catchup, just normal first execution
    return { catchup_triggered: false, expected_interval_ms: intervalMs };
  }

  const lastRunMs = entry.epoch_ms;
  const elapsed = Date.now() - lastRunMs;
  // Catchup if more than 2x the expected interval has passed
  // (1x would false-positive on normal jitter)
  const threshold = intervalMs * 2;

  if (elapsed > threshold) {
    const missedMs = elapsed - intervalMs;
    return {
      catchup_triggered: true,
      missed_duration_ms: missedMs,
      missed_duration_human: humanDuration(missedMs),
      last_run: entry.timestamp,
      expected_interval_ms: intervalMs,
    };
  }

  return { catchup_triggered: false, expected_interval_ms: intervalMs };
}

/**
 * Record a successful run for this script.
 * Call after main() logic completes successfully.
 */
export function recordRun(scriptName: string): void {
  const state = loadState();
  const now = new Date();
  state[scriptName] = {
    timestamp: now.toISOString(),
    epoch_ms: now.getTime(),
  };
  saveState(state);
}

function humanDuration(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
