#!/usr/bin/env bash
set -e

# -----------------------------------------------------------------------------
# 1) start a background daemon so we can pull the model
# -----------------------------------------------------------------------------
ollama serve >/tmp/ollama.log 2>&1 &
DAEMON_PID=$!

# wait until the HTTP port is reachable
echo "Waiting for Ollama daemon..."
until curl -s http://127.0.0.1:11434/ >/dev/null 2>&1; do
  sleep 1
done
echo "Daemon is up – pulling model gemma3"

# -----------------------------------------------------------------------------
# 2) pull the model (idempotent)
# -----------------------------------------------------------------------------
curl -s -X POST http://127.0.0.1:11434/api/pull \
     -H "Content-Type: application/json" \
     -d '{"name":"gemma3"}' >/dev/null

# poll until the model is fully downloaded
while ! curl -s -X POST http://127.0.0.1:11434/api/show \
              -H "Content-Type: application/json" \
              -d '{"model":"gemma3"}' \
              | grep -q '"details"'; do
  echo "Downloading gemma3 – still in progress..."
  sleep 5
done
echo "gemma3 is ready ✔"

# -----------------------------------------------------------------------------
# 3) stop the bootstrap daemon and run the real foreground server
# -----------------------------------------------------------------------------
kill "${DAEMON_PID}"
wait "${DAEMON_PID}" 2>/dev/null || true

echo "Starting Ollama serve in foreground"
exec ollama serve
