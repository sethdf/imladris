#!/usr/bin/env python3
"""
Voice Listener — Wake-word activated dictation daemon for PAI
Decision 43: Voice I/O via local Aurora daemon

Listens continuously for a wake word ("hey jarvis") using OpenWakeWord,
then records speech until silence is detected, transcribes via the voice
server's /transcribe endpoint, and injects text into the active Claude
Code session or copies to clipboard.

Flow:
  1. Continuous mic listening (low CPU via OpenWakeWord)
  2. Wake word detected → beep → start recording
  3. Silence detected (1.5s) or timeout (30s) → stop recording
  4. Send audio to POST localhost:8888/transcribe
  5. Copy transcribed text to clipboard via wl-copy
  6. Desktop notification with transcribed text
  7. User pastes into whichever Claude session they want
  8. Return to listening

Usage:
  python3 voice-listener.py                         # Default: "hey_jarvis"
  WAKE_WORD=alexa python3 voice-listener.py         # Use "alexa" wake word
  VOICE_SERVER=http://host:8888 python3 voice-listener.py
"""

import io
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
import sounddevice as sd
from openwakeword.model import Model

# ==========================================================================
# Configuration
# ==========================================================================

VOICE_SERVER = os.environ.get("VOICE_SERVER", "http://localhost:8888")
WAKE_WORD = os.environ.get("WAKE_WORD", "hey_jarvis")
SAMPLE_RATE = 16000
CHANNELS = 1
CHUNK_SAMPLES = 1280  # 80ms chunks for openwakeword (requires 80ms frames)
WAKE_THRESHOLD = float(os.environ.get("WAKE_THRESHOLD", "0.5"))
SILENCE_THRESHOLD = float(os.environ.get("SILENCE_THRESHOLD", "0.01"))
SILENCE_DURATION = float(os.environ.get("SILENCE_DURATION", "1.5"))  # seconds
MAX_RECORD_SECONDS = int(os.environ.get("MAX_RECORD_SECONDS", "30"))
BEEP_ENABLED = os.environ.get("BEEP_ENABLED", "1") == "1"

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
# Audio Feedback
# ==========================================================================

def generate_beep(freq: int = 880, duration_ms: int = 100) -> bytes:
    """Generate a simple WAV beep in memory."""
    n_samples = int(SAMPLE_RATE * duration_ms / 1000)
    samples = []
    for i in range(n_samples):
        sample = int(16000 * np.sin(2 * np.pi * freq * i / SAMPLE_RATE))
        samples.append(struct.pack("<h", max(-32768, min(32767, sample))))

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(b"".join(samples))
    return buf.getvalue()


def play_beep(freq: int = 880, duration_ms: int = 100) -> None:
    """Play a short beep via pw-play."""
    if not BEEP_ENABLED:
        return
    try:
        wav_data = generate_beep(freq, duration_ms)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(wav_data)
            tmp = f.name
        subprocess.run(["pw-play", tmp], capture_output=True, timeout=3)
        os.unlink(tmp)
    except Exception:
        pass  # beep failure is non-critical


# ==========================================================================
# Transcription
# ==========================================================================

def transcribe(audio_path: str) -> str | None:
    """Send audio to voice server /transcribe endpoint."""
    try:
        result = subprocess.run(
            [
                "curl", "-sf", "-X", "POST",
                f"{VOICE_SERVER}/transcribe",
                "-F", f"file=@{audio_path}",
                "--max-time", "30",
            ],
            capture_output=True,
            text=True,
            timeout=35,
        )
        if result.returncode != 0:
            log_err(f"Transcribe failed: {result.stderr.strip()}")
            return None

        import json
        data = json.loads(result.stdout)
        return data.get("text", "").strip() or None
    except Exception as e:
        log_err(f"Transcribe error: {e}")
        return None


# ==========================================================================
# Output: Clipboard + smart tmux injection
# ==========================================================================

TERMINAL_CLASSES = {"konsole", "alacritty", "kitty", "wezterm", "foot", "ghostty", "org.gnome.terminal"}


def copy_to_clipboard(text: str) -> None:
    """Copy text to Wayland clipboard."""
    try:
        subprocess.run(["wl-copy", text], timeout=3)
    except Exception as e:
        log_err(f"Clipboard copy failed: {e}")


def notify(title: str, message: str) -> None:
    """Show desktop notification."""
    try:
        subprocess.run(["notify-send", title, message], timeout=3)
    except Exception:
        pass


def is_terminal_focused() -> bool:
    """Check if the focused desktop window is a terminal emulator via KWin DBus."""
    try:
        result = subprocess.run(
            [
                "dbus-send", "--session", "--dest=org.kde.KWin",
                "--print-reply", "/KWin", "org.kde.KWin.queryWindowInfo",
            ],
            capture_output=True, text=True, timeout=3,
        )
        if result.returncode != 0:
            return False
        # Parse resourceClass from DBus output
        lines = result.stdout.split("\n")
        for i, line in enumerate(lines):
            if "resourceClass" in line and i + 1 < len(lines):
                # Next line has: variant  string "konsole"
                class_line = lines[i + 1].strip()
                for cls in TERMINAL_CLASSES:
                    if cls.lower() in class_line.lower():
                        return True
        return False
    except Exception:
        return False


