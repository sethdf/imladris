// Windmill Script: Security Feed Collector
// Phase 6 Gap #1: Feed collection infrastructure
//
// Polls RSS/CVE/NVD feeds, deduplicates, sends new items to auto_triage.
// Designed to run as Windmill cron (e.g., every 6 hours).
//
// Requires Windmill variable:
//   f/devops/feed_urls  — JSON array of RSS feed URLs (optional, has defaults)

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();
const FEED_LOG = join(HOME, ".claude", "logs", "feed-events.jsonl");
const SEEN_FILE = join(HOME, ".claude", "state", "feed-seen.json");

// Default security feeds
const DEFAULT_FEEDS = [
  "https://nvd.nist.gov/feeds/json/cve/1.1/nvdcve-1.1-recent.json.gz",
  "https://tldrsec.com/feed.xml",
  "https://aws.amazon.com/security/security-bulletins/feed/",
];

interface FeedItem {
  id: string;
  title: string;
  source: string;
  url: string;
  published: string;
  severity?: string;
}

function ensureDirs(): void {
  const logDir = join(HOME, ".claude", "logs");
  const stateDir = join(HOME, ".claude", "state");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
}

function loadSeen(): Set<string> {
  if (!existsSync(SEEN_FILE)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(SEEN_FILE, "utf-8")));
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>): void {
  // Keep last 10000 entries to prevent unbounded growth
  const entries = Array.from(seen).slice(-10000);
  writeFileSync(SEEN_FILE, JSON.stringify(entries));
}

async function fetchRssFeed(url: string): Promise<FeedItem[]> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Imladris-FeedCollector/1.0" },
    });

    if (!response.ok) return [];

    const text = await response.text();
    const items: FeedItem[] = [];

    // Simple XML parsing for RSS/Atom items
    const itemMatches = text.matchAll(/<item>([\s\S]*?)<\/item>|<entry>([\s\S]*?)<\/entry>/gi);
    for (const match of itemMatches) {
      const content = match[1] || match[2] || "";
      const title = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() || "";
      const link = content.match(/<link[^>]*href="([^"]*)"/)?.[ 1] ||
        content.match(/<link>([\s\S]*?)<\/link>/i)?.[1]?.trim() || "";
      const pubDate = content.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() ||
        content.match(/<published>([\s\S]*?)<\/published>/i)?.[1]?.trim() || "";
      const guid = content.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1]?.trim() || link || title;

      if (title) {
        items.push({
          id: guid,
          title,
          source: new URL(url).hostname,
          url: link,
          published: pubDate || new Date().toISOString(),
        });
      }
    }

    return items;
  } catch {
    return [];
  }
}

async function fetchNvdRecent(): Promise<FeedItem[]> {
  try {
    // NVD API 2.0 — last 24 hours
    const since = new Date(Date.now() - 86400000).toISOString();
    const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?pubStartDate=${since}&resultsPerPage=50`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(30000),
      headers: { "User-Agent": "Imladris-FeedCollector/1.0" },
    });

    if (!response.ok) return [];

    const data = await response.json() as any;
    return (data.vulnerabilities || []).map((v: any) => {
      const cve = v.cve || {};
      const severity = cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseSeverity || "UNKNOWN";
      return {
        id: cve.id || "",
        title: `${cve.id}: ${(cve.descriptions || []).find((d: any) => d.lang === "en")?.value?.slice(0, 120) || "No description"}`,
        source: "nvd.nist.gov",
        url: `https://nvd.nist.gov/vuln/detail/${cve.id}`,
        published: cve.published || new Date().toISOString(),
        severity,
      };
    });
  } catch {
    return [];
  }
}

export async function main(
  custom_feeds: string = "",
  include_nvd: boolean = true,
  dry_run: boolean = false,
) {
  ensureDirs();

  // Parse feed URLs
  let feedUrls = DEFAULT_FEEDS;
  const envFeeds = Bun.env.WM_VAR_F_DEVOPS_FEED_URLS;
  if (envFeeds) {
    try {
      feedUrls = JSON.parse(envFeeds);
    } catch {
      // Keep defaults
    }
  }
  if (custom_feeds) {
    try {
      feedUrls = [...feedUrls, ...JSON.parse(custom_feeds)];
    } catch {
      feedUrls.push(custom_feeds); // Single URL
    }
  }

  const seen = loadSeen();
  const newItems: FeedItem[] = [];

  // Fetch RSS feeds in parallel
  const rssResults = await Promise.allSettled(feedUrls.map(fetchRssFeed));
  for (const result of rssResults) {
    if (result.status === "fulfilled") {
      for (const item of result.value) {
        if (!seen.has(item.id)) {
          newItems.push(item);
          seen.add(item.id);
        }
      }
    }
  }

  // Fetch NVD
  if (include_nvd) {
    const nvdItems = await fetchNvdRecent();
    for (const item of nvdItems) {
      if (!seen.has(item.id)) {
        newItems.push(item);
        seen.add(item.id);
      }
    }
  }

  if (!dry_run) {
    // Log new items
    for (const item of newItems) {
      appendFileSync(
        FEED_LOG,
        JSON.stringify({ ...item, collected_at: new Date().toISOString() }) + "\n",
      );
    }
    saveSeen(seen);
  }

  // Categorize by severity for summary
  const critical = newItems.filter((i) => i.severity === "CRITICAL");
  const high = newItems.filter((i) => i.severity === "HIGH");

  return {
    new_items: newItems.length,
    total_seen: seen.size,
    feeds_checked: feedUrls.length + (include_nvd ? 1 : 0),
    critical_count: critical.length,
    high_count: high.length,
    critical_items: critical.map((i) => ({ id: i.id, title: i.title })),
    sample: newItems.slice(0, 10).map((i) => ({
      id: i.id,
      title: i.title.slice(0, 100),
      source: i.source,
      severity: i.severity || "N/A",
    })),
    dry_run,
  };
}
