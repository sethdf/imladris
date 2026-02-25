import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let testDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  testDir = join(tmpdir(), `catchup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(testDir, ".claude", "state"), { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = testDir;
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// Dynamic import to pick up env changes
async function loadLib() {
  const mod = await import("../../windmill/f/devops/catchup_lib.ts");
  return mod;
}

test("shouldCatchUp returns false on first run (no prior state)", async () => {
  const { shouldCatchUp } = await loadLib();
  const result = shouldCatchUp("test_script", 3600000);
  expect(result.catchup_triggered).toBe(false);
  expect(result.expected_interval_ms).toBe(3600000);
});

test("shouldCatchUp returns false when within interval", async () => {
  const { shouldCatchUp, recordRun } = await loadLib();
  // Record a run just now
  recordRun("test_script");
  const result = shouldCatchUp("test_script", 3600000);
  expect(result.catchup_triggered).toBe(false);
});

test("shouldCatchUp returns true when interval exceeded by 2x", async () => {
  const { shouldCatchUp } = await loadLib();
  // Manually write a stale timestamp (3 hours ago for a 1-hour interval)
  const statePath = join(testDir, ".claude", "state", "cron-last-run.json");
  const threeHoursAgo = Date.now() - 3 * 3600000;
  writeFileSync(statePath, JSON.stringify({
    test_script: { timestamp: new Date(threeHoursAgo).toISOString(), epoch_ms: threeHoursAgo }
  }));
  const result = shouldCatchUp("test_script", 3600000);
  expect(result.catchup_triggered).toBe(true);
  expect(result.missed_duration_ms).toBeGreaterThan(0);
  expect(result.missed_duration_human).toBeDefined();
  expect(result.last_run).toBeDefined();
});

test("shouldCatchUp returns false when within 2x threshold", async () => {
  const { shouldCatchUp } = await loadLib();
  // 1.5 hours ago for a 1-hour interval — within 2x threshold
  const statePath = join(testDir, ".claude", "state", "cron-last-run.json");
  const ninetyMinAgo = Date.now() - 90 * 60000;
  writeFileSync(statePath, JSON.stringify({
    test_script: { timestamp: new Date(ninetyMinAgo).toISOString(), epoch_ms: ninetyMinAgo }
  }));
  const result = shouldCatchUp("test_script", 3600000);
  expect(result.catchup_triggered).toBe(false);
});

test("recordRun persists timestamp to disk", async () => {
  const { recordRun } = await loadLib();
  recordRun("test_script");
  const statePath = join(testDir, ".claude", "state", "cron-last-run.json");
  expect(existsSync(statePath)).toBe(true);
  const state = JSON.parse(readFileSync(statePath, "utf-8"));
  expect(state.test_script).toBeDefined();
  expect(state.test_script.timestamp).toBeDefined();
  expect(state.test_script.epoch_ms).toBeGreaterThan(0);
});

test("multiple scripts tracked independently", async () => {
  const { shouldCatchUp, recordRun } = await loadLib();
  recordRun("script_a");
  // Write stale entry for script_b
  const statePath = join(testDir, ".claude", "state", "cron-last-run.json");
  const state = JSON.parse(readFileSync(statePath, "utf-8"));
  state.script_b = { timestamp: new Date(Date.now() - 5 * 3600000).toISOString(), epoch_ms: Date.now() - 5 * 3600000 };
  writeFileSync(statePath, JSON.stringify(state));

  const resultA = shouldCatchUp("script_a", 3600000);
  const resultB = shouldCatchUp("script_b", 3600000);
  expect(resultA.catchup_triggered).toBe(false);
  expect(resultB.catchup_triggered).toBe(true);
});

test("handles corrupted state file gracefully", async () => {
  const { shouldCatchUp } = await loadLib();
  const statePath = join(testDir, ".claude", "state", "cron-last-run.json");
  writeFileSync(statePath, "not json{{{");
  const result = shouldCatchUp("test_script", 3600000);
  // Should treat as first run, not crash
  expect(result.catchup_triggered).toBe(false);
});

test("handles missing state directory gracefully", async () => {
  const { recordRun } = await loadLib();
  // Remove state dir
  rmSync(join(testDir, ".claude", "state"), { recursive: true, force: true });
  // recordRun should recreate it
  recordRun("test_script");
  const statePath = join(testDir, ".claude", "state", "cron-last-run.json");
  expect(existsSync(statePath)).toBe(true);
});

test("humanDuration formats correctly for long gaps", async () => {
  const { shouldCatchUp } = await loadLib();
  const statePath = join(testDir, ".claude", "state", "cron-last-run.json");
  // 3 days ago for a 6-hour interval
  const threeDaysAgo = Date.now() - 3 * 24 * 3600000;
  writeFileSync(statePath, JSON.stringify({
    test_script: { timestamp: new Date(threeDaysAgo).toISOString(), epoch_ms: threeDaysAgo }
  }));
  const result = shouldCatchUp("test_script", 6 * 3600000);
  expect(result.catchup_triggered).toBe(true);
  expect(result.missed_duration_human).toMatch(/\dd/); // should contain "Xd"
});
