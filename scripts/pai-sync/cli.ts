#!/usr/bin/env bun
// ============================================================
// cli.ts — pai-sync CLI
// Install to /usr/local/bin/pai-sync via Ansible.
//
// Commands:
//   pai-sync push
//   pai-sync pull
//   pai-sync status [--verbose]
//   pai-sync history <key>
//   pai-sync restore <key> [--version N]
//   pai-sync diff <key> [v1] [v2]
//   pai-sync backfill
//   pai-sync daemon start|stop|status
// ============================================================

import { config, validateConfig } from "./config.ts";
import { SyncEngine } from "./SyncEngine.ts";
import { runBackfill } from "./backfill.ts";

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  printHelp();
  process.exit(0);
}

if (cmd === "daemon") {
  await handleDaemon(args.slice(1));
  process.exit(0);
}

if (cmd === "backfill") {
  validateConfig();
  await runBackfill();
  process.exit(0);
}

// All other commands need a Postgres connection
validateConfig();
const engine = new SyncEngine(process.env.PAI_SESSION_ID);

try {
  switch (cmd) {
    case "push":
      await handlePush();
      break;
    case "pull":
      await handlePull();
      break;
    case "status":
      await handleStatus(args.includes("--verbose"));
      break;
    case "history":
      await handleHistory(args[1]);
      break;
    case "restore":
      await handleRestore(args[1], args.indexOf("--version") !== -1 ? parseInt(args[args.indexOf("--version") + 1]) : undefined);
      break;
    case "diff":
      await handleDiff(args[1], args[2] ? parseInt(args[2]) : undefined, args[3] ? parseInt(args[3]) : undefined);
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
} finally {
  await engine.close();
}

// ============================================================
// Handlers
// ============================================================

async function handlePush(): Promise<void> {
  console.log("Pushing all dirty files to Postgres...");
  const result = await engine.pushAll();
  console.log(
    `Done: ${result.files_pushed} files pushed, ${result.files_skipped} unchanged, ` +
    `${result.lines_pushed} JSONL lines, ${result.errors.length} errors (${result.duration_ms}ms)`
  );
  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(" ", e);
    process.exit(1);
  }
}

async function handlePull(): Promise<void> {
  console.log("Pulling from Postgres to filesystem...");
  const result = await engine.pullAll();
  console.log(
    `Done: ${result.files_pushed} files restored, ${result.errors.length} errors (${result.duration_ms}ms)`
  );
  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(" ", e);
    process.exit(1);
  }
}

async function handleStatus(verbose: boolean): Promise<void> {
  const diff = await engine.status();
  const total = diff.localOnly.length + diff.remoteOnly.length + diff.modified.length;

  if (total === 0) {
    console.log(`✓ Local and remote are in sync  (${diff.jsonlInSync} JSONL files synced via memory_lines)`);
    return;
  }
  if (diff.jsonlInSync > 0) {
    console.log(`  ${diff.jsonlInSync} JSONL files synced via memory_lines`);
  }

  if (diff.localOnly.length > 0) {
    console.log(`\nLocal only (not yet pushed): ${diff.localOnly.length}`);
    if (verbose || diff.localOnly.length <= 20) {
      for (const f of diff.localOnly) console.log(`  + ${f}`);
    }
  }

  if (diff.remoteOnly.length > 0) {
    console.log(`\nRemote only (not pulled): ${diff.remoteOnly.length}`);
    if (verbose || diff.remoteOnly.length <= 20) {
      for (const f of diff.remoteOnly) console.log(`  - ${f}`);
    }
  }

  if (diff.modified.length > 0) {
    console.log(`\nModified (local differs from remote): ${diff.modified.length}`);
    if (verbose || diff.modified.length <= 20) {
      for (const f of diff.modified) console.log(`  ~ ${f}`);
    }
  }
}

async function handleHistory(key: string): Promise<void> {
  if (!key) {
    console.error("Usage: pai-sync history <key>");
    process.exit(1);
  }

  const history = await engine.adapter.getFileHistory(key);
  if (history.length === 0) {
    console.log(`No version history for: ${key}`);
    return;
  }

  console.log(`Version history for: ${key}`);
  for (const v of history) {
    console.log(
      `  v${v.version}  ${v.createdAt.toISOString()}  ${v.contentHash.slice(0, 8)}  ` +
      `machine:${v.machineId ?? "unknown"}  session:${v.sessionId?.slice(0, 8) ?? "unknown"}`
    );
  }
}

