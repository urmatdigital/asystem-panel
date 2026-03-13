/**
 * a2a.mjs — Lightweight Agent2Agent Protocol for ASYSTEM
 *
 * Google A2A pattern: structured message envelopes + AgentCard registry.
 * Enables bidirectional agent communication (not just fire-and-forget dispatch).
 *
 * Endpoints (registered in server.mjs):
 *   GET  /api/a2a/agents           — list all AgentCards (with optional ?capability= filter)
 *   GET  /api/a2a/agents/:id       — get single AgentCard
 *   POST /api/a2a/send             — send A2A message envelope to target agent
 *   GET  /api/a2a/inbox/:agentId   — poll unread A2A messages for agent
 *
 * Message Envelope (A2A standard):
 * {
 *   id:        string,           // unique message id
 *   from:      string,           // sender agentId
 *   to:        string,           // recipient agentId
 *   message: { parts: [{ kind: "text", text: "..." }] },
 *   reply_to:  string|null,      // message id being replied to
 *   await:     boolean,          // true = synchronous (wait for reply)
 *   created:   ISO timestamp
 * }
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { createHash } from 'node:crypto';

const HOME = os.homedir();
const MANIFESTS_DIR = path.join(HOME, 'projects/ASYSTEM/api/agent-manifests');
const A2A_INBOX_DIR = path.join(HOME, '.openclaw/workspace/a2a-inbox');
const A2A_LOG_FILE  = path.join(HOME, '.openclaw/workspace/audit-log.jsonl');

// Agent network routing (IP → gateway port)
const AGENT_NETWORK = {
  forge:  { ip: '100.87.107.50',  port: 18789, method: 'gateway' },
  atlas:  { ip: '100.68.144.79',  port: 18789, method: 'gateway' },
  iron:   { ip: '100.114.136.87', port: 18789, method: 'gateway' },
  mesa:   { ip: '100.100.40.27',  port: 18789, method: 'gateway' },
  pixel:  { ip: '100.99.197.46',  port: 18789, method: 'gateway' },
  dana:   { ip: '100.114.5.104',  port: 18789, method: 'gateway' },
  nurlan: { ip: '100.83.188.95',  port: 18789, method: 'gateway' },
  ainura: { ip: '100.112.184.63', port: 18789, method: 'gateway' },
  marat:  { ip: '100.107.171.121',port: 18789, method: 'gateway' },
  bekzat: { ip: '100.66.219.32',  port: 18789, method: 'gateway' },
};

// Gateway tokens per agent (from MEMORY.md)
const GATEWAY_TOKENS = {
  atlas:  'atlas-proxmox-vm216-77f69ebeec37f60bd7324cf9',
  iron:   'iron-vps-c01d6818d635d80523bbb355',
  dana:   'dana-pve2-2026-1b9cb2394b15',
  nurlan: 'nurlan-pve2-2026-b7f23a918c44',
  ainura: 'ainura-pve2-2026-98b2cf94456f',
  marat:  'marat-pve2-2026-70bd808f3957',
  pixel:  'design-pixel-2026',
};

// ── Load AgentCards from YAML manifests ──────────────────────────────────────
function loadAgentCard(agentId) {
  try {
    const yamlPath = path.join(MANIFESTS_DIR, `${agentId}.yaml`);
    const raw = fs.readFileSync(yamlPath, 'utf8');
    // Simple YAML parser for our flat structure (no deps)
    const card = { id: agentId, capabilities: [], skills: [], projects: [] };
    let inBlock = null;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (trimmed === 'capabilities:') { inBlock = 'capabilities'; continue; }
      if (trimmed === 'skills:' || trimmed === 'projects:') { inBlock = trimmed.replace(':', ''); continue; }
      if (/^[a-z_]+:/.test(trimmed) && !trimmed.startsWith('-')) { inBlock = null; }
      if (inBlock && trimmed.startsWith('- ')) {
        card[inBlock].push(trimmed.slice(2).replace(/['"]/g, ''));
        continue;
      }
      const [key, ...rest] = trimmed.split(':');
      if (!inBlock && rest.length) {
        card[key.trim()] = rest.join(':').trim().replace(/['"#].*/g, '').trim();
      }
    }
    card.network = AGENT_NETWORK[agentId] || null;
    card.online = card.status !== 'offline' && card.status !== 'unstable';
    return card;
  } catch {
    return null;
  }
}

