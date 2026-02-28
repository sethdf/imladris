// cache_lib.ts — SQLite-backed triage cache on NVMe
// Cross-source searchable cache with entity index and FTS5.
// Ephemeral by design: lives on /local (NVMe), lost on instance stop.
// Zero external dependencies — uses bun:sqlite (built into Bun).

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync, readdirSync, unlinkSync, writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";

function getCacheDir() { return process.env.CACHE_DIR || "/local/cache/triage"; }
function getDbPath() { return join(getCacheDir(), "index.db"); }
function getDataDir() { return join(getCacheDir(), "data"); }
function getMaxSizeGb() { return Number(process.env.CACHE_MAX_SIZE_GB || "100"); }

// Entity extraction patterns (inline — no external dependency)
const ENTITY_PATTERNS: Array<{ type: string; regex: RegExp }> = [
  { type: "instance", regex: /\bi-[0-9a-f]{8,17}\b/gi },
  { type: "sg", regex: /\bsg-[0-9a-f]{8,17}\b/gi },
  { type: "cve", regex: /\bCVE-\d{4}-\d{4,}\b/gi },
  { type: "ip", regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g },
  { type: "ticket", regex: /\b(?:ticket|request|SR)[- #]?(\d{4,})\b/gi },
  { type: "s3_bucket", regex: /\bs3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\b/gi },
  { type: "arn", regex: /\barn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[a-zA-Z0-9/:._-]+\b/g },
  { type: "subnet", regex: /\bsubnet-[0-9a-f]{8,17}\b/gi },
  { type: "vpc", regex: /\bvpc-[0-9a-f]{8,17}\b/gi },
  { type: "ami", regex: /\bami-[0-9a-f]{8,17}\b/gi },
  { type: "vol", regex: /\bvol-[0-9a-f]{8,17}\b/gi },
];

/** Extract entities from text */
export function extractEntities(text: string): Array<{ entity: string; type: string }> {
  const results: Array<{ entity: string; type: string }> = [];
  const seen = new Set<string>();
  for (const { type, regex } of ENTITY_PATTERNS) {
    const matches = text.match(regex) || [];
    for (const m of matches) {
      const key = `${type}:${m.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ entity: m, type });
      }
    }
  }
  return results;
}

/** Check if NVMe cache is available */
export function isAvailable(): boolean {
  try {
    const parent = dirname(getCacheDir());
    return existsSync(parent);
  } catch {
    return false;
  }
}

/** Get or create the database */
function getDb(): Database | null {
  if (!isAvailable()) return null;
  try {
    mkdirSync(getCacheDir(), { recursive: true });
    mkdirSync(getDataDir(), { recursive: true });
    const db = new Database(getDbPath(), { create: true });
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=NORMAL");
    return db;
  } catch {
    return null;
  }
}

/** Initialize schema (idempotent) */
export function init(): boolean {
  const db = getDb();
  if (!db) return false;
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        cached_at INTEGER NOT NULL,
        file_path TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_items_source ON items(source);
      CREATE INDEX IF NOT EXISTS idx_items_cached_at ON items(cached_at);

      CREATE TABLE IF NOT EXISTS entity_index (
        entity TEXT NOT NULL,
        item_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_entity ON entity_index(entity);
      CREATE INDEX IF NOT EXISTS idx_entity_item ON entity_index(item_id);
    `);

    // ── Triage pipeline tables ──
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
      CREATE INDEX IF NOT EXISTS idx_triage_rules_priority ON triage_rules(priority);
      CREATE INDEX IF NOT EXISTS idx_triage_rules_enabled ON triage_rules(enabled);

      CREATE TABLE IF NOT EXISTS triage_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL DEFAULT 'm365',
        message_id TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        sender TEXT NOT NULL DEFAULT '',
        received_at TEXT DEFAULT '',
        action TEXT NOT NULL,
        urgency TEXT NOT NULL DEFAULT 'low',
        summary TEXT NOT NULL DEFAULT '',
        reasoning TEXT NOT NULL DEFAULT '',
        domain TEXT NOT NULL DEFAULT 'work',
        classified_by TEXT NOT NULL DEFAULT 'L2_ai',
        rule_id INTEGER DEFAULT NULL,
        dedup_hash TEXT DEFAULT '',
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        human_override TEXT DEFAULT NULL,
        override_notes TEXT DEFAULT '',
        marked_read INTEGER NOT NULL DEFAULT 0,
        metadata TEXT DEFAULT '{}',
        task_id TEXT DEFAULT NULL,
        classified_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_triage_results_dedup ON triage_results(dedup_hash, classified_at);
      CREATE INDEX IF NOT EXISTS idx_triage_results_source ON triage_results(source);
      CREATE INDEX IF NOT EXISTS idx_triage_results_action ON triage_results(action);
      CREATE INDEX IF NOT EXISTS idx_triage_results_classified_by ON triage_results(classified_by);
      CREATE INDEX IF NOT EXISTS idx_triage_results_message ON triage_results(message_id);
      CREATE INDEX IF NOT EXISTS idx_triage_results_task ON triage_results(task_id);
    `);

    // Migration: add task_id column to existing triage_results tables
    try {
      db.exec("ALTER TABLE triage_results ADD COLUMN task_id TEXT DEFAULT NULL");
    } catch {
      // Column already exists — expected on subsequent runs
    }
    try {
      db.exec("CREATE INDEX IF NOT EXISTS idx_triage_results_task ON triage_results(task_id)");
    } catch { /* index may already exist */ }

    // FTS5 — try to create, gracefully handle if unavailable
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
          title, body, content=items, content_rowid=rowid
        );
        CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
          INSERT INTO items_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
        END;
        CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
          INSERT INTO items_fts(items_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
        END;
        CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
          INSERT INTO items_fts(items_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
          INSERT INTO items_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
        END;
      `);
    } catch {
      // FTS5 not available — search will fall back to LIKE
    }
    db.close();
    return true;
  } catch {
    db.close();
    return false;
  }
}

