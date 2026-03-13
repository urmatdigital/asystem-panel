// MC Token Bridge — Real Anthropic API tokens → Minecraft Scoreboard
// Reads OpenClaw session logs → diffs token counts → updates MC scoreboard
import fs from 'fs';
import path from 'path';
import net from 'net';
import os from 'os';

const MC_HOST = '100.79.117.102';
const MC_PORT = 25575;
const MC_PASS = 'asystem-rcon-2026';
const LOG_DIR = path.join(os.homedir(), '.openclaw', 'logs');
const STATE_FILE = '/tmp/mc_token_state.json';

// Agent name → OpenClaw session key mapping
const AGENT_SESSIONS = {
  Forge:  'agent:main:telegram',
  Atlas:  'atlas',
  Iron:   'iron',
  Mesa:   'mesa',
  Pixel:  'pixel',
  Dana:   'dana',
  Nurlan: 'nurlan',
  Ainura: 'ainura',
  Marat:  'marat',
  Bekzat: 'bekzat',
};

const rcon = (cmd) => new Promise((resolve) => {
  const s = net.createConnection({ host: MC_HOST, port: MC_PORT });
  s.setTimeout(5000);
  let buf = Buffer.alloc(0);
  const pkt = (id, type, payload) => {
    const p = Buffer.from(payload, 'utf8');
    const b = Buffer.alloc(14 + p.length);
    b.writeInt32LE(10 + p.length, 0); b.writeInt32LE(id, 4); b.writeInt32LE(type, 8);
    p.copy(b, 12); b.writeUInt16LE(0, 12 + p.length); s.write(b);
  };
  s.on('connect', () => pkt(1, 3, MC_PASS));
  s.on('data', (data) => {
    buf = Buffer.concat([buf, data]);
    if (buf.length < 4) return;
    const len = buf.readInt32LE(0);
    if (buf.length < 4 + len) return;
    const reqId = buf.readInt32LE(4);
    if (reqId === 1) { pkt(2, 2, cmd); return; }
    if (reqId === 2) { s.destroy(); resolve(buf.slice(12, 4+len-2).toString('utf8')); }
  });
  s.on('timeout', () => { s.destroy(); resolve(''); });
  s.on('error', () => resolve(''));
});

// Read token count from OpenClaw session log files
function readSessionTokens(sessionPrefix) {
  try {
    if (!fs.existsSync(LOG_DIR)) return 0;
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.includes(sessionPrefix) && f.endsWith('.jsonl'))
      .map(f => path.join(LOG_DIR, f));
    
    let totalTokens = 0;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // last 24h
    
    for (const file of files.slice(-3)) { // last 3 files
      try {
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          const msg = JSON.parse(line);
          if (!msg.timestamp || new Date(msg.timestamp).getTime() < cutoff) continue;
          if (msg.usage) {
            totalTokens += (msg.usage.input || 0) + (msg.usage.output || 0);
          }
        }
      } catch {}
    }
    return totalTokens;
  } catch { return 0; }
}

// Load previous state
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// STATUS_BLOCKS based on token usage rate
function getStatusBlock(tokensPerMin) {
  if (tokensPerMin > 500) return 'minecraft:redstone_block';   // high load
  if (tokensPerMin > 100) return 'minecraft:lime_concrete';    // active
  if (tokensPerMin > 10)  return 'minecraft:yellow_concrete';  // light
  return 'minecraft:gray_concrete';                             // idle
}

const AGENT_PLOTS = {
  Forge:  [100,-62,-10], Atlas: [140,-62,-10], Iron: [180,-62,-10],
  Mesa:   [100,-62,30],  Pixel: [140,-62,30],  Dana: [180,-62,30],
  Nurlan: [100,-62,70],  Ainura:[140,-62,70],  Marat:[180,-62,70],
  Bekzat: [100,-62,110]
};

async function sync() {
  const state = loadState();
  const now = Date.now();
  const updates = [];

  for (const [agentName, sessionKey] of Object.entries(AGENT_SESSIONS)) {
    const tokens = readSessionTokens(sessionKey);
    const prev = state[agentName] || { tokens: 0, ts: now };
    const deltaTokens = Math.max(0, tokens - prev.tokens);
    const deltaMs = now - prev.ts;
    const tokensPerMin = deltaMs > 0 ? (deltaTokens / deltaMs) * 60000 : 0;

    // Update scoreboard
    if (tokens > 0) {
      const displayK = Math.round(tokens / 100); // tokens in hundreds
      await rcon(`scoreboard players set ${agentName} tokens_used ${displayK}`);
    }

    // Update plot block based on activity
    const plot = AGENT_PLOTS[agentName];
    if (plot && deltaTokens > 0) {
      const block = getStatusBlock(tokensPerMin);
      await rcon(`setblock ${plot[0]} ${plot[1]} ${plot[2]} ${block}`);
      updates.push(`${agentName}: +${deltaTokens}tok (${Math.round(tokensPerMin)}/min)`);
    }

    state[agentName] = { tokens, ts: now };
    await new Promise(r => setTimeout(r, 200)); // rate limit
  }

  saveState(state);

  if (updates.length > 0) {
    console.log(`[TOKEN BRIDGE] ${new Date().toISOString()} Synced: ${updates.join(' | ')}`);
  } else {
    console.log(`[TOKEN BRIDGE] ${new Date().toISOString()} No new token activity`);
  }
}

// Run immediately then every 2 minutes
sync().catch(console.error);
setInterval(() => sync().catch(console.error), 2 * 60 * 1000);
console.log('[TOKEN BRIDGE] Started — syncing real tokens → MC scoreboard every 2 min');
