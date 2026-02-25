// Windmill Script: Knowledge Store
// Phase 6: Persistent entity-relationship storage
// Stores entity->entity relationships with timestamps, source, confidence
// Backed by JSONL for append-friendly, line-oriented storage

import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();
const KB_PATH = join(HOME, ".claude", "state", "knowledge.jsonl");

interface KBEntry {
  timestamp: string;
  entity_a: { type: string; value: string };
  entity_b: { type: string; value: string };
  relationship: string; // "co-occurrence", "contains", "triggers", "resolves"
  source: string;       // which script/event discovered this
  confidence: number;   // 0-1
  context?: string;
}

function ensureDirs(): void {
  const stateDir = join(HOME, ".claude", "state");
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
}

function readAllEntries(): KBEntry[] {
  if (!existsSync(KB_PATH)) return [];

  const lines = readFileSync(KB_PATH, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  const entries: KBEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as KBEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

function storeEntry(
  entity_a_type: string,
  entity_a_value: string,
  entity_b_type: string,
  entity_b_value: string,
  relationship: string,
  source: string,
  confidence: number,
  context: string,
): { stored: boolean; entry: KBEntry } {
  if (!entity_a_type || !entity_a_value || !entity_b_type || !entity_b_value) {
    throw new Error("store requires entity_a_type, entity_a_value, entity_b_type, entity_b_value");
  }

  const entry: KBEntry = {
    timestamp: new Date().toISOString(),
    entity_a: { type: entity_a_type, value: entity_a_value },
    entity_b: { type: entity_b_type, value: entity_b_value },
    relationship,
    source,
    confidence: Math.max(0, Math.min(1, confidence)),
    ...(context ? { context } : {}),
  };

  appendFileSync(KB_PATH, JSON.stringify(entry) + "\n");

  return { stored: true, entry };
}

function queryEntity(
  entity_type: string,
  entity_value: string,
  lookback_days: number,
): { matches: number; relationships: KBEntry[] } {
  if (!entity_type || !entity_value) {
    throw new Error("query requires entity_type and entity_value");
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookback_days);
  const cutoffISO = cutoff.toISOString();

  const all = readAllEntries();
  const matches = all.filter((entry) => {
    if (entry.timestamp < cutoffISO) return false;

    const matchA = entry.entity_a.type === entity_type && entry.entity_a.value === entity_value;
    const matchB = entry.entity_b.type === entity_type && entry.entity_b.value === entity_value;
    return matchA || matchB;
  });

  return { matches: matches.length, relationships: matches };
}

function pruneEntries(max_age_days: number): { before: number; after: number; pruned: number } {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - max_age_days);
  const cutoffISO = cutoff.toISOString();

  const all = readAllEntries();
  const kept = all.filter((entry) => entry.timestamp >= cutoffISO);

  const before = all.length;
  const after = kept.length;

  // Rewrite the file with only kept entries
  const content = kept.map((entry) => JSON.stringify(entry)).join("\n") + (kept.length > 0 ? "\n" : "");
  writeFileSync(KB_PATH, content);

  return { before, after, pruned: before - after };
}

function getStats(): {
  total_entries: number;
  unique_entities: number;
  relationship_types: string[];
  oldest_entry: string | null;
  newest_entry: string | null;
  entities_by_type: Record<string, number>;
} {
  const all = readAllEntries();

  if (all.length === 0) {
    return {
      total_entries: 0,
      unique_entities: 0,
      relationship_types: [],
      oldest_entry: null,
      newest_entry: null,
      entities_by_type: {},
    };
  }

  const entitySet = new Set<string>();
  const relTypes = new Set<string>();
  const entityTypeCounts: Record<string, number> = {};
  let oldest = all[0].timestamp;
  let newest = all[0].timestamp;

  for (const entry of all) {
    const keyA = `${entry.entity_a.type}:${entry.entity_a.value}`;
    const keyB = `${entry.entity_b.type}:${entry.entity_b.value}`;
    entitySet.add(keyA);
    entitySet.add(keyB);

    relTypes.add(entry.relationship);

    entityTypeCounts[entry.entity_a.type] = (entityTypeCounts[entry.entity_a.type] || 0) + 1;
    entityTypeCounts[entry.entity_b.type] = (entityTypeCounts[entry.entity_b.type] || 0) + 1;

    if (entry.timestamp < oldest) oldest = entry.timestamp;
    if (entry.timestamp > newest) newest = entry.timestamp;
  }

  return {
    total_entries: all.length,
    unique_entities: entitySet.size,
    relationship_types: [...relTypes],
    oldest_entry: oldest,
    newest_entry: newest,
    entities_by_type: entityTypeCounts,
  };
}

export async function main(
  action: string = "stats",
  entity_a_type: string = "",
  entity_a_value: string = "",
  entity_b_type: string = "",
  entity_b_value: string = "",
  relationship: string = "co-occurrence",
  source: string = "manual",
  confidence: number = 0.5,
  context: string = "",
  entity_type: string = "",
  entity_value: string = "",
  lookback_days: number = 90,
  max_age_days: number = 180,
) {
  ensureDirs();

  switch (action) {
    case "store":
      return storeEntry(
        entity_a_type,
        entity_a_value,
        entity_b_type,
        entity_b_value,
        relationship,
        source,
        confidence,
        context,
      );

    case "query":
      return queryEntity(entity_type, entity_value, lookback_days);

    case "prune":
      return pruneEntries(max_age_days);

    case "stats":
      return getStats();

    default:
      return { error: `Unknown action: ${action}. Valid actions: store, query, prune, stats` };
  }
}
