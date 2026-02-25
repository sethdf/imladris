import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

// All Phase 6 scripts use `const HOME = homedir()` at module level.
// Subprocess execution gives each test a fresh HOME.

const HELPER = join(__dirname, "_run-helper.ts");
const SCRIPTS_DIR = join(__dirname, "..", "..", "windmill", "f", "devops");

const KNOWLEDGE_STORE = join(SCRIPTS_DIR, "knowledge_store.ts");
const CROSS_CORRELATE = join(SCRIPTS_DIR, "cross_correlate.ts");
const RESPONSE_PLAYBOOK = join(SCRIPTS_DIR, "response_playbook.ts");
const TREND_ENGINE = join(SCRIPTS_DIR, "trend_engine.ts");
const AUTO_TRIAGE = join(SCRIPTS_DIR, "auto_triage.ts");
const TRIAGE_FEEDBACK = join(SCRIPTS_DIR, "triage_feedback.ts");

function runScript(scriptPath: string, args: unknown[], tempHome: string): any {
  const result = spawnSync(
    "bun",
    ["run", HELPER, scriptPath, JSON.stringify(args)],
    {
      encoding: "utf-8",
      env: { ...process.env, HOME: tempHome },
      timeout: 30000,
    },
  );
  const stdout = (result.stdout || "").trim();
  if (!stdout) {
    throw new Error(
      `Script produced no output. stderr: ${result.stderr}`,
    );
  }
  return JSON.parse(stdout);
}

