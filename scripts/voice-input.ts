#!/usr/bin/env bun
/**
 * Voice Input — Local STT daemon for Aurora
 * Decision 43: Voice I/O via local Aurora daemon
 *
 * Records audio from PipeWire microphone, sends to ElevenLabs Scribe
 * (proxied through voice server), and outputs transcribed text.
 *
 * Activation modes:
 *   1. Named pipe: echo "start" > /tmp/voice-input-trigger (toggle recording)
 *   2. One-shot:   VOICE_INPUT_MODE=oneshot bun run voice-input.ts
 *
 * Output: Transcribed text is written to stdout, one utterance per line.
 * This allows piping to other tools or direct use in scripts.
 *
 * Usage:
 *   bun run voice-input.ts                    # Daemon mode (named pipe trigger)
 *   VOICE_INPUT_MODE=oneshot bun run voice-input.ts  # Record once, transcribe, exit
 */

import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync, unlinkSync, watch } from "fs";
import { join } from "path";

const VOICE_SERVER = process.env.VOICE_SERVER || "http://localhost:8888";
const TRIGGER_PIPE = process.env.VOICE_INPUT_TRIGGER || "/tmp/voice-input-trigger";
const AUDIO_DIR = process.env.VOICE_INPUT_AUDIO_DIR || "/tmp/voice-input-audio";
const MODE = process.env.VOICE_INPUT_MODE || "daemon";
const MAX_RECORD_SECONDS = parseInt(process.env.MAX_RECORD_SECONDS || "30");
const SILENCE_TIMEOUT_MS = parseInt(process.env.SILENCE_TIMEOUT_MS || "3000");

mkdirSync(AUDIO_DIR, { recursive: true });

let isRecording = false;
let recordProc: Subprocess | null = null;
let currentRecordPath: string | null = null;
let isShuttingDown = false;
let recordTimeout: ReturnType<typeof setTimeout> | null = null;

// ==========================================================================
// Logging
// ==========================================================================

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.error(`[${ts}] ${msg}`);
}

function logError(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.error(`[${ts}] ERROR: ${msg}`);
}

// ==========================================================================
// Audio Recording via pw-record
// ==========================================================================

async function startRecording(): Promise<void> {
  if (isRecording) {
    log("Already recording — stopping current recording");
    await stopRecording();
    return;
  }

  const recordId = `input-${Date.now()}`;
  currentRecordPath = join(AUDIO_DIR, `${recordId}.wav`);

  log("Recording started — speak now");

  // Feedback beep (short sine wave via pw-play)
  try {
    const beep = spawn(["bash", "-c",
      "python3 -c \"import struct,math;f=open('/tmp/beep.wav','wb');f.write(b'RIFF');d=b''.join(struct.pack('<h',int(16000*math.sin(2*math.pi*880*i/48000)))for i in range(4800));f.write(struct.pack('<I',36+len(d)));f.write(b'WAVEfmt ');f.write(struct.pack('<IHHIIHH',16,1,1,48000,96000,2,16));f.write(b'data');f.write(struct.pack('<I',len(d)));f.write(d);f.close()\" && pw-play /tmp/beep.wav"
    ], { stdout: "ignore", stderr: "ignore" });
    await beep.exited;
  } catch { /* no beep is fine */ }

  recordProc = spawn(["pw-record", "--format", "s16", "--rate", "16000", "--channels", "1", currentRecordPath], {
    stdout: "ignore",
    stderr: "ignore",
  });

  isRecording = true;

  // Auto-stop after MAX_RECORD_SECONDS
  recordTimeout = setTimeout(async () => {
    if (isRecording) {
      log(`Max recording time (${MAX_RECORD_SECONDS}s) reached — auto-stopping`);
      await stopRecording();
    }
  }, MAX_RECORD_SECONDS * 1000);
}

