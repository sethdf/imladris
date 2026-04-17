// ============================================================
// SyncEngine.ts — debounce logic, WAL management, push/pull orchestration
// ============================================================

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { config } from "./config.ts";
import { shouldExclude, toFileKey } from "./syncignore.ts";
import { extractMetadata } from "./metadata-extractor.ts";
import { maybeCompress, decompressBase64 } from "./compression.ts";
import { PostgresAdapter } from "./adapters/PostgresAdapter.ts";

interface WalEntry {
  path: string;
  event: "change" | "delete";
  timestamp: string;
  committed?: boolean;
}

interface SyncResult {
  files_pushed: number;
  files_skipped: number;
  lines_pushed: number;
  versions_archived: number;
  errors: string[];
  duration_ms: number;
}

export class SyncEngine {
  private db: PostgresAdapter;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty: Set<string> = new Set(); // absolute paths pending push
  private walFd: number | null = null;

  constructor(private sessionId?: string) {
    this.db = new PostgresAdapter(config.postgresUrl);
    this.openWal();
  }

  // ============================================================
  // WAL management
  // ============================================================

  private openWal(): void {
    const dir = path.dirname(config.walPath);
    fs.mkdirSync(dir, { recursive: true });
    this.walFd = fs.openSync(config.walPath, "a");
  }

  private appendWal(entry: WalEntry): void {
    if (this.walFd === null) return;
    const line = JSON.stringify(entry) + "\n";
    const buf = Buffer.from(line);
    fs.writeSync(this.walFd, buf);
    fs.fsyncSync(this.walFd); // guarantee durability before returning
  }

