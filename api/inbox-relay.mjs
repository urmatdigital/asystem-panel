/**
 * Inbox Relay — Forge processes dispatch files for offline/LXC agents
 * Converts inbox files → OpenClaw gateway calls OR Convex task creation
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HOME = process.env.HOME || '/Users/urmatmyrzabekov';
const INBOX = path.join(HOME, '.openclaw/workspace/tasks/inbox');
const DONE  = path.join(HOME, '.openclaw/workspace/tasks/done');
const API   = 'http://127.0.0.1:5190';

// LXC agent gateway map
const AGENT_GATEWAYS = {
  dana:    { url: 'http://100.114.5.104:18789',  token: 'dana-pve2-2026-1b9cb2394b15' },
  nurlan:  { url: 'http://100.83.188.95:18789',   token: 'nurlan-pve2-2026-b7f23a918c44' },
  bekzat:  { url: 'http://100.66.219.32:18789',   token: 'bekzat-pve2-2026-aceca388538a' },
  ainura:  { url: 'http://100.112.184.63:18789',  token: 'ainura-pve2-2026-98b2cf94456f' },
  marat:   { url: 'http://100.107.171.121:18789', token: 'marat-pve2-2026-70bd808f3957' },
  atlas:   { url: 'http://100.68.144.79:18789',   token: 'atlas-proxmox-vm216-77f69ebeec37f60bd7324cf9' },
  iron:    { url: 'http://100.114.136.87:18789',  token: 'iron-vps-c01d6818d635d80523bbb355' },
  mesa:    { url: 'http://100.100.40.27:18789',   token: null },
};

fs.mkdirSync(INBOX, { recursive: true });
fs.mkdirSync(DONE,  { recursive: true });

async function sendToGateway(agent, message, token, gwUrl) {
  const body = JSON.stringify({
    message,
    from: 'forge',
    model: 'anthropic/claude-haiku-4-5',
  });
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`${gwUrl}/api/message`, { method: 'POST', headers, body, signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { clearTimeout(t); return false; }
}

async function processFile(file) {
  const filePath = path.join(INBOX, file);
  let task;
  try { task = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return; }

  const { to, title, body, task_id, source } = task;
  if (!to || !title) { fs.renameSync(filePath, path.join(DONE, file)); return; }

  // Skip forge-to-forge (self)
  if (to === 'forge') { fs.renameSync(filePath, path.join(DONE, file)); return; }

  const gw = AGENT_GATEWAYS[to];
  if (!gw) { fs.renameSync(filePath, path.join(DONE, file)); return; }

  console.log(`[Relay] ${to} ← "${title.slice(0,50)}"`);

  const msg = `📬 Task from Forge:\n**${title}**\n\n${body || ''}\n\nTask ID: ${task_id || 'N/A'}\nSource: ${source || 'relay'}`;
  const ok = await sendToGateway(to, msg, gw.token, gw.url);

  if (ok) {
    console.log(`[Relay] ✅ Delivered to ${to}`);
  } else {
    console.warn(`[Relay] ⚠️ ${to} offline — Forge will handle via dispatch`);
    // Fallback: dispatch to forge for handling + mark as in Convex with note
    try {
      await fetch('https://expert-dachshund-299.convex.cloud/api/mutation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'tasks:create', args: {
          title: `[RELAY→${to.toUpperCase()}] ${title}`,
          description: `Original for: ${to}\n\n${body || ''}`,
          agent: 'forge',
          status: 'todo', priority: 'medium', type: 'task',
        }}),
      });
      console.log(`[Relay] ↩️ Redirected to forge queue`);
    } catch {}
  }

  fs.renameSync(filePath, path.join(DONE, file));
}

async function scanInbox() {
  try {
    const files = fs.readdirSync(INBOX).filter(f => f.endsWith('.json'));
    if (files.length > 0) console.log(`[Relay] ${files.length} file(s) in inbox`);
    for (const file of files) {
      await processFile(file);
      await new Promise(r => setTimeout(r, 200)); // throttle
    }
  } catch (e) { console.error('[Relay] scan error:', e.message); }
}

console.log('[Relay] 📡 Inbox relay started — scanning every 30s');
scanInbox();
setInterval(scanInbox, 30_000);