export function getAllAgentCards() {
  const files = fs.readdirSync(MANIFESTS_DIR).filter(f => f.endsWith('.yaml'));
  return files.map(f => loadAgentCard(path.basename(f, '.yaml'))).filter(Boolean);
}

export function getAgentCard(agentId) {
  return loadAgentCard(agentId);
}

// ── A2A Inbox (file-based, local only) ───────────────────────────────────────
function ensureInboxDir() { fs.mkdirSync(A2A_INBOX_DIR, { recursive: true }); }

function getInboxPath(agentId) {
  ensureInboxDir();
  return path.join(A2A_INBOX_DIR, `${agentId}.jsonl`);
}

function writeToInbox(agentId, envelope) {
  const p = getInboxPath(agentId);
  fs.appendFileSync(p, JSON.stringify(envelope) + '\n');
}

export function readInbox(agentId, { unreadOnly = true, limit = 10 } = {}) {
  const p = getInboxPath(agentId);
  try {
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
    const messages = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return unreadOnly ? messages.filter(m => !m.read).slice(-limit) : messages.slice(-limit);
  } catch { return []; }
}

function markRead(agentId, messageId) {
  const p = getInboxPath(agentId);
  try {
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
    const updated = lines.map(l => {
      try { const m = JSON.parse(l); if (m.id === messageId) m.read = true; return JSON.stringify(m); }
      catch { return l; }
    });
    fs.writeFileSync(p, updated.join('\n') + '\n');
  } catch {}
}

// ── Send A2A message to remote agent gateway ──────────────────────────────────
async function sendToGateway(agentId, envelope) {
  const net = AGENT_NETWORK[agentId];
  if (!net) return { ok: false, error: `No network config for ${agentId}` };
  const token = GATEWAY_TOKENS[agentId] || '';
  const url = `http://${net.ip}:${net.port}/api/a2a/receive`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(8000),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Core: send A2A message ────────────────────────────────────────────────────
export async function sendA2AMessage({ from, to, text, replyTo = null, awaitResponse = false }) {
  const id = createHash('sha256').update(`${from}:${to}:${text}:${Date.now()}`).digest('hex').slice(0, 16);
  const envelope = {
    id,
    from,
    to,
    message: { parts: [{ kind: 'text', text }] },
    reply_to: replyTo,
    await: awaitResponse,
    created: new Date().toISOString(),
    read: false,
  };

  // Audit log
  fs.appendFileSync(A2A_LOG_FILE, JSON.stringify({ ts: Date.now(), type: 'a2a.send', from, to, msgId: id, text: text.slice(0, 100) }) + '\n');

  // Local delivery (forge → forge, or any agent on this machine)
  if (to === 'forge' || !AGENT_NETWORK[to]) {
    writeToInbox(to, envelope);
    console.log(`[A2A] 📨 ${from} → ${to} (local inbox): ${text.slice(0, 60)}`);
    return { ok: true, id, delivery: 'local' };
  }

  // Remote delivery via gateway
  const gwResult = await sendToGateway(to, envelope);
  if (gwResult.ok) {
    console.log(`[A2A] 📨 ${from} → ${to} (gateway ${AGENT_NETWORK[to].ip}): ${text.slice(0, 60)}`);
    return { ok: true, id, delivery: 'gateway' };
  }

  // Fallback: write to local inbox anyway (agent will pick up via task inbox relay)
  console.warn(`[A2A] ⚠️ Gateway delivery failed for ${to}, falling back to local inbox`);
  writeToInbox(to, envelope);
  // Also drop into dispatch inbox for agent
  const inboxDir = path.join(HOME, '.openclaw/workspace/tasks/inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(path.join(inboxDir, `a2a-${id}.json`), JSON.stringify({
    task_id: `a2a-${id}`, from, type: 'a2a_message',
    title: `[A2A from ${from}] ${text.slice(0, 80)}`,
    body: text, created: envelope.created, source: 'a2a',
  }, null, 2));
  return { ok: true, id, delivery: 'fallback-inbox', warning: gwResult.error };
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getA2AStats() {
  try {
    const agents = getAllAgentCards().map(c => c.id);
    const inboxes = {};
    for (const a of agents) {
      const msgs = readInbox(a, { unreadOnly: false, limit: 100 });
      inboxes[a] = { total: msgs.length, unread: msgs.filter(m => !m.read).length };
    }
    return { agents: agents.length, inboxes };
  } catch { return {}; }
}
