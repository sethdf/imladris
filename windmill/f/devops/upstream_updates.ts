// Windmill Script: Upstream Dependency Update Checker
// Daily check for new releases/changes to tools and ecosystem imladris depends on.
//
// Monitors: GitHub repos (imladris deps + competitive + OSS models),
// npm packages, and AI research blogs via RSS.
//
// Runs daily at 8 AM PT. Uses seen-state to avoid duplicate reports.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { shouldCatchUp, recordRun, type CatchupInfo } from "./catchup_lib.ts";

const HOME = process.env.HOME || "/root";
const LOG_FILE = join(HOME, ".claude", "logs", "upstream-updates.jsonl");
const SEEN_FILE = join(HOME, ".claude", "state", "upstream-seen.json");
const TWENTY_FOUR_HOURS_MS = 24 * 3600000;

// ── Monitored Sources ──────────────────────────────────────────────

interface MonitoredRepo {
  name: string;
  owner: string;
  repo: string;
  relevance: string;       // Why imladris cares — static, shown in report
  check: "releases" | "tags" | "commits";  // What to poll
  branch?: string;         // For commit checks (default: main)
}

const REPOS: MonitoredRepo[] = [
  {
    name: "Claude Code",
    owner: "anthropics",
    repo: "claude-code",
    relevance: "Primary interface — new features, breaking changes, hook API updates",
    check: "releases",
  },
  {
    name: "PAI",
    owner: "danielmiessler",
    repo: "PAI",
    relevance: "Core algorithm — skills, hooks, agents, Algorithm version changes",
    check: "commits",
    branch: "main",
  },
  {
    name: "OpenClaw",
    owner: "anthropics",
    repo: "openclaw",
    relevance: "Patterns to adapt — cron, search, multi-agent coordination",
    check: "releases",
  },
  {
    name: "Anthropic SDK (TypeScript)",
    owner: "anthropics",
    repo: "anthropic-sdk-typescript",
    relevance: "Inference.ts dependency — new model support, API changes",
    check: "releases",
  },
  {
    name: "Anthropic SDK (Python)",
    owner: "anthropics",
    repo: "anthropic-sdk-python",
    relevance: "API contract changes that affect TypeScript SDK too",
    check: "releases",
  },
  {
    name: "Bun",
    owner: "oven-sh",
    repo: "bun",
    relevance: "Runtime for all scripts — performance fixes, API additions, breaking changes",
    check: "releases",
  },
  {
    name: "Windmill",
    owner: "windmill-labs",
    repo: "windmill",
    relevance: "Automation layer — worker changes, API updates, new features",
    check: "releases",
  },
  {
    name: "Anthropic Cookbook",
    owner: "anthropics",
    repo: "anthropic-cookbook",
    relevance: "New patterns, tool use examples, best practices",
    check: "commits",
    branch: "main",
  },
  // ── Competitive Intelligence ──
  {
    name: "OpenAI Codex",
    owner: "openai",
    repo: "codex",
    relevance: "Competitive — coding agent patterns, tool use approaches, CLI design",
    check: "releases",
  },
  {
    name: "OpenAI Cookbook",
    owner: "openai",
    repo: "openai-cookbook",
    relevance: "Competitive — API patterns, prompt engineering, tool use examples",
    check: "commits",
    branch: "main",
  },
  // ── Open Source Models ──
  {
    name: "Llama Models",
    owner: "meta-llama",
    repo: "llama-models",
    relevance: "OSS frontier — new model weights, architecture changes, local inference options",
    check: "releases",
  },
  {
    name: "Mistral Inference",
    owner: "mistralai",
    repo: "mistral-inference",
    relevance: "OSS frontier — efficient inference, new model releases, API-compatible serving",
    check: "releases",
  },
  {
    name: "Gemma",
    owner: "google-deepmind",
    repo: "gemma",
    relevance: "OSS frontier — Google open weights, multimodal capabilities",
    check: "releases",
  },
  {
    name: "Hugging Face Transformers",
    owner: "huggingface",
    repo: "transformers",
    relevance: "Model ecosystem — new model support, pipeline APIs, tokenizer updates",
    check: "releases",
  },
  {
    name: "Ollama",
    owner: "ollama",
    repo: "ollama",
    relevance: "Local model runner — relevant for local Whisper, embeddings, offline inference",
    check: "releases",
  },
];

// ── npm package monitoring ─────────────────────────────────────────

interface NpmPackage {
  name: string;
  package: string;
  relevance: string;
}

const NPM_PACKAGES: NpmPackage[] = [
  {
    name: "Claude Code (npm)",
    package: "@anthropic-ai/claude-code",
    relevance: "Installed CLI version — update when new version ships",
  },
];

