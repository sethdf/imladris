#!/usr/bin/env bun
/**
 * Voice Server — Unified PAI TTS/STT server
 * Decision 43: Voice I/O via local Aurora daemon
 *
 * Architecture: Pure pass-through. All voice config comes from settings.json.
 * The server has zero hardcoded voice parameters.
 *
 * Platform detection:
 *   Desktop (WAYLAND_DISPLAY/DISPLAY or macOS): play audio locally + store for /audio/:id
 *   Headless (EC2/server): store audio only, serve via /audio/:id for remote clients
 *
 * Config resolution (3-tier):
 *   1. Caller sends voice_settings in request body → use directly (pass-through)
 *   2. Caller sends voice_id → look up in settings.json daidentity.voices → use those settings
 *   3. Neither → use settings.json daidentity.voices.main as default
 *
 * Pronunciation preprocessing: loads pronunciations.json and applies
 * word-boundary replacements before sending text to ElevenLabs TTS.
 *
 * Endpoints:
 *   POST /notify            — Generate TTS, play locally (desktop) and/or store
 *   POST /notify/personality — Compatibility shim
 *   POST /pai               — PAI notification shim
 *   POST /transcribe         — STT via ElevenLabs Scribe v2
 *   GET  /audio/:id          — Serve generated MP3 audio
 *   GET  /audio/latest       — Redirect to most recent audio
 *   GET  /health             — Server status
 */

import { serve } from "bun";
import { spawn } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from "fs";

// ==========================================================================
// Platform Detection
// ==========================================================================

const IS_LINUX = process.platform === "linux";
const IS_MACOS = process.platform === "darwin";
const IS_DESKTOP = IS_MACOS || !!(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);
const AUDIO_PLAYER = IS_LINUX ? "pw-play" : "/usr/bin/afplay";

// ==========================================================================
// Environment & Config
// ==========================================================================

// Load .env from user home directory (fallback when env vars not set by systemd)
const envPath = join(homedir(), ".env");
if (existsSync(envPath)) {
  const envContent = await Bun.file(envPath).text();
  envContent.split("\n").forEach((line) => {
    const [key, value] = line.split("=");
    if (key && value && !key.startsWith("#")) {
      // Don't overwrite existing env vars (systemd EnvironmentFile takes precedence)
      if (!process.env[key.trim()]) {
        process.env[key.trim()] = value.trim();
      }
    }
  });
}

const PORT = parseInt(process.env.VOICE_SERVER_PORT || process.env.PORT || "8888");
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const AUDIO_DIR = process.env.VOICE_AUDIO_DIR || "/tmp/voice-audio";
const MAX_AUDIO_FILES = 50;

// Ensure audio directory exists
mkdirSync(AUDIO_DIR, { recursive: true });

if (!ELEVENLABS_API_KEY) {
  console.error("ELEVENLABS_API_KEY not found in env or ~/.env");
  console.error("Add: ELEVENLABS_API_KEY=your_key_here");
}

// ==========================================================================
// Pronunciation System
// ==========================================================================

interface PronunciationEntry {
  term: string;
  phonetic: string;
  note?: string;
}

interface CompiledRule {
  regex: RegExp;
  phonetic: string;
}

let pronunciationRules: CompiledRule[] = [];

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadPronunciations(): void {
  const pronPath = join(import.meta.dir, "pronunciations.json");
  try {
    if (!existsSync(pronPath)) {
      console.warn("No pronunciations.json found — TTS will use default pronunciations");
      return;
    }
    const content = readFileSync(pronPath, "utf-8");
    const config = JSON.parse(content);
    pronunciationRules = (config.replacements || []).map((entry: PronunciationEntry) => ({
      regex: new RegExp(`\\b${escapeRegex(entry.term)}\\b`, "g"),
      phonetic: entry.phonetic,
    }));
    console.log(`Loaded ${pronunciationRules.length} pronunciation rules`);
    for (const entry of config.replacements || []) {
      console.log(`   ${entry.term} → ${entry.phonetic} (${entry.note || ""})`);
    }
  } catch (error) {
    console.error("Failed to load pronunciations.json:", error);
  }
}

