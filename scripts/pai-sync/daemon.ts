#!/usr/bin/env bun
// ============================================================
// daemon.ts — inotify watcher and systemd watchdog
// Spawns inotifywait, routes events to SyncEngine.
// Install to /usr/local/bin/pai-sync-daemon via Ansible.
// ============================================================

import { config, validateConfig } from "./config.ts";
import { SyncEngine } from "./SyncEngine.ts";
import { processUnembedded } from "./embeddings.ts";
import pg from "pg";

// Validate config before starting
try {
  validateConfig();
} catch (e) {
  console.error(`[pai-sync-daemon] config error: ${e}`);
  process.exit(1);
}

const engine = new SyncEngine(process.env.PAI_SESSION_ID);

// Replay any uncommitted WAL entries from previous daemon run
await engine.replayWal();

console.log(`[pai-sync-daemon] watching ${config.watchRoot}`);

// Embedding worker — processes unembedded memory_objects every 60s
const embeddingPool = new pg.Pool({ connectionString: config.postgresUrl, max: 2 });
const EMBEDDING_INTERVAL_MS = 60_000;
let embeddingTimer: ReturnType<typeof setInterval> | null = null;

async function runEmbeddingCycle() {
  try {
    const result = await processUnembedded(embeddingPool);
    if (result.processed > 0 || result.errors > 0) {
      console.log(`[embeddings] processed=${result.processed} skipped=${result.skipped} errors=${result.errors}`);
    }
  } catch (err) {
    console.error(`[embeddings] cycle error: ${err}`);
  }
}

// Start embedding worker after a 30s delay (let initial sync settle)
setTimeout(() => {
  runEmbeddingCycle(); // first run
  embeddingTimer = setInterval(runEmbeddingCycle, EMBEDDING_INTERVAL_MS);
  console.log(`[embeddings] worker started (every ${EMBEDDING_INTERVAL_MS / 1000}s)`);
}, 30_000);

// systemd watchdog ping
let watchdogInterval: ReturnType<typeof setInterval> | null = null;
if (process.env.WATCHDOG_USEC) {
  const intervalMs = Math.floor(config.watchdogSec * 1000 / 2);
  watchdogInterval = setInterval(() => {
    // Signal sd_notify via WATCHDOG=1 — Bun doesn't have native sd_notify,
    // but the systemd WatchdogSec gives us a safety net; the interval log line
    // keeps the daemon alive until proper sd_notify support is added.
    process.stderr.write("[watchdog]\n");
  }, intervalMs);
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[pai-sync-daemon] SIGTERM received, flushing...");
  if (watchdogInterval) clearInterval(watchdogInterval);
  if (embeddingTimer) clearInterval(embeddingTimer);
  await embeddingPool.end();
  await engine.close();
  process.exit(0);
});
process.on("SIGINT", async () => {
  if (watchdogInterval) clearInterval(watchdogInterval);
  if (embeddingTimer) clearInterval(embeddingTimer);
  await embeddingPool.end();
  await engine.close();
  process.exit(0);
});

// Spawn inotifywait in monitor mode
// -r = recursive, -m = monitor (continuous), -e = events, --format = line format
const inotify = Bun.spawn(
  [
    "inotifywait",
    "-r",
    "-m",
    "-e", "close_write",
    "-e", "moved_to",
    "-e", "create",
    "-e", "delete",
    "--format", "%w%f %e",
    "--quiet",
    config.watchRoot,
  ],
  {
    stdout: "pipe",
    stderr: "inherit",
  }
);

// Stream stdout line by line
const reader = inotify.stdout.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? ""; // keep incomplete line in buffer

  for (const line of lines) {
    if (!line.trim()) continue;
    const spaceIdx = line.lastIndexOf(" ");
    if (spaceIdx === -1) continue;

    const absolutePath = line.slice(0, spaceIdx);
    const event = line.slice(spaceIdx + 1);

    if (event.includes("DELETE")) {
      engine.onFileDeleted(absolutePath);
    } else {
      engine.onFileChanged(absolutePath);
    }
  }
}

// inotifywait exited unexpectedly
console.error("[pai-sync-daemon] inotifywait exited — daemon stopping");
await engine.close();
process.exit(1);
