// wip_gate.ts — Work-In-Progress limit enforcement
//
// Seth's workflow rule: max 3 items "in progress" at any time.
// An item is "in progress" once touched (not just created by triage).
// Must close or hold before starting new work.
//
// Called by:
// - Status dashboard (/wip endpoint) to show current WIP count
// - process_actionable.ts before creating tickets (advisory — doesn't block creation)
// - PAI sessions via MCP to check before starting new work

import { Database } from "bun:sqlite";

const SQLITE_PATH = (process.env.CACHE_DIR || "/local/cache/triage") + "/index.db";
const WIP_LIMIT = parseInt(process.env.WIP_LIMIT || "3");

interface WipItem {
  id: number;
  subject: string;
  task_id: string | null;
  urgency: string;
  source: string;
  touched_at: string | null;
  hold_reason: string | null;
  status: "active" | "on_hold" | "untouched";
}

export async function main(
  action: string = "status",
  item_id: number = 0,
  hold_reason: string = "",
) {
  const db = new Database(SQLITE_PATH);

  try {
    // Ensure WIP tracking columns exist
    try { db.exec("ALTER TABLE triage_results ADD COLUMN wip_touched_at INTEGER DEFAULT NULL"); } catch {}
    try { db.exec("ALTER TABLE triage_results ADD COLUMN wip_hold_reason TEXT DEFAULT NULL"); } catch {}
    try { db.exec("ALTER TABLE triage_results ADD COLUMN wip_status TEXT DEFAULT 'untouched'"); } catch {}

    switch (action) {
      case "status":
        return getWipStatus(db);
      case "touch":
        return touchItem(db, item_id);
      case "hold":
        return holdItem(db, item_id, hold_reason);
      case "close":
        return closeItem(db, item_id);
      default:
        return { error: `Unknown action: ${action}. Use status, touch, hold, or close.` };
    }
  } finally {
    db.close();
  }
}

function getWipStatus(db: Database) {
  const active = db.query(`
    SELECT id, subject, task_id, urgency, source, wip_touched_at, wip_hold_reason, wip_status
    FROM triage_results
    WHERE wip_status = 'active'
    ORDER BY wip_touched_at DESC
  `).all() as WipItem[];

  const onHold = db.query(`
    SELECT id, subject, task_id, urgency, source, wip_touched_at, wip_hold_reason, wip_status
    FROM triage_results
    WHERE wip_status = 'on_hold'
    ORDER BY wip_touched_at DESC
  `).all() as WipItem[];

  const untouched = db.query(`
    SELECT count(*) as cnt FROM triage_results
    WHERE task_id IS NOT NULL AND (wip_status = 'untouched' OR wip_status IS NULL) AND marked_read = 0
  `).get() as any;

  const atLimit = active.length >= WIP_LIMIT;

  return {
    wip_limit: WIP_LIMIT,
    active_count: active.length,
    at_limit: atLimit,
    can_start_new: !atLimit,
    active_items: active,
    on_hold_items: onHold,
    untouched_with_tickets: untouched?.cnt || 0,
    message: atLimit
      ? `⛔ WIP limit reached (${active.length}/${WIP_LIMIT}). Close or hold an item before starting new work.`
      : `✅ ${active.length}/${WIP_LIMIT} active items. ${WIP_LIMIT - active.length} slot${WIP_LIMIT - active.length !== 1 ? 's' : ''} available.`,
  };
}

function touchItem(db: Database, itemId: number) {
  // Check WIP limit first
  const status = getWipStatus(db);
  if (status.at_limit) {
    return {
      blocked: true,
      message: `Cannot start new work — WIP limit reached (${status.active_count}/${WIP_LIMIT}). Close or hold one of: ${status.active_items.map(i => i.subject?.slice(0, 40)).join(", ")}`,
    };
  }

  db.prepare(`
    UPDATE triage_results
    SET wip_status = 'active', wip_touched_at = unixepoch()
    WHERE id = ? AND (wip_status = 'untouched' OR wip_status IS NULL)
  `).run(itemId);

  return { touched: true, item_id: itemId, new_status: getWipStatus(db) };
}

function holdItem(db: Database, itemId: number, reason: string) {
  if (!reason || reason.trim().length < 5) {
    return { error: "Hold reason is required (min 5 chars). Why is this on hold?" };
  }

  db.prepare(`
    UPDATE triage_results
    SET wip_status = 'on_hold', wip_hold_reason = ?
    WHERE id = ? AND wip_status = 'active'
  `).run(reason, itemId);

  return { held: true, item_id: itemId, reason, new_status: getWipStatus(db) };
}

function closeItem(db: Database, itemId: number) {
  db.prepare(`
    UPDATE triage_results
    SET wip_status = 'closed', marked_read = 1
    WHERE id = ?
  `).run(itemId);

  return { closed: true, item_id: itemId, new_status: getWipStatus(db) };
}
