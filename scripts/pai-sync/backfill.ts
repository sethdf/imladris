// ============================================================
// backfill.ts — initial bulk upload of existing MEMORY files
// Runs once on first deploy (or after a long sync gap).
// Strategy: newest-first, progress tracked in STATE/sync-backfill.jsonl
// ============================================================

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { config } from "./config.ts";
import { shouldExclude, toFileKey } from "./syncignore.ts";
import { SyncEngine } from "./SyncEngine.ts";

interface BackfillProgress {
  started_at: string;
  files_total: number;
  files_done: number;
  files_pushed: number;
  files_skipped: number;
  lines_pushed: number;
  errors: string[];
  completed_at?: string;
}

const PROGRESS_PATH = path.join(config.watchRoot, "STATE", "sync-backfill.jsonl");
const BATCH_SIZE = 200;

export async function runBackfill(): Promise<void> {
  const engine = new SyncEngine(process.env.PAI_SESSION_ID);

  console.log(`[pai-sync backfill] scanning ${config.watchRoot}...`);

  // Collect all files, sorted newest-first by mtime
  const allFiles = walkDirSortedByMtime(config.watchRoot)
    .filter((f) => !shouldExclude(f));

  const progress: BackfillProgress = {
    started_at: new Date().toISOString(),
    files_total: allFiles.length,
    files_done: 0,
    files_pushed: 0,
    files_skipped: 0,
    lines_pushed: 0,
    errors: [],
  };

  console.log(`[pai-sync backfill] ${allFiles.length} files to process`);
  writeProgress(progress);

  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    const batch = allFiles.slice(i, i + BATCH_SIZE);
    const keys = batch.map(toFileKey);

    // Check which files the remote already has
    const remoteHashes = await getRemoteHashes(engine, keys);

    for (const absPath of batch) {
      const key = toFileKey(absPath);
      let content: string;
      try {
        content = fs.readFileSync(absPath, "utf8");
      } catch {
        progress.files_skipped++;
        continue;
      }

      // Skip if remote already has this exact content
      const localHash = sha256(content);
      if (remoteHashes.get(key) === localHash) {
        progress.files_skipped++;
        progress.files_done++;
        continue;
      }

      try {
        if (key.endsWith(".jsonl")) {
          // Use SyncEngine's JSONL push
          const lines = content
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => ({
              content: l,
              lineHash: sha256(l),
              metadata: safeParseJson(l),
              sessionId: null,
              machineId: config.machineId,
            }));
          if (lines.length > 0) {
            const { inserted } = await engine.adapter.putLines(key, lines);
            progress.lines_pushed += inserted;
          }
        } else {
          // Regular file
          engine.onFileChanged(absPath);
          progress.files_pushed++;
        }
      } catch (e) {
        progress.errors.push(`${key}: ${e}`);
      }

      progress.files_done++;
    }

    // Force push after each batch (bypass debounce)
    await engine.flush();

    // Write progress
    writeProgress(progress);

    const pct = Math.round((progress.files_done / progress.files_total) * 100);
    console.log(
      `[pai-sync backfill] ${pct}% — ${progress.files_done}/${progress.files_total} files, ` +
      `${progress.lines_pushed} lines`
    );
  }

  progress.completed_at = new Date().toISOString();
  writeProgress(progress);
  await engine.close();

  console.log(
    `[pai-sync backfill] done — pushed ${progress.files_pushed} files, ` +
    `${progress.lines_pushed} lines, skipped ${progress.files_skipped}, ` +
    `${progress.errors.length} errors`
  );

  if (progress.errors.length > 0) {
    console.error("[pai-sync backfill] errors:");
    for (const e of progress.errors) console.error(" ", e);
  }
}

// ============================================================
// Helpers
// ============================================================

function walkDirSortedByMtime(dir: string): string[] {
  const results: Array<{ path: string; mtime: number }> = [];
  walkDirRec(dir, results);
  results.sort((a, b) => b.mtime - a.mtime); // newest first
  return results.map((r) => r.path);
}

function walkDirRec(dir: string, out: Array<{ path: string; mtime: number }>): void {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDirRec(full, out);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          out.push({ path: full, mtime: stat.mtimeMs });
        } catch {
          // stat failed — skip
        }
      }
    }
  } catch {
    // readdir failed — skip
  }
}

function writeProgress(progress: BackfillProgress): void {
  const dir = path.dirname(PROGRESS_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(PROGRESS_PATH, JSON.stringify(progress) + "\n");
}

async function getRemoteHashes(
  engine: SyncEngine,
  keys: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  // Batch check — for now do individual lookups (acceptable for backfill)
  for (const key of keys) {
    try {
      const remote = await engine.adapter.getFile(key);
      if (remote) map.set(key, remote.contentHash);
    } catch {
      // skip
    }
  }
  return map;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function safeParseJson(line: string): Record<string, unknown> {
  try { return JSON.parse(line); } catch { return {}; }
}
