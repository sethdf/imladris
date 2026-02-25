#!/usr/bin/env bun
/**
 * Voice Server — Linux/EC2 adaptation of PAI VoiceServer
 * Decision 43: Voice I/O via local Aurora daemon
 *
 * Architecture: ElevenLabs TTS on EC2, audio served via HTTP for remote playback.
 * On macOS the upstream server uses afplay for local playback. On headless Linux
 * (EC2), there are no speakers — instead we store generated audio and serve it
 * at /audio/:id so the Aurora client can fetch and play via PipeWire.
 *
 * Endpoints:
 *   POST /notify          — Generate TTS, return JSON with audio_url (backward-compatible)
 *   POST /notify/personality — Compatibility shim
 *   POST /pai             — PAI notification shim
 *   GET  /audio/:id       — Serve generated MP3 audio
 *   GET  /audio/latest    — Redirect to most recent audio
 *   GET  /health          — Server status
 *
 * Config resolution (3-tier, same as upstream):
 *   1. Caller sends voice_settings → use directly
 *   2. Caller sends voice_id → look up in settings.json
 *   3. Neither → use settings.json daidentity.voices.main
 */

import { serve } from "bun";
import { join } from "path";
import { existsSync, readFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from "fs";

const HOME = process.env.HOME || "/home/ec2-user";
const PORT = parseInt(process.env.VOICE_SERVER_PORT || "8888");
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const AUDIO_DIR = process.env.VOICE_AUDIO_DIR || "/tmp/voice-audio";
const MAX_AUDIO_FILES = 50; // keep last 50 audio files

// Ensure audio directory exists
mkdirSync(AUDIO_DIR, { recursive: true });

if (!ELEVENLABS_API_KEY) {
  console.error("ELEVENLABS_API_KEY not set — TTS will fail");
}

// ==========================================================================
// Pronunciation System
// ==========================================================================

interface PronunciationEntry { term: string; phonetic: string; note?: string; }
interface CompiledRule { regex: RegExp; phonetic: string; }

let pronunciationRules: CompiledRule[] = [];

function loadPronunciations(): void {
  const pronPath = join(import.meta.dir, "pronunciations.json");
  try {
    if (!existsSync(pronPath)) return;
    const config = JSON.parse(readFileSync(pronPath, "utf-8"));
    pronunciationRules = (config.replacements || []).map((entry: PronunciationEntry) => ({
      regex: new RegExp(`\\b${entry.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"),
      phonetic: entry.phonetic,
    }));
    console.log(`Loaded ${pronunciationRules.length} pronunciation rules`);
  } catch (e) {
    console.error("Failed to load pronunciations.json:", e);
  }
}

function applyPronunciations(text: string): string {
  let result = text;
  for (const rule of pronunciationRules) result = result.replace(rule.regex, rule.phonetic);
  return result;
}

loadPronunciations();

// ==========================================================================
// Voice Configuration from settings.json
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

const FALLBACK_SETTINGS: ElevenLabsVoiceSettings = {
  stability: 0.5, similarity_boost: 0.75, style: 0.0, speed: 1.0, use_speaker_boost: true,
};

interface VoiceConfig {
  defaultVoiceId: string;
  voices: Record<string, VoiceEntry>;
  voicesByVoiceId: Record<string, VoiceEntry>;
}

function loadVoiceConfig(): VoiceConfig {
  const settingsPath = join(HOME, ".claude", "settings.json");
  const empty: VoiceConfig = { defaultVoiceId: "", voices: {}, voicesByVoiceId: {} };
  try {
    if (!existsSync(settingsPath)) return empty;
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const daidentity = settings.daidentity || {};
    const voicesSection = daidentity.voices || {};

    const voices: Record<string, VoiceEntry> = {};
    const voicesByVoiceId: Record<string, VoiceEntry> = {};

    for (const [name, config] of Object.entries(voicesSection)) {
      const e = config as any;
      if (e.voiceId) {
        const entry: VoiceEntry = {
          voiceId: e.voiceId,
          voiceName: e.voiceName,
          stability: e.stability ?? 0.5,
          similarity_boost: e.similarity_boost ?? e.similarityBoost ?? 0.75,
          style: e.style ?? 0.0,
          speed: e.speed ?? 1.0,
          use_speaker_boost: e.use_speaker_boost ?? e.useSpeakerBoost ?? true,
          volume: e.volume ?? 1.0,
        };
        voices[name] = entry;
        voicesByVoiceId[e.voiceId] = entry;
      }
    }

    const defaultVoiceId = voices.main?.voiceId || daidentity.mainDAVoiceID || "";
    console.log(`Loaded ${Object.keys(voices).length} voice config(s): ${Object.keys(voices).join(", ")}`);
    return { defaultVoiceId, voices, voicesByVoiceId };
  } catch {
    return empty;
  }
}

const voiceConfig = loadVoiceConfig();
const DEFAULT_VOICE_ID = voiceConfig.defaultVoiceId || process.env.ELEVENLABS_VOICE_ID || "";

// Emotional presets (overlay stability + similarity_boost)
const EMOTIONAL_PRESETS: Record<string, { stability: number; similarity_boost: number }> = {
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
// Audio Management
// ==========================================================================

let latestAudioId: string | null = null;

function pruneAudioDir(): void {
  try {
    const files = readdirSync(AUDIO_DIR)
      .filter(f => f.endsWith(".mp3"))
      .map(f => ({ name: f, time: statSync(join(AUDIO_DIR, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    for (const f of files.slice(MAX_AUDIO_FILES)) {
      unlinkSync(join(AUDIO_DIR, f.name));
    }
  } catch { /* ignore */ }
}

// ==========================================================================
// TTS Generation
// ==========================================================================

function sanitize(input: string): string {
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

function extractEmotion(message: string): { cleaned: string; emotion?: string } {
  const map: Record<string, string> = {
    "\u{1F4A5}": "excited", "\u{1F389}": "celebration", "\u{1F4A1}": "insight",
    "\u{1F3A8}": "creative", "\u{2728}": "success", "\u{1F4C8}": "progress",
    "\u{1F50D}": "investigating", "\u{1F41B}": "debugging", "\u{1F4DA}": "learning",
    "\u{1F914}": "pondering", "\u{1F3AF}": "focused", "\u{26A0}\u{FE0F}": "caution",
    "\u{1F6A8}": "urgent",
  };
  for (const [emoji, name] of Object.entries(map)) {
    const pattern = `[${emoji} ${name}]`;
    if (message.includes(pattern)) {
      return { cleaned: message.replace(pattern, "").trim(), emotion: name };
    }
  }
  return { cleaned: message };
}

async function generateSpeech(
  text: string, voiceId: string, settings: ElevenLabsVoiceSettings,
): Promise<ArrayBuffer> {
  if (!ELEVENLABS_API_KEY) throw new Error("ElevenLabs API key not configured");

  const pronounced = applyPronunciations(text);
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "audio/mpeg",
      "Content-Type": "application/json",
      "xi-api-key": ELEVENLABS_API_KEY,
    },
    body: JSON.stringify({
      text: pronounced,
      model_id: "eleven_turbo_v2_5",
      voice_settings: settings,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs API error: ${response.status} - ${err}`);
  }

  return await response.arrayBuffer();
}

// ==========================================================================
// Notification Handler
// ==========================================================================

async function handleNotify(data: any): Promise<{ status: string; message: string; audio_url?: string; audio_id?: string }> {
  const rawMessage = data.message || "Task completed";
  const safeMessage = sanitize(rawMessage);
  if (!safeMessage || safeMessage.length < 2) {
    return { status: "success", message: "Skipped — message too short" };
  }

  const { cleaned, emotion } = extractEmotion(safeMessage);
  const voiceId = data.voice_id || DEFAULT_VOICE_ID;

  // 3-tier voice settings resolution
  let resolved: ElevenLabsVoiceSettings;
  const callerSettings = data.voice_settings;

  if (callerSettings && typeof callerSettings === "object" && Object.keys(callerSettings).length > 0) {
    resolved = { ...FALLBACK_SETTINGS, ...callerSettings };
  } else {
    const entry = voiceConfig.voicesByVoiceId[voiceId] || voiceConfig.voices.main;
    resolved = entry
      ? { stability: entry.stability, similarity_boost: entry.similarity_boost, style: entry.style, speed: entry.speed, use_speaker_boost: entry.use_speaker_boost }
      : { ...FALLBACK_SETTINGS };
  }

  if (emotion && EMOTIONAL_PRESETS[emotion]) {
    resolved = { ...resolved, ...EMOTIONAL_PRESETS[emotion] };
  }

  if (!ELEVENLABS_API_KEY) {
    console.log(`[dry] Would speak: "${cleaned}" (voice: ${voiceId})`);
    return { status: "success", message: "Notification logged (no API key)" };
  }

  try {
    const audioBuffer = await generateSpeech(cleaned, voiceId, resolved);
    const audioId = `voice-${Date.now()}`;
    const audioPath = join(AUDIO_DIR, `${audioId}.mp3`);
    await Bun.write(audioPath, audioBuffer);
    latestAudioId = audioId;
    pruneAudioDir();

    console.log(`TTS: "${cleaned.slice(0, 60)}..." → ${audioId}.mp3 (${audioBuffer.byteLength} bytes)`);
    return {
      status: "success",
      message: "Notification sent",
      audio_id: audioId,
      audio_url: `/audio/${audioId}`,
    };
  } catch (e: any) {
    console.error("TTS failed:", e.message);
    return { status: "error", message: `TTS failed: ${e.message}` };
  }
}

// ==========================================================================
// Rate Limiting
// ==========================================================================

const rateLimits = new Map<string, { count: number; resetTime: number }>();

function checkRate(ip: string): boolean {
  const now = Date.now();
  const rec = rateLimits.get(ip);
  if (!rec || now > rec.resetTime) {
    rateLimits.set(ip, { count: 1, resetTime: now + 60000 });
    return true;
  }
  if (rec.count >= 30) return false;
  rec.count++;
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
    const ip = req.headers.get("x-forwarded-for") || "localhost";

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: cors, status: 204 });
    }

    if (!checkRate(ip)) {
      return Response.json({ status: "error", message: "Rate limit exceeded" }, { status: 429, headers: cors });
    }

    // POST /notify — main TTS endpoint
    if (url.pathname === "/notify" && req.method === "POST") {
      try {
        const data = await req.json();
        const result = await handleNotify(data);
        const status = result.status === "error" ? 502 : 200;
        return Response.json(result, { status, headers: cors });
      } catch (e: any) {
        return Response.json({ status: "error", message: e.message }, { status: 400, headers: cors });
      }
    }

    // POST /notify/personality — compatibility shim
    if (url.pathname === "/notify/personality" && req.method === "POST") {
      try {
        const data = await req.json();
        const result = await handleNotify({ message: data.message || "Notification" });
        return Response.json(result, { headers: cors });
      } catch (e: any) {
        return Response.json({ status: "error", message: e.message }, { status: 400, headers: cors });
      }
    }

    // POST /pai — PAI notification shim
    if (url.pathname === "/pai" && req.method === "POST") {
      try {
        const data = await req.json();
        const result = await handleNotify({ message: data.message || "Task completed", ...data });
        return Response.json(result, { headers: cors });
      } catch (e: any) {
        return Response.json({ status: "error", message: e.message }, { status: 400, headers: cors });
      }
    }

    // GET /audio/:id — serve generated audio file
    if (url.pathname.startsWith("/audio/") && req.method === "GET") {
      const id = url.pathname.slice(7); // remove "/audio/"

      // /audio/latest → redirect to most recent
      if (id === "latest") {
        if (!latestAudioId) {
          return Response.json({ status: "error", message: "No audio available" }, { status: 404, headers: cors });
        }
        return Response.redirect(`/audio/${latestAudioId}`, 302);
      }

      const audioPath = join(AUDIO_DIR, `${id}.mp3`);
      if (!existsSync(audioPath)) {
        return Response.json({ status: "error", message: "Audio not found" }, { status: 404, headers: cors });
      }

      const file = Bun.file(audioPath);
      return new Response(file, {
        headers: { ...cors, "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=3600" },
      });
    }

    // GET /health
    if (url.pathname === "/health") {
      return Response.json({
        status: "healthy",
        port: PORT,
        voice_system: "ElevenLabs",
        platform: "linux",
        default_voice_id: DEFAULT_VOICE_ID,
        api_key_configured: !!ELEVENLABS_API_KEY,
        pronunciation_rules: pronunciationRules.length,
        configured_voices: Object.keys(voiceConfig.voices),
        audio_dir: AUDIO_DIR,
        latest_audio: latestAudioId,
      }, { headers: cors });
    }

    return new Response("Voice Server (Linux) — POST /notify, GET /audio/:id, GET /health", { headers: cors });
  },
});

console.log(`Voice Server running on 127.0.0.1:${PORT}`);
console.log(`ElevenLabs TTS — default voice: ${DEFAULT_VOICE_ID || "(not configured)"}`);
console.log(`API Key: ${ELEVENLABS_API_KEY ? "configured" : "MISSING"}`);
console.log(`Audio dir: ${AUDIO_DIR}`);
console.log(`Pronunciations: ${pronunciationRules.length} rules`);