// ---------------------------------------------------------------------------
// 1. knowledge_store.ts
// ---------------------------------------------------------------------------
describe("knowledge_store", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "kb-test-"));
    mkdirSync(join(tempHome, ".claude", "state"), { recursive: true });
    mkdirSync(join(tempHome, ".claude", "logs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("stats with empty KB returns zero counts", () => {
    const result = runScript(KNOWLEDGE_STORE, ["stats"], tempHome);
    expect(result.total_entries).toBe(0);
    expect(result.unique_entities).toBe(0);
    expect(result.relationship_types).toEqual([]);
    expect(result.oldest_entry).toBeNull();
    expect(result.newest_entry).toBeNull();
    expect(result.entities_by_type).toEqual({});
  });

  test("store creates entry in knowledge.jsonl", () => {
    const result = runScript(
      KNOWLEDGE_STORE,
      [
        "store",
        "aws_instance",
        "i-abc123def",
        "aws_sg",
        "sg-xyz789",
        "co-occurrence",
        "test",
        0.8,
        "test context",
      ],
      tempHome,
    );

    expect(result.stored).toBe(true);
    expect(result.entry.entity_a.type).toBe("aws_instance");
    expect(result.entry.entity_a.value).toBe("i-abc123def");
    expect(result.entry.entity_b.type).toBe("aws_sg");
    expect(result.entry.entity_b.value).toBe("sg-xyz789");
    expect(result.entry.confidence).toBe(0.8);

    // Verify file was written
    const kbPath = join(tempHome, ".claude", "state", "knowledge.jsonl");
    expect(existsSync(kbPath)).toBe(true);
    const line = readFileSync(kbPath, "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.entity_a.value).toBe("i-abc123def");
  });

  test("query finds stored relationships by entity", () => {
    // Store two entries - one matching, one not
    runScript(
      KNOWLEDGE_STORE,
      [
        "store",
        "aws_instance",
        "i-match",
        "aws_sg",
        "sg-111",
        "co-occurrence",
        "test",
        0.9,
        "",
      ],
      tempHome,
    );
    runScript(
      KNOWLEDGE_STORE,
      [
        "store",
        "aws_instance",
        "i-other",
        "aws_sg",
        "sg-222",
        "co-occurrence",
        "test",
        0.5,
        "",
      ],
      tempHome,
    );

    // Query for entity_type=aws_instance, entity_value=i-match
    const result = runScript(
      KNOWLEDGE_STORE,
      [
        "query",
        "",
        "",
        "",
        "",
        "co-occurrence",
        "manual",
        0.5,
        "",
        "aws_instance",
        "i-match",
        90,
      ],
      tempHome,
    );

    expect(result.matches).toBe(1);
    expect(result.relationships.length).toBe(1);
    expect(result.relationships[0].entity_a.value).toBe("i-match");
  });

  test("query respects lookback_days window", () => {
    // Manually write an old entry directly to JSONL
    const kbPath = join(tempHome, ".claude", "state", "knowledge.jsonl");
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 200);
    const oldEntry = {
      timestamp: oldDate.toISOString(),
      entity_a: { type: "aws_instance", value: "i-old" },
      entity_b: { type: "aws_sg", value: "sg-old" },
      relationship: "co-occurrence",
      source: "test",
      confidence: 0.5,
    };
    writeFileSync(kbPath, JSON.stringify(oldEntry) + "\n");

    // Store a fresh entry via the script
    runScript(
      KNOWLEDGE_STORE,
      [
        "store",
        "aws_instance",
        "i-old",
        "aws_sg",
        "sg-new",
        "co-occurrence",
        "test",
        0.7,
        "",
      ],
      tempHome,
    );

    // Query with 90 days lookback - should only find the recent one
    const result = runScript(
      KNOWLEDGE_STORE,
      [
        "query",
        "",
        "",
        "",
        "",
        "co-occurrence",
        "manual",
        0.5,
        "",
        "aws_instance",
        "i-old",
        90,
      ],
      tempHome,
    );

    expect(result.matches).toBe(1);
    expect(result.relationships[0].entity_b.value).toBe("sg-new");
  });

  test("prune removes old entries", () => {
    const kbPath = join(tempHome, ".claude", "state", "knowledge.jsonl");

    // Write one old entry and one recent entry
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 200);
    const oldEntry = {
      timestamp: oldDate.toISOString(),
      entity_a: { type: "aws_instance", value: "i-old" },
      entity_b: { type: "aws_sg", value: "sg-old" },
      relationship: "co-occurrence",
      source: "test",
      confidence: 0.5,
    };
    const newEntry = {
      timestamp: new Date().toISOString(),
      entity_a: { type: "aws_instance", value: "i-new" },
      entity_b: { type: "aws_sg", value: "sg-new" },
      relationship: "co-occurrence",
      source: "test",
      confidence: 0.8,
    };
    writeFileSync(
      kbPath,
      JSON.stringify(oldEntry) + "\n" + JSON.stringify(newEntry) + "\n",
    );

    // Prune entries older than 180 days (the old entry at 200 days gets removed)
    const result = runScript(
      KNOWLEDGE_STORE,
      [
        "prune",
        "",
        "",
        "",
        "",
        "co-occurrence",
        "manual",
        0.5,
        "",
        "",
        "",
        90,
        180,
      ],
      tempHome,
    );

    expect(result.before).toBe(2);
    expect(result.after).toBe(1);
    expect(result.pruned).toBe(1);

    // Verify file only contains the new entry
    const remaining = readFileSync(kbPath, "utf-8").trim();
    const parsed = JSON.parse(remaining);
    expect(parsed.entity_a.value).toBe("i-new");
  });

  test("store with missing entity_a returns error", () => {
    // Pass empty entity_a_type and entity_a_value - should throw
    let threw = false;
    try {
      runScript(
        KNOWLEDGE_STORE,
        ["store", "", "", "aws_sg", "sg-123", "co-occurrence", "test", 0.5, ""],
        tempHome,
      );
    } catch (e: any) {
      threw = true;
      // The script throws, which means stderr has the error and stdout is empty
      expect(e.message).toContain("no output");
    }
    expect(threw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. cross_correlate.ts
// ---------------------------------------------------------------------------
describe("cross_correlate", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "correlate-test-"));
    mkdirSync(join(tempHome, ".claude", "state"), { recursive: true });
    mkdirSync(join(tempHome, ".claude", "logs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("dry_run processes logs without writing to KB", () => {
    // Create feed-events.jsonl with co-occurring entities
    const feedPath = join(
      tempHome,
      ".claude",
      "logs",
      "feed-events.jsonl",
    );
    const now = new Date().toISOString();
    const entries = [
      { timestamp: now, title: "Instance i-0abc1234 in sg-0def5678 alert" },
      { timestamp: now, title: "Instance i-0abc1234 in sg-0def5678 again" },
      { timestamp: now, title: "Instance i-0abc1234 with sg-0def5678 third" },
    ];
    writeFileSync(
      feedPath,
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    // dry_run=true, min_co_occurrences=2
    const result = runScript(
      CROSS_CORRELATE,
      [7, 2, true],
      tempHome,
    );

    expect(result.dry_run).toBe(true);
    expect(result.new_correlations_stored).toBe(0);

    // KB should not exist or be empty
    const kbPath = join(tempHome, ".claude", "state", "knowledge.jsonl");
    if (existsSync(kbPath)) {
      const content = readFileSync(kbPath, "utf-8").trim();
      expect(content).toBe("");
    }
  });

  test("handles missing log files gracefully", () => {
    // Run with no log files at all
    const result = runScript(
      CROSS_CORRELATE,
      [7, 2, true],
      tempHome,
    );

    expect(result.sources_scanned).toBe(0);
    expect(result.entries_processed).toBe(0);
    expect(result.entities_found).toBe(0);
    expect(result.correlations_found).toBe(0);
  });

  test("finds co-occurring entities from feed-events.jsonl", () => {
    const feedPath = join(
      tempHome,
      ".claude",
      "logs",
      "feed-events.jsonl",
    );
    const now = new Date().toISOString();
    // Same two entities appearing together multiple times (>= min_co_occurrences)
    const entries = [
      { timestamp: now, text: "i-0abc12345678 sg-0def56789012" },
      { timestamp: now, text: "i-0abc12345678 sg-0def56789012" },
      { timestamp: now, text: "i-0abc12345678 sg-0def56789012" },
    ];
    writeFileSync(
      feedPath,
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const result = runScript(
      CROSS_CORRELATE,
      [7, 2, false],
      tempHome,
    );

    expect(result.entities_found).toBeGreaterThanOrEqual(2);
    expect(result.correlations_found).toBeGreaterThanOrEqual(1);
    expect(result.new_correlations_stored).toBeGreaterThanOrEqual(1);

    // Verify KB was written
    const kbPath = join(tempHome, ".claude", "state", "knowledge.jsonl");
    expect(existsSync(kbPath)).toBe(true);
    const kbContent = readFileSync(kbPath, "utf-8").trim();
    expect(kbContent.length).toBeGreaterThan(0);
  });

  test("returns structured graph with nodes and edges", () => {
    const feedPath = join(
      tempHome,
      ".claude",
      "logs",
      "feed-events.jsonl",
    );
    const now = new Date().toISOString();
    const entries = [
      { timestamp: now, text: "i-0abc12345678 sg-0def56789012 vpc-0aaa11112222" },
      { timestamp: now, text: "i-0abc12345678 sg-0def56789012 vpc-0aaa11112222" },
      { timestamp: now, text: "i-0abc12345678 sg-0def56789012" },
    ];
    writeFileSync(
      feedPath,
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const result = runScript(
      CROSS_CORRELATE,
      [7, 2, true],
      tempHome,
    );

    expect(result.graph).toBeDefined();
    expect(Array.isArray(result.graph.nodes)).toBe(true);
    expect(Array.isArray(result.graph.edges)).toBe(true);

    // Nodes should have type, value, occurrence_count
    if (result.graph.nodes.length > 0) {
      const node = result.graph.nodes[0];
      expect(node).toHaveProperty("type");
      expect(node).toHaveProperty("value");
      expect(node).toHaveProperty("occurrence_count");
    }

    // Edges should have entity_a, entity_b, weight, sources
    if (result.graph.edges.length > 0) {
      const edge = result.graph.edges[0];
      expect(edge).toHaveProperty("entity_a");
      expect(edge).toHaveProperty("entity_b");
      expect(edge).toHaveProperty("weight");
      expect(edge).toHaveProperty("sources");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. response_playbook.ts
// ---------------------------------------------------------------------------
describe("response_playbook", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "playbook-test-"));
    mkdirSync(join(tempHome, ".claude", "logs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("rejects execution when approval_id is missing", () => {
    const result = runScript(
      RESPONSE_PLAYBOOK,
      ["isolate_instance", "i-0abc123", ""],
      tempHome,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("approval_id is required");
    expect(result.playbook).toBe("isolate_instance");
  });

  test("rejects execution when approval_id is empty string with spaces", () => {
    const result = runScript(
      RESPONSE_PLAYBOOK,
      ["revoke_sg_rule", "sg-0abc123", "   "],
      tempHome,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("approval_id is required");
  });

  test("dry_run returns command without executing", () => {
    const result = runScript(
      RESPONSE_PLAYBOOK,
      ["revoke_sg_rule", "sg-0test123", "approval-42", true, "{}"],
      tempHome,
    );

    // dry_run should succeed (runAws returns DRY RUN message)
    expect(result.success).toBe(true);
    expect(result.output).toContain("[DRY RUN]");
    expect(result.approval_id).toBe("approval-42");
    expect(result.playbook).toBe("revoke_sg_rule");
  });

  test("unknown playbook returns error", () => {
    const result = runScript(
      RESPONSE_PLAYBOOK,
      ["nuke_everything", "some-resource", "approval-99", true],
      tempHome,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown playbook: nuke_everything");
    expect(result.error).toContain("Available:");
  });

  test("logs execution to playbook-executions.jsonl", () => {
    runScript(
      RESPONSE_PLAYBOOK,
      ["revoke_sg_rule", "sg-0test456", "approval-77", true, "{}"],
      tempHome,
    );

    const logPath = join(
      tempHome,
      ".claude",
      "logs",
      "playbook-executions.jsonl",
    );
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, "utf-8").trim();
    const entry = JSON.parse(content);
    expect(entry.playbook).toBe("revoke_sg_rule");
    expect(entry.approval_id).toBe("approval-77");
    expect(entry.dry_run).toBe(true);
    expect(entry.timestamp).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4. trend_engine.ts
// ---------------------------------------------------------------------------
describe("trend_engine", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "trend-test-"));
    mkdirSync(join(tempHome, ".claude", "logs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  // Helper: generate JSONL with timestamps spread across weeks
  function writeTrendData(filename: string, weekCounts: number[]): void {
    const logPath = join(tempHome, ".claude", "logs", filename);
    const lines: string[] = [];
    const now = Date.now();

    // weekCounts[0] = events in oldest week, last = events in most recent week
    for (let w = 0; w < weekCounts.length; w++) {
      const weekOffset = (weekCounts.length - 1 - w) * 7 * 86400000;
      for (let i = 0; i < weekCounts[w]; i++) {
        // Spread events within the week
        const ts = new Date(now - weekOffset + i * 3600000).toISOString();
        lines.push(JSON.stringify({ timestamp: ts, event: "test" }));
      }
    }

    writeFileSync(logPath, lines.join("\n") + "\n");
  }

  test("alert_threshold triggers alert when change_pct exceeds it", () => {
    // Create steeply increasing data: first weeks low, recent weeks high
    // 6 weeks: [1, 1, 1, 5, 10, 15] - strong increase
    writeTrendData("feed-events.jsonl", [1, 1, 1, 5, 10, 15]);

    const result = runScript(
      TREND_ENGINE,
      [
        "feed_events", // metric
        "week",        // period
        90,            // lookback_days
        "",            // filter_field
        "",            // filter_value
        30,            // alert_threshold (low to ensure trigger)
        true,          // alert_on_increase
      ],
      tempHome,
    );

    expect(result.alerts_fired).toBeGreaterThanOrEqual(1);

    // Verify alerts.jsonl was written
    const alertPath = join(tempHome, ".claude", "logs", "alerts.jsonl");
    expect(existsSync(alertPath)).toBe(true);
    const alertLine = readFileSync(alertPath, "utf-8").trim().split("\n")[0];
    const alert = JSON.parse(alertLine);
    expect(alert.metric).toBe("feed_events");
    expect(alert.trend).toBe("increasing");
    expect(Math.abs(alert.change_pct)).toBeGreaterThan(30);
  });

  test("no alert fired when change_pct below threshold", () => {
    // Create stable data: equal events per week
    // 4 weeks: [5, 5, 5, 5] - stable, ~0% change
    writeTrendData("feed-events.jsonl", [5, 5, 5, 5]);

    const result = runScript(
      TREND_ENGINE,
      [
        "feed_events",
        "week",
        90,
        "",
        "",
        50,   // high threshold
        true,
      ],
      tempHome,
    );

    expect(result.alerts_fired).toBe(0);

    // alerts.jsonl should not exist
    const alertPath = join(tempHome, ".claude", "logs", "alerts.jsonl");
    expect(existsSync(alertPath)).toBe(false);
  });

  test("alerts written to alerts.jsonl", () => {
    // Create strongly decreasing data to trigger alert
    // 6 weeks: [15, 12, 8, 3, 1, 1] - strong decrease
    writeTrendData("feed-events.jsonl", [15, 12, 8, 3, 1, 1]);

    const result = runScript(
      TREND_ENGINE,
      [
        "feed_events",
        "week",
        90,
        "",
        "",
        20,   // low threshold
        true,
      ],
      tempHome,
    );

    expect(result.alerts_fired).toBeGreaterThanOrEqual(1);

    const alertPath = join(tempHome, ".claude", "logs", "alerts.jsonl");
    expect(existsSync(alertPath)).toBe(true);

    const lines = readFileSync(alertPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const alert = JSON.parse(lines[0]);
    expect(alert).toHaveProperty("timestamp");
    expect(alert).toHaveProperty("metric");
    expect(alert).toHaveProperty("change_pct");
    expect(alert).toHaveProperty("threshold");
    expect(alert).toHaveProperty("trend");
    expect(alert).toHaveProperty("description");
  });
});

// ---------------------------------------------------------------------------
// 5. auto_triage.ts  (calibration read tests)
// ---------------------------------------------------------------------------
describe("auto_triage calibration", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "triage-cal-test-"));
    mkdirSync(join(tempHome, ".claude", "logs"), { recursive: true });
    mkdirSync(join(tempHome, ".claude", "state"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("still works without calibration file (backwards compatible)", () => {
    // No calibration file exists - should not error
    // auto_triage calls claude CLI which won't exist, so it hits fallback
    const result = runScript(
      AUTO_TRIAGE,
      ["test-source", "test-event", "Test payload without calibration", true],
      tempHome,
    );

    // Either dry_run path or error/fallback - both are valid
    if (result.error) {
      expect(result.fallback).toBeTruthy();
      expect(result.fallback.action).toBe("QUEUE");
    } else if (result.dry_run) {
      expect(result.triage).toBeTruthy();
    }
    // Key: no crash, no calibration-related error
  });

  test("reads calibration file when present (verify it does not error)", () => {
    // Write a calibration file
    const calibrationPath = join(
      tempHome,
      ".claude",
      "state",
      "triage-calibration.json",
    );
    const calibration = {
      last_updated: new Date().toISOString(),
      total_events: 20,
      accuracy_rate: 75,
      over_triage_rate: 15,
      under_triage_rate: 10,
      by_source: {
        AUTO: { total: 8, correct: 5, accuracy: 62 },
        QUEUE: { total: 7, correct: 6, accuracy: 86 },
        NOTIFY: { total: 5, correct: 4, accuracy: 80 },
      },
      recommendations: ["AUTO accuracy below 80%."],
      threshold_adjustments: [
        { action: "AUTO", direction: "demote", reason: "Accuracy 62%" },
      ],
    };
    writeFileSync(calibrationPath, JSON.stringify(calibration, null, 2));

    const result = runScript(
      AUTO_TRIAGE,
      ["test-source", "security-alert", "Suspicious login from new IP", true],
      tempHome,
    );

    // Should not crash when calibration exists
    if (result.error) {
      expect(result.fallback).toBeTruthy();
    } else if (result.dry_run) {
      expect(result.triage).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. triage_feedback.ts (threshold_adjustments tests)
// ---------------------------------------------------------------------------
describe("triage_feedback threshold_adjustments", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "feedback-adj-test-"));
    mkdirSync(join(tempHome, ".claude", "logs"), { recursive: true });
    mkdirSync(join(tempHome, ".claude", "state"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("calibrate action includes threshold_adjustments in output", () => {
    // Record feedback entries
    runScript(
      TRIAGE_FEEDBACK,
      ["record", "evt-1", "NOTIFY", "high", "correct", ""],
      tempHome,
    );
    runScript(
      TRIAGE_FEEDBACK,
      ["record", "evt-2", "QUEUE", "medium", "correct", ""],
      tempHome,
    );
    runScript(
      TRIAGE_FEEDBACK,
      ["record", "evt-3", "AUTO", "low", "correct", ""],
      tempHome,
    );

    const result = runScript(
      TRIAGE_FEEDBACK,
      ["calibrate"],
      tempHome,
    );

    expect(result.threshold_adjustments).toBeDefined();
    expect(Array.isArray(result.threshold_adjustments)).toBe(true);
    expect(result.threshold_adjustments.length).toBeGreaterThan(0);

    // Each adjustment should have action, direction, reason
    for (const adj of result.threshold_adjustments) {
      expect(adj).toHaveProperty("action");
      expect(adj).toHaveProperty("direction");
      expect(adj).toHaveProperty("reason");
      expect(["promote", "demote", "hold"]).toContain(adj.direction);
    }

    // Verify calibration file was written
    const calPath = join(
      tempHome,
      ".claude",
      "state",
      "triage-calibration.json",
    );
    expect(existsSync(calPath)).toBe(true);
  });

  test("threshold_adjustments contains demote for low accuracy actions", () => {
    // Record entries where AUTO is mostly wrong (< 70% accuracy)
    // 10 AUTO entries: 5 correct, 5 under_triaged = 50% accuracy -> demote
    for (let i = 0; i < 5; i++) {
      runScript(
        TRIAGE_FEEDBACK,
        ["record", `evt-correct-${i}`, "AUTO", "low", "correct", ""],
        tempHome,
      );
    }
    for (let i = 0; i < 5; i++) {
      runScript(
        TRIAGE_FEEDBACK,
        ["record", `evt-under-${i}`, "AUTO", "low", "under_triaged", ""],
        tempHome,
      );
    }

    const result = runScript(
      TRIAGE_FEEDBACK,
      ["calibrate"],
      tempHome,
    );

    expect(result.threshold_adjustments).toBeDefined();

    const autoAdj = result.threshold_adjustments.find(
      (a: any) => a.action === "AUTO",
    );
    expect(autoAdj).toBeDefined();
    expect(autoAdj.direction).toBe("demote");
    expect(autoAdj.reason).toContain("< 70%");
  });
});