def get_active_tmux_command() -> str | None:
    """Get the command running in the active tmux pane."""
    try:
        result = subprocess.run(
            ["tmux", "display-message", "-p", "#{pane_current_command}"],
            capture_output=True, text=True, timeout=3,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return None


def inject_into_claude(text: str) -> bool:
    """Inject text into active tmux pane if terminal is focused and pane runs claude."""
    if not is_terminal_focused():
        return False

    cmd = get_active_tmux_command()
    if not cmd or cmd.lower() not in ("claude", "claude-code"):
        return False

    try:
        subprocess.run(["tmux", "send-keys", text], timeout=3)
        return True
    except Exception as e:
        log_err(f"tmux inject failed: {e}")
        return False


def handle_transcription(text: str) -> None:
    """Inject into Claude if focused, otherwise clipboard + notify."""
    copy_to_clipboard(text)

    if inject_into_claude(text):
        log(f"Injected into Claude: \"{text[:60]}{'...' if len(text) > 60 else ''}\"")
        notify("Voice → Claude", f"{text[:100]}")
    else:
        log(f"Clipboard: \"{text[:60]}{'...' if len(text) > 60 else ''}\"")
        notify("Voice → Clipboard", f"{text[:100]}")


# ==========================================================================
# Recording with silence detection
# ==========================================================================

def record_until_silence() -> str | None:
    """Record audio until silence detected or timeout. Returns path to WAV file."""
    log("Recording — speak now...")
    play_beep(880, 100)  # high beep = start

    frames: list[np.ndarray] = []
    silence_start: float | None = None
    start_time = time.time()

    def callback(indata, frame_count, time_info, status):
        nonlocal silence_start
        if status:
            log_err(f"Audio status: {status}")
        frames.append(indata.copy())

        # Check for silence
        rms = np.sqrt(np.mean(indata ** 2))
        if rms < SILENCE_THRESHOLD:
            if silence_start is None:
                silence_start = time.time()
        else:
            silence_start = None

    with sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=CHANNELS,
        dtype="int16",
        blocksize=CHUNK_SAMPLES,
        callback=callback,
    ):
        while not shutting_down:
            time.sleep(0.05)
            elapsed = time.time() - start_time

            # Silence detection
            if silence_start and (time.time() - silence_start) >= SILENCE_DURATION:
                # Only stop if we've recorded at least 0.5s of actual audio
                if elapsed > SILENCE_DURATION + 0.5:
                    log(f"Silence detected after {elapsed:.1f}s")
                    break

            # Timeout
            if elapsed >= MAX_RECORD_SECONDS:
                log(f"Max recording time ({MAX_RECORD_SECONDS}s) reached")
                break

    play_beep(440, 100)  # low beep = stop

    if not frames:
        return None

    # Write WAV file
    audio_data = np.concatenate(frames)
    if len(audio_data) < SAMPLE_RATE * 0.3:  # less than 0.3s
        log("Audio too short — skipping")
        return None

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    with wave.open(tmp.name, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(2)  # int16
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio_data.tobytes())

    return tmp.name


# ==========================================================================
# Main Loop
# ==========================================================================

def main() -> None:
    global shutting_down

    log(f"Voice listener starting — wake word: \"{WAKE_WORD}\"")
    log(f"Server: {VOICE_SERVER} | Threshold: {WAKE_THRESHOLD}")
    log(f"Silence: {SILENCE_DURATION}s | Max record: {MAX_RECORD_SECONDS}s")

    # Load wake word model
    log("Loading wake word model...")
    model = Model(wakeword_models=[WAKE_WORD])
    log(f"Model loaded: {list(model.models.keys())}")

    # Open audio stream for wake word detection
    log("Listening for wake word...")

    def signal_handler(sig, frame):
        global shutting_down
        log("Shutting down...")
        shutting_down = True

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    # Continuous listening loop
    with sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=CHANNELS,
        dtype="int16",
        blocksize=CHUNK_SAMPLES,
    ) as stream:
        while not shutting_down:
            try:
                audio_chunk, overflowed = stream.read(CHUNK_SAMPLES)
                if overflowed:
                    continue

                # Feed to wake word model (expects float32 -1 to 1)
                audio_float = audio_chunk.flatten().astype(np.float32) / 32768.0
                prediction = model.predict(audio_float)

                # Check wake word score
                score = prediction.get(WAKE_WORD, 0.0)
                if score >= WAKE_THRESHOLD:
                    log(f"Wake word detected! (score: {score:.3f})")
                    model.reset()  # reset to avoid re-triggering

                    # Record, transcribe, inject
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

                    log("Listening for wake word...")

            except Exception as e:
                if not shutting_down:
                    log_err(f"Error in listen loop: {e}")
                    time.sleep(1)

    log("Voice listener stopped")


if __name__ == "__main__":
    main()
