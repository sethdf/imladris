// Windmill Script: Contextual Surfacing
// Phase 6 Gap #3: Proactively pull related info into active workstreams
//
// Reads active workstreams, searches feed-events.jsonl and
// entity-extractions.jsonl for related content, writes summaries
// to workstream PRD context sections.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const HOME = homedir();
const STATE_PATH = join(HOME, ".claude", "state", "current-work.json");
const FEED_LOG = join(HOME, ".claude", "logs", "feed-events.jsonl");
const ENTITY_LOG = join(HOME, ".claude", "logs", "entity-extractions.jsonl");

interface Workstream {
  name: string;
  prd: string;
  domain: string;
  status: string;
  archived: boolean;
}

interface FeedItem {
  id: string;
  title: string;
  source: string;
  severity?: string;
  collected_at: string;
}

function readJsonl<T>(path: string, since: Date): T[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((item): item is T => {
        if (!item) return false;
        const ts = (item as any).collected_at || (item as any).timestamp;
        return ts ? new Date(ts) >= since : false;
      });
  } catch {
    return [];
  }
}

function extractKeywords(prdContent: string): string[] {
  // Extract meaningful words from PRD for matching
  const stopWords = new Set([
    "the", "is", "at", "in", "of", "and", "or", "to", "a", "an",
    "for", "on", "with", "this", "that", "from", "by", "are", "was",
    "be", "has", "had", "not", "but", "what", "all", "can", "will",
  ]);

  const words = prdContent
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopWords.has(w));

  // Return unique keywords, weighted by frequency
  const freq: Record<string, number> = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([w]) => w);
}

function scoreRelevance(item: FeedItem, keywords: string[]): number {
  const title = item.title.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (title.includes(kw)) score += 1;
  }
  // Boost critical/high severity
  if (item.severity === "CRITICAL") score += 3;
  if (item.severity === "HIGH") score += 2;
  return score;
}

export async function main(
  lookback_hours: number = 24,
  min_relevance: number = 2,
  dry_run: boolean = false,
) {
  // Read active workstreams
  if (!existsSync(STATE_PATH)) {
    return { message: "No active workstreams" };
  }

  const state = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  const workstreams: Workstream[] = (state.active_workstreams || []).filter(
    (w: Workstream) => !w.archived && w.status !== "SHELVED",
  );

  if (workstreams.length === 0) {
    return { message: "No active (non-shelved) workstreams" };
  }

  const since = new Date(Date.now() - lookback_hours * 3600000);
  const feedItems = readJsonl<FeedItem>(FEED_LOG, since);

  const results = [];

  for (const ws of workstreams) {
    // Read PRD to extract keywords
    let keywords: string[] = [ws.name.toLowerCase()];
    if (existsSync(ws.prd)) {
      try {
        const prdContent = readFileSync(ws.prd, "utf-8");
        keywords = [...keywords, ...extractKeywords(prdContent)];
      } catch {
        // PRD unreadable
      }
    }

    // Score feed items against workstream keywords
    const relevant = feedItems
      .map((item) => ({ item, score: scoreRelevance(item, keywords) }))
      .filter((r) => r.score >= min_relevance)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    if (relevant.length > 0 && !dry_run && existsSync(ws.prd)) {
      // Append relevant items to PRD CONTEXT section
      try {
        let prd = readFileSync(ws.prd, "utf-8");
        const contextHeader = "### Auto-Surfaced Context";
        const timestamp = new Date().toISOString().slice(0, 10);
        const surfacedBlock = `\n${contextHeader} (${timestamp})\n${relevant.map((r) => `- [${r.item.severity || "INFO"}] ${r.item.title.slice(0, 120)} (score: ${r.score})`).join("\n")}\n`;

        // Replace existing auto-surfaced section or append
        if (prd.includes(contextHeader)) {
          prd = prd.replace(
            new RegExp(`${contextHeader}[\\s\\S]*?(?=\\n##|$)`),
            surfacedBlock.trim(),
          );
        } else if (prd.includes("## CONTEXT")) {
          prd = prd.replace("## CONTEXT", `## CONTEXT\n${surfacedBlock}`);
        } else {
          prd += surfacedBlock;
        }

        const dir = dirname(ws.prd);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(ws.prd, prd);
      } catch {
        // Write failed
      }
    }

    results.push({
      workstream: ws.name,
      keywords_used: keywords.slice(0, 5),
      relevant_items: relevant.length,
      items: relevant.map((r) => ({
        title: r.item.title.slice(0, 100),
        severity: r.item.severity,
        score: r.score,
      })),
    });
  }

  return {
    workstreams_checked: workstreams.length,
    feed_items_scanned: feedItems.length,
    lookback_hours,
    results,
    dry_run,
  };
}
