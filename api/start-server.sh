#!/bin/bash
# start-server.sh — Clean start wrapper for asystem-api
# Kills only orphan server.mjs processes (not this script itself)

OWN_PID=$$
echo "[start-server] PID=$OWN_PID — killing orphan server.mjs..."

# Kill node processes running server.mjs, but NOT our parent (pm2) or ourselves
pgrep -f "node.*server\.mjs" | while read pid; do
  # Skip if it's our own process or parent
  if [ "$pid" != "$OWN_PID" ] && [ "$pid" != "$PPID" ]; then
    echo "[start-server] Killing orphan PID $pid"
    kill -9 "$pid" 2>/dev/null || true
  fi
done
sleep 1

echo "[start-server] Starting server.mjs..."
exec /opt/homebrew/bin/node /Users/urmatmyrzabekov/projects/ASYSTEM/api/server.mjs
