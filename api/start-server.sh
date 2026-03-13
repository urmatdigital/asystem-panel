#!/bin/bash
# start-server.sh — Clean start wrapper for asystem-api
# Kills any existing server.mjs processes before starting

echo "[start-server] Killing existing server.mjs..."
pkill -9 -f "node.*server.mjs" 2>/dev/null || true
sleep 1

echo "[start-server] Starting server.mjs..."
exec /opt/homebrew/bin/node /Users/urmatmyrzabekov/projects/ASYSTEM/api/server.mjs
