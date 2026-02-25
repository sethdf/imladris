#!/usr/bin/env bash
# =============================================================================
# voice-tunnel.sh — Audio relay tunnel from local machine to imladris
# Decision 43: Voice I/O via local Aurora daemon
# =============================================================================
#
# Run this on your LOCAL machine (Aurora) to forward the voice server port
# from imladris EC2 to localhost. This lets a local audio player fetch
# TTS audio from the voice server running on EC2.
#
# The voice server on EC2 binds to 127.0.0.1:8888 (Decision 33: no public
# ports). This SSH tunnel makes it accessible at localhost:8888 on Aurora.
#
# Usage:
#   ./voice-tunnel.sh              # Start tunnel in background
#   ./voice-tunnel.sh stop         # Stop tunnel
#   ./voice-tunnel.sh status       # Check if tunnel is running
#
# Audio playback (run separately on Aurora):
#   # One-shot: play the latest TTS audio
#   curl -sL http://localhost:8888/audio/latest -o /tmp/voice.mp3 && pw-play /tmp/voice.mp3
#
#   # Continuous: poll for new audio and play automatically
#   # (Future: voice-client daemon will handle this)
#
# Connection stack:
#   Terminal:  Aurora → Mosh → tmux → Claude (text only, no audio)
#   Audio:     Aurora → SSH tunnel (port 8888) → EC2 voice server → ElevenLabs TTS
#   Playback:  Aurora fetches MP3 from localhost:8888/audio/latest → PipeWire → speakers
#
# Prerequisites:
#   - Tailscale connected (imladris-1 reachable)
#   - SSH key configured for ec2-user@imladris-1

set -euo pipefail

REMOTE_HOST="${IMLADRIS_HOST:-ec2-user@imladris-1}"
LOCAL_PORT="${VOICE_PORT:-8888}"
REMOTE_PORT="${VOICE_PORT:-8888}"
PID_FILE="/tmp/voice-tunnel.pid"

start_tunnel() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Voice tunnel already running (PID $(cat "$PID_FILE"))"
    return 0
  fi

  echo "Starting voice tunnel: localhost:${LOCAL_PORT} → ${REMOTE_HOST}:${REMOTE_PORT}"
  ssh -f -N -L "${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" "$REMOTE_HOST" \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes

  # Find the SSH process we just started
  PID=$(pgrep -f "ssh.*-L.*${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}.*${REMOTE_HOST}" | tail -1)
  if [ -n "$PID" ]; then
    echo "$PID" > "$PID_FILE"
    echo "Voice tunnel started (PID $PID)"
    echo ""
    echo "Test:     curl -s http://localhost:${LOCAL_PORT}/health | jq ."
    echo "Play:     curl -sL http://localhost:${LOCAL_PORT}/audio/latest -o /tmp/voice.mp3 && pw-play /tmp/voice.mp3"
  else
    echo "ERROR: Tunnel started but PID not found"
    return 1
  fi
}

stop_tunnel() {
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID"
      echo "Voice tunnel stopped (PID $PID)"
    else
      echo "Tunnel process $PID not running"
    fi
    rm -f "$PID_FILE"
  else
    echo "No tunnel PID file found"
    # Try to find and kill any matching tunnel
    pkill -f "ssh.*-L.*${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" 2>/dev/null && echo "Killed orphan tunnel" || echo "No tunnel running"
  fi
}

check_status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Voice tunnel: RUNNING (PID $(cat "$PID_FILE"))"
    # Test the connection
    if curl -sf http://localhost:${LOCAL_PORT}/health >/dev/null 2>&1; then
      echo "Voice server: HEALTHY"
      curl -s http://localhost:${LOCAL_PORT}/health | python3 -m json.tool 2>/dev/null || true
    else
      echo "Voice server: NOT RESPONDING (tunnel up but server may be down)"
    fi
  else
    echo "Voice tunnel: NOT RUNNING"
  fi
}

case "${1:-start}" in
  start)  start_tunnel ;;
  stop)   stop_tunnel ;;
  status) check_status ;;
  *)
    echo "Usage: $0 {start|stop|status}"
    exit 1
    ;;
esac
