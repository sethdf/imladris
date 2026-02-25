import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

let testDir: string;
let originalHome: string | undefined;

const HELPER = join(import.meta.dir, "_run-helper.ts");
const SCRIPT = join(import.meta.dir, "../../windmill/f/devops/upstream_updates.ts");

beforeEach(() => {
  testDir = join(tmpdir(), `upstream-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(testDir, ".claude", "state"), { recursive: true });
  mkdirSync(join(testDir, ".claude", "logs"), { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = testDir;
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

function runScript(dryRun = true): any {
  const result = execSync(
    `bun run ${HELPER} ${SCRIPT} '[${dryRun}]'`,
    { env: { ...process.env, HOME: testDir }, encoding: "utf-8", timeout: 60000 }
  );
  return JSON.parse(result.trim());
}

test("dry_run mode returns report without writing state files", () => {
  const result = runScript(true);
  expect(result.report).toContain("UPSTREAM DEPENDENCY UPDATE REPORT");
  expect(result.sources_checked).toBeGreaterThanOrEqual(6);
  // Seen file should NOT exist in dry_run
  const seenFile = join(testDir, ".claude", "state", "upstream-seen.json");
  expect(existsSync(seenFile)).toBe(false);
}, 45000);

test("non-dry-run mode writes seen state file", () => {
  const result = runScript(false);
  expect(result.report).toContain("UPSTREAM DEPENDENCY UPDATE REPORT");
  const seenFile = join(testDir, ".claude", "state", "upstream-seen.json");
  expect(existsSync(seenFile)).toBe(true);
  const seen = JSON.parse(readFileSync(seenFile, "utf-8"));
  // Should have entries for at least some repos
  expect(Object.keys(seen).length).toBeGreaterThan(0);
}, 45000);

test("second run reports fewer updates (dedup via seen state)", () => {
  const first = runScript(false);
  const second = runScript(false);
  // Second run should find fewer or equal updates (seen state filters them)
  expect(second.updates_found).toBeLessThanOrEqual(first.updates_found);
}, 90000);

test("report includes relevance descriptions for found updates", () => {
  const result = runScript(true);
  if (result.updates_found > 0) {
    // If any updates found, report should contain "Why it matters"
    expect(result.report).toContain("Why it matters:");
  }
}, 45000);

test("sources_checked covers all monitored repos, npm, and blogs", () => {
  const result = runScript(true);
  // 15 GitHub repos + 1 npm package + 5 blogs = 21
  expect(result.sources_checked).toBe(21);
}, 45000);

test("errors array captures failures without crashing", () => {
  const result = runScript(true);
  expect(Array.isArray(result.errors)).toBe(true);
  // Script should not throw even if some repos fail
}, 45000);

test("JSONL log written on non-dry-run when updates found", () => {
  const result = runScript(false);
  const logFile = join(testDir, ".claude", "logs", "upstream-updates.jsonl");
  if (result.updates_found > 0) {
    expect(existsSync(logFile)).toBe(true);
    const lines = readFileSync(logFile, "utf-8").trim().split("\n");
    expect(lines.length).toBe(result.updates_found);
    // Each line should be valid JSON
    for (const line of lines) {
      const entry = JSON.parse(line);
      expect(entry.source).toBeDefined();
      expect(entry.checked_at).toBeDefined();
    }
  }
}, 45000);

test("no hardcoded API tokens in script source", () => {
  const source = readFileSync(SCRIPT, "utf-8");
  expect(source).not.toContain("ghp_");
  expect(source).not.toContain("github_pat_");
  expect(source).not.toContain("Bearer ");
  expect(source).not.toContain("Authorization");
});