function applyPronunciations(text: string): string {
  let result = text;
  for (const rule of pronunciationRules) {
    result = result.replace(rule.regex, rule.phonetic);
  }
  return result;
}

loadPronunciations();

// ==========================================================================
// Voice Configuration — Single Source of Truth: settings.json
// ==========================================================================

interface ElevenLabsVoiceSettings {
  stability: number;
  similarity_boost: number;
  style?: number;
  speed?: number;
  use_speaker_boost?: boolean;
}

interface VoiceEntry {
  voiceId: string;
  voiceName?: string;
  stability: number;
  similarity_boost: number;
  style: number;
  speed: number;
  use_speaker_boost: boolean;
  volume: number;
}

interface LoadedVoiceConfig {
  defaultVoiceId: string;
  voices: Record<string, VoiceEntry>;
  voicesByVoiceId: Record<string, VoiceEntry>;
  desktopNotifications: boolean;
}

const FALLBACK_VOICE_SETTINGS: ElevenLabsVoiceSettings = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.0,
  speed: 1.0,
  use_speaker_boost: true,
};
const FALLBACK_VOLUME = 1.0;

function loadVoiceConfig(): LoadedVoiceConfig {
  const settingsPath = join(homedir(), ".claude", "settings.json");

  try {
    if (!existsSync(settingsPath)) {
      console.warn("settings.json not found — using fallback voice defaults");
      return { defaultVoiceId: "", voices: {}, voicesByVoiceId: {}, desktopNotifications: true };
    }

    const content = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(content);
    const daidentity = settings.daidentity || {};
    const voicesSection = daidentity.voices || {};
    const desktopNotifications = settings.notifications?.desktop?.enabled !== false;

    const voices: Record<string, VoiceEntry> = {};
    const voicesByVoiceId: Record<string, VoiceEntry> = {};

    for (const [name, config] of Object.entries(voicesSection)) {
      const entry = config as any;
      if (entry.voiceId) {
        const voiceEntry: VoiceEntry = {
          voiceId: entry.voiceId,
          voiceName: entry.voiceName,
          stability: entry.stability ?? 0.5,
          similarity_boost: entry.similarity_boost ?? entry.similarityBoost ?? 0.75,
          style: entry.style ?? 0.0,
          speed: entry.speed ?? 1.0,
          use_speaker_boost: entry.use_speaker_boost ?? entry.useSpeakerBoost ?? true,
          volume: entry.volume ?? 1.0,
        };
        voices[name] = voiceEntry;
        voicesByVoiceId[entry.voiceId] = voiceEntry;
      }
    }

    const defaultVoiceId = voices.main?.voiceId || daidentity.mainDAVoiceID || "";
    console.log(`Loaded ${Object.keys(voices).length} voice config(s): ${Object.keys(voices).join(", ")}`);
    for (const [name, entry] of Object.entries(voices)) {
      console.log(`   ${name}: ${entry.voiceName || entry.voiceId} (speed: ${entry.speed}, stability: ${entry.stability})`);
    }

    return { defaultVoiceId, voices, voicesByVoiceId, desktopNotifications };
  } catch (error) {
    console.error("Failed to load settings.json voice config:", error);
    return { defaultVoiceId: "", voices: {}, voicesByVoiceId: {}, desktopNotifications: true };
  }
}

const voiceConfig = loadVoiceConfig();
const DEFAULT_VOICE_ID =
  voiceConfig.defaultVoiceId || process.env.ELEVENLABS_VOICE_ID || "s3TPKV1kjDlVtZbl4Ksh";

function lookupVoiceByVoiceId(voiceId: string): VoiceEntry | null {
  return voiceConfig.voicesByVoiceId[voiceId] || null;
}