export interface CacheItem {
  id: string;
  source: string;
  type: string;
  title: string;
  body: string;
  cached_at: number;
  file_path: string | null;
  entities?: Array<{ entity: string; type: string }>;
}

/** Store an item in the cache */
export function store(
  source: string,
  type: string,
  id: string,
  title: string,
  body: string,
  rawJson?: unknown
): CacheItem | null {
  const db = getDb();
  if (!db) return null;
  try {
    init(); // ensure schema

    const itemId = `${source}:${type}:${id}`;
    const now = Math.floor(Date.now() / 1000);

    // Store raw JSON to disk if provided
    let filePath: string | null = null;
    if (rawJson !== undefined) {
      const dir = join(getDataDir(), source);
      mkdirSync(dir, { recursive: true });
      filePath = join(dir, `${type}-${id}.json`);
      writeFileSync(filePath, JSON.stringify(rawJson, null, 2));
    }

    // Upsert item
    db.exec("DELETE FROM entity_index WHERE item_id = ?", [itemId]);
    db.run(
      `INSERT OR REPLACE INTO items (id, source, type, title, body, cached_at, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [itemId, source, type, title, body, now, filePath]
    );

    // Extract and index entities
    const searchText = `${title} ${body}`;
    const entities = extractEntities(searchText);
    const insertEntity = db.prepare(
      "INSERT INTO entity_index (entity, item_id, entity_type) VALUES (?, ?, ?)"
    );
    for (const { entity, type: entityType } of entities) {
      insertEntity.run(entity, itemId, entityType);
    }

    db.close();
    return { id: itemId, source, type, title, body, cached_at: now, file_path: filePath, entities };
  } catch (e) {
    db.close();
    return null;
  }
}

/** Query by entity — returns items from any source that mention this entity */
export function queryEntity(entity: string, limit = 50): CacheItem[] {
  const db = getDb();
  if (!db) return [];
  try {
    init();
    const rows = db.prepare(`
      SELECT DISTINCT i.id, i.source, i.type, i.title, i.body, i.cached_at, i.file_path
      FROM items i
      JOIN entity_index e ON i.id = e.item_id
      WHERE e.entity = ? COLLATE NOCASE
      ORDER BY i.cached_at DESC
      LIMIT ?
    `).all(entity, limit) as CacheItem[];
    db.close();
    return rows;
  } catch {
    db.close();
    return [];
  }
}

/** Full-text search across all cached items */
export function search(query: string, source?: string, limit = 50): CacheItem[] {
  const db = getDb();
  if (!db) return [];
  try {
    init();

    // Try FTS5 first
    try {
      const ftsQuery = source
        ? `SELECT i.id, i.source, i.type, i.title, i.body, i.cached_at, i.file_path
           FROM items_fts f
           JOIN items i ON i.rowid = f.rowid
           WHERE items_fts MATCH ? AND i.source = ?
           ORDER BY rank
           LIMIT ?`
        : `SELECT i.id, i.source, i.type, i.title, i.body, i.cached_at, i.file_path
           FROM items_fts f
           JOIN items i ON i.rowid = f.rowid
           WHERE items_fts MATCH ?
           ORDER BY rank
           LIMIT ?`;

      const rows = source
        ? db.prepare(ftsQuery).all(query, source, limit) as CacheItem[]
        : db.prepare(ftsQuery).all(query, limit) as CacheItem[];
      db.close();
      return rows;
    } catch {
      // FTS5 unavailable — fall back to LIKE
      const likeQuery = `%${query}%`;
      const sql = source
        ? `SELECT * FROM items WHERE (title LIKE ? OR body LIKE ?) AND source = ? ORDER BY cached_at DESC LIMIT ?`
        : `SELECT * FROM items WHERE (title LIKE ? OR body LIKE ?) ORDER BY cached_at DESC LIMIT ?`;

      const rows = source
        ? db.prepare(sql).all(likeQuery, likeQuery, source, limit) as CacheItem[]
        : db.prepare(sql).all(likeQuery, likeQuery, limit) as CacheItem[];
      db.close();
      return rows;
    }
  } catch {
    db.close();
    return [];
  }
}

/** Get recent items, optionally filtered by source */
export function recent(source?: string, limit = 20): CacheItem[] {
  const db = getDb();
  if (!db) return [];
  try {
    init();
    const sql = source
      ? "SELECT * FROM items WHERE source = ? ORDER BY cached_at DESC LIMIT ?"
      : "SELECT * FROM items ORDER BY cached_at DESC LIMIT ?";
    const rows = source
      ? db.prepare(sql).all(source, limit) as CacheItem[]
      : db.prepare(sql).all(limit) as CacheItem[];
    db.close();
    return rows;
  } catch {
    db.close();
    return [];
  }
}

/** Get cache statistics */
export function stats(): { total: number; by_source: Record<string, number>; entities: number; size_mb: number } {
  const db = getDb();
  if (!db) return { total: 0, by_source: {}, entities: 0, size_mb: 0 };
  try {
    init();
    const total = (db.prepare("SELECT COUNT(*) as c FROM items").get() as any)?.c || 0;
    const entityCount = (db.prepare("SELECT COUNT(*) as c FROM entity_index").get() as any)?.c || 0;

    const bySource: Record<string, number> = {};
    const rows = db.prepare("SELECT source, COUNT(*) as c FROM items GROUP BY source").all() as any[];
    for (const r of rows) bySource[r.source] = r.c;

    // Estimate size from DB file + data dir
    let sizeMb = 0;
    try {
      if (existsSync(getDbPath())) sizeMb += statSync(getDbPath()).size / 1048576;
      sizeMb += dirSizeMb(getDataDir());
    } catch { /* ignore */ }

    db.close();
    return { total, by_source: bySource, entities: entityCount, size_mb: Math.round(sizeMb * 100) / 100 };
  } catch {
    db.close();
    return { total: 0, by_source: {}, entities: 0, size_mb: 0 };
  }
}

/** Size-based eviction — remove oldest items until under maxSizeGb */
export function evict(maxSizeGb = getMaxSizeGb()): { removed: number; size_mb_after: number } {
  const db = getDb();
  if (!db) return { removed: 0, size_mb_after: 0 };
  try {
    init();
    let removed = 0;
    const maxSizeMb = maxSizeGb * 1024;

    let currentSizeMb = 0;
    if (existsSync(getDbPath())) currentSizeMb += statSync(getDbPath()).size / 1048576;
    currentSizeMb += dirSizeMb(getDataDir());

    while (currentSizeMb > maxSizeMb) {
      const oldest = db.prepare(
        "SELECT id, file_path FROM items ORDER BY cached_at ASC LIMIT 1"
      ).get() as { id: string; file_path: string | null } | undefined;

      if (!oldest) break;

      // Delete raw JSON file
      if (oldest.file_path && existsSync(oldest.file_path)) {
        unlinkSync(oldest.file_path);
      }

      // Delete from DB (CASCADE removes entity_index entries)
      db.run("DELETE FROM items WHERE id = ?", [oldest.id]);
      removed++;

      // Recalculate size
      currentSizeMb = 0;
      if (existsSync(getDbPath())) currentSizeMb += statSync(getDbPath()).size / 1048576;
      currentSizeMb += dirSizeMb(getDataDir());
    }

    db.close();
    return { removed, size_mb_after: Math.round(currentSizeMb * 100) / 100 };
  } catch {
    db.close();
    return { removed: 0, size_mb_after: 0 };
  }
}

/** Recursively calculate directory size in MB */
function dirSizeMb(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += dirSizeMb(full);
      } else {
        total += statSync(full).size;
      }
    }
  } catch { /* ignore permission errors */ }
  return total / 1048576;
}

/** Get the raw JSON for a cached item (from disk) */
export function getRaw(itemId: string): unknown | null {
  const db = getDb();
  if (!db) return null;
  try {
    init();
    const row = db.prepare("SELECT file_path FROM items WHERE id = ?").get(itemId) as { file_path: string | null } | undefined;
    db.close();
    if (row?.file_path && existsSync(row.file_path)) {
      return JSON.parse(readFileSync(row.file_path, "utf-8"));
    }
    return null;
  } catch {
    db.close();
    return null;
  }
}

// ── Triage pipeline helpers ──

/** Glob-to-regex matcher: * matches any chars, case-insensitive */
export function globMatch(pattern: string, text: string): boolean {
  if (!pattern) return false;
  // Escape regex special chars except *, then convert * to .*
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(text);
}

export interface TriageRule {
  id: number;
  name: string;
  source_pattern: string;
  sender_pattern: string;
  subject_pattern: string;
  action: string;
  urgency: string;
  domain: string;
  summary_template: string;
  enabled: number;
  priority: number;
  hit_count: number;
  override_count: number;
  source: string;
  created_at: number;
  updated_at: number;
}

/** Find the first matching enabled rule, ordered by priority (lower = higher priority) */
export function matchRule(source: string, sender: string, subject: string): TriageRule | null {
  const db = getDb();
  if (!db) return null;
  try {
    init();
    const rules = db.prepare(
      "SELECT * FROM triage_rules WHERE enabled = 1 ORDER BY priority ASC, id ASC"
    ).all() as TriageRule[];
    db.close();

    for (const rule of rules) {
      const sourceMatch = !rule.source_pattern || globMatch(rule.source_pattern, source);
      const senderMatch = !rule.sender_pattern || globMatch(rule.sender_pattern, sender);
      const subjectMatch = !rule.subject_pattern || globMatch(rule.subject_pattern, subject);
      if (sourceMatch && senderMatch && subjectMatch) {
        return rule;
      }
    }
    return null;
  } catch {
    db.close();
    return null;
  }
}

/** Increment hit_count for a rule */
export function incrementRuleHit(ruleId: number): void {
  const db = getDb();
  if (!db) return;
  try {
    init();
    db.run("UPDATE triage_rules SET hit_count = hit_count + 1, updated_at = unixepoch() WHERE id = ?", [ruleId]);
    db.close();
  } catch {
    db.close();
  }
}

export interface DedupResult {
  found: boolean;
  existing?: {
    action: string;
    urgency: string;
    summary: string;
    reasoning: string;
    domain: string;
    rule_id: number | null;
    classified_by: string;
    id: number;
  };
}

/** Check for dedup match within time window (default 4 hours = 14400s) */
export function checkDedup(hash: string, windowSeconds: number = 14400): DedupResult {
  const db = getDb();
  if (!db) return { found: false };
  try {
    init();
    const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;
    const row = db.prepare(
      `SELECT id, action, urgency, summary, reasoning, domain, rule_id, classified_by
       FROM triage_results
       WHERE dedup_hash = ? AND classified_at >= ?
       ORDER BY classified_at DESC LIMIT 1`
    ).get(hash, cutoff) as any | undefined;

    if (row) {
      db.run(
        "UPDATE triage_results SET occurrence_count = occurrence_count + 1 WHERE id = ?",
        [row.id]
      );
      db.close();
      return { found: true, existing: row };
    }
    db.close();
    return { found: false };
  } catch {
    db.close();
    return { found: false };
  }
}

export interface TriageResultInput {
  source: string;
  message_id: string;
  subject: string;
  sender: string;
  received_at: string;
  action: string;
  urgency: string;
  summary: string;
  reasoning: string;
  domain: string;
  classified_by: string;
  rule_id?: number | null;
  dedup_hash: string;
  marked_read: number;
  metadata?: string;
  task_id?: string | null;
}

/** Insert a triage classification result */
export function storeTriageResult(result: TriageResultInput): number | null {
  const db = getDb();
  if (!db) return null;
  try {
    init();
    const stmt = db.prepare(
      `INSERT INTO triage_results
       (source, message_id, subject, sender, received_at, action, urgency, summary, reasoning, domain, classified_by, rule_id, dedup_hash, marked_read, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const info = stmt.run(
      result.source,
      result.message_id,
      result.subject,
      result.sender,
      result.received_at,
      result.action,
      result.urgency,
      result.summary,
      result.reasoning,
      result.domain,
      result.classified_by,
      result.rule_id ?? null,
      result.dedup_hash,
      result.marked_read,
      result.metadata || "{}",
    );
    db.close();
    return (info as any).lastInsertRowid ?? null;
  } catch {
    db.close();
    return null;
  }
}

/** Aggregate triage stats by layer, action, and source */
export function triageStats(): {
  total: number;
  by_layer: Record<string, number>;
  by_action: Record<string, number>;
  by_source: Record<string, number>;
  rules_total: number;
  rules_enabled: number;
} {
  const db = getDb();
  if (!db) return { total: 0, by_layer: {}, by_action: {}, by_source: {}, rules_total: 0, rules_enabled: 0 };
  try {
    init();
    const total = (db.prepare("SELECT COUNT(*) as c FROM triage_results").get() as any)?.c || 0;

    const byLayer: Record<string, number> = {};
    for (const r of db.prepare("SELECT classified_by, COUNT(*) as c FROM triage_results GROUP BY classified_by").all() as any[]) {
      byLayer[r.classified_by] = r.c;
    }

    const byAction: Record<string, number> = {};
    for (const r of db.prepare("SELECT action, COUNT(*) as c FROM triage_results GROUP BY action").all() as any[]) {
      byAction[r.action] = r.c;
    }

    const bySource: Record<string, number> = {};
    for (const r of db.prepare("SELECT source, COUNT(*) as c FROM triage_results GROUP BY source").all() as any[]) {
      bySource[r.source] = r.c;
    }

    const rulesTotal = (db.prepare("SELECT COUNT(*) as c FROM triage_rules").get() as any)?.c || 0;
    const rulesEnabled = (db.prepare("SELECT COUNT(*) as c FROM triage_rules WHERE enabled = 1").get() as any)?.c || 0;

    db.close();
    return { total, by_layer: byLayer, by_action: byAction, by_source: bySource, rules_total: rulesTotal, rules_enabled: rulesEnabled };
  } catch {
    db.close();
    return { total: 0, by_layer: {}, by_action: {}, by_source: {}, rules_total: 0, rules_enabled: 0 };
  }
}

/** Update task_id for all triage_results rows matching a dedup_hash */
export function updateTaskId(dedup_hash: string, task_id: string): number {
  const db = getDb();
  if (!db) return 0;
  try {
    init();
    const info = db.run(
      "UPDATE triage_results SET task_id = ? WHERE dedup_hash = ? AND task_id IS NULL",
      [task_id, dedup_hash],
    );
    db.close();
    return (info as any).changes ?? 0;
  } catch {
    db.close();
    return 0;
  }
}

export interface ActionableItem {
  id: number;
  source: string;
  message_id: string;
  subject: string;
  sender: string;
  received_at: string;
  action: string;
  urgency: string;
  summary: string;
  reasoning: string;
  domain: string;
  classified_by: string;
  dedup_hash: string;
  metadata: string;
}

/** Get unprocessed actionable items (QUEUE/NOTIFY, no task_id, work domain only) */
export function getUnprocessedActionable(limit: number = 20, priorityFilter?: string): ActionableItem[] {
  const db = getDb();
  if (!db) return [];
  try {
    init();
    const urgencyOrder = "CASE urgency WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END";
    let sql: string;
    let params: any[];

    if (priorityFilter) {
      sql = `SELECT id, source, message_id, subject, sender, received_at, action, urgency, summary, reasoning, domain, classified_by, dedup_hash, metadata
             FROM triage_results
             WHERE action = ? AND task_id IS NULL AND domain = 'work'
             ORDER BY ${urgencyOrder} ASC, classified_at DESC
             LIMIT ?`;
      params = [priorityFilter, limit];
    } else {
      sql = `SELECT id, source, message_id, subject, sender, received_at, action, urgency, summary, reasoning, domain, classified_by, dedup_hash, metadata
             FROM triage_results
             WHERE action IN ('QUEUE', 'NOTIFY') AND task_id IS NULL AND domain = 'work'
             ORDER BY ${urgencyOrder} ASC, classified_at DESC
             LIMIT ?`;
      params = [limit];
    }

    const rows = db.prepare(sql).all(...params) as ActionableItem[];
    db.close();
    return rows;
  } catch {
    db.close();
    return [];
  }
}
