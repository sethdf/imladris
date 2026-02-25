// Windmill Script: Upstream Dependency Update Checker
// Daily check for new releases/changes to tools imladris depends on.
//
// Monitors GitHub repos + npm for: Claude Code, PAI, OpenClaw,
// Anthropic SDK, Bun, Windmill, and Anthropic model announcements.
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

// ── Types ──────────────────────────────────────────────────────────

interface Update {
  source: string;
  type: "release" | "commit" | "npm";
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

  // Action items
  const releases = updates.filter(u => u.type === "release" && !u.title.startsWith("[ERROR]"));
  if (releases.length > 0) {
    lines.push("── ACTION ITEMS ──");
    for (const r of releases) {
      if (r.source === "Claude Code" || r.source === "Claude Code (npm)") {
        lines.push(`   → Review Claude Code ${r.version} changelog for breaking changes before updating`);
      } else if (r.source === "Bun") {
        lines.push(`   → Test Bun ${r.version} compatibility with Windmill scripts before updating`);
      } else if (r.source === "PAI") {
        lines.push(`   → Pull PAI updates and check for skill/hook/agent changes`);
      } else if (r.source === "Windmill") {
        lines.push(`   → Review Windmill ${r.version} for worker/API changes before docker-compose update`);
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
    sources_checked: REPOS.length + NPM_PACKAGES.length,
    errors,
    ...(catchup.catchup_triggered ? { catchup } : {}),
  };
}