function voiceEntryToSettings(entry: VoiceEntry): ElevenLabsVoiceSettings {
  return {
    stability: entry.stability,
    similarity_boost: entry.similarity_boost,
    style: entry.style,
    speed: entry.speed,
    use_speaker_boost: entry.use_speaker_boost,
  };
}

// ==========================================================================
// Emotional Presets — 13 Emotional Overlays
// ==========================================================================

interface EmotionalOverlay {
  stability: number;
  similarity_boost: number;
}

const EMOTIONAL_PRESETS: Record<string, EmotionalOverlay> = {
  excited: { stability: 0.7, similarity_boost: 0.9 },
  celebration: { stability: 0.65, similarity_boost: 0.85 },
  insight: { stability: 0.55, similarity_boost: 0.8 },
  creative: { stability: 0.5, similarity_boost: 0.75 },
  success: { stability: 0.6, similarity_boost: 0.8 },
  progress: { stability: 0.55, similarity_boost: 0.75 },
  investigating: { stability: 0.6, similarity_boost: 0.85 },
  debugging: { stability: 0.55, similarity_boost: 0.8 },
  learning: { stability: 0.5, similarity_boost: 0.75 },
  pondering: { stability: 0.65, similarity_boost: 0.8 },
  focused: { stability: 0.7, similarity_boost: 0.85 },
  caution: { stability: 0.4, similarity_boost: 0.6 },
  urgent: { stability: 0.3, similarity_boost: 0.9 },
};

// ==========================================================================
// Input Sanitization & Validation
// ==========================================================================

