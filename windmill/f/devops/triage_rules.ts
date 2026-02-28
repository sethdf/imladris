// Windmill Script: Triage Rule Management
// Manage heuristic rules for Layer 1 email/message classification.
// Rules use glob patterns (* = any) on source, sender, and subject fields.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

function getCacheDir() { return process.env.CACHE_DIR || "/local/cache/triage"; }
function getDbPath() { return join(getCacheDir(), "index.db"); }

function getDb(): Database {
  mkdirSync(getCacheDir(), { recursive: true });
  const db = new Database(getDbPath(), { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  return db;
}

function ensureSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS triage_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      source_pattern TEXT DEFAULT '',
      sender_pattern TEXT DEFAULT '',
      subject_pattern TEXT DEFAULT '',
      action TEXT NOT NULL DEFAULT 'AUTO',
      urgency TEXT NOT NULL DEFAULT 'low',
      domain TEXT NOT NULL DEFAULT 'work',
      summary_template TEXT DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      hit_count INTEGER NOT NULL DEFAULT 0,
      override_count INTEGER NOT NULL DEFAULT 0,
      source TEXT DEFAULT 'seed',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}

/** Glob-to-regex matcher: * matches any chars, case-insensitive */
function globMatch(pattern: string, text: string): boolean {
  if (!pattern) return false;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(text);
}

const SEED_RULES = [
  // Email (M365) rules — source_pattern empty = match all sources
  { name: "site24x7-clear", source_pattern: "", sender_pattern: "*site24x7*", subject_pattern: "*has cleared*", action: "AUTO", urgency: "low" },
  { name: "site24x7-up", source_pattern: "", sender_pattern: "*site24x7*", subject_pattern: "*is Up*", action: "AUTO", urgency: "low" },
  { name: "site24x7-trouble", source_pattern: "", sender_pattern: "*site24x7*", subject_pattern: "*is in Trouble*", action: "NOTIFY", urgency: "high" },
  { name: "dlp-low", source_pattern: "", sender_pattern: "", subject_pattern: "*Low-severity alert: DLP*", action: "AUTO", urgency: "low" },
  { name: "dlp-high", source_pattern: "", sender_pattern: "", subject_pattern: "*High-severity alert: DLP*", action: "NOTIFY", urgency: "high" },
  { name: "phish-alert", source_pattern: "", sender_pattern: "", subject_pattern: "[Phish Alert]*", action: "AUTO", urgency: "low" },
  { name: "daily-digest", source_pattern: "", sender_pattern: "", subject_pattern: "*Daily Digest*", action: "AUTO", urgency: "low" },
  { name: "weekly-digest", source_pattern: "", sender_pattern: "", subject_pattern: "*weekly digest*", action: "AUTO", urgency: "low" },
  { name: "stall-cleared", source_pattern: "", sender_pattern: "", subject_pattern: "*stall has cleared*", action: "AUTO", urgency: "low" },
  { name: "geocode-stalled", source_pattern: "", sender_pattern: "", subject_pattern: "*FirstLogicGeocode*stalled*", action: "NOTIFY", urgency: "medium" },
  { name: "task-assigned", source_pattern: "", sender_pattern: "", subject_pattern: "Task ID:*has been assign*", action: "QUEUE", urgency: "medium" },
  { name: "sharefile-activity", source_pattern: "", sender_pattern: "", subject_pattern: "*ShareFile Activity*", action: "AUTO", urgency: "low" },
  { name: "aws-marketplace-sub", source_pattern: "", sender_pattern: "", subject_pattern: "*AWS Marketplace subscription*", action: "AUTO", urgency: "low" },
  { name: "alert-sophos", source_pattern: "", sender_pattern: "*sophos.com", subject_pattern: "", action: "AUTO", urgency: "low" },
  { name: "alert-aws-health", source_pattern: "", sender_pattern: "health@aws.com", subject_pattern: "", action: "QUEUE", urgency: "medium" },
  { name: "alert-okta", source_pattern: "", sender_pattern: "*okta.com", subject_pattern: "", action: "NOTIFY", urgency: "high" },
  { name: "alert-ms-security", source_pattern: "", sender_pattern: "MSSecurity*@microsoft.com", subject_pattern: "", action: "NOTIFY", urgency: "high" },
  { name: "alert-o365", source_pattern: "", sender_pattern: "Office365Alerts@microsoft.com", subject_pattern: "", action: "QUEUE", urgency: "medium" },
  // Slack-specific rules
  { name: "slack-slackbot", source_pattern: "slack", sender_pattern: "Slackbot*", subject_pattern: "", action: "AUTO", urgency: "low" },
  { name: "slack-bot-github", source_pattern: "slack", sender_pattern: "*github*", subject_pattern: "", action: "AUTO", urgency: "low" },
  { name: "slack-bot-jira", source_pattern: "slack", sender_pattern: "*jira*", subject_pattern: "", action: "QUEUE", urgency: "medium" },
  { name: "slack-channel-general", source_pattern: "slack", sender_pattern: "", subject_pattern: "#general", action: "AUTO", urgency: "low" },
  { name: "slack-channel-random", source_pattern: "slack", sender_pattern: "", subject_pattern: "#random", action: "AUTO", urgency: "low" },
];

export async function main(
  action: string = "list",
  name: string = "",
  source_pattern: string = "",
  sender_pattern: string = "",
  subject_pattern: string = "",
  rule_action: string = "AUTO",
  urgency: string = "low",
  summary_template: string = "",
  rule_id: number = 0,
  test_source: string = "",
  test_subject: string = "",
  test_sender: string = "",
): Promise<any> {
  const db = getDb();
  ensureSchema(db);

  try {
    switch (action) {
      case "seed": {
        let created = 0, skipped = 0;
        const insert = db.prepare(
          `INSERT OR IGNORE INTO triage_rules (name, source_pattern, sender_pattern, subject_pattern, action, urgency, source)
           VALUES (?, ?, ?, ?, ?, ?, 'seed')`
        );
        for (const rule of SEED_RULES) {
          const info = insert.run(rule.name, rule.source_pattern, rule.sender_pattern, rule.subject_pattern, rule.action, rule.urgency);
          if ((info as any).changes > 0) created++; else skipped++;
        }
        const total = (db.prepare("SELECT COUNT(*) as c FROM triage_rules").get() as any)?.c || 0;
        db.close();
        return { action: "seed", created, skipped, total_rules: total };
      }

      case "list": {
        const rules = db.prepare("SELECT * FROM triage_rules ORDER BY priority ASC, id ASC").all();
        db.close();
        return { action: "list", count: rules.length, rules };
      }

      case "add": {
        if (!name) { db.close(); return { error: "name is required for add action" }; }
        const insert = db.prepare(
          `INSERT INTO triage_rules (name, source_pattern, sender_pattern, subject_pattern, action, urgency, summary_template, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')`
        );
        try {
          insert.run(name, source_pattern, sender_pattern, subject_pattern, rule_action, urgency, summary_template);
        } catch (e: any) {
          db.close();
          return { error: `Failed to add rule: ${e.message}` };
        }
        db.close();
        return { action: "add", name, source_pattern, sender_pattern, subject_pattern, rule_action: rule_action, urgency };
      }

      case "remove": {
        if (!rule_id && !name) { db.close(); return { error: "rule_id or name required for remove" }; }
        let changes = 0;
        if (rule_id) {
          changes = (db.prepare("DELETE FROM triage_rules WHERE id = ?").run(rule_id) as any).changes;
        } else {
          changes = (db.prepare("DELETE FROM triage_rules WHERE name = ?").run(name) as any).changes;
        }
        db.close();
        return { action: "remove", removed: changes };
      }

      case "enable": {
        if (!rule_id && !name) { db.close(); return { error: "rule_id or name required for enable/disable" }; }
        // Toggle enabled state
        if (rule_id) {
          db.run("UPDATE triage_rules SET enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END, updated_at = unixepoch() WHERE id = ?", [rule_id]);
        } else {
          db.run("UPDATE triage_rules SET enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END, updated_at = unixepoch() WHERE name = ?", [name]);
        }
        db.close();
        return { action: "enable", toggled: name || rule_id };
      }

      case "test": {
        if (!test_subject && !test_sender) { db.close(); return { error: "test_subject or test_sender required" }; }
        const rules = db.prepare(
          "SELECT * FROM triage_rules WHERE enabled = 1 ORDER BY priority ASC, id ASC"
        ).all() as any[];

        let matched: any = null;
        for (const rule of rules) {
          const sourceOk = !rule.source_pattern || !test_source || globMatch(rule.source_pattern, test_source);
          const senderOk = !rule.sender_pattern || globMatch(rule.sender_pattern, test_sender);
          const subjectOk = !rule.subject_pattern || globMatch(rule.subject_pattern, test_subject);
          if (sourceOk && senderOk && subjectOk) {
            matched = rule;
            break;
          }
        }
        db.close();
        return {
          action: "test",
          test_source,
          test_subject,
          test_sender,
          matched: matched ? { name: matched.name, source_pattern: matched.source_pattern, action: matched.action, urgency: matched.urgency, priority: matched.priority } : null,
          rules_checked: rules.length,
        };
      }

      case "stats": {
        const total = (db.prepare("SELECT COUNT(*) as c FROM triage_rules").get() as any)?.c || 0;
        const enabled = (db.prepare("SELECT COUNT(*) as c FROM triage_rules WHERE enabled = 1").get() as any)?.c || 0;
        const topHits = db.prepare(
          "SELECT name, hit_count, action, urgency FROM triage_rules ORDER BY hit_count DESC LIMIT 10"
        ).all();

        // Also pull triage_results stats if available
        let resultStats: any = {};
        try {
          const resultTotal = (db.prepare("SELECT COUNT(*) as c FROM triage_results").get() as any)?.c || 0;
          const byLayer = db.prepare("SELECT classified_by, COUNT(*) as c FROM triage_results GROUP BY classified_by").all();
          const byAction = db.prepare("SELECT action, COUNT(*) as c FROM triage_results GROUP BY action").all();
          resultStats = { classified_total: resultTotal, by_layer: byLayer, by_action: byAction };
        } catch { /* triage_results may not exist yet */ }

        db.close();
        return { action: "stats", total_rules: total, enabled_rules: enabled, top_hits: topHits, ...resultStats };
      }

      default:
        db.close();
        return { error: `Unknown action: ${action}. Valid: seed, list, add, remove, enable, test, stats` };
    }
  } catch (e: any) {
    db.close();
    return { error: e.message };
  }
}