// ── Blog / RSS Monitoring ──────────────────────────────────────────

interface MonitoredBlog {
  name: string;
  feed_url: string;
  relevance: string;
}

const BLOGS: MonitoredBlog[] = [
  {
    name: "Anthropic Blog",
    feed_url: "https://www.anthropic.com/rss.xml",
    relevance: "Primary vendor — model releases, API changes, safety research, Claude updates",
  },
  {
    name: "OpenAI Blog",
    feed_url: "https://openai.com/blog/rss.xml",
    relevance: "Competitive — GPT releases, Codex updates, API changes, product launches",
  },
  {
    name: "Google DeepMind Blog",
    feed_url: "https://deepmind.google/blog/rss.xml",
    relevance: "Competitive — Gemini/Gemma releases, research breakthroughs",
  },
  {
    name: "Meta AI Blog",
    feed_url: "https://ai.meta.com/blog/rss/",
    relevance: "OSS ecosystem — Llama releases, open source model announcements",
  },
  {
    name: "Hugging Face Blog",
    feed_url: "https://huggingface.co/blog/feed.xml",
    relevance: "Model ecosystem — new libraries, model releases, community tools",
  },
];

// ── Types ──────────────────────────────────────────────────────────

interface Update {
  source: string;
  type: "release" | "commit" | "npm" | "blog";
  version?: string;
  title: string;
  url: string;
  published: string;
  relevance: string;
  body_summary?: string;
}

interface SeenState {
  [key: string]: string[];  // source name → array of seen IDs
}

// ── Helpers ────────────────────────────────────────────────────────

function ensureDirs(): void {
  const logDir = join(HOME, ".claude", "logs");
  const stateDir = join(HOME, ".claude", "state");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
}

function loadSeen(): SeenState {
  if (!existsSync(SEEN_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SEEN_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveSeen(seen: SeenState): void {
  // Keep last 200 entries per source to prevent unbounded growth
  const trimmed: SeenState = {};
  for (const [key, ids] of Object.entries(seen)) {
    trimmed[key] = ids.slice(-200);
  }
  writeFileSync(SEEN_FILE, JSON.stringify(trimmed, null, 2));
}

function isNew(seen: SeenState, source: string, id: string): boolean {
  return !(seen[source] || []).includes(id);
}

function markSeen(seen: SeenState, source: string, id: string): void {
  if (!seen[source]) seen[source] = [];
  seen[source].push(id);
}

function summarizeBody(body: string | null | undefined, maxLen = 200): string {
  if (!body) return "";
  // Strip markdown formatting, collapse whitespace
  const clean = body
    .replace(/#{1,6}\s/g, "")
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n+/g, " ")
    .trim();
  return clean.length > maxLen ? clean.slice(0, maxLen) + "..." : clean;
}

// ── GitHub API ─────────────────────────────────────────────────────

const GH_HEADERS: Record<string, string> = {
  "Accept": "application/vnd.github+json",
  "User-Agent": "imladris-upstream-checker/1.0",
  "X-GitHub-Api-Version": "2022-11-28",
};

async function checkReleases(repo: MonitoredRepo, seen: SeenState): Promise<Update[]> {
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=5`;
  try {
    const res = await fetch(url, { headers: GH_HEADERS, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      if (res.status === 404) return []; // Repo might not have releases
      throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
    }
    const releases = await res.json() as any[];
    const updates: Update[] = [];
    for (const rel of releases) {
      const id = rel.tag_name || rel.id?.toString();
      if (!id || !isNew(seen, repo.name, id)) continue;
      markSeen(seen, repo.name, id);
      updates.push({
        source: repo.name,
        type: "release",
        version: rel.tag_name,
        title: rel.name || rel.tag_name,
        url: rel.html_url,
        published: rel.published_at || rel.created_at,
        relevance: repo.relevance,
        body_summary: summarizeBody(rel.body),
      });
    }
    return updates;
  } catch (err: any) {
    return [{
      source: repo.name,
      type: "release",
      title: `[ERROR] Failed to check: ${err.message}`,
      url: `https://github.com/${repo.owner}/${repo.repo}/releases`,
      published: new Date().toISOString(),
      relevance: repo.relevance,
    }];
  }
}