  private markWalCommitted(paths: string[]): void {
    // Rewrite WAL removing committed entries (in practice: append a commit marker)
    const set = new Set(paths);
    const entries = this.readWal().filter((e) => !set.has(e.path));
    fs.writeFileSync(config.walPath, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
  }

  readWal(): WalEntry[] {
    try {
      return fs
        .readFileSync(config.walPath, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as WalEntry);
    } catch {
      return [];
    }
  }

  // ============================================================
  // Debounce logic — called by daemon on every inotify event
  // ============================================================

  onFileChanged(absolutePath: string): void {
    if (shouldExclude(absolutePath)) return;

    // Append to WAL immediately (fsync'd — zero data loss)
    this.appendWal({ path: absolutePath, event: "change", timestamp: new Date().toISOString() });
    this.dirty.add(absolutePath);

    // Start or reset the 5s quiet timer
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushDirty(), config.debounceMs);

    // Start 30s max-wait timer if not already running
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => this.flushDirty(), config.maxWaitMs);
    }
  }

  onFileDeleted(absolutePath: string): void {
    if (shouldExclude(absolutePath)) return;
    this.appendWal({ path: absolutePath, event: "delete", timestamp: new Date().toISOString() });
    this.dirty.add(absolutePath + "\x00delete"); // marker
  }

  /** Public flush — used by CLI (push command) and backfill to bypass debounce. */
  async flush(): Promise<void> {
    return this.flushDirty();
  }

  private async flushDirty(): Promise<void> {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.maxWaitTimer) { clearTimeout(this.maxWaitTimer); this.maxWaitTimer = null; }

    const paths = [...this.dirty];
    this.dirty.clear();

    if (paths.length === 0) return;
    await this.pushPaths(paths);
  }

  // ============================================================
  // Push — filesystem → Postgres
  // ============================================================

  async pushAll(): Promise<SyncResult> {
    const start = Date.now();
    const result: SyncResult = { files_pushed: 0, files_skipped: 0, lines_pushed: 0, versions_archived: 0, errors: [] };

    // Walk ALL watched roots (main + extra paths like projects/)
    const allRoots = [config.watchRoot, ...config.extraWatchPaths];
    const batch: string[] = [];
    for (const root of allRoots) {
      try {
        for (const f of walkDir(root)) {
          if (!shouldExclude(f)) batch.push(f);
        }
      } catch (e) {
        result.errors.push(`walk ${root}: ${e}`);
      }
    }

    const stats = await this.pushPaths(batch);
    result.files_pushed = stats.files_pushed;
    result.files_skipped = stats.files_skipped;
    result.lines_pushed = stats.lines_pushed;
    result.errors = stats.errors;
    result.duration_ms = Date.now() - start;
    this.writeSyncLog({ direction: "push", ...result });
    return result;
  }

  private async pushPaths(paths: string[]): Promise<SyncResult> {
    const start = Date.now();
    const result: SyncResult = { files_pushed: 0, files_skipped: 0, lines_pushed: 0, versions_archived: 0, errors: [] };

    for (const absPath of paths) {
      // Handle delete markers
      if (absPath.endsWith("\x00delete")) {
        const realPath = absPath.slice(0, -7);
        const key = toFileKey(realPath);
        try {
          await this.db.deleteFile(key);
        } catch (e) {
          result.errors.push(`delete ${key}: ${e}`);
        }
        continue;
      }

      const key = toFileKey(absPath);

      let content: string;
      try {
        content = fs.readFileSync(absPath, "utf8");
      } catch {
        result.files_skipped++;
        continue; // file may have been deleted between event and push
      }

      try {
        if (key.endsWith(".jsonl")) {
          const pushed = await this.pushJsonlFile(key, content);
          result.lines_pushed += pushed;
        } else {
          const pushed = await this.pushRegularFile(key, content);
          if (pushed) result.files_pushed++;
          else result.files_skipped++;
        }
        this.markWalCommitted([absPath]);
      } catch (e) {
        result.errors.push(`push ${key}: ${e}`);
      }
    }

    result.duration_ms = Date.now() - start;
    return result;
  }

  private async pushRegularFile(key: string, content: string): Promise<boolean> {
    const contentHash = sha256(content);

    // Check if remote is already up-to-date
    const remote = await this.db.getFile(key);
    if (remote && remote.contentHash === contentHash) return false; // no change

    const compressed = await maybeCompress(content);
    const metadata = extractMetadata(key, content);

    if (compressed.chunks && compressed.chunks.length > 1) {
      // Multi-chunk: push each chunk as a separate row
      for (const chunk of compressed.chunks) {
        await this.db.putFile(key + `#chunk${chunk.chunk_index}`, {
          content: chunk.content,
          contentHash: contentHash + `:chunk${chunk.chunk_index}`,
          metadata: { ...metadata, chunk_index: chunk.chunk_index, chunk_total: chunk.chunk_total },
          compressed: true,
          chunkIndex: chunk.chunk_index,
          chunkTotal: chunk.chunk_total,
          sessionId: this.sessionId ?? null,
          machineId: config.machineId,
        });
      }
    } else {
      await this.db.putFile(key, {
        content: compressed.content,
        contentHash,
        metadata: metadata as unknown as Record<string, unknown>,
        compressed: compressed.compressed,
        sessionId: this.sessionId ?? null,
        machineId: config.machineId,
      });
    }
    return true;
  }

  private async pushJsonlFile(key: string, content: string): Promise<number> {
    const lines = content
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => ({
        content: l,
        lineHash: sha256(l),
        metadata: safeParseJson(l),
        sessionId: this.sessionId ?? null,
        machineId: config.machineId,
      }));

    if (lines.length === 0) return 0;
    const { inserted } = await this.db.putLines(key, lines);
    return inserted;
  }

  // ============================================================
  // Pull — Postgres → filesystem
  // ============================================================

  async pullAll(): Promise<SyncResult> {
    const start = Date.now();
    const result: SyncResult = { files_pushed: 0, files_skipped: 0, lines_pushed: 0, versions_archived: 0, errors: [] };

    const remoteFiles = await this.db.listFiles();
    for (const f of remoteFiles) {
      try {
        await this.pullFile(f.key);
        result.files_pushed++;
      } catch (e) {
        result.errors.push(`pull ${f.key}: ${e}`);
      }
    }

    result.duration_ms = Date.now() - start;
    this.writeSyncLog({ direction: "pull", ...result });
    return result;
  }

  async pullFile(key: string): Promise<void> {
    const absPath = path.join(config.watchRoot, key.split("/").join(path.sep));
    fs.mkdirSync(path.dirname(absPath), { recursive: true });

    if (key.endsWith(".jsonl")) {
      const lines = await this.db.getLines(key);
      const content = lines.map((l) => l.content).join("\n") + "\n";
      fs.writeFileSync(absPath, content, "utf8");
    } else {
      const remote = await this.db.getFile(key);
      if (!remote) return;
      const content = remote.compressed
        ? await decompressBase64(remote.content)
        : remote.content;
      fs.writeFileSync(absPath, content, "utf8");
    }
  }

  // ============================================================
  // Status — show diff between local and remote
  // ============================================================

  async status(): Promise<{ localOnly: string[]; remoteOnly: string[]; modified: string[]; jsonlInSync: number }> {
    const localFiles = new Map<string, string>(); // key → hash (non-jsonl)
    const localJsonl = new Set<string>();          // keys for jsonl files

    for (const f of walkDir(config.watchRoot)) {
      if (shouldExclude(f)) continue;
      const key = toFileKey(f);
      const content = fs.readFileSync(f, "utf8");
      if (key.endsWith(".jsonl")) {
        localJsonl.add(key);
      } else {
        localFiles.set(key, sha256(content));
      }
    }

    const remote = new Map<string, string>(); // key → hash (memory_objects)
    for (const f of await this.db.listFiles()) {
      remote.set(f.key, f.contentHash);
    }

    // JSONL files live in memory_lines, not memory_objects — query separately
    const remoteJsonl = await this.db.listJsonlKeys().catch(() => new Set<string>());

    const localOnly = [...localFiles.keys()].filter((k) => !remote.has(k));
    const remoteOnly = [...remote.keys()].filter((k) => !localFiles.has(k));
    const modified = [...localFiles.keys()].filter(
      (k) => remote.has(k) && localFiles.get(k) !== remote.get(k)
    );

    // JSONL: count those on disk and in Postgres (don't flag as localOnly)
    const jsonlInSync = [...localJsonl].filter((k) => remoteJsonl.has(k)).length;
    // JSONL only on disk (no lines pushed yet — e.g. empty file)
    const jsonlLocalOnly = [...localJsonl].filter((k) => !remoteJsonl.has(k));
    localOnly.push(...jsonlLocalOnly);

    return { localOnly, remoteOnly, modified, jsonlInSync };
  }

  // ============================================================
  // Replay uncommitted WAL entries on startup
  // ============================================================

  async replayWal(): Promise<void> {
    const entries = this.readWal();
    if (entries.length === 0) return;
    console.log(`[pai-sync] replaying ${entries.length} uncommitted WAL entries`);
    const paths = entries.map((e) => e.event === "delete" ? e.path + "\x00delete" : e.path);
    await this.pushPaths(paths);
  }

  // ============================================================
  // Helpers
  // ============================================================

  private writeSyncLog(entry: Record<string, unknown>): void {
    const dir = path.dirname(config.syncLogPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      config.syncLogPath,
      JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n"
    );
  }

  async close(): Promise<void> {
    if (this.walFd !== null) fs.closeSync(this.walFd);
    await this.db.close();
  }

  get adapter(): PostgresAdapter {
    return this.db;
  }
}

// ============================================================
// Utilities
// ============================================================

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function safeParseJson(line: string): Record<string, unknown> {
  try { return JSON.parse(line); } catch { return {}; }
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkDir(full));
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  } catch {
    // directory disappeared — skip
  }
  return results;
}
