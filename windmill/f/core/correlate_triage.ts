// Windmill Script: Correlate Triage Results
// Queries recent triage_results, groups by sender+alert_type and shared entities,
// detects incidents (repeated alerts), resolutions, and escalations.
// Updates incident_id on correlated items.

import { Database } from "bun:sqlite";

const DB_PATH = "/local/cache/triage/index.db";

interface TriageRow {
  id: number;
  source: string;
  sender: string;
  subject: string;
  action: string;
  urgency: string;
  summary: string;
  alert_type: string;
  source_system: string;
  entities: string;
  incident_id: string | null;
  classified_at: number;
  metadata: string;
}

interface IncidentGroup {
  incident_id: string;
  pattern: "repeated" | "flood" | "escalation" | "resolved";
  entity: string;
  sender: string;
  alert_type: string;
  item_count: number;
  highest_urgency: string;
  item_ids: number[];
}

const URGENCY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function urgencyRank(u: string): number {
  return URGENCY_RANK[u] || 0;
}

function highestUrgency(urgencies: string[]): string {
  let best = "low";
  for (const u of urgencies) {
    if (urgencyRank(u) > urgencyRank(best)) best = u;
  }
  return best;
}

export async function main(
  window_hours: number = 48,
  incident_threshold: number = 3,
  incident_window_hours: number = 2,
  flood_threshold: number = 20,
  flood_window_hours: number = 1,
  dry_run: boolean = false,
): Promise<{
  total_scanned: number;
  incidents_detected: number;
  items_correlated: number;
  incidents: IncidentGroup[];
}> {
  console.log(`[correlate] Starting: window=${window_hours}h, threshold=${incident_threshold}, dry_run=${dry_run}`);

  let db: Database;
  try {
    db = new Database(DB_PATH);
  } catch (err: any) {
    console.error(`[correlate] Cannot open DB: ${err.message}`);
    return { total_scanned: 0, incidents_detected: 0, items_correlated: 0, incidents: [] };
  }

  // Ensure columns exist (idempotent)
  try { db.exec("ALTER TABLE triage_results ADD COLUMN incident_id TEXT DEFAULT NULL"); } catch { /* exists */ }
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_triage_results_incident ON triage_results(incident_id)"); } catch { /* exists */ }

  const windowCutoff = Math.floor(Date.now() / 1000) - (window_hours * 3600);

  // Fetch all items in window that don't already have an incident_id
  const rows = db.prepare(
    `SELECT id, source, sender, subject, action, urgency, summary, alert_type, source_system, entities, incident_id, classified_at, metadata
     FROM triage_results
     WHERE classified_at >= ? AND action IN ('NOTIFY', 'QUEUE')
     ORDER BY classified_at ASC`
  ).all(windowCutoff) as TriageRow[];

  console.log(`[correlate] Scanned ${rows.length} NOTIFY/QUEUE items in ${window_hours}h window`);

  const incidents: IncidentGroup[] = [];
  const assignedIds = new Set<number>();

  // ── Pattern 1: Repeated alerts — same sender + alert_type within incident_window ──
  const senderAlertGroups = new Map<string, TriageRow[]>();
  for (const row of rows) {
    if (row.alert_type === "info") continue;
    const key = `${row.sender.toLowerCase()}|${row.alert_type}`;
    if (!senderAlertGroups.has(key)) senderAlertGroups.set(key, []);
    senderAlertGroups.get(key)!.push(row);
  }

  const incidentWindowSecs = incident_window_hours * 3600;
  for (const [key, items] of senderAlertGroups) {
    if (items.length < incident_threshold) continue;

    // Sliding window: find clusters of N+ items within incident_window
    for (let start = 0; start < items.length; start++) {
      const windowEnd = items[start].classified_at + incidentWindowSecs;
      const cluster = items.filter(
        (it) => it.classified_at >= items[start].classified_at && it.classified_at <= windowEnd && !assignedIds.has(it.id),
      );

      if (cluster.length >= incident_threshold) {
        const [sender, alertType] = key.split("|");
        const incidentId = `INC-${items[start].classified_at}`;

        // Find shared entities across cluster
        const entityCounts = new Map<string, number>();
        for (const item of cluster) {
          try {
            const entities = JSON.parse(item.entities || "[]") as string[];
            for (const e of entities) {
              entityCounts.set(e, (entityCounts.get(e) || 0) + 1);
            }
          } catch { /* malformed entities */ }
        }
        const topEntity = [...entityCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .find(([_, count]) => count >= 2)?.[0] || sender;

        const ids = cluster.map((it) => it.id);
        ids.forEach((id) => assignedIds.add(id));

        incidents.push({
          incident_id: incidentId,
          pattern: "repeated",
          entity: topEntity,
          sender,
          alert_type: alertType,
          item_count: cluster.length,
          highest_urgency: highestUrgency(cluster.map((it) => it.urgency)),
          item_ids: ids,
        });
      }
    }
  }

  // ── Pattern 2: Flood — 20+ from same sender in 1h regardless of alert_type ──
  const floodWindowSecs = flood_window_hours * 3600;
  const senderGroups = new Map<string, TriageRow[]>();
  for (const row of rows) {
    const key = row.sender.toLowerCase();
    if (!senderGroups.has(key)) senderGroups.set(key, []);
    senderGroups.get(key)!.push(row);
  }

  for (const [sender, items] of senderGroups) {
    for (let start = 0; start < items.length; start++) {
      const windowEnd = items[start].classified_at + floodWindowSecs;
      const cluster = items.filter(
        (it) => it.classified_at >= items[start].classified_at && it.classified_at <= windowEnd && !assignedIds.has(it.id),
      );

      if (cluster.length >= flood_threshold) {
        const incidentId = `FLOOD-${items[start].classified_at}`;
        const ids = cluster.map((it) => it.id);
        ids.forEach((id) => assignedIds.add(id));

        incidents.push({
          incident_id: incidentId,
          pattern: "flood",
          entity: sender,
          sender,
          alert_type: "mixed",
          item_count: cluster.length,
          highest_urgency: highestUrgency(cluster.map((it) => it.urgency)),
          item_ids: ids,
        });
      }
    }
  }

  // ── Pattern 3: Resolution detection — is_resolution=true within window of non-resolution ──
  for (const row of rows) {
    if (assignedIds.has(row.id)) continue;
    try {
      const meta = JSON.parse(row.metadata || "{}");
      if (meta.is_resolution !== true) continue;

      // Find matching non-resolution items from same sender+alert_type
      const key = `${row.sender.toLowerCase()}|${row.alert_type}`;
      const group = senderAlertGroups.get(key) || [];
      const related = group.filter(
        (it) =>
          it.id !== row.id &&
          !assignedIds.has(it.id) &&
          Math.abs(it.classified_at - row.classified_at) <= incidentWindowSecs,
      );

      if (related.length > 0) {
        const incidentId = `RES-${row.classified_at}`;
        const ids = [row.id, ...related.map((it) => it.id)];
        ids.forEach((id) => assignedIds.add(id));

        incidents.push({
          incident_id: incidentId,
          pattern: "resolved",
          entity: row.sender.toLowerCase(),
          sender: row.sender.toLowerCase(),
          alert_type: row.alert_type,
          item_count: ids.length,
          highest_urgency: "low",
          item_ids: ids,
        });
      }
    } catch { /* malformed metadata */ }
  }

  // ── Apply incident_ids to DB ──
  let itemsCorrelated = 0;
  if (!dry_run) {
    const updateStmt = db.prepare("UPDATE triage_results SET incident_id = ? WHERE id = ?");
    for (const incident of incidents) {
      for (const id of incident.item_ids) {
        try {
          updateStmt.run(incident.incident_id, id);
          itemsCorrelated++;
        } catch { /* best-effort */ }
      }
    }
  } else {
    itemsCorrelated = incidents.reduce((sum, inc) => sum + inc.item_ids.length, 0);
  }

  db.close();

  console.log(`[correlate] Detected ${incidents.length} incidents, ${itemsCorrelated} items correlated`);
  for (const inc of incidents) {
    console.log(`[correlate] ${inc.incident_id} [${inc.pattern}] ${inc.entity} — ${inc.item_count} items (${inc.highest_urgency})`);
  }

  return {
    total_scanned: rows.length,
    incidents_detected: incidents.length,
    items_correlated: itemsCorrelated,
    incidents,
  };
}