async function checkCommits(repo: MonitoredRepo, seen: SeenState): Promise<Update[]> {
  const branch = repo.branch || "main";
  const since = new Date(Date.now() - 48 * 3600000).toISOString(); // Last 48h for daily+catchup
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/commits?sha=${branch}&since=${since}&per_page=10`;
  try {
    const res = await fetch(url, { headers: GH_HEADERS, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
    const commits = await res.json() as any[];
    const updates: Update[] = [];
    for (const c of commits) {
      const sha = c.sha?.slice(0, 8);
      if (!sha || !isNew(seen, repo.name, sha)) continue;
      markSeen(seen, repo.name, sha);
      updates.push({
        source: repo.name,
        type: "commit",
        title: c.commit?.message?.split("\n")[0] || "Unknown commit",
        url: c.html_url,
        published: c.commit?.committer?.date || new Date().toISOString(),
        relevance: repo.relevance,
      });
    }
    return updates;
  } catch (err: any) {
    return [{
      source: repo.name,
      type: "commit",
      title: `[ERROR] Failed to check: ${err.message}`,
      url: `https://github.com/${repo.owner}/${repo.repo}`,
      published: new Date().toISOString(),
      relevance: repo.relevance,
    }];
  }
}

// ── npm Registry ───────────────────────────────────────────────────

async function checkNpm(pkg: NpmPackage, seen: SeenState): Promise<Update[]> {
  const url = `https://registry.npmjs.org/${pkg.package}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`npm registry ${res.status}`);
    const data = await res.json() as any;
    const latest = data["dist-tags"]?.latest;
    if (!latest || !isNew(seen, pkg.name, latest)) return [];
    markSeen(seen, pkg.name, latest);
    const versionInfo = data.versions?.[latest];
    return [{
      source: pkg.name,
      type: "npm",
      version: latest,
      title: `${pkg.package}@${latest}`,
      url: `https://www.npmjs.com/package/${pkg.package}/v/${latest}`,
      published: versionInfo?.publishedAt || data.time?.[latest] || new Date().toISOString(),
      relevance: pkg.relevance,
    }];
  } catch (err: any) {
    return [{
      source: pkg.name,
      type: "npm",
      title: `[ERROR] Failed to check npm: ${err.message}`,
      url: `https://www.npmjs.com/package/${pkg.package}`,
      published: new Date().toISOString(),
      relevance: pkg.relevance,
    }];
  }
}

// ── Blog / RSS Feeds ──────────────────────────────────────────────

async function checkBlog(blog: MonitoredBlog, seen: SeenState): Promise<Update[]> {
  try {
    const res = await fetch(blog.feed_url, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "imladris-upstream-checker/1.0" },
    });
    if (!res.ok) throw new Error(`RSS ${res.status}: ${res.statusText}`);
    const xml = await res.text();

    // Simple XML extraction — handles both RSS <item> and Atom <entry>
    const items: Update[] = [];
    // Match <item>...</item> or <entry>...</entry> blocks
    const entryPattern = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
    let match: RegExpExecArray | null;
    let count = 0;

    while ((match = entryPattern.exec(xml)) !== null && count < 10) {
      const block = match[1];

      // Extract title
      const titleMatch = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
      const title = titleMatch?.[1]?.trim() || "Untitled";

      // Extract link (RSS: <link>, Atom: <link href="...">)
      const linkHrefMatch = block.match(/<link[^>]+href="([^"]+)"/i);
      const linkTextMatch = block.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i);
      const url = linkHrefMatch?.[1] || linkTextMatch?.[1]?.trim() || blog.feed_url;

      // Extract date (pubDate for RSS, published/updated for Atom)
      const dateMatch = block.match(/<(?:pubDate|published|updated)>([^<]+)<\//i);
      const published = dateMatch?.[1]?.trim() || new Date().toISOString();

      // Use URL as unique ID (most stable across feed rebuilds)
      const id = url;
      if (!isNew(seen, blog.name, id)) continue;
      markSeen(seen, blog.name, id);

      // Extract description/summary snippet
      const descMatch = block.match(/<(?:description|summary|content)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:description|summary|content)>/i);
      const body_summary = descMatch ? summarizeBody(descMatch[1]) : "";

      items.push({
        source: blog.name,
        type: "blog",
        title,
        url,
        published,
        relevance: blog.relevance,
        body_summary,
      });
      count++;
    }

    return items;
  } catch (err: any) {
    return [{
      source: blog.name,
      type: "blog",
      title: `[ERROR] Failed to fetch feed: ${err.message}`,
      url: blog.feed_url,
      published: new Date().toISOString(),
      relevance: blog.relevance,
    }];
  }
}

// ── Report Formatting ──────────────────────────────────────────────