function escapeForAppleScript(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function extractEmotionalMarker(message: string): { cleaned: string; emotion?: string } {
  const emojiToEmotion: Record<string, string> = {
    "\u{1F4A5}": "excited",
    "\u{1F389}": "celebration",
    "\u{1F4A1}": "insight",
    "\u{1F3A8}": "creative",
    "\u{2728}": "success",
    "\u{1F4C8}": "progress",
    "\u{1F50D}": "investigating",
    "\u{1F41B}": "debugging",
    "\u{1F4DA}": "learning",
    "\u{1F914}": "pondering",
    "\u{1F3AF}": "focused",
    "\u{26A0}\u{FE0F}": "caution",
    "\u{1F6A8}": "urgent",
  };

  const emotionMatch = message.match(
    /\[(\u{1F4A5}|\u{1F389}|\u{1F4A1}|\u{1F3A8}|\u{2728}|\u{1F4C8}|\u{1F50D}|\u{1F41B}|\u{1F4DA}|\u{1F914}|\u{1F3AF}|\u{26A0}\u{FE0F}|\u{1F6A8})\s+(\w+)\]/u,
  );
  if (emotionMatch) {
    const emoji = emotionMatch[1];
    const emotionName = emotionMatch[2].toLowerCase();
    if (emojiToEmotion[emoji] === emotionName) {
      return {
        cleaned: message.replace(emotionMatch[0], "").trim(),
        emotion: emotionName,
      };
    }
  }

  return { cleaned: message };
}

function sanitizeForSpeech(input: string): string {
  return input
    .replace(/<script/gi, "")
    .replace(/\.\.\//g, "")
    .replace(/[;&|><`$\\]/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/#{1,6}\s+/g, "")
    .trim()
    .substring(0, 500);
}

function validateInput(input: any): { valid: boolean; error?: string; sanitized?: string } {
  if (!input || typeof input !== "string") {
    return { valid: false, error: "Invalid input type" };
  }
  if (input.length > 500) {
    return { valid: false, error: "Message too long (max 500 characters)" };
  }
  const sanitized = sanitizeForSpeech(input);
  if (!sanitized || sanitized.length === 0) {
    return { valid: false, error: "Message contains no valid content after sanitization" };
  }
  return { valid: true, sanitized };
}

// ==========================================================================
// Audio Management (for /audio/:id serving)
// ==========================================================================

let latestAudioId: string | null = null;

function pruneAudioDir(): void {
  try {
    const files = readdirSync(AUDIO_DIR)
      .filter((f) => f.endsWith(".mp3"))
      .map((f) => ({ name: f, time: statSync(join(AUDIO_DIR, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    for (const f of files.slice(MAX_AUDIO_FILES)) {
      unlinkSync(join(AUDIO_DIR, f.name));
    }
  } catch {
    /* ignore */
  }
}

// ==========================================================================
// TTS Generation
// ==========================================================================

async function generateSpeech(
  text: string,
  voiceId: string,
  voiceSettings: ElevenLabsVoiceSettings,
): Promise<ArrayBuffer> {
  if (!ELEVENLABS_API_KEY) {
    throw new Error("ElevenLabs API key not configured");
  }

  const pronouncedText = applyPronunciations(text);
  if (pronouncedText !== text) {
    console.log(`Pronunciation: "${text}" → "${pronouncedText}"`);
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "audio/mpeg",
      "Content-Type": "application/json",
      "xi-api-key": ELEVENLABS_API_KEY,
    },
    body: JSON.stringify({
      text: pronouncedText,
      model_id: "eleven_turbo_v2_5",
      voice_settings: voiceSettings,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
  }

  return await response.arrayBuffer();
}

// ==========================================================================
// Local Audio Playback (desktop mode only)
// ==========================================================================

function spawnSafe(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    proc.on("error", (error) => {
      console.error(`Error spawning ${command}:`, error);
      reject(error);
    });
    proc.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

async function playAudioLocally(
  audioBuffer: ArrayBuffer,
  volume: number = FALLBACK_VOLUME,
): Promise<void> {
  const tempFile = `/tmp/voice-${Date.now()}.mp3`;
  await Bun.write(tempFile, audioBuffer);

  return new Promise((resolve, reject) => {
    const args = IS_LINUX
      ? ["--volume", Math.min(volume, 1.0).toString(), tempFile]
      : ["-v", volume.toString(), tempFile];

    const proc = spawn(AUDIO_PLAYER, args);

    proc.on("error", (error) => {
      console.error(`Error playing audio with ${AUDIO_PLAYER}:`, error);
      reject(error);
    });

    proc.on("exit", (code) => {
      spawn("/bin/rm", [tempFile]);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${AUDIO_PLAYER} exited with code ${code}`));
      }
    });
  });
}

// ==========================================================================
// Core: Send notification with 3-tier voice settings resolution
// ==========================================================================

