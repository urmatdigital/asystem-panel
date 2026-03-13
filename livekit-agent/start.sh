#!/bin/bash
cd ~/projects/ASYSTEM/livekit-agent
set -a; source .env; set +a
exec .venv/bin/python3 forge_agent.py start
