// Windmill Script: Cross-Source Correlation Engine
// Phase 6: Find relationships across feeds, SDP, AWS, triage events
// Reads all event log sources, extracts entity co-occurrences,
// writes correlations to knowledge store (knowledge.jsonl)

import { readFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();
const KB_PATH = join(HOME, ".claude", "state", "knowledge.jsonl");

// All event log sources to scan
const LOG_SOURCES: { name: string; path: string }[] = [
  { name: "feed-events", path: join(HOME, ".claude", "logs", "feed-events.jsonl") },
  { name: "entity-extractions", path: join(HOME, ".claude", "logs", "entity-extractions.jsonl") },
  { name: "triage-feedback", path: join(HOME, ".claude", "logs", "triage-feedback.jsonl") },
  { name: "compliance-scans", path: join(HOME, ".claude", "logs", "compliance-scans.jsonl") },
  { name: "sdp-aws-correlations", path: join(HOME, ".claude", "logs", "sdp-aws-correlations.jsonl") },
  { name: "cost-reports", path: join(HOME, ".claude", "logs", "cost-reports.jsonl") },
];

// Entity patterns — exact copy from entity_extract.ts
const PATTERNS: [string, RegExp][] = [
  ["aws_instance", /\bi-[0-9a-f]{8,17}\b/gi],
  ["aws_account", /\b\d{12}\b/g],
  ["aws_arn", /arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[a-zA-Z0-9/._-]+/g],
  ["aws_sg", /\bsg-[0-9a-f]{8,17}\b/gi],
  ["aws_vpc", /\bvpc-[0-9a-f]{8,17}\b/gi],
  ["aws_subnet", /\bsubnet-[0-9a-f]{8,17}\b/gi],
  ["aws_eni", /\beni-[0-9a-f]{8,17}\b/gi],
  ["aws_volume", /\bvol-[0-9a-f]{8,17}\b/gi],
  ["ipv4", /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g],
  ["hostname", /\b[a-z][a-z0-9-]+\.(?:ec2\.internal|amazonaws\.com|compute\.internal)\b/gi],
  ["cve", /CVE-\d{4}-\d{4,}/gi],
];

interface Entity {
  type: string;
  value: string;
}

interface GraphNode {
  type: string;
  value: string;
  occurrence_count: number;
}

interface GraphEdge {
  entity_a: string;
  entity_b: string;
  weight: number;
  sources: string[];
}

function ensureDirs(): void {
  const stateDir = join(HOME, ".claude", "state");
  const logDir = join(HOME, ".claude", "logs");
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
}

function extractEntitiesFromText(text: string): Entity[] {
  const entities: Entity[] = [];
  const seen = new Set<string>();

  for (const [type, pattern] of PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0;
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const value = match[0];
      const key = `${type}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entities.push({ type, value });
    }
  }

  return entities;
}

function readLogEntries(path: string, cutoffISO: string): { text: string; timestamp?: string }[] {
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  const entries: { text: string; timestamp?: string }[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      // Filter by timestamp if the entry has one
      if (parsed.timestamp && parsed.timestamp < cutoffISO) continue;
      // Stringify the entire entry so entity patterns can match any field
      entries.push({ text: line, timestamp: parsed.timestamp });
    } catch {
      // Non-JSON lines: include as raw text (no timestamp filter possible)
      entries.push({ text: line });
    }
  }

  return entries;
}

function readExistingCorrelations(): Set<string> {
  const existing = new Set<string>();
  if (!existsSync(KB_PATH)) return existing;

  const lines = readFileSync(KB_PATH, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.relationship === "co-occurrence" && entry.source === "cross_correlate") {
        // Canonical key: sorted entity pair
        const keyA = `${entry.entity_a.type}:${entry.entity_a.value}`;
        const keyB = `${entry.entity_b.type}:${entry.entity_b.value}`;
        const sorted = [keyA, keyB].sort();
        existing.add(`${sorted[0]}||${sorted[1]}`);
      }
    } catch {
      // Skip malformed
    }
  }

  return existing;
}

export async function main(
  lookback_days: number = 7,
  min_co_occurrences: number = 2,
  dry_run: boolean = false,
) {
  ensureDirs();

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookback_days);
  const cutoffISO = cutoff.toISOString();

  // Track entity occurrences across all sources
  // nodeKey -> { type, value, count }
  const nodeCounts = new Map<string, { type: string; value: string; count: number }>();

  // Track co-occurrence edges
  // edgeKey -> { entity_a, entity_b, weight, sources }
  const edgeMap = new Map<string, { entity_a: string; entity_b: string; weight: number; sources: Set<string> }>();

  let sourcesScanned = 0;
  let entriesProcessed = 0;

  for (const source of LOG_SOURCES) {
    const entries = readLogEntries(source.path, cutoffISO);
    if (entries.length === 0) continue;

    sourcesScanned++;

    for (const entry of entries) {
      entriesProcessed++;
      const entities = extractEntitiesFromText(entry.text);

      // Count each entity occurrence
      for (const entity of entities) {
        const key = `${entity.type}:${entity.value}`;
        const existing = nodeCounts.get(key);
        if (existing) {
          existing.count++;
        } else {
          nodeCounts.set(key, { type: entity.type, value: entity.value, count: 1 });
        }
      }

      // Build co-occurrence edges: every pair of entities in the same entry
      for (let i = 0; i < entities.length; i++) {
        for (let j = i + 1; j < entities.length; j++) {
          const keyA = `${entities[i].type}:${entities[i].value}`;
          const keyB = `${entities[j].type}:${entities[j].value}`;

          // Skip self-correlations (same entity type and value)
          if (keyA === keyB) continue;

          // Canonical edge key: sorted pair
          const sorted = [keyA, keyB].sort();
          const edgeKey = `${sorted[0]}||${sorted[1]}`;

          const existing = edgeMap.get(edgeKey);
          if (existing) {
            existing.weight++;
            existing.sources.add(source.name);
          } else {
            edgeMap.set(edgeKey, {
              entity_a: sorted[0],
              entity_b: sorted[1],
              weight: 1,
              sources: new Set([source.name]),
            });
          }
        }
      }
    }
  }

  // Filter edges by minimum co-occurrences
  const significantEdges = [...edgeMap.values()].filter((edge) => edge.weight >= min_co_occurrences);

  // Determine which correlations are new (not already in knowledge.jsonl)
  const existingCorrelations = readExistingCorrelations();
  const newEdges = significantEdges.filter((edge) => {
    const edgeKey = `${edge.entity_a}||${edge.entity_b}`;
    return !existingCorrelations.has(edgeKey);
  });

  // Write new correlations to knowledge.jsonl
  let newCorrelationsStored = 0;
  if (!dry_run) {
    for (const edge of newEdges) {
      const [aType, aValue] = edge.entity_a.split(":");
      const [bType, bValue] = edge.entity_b.split(":");

      // Confidence scales with weight and number of sources
      const sourceCount = edge.sources.size;
      const confidence = Math.min(1.0, 0.3 + (edge.weight * 0.05) + (sourceCount * 0.1));

      const kbEntry = {
        timestamp: new Date().toISOString(),
        entity_a: { type: aType, value: aValue },
        entity_b: { type: bType, value: bValue },
        relationship: "co-occurrence",
        source: "cross_correlate",
        confidence: Math.round(confidence * 100) / 100,
        context: `${edge.weight} co-occurrences across ${sourceCount} source(s): ${[...edge.sources].join(", ")}`,
      };

      appendFileSync(KB_PATH, JSON.stringify(kbEntry) + "\n");
      newCorrelationsStored++;
    }
  }

  // Build output graph
  const nodes: GraphNode[] = [...nodeCounts.values()]
    .sort((a, b) => b.count - a.count)
    .map((n) => ({ type: n.type, value: n.value, occurrence_count: n.count }));

  const edges: GraphEdge[] = significantEdges
    .sort((a, b) => b.weight - a.weight)
    .map((e) => ({
      entity_a: e.entity_a,
      entity_b: e.entity_b,
      weight: e.weight,
      sources: [...e.sources],
    }));

  return {
    sources_scanned: sourcesScanned,
    entries_processed: entriesProcessed,
    entities_found: nodeCounts.size,
    correlations_found: significantEdges.length,
    new_correlations_stored: newCorrelationsStored,
    dry_run,
    lookback_days,
    min_co_occurrences,
    graph: {
      nodes,
      edges,
    },
  };
}