async function stopRecording(): Promise<void> {
  if (!isRecording || !recordProc) return;

  if (recordTimeout) {
    clearTimeout(recordTimeout);
    recordTimeout = null;
  }

  // Send SIGINT to pw-record to stop cleanly
  recordProc.kill("SIGINT");
  await recordProc.exited;
  recordProc = null;
  isRecording = false;

  log("Recording stopped");

  // Stop feedback beep
  try {
    const beep = spawn(["bash", "-c",
      "python3 -c \"import struct,math;f=open('/tmp/beep2.wav','wb');f.write(b'RIFF');d=b''.join(struct.pack('<h',int(16000*math.sin(2*math.pi*440*i/48000)))for i in range(2400));f.write(struct.pack('<I',36+len(d)));f.write(b'WAVEfmt ');f.write(struct.pack('<IHHIIHH',16,1,1,48000,96000,2,16));f.write(b'data');f.write(struct.pack('<I',len(d)));f.write(d);f.close()\" && pw-play /tmp/beep2.wav"
    ], { stdout: "ignore", stderr: "ignore" });
    await beep.exited;
  } catch { /* no beep is fine */ }

  if (currentRecordPath && existsSync(currentRecordPath)) {
    await transcribeAndOutput(currentRecordPath);
  }
}

// ==========================================================================
// Transcription via Voice Server (proxied to ElevenLabs Scribe)
// ==========================================================================

async function transcribeAndOutput(audioPath: string): Promise<void> {
  log(`Transcribing: ${audioPath}`);

  try {
    const file = Bun.file(audioPath);
    const fileSize = file.size;

    if (fileSize < 1000) {
      log("Audio too short — skipping transcription");
      unlinkSync(audioPath);
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    const resp = await fetch(`${VOICE_SERVER}/transcribe`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      logError(`Transcription failed: ${resp.status} — ${errText}`);
      unlinkSync(audioPath);
      return;
    }

    const result = await resp.json() as { text?: string; status?: string };
    const text = result.text?.trim();

    if (text && text.length > 0) {
      // Output transcribed text to stdout (for piping to other tools)
      console.log(text);
      log(`Transcribed: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);
    } else {
      log("No speech detected");
    }
  } catch (e: any) {
    logError(`Transcription error: ${e.message}`);
  } finally {
    try { unlinkSync(audioPath); } catch { /* ignore */ }
  }
}

// ==========================================================================
// Named Pipe Trigger
// ==========================================================================

async function setupTriggerPipe(): Promise<void> {
  // Create named pipe if it doesn't exist
  if (!existsSync(TRIGGER_PIPE)) {
    const proc = spawn(["mkfifo", TRIGGER_PIPE], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    log(`Created trigger pipe: ${TRIGGER_PIPE}`);
  }

  log(`Listening on trigger pipe: ${TRIGGER_PIPE}`);
  log(`Toggle recording: echo toggle > ${TRIGGER_PIPE}`);
  log(`Start recording:  echo start > ${TRIGGER_PIPE}`);
  log(`Stop recording:   echo stop > ${TRIGGER_PIPE}`);

  // Read from pipe in a loop
  while (!isShuttingDown) {
    try {
      const file = Bun.file(TRIGGER_PIPE);
      const text = await file.text();
      const command = text.trim().toLowerCase();

      if (command === "start" || command === "toggle") {
        if (isRecording) {
          await stopRecording();
        } else {
          await startRecording();
        }
      } else if (command === "stop") {
        if (isRecording) {
          await stopRecording();
        }
      }
    } catch (e: any) {
      if (!isShuttingDown) {
        // Brief pause before retrying pipe read
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
}

// ==========================================================================
// One-shot Mode
// ==========================================================================

async function oneshotMode(): Promise<void> {
  log("One-shot mode — recording for up to " + MAX_RECORD_SECONDS + "s (Ctrl+C to stop)");

  await startRecording();

  // Wait for SIGINT or timeout
  await new Promise<void>(resolve => {
    const check = setInterval(() => {
      if (!isRecording || isShuttingDown) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });

  if (isRecording) {
    await stopRecording();
  }
}

// ==========================================================================
// Signal Handling & Main
// ==========================================================================

process.on("SIGINT", async () => {
  log("Received SIGINT — shutting down");
  isShuttingDown = true;
  if (isRecording) await stopRecording();
});

process.on("SIGTERM", async () => {
  log("Received SIGTERM — shutting down");
  isShuttingDown = true;
  if (isRecording) await stopRecording();
});

// Main
log(`Voice input starting — server: ${VOICE_SERVER}, mode: ${MODE}`);

if (MODE === "oneshot") {
  await oneshotMode();
} else {
  await setupTriggerPipe();
}
