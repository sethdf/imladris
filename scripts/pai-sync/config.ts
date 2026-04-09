// ============================================================
// config.ts — daemon and CLI configuration
// All secrets come from environment variables set by Ansible
// ============================================================

const HOME = process.env.HOME ?? "/home/ec2-user";

export const config = {
  // Watch root: ~/.claude/MEMORY on host (pre-Docker-Modular)
  // Changes to /pai/memory after Docker-Modular ships (v2.4.0+)
  watchRoot: process.env.PAI_SYNC_WATCH_ROOT ?? `${HOME}/.claude/MEMORY`,

  // Additional watch paths — synced to memory_objects alongside MEMORY/
  // Conversation transcripts live here (2,770 .jsonl files, 662MB)
  extraWatchPaths: (process.env.PAI_SYNC_EXTRA_WATCH ?? `${HOME}/.claude/projects`).split(",").filter(Boolean),

  // PAI methodology root: ~/.claude/PAI/ — synced to pai_system table
  // Includes Algorithm, steering rules, principles, system architecture
  paiRoot: process.env.PAI_SYNC_PAI_ROOT ?? `${HOME}/.claude/PAI`,

  // Agent personas: ~/.claude/skills/Agents/ — synced to pai_system table
  agentsRoot: process.env.PAI_SYNC_AGENTS_ROOT ?? `${HOME}/.claude/skills/Agents`,

  // TELOS: ~/.claude/PAI/USER/TELOS/ — synced to pai_system table
  telosRoot: process.env.PAI_SYNC_TELOS_ROOT ?? `${HOME}/.claude/PAI/USER/TELOS`,

  // Postgres connection URL — set by Ansible from BWS, written to /etc/pai-sync/env
  postgresUrl: process.env.POSTGRES_URL ?? "",

  // Stable identifier for this machine (hostname by default)
  machineId: process.env.PAI_SYNC_MACHINE_ID ?? process.env.HOSTNAME ?? "unknown",

  // Debounce: push after this many ms of quiet (5 seconds)
  debounceMs: parseInt(process.env.PAI_SYNC_DEBOUNCE_MS ?? "5000"),

  // Max wait: force push after this many ms regardless of activity (30 seconds)
  maxWaitMs: parseInt(process.env.PAI_SYNC_MAX_WAIT_MS ?? "30000"),

  // Large file threshold: gzip files above this size (100KB)
  compressThresholdBytes: parseInt(process.env.PAI_SYNC_COMPRESS_THRESHOLD ?? "102400"),

  // Chunk size for very large files after compression (50MB per chunk)
  chunkSizeBytes: parseInt(process.env.PAI_SYNC_CHUNK_SIZE ?? "52428800"),

  // WAL location — inside STATE/ which is excluded from sync (avoids recursion)
  walPath: process.env.PAI_SYNC_WAL_PATH ??
    `${process.env.HOME ?? "/home/ec2-user"}/.claude/MEMORY/STATE/sync-wal.jsonl`,

  // Sync log location — machine-local operational data, excluded from sync
  syncLogPath: process.env.PAI_SYNC_LOG_PATH ??
    `${process.env.HOME ?? "/home/ec2-user"}/.claude/MEMORY/STATE/sync-log.jsonl`,

  // systemd watchdog timeout (seconds) — daemon pings sd_notify
  watchdogSec: parseInt(process.env.WATCHDOG_USEC ?? "0") / 1_000_000 || 60,
} as const;

export function validateConfig(): void {
  if (!config.postgresUrl) {
    throw new Error(
      "POSTGRES_URL is not set. Add it to /etc/pai-sync/env via Ansible."
    );
  }
}
