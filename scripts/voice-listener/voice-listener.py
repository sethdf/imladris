#!/usr/bin/env python3
"""
Voice Listener — Wake-word activated dictation daemon for PAI
Decision 43: Voice I/O via local Aurora daemon

Listens continuously for a wake word ("hey jarvis") using OpenWakeWord,
then records speech until silence is detected, transcribes via the voice
server's /transcribe endpoint, and injects text into the active Claude
Code session or copies to clipboard.

Audio capture uses ffmpeg reading from PulseAudio/PipeWire default source,
outputting raw s16le PCM to stdout. pw-record was abandoned because it
outputs SPA pod format (not raw PCM) when piping to stdout.

Flow:
  1. Continuous mic listening via pw-record pipe (low CPU via OpenWakeWord)
  2. Wake word detected → beep → start recording
  3. Silence detected (1.5s) or timeout (30s) → stop recording
  4. Send audio to POST localhost:8888/transcribe
  5. If Konsole focused + active tmux pane is claude → inject
  6. Always copy to clipboard via wl-copy
  7. Desktop notification with transcribed text
  8. Return to listening

Usage:
  python3 voice-listener.py                         # Default: "hey_jarvis"
  WAKE_WORD=alexa python3 voice-listener.py         # Use "alexa" wake word
  VOICE_SERVER=http://host:8888 python3 voice-listener.py
"""

import io
import json
import os
import signal
import struct
import subprocess
import sys
import tempfile
import time
import wave
from datetime import datetime

import numpy as np
from openwakeword.model import Model

# ==========================================================================
# Configuration
# ==========================================================================

VOICE_SERVER = os.environ.get("VOICE_SERVER", "http://localhost:8888")
WAKE_WORD = os.environ.get("WAKE_WORD", "hey_jarvis")
SAMPLE_RATE = 16000
CHANNELS = 1
BYTES_PER_SAMPLE = 2  # int16
CHUNK_SAMPLES = 1280  # 80ms chunks for openwakeword
CHUNK_BYTES = CHUNK_SAMPLES * BYTES_PER_SAMPLE
WAKE_THRESHOLD = float(os.environ.get("WAKE_THRESHOLD", "0.5"))
SILENCE_THRESHOLD = float(os.environ.get("SILENCE_THRESHOLD", "200"))  # RMS of int16 samples
SILENCE_DURATION = float(os.environ.get("SILENCE_DURATION", "1.5"))
MAX_RECORD_SECONDS = int(os.environ.get("MAX_RECORD_SECONDS", "30"))
BEEP_ENABLED = os.environ.get("BEEP_ENABLED", "1") == "1"
TMUX_SSH_HOST = os.environ.get("TMUX_SSH_HOST", "ec2-user@imladris")
TMUX_SESSION = os.environ.get("TMUX_SESSION", "work")

shutting_down = False


# ==========================================================================
# Logging
# ==========================================================================

def log(msg: str) -> None:
    ts = datetime.now().strftime("%H:%M:%S.%f")[:12]
    print(f"[{ts}] {msg}", flush=True)


def log_err(msg: str) -> None:
    ts = datetime.now().strftime("%H:%M:%S.%f")[:12]
    print(f"[{ts}] ERROR: {msg}", file=sys.stderr, flush=True)


# ==========================================================================
# Audio Capture via ffmpeg (PulseAudio/PipeWire)
# ==========================================================================