async function sendNotification(
  title: string,
  message: string,
  voiceEnabled = true,
  voiceId: string | null = null,
  callerVoiceSettings?: Partial<ElevenLabsVoiceSettings> | null,
  callerVolume?: number | null,
): Promise<{
  voicePlayed: boolean;
  voiceError?: string;
  audio_id?: string;
  audio_url?: string;
}> {
  const titleValidation = validateInput(title);
  const messageValidation = validateInput(message);

  if (!titleValidation.valid) {
    throw new Error(`Invalid title: ${titleValidation.error}`);
  }
  if (!messageValidation.valid) {
    throw new Error(`Invalid message: ${messageValidation.error}`);
  }

  const safeTitle = titleValidation.sanitized!;
  let safeMessage = messageValidation.sanitized!;

  const { cleaned, emotion } = extractEmotionalMarker(safeMessage);
  safeMessage = cleaned;

  let voicePlayed = false;
  let voiceError: string | undefined;
  let audioId: string | undefined;
  let audioUrl: string | undefined;

  if (voiceEnabled && ELEVENLABS_API_KEY) {
    try {
      const voice = voiceId || DEFAULT_VOICE_ID;

      // 3-tier voice settings resolution
      let resolvedSettings: ElevenLabsVoiceSettings;
      let resolvedVolume: number;

      if (callerVoiceSettings && Object.keys(callerVoiceSettings).length > 0) {
        // Tier 1: Caller provided explicit voice_settings → pass through
        resolvedSettings = {
          stability: callerVoiceSettings.stability ?? FALLBACK_VOICE_SETTINGS.stability,
          similarity_boost:
            callerVoiceSettings.similarity_boost ?? FALLBACK_VOICE_SETTINGS.similarity_boost,
          style: callerVoiceSettings.style ?? FALLBACK_VOICE_SETTINGS.style,
          speed: callerVoiceSettings.speed ?? FALLBACK_VOICE_SETTINGS.speed,
          use_speaker_boost:
            callerVoiceSettings.use_speaker_boost ?? FALLBACK_VOICE_SETTINGS.use_speaker_boost,
        };
        resolvedVolume = callerVolume ?? FALLBACK_VOLUME;
        console.log("Voice settings: pass-through from caller");
      } else {
        // Tier 2/3: Look up by voiceId, fall back to main
        const voiceEntry = lookupVoiceByVoiceId(voice) || voiceConfig.voices.main;
        if (voiceEntry) {
          resolvedSettings = voiceEntryToSettings(voiceEntry);
          resolvedVolume = callerVolume ?? voiceEntry.volume ?? FALLBACK_VOLUME;
          console.log(
            `Voice settings: from settings.json (${voiceEntry.voiceName || voice})`,
          );
        } else {
          resolvedSettings = { ...FALLBACK_VOICE_SETTINGS };
          resolvedVolume = callerVolume ?? FALLBACK_VOLUME;
          console.log(`Voice settings: fallback defaults (no config found for ${voice})`);
        }
      }

      // Emotional preset overlay — modifies stability + similarity_boost only
      if (emotion && EMOTIONAL_PRESETS[emotion]) {
        resolvedSettings = {
          ...resolvedSettings,
          stability: EMOTIONAL_PRESETS[emotion].stability,
          similarity_boost: EMOTIONAL_PRESETS[emotion].similarity_boost,
        };
        console.log(`Emotion overlay: ${emotion}`);
      }

      console.log(
        `Generating speech (voice: ${voice}, speed: ${resolvedSettings.speed}, stability: ${resolvedSettings.stability}, volume: ${resolvedVolume})`,
      );

      const audioBuffer = await generateSpeech(safeMessage, voice, resolvedSettings);

      // Always store audio for /audio/:id serving
      audioId = `voice-${Date.now()}`;
      const audioPath = join(AUDIO_DIR, `${audioId}.mp3`);
      await Bun.write(audioPath, audioBuffer);
      latestAudioId = audioId;
      audioUrl = `/audio/${audioId}`;
      pruneAudioDir();

      console.log(
        `TTS: "${safeMessage.slice(0, 60)}..." → ${audioId}.mp3 (${audioBuffer.byteLength} bytes)`,
      );

      // On desktop: also play locally
      if (IS_DESKTOP) {
        await playAudioLocally(audioBuffer, resolvedVolume);
      }

      voicePlayed = true;
    } catch (error: any) {
      console.error("Failed to generate/play speech:", error);
      voiceError = error.message || "TTS generation failed";
    }
  }

  // Display desktop notification (desktop mode only)
  if (IS_DESKTOP && voiceConfig.desktopNotifications) {
    try {
      if (IS_LINUX) {
        await spawnSafe("notify-send", [safeTitle, safeMessage]);
      } else {
        const escapedTitle = escapeForAppleScript(safeTitle);
        const escapedMessage = escapeForAppleScript(safeMessage);
        const script = `display notification "${escapedMessage}" with title "${escapedTitle}" sound name ""`;
        await spawnSafe("/usr/bin/osascript", ["-e", script]);
      }
    } catch (error) {
      console.error("Notification display error:", error);
    }
  }

  return { voicePlayed, voiceError, audio_id: audioId, audio_url: audioUrl };
}

