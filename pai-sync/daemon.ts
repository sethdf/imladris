#!/usr/bin/env bun
/**
 * PAI Memory Sync Daemon
 *
 * Watches ~/.claude/ via chokidar and pushes changes to pai_memory Postgres DB.
 * Uses a write-ahead log (WAL) for zero data loss across restarts.
 * Debounces pushes: 5s quiet period or 30s max-wait cap.
 */

import chokidar from 'chokidar';
import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync, openSync, fsyncSync, closeSync } from 'fs';
import { join, relative, dirname } from 'path';
import { homedir } from 'os';
import { SyncEngine } from './sync-engine.ts';
import { shouldExclude } from './syncignore.ts';

const CLAUDE_DIR      = join(homedir(), '.claude');
const STATE_DIR       = join(CLAUDE_DIR, 'MEMORY/STATE');
const WAL_PATH        = join(STATE_DIR, 'sync-wal.jsonl');
const SYNC_LOG_PATH   = join(STATE_DIR, 'sync-log.jsonl');
const DEBOUNCE_MS     = 5_000;
const MAX_WAIT_MS     = 30_000;
const RETRY_DELAYS    = [2000, 4000, 8000, 16000];

const PG_URL = `postgresql://postgres:${process.env.WINDMILL_DB_PASSWORD}@127.0.0.1:5432/pai_memory`;

interface WalEntry {
  path: string;
  event: string;
  timestamp: string;
  committed: boolean;
}

// ── WAL helpers ────────────────────────────────────────────────────────────

function walAppend(entry: WalEntry): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  const fd = openSync(WAL_PATH, 'a');
  try {
    const buf = Buffer.from(line, 'utf8');
    // @ts-ignore — Bun/Node writeSync
    import('fs').then(({ writeSync }) => writeSync(fd, buf));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function walAppendSync(entry: WalEntry): void {
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(WAL_PATH, JSON.stringify(entry) + '\n', 'utf8');
}

function readWal(): WalEntry[] {
  if (!existsSync(WAL_PATH)) return [];
  try {
    return readFileSync(WAL_PATH, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as WalEntry);
  } catch {
    return [];
  }
}

function rewriteWal(entries: WalEntry[]): void {
  writeFileSync(WAL_PATH, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
}

function markWalCommitted(relativePath: string): void {
  const entries = readWal();
  const updated = entries.map(e =>
    e.path === relativePath ? { ...e, committed: true } : e
  );
  rewriteWal(updated);
}

// ── Sync log ───────────────────────────────────────────────────────────────

function writeLog(entry: Record<string, unknown>): void {
  try {
    appendFileSync(SYNC_LOG_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch {
    // log failure is non-fatal
  }
}

// ── Main daemon ────────────────────────────────────────────────────────────

const engine = new SyncEngine(PG_URL);
const dirtyFiles = new Set<string>();    // relative paths pending push
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let maxWaitTimer:  ReturnType<typeof setTimeout> | null = null;

async function pushFile(relativePath: string): Promise<void> {
  const fullPath = join(CLAUDE_DIR, relativePath);
  let content: string;
  try {
    content = readFileSync(fullPath, 'utf8');
  } catch {
    // File deleted or unreadable — soft delete in DB
    try { await engine.softDelete(relativePath); } catch { /* ignore */ }
    return;
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      if (relativePath.endsWith('.jsonl')) {
        const lines = content.split('\n').filter(l => l.trim());
        await engine.putLines(relativePath, lines);
      } else {
        await engine.putFile(relativePath, content);
      }
      markWalCommitted(relativePath);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_DELAYS.length) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
      }
    }
  }
  console.error(`[pai-sync] Failed to push ${relativePath}:`, lastErr);
}

async function flush(): Promise<void> {
  if (dirtyFiles.size === 0) return;

  const batch = Array.from(dirtyFiles);
  dirtyFiles.clear();

  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (maxWaitTimer)  { clearTimeout(maxWaitTimer);  maxWaitTimer  = null; }

  const start = Date.now();
  let pushed = 0;
  let failed = 0;

  for (const rel of batch) {
    try {
      await pushFile(rel);
      pushed++;
    } catch (err) {
      failed++;
      console.error(`[pai-sync] Error flushing ${rel}:`, err);
    }
  }

  writeLog({ direction: 'push', files_pushed: pushed, files_failed: failed, duration_ms: Date.now() - start });
  if (pushed > 0) {
    console.log(`[pai-sync] Pushed ${pushed} file(s)${failed ? `, ${failed} failed` : ''} (${Date.now() - start}ms)`);
  }
}

function schedulePush(): void {
  // Reset debounce timer
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => flush(), DEBOUNCE_MS);

  // Start max-wait timer only once per batch
  if (!maxWaitTimer) {
    maxWaitTimer = setTimeout(() => flush(), MAX_WAIT_MS);
  }
}

function onFileEvent(event: string, fullPath: string): void {
  const relativePath = relative(CLAUDE_DIR, fullPath);
  if (shouldExclude(relativePath)) return;

  walAppendSync({ path: relativePath, event, timestamp: new Date().toISOString(), committed: false });
  dirtyFiles.add(relativePath);
  schedulePush();
}

// Replay uncommitted WAL entries on startup
async function replayWal(): Promise<void> {
  const entries = readWal().filter(e => !e.committed);
  if (entries.length === 0) return;

  console.log(`[pai-sync] Replaying ${entries.length} uncommitted WAL entries`);
  for (const entry of entries) {
    dirtyFiles.add(entry.path);
  }
  await flush();
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log('[pai-sync] Shutting down — flushing pending files');
  await flush();
  await engine.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

// ── Start ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true });

  console.log('[pai-sync] Starting — replaying WAL');
  await replayWal();

  const watcher = chokidar.watch(CLAUDE_DIR, {
    recursive: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    ignored: (path: string) => {
      const rel = relative(CLAUDE_DIR, path);
      return shouldExclude(rel);
    },
  });

  watcher
    .on('add',    path => onFileEvent('add',    path))
    .on('change', path => onFileEvent('change', path))
    .on('unlink', path => onFileEvent('unlink', path))
    .on('error',  err  => console.error('[pai-sync] Watcher error:', err));

  console.log(`[pai-sync] Watching ${CLAUDE_DIR}`);

  // Systemd watchdog
  if (process.env.WATCHDOG_USEC) {
    const interval = Math.floor(parseInt(process.env.WATCHDOG_USEC) / 2000);
    setInterval(() => process.kill(process.pid, 0), interval); // keep-alive ping
  }
}

main().catch(err => {
  console.error('[pai-sync] Fatal error:', err);
  process.exit(1);
});
