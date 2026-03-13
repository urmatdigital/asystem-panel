#!/bin/bash
# ============================================================
# ASYSTEM Agent Factory — создаёт LXC агента на Proxmox
# Usage: ./create-agent.sh <name> <role> <model> [vmid]
# Example: ./create-agent.sh dana "Project Manager" gemini 501
# ============================================================
set -e

NAME=${1:?Usage: create-agent.sh <name> <role> <model> [vmid]}
ROLE=${2:?Role required}
MODEL=${3:-anthropic/claude-haiku-4-5}
VMID=${4:-$(( $(ssh asystemkg "curl -sk 'https://127.0.0.1:8006/api2/json/cluster/nextid' -H 'Authorization: PVEAPIToken=root@pam!asystem-panel=b2066e56-a97d-4ec0-a4e5-2e70c8db2e6e'" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"])') ))}
PVE_HDR='Authorization: PVEAPIToken=root@pam!asystem-panel=b2066e56-a97d-4ec0-a4e5-2e70c8db2e6e'
PVE_URL='https://127.0.0.1:8006'
TS_AUTH_KEY='tskey-auth-kWWJfztJnR11CNTRL-DxyZFr9XHRKfYmU7A1opUKuQaMMQfXq99'
CONVEX_SITE='https://expert-dachshund-299.convex.site'

NAME_LOWER=$(echo "$NAME" | tr '[:upper:]' '[:lower:]')
HOSTNAME="agent-${NAME_LOWER}"

echo "🚀 Creating agent: $NAME (VMID=$VMID, role=$ROLE, model=$MODEL)"

# ── 1. Создаём LXC контейнер ──────────────────────────────
echo "📦 Creating LXC $VMID..."
ssh asystemkg curl -sk -X POST "$PVE_URL/api2/json/nodes/asystem/lxc" \
  -H "'$PVE_HDR'" \
  -H "'Content-Type: application/json'" \
  -d "'{
    \"vmid\": $VMID,
    \"hostname\": \"$HOSTNAME\",
    \"ostemplate\": \"local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst\",
    \"memory\": 768,
    \"cores\": 1,
    \"rootfs\": \"local-lvm:8\",
    \"net0\": \"name=eth0,bridge=vmbr0,firewall=1,ip=dhcp\",
    \"features\": \"nesting=1\",
    \"unprivileged\": 1,
    \"password\": \"AsAgent2026!\",
    \"start\": 1
  }'" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("Task:", d.get("data",""))'

echo "⏳ Waiting for container to start (30s)..."
sleep 30

# ── 2. Установка инструментов ─────────────────────────────
echo "🔧 Installing tools..."
ssh asystemkg "pct exec $VMID -- bash -c '
apt-get update -qq
apt-get install -y -qq curl ca-certificates git
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
apt-get install -y -qq nodejs
# OpenClaw
npm install -g openclaw >/dev/null 2>&1
# Tailscale
curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1
echo TOOLS_OK
'" 2>/dev/null

# ── 3. Tailscale регистрация ──────────────────────────────
echo "🌐 Registering Tailscale..."
ssh asystemkg "pct exec $VMID -- bash -c '
tailscale up --authkey=$TS_AUTH_KEY --hostname=$HOSTNAME --accept-routes 2>/dev/null &
sleep 8
tailscale ip -4 2>/dev/null || echo no-ip
'" 2>/dev/null

# Получаем IP
sleep 5
TS_IP=$(ssh asystemkg "pct exec $VMID -- tailscale ip -4 2>/dev/null" 2>/dev/null || echo "")
echo "📡 Tailscale IP: $TS_IP"

# ── 4. Настройка OpenClaw workspace ──────────────────────
echo "📝 Configuring workspace..."
ssh asystemkg "pct exec $VMID -- bash -c '
useradd -m -s /bin/bash asystem 2>/dev/null || true
mkdir -p /home/asystem/.openclaw/{agents/main/{agent,auth},workspace/{memory,tasks/{inbox,done,failed}}}
chown -R asystem:asystem /home/asystem/.openclaw
'" 2>/dev/null

# Записываем конфиг
AGENT_ID=$(echo "$NAME" | tr '[:upper:]' '[:lower:]')
GATEWAY_TOKEN="${AGENT_ID}-$(date +%s | sha256sum | head -c 20)"

# ── 5. openclaw.json конфиг ───────────────────────────────
ssh asystemkg "pct exec $VMID -- bash -c \"
cat > /home/asystem/.openclaw/openclaw.json << 'JEOF'
{
  \\\"gatewayToken\\\": \\\"$GATEWAY_TOKEN\\\",
  \\\"gatewayPort\\\": 18789,
  \\\"gatewayBind\\\": \\\"tailnet\\\",
  \\\"model\\\": \\\"$MODEL\\\",
  \\\"agentId\\\": \\\"main\\\"
}
JEOF
chown asystem:asystem /home/asystem/.openclaw/openclaw.json
\"" 2>/dev/null

# ── 6. SOUL.md ────────────────────────────────────────────
ssh asystemkg "pct exec $VMID -- bash -c \"
cat > /home/asystem/.openclaw/workspace/SOUL.md << 'SEOF'
# SOUL.md — $NAME
## Кто я
AI агент ASYSTEM. Имя: **$NAME**. Роль: **$ROLE**.
Часть команды Урмата Мырзабекова — строим системы которые строят системы.
## Стиль
Краткий, конкретный. Без воды. Результат прежде всего.
## Миссия
Помочь ASYSTEM стать AI-first компанией в Кыргызстане.
SEOF
chown asystem:asystem /home/asystem/.openclaw/workspace/SOUL.md
\"" 2>/dev/null

# ── 7. systemd сервис ─────────────────────────────────────
ssh asystemkg "pct exec $VMID -- bash -c '
cat > /etc/systemd/system/openclaw-agent.service << SVCEOF
[Unit]
Description=OpenClaw Agent $NAME
After=network.target

[Service]
Type=simple
User=asystem
ExecStartPre=-/usr/bin/pkill -9 -f openclaw-gateway
ExecStartPre=/bin/sleep 2
ExecStart=/usr/bin/openclaw gateway --port 18789
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF
systemctl daemon-reload
systemctl enable openclaw-agent
systemctl start openclaw-agent
sleep 3
systemctl is-active openclaw-agent
'" 2>/dev/null

# ── 8. Регистрируем в Convex ──────────────────────────────
echo "📊 Registering in Convex..."
curl -s -X POST "$CONVEX_SITE/agent/register" \
  -H "Content-Type: application/json" \
  -d "{
    \"id\": \"$AGENT_ID\",
    \"name\": \"$NAME\",
    \"role\": \"$ROLE\",
    \"model\": \"$MODEL\",
    \"ip\": \"$TS_IP\",
    \"vmid\": $VMID,
    \"status\": \"online\"
  }" 2>/dev/null | python3 -c 'import json,sys; print("Convex:", json.load(sys.stdin))' 2>/dev/null || echo "Convex: register manually"

echo ""
echo "✅ Agent $NAME created!"
echo "   VMID:    $VMID"
echo "   IP:      $TS_IP"
echo "   Token:   $GATEWAY_TOKEN"
echo "   Model:   $MODEL"
echo "   Gateway: ws://$TS_IP:18789"