// ==========================================================================
// Rate Limiting
// ==========================================================================

const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 120;
const RATE_WINDOW = 60000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = requestCounts.get(ip);

  if (!record || now > record.resetTime) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
    return true;
  }

  if (record.count >= RATE_LIMIT) {
    return false;
  }

  record.count++;
  return true;
}

// ==========================================================================
// HTTP Server
// ==========================================================================

const server = serve({
  port: PORT,
  hostname: "127.0.0.1",

  async fetch(req) {
    const url = new URL(req.url);
    const clientIp = req.headers.get("x-forwarded-for") || "localhost";

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders, status: 204 });
    }

    if (!checkRateLimit(clientIp)) {
      return Response.json(
        { status: "error", message: "Rate limit exceeded" },
        { status: 429, headers: corsHeaders },
      );
    }

    // POST /notify — main TTS endpoint
    if (url.pathname === "/notify" && req.method === "POST") {
      try {
        const data = await req.json();
        const title = data.title || "PAI Notification";
        const message = data.message || "Task completed";
        const voiceEnabled = data.voice_enabled !== false;
        const voiceId = data.voice_id || data.voice_name || null;
        const voiceSettings = data.voice_settings || null;
        const volume = data.volume ?? null;

        if (voiceId && typeof voiceId !== "string") {
          throw new Error("Invalid voice_id");
        }

        console.log(
          `Notification: "${title}" - "${message}" (voice: ${voiceEnabled}, voiceId: ${voiceId || DEFAULT_VOICE_ID})`,
        );

        const result = await sendNotification(
          title,
          message,
          voiceEnabled,
          voiceId,
          voiceSettings,
          volume,
        );

        if (voiceEnabled && !result.voicePlayed && result.voiceError) {
          return Response.json(
            {
              status: "error",
              message: `TTS failed: ${result.voiceError}`,
              notification_sent: true,
            },
            { status: 502, headers: corsHeaders },
          );
        }

        return Response.json(
          {
            status: "success",
            message: "Notification sent",
            audio_id: result.audio_id,
            audio_url: result.audio_url,
          },
          { headers: corsHeaders },
        );
      } catch (error: any) {
        console.error("Notification error:", error);
        return Response.json(
          { status: "error", message: error.message || "Internal server error" },
          { status: error.message?.includes("Invalid") ? 400 : 500, headers: corsHeaders },
        );
      }
    }

    // POST /notify/personality — compatibility shim
    if (url.pathname === "/notify/personality" && req.method === "POST") {
      try {
        const data = await req.json();
        const message = data.message || "Notification";

        console.log(`Personality notification: "${message}"`);
        const result = await sendNotification("PAI Notification", message, true, null);

        return Response.json(
          {
            status: "success",
            message: "Personality notification sent",
            audio_id: result.audio_id,
            audio_url: result.audio_url,
          },
          { headers: corsHeaders },
        );
      } catch (error: any) {
        console.error("Personality notification error:", error);
        return Response.json(
          { status: "error", message: error.message || "Internal server error" },
          { status: error.message?.includes("Invalid") ? 400 : 500, headers: corsHeaders },
        );
      }
    }

    // POST /pai — PAI notification shim
    if (url.pathname === "/pai" && req.method === "POST") {
      try {
        const data = await req.json();
        const title = data.title || "PAI Assistant";
        const message = data.message || "Task completed";

        console.log(`PAI notification: "${title}" - "${message}"`);
        const result = await sendNotification(title, message, true, null);

        return Response.json(
          {
            status: "success",
            message: "PAI notification sent",
            audio_id: result.audio_id,
            audio_url: result.audio_url,
          },
          { headers: corsHeaders },
        );
      } catch (error: any) {
        console.error("PAI notification error:", error);
        return Response.json(
          { status: "error", message: error.message || "Internal server error" },
          { status: error.message?.includes("Invalid") ? 400 : 500, headers: corsHeaders },
        );
      }
    }

    // GET /audio/:id — serve generated audio file
    if (url.pathname.startsWith("/audio/") && req.method === "GET") {
      const id = url.pathname.slice(7); // remove "/audio/"

      // /audio/latest → redirect to most recent
      if (id === "latest") {
        if (!latestAudioId) {
          return Response.json(
            { status: "error", message: "No audio available" },
            { status: 404, headers: corsHeaders },
          );
        }
        return Response.redirect(`/audio/${latestAudioId}`, 302);
      }

      const audioPath = join(AUDIO_DIR, `${id}.mp3`);
      if (!existsSync(audioPath)) {
        return Response.json(
          { status: "error", message: "Audio not found" },
          { status: 404, headers: corsHeaders },
        );
      }

      const file = Bun.file(audioPath);
      return new Response(file, {
        headers: {
          ...corsHeaders,
          "Content-Type": "audio/mpeg",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // POST /transcribe — STT via ElevenLabs Scribe v2
    if (url.pathname === "/transcribe" && req.method === "POST") {
      try {
        if (!ELEVENLABS_API_KEY) {
          return Response.json(
            { status: "error", message: "ElevenLabs API key not configured" },
            { status: 500, headers: corsHeaders },
          );
        }

        const formData = await req.formData();
        const audioFile = formData.get("file");
        if (!audioFile || !(audioFile instanceof File)) {
          return Response.json(
            {
              status: "error",
              message: "No audio file provided. Send multipart/form-data with 'file' field.",
            },
            { status: 400, headers: corsHeaders },
          );
        }

        console.log(`Transcribing: ${audioFile.name} (${audioFile.size} bytes)`);

        const sttFormData = new FormData();
        sttFormData.append("file", audioFile);
        sttFormData.append("model_id", "scribe_v2");

        const sttResp = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
          method: "POST",
          headers: { "xi-api-key": ELEVENLABS_API_KEY },
          body: sttFormData,
        });

        if (!sttResp.ok) {
          const errText = await sttResp.text();
          console.error(`STT error: ${sttResp.status} — ${errText}`);
          return Response.json(
            { status: "error", message: `STT failed: ${sttResp.status}` },
            { status: 502, headers: corsHeaders },
          );
        }

        const sttResult = (await sttResp.json()) as any;
        const text = sttResult.text || "";
        console.log(`Transcribed: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);

        return Response.json({ status: "success", text }, { headers: corsHeaders });
      } catch (error: any) {
        console.error("Transcription error:", error);
        return Response.json(
          { status: "error", message: error.message },
          { status: 500, headers: corsHeaders },
        );
      }
    }

    // GET /health
    if (url.pathname === "/health") {
      return Response.json(
        {
          status: "healthy",
          port: PORT,
          voice_system: "ElevenLabs",
          platform: process.platform,
          is_desktop: IS_DESKTOP,
          default_voice_id: DEFAULT_VOICE_ID,
          api_key_configured: !!ELEVENLABS_API_KEY,
          pronunciation_rules: pronunciationRules.length,
          configured_voices: Object.keys(voiceConfig.voices),
          audio_dir: AUDIO_DIR,
          latest_audio: latestAudioId,
        },
        { headers: corsHeaders },
      );
    }

    return new Response(
      "Voice Server — POST /notify, /transcribe | GET /audio/:id, /health",
      { headers: corsHeaders },
    );
  },
});

console.log(`Voice Server running on 127.0.0.1:${PORT}`);
console.log(`Platform: ${process.platform} | Desktop: ${IS_DESKTOP}`);
console.log(`ElevenLabs TTS — default voice: ${DEFAULT_VOICE_ID}`);
console.log(`API Key: ${ELEVENLABS_API_KEY ? "configured" : "MISSING"}`);
console.log(`Audio dir: ${AUDIO_DIR}`);
console.log(`Pronunciations: ${pronunciationRules.length} rules`);