function formatReport(updates: Update[], catchup: CatchupInfo): string {
  const lines: string[] = [];
  lines.push("═══ UPSTREAM DEPENDENCY UPDATE REPORT ═══");
  lines.push(`Generated: ${new Date().toISOString()}`);

  if (catchup.catchup_triggered) {
    lines.push(`⚠️  CATCHUP MODE: Instance was down for ${catchup.missed_duration_human}. Checking extended window.`);
  }

  if (updates.length === 0) {
    lines.push("\n✅ No new updates detected across all monitored sources.");
    return lines.join("\n");
  }

  lines.push(`\n📦 ${updates.length} new update(s) found:\n`);

  // Group by source
  const bySource = new Map<string, Update[]>();
  for (const u of updates) {
    if (!bySource.has(u.source)) bySource.set(u.source, []);
    bySource.get(u.source)!.push(u);
  }

  for (const [source, items] of bySource) {
    lines.push(`── ${source} ──`);
    lines.push(`   Why it matters: ${items[0].relevance}`);
    for (const item of items) {
      const tag = item.version ? `[${item.version}]` : `[${item.type}]`;
      lines.push(`   ${tag} ${item.title}`);
      if (item.body_summary) {
        lines.push(`         ${item.body_summary}`);
      }
      lines.push(`         ${item.url}`);
    }
    lines.push("");
  }

  // Action items for releases and important blog posts
  const actionable = updates.filter(u =>
    (u.type === "release" || u.type === "blog") && !u.title.startsWith("[ERROR]")
  );
  if (actionable.length > 0) {
    lines.push("── ACTION ITEMS ──");
    for (const r of actionable) {
      if (r.source === "Claude Code" || r.source === "Claude Code (npm)") {
        lines.push(`   → Review Claude Code ${r.version} changelog for breaking changes before updating`);
      } else if (r.source === "Bun") {
        lines.push(`   → Test Bun ${r.version} compatibility with Windmill scripts before updating`);
      } else if (r.source === "PAI") {
        lines.push(`   → Pull PAI updates and check for skill/hook/agent changes`);
      } else if (r.source === "Windmill") {
        lines.push(`   → Review Windmill ${r.version} for worker/API changes before docker-compose update`);
      } else if (r.source === "OpenAI Codex") {
        lines.push(`   → Review OpenAI Codex ${r.version || ""} for patterns to adapt or competitive moves`);
      } else if (r.type === "blog") {
        lines.push(`   → Read: "${r.title}" (${r.source})`);
      } else {
        lines.push(`   → Review ${r.source} ${r.version || ""} for relevant changes`);
      }
    }
  }

  return lines.join("\n");
}

// ── Main ───────────────────────────────────────────────────────────

export async function main(dry_run = false): Promise<{
  report: string;
  updates_found: number;
  sources_checked: number;
  errors: string[];
  catchup?: CatchupInfo;
}> {
  ensureDirs();

  const catchup = shouldCatchUp("upstream_updates", TWENTY_FOUR_HOURS_MS);
  const seen = loadSeen();
  const allUpdates: Update[] = [];
  const errors: string[] = [];

  // Check all GitHub repos
  for (const repo of REPOS) {
    try {
      let updates: Update[];
      if (repo.check === "releases" || repo.check === "tags") {
        updates = await checkReleases(repo, seen);
      } else {
        updates = await checkCommits(repo, seen);
      }
      allUpdates.push(...updates);
    } catch (err: any) {
      errors.push(`${repo.name}: ${err.message}`);
    }
  }

  // Check npm packages
  for (const pkg of NPM_PACKAGES) {
    try {
      const updates = await checkNpm(pkg, seen);
      allUpdates.push(...updates);
    } catch (err: any) {
      errors.push(`${pkg.name}: ${err.message}`);
    }
  }

  // Check blog RSS feeds
  for (const blog of BLOGS) {
    try {
      const updates = await checkBlog(blog, seen);
      allUpdates.push(...updates);
    } catch (err: any) {
      errors.push(`${blog.name}: ${err.message}`);
    }
  }

  const report = formatReport(allUpdates, catchup);

  // Persist state and log
  if (!dry_run) {
    saveSeen(seen);
    recordRun("upstream_updates");

    // Log each update as JSONL for trend tracking
    for (const u of allUpdates) {
      if (!u.title.startsWith("[ERROR]")) {
        const entry = { ...u, checked_at: new Date().toISOString() };
        appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
      }
    }
  }

  return {
    report,
    updates_found: allUpdates.filter(u => !u.title.startsWith("[ERROR]")).length,
    sources_checked: REPOS.length + NPM_PACKAGES.length + BLOGS.length,
    errors,
    ...(catchup.catchup_triggered ? { catchup } : {}),
  };
}