def start_audio_capture() -> subprocess.Popen:
    """Start ffmpeg reading from PulseAudio default source, outputting raw s16le PCM."""
    return subprocess.Popen(
        ["ffmpeg", "-f", "pulse", "-i", "default",
         "-ac", str(CHANNELS), "-ar", str(SAMPLE_RATE),
         "-f", "s16le", "-loglevel", "error", "pipe:1"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )


def read_chunk(proc: subprocess.Popen) -> np.ndarray | None:
    """Read one chunk of raw PCM audio from ffmpeg stdout."""
    data = proc.stdout.read(CHUNK_BYTES)
    if not data or len(data) < CHUNK_BYTES:
        return None
    return np.frombuffer(data, dtype=np.int16)


# ==========================================================================
# Audio Feedback
# ==========================================================================

def play_beep(freq: int = 880, duration_ms: int = 100) -> None:
    """Play a short beep via pw-play."""
    if not BEEP_ENABLED:
        return
    try:
        n_samples = int(SAMPLE_RATE * duration_ms / 1000)
        samples = b"".join(
            struct.pack("<h", max(-32768, min(32767, int(16000 * np.sin(2 * np.pi * freq * i / SAMPLE_RATE)))))
            for i in range(n_samples)
        )
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(samples)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(buf.getvalue())
            tmp = f.name
        subprocess.run(["pw-play", tmp], capture_output=True, timeout=3)
        os.unlink(tmp)
    except Exception:
        pass


# ==========================================================================
# Transcription
# ==========================================================================

def transcribe(audio_path: str) -> str | None:
    """Send audio to voice server /transcribe endpoint."""
    try:
        result = subprocess.run(
            ["curl", "-sf", "-X", "POST", f"{VOICE_SERVER}/transcribe",
             "-F", f"file=@{audio_path}", "--max-time", "30"],
            capture_output=True, text=True, timeout=35,
        )
        if result.returncode != 0:
            log_err(f"Transcribe failed: {result.stderr.strip()}")
            return None
        data = json.loads(result.stdout)
        return data.get("text", "").strip() or None
    except Exception as e:
        log_err(f"Transcribe error: {e}")
        return None


# ==========================================================================
# Output: Clipboard + remote tmux injection via SSH
# ==========================================================================


def copy_to_clipboard(text: str) -> None:
    try:
        env = {**os.environ, "WAYLAND_DISPLAY": os.environ.get("WAYLAND_DISPLAY", "wayland-0")}
        subprocess.run(["wl-copy", text], timeout=3, env=env)
    except Exception as e:
        log_err(f"Clipboard copy failed: {e}")


def notify(title: str, message: str) -> None:
    try:
        env = {**os.environ, "WAYLAND_DISPLAY": os.environ.get("WAYLAND_DISPLAY", "wayland-0")}
        subprocess.run(["notify-send", title, message], timeout=3, env=env)
    except Exception:
        pass


def inject_into_tmux(text: str) -> bool:
    """Inject text into the active pane of the remote tmux session via SSH."""
    try:
        escaped = text.replace("'", "'\\''")
        result = subprocess.run(
            ["ssh", "-o", "ConnectTimeout=3", TMUX_SSH_HOST,
             f"tmux send-keys -t {TMUX_SESSION} -l '{escaped}'"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            log_err(f"tmux send-keys failed: {result.stderr.strip()}")
            return False
        return True
    except Exception as e:
        log_err(f"tmux inject failed: {e}")
        return False


def handle_transcription(text: str) -> None:
    copy_to_clipboard(text)
    if inject_into_tmux(text):
        log(f"Injected into tmux: \"{text[:60]}{'...' if len(text) > 60 else ''}\"")
        notify("Voice → tmux", f"{text[:100]}")
    else:
        log(f"Clipboard: \"{text[:60]}{'...' if len(text) > 60 else ''}\"")
        notify("Voice → Clipboard", f"{text[:100]}")


# ==========================================================================
# Recording with silence detection (via ffmpeg)
# ==========================================================================

def record_until_silence() -> str | None:
    """Record audio via ffmpeg until silence or timeout. Returns WAV path."""
    log("Recording — speak now...")

    proc = start_audio_capture()
    frames: list[bytes] = []
    silence_start: float | None = None
    start_time = time.time()

    try:
        while not shutting_down:
            data = proc.stdout.read(CHUNK_BYTES)
            if not data or len(data) < CHUNK_BYTES:
                break

            frames.append(data)
            chunk = np.frombuffer(data, dtype=np.int16)
            rms = np.sqrt(np.mean(chunk.astype(np.float32) ** 2))
            elapsed = time.time() - start_time

            if rms < SILENCE_THRESHOLD:
                if silence_start is None:
                    silence_start = time.time()
                elif (time.time() - silence_start) >= SILENCE_DURATION and elapsed > SILENCE_DURATION + 0.5:
                    log(f"Silence detected after {elapsed:.1f}s")
                    break
            else:
                silence_start = None

            if elapsed >= MAX_RECORD_SECONDS:
                log(f"Max recording time ({MAX_RECORD_SECONDS}s) reached")
                break
    finally:
        proc.terminate()
        proc.wait()

    # No end-beep — it gets picked up by the mic and re-triggers wake word

    if not frames:
        return None

    audio_data = b"".join(frames)
    if len(audio_data) < SAMPLE_RATE * BYTES_PER_SAMPLE * 0.3:
        log("Audio too short — skipping")
        return None

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    with wave.open(tmp.name, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(BYTES_PER_SAMPLE)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio_data)

    return tmp.name


# ==========================================================================
# Main Loop: ffmpeg → OpenWakeWord
# ==========================================================================

PID_FILE = "/tmp/voice-listener.pid"


def acquire_pidfile() -> bool:
    """Ensure only one instance runs. Kill any existing daemon."""
    if os.path.exists(PID_FILE):
        try:
            old_pid = int(open(PID_FILE).read().strip())
            os.kill(old_pid, signal.SIGTERM)
            log(f"Killed previous instance (pid {old_pid})")
            time.sleep(0.5)
        except (ProcessLookupError, ValueError):
            pass
        except PermissionError:
            log_err(f"Cannot kill existing pid — aborting")
            return False
    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))
    return True


def release_pidfile() -> None:
    try:
        if os.path.exists(PID_FILE) and int(open(PID_FILE).read().strip()) == os.getpid():
            os.unlink(PID_FILE)
    except Exception:
        pass


def main() -> None:
    global shutting_down

    if not acquire_pidfile():
        sys.exit(1)

    log(f"Voice listener starting — wake word: \"{WAKE_WORD}\"")
    log(f"Server: {VOICE_SERVER} | Threshold: {WAKE_THRESHOLD}")
    log(f"Silence: {SILENCE_DURATION}s | Max record: {MAX_RECORD_SECONDS}s")

    def signal_handler(sig, frame):
        global shutting_down
        log("Shutting down...")
        shutting_down = True

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    log("Loading wake word model...")
    model = Model()
    log(f"Model loaded: {list(model.models.keys())}")

    while not shutting_down:
        # Start ffmpeg for wake word listening
        proc = start_audio_capture()
        log("Listening for wake word...")

        # Flush initial audio buffer (~2s) to clear residual wake word audio
        for _ in range(25):
            read_chunk(proc)

        try:
            while not shutting_down:
                chunk = read_chunk(proc)
                if chunk is None:
                    break

                # Feed to wake word model (expects raw int16 PCM)
                prediction = model.predict(chunk)

                score = prediction.get(WAKE_WORD, 0.0)
                if score >= WAKE_THRESHOLD:
                    log(f"Wake word detected! (score: {score:.3f})")
                    model.reset()

                    # Stop the listening stream before recording
                    proc.terminate()
                    proc.wait()

                    # Record, transcribe, output
                    audio_path = record_until_silence()
                    if audio_path:
                        text = transcribe(audio_path)
                        os.unlink(audio_path)
                        if text:
                            handle_transcription(text)
                        else:
                            log("No speech recognized")
                            notify("Voice Input", "No speech recognized")
                    else:
                        log("Recording too short")

                    # Full reset: clear prediction buffer AND preprocessor
                    # feature/melspec buffers so "hey jarvis" audio doesn't re-trigger
                    model.reset()
                    model.preprocessor.feature_buffer = np.zeros_like(model.preprocessor.feature_buffer)
                    model.preprocessor.melspectrogram_buffer = np.zeros_like(model.preprocessor.melspectrogram_buffer)
                    model.preprocessor.raw_data_buffer.clear()
                    model.preprocessor.accumulated_samples = 0

                    break  # restart the outer loop to create a new capture

        except Exception as e:
            if not shutting_down:
                log_err(f"Error in listen loop: {e}")
                time.sleep(1)
        finally:
            if proc.poll() is None:
                proc.terminate()
                proc.wait()

    release_pidfile()
    log("Voice listener stopped")


if __name__ == "__main__":
    main()
