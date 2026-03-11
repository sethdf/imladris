#!/usr/bin/env bun
/**
 * Voice Client — Local TTS playback daemon for Aurora
 * Decision 43: Voice I/O via local Aurora daemon
 *
 * Polls the voice server (EC2 via SSH tunnel) for new TTS audio and
 * auto-plays it via PipeWire. Runs as a systemd user service.
 *
 * The voice server generates audio IDs like "voice-1710000000000".
 * We track the last-played ID and only play newer ones.
 *
 * Usage:
 *   bun run voice-client.ts              # Start daemon
 *   VOICE_SERVER=host:port bun run voice-client.ts  # Custom server
 *   POLL_INTERVAL=2000 bun run voice-client.ts      # 2s poll interval
 */

import { spawn } from "bun";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";

const VOICE_SERVER = process.env.VOICE_SERVER || "http://localhost:8888";
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "5000");
const AUDIO_DIR = process.env.VOICE_CLIENT_AUDIO_DIR || "/tmp/voice-client-audio";
const MAX_LOCAL_FILES = 20;

// Ensure audio directory exists
mkdirSync(AUDIO_DIR, { recursive: true });

let lastPlayedId: string | null = null;
let isPlaying = false;
let isShuttingDown = false;
let serverAvailable = true;
let consecutiveFailures = 0;
const MAX_BACKOFF_MS = 30000;
const HEALTH_CHECK_INTERVAL = 30000; // Check health every 30s, not every poll
let lastHealthCheck = 0;

// ==========================================================================
// Logging
// ==========================================================================

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${msg}`);
}

function logError(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.error(`[${ts}] ERROR: ${msg}`);
}

// ==========================================================================
// Audio Playback
// ==========================================================================

async function playAudio(filePath: string): Promise<void> {
  isPlaying = true;
  try {
    const proc = spawn(["pw-play", filePath], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      logError(`pw-play exited ${exitCode}: ${stderr.trim()}`);
    }
  } finally {
    isPlaying = false;
    // Clean up played file
    try { unlinkSync(filePath); } catch { /* ignore */ }
  }
}

function pruneLocalAudio(): void {
  try {
    const { readdirSync, statSync } = require("fs");
    const files = readdirSync(AUDIO_DIR)
      .filter((f: string) => f.endsWith(".mp3"))
      .map((f: string) => ({ name: f, time: statSync(join(AUDIO_DIR, f)).mtimeMs }))
      .sort((a: any, b: any) => b.time - a.time);

    for (const f of files.slice(MAX_LOCAL_FILES)) {
      unlinkSync(join(AUDIO_DIR, f.name));
    }
  } catch { /* ignore */ }
}

// ==========================================================================
// Server Communication
// ==========================================================================

async function checkHealth(): Promise<boolean> {
  try {
    const resp = await fetch(`${VOICE_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      if (!serverAvailable) {
        log("Voice server reconnected");
        serverAvailable = true;
        consecutiveFailures = 0;
      }
      return true;
    }
    return false;
  } catch {
    if (serverAvailable) {
      log("Voice server unavailable — will retry");
      serverAvailable = false;
    }
    return false;
  }
}

async function getLatestAudioId(): Promise<string | null> {
  try {
    // Use redirect: manual on /audio/latest to get the redirect location without downloading
    const resp = await fetch(`${VOICE_SERVER}/audio/latest`, {
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });

    if (resp.status === 302) {
      const location = resp.headers.get("location");
      if (location) {
        // Location is like "/audio/voice-1710000000000"
        return location.replace("/audio/", "");
      }
    }

    if (resp.status === 404) {
      // No audio available yet
      return null;
    }

    if (resp.status === 429) {
      // Rate limited — back off
      if (consecutiveFailures < 3) consecutiveFailures = 3; // force backoff
      log("Rate limited by server — backing off");
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

async function downloadAudio(audioId: string): Promise<string | null> {
  try {
    const resp = await fetch(`${VOICE_SERVER}/audio/${audioId}`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      logError(`Failed to download ${audioId}: ${resp.status}`);
      return null;
    }

    const buffer = await resp.arrayBuffer();
    const filePath = join(AUDIO_DIR, `${audioId}.mp3`);
    await Bun.write(filePath, buffer);
    return filePath;
  } catch (e: any) {
    logError(`Download failed for ${audioId}: ${e.message}`);
    return null;
  }
}

// ==========================================================================
// Main Poll Loop
// ==========================================================================

async function pollOnce(): Promise<void> {
  if (isPlaying || isShuttingDown) return;

  // Periodic health check (not every poll — saves rate limit budget)
  const now = Date.now();
  if (!serverAvailable || now - lastHealthCheck > HEALTH_CHECK_INTERVAL) {
    const healthy = await checkHealth();
    lastHealthCheck = now;
    if (!healthy) {
      consecutiveFailures++;
      return;
    }
  }

  const latestId = await getLatestAudioId();
  if (!latestId) {
    // Server returned 404 or error — not a failure, just no audio yet
    return;
  }
  if (latestId === lastPlayedId) return;

  // New audio available
  log(`New audio: ${latestId}`);
  const filePath = await downloadAudio(latestId);
  if (!filePath) return;

  lastPlayedId = latestId;
  log(`Playing: ${latestId}`);
  await playAudio(filePath);
  pruneLocalAudio();
}

function getBackoffInterval(): number {
  if (consecutiveFailures <= 0) return POLL_INTERVAL;
  // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at MAX_BACKOFF_MS
  return Math.min(POLL_INTERVAL * Math.pow(2, consecutiveFailures), MAX_BACKOFF_MS);
}

async function mainLoop(): Promise<void> {
  log(`Voice client starting — server: ${VOICE_SERVER}, poll: ${POLL_INTERVAL}ms`);
  log(`Audio dir: ${AUDIO_DIR}`);

  // Initial health check
  const healthy = await checkHealth();
  if (healthy) {
    // Get current latest so we don't replay old audio on startup
    lastPlayedId = await getLatestAudioId();
    if (lastPlayedId) {
      log(`Skipping existing audio: ${lastPlayedId}`);
    }
    log("Connected to voice server — listening for new audio");
  } else {
    log("Voice server not available — will retry");
  }

  while (!isShuttingDown) {
    try {
      await pollOnce();
    } catch (e: any) {
      logError(`Poll error: ${e.message}`);
    }

    const interval = getBackoffInterval();
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  log("Voice client stopped");
}

// ==========================================================================
// Signal Handling
// ==========================================================================

process.on("SIGINT", () => {
  log("Received SIGINT — shutting down");
  isShuttingDown = true;
});

process.on("SIGTERM", () => {
  log("Received SIGTERM — shutting down");
  isShuttingDown = true;
});

// Start
mainLoop();