async function handleRestore(key: string, version?: number): Promise<void> {
  if (!key) {
    console.error("Usage: pai-sync restore <key> [--version N]");
    process.exit(1);
  }

  const ok = await engine.adapter.restoreFile(key, version);
  if (!ok) {
    console.error(`Cannot restore: ${key}${version !== undefined ? ` v${version}` : ""} — not found`);
    process.exit(1);
  }

  console.log(`Restored: ${key}${version !== undefined ? ` (v${version})` : ""}`);
  console.log("Run 'pai-sync pull' to write the restored version to disk.");
}

async function handleDiff(key: string, v1?: number, v2?: number): Promise<void> {
  if (!key) {
    console.error("Usage: pai-sync diff <key> [v1] [v2]");
    process.exit(1);
  }

  // Show current version
  const current = await engine.adapter.getFile(key);
  if (!current) {
    console.error(`File not found: ${key}`);
    process.exit(1);
  }

  const history = await engine.adapter.getFileHistory(key);
  console.log(`File: ${key}`);
  console.log(`Current: v${current.version}  hash:${current.contentHash.slice(0, 8)}`);
  if (history.length > 0) {
    console.log(`Previous versions: ${history.length}`);
    for (const v of history.slice(0, 5)) {
      console.log(`  v${v.version}  ${v.createdAt.toISOString()}  ${v.contentHash.slice(0, 8)}`);
    }
  }
  console.log("\nNote: pai-sync diff shows metadata only. Use 'pai-sync restore <key> --version N && pai-sync pull' to view content.");
}

async function handleDaemon(subArgs: string[]): Promise<void> {
  const sub = subArgs[0];
  switch (sub) {
    case "start":
      console.log("Starting pai-sync-daemon via systemd...");
      Bun.spawnSync(["systemctl", "start", "pai-sync"]);
      Bun.spawnSync(["systemctl", "status", "pai-sync", "--no-pager", "-l"]);
      break;
    case "stop":
      console.log("Stopping pai-sync-daemon...");
      Bun.spawnSync(["systemctl", "stop", "pai-sync"]);
      break;
    case "status": {
      const result = Bun.spawnSync(["systemctl", "is-active", "pai-sync"]);
      const active = new TextDecoder().decode(result.stdout).trim();
      console.log(`pai-sync daemon: ${active}`);
      if (active === "active") {
        Bun.spawnSync(["systemctl", "status", "pai-sync", "--no-pager", "-l", "--lines=20"], { stdout: "inherit", stderr: "inherit" });
      }
      break;
    }
    default:
      console.error("Usage: pai-sync daemon start|stop|status");
      process.exit(1);
  }
}

// ============================================================
// Help
// ============================================================

function printHelp(): void {
  console.log(`
pai-sync — PAI Memory Sync CLI

Usage:
  pai-sync push              Push all dirty files to Postgres (bypass debounce)
  pai-sync pull              Restore filesystem from Postgres
  pai-sync status            Show diff: local-only, remote-only, modified
  pai-sync status --verbose  Include all file paths

  pai-sync history <key>           Show all versions of a file
  pai-sync restore <key>           Restore a soft-deleted file
  pai-sync restore <key> --version N  Restore a specific historical version
  pai-sync diff <key> [v1] [v2]    Show version metadata for a file

  pai-sync backfill          Run initial bulk upload (background-friendly)

  pai-sync daemon start      Start the sync daemon (via systemctl)
  pai-sync daemon stop       Stop the sync daemon
  pai-sync daemon status     Check daemon health

Environment:
  POSTGRES_URL               Postgres connection string (required)
                             Set by Ansible from BWS in /etc/pai-sync/env
  PAI_SYNC_WATCH_ROOT        Watch root (default: /pai/memory)
  PAI_SYNC_MACHINE_ID        Machine identifier (default: hostname)
`);
}
