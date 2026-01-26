/**
 * Intake Database Operations
 *
 * SQLite database layer for the universal intake system.
 * Uses Bun's built-in SQLite for performance.
 * Vector search via sqlite-vec extension.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { createHash } from "crypto";

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_DB_PATH = "/data/.cache/intake/intake.sqlite";
const SCHEMA_PATH = join(dirname(import.meta.path), "schema.sql");

function getDbPath(): string {
  return process.env.INTAKE_DB || DEFAULT_DB_PATH;
}

// =============================================================================
// Types
// =============================================================================

export type Zone = "work" | "home";

export interface IntakeItem {
  id: string;
  zone: Zone;
  source: string;
  source_id: string;
  type: string;
  subject?: string;
  body?: string;
  context?: string;
  content_hash?: string;
  from_name?: string;
  from_address?: string;
  from_user_id?: string;
  participants?: string;
  created_at?: string;
  updated_at?: string;
  ingested_at?: string;
  status?: string;
  read_status?: string;
  message_count?: number;
  enrichment?: string;
  embedding?: Buffer;
  metadata?: string;
}

export interface Message {
  id: string;
  intake_id: string;
  source_message_id?: string;
  timestamp: string;
  sender_name?: string;
  sender_address?: string;
  content: string;
  metadata?: string;
}

export interface TriageResult {
  intake_id: string;
  category?: string;
  priority?: string;
  confidence?: number;
  quick_win?: boolean;
  quick_win_reason?: string;
  estimated_time?: string;
  reasoning?: string;
  suggested_action?: string;
  triaged_by?: string;
}

export interface Contact {
  id: string;
  name?: string;
  email?: string;
  slack_user_id?: string;
  telegram_chat_id?: string;
  ms365_user_id?: string;
  is_vip?: boolean;
  vip_reason?: string;
  relationship?: string;
  organization?: string;
  typical_urgency?: string;
  notes?: string;
}

export interface SyncState {
  source: string;
  last_sync?: string;
  last_successful_sync?: string;
  cursor?: string;
  status?: string;
  error_message?: string;
  items_synced?: number;
  consecutive_failures?: number;
  backoff_until?: string;
}

export interface QueryOptions {
  zone?: Zone;
  source?: string[];
  status?: string[];
  limit?: number;
  offset?: number;
  since?: Date;
  untriaged?: boolean;
  priority?: string[];
  category?: string[];
  quick_wins?: boolean;
}

// =============================================================================
// Database Connection
// =============================================================================

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;

  const dbPath = getDbPath();
  const dbDir = dirname(dbPath);

  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  _db = new Database(dbPath, { create: true });

  // Enable WAL mode for better concurrency
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA synchronous = NORMAL");
  _db.exec("PRAGMA foreign_keys = ON");

  return _db;
}

export function initializeSchema(): void {
  const db = getDb();
  const schema = readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schema);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

export function generateId(): string {
  return crypto.randomUUID();
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").substring(0, 32);
}

// =============================================================================
// Intake Operations
// =============================================================================

export function upsertIntake(item: Partial<IntakeItem> & { source: string; source_id: string; type: string }): string {
  const db = getDb();
  const id = item.id || generateId();
  const now = new Date().toISOString();
  // Default zone from environment or 'work'
  const zone = item.zone || (process.env.ZONE as Zone) || "work";

  const stmt = db.prepare(`
    INSERT INTO intake (
      id, zone, source, source_id, type, subject, body, context, content_hash,
      from_name, from_address, from_user_id, participants,
      created_at, updated_at, ingested_at, status, read_status,
      message_count, enrichment, embedding, metadata
    ) VALUES (
      $id, $zone, $source, $source_id, $type, $subject, $body, $context, $content_hash,
      $from_name, $from_address, $from_user_id, $participants,
      $created_at, $updated_at, $ingested_at, $status, $read_status,
      $message_count, $enrichment, $embedding, $metadata
    )
    ON CONFLICT(source, source_id) DO UPDATE SET
      subject = excluded.subject,
      body = excluded.body,
      context = excluded.context,
      content_hash = excluded.content_hash,
      updated_at = excluded.updated_at,
      message_count = excluded.message_count,
      enrichment = excluded.enrichment,
      embedding = excluded.embedding,
      metadata = excluded.metadata
  `);

  stmt.run({
    $id: id,
    $zone: zone,
    $source: item.source,
    $source_id: item.source_id,
    $type: item.type,
    $subject: item.subject || null,
    $body: item.body || null,
    $context: item.context || null,
    $content_hash: item.content_hash || (item.body ? hashContent(item.body) : null),
    $from_name: item.from_name || null,
    $from_address: item.from_address || null,
    $from_user_id: item.from_user_id || null,
    $participants: item.participants || null,
    $created_at: item.created_at || now,
    $updated_at: item.updated_at || now,
    $ingested_at: item.ingested_at || now,
    $status: item.status || "new",
    $read_status: item.read_status || "unread",
    $message_count: item.message_count || 1,
    $enrichment: item.enrichment || null,
    $embedding: item.embedding || null,
    $metadata: item.metadata || null,
  });

  return id;
}

export function getIntake(id: string): IntakeItem | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM intake WHERE id = ?").get(id) as IntakeItem | undefined;
}

export function getIntakeBySourceId(source: string, sourceId: string): IntakeItem | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM intake WHERE source = ? AND source_id = ?").get(source, sourceId) as IntakeItem | undefined;
}

export function queryIntake(options: QueryOptions = {}): IntakeItem[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  // Zone filtering - defaults to environment variable if not specified
  if (options.zone) {
    conditions.push("zone = @zone");
    params.zone = options.zone;
  }

  if (options.source?.length) {
    conditions.push(`source IN (${options.source.map((_, i) => `@source${i}`).join(", ")})`);
    options.source.forEach((s, i) => { params[`source${i}`] = s; });
  }

  if (options.status?.length) {
    conditions.push(`status IN (${options.status.map((_, i) => `@status${i}`).join(", ")})`);
    options.status.forEach((s, i) => { params[`status${i}`] = s; });
  }

  if (options.since) {
    conditions.push("updated_at >= @since");
    params.since = options.since.toISOString();
  }

  if (options.untriaged) {
    conditions.push("id NOT IN (SELECT intake_id FROM triage)");
  }

  if (options.priority?.length) {
    conditions.push(`id IN (SELECT intake_id FROM triage WHERE priority IN (${options.priority.map((_, i) => `@priority${i}`).join(", ")}))`);
    options.priority.forEach((p, i) => { params[`priority${i}`] = p; });
  }

  if (options.category?.length) {
    conditions.push(`id IN (SELECT intake_id FROM triage WHERE category IN (${options.category.map((_, i) => `@category${i}`).join(", ")}))`);
    options.category.forEach((c, i) => { params[`category${i}`] = c; });
  }

  if (options.quick_wins) {
    conditions.push("id IN (SELECT intake_id FROM triage WHERE quick_win = 1)");
  }

  let sql = "SELECT * FROM intake";
  if (conditions.length) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY updated_at DESC";
  sql += ` LIMIT ${options.limit || 50}`;
  if (options.offset) {
    sql += ` OFFSET ${options.offset}`;
  }

  return db.prepare(sql).all(params) as IntakeItem[];
}

export function updateIntakeStatus(id: string, status: string): boolean {
  const db = getDb();
  const result = db.prepare("UPDATE intake SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), id);
  return result.changes > 0;
}

export function updateIntakeEmbedding(id: string, embedding: Float32Array): boolean {
  const db = getDb();
  const buffer = Buffer.from(embedding.buffer);
  const result = db.prepare("UPDATE intake SET embedding = ? WHERE id = ?").run(buffer, id);
  return result.changes > 0;
}

// =============================================================================
// Message Operations
// =============================================================================

export function addMessage(message: Message): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO messages (
      id, intake_id, source_message_id, timestamp,
      sender_name, sender_address, content, metadata
    ) VALUES (
      @id, @intake_id, @source_message_id, @timestamp,
      @sender_name, @sender_address, @content, @metadata
    )
  `).run({
    id: message.id,
    intake_id: message.intake_id,
    source_message_id: message.source_message_id || null,
    timestamp: message.timestamp,
    sender_name: message.sender_name || null,
    sender_address: message.sender_address || null,
    content: message.content,
    metadata: message.metadata || null,
  });
}

export function getMessages(intakeId: string, limit = 20): Message[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM messages
    WHERE intake_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(intakeId, limit) as Message[];
}

export function buildThreadContext(intakeId: string, limit = 10): string {
  const messages = getMessages(intakeId, limit);
  return messages
    .reverse()
    .map(m => `[${m.sender_name || "Unknown"}]: ${m.content}`)
    .join("\n");
}

// =============================================================================
// Triage Operations
// =============================================================================

export function upsertTriage(triage: TriageResult): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO triage (
      intake_id, category, priority, confidence, quick_win,
      quick_win_reason, estimated_time, reasoning, suggested_action, triaged_by
    ) VALUES (
      @intake_id, @category, @priority, @confidence, @quick_win,
      @quick_win_reason, @estimated_time, @reasoning, @suggested_action, @triaged_by
    )
    ON CONFLICT(intake_id) DO UPDATE SET
      category = excluded.category,
      priority = excluded.priority,
      confidence = excluded.confidence,
      quick_win = excluded.quick_win,
      quick_win_reason = excluded.quick_win_reason,
      estimated_time = excluded.estimated_time,
      reasoning = excluded.reasoning,
      suggested_action = excluded.suggested_action,
      triaged_by = excluded.triaged_by,
      triaged_at = CURRENT_TIMESTAMP
  `).run({
    intake_id: triage.intake_id,
    category: triage.category || null,
    priority: triage.priority || null,
    confidence: triage.confidence || null,
    quick_win: triage.quick_win ? 1 : 0,
    quick_win_reason: triage.quick_win_reason || null,
    estimated_time: triage.estimated_time || null,
    reasoning: triage.reasoning || null,
    suggested_action: triage.suggested_action || null,
    triaged_by: triage.triaged_by || null,
  });
}

export function getTriage(intakeId: string): TriageResult | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM triage WHERE intake_id = ?").get(intakeId) as TriageResult | undefined;
}

export function recordCorrection(
  intakeId: string,
  originalCategory: string | undefined,
  originalPriority: string | undefined,
  correctedCategory: string,
  correctedPriority: string,
  reason?: string
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO triage_corrections (
      intake_id, original_category, original_priority,
      corrected_category, corrected_priority, correction_reason
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(intakeId, originalCategory, originalPriority, correctedCategory, correctedPriority, reason);
}

// =============================================================================
// Contact Operations
// =============================================================================

export function upsertContact(contact: Contact): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO contacts (
      id, name, email, slack_user_id, telegram_chat_id, ms365_user_id,
      is_vip, vip_reason, relationship, organization, typical_urgency, notes
    ) VALUES (
      @id, @name, @email, @slack_user_id, @telegram_chat_id, @ms365_user_id,
      @is_vip, @vip_reason, @relationship, @organization, @typical_urgency, @notes
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      email = excluded.email,
      slack_user_id = excluded.slack_user_id,
      telegram_chat_id = excluded.telegram_chat_id,
      ms365_user_id = excluded.ms365_user_id,
      is_vip = excluded.is_vip,
      vip_reason = excluded.vip_reason,
      relationship = excluded.relationship,
      organization = excluded.organization,
      typical_urgency = excluded.typical_urgency,
      notes = excluded.notes,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    id: contact.id,
    name: contact.name || null,
    email: contact.email || null,
    slack_user_id: contact.slack_user_id || null,
    telegram_chat_id: contact.telegram_chat_id || null,
    ms365_user_id: contact.ms365_user_id || null,
    is_vip: contact.is_vip ? 1 : 0,
    vip_reason: contact.vip_reason || null,
    relationship: contact.relationship || null,
    organization: contact.organization || null,
    typical_urgency: contact.typical_urgency || null,
    notes: contact.notes || null,
  });
}

export function getContactByEmail(email: string): Contact | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM contacts WHERE email = ?").get(email) as Contact | undefined;
}

export function isVip(email?: string, slackUserId?: string): boolean {
  const db = getDb();
  if (email) {
    const contact = db.prepare("SELECT is_vip FROM contacts WHERE email = ?").get(email) as { is_vip: number } | undefined;
    if (contact?.is_vip) return true;
  }
  if (slackUserId) {
    const contact = db.prepare("SELECT is_vip FROM contacts WHERE slack_user_id = ?").get(slackUserId) as { is_vip: number } | undefined;
    if (contact?.is_vip) return true;
  }
  return false;
}

// =============================================================================
// Sync State Operations
// =============================================================================

export function getSyncState(source: string): SyncState | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM sync_state WHERE source = ?").get(source) as SyncState | undefined;
}

export function updateSyncState(state: Partial<SyncState> & { source: string }): void {
  const db = getDb();
  const existing = getSyncState(state.source);

  if (existing) {
    const updates: string[] = [];
    const params: Record<string, unknown> = { source: state.source };

    for (const [key, value] of Object.entries(state)) {
      if (key !== "source" && value !== undefined) {
        updates.push(`${key} = @${key}`);
        params[key] = value;
      }
    }

    if (updates.length) {
      db.prepare(`UPDATE sync_state SET ${updates.join(", ")} WHERE source = @source`).run(params);
    }
  } else {
    db.prepare(`
      INSERT INTO sync_state (source, last_sync, status)
      VALUES (@source, @last_sync, @status)
    `).run({
      source: state.source,
      last_sync: state.last_sync || new Date().toISOString(),
      status: state.status || "pending",
    });
  }
}

// =============================================================================
// Statistics
// =============================================================================

export interface IntakeStats {
  zone?: Zone;
  total: number;
  by_zone: Record<string, number>;
  by_source: Record<string, number>;
  by_status: Record<string, number>;
  by_priority: Record<string, number>;
  untriaged: number;
  quick_wins: number;
}

export function getStats(zone?: Zone): IntakeStats {
  const db = getDb();
  const zoneFilter = zone ? " WHERE zone = ?" : "";
  const zoneParam = zone ? [zone] : [];

  const total = (db.prepare(`SELECT COUNT(*) as count FROM intake${zoneFilter}`).get(...zoneParam) as { count: number }).count;

  const byZone: Record<string, number> = {};
  for (const row of db.prepare("SELECT zone, COUNT(*) as count FROM intake GROUP BY zone").all() as { zone: string; count: number }[]) {
    byZone[row.zone] = row.count;
  }

  const bySource: Record<string, number> = {};
  for (const row of db.prepare(`SELECT source, COUNT(*) as count FROM intake${zoneFilter} GROUP BY source`).all(...zoneParam) as { source: string; count: number }[]) {
    bySource[row.source] = row.count;
  }

  const byStatus: Record<string, number> = {};
  for (const row of db.prepare(`SELECT status, COUNT(*) as count FROM intake${zoneFilter} GROUP BY status`).all(...zoneParam) as { status: string; count: number }[]) {
    byStatus[row.status] = row.count;
  }

  const byPriority: Record<string, number> = {};
  const priorityQuery = zone
    ? "SELECT priority, COUNT(*) as count FROM triage t JOIN intake i ON t.intake_id = i.id WHERE priority IS NOT NULL AND i.zone = ? GROUP BY priority"
    : "SELECT priority, COUNT(*) as count FROM triage WHERE priority IS NOT NULL GROUP BY priority";
  for (const row of db.prepare(priorityQuery).all(...zoneParam) as { priority: string; count: number }[]) {
    byPriority[row.priority] = row.count;
  }

  const untriagedQuery = zone
    ? "SELECT COUNT(*) as count FROM intake WHERE zone = ? AND id NOT IN (SELECT intake_id FROM triage)"
    : "SELECT COUNT(*) as count FROM intake WHERE id NOT IN (SELECT intake_id FROM triage)";
  const untriaged = (db.prepare(untriagedQuery).get(...zoneParam) as { count: number }).count;

  const quickWinsQuery = zone
    ? "SELECT COUNT(*) as count FROM triage t JOIN intake i ON t.intake_id = i.id WHERE t.quick_win = 1 AND i.zone = ?"
    : "SELECT COUNT(*) as count FROM triage WHERE quick_win = 1";
  const quickWins = (db.prepare(quickWinsQuery).get(...zoneParam) as { count: number }).count;

  return { zone, total, by_zone: byZone, by_source: bySource, by_status: byStatus, by_priority: byPriority, untriaged, quick_wins: quickWins };
}
