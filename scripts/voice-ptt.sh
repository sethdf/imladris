#!/usr/bin/env bash
# =============================================================================
# voice-ptt.sh — Push-to-talk voice input (toggle mode)
# Decision 43: Voice I/O via local Aurora daemon
#
# Toggle: press hotkey to start recording, press again to stop.
# After stop: transcribes via ElevenLabs Scribe → clipboard → notification.
#
# KDE Global Shortcut: Meta+V → runs this script
#
# Flow:
#   Meta+V → beep → "recording..." → speak → Meta+V → beep → transcribe
#   → text in clipboard → Ctrl+Shift+V to paste in terminal
# =============================================================================

set -uo pipefail

VOICE_SERVER="${VOICE_SERVER:-http://localhost:8888}"
AUDIO_FILE="/tmp/voice-ptt-recording.wav"
PID_FILE="/tmp/voice-ptt.pid"
MAX_RECORD_SECONDS="${MAX_RECORD_SECONDS:-60}"

BEEP_START="/tmp/voice-ptt-start.wav"
BEEP_STOP="/tmp/voice-ptt-stop.wav"

# Generate audio feedback beeps (once, cached)
generate_beeps() {
  [ -f "$BEEP_START" ] && [ -f "$BEEP_STOP" ] && return
  python3 -c "
import struct, math
for fname, freq in [('$BEEP_START', 880), ('$BEEP_STOP', 440)]:
    f = open(fname, 'wb')
    sr, dur = 48000, 0.1
    n = int(sr * dur)
    d = b''.join(struct.pack('<h', int(12000 * math.sin(2 * math.pi * freq * i / sr))) for i in range(n))
    f.write(b'RIFF' + struct.pack('<I', 36+len(d)) + b'WAVEfmt ' + struct.pack('<IHHIIHH',16,1,1,sr,sr*2,2,16) + b'data' + struct.pack('<I',len(d)) + d)
    f.close()
" 2>/dev/null || true
}

is_recording() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null
}

do_stop() {
  local REC_PID
  REC_PID=$(cat "$PID_FILE" 2>/dev/null)
  kill "$REC_PID" 2>/dev/null || true
  wait "$REC_PID" 2>/dev/null || true
  rm -f "$PID_FILE"

  # Stop beep
  pw-play "$BEEP_STOP" 2>/dev/null || true

  # Check file size
  local SIZE
  SIZE=$(stat -c%s "$AUDIO_FILE" 2>/dev/null || echo 0)
  if [ "$SIZE" -lt 2000 ]; then
    notify-send -t 2000 "Voice Input" "Too short — skipped" 2>/dev/null || true
    rm -f "$AUDIO_FILE"
    return
  fi

  notify-send -t 2000 "Voice Input" "Transcribing..." 2>/dev/null || true

  # Transcribe
  local RESULT TEXT
  RESULT=$(curl -sf --max-time 30 -X POST "${VOICE_SERVER}/transcribe" \
    -F "file=@${AUDIO_FILE}" 2>&1) || RESULT=""
  rm -f "$AUDIO_FILE"

  TEXT=$(echo "$RESULT" | python3 -c "
import sys, json
try:
    r = json.load(sys.stdin)
    t = r.get('text', '').strip()
    print(t if t else '')
except:
    print('')
" 2>/dev/null) || TEXT=""

  if [ -n "$TEXT" ]; then
    # Clipboard
    echo -n "$TEXT" | wl-copy 2>/dev/null || true
    notify-send -t 5000 "Voice Input" "$TEXT" 2>/dev/null || true
  else
    notify-send -t 3000 "Voice Input" "No speech detected" 2>/dev/null || true
  fi
}

do_start() {
  generate_beeps

  rm -f "$AUDIO_FILE"
  pw-play "$BEEP_START" 2>/dev/null || true

  # Start recording in background
  pw-record --format s16 --rate 16000 --channels 1 "$AUDIO_FILE" &
  echo $! > "$PID_FILE"

  notify-send -t 2000 "Voice Input" "Recording... press Meta+V to stop" 2>/dev/null || true

  # Safety timeout — auto-stop after MAX_RECORD_SECONDS
  (
    sleep "$MAX_RECORD_SECONDS"
    if is_recording; then
      do_stop
    fi
  ) &
  disown
}

# =============================================================================
# Main toggle
# =============================================================================

if is_recording; then
  do_stop
else
  do_start
fi
