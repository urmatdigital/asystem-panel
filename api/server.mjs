/**
 * ASYSTEM Live Data API v2.0
 * port 5190 — реальные данные + WebSocket + C-Suite агенты
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { exec, spawn as exec_child_spawn } from 'node:child_process';
import * as narrativeMemory from './narrative-memory.mjs';
import * as requestPipeline from './request-pipeline.mjs';
import * as sessionState from './session-state-simple.mjs';
import * as realtimeSync from './realtime-sync.mjs';
import * as vectorEmbeddings from './vector-embeddings.mjs';
import * as reasoningTraces from './reasoning-traces.mjs';
import * as reflectionLoop from './reflection-loop.mjs';
import * as contextCompression from './context-compression.mjs';
import * as crossSessionLearning from './cross-session-learning.mjs';
import * as confidenceScoring from './confidence-scoring.mjs';
import * as failureRecovery from './failure-recovery.mjs';
import * as entityGraph from './entity-graph.mjs';
import * as anomalyDetection from './anomaly-detection.mjs';
import * as embeddingsML from './embeddings-ml.mjs';
import * as advancedAnalytics from './advanced-analytics.mjs';
import * as distributedCache from './distributed-cache.mjs';

const exec_child = (cmd, opts) => exec_child_spawn('sh', ['-c', cmd], { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });

// Initialize session state on startup
sessionState.initSessionState();

// ── PIPELINE WRAPPER ──────────────────────────────────────────────────
async function withPipeline(req, body, handler) {
  try {
    const pipeline = await requestPipeline.runFullPipeline(req, body);
    
    if (!pipeline.ok) {
      return { code: pipeline.code || 400, body: { ok: false, error: pipeline.error } };
    }
    
    // Attach pipeline context to request for downstream use
    req.pipeline = pipeline.pipeline;
    req.pipelineOptimizer = pipeline.pipeline.optimizer;
    req.pipelineSLA = pipeline.pipeline.sla;
    req.pipelinePersona = pipeline.pipeline.persona;
    
    // Execute actual handler
    return await handler(pipeline);
  } catch (err) {
    console.error('Pipeline error:', err.message);
    return { code: 500, body: { ok: false, error: 'Pipeline processing error' } };
  }
}

// ── Dispatch Rate Limiter — prevents Anthropic 529 overload ──────────────
const dispatchQueue = [];
let dispatchActive = 0;
const DISPATCH_CONCURRENCY = 3;
const DISPATCH_MIN_INTERVAL_MS = 1500; // min 1.5s between dispatches

function queueDispatch(fn) {
  return new Promise((resolve, reject) => {
    dispatchQueue.push({ fn, resolve, reject });
    drainDispatchQueue();
  });
}

async function drainDispatchQueue() {
  if (dispatchActive >= DISPATCH_CONCURRENCY || dispatchQueue.length === 0) return;
  dispatchActive++;
  const { fn, resolve, reject } = dispatchQueue.shift();
  await new Promise(r => setTimeout(r, DISPATCH_MIN_INTERVAL_MS * (dispatchActive - 1)));
  try { resolve(await fn()); } catch (e) { reject(e); }
  finally {
    dispatchActive--;
    setTimeout(drainDispatchQueue, DISPATCH_MIN_INTERVAL_MS);
  }
}

import { promisify } from 'node:util';
import os from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';

// ── C-Suite Agents Config ──────────────────────────────────────────────
// IPs verified from: `tailscale status` 2026-03-07
const CSUITE_AGENTS = [
  { id: 'forge', name: 'Forge',  role: 'COO', roleLabel: 'Chief Operations Officer',    ip: '127.0.0.1',      isSelf: true,  color: '#06b6d4', telegram: '@forge_bot',          gatewayPort: 18789 },
  { id: 'atlas', name: 'Atlas',  role: 'CTO', roleLabel: 'Chief Technology Officer',    ip: '100.68.144.79',  isSelf: false, color: '#f59e0b', telegram: '@openclaw_bot',        gatewayPort: 18789 },
  { id: 'iron',  name: 'IRON',   role: 'CSO', roleLabel: 'Chief Security Officer',      ip: '100.114.136.87', isSelf: false, color: '#ef4444', telegram: '@iron_contabo_bot',    gatewayPort: 18789 },
  { id: 'mesa',  name: 'MESA',   role: 'CFO', roleLabel: 'Chief Analytics Officer',     ip: '100.100.40.27',  isSelf: false, color: '#8b5cf6', telegram: '@Mesa_Asystembot',     gatewayPort: 18789 },
  { id: 'titan', name: 'Titan',  role: 'CIO', roleLabel: 'Chief Infrastructure Officer', ip: '100.83.105.111', isSelf: false, color: '#f97316', telegram: '@proxmox_titan_bot',   gatewayPort: 18789 },
  { id: 'pixel', name: 'PIXEL',  role: 'CMO', roleLabel: 'Chief Creative Officer',       ip: '10.10.10.53',   isSelf: false, color: '#ec4899', telegram: null,                   gatewayPort: 18789 },
];

const USER_HOME_DIR = process.env.HOME || '/Users/urmatmyrzabekov';
const TASK_DONE_DIR = path.join(USER_HOME_DIR, '.openclaw/workspace/tasks/done');

// Load .env vars if not already set
try {
  const envLines = fs.readFileSync(path.join(USER_HOME_DIR, '.openclaw/.env'), 'utf8').split('\n');
  for (const line of envLines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {}

// ── WebSocket ──────────────────────────────────────────────────────────
let wss = null;
const broadcast = (data) => {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
};

// ── Agent status cache ─────────────────────────────────────────────────
let agentCache = {};
let agentCacheTs = 0;
const AGENT_TTL = 15000;
// Per-agent last-seen tracker (updated every fetchAgentStatus cycle)
const agentLastSeen = {}; // agentId -> { ts: epoch, latencyMs }

async function fetchAgentStatus() {
  const now = Date.now();
  if (now - agentCacheTs < AGENT_TTL) return agentCache;
  agentCacheTs = now;

  const checkAgent = async (agent) => {
    let online = false;
    let gatewayOk = false;
    let latencyMs = null;

    if (agent.isSelf) {
      // Forge is self — always online, check own gateway
      online = true;
      try {
        const t0 = Date.now();
        await new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('timeout')), 1500);
          http.get(`http://127.0.0.1:${agent.gatewayPort}/`, (r) => {
            clearTimeout(timer);
            gatewayOk = r.statusCode < 500;
            latencyMs = Date.now() - t0;
            r.resume(); res();
          }).on('error', rej);
        });
      } catch { gatewayOk = true; } // self is always reachable even if gateway port differs
    } else {
      // Remote agents — use gateway HTTP check directly (faster + more reliable than ICMP)
      // macOS ping -W is in ms but ICMP often blocked on VPN; HTTP check is better
      const t0 = Date.now();
      try {
        await new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('timeout')), 4000);
          http.get(`http://${agent.ip}:${agent.gatewayPort}/`, (r) => {
            clearTimeout(timer);
            latencyMs = Date.now() - t0;
            online = true;
            gatewayOk = r.statusCode < 500;
            r.resume(); res();
          }).on('error', () => { clearTimeout(timer); rej(new Error('connection refused')); });
        });
      } catch {
        // Fallback: Tailscale ping (non-blocking, quick)
        try {
          await new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('ts timeout')), 3000);
            exec(`/Applications/Tailscale.app/Contents/MacOS/Tailscale ping -c 1 --timeout 2s ${agent.ip} 2>/dev/null`, (err, stdout) => {
              clearTimeout(timer);
              if (!err && stdout.includes('pong')) { online = true; latencyMs = parseInt(stdout.match(/(\d+)ms/)?.[1] ?? '0'); }
              res();
            });
          });
        } catch {}
      }
    }

    return { ...agent, online, gatewayOk, latencyMs, checkedAt: now };
  };

  const results = await Promise.all(CSUITE_AGENTS.map(a => checkAgent(a)));

  // Enrich with active tasks from Convex
  try {
    const _convexCloud2 = 'https://expert-dachshund-299.convex.cloud';
    const txRes = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 5000);
      https.get(`${convexSite}/agent/tasks/active`, { headers: { 'Accept': 'application/json' } }, r => {
        clearTimeout(timer);
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
      }).on('error', e => { clearTimeout(timer); reject(e); });
    });
    const activeTasks = txRes.tasks ?? [];
    // Map by agent id
    const taskByAgent = {};
    for (const t of activeTasks) {
      if (t.agent && !taskByAgent[t.agent]) taskByAgent[t.agent] = t;
    }
    // Inject into results
    for (const agent of results) {
      if (taskByAgent[agent.id]) {
        agent.task = { id: taskByAgent[agent.id]._id, title: taskByAgent[agent.id].title, status: taskByAgent[agent.id].status, priority: taskByAgent[agent.id].priority };
      } else {
        agent.task = null;
      }
    }
  } catch {
    // Convex unavailable — leave task as null
    for (const agent of results) agent.task = null;
  }

  // Update per-agent last-seen
  for (const a of results) {
    if (a.online) agentLastSeen[a.id] = { ts: now, latencyMs: a.latencyMs };
  }
  // Inject lastSeenSecs into each agent
  for (const a of results) {
    const ls = agentLastSeen[a.id];
    a.lastSeenSecs = ls ? Math.round((now - ls.ts) / 1000) : null;
    a.lastSeenLatency = ls?.latencyMs ?? null;
  }
  agentCache = { agents: results, ts: now };
  return agentCache;
}

// ── Inbox reader ───────────────────────────────────────────────────────
function readInbox(limit = 20) {
  try {
    if (!fs.existsSync(TASK_DONE_DIR)) return [];
    const files = fs.readdirSync(TASK_DONE_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const raw = fs.readFileSync(path.join(TASK_DONE_DIR, f), 'utf8');
          return JSON.parse(raw);
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.completed_at || b.received_at || 0) - new Date(a.completed_at || a.received_at || 0));
    return files.slice(0, limit);
  } catch { return []; }
}

// ── Watch task inbox ───────────────────────────────────────────────────
function watchInbox() {
  try {
    if (!fs.existsSync(TASK_DONE_DIR)) {
      fs.mkdirSync(TASK_DONE_DIR, { recursive: true });
    }
    fs.watch(TASK_DONE_DIR, (eventType, filename) => {
      if (eventType === 'rename' && filename?.endsWith('.json')) {
        setTimeout(() => {
          try {
            const fpath = path.join(TASK_DONE_DIR, filename);
            if (fs.existsSync(fpath)) {
              const task = JSON.parse(fs.readFileSync(fpath, 'utf8'));
              broadcast({ type: 'inbox', task });
              console.log(`[WS] New task from ${task.from}: ${task.title}`);
            }
          } catch {}
        }, 200);
      }
    });
    console.log('[Inbox] Watching', TASK_DONE_DIR);
  } catch (e) {
    console.warn('[Inbox] Watch failed:', e.message);
  }
}

// ── Polling scheduler ─────────────────────────────────────────────────
function startPolling() {
  // Agent status every 15s
  setInterval(async () => {
    agentCacheTs = 0; // force refresh
    const data = await fetchAgentStatus();
    broadcast({ type: 'agents', data });
  }, 15000);

  console.log('[Polling] Agent status every 15s');
}

// ── AgentMail ──────────────────────────────────────────────────────────
const AGENTMAIL_KEY = 'am_us_b598717c387b09321cc1482df6faacdf5ce61646223da10e94cb662f20726458';
const AGENTMAIL_INBOXES = [
  { id: 'orch', address: 'asystem-orch@agentmail.to', label: 'ORCH', color: '#f59e0b' },
  { id: 'mesa', address: 'asystem-mesa@agentmail.to', label: 'MESA', color: '#8b5cf6' },
  { id: 'ai',   address: 'asystem-ai@agentmail.to',   label: 'AI',   color: '#06b6d4' },
];

const apiGet = (url) => new Promise((resolve, reject) => {
  https.get(url, { headers: { Authorization: `Bearer ${AGENTMAIL_KEY}`, 'Content-Type': 'application/json' } }, res => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
  }).on('error', reject);
});

// Mayor Console — задачи агентам (in-memory queue)
const mayorQueue = [];

const execAsync = promisify(exec);
const PORT = 5190;

// ── Helpers ────────────────────────────────────────────────────────────
const SSH_OPTS = '-o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes';
const USER_HOME = process.env.HOME || '/Users/urmatmyrzabekov';

const run = async (cmd, fallback = '') => {
  try { const { stdout } = await execAsync(cmd, { timeout: 10000, env: { ...process.env, HOME: USER_HOME } }); return stdout.trim(); }
  catch { return fallback; }
};
// Используем $'...' (ANSI-C quoting) чтобы избежать конфликтов кавычек
const ssh = (host, cmd, fallback = '') => run(`ssh ${SSH_OPTS} ${host} $'${cmd.replace(/'/g, "'\\''")}' 2>/dev/null`, fallback);

const cpuPercent = () => {
  const cpus = os.cpus();
  const total = cpus.reduce((s, c) => {
    const t = Object.values(c.times).reduce((a, b) => a + b, 0);
    return { idle: s.idle + c.times.idle, total: s.total + t };
  }, { idle: 0, total: 0 });
  return Math.round((1 - total.idle / total.total) * 100);
};

// ── Cache ──────────────────────────────────────────────────────────────
let cache = {};
let lastFetch = 0;
const CACHE_TTL = 8000; // 8 секунд

async function fetchData() {
  const now = Date.now();
  if (now - lastFetch < CACHE_TTL) return cache;
  lastFetch = now;

  // Параллельно получаем все данные
  const RAM_CMD  = "free -m | awk '/^Mem/ {printf \"%d/%d\", $3, $2}'";
  const CPU_CMD  = "vmstat 1 1 | tail -1 | awk '{print 100-$15}'";
  const LOAD_CMD = "cat /proc/loadavg | cut -d' ' -f1";
  const UP_CMD   = "awk '{d=int($1/86400);h=int($1%86400/3600);m=int($1%3600/60);printf \"%dd %dh %dm\",d,h,m}' /proc/uptime";
  const GIT_CMD  = (path) => `cd ${path} && git log -1 --format="%s" 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null && git status --porcelain 2>/dev/null | wc -l`;

  const [
    mesaCpu, mesaRam, mesaLoad, mesaUptime,
    kaliasCpu, kaliasRam, kaliasLoad, kaliasUptime,
    gulnaraCpu, gulnaraRam,
    aizatCpu, aizatRam,
    designCpu, designRam,
    gitOrgon, gitAurwa, gitVoltera, gitFiatex, gitTwinbridge,
  ] = await Promise.all([
    ssh('mesa',    CPU_CMD,  '0'),
    ssh('mesa',    RAM_CMD,  '0/0'),
    ssh('mesa',    LOAD_CMD, '0.00'),
    ssh('mesa',    UP_CMD,   'unknown'),
    ssh('kalias',  CPU_CMD,  '0'),
    ssh('kalias',  RAM_CMD,  '0/0'),
    ssh('kalias',  LOAD_CMD, '0.00'),
    ssh('kalias',  UP_CMD,   'unknown'),
    ssh('gulnara', CPU_CMD,  '0'),
    ssh('gulnara', RAM_CMD,  '0/0'),
    ssh('aizat',   CPU_CMD,  '0'),
    ssh('aizat',   RAM_CMD,  '0/0'),
    ssh('design',  CPU_CMD,  '0'),
    ssh('design',  RAM_CMD,  '0/0'),
    run(GIT_CMD('~/projects/ORGON'),          ''),
    run(GIT_CMD('~/projects/AURWA'),          ''),
    run(GIT_CMD('~/projects/Voltera-mobile'), ''),
    run(GIT_CMD('~/projects/fiatexkg'),       ''),
    run(GIT_CMD('~/projects/ASYSTEM'),        ''),
  ]);

  // Mac-mini CPU/RAM из os module
  const macRamUsed = Math.round((os.totalmem() - os.freemem()) / 1024 / 1024);
  const macRamTotal = Math.round(os.totalmem() / 1024 / 1024);
  const macCpu = cpuPercent();
  const macLoad = os.loadavg()[0].toFixed(2);

  // RAM parser
  const parseRam = (raw) => {
    const [used, total] = (raw || '0/0').split('/').map(Number);
    return { used: used || 0, total: total || 0, pct: total > 0 ? Math.round(used / total * 100) : 0 };
  };
  const parseGit = (raw) => {
    if (!raw) return { commit: '—', branch: 'main', changes: 0 };
    const lines = raw.split('\n').filter(Boolean);
    return { commit: lines[0] || '—', branch: lines[1] || 'main', changes: parseInt(lines[2]) || 0 };
  };

  const mesaR    = parseRam(mesaRam);
  const kaliasR  = parseRam(kaliasRam);
  const gulnaraR = parseRam(gulnaraRam);
  const aizatR   = parseRam(aizatRam);
  const designR  = parseRam(designRam);

  cache = {
    ts: now,
    nodes: {
      macmini: {
        id: 'macmini', label: 'MAC-MINI', ip: '100.87.107.50', role: 'orchestrator',
        cpu: macCpu, ram: Math.round(macRamUsed / macRamTotal * 100),
        ramUsed: macRamUsed, ramTotal: macRamTotal,
        load: parseFloat(macLoad), uptime: os.uptime(), online: true,
      },
      mesa: {
        id: 'mesa', label: 'MESA-SIM', ip: '100.100.40.27', role: 'analytics',
        cpu: parseInt(mesaCpu) || 0, ram: mesaR.pct,
        ramUsed: mesaR.used, ramTotal: mesaR.total,
        load: parseFloat(mesaLoad) || 0, uptime: mesaUptime, online: mesaR.total > 0,
      },
      kalias: {
        id: 'kalias', label: 'KALIAS', ip: '100.87.38.53', role: 'security',
        cpu: parseInt(kaliasCpu) || 0, ram: kaliasR.pct,
        ramUsed: kaliasR.used, ramTotal: kaliasR.total,
        load: parseFloat(kaliasLoad) || 0, uptime: kaliasUptime, online: kaliasR.total > 0,
      },
      gulnara: {
        id: 'gulnara', label: 'GULNARA', ip: '10.10.10.51', role: 'tax',
        cpu: parseInt(gulnaraCpu) || 0, ram: gulnaraR.pct,
        ramUsed: gulnaraR.used, ramTotal: gulnaraR.total,
        load: 0, uptime: '—', online: gulnaraR.total > 0,
      },
      design: {
        id: 'design', label: 'PIXEL-VM', ip: '10.10.10.53', role: 'design',
        cpu: parseInt(designCpu) || 0, ram: designR.pct,
        ramUsed: designR.used, ramTotal: designR.total,
        load: 0, uptime: '—', online: designR.total > 0,
      },
      aizat: {
        id: 'aizat', label: 'AIZAT', ip: '10.10.10.52', role: 'legal',
        cpu: parseInt(aizatCpu) || 0, ram: aizatR.pct,
        ramUsed: aizatR.used, ramTotal: aizatR.total,
        load: 0, uptime: '—', online: aizatR.total > 0,
      },
    },
    projects: {
      orgon:      { id: 'orgon',      path: '~/projects/ORGON',          ...parseGit(gitOrgon) },
      aurwa:      { id: 'aurwa',      path: '~/projects/AURWA',          ...parseGit(gitAurwa) },
      voltera:    { id: 'voltera',    path: '~/projects/Voltera-mobile', ...parseGit(gitVoltera) },
      fiatex:     { id: 'fiatex',     path: '~/projects/fiatexkg',       ...parseGit(gitFiatex) },
      twinbridge: { id: 'twinbridge', path: '~/projects/ASYSTEM',        ...parseGit(gitTwinbridge) },
      bridgex:    { id: 'bridgex',    path: '~/projects/bridgex',        commit: '—', branch: 'main', changes: 0 },
    },
  };
  return cache;
}

// ── HTTP Server ────────────────────────────────────────────────────────
// ── AgentMail cache ───────────────────────────────────────────────────
let mailCache = { ts: 0, messages: [] };
const MAIL_TTL = 60_000; // 1 минута

async function fetchMail() {
  const now = Date.now();
  if (now - mailCache.ts < MAIL_TTL) return mailCache;
  mailCache.ts = now;

  const results = [];
  for (const inbox of AGENTMAIL_INBOXES) {
    try {
      const data = await apiGet(`https://api.agentmail.to/v0/inboxes/${inbox.address}/threads?limit=5`);
      const threads = data?.threads || data?.items || [];
      for (const thread of threads.slice(0, 3)) {
        results.push({
          id: thread.id,
          inbox: inbox.id,
          inboxLabel: inbox.label,
          color: inbox.color,
          subject: thread.subject || thread.title || '(no subject)',
          from: thread.from || thread.sender || '?',
          ts: thread.lastMessageAt || thread.createdAt || thread.ts || now,
          preview: (thread.snippet || thread.preview || '').slice(0, 80),
        });
      }
    } catch { /* inbox unavailable */ }
  }
  // Sort newest first
  results.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  mailCache.messages = results;
  return mailCache;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // ── PIPELINE PROCESSING ──
  // Apply pipeline to POST/PATCH/PUT requests with body
  if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
    let body = {};
    try {
      body = await parseJSON(req);
    } catch {
      body = {};
    }
    
    const pipeline = await requestPipeline.runFullPipeline(req, body).catch(err => ({ ok: false, error: err.message }));
    
    if (!pipeline.ok) {
      res.writeHead(pipeline.code || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: pipeline.error }));
      return;
    }
    
    // Attach pipeline context for handlers
    req.pipeline = pipeline.pipeline;
    req.pipelineOptimizer = pipeline.pipeline.optimizer;
    req.pipelineSLA = pipeline.pipeline.sla;
    req.pipelinePersona = pipeline.pipeline.persona;
    req.pipelineTrace = pipeline.pipeline.trace.traceId;
  }

  // ── Prometheus metrics (no auth) ──
  const urlPath0 = req.url.split('?')[0];
  if (urlPath0 === '/api/metrics') {
    const uptime = Math.round(process.uptime());
    const mem = process.memoryUsage();
    const metrics = [
      '# TYPE forge_up gauge', 'forge_up 1',
      '# TYPE forge_uptime_seconds gauge', `forge_uptime_seconds ${uptime}`,
      '# TYPE forge_memory_heap_bytes gauge', `forge_memory_heap_bytes ${mem.heapUsed}`,
    ].join('\n') + '\n';
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', 'Access-Control-Allow-Origin': '*' });
    return res.end(metrics);
  }

  // ── Netdata Proxy (early — before auth chain) ─────────────────────
  if (urlPath0.startsWith('/api/netdata/')) {
    const nd = urlPath0.replace('/api/netdata', '');
    const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    try {
      const r = await fetch(`http://localhost:19999${nd}${qs}`, { signal: AbortSignal.timeout(5000) });
      const d = await r.json();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
      return res.end(JSON.stringify(d));
    } catch (e) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: 'Netdata unavailable', detail: e.message }));
    }
  }

  if (req.url === '/api/live' || req.url === '/api/live/') {
    try {
      const data = await fetchData();
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(e) }));
    }

  } else if (req.url === '/api/mail' || req.url === '/api/mail/') {
    try {
      const data = await fetchMail();
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(e) }));
    }

  } else if (req.url === '/api/mayor' && req.method === 'POST') {
    // Mayor Console: queue a task for a project
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const task = JSON.parse(body);
        task.id = Date.now();
        task.status = 'queued';
        task.ts = new Date().toISOString();
        mayorQueue.unshift(task);
        if (mayorQueue.length > 20) mayorQueue.length = 20;
        console.log(`[Mayor] Task queued: ${task.project} — ${task.message}`);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, task }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'bad json' }));
      }
    });

  } else if (req.url === '/api/mayor' || req.url === '/api/mayor/') {
    res.writeHead(200);
    res.end(JSON.stringify({ queue: mayorQueue }));

  } else if (req.url === '/api/pings' || req.url === '/api/pings/') {
    // Ping all Tailscale nodes
    const pingTargets = [
      { id: 'mac-mini',     ip: '100.87.107.50'  },
      { id: 'mesa-sim',     ip: '100.100.40.27'  },
      { id: 'kalias',       ip: '100.87.38.53'   },
      { id: 'titan',        ip: '100.83.105.111' },
      { id: 'atlas',        ip: '100.68.144.79'  },
      { id: 'coolify',      ip: '100.104.98.67'  },
      { id: 'onlyoffice',   ip: '100.76.181.84'  },
      { id: 'docling',      ip: '100.69.12.99'   },
      { id: 'orgon-1',      ip: '100.84.150.124' },
      { id: 'gulnara',      ip: '100.68.144.79'  },
      { id: 'aizat',        ip: '10.10.10.52',   via: 'ssh' },
      { id: 'pixel-vm',     ip: '10.10.10.53',   via: 'ssh' },
    ];
    const pingOne = (t) => new Promise(resolve => {
      const start = Date.now();
      exec(`/sbin/ping -c 1 ${t.ip} 2>/dev/null`, { shell: true, timeout: 5000 }, (err, stdout) => {
        const ms = err ? null : (() => {
          const m = stdout.match(/time[=<](\d+\.?\d*)/);
          return m ? parseFloat(m[1]) : null;
        })();
        resolve({ id: t.id, ip: t.ip, ms, ok: ms !== null, network: t.ip.startsWith('10.') ? 'proxmox' : 'tailscale' });
      });
    });
    try {
      const results = await Promise.all(pingTargets.map(t => pingOne(t)));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ pings: results, ts: Date.now() }));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (req.url === '/health' || req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()), ts: Date.now() }));

  }
  // NOTE: no catch-all 404 here — v2 handler (server.on('request')) handles remaining routes
});

// ── New v2 endpoints ──────────────────────────────────────────────────
// ── Veritas Proxy ──────────────────────────────────────────────────────
const VERITAS_ADMIN_KEY = (() => {
  try {
    const env = fs.readFileSync(path.join('/Users/urmatmyrzabekov', 'projects/veritas/server/.env'), 'utf8');
    const m = env.match(/VERITAS_ADMIN_KEY=(.+)/);
    return m ? m[1].trim() : '';
  } catch { return ''; }
})();

async function proxyVeritas(req, res) {
  const target = `http://localhost:3002${req.url.replace(/^\/api\/veritas/, '')}`;
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? Buffer.concat(chunks) : null;
      const options = {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': VERITAS_ADMIN_KEY,
          ...(body ? { 'Content-Length': body.length } : {}),
        },
      };
      const vReq = http.request(target, options, (vRes) => {
        const data = [];
        vRes.on('data', c => data.push(c));
        vRes.on('end', () => {
          res.writeHead(vRes.statusCode, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
          });
          res.end(Buffer.concat(data));
          resolve(true);
        });
      });
      vReq.on('error', () => {
        res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Veritas backend unavailable' }));
        resolve(true);
      });
      if (body) vReq.write(body);
      vReq.end();
    });
  });
}

const handleV2 = async (req, res) => {
  const url = req.url.split('?')[0];
  const urlPath = url;  // alias — some handlers use urlPath
  const params = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');

  // ── BlueMap proxy → /bluemap/* → BlueMap on VM 105 via Tailscale ──────
  if (url.startsWith('/bluemap')) {
    const bmPath = url.replace('/bluemap', '') || '/';
    console.log('[BlueMap] Handling request:', bmPath);
    const bmSocket = net.createConnection({ host: '100.79.117.102', port: 8124, timeout: 30000 });
    let headersDone = false;
    let buf = Buffer.alloc(0);
    bmSocket.on('connect', () => {
      const reqLine = `GET ${bmPath || '/'} HTTP/1.0\r\n`;
      const hdrs = `Host: 100.79.117.102:8124\r\nConnection: close\r\nAccept: */*\r\nAccept-Encoding: identity\r\n\r\n`;
      bmSocket.write(reqLine + hdrs);
    });
    bmSocket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!headersDone) {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep === -1) return;
        headersDone = true;
        const headerStr = buf.slice(0, sep).toString();
        const body = buf.slice(sep + 4);
        buf = Buffer.alloc(0);
        const statusMatch = headerStr.match(/HTTP\/[\d.]+ (\d+)/);
        const statusCode = statusMatch ? parseInt(statusMatch[1]) : 200;
        const headers = { 'access-control-allow-origin': '*' };
        for (const line of headerStr.split('\r\n').slice(1)) {
          const idx = line.indexOf(': ');
          if (idx > 0) {
            const k = line.slice(0, idx).toLowerCase();
            if (!['transfer-encoding','connection'].includes(k)) headers[k] = line.slice(idx + 2);
          }
        }
        console.log('[BlueMap] Responding', statusCode, 'body start:', body.length);
        res.writeHead(statusCode, headers);
        if (body.length > 0) res.write(body);
      } else {
        res.write(chunk);
      }
    });
    bmSocket.on('end', () => { console.log('[BlueMap] Done'); try { res.end(); } catch {} });
    bmSocket.on('error', e => { console.error('[BlueMap] Error:', e.message); if (!res.headersSent) { res.writeHead(502); } try { res.end('BlueMap error'); } catch {} });
    bmSocket.on('timeout', () => { bmSocket.destroy(); try { res.end(); } catch {} });
    req.on('close', () => bmSocket.destroy());
    return true;
  }

  // ── OliveTin Ops Panel proxy → /ops/* → localhost:1337 ──────────────
  if (req.url.startsWith('/ops')) {
    const targetPath = req.url.replace(/^\/ops/, '') || '/';
    const proxyReq = http.request({
      host: 'localhost', port: 1337,
      path: targetPath,
      method: req.method,
      headers: { ...req.headers, host: 'localhost:1337' }
    }, (proxyRes) => {
      // Fix absolute redirects
      const headers = { ...proxyRes.headers };
      if (headers.location && headers.location.startsWith('/')) {
        headers.location = '/ops' + headers.location;
      }
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('OliveTin not available (localhost:1337)');
    });
    req.pipe(proxyReq);
    return true;
  }

  // Proxy Veritas Kanban API
  if (url.startsWith('/api/veritas/')) {
    return proxyVeritas(req, res);
  }

  if (url === '/api/agents') {
    const data = await fetchAgentStatus();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(data));
  }

  // Manual heartbeat trigger
  if (url === '/api/agents/heartbeat' && req.method === 'POST') {
    runHeartbeatScan().catch(() => {});
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ ok: true, msg: 'heartbeat scan triggered' }));
  }

  if (url === '/api/inbox') {
    const inbox = readInbox();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ inbox, ts: Date.now() }));
  }

  if (url === '/api/swarms') {
    try {
      const raw = await ssh('100.87.107.50', 'cd ~/projects/gastown && ov status --json 2>/dev/null || echo \'{"agents":[],"worktrees":0}\'', '{"agents":[]}');
      let parsed = {};
      try { parsed = JSON.parse(raw); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ swarms: [], ovStatus: parsed, ts: Date.now() }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ swarms: [], ts: Date.now() }));
    }
  }

  if (url === '/api/issues') {
    try {
      const raw = await ssh('100.87.107.50', 'cd ~/projects/gastown && sd list 2>/dev/null | head -50', '');
      const issues = raw.split('\n').filter(l => l.startsWith('-')).map((l, i) => {
        const m = l.match(/^- (\S+) · (.+?) \s+\[(\w+) · (\w+)\]/);
        if (!m) return null;
        const [, id, title, priority, type] = m;
        return { id, title: title.trim(), priority: 2, type: type || 'task', status: 'open', assignee: 'forge' };
      }).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ issues, ts: Date.now() }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ issues: [], ts: Date.now() }));
    }
  }

  // ── Daily Standup ────────────────────────────────────────────────
  if (url === '/api/standup' && req.method === 'GET') {
    try {
      const { generateStandup } = await import('./daily-standup.mjs');
      const result = await generateStandup();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/api/standup/send' && req.method === 'POST') {
    try {
      const { sendStandup } = await import('./daily-standup.mjs');
      const stats = await sendStandup();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ ok: true, stats }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Anomaly detection status ──────────────────────────────────────
  if (url === '/api/anomalies' && req.method === 'GET') {
    try {
      const { getTrackerStates } = await import('./anomaly-detector.mjs');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(getTrackerStates()));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ status: 'warming up', error: e.message }));
    }
  }

  // ── Health broadcast (from health-monitor → WS clients) ──────────
  if (url === '/api/health/broadcast' && req.method === 'POST') {
    const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString());
      broadcast({ type: 'health', data });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"ok":true}');
    } catch { res.writeHead(400); return res.end('{"error":"bad json"}'); }
  }

  // ── A2A Protocol & Goal Decomposition ─────────────────────────────
  if (url === '/api/a2a/decompose' && req.method === 'POST') {
    const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
    try {
      const { title, description } = JSON.parse(Buffer.concat(chunks).toString());
      const { decomposeGoal } = await import('./a2a-protocol.mjs');
      const subtasks = decomposeGoal(title, description);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ goal: title, subtasks, count: subtasks.length }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/api/a2a/execute' && req.method === 'POST') {
    const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
    try {
      const { title, description, requestedBy } = JSON.parse(Buffer.concat(chunks).toString());
      const { executeGoal } = await import('./a2a-protocol.mjs');
      const result = await executeGoal(title, description, requestedBy);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/api/a2a/send' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      // Support both old format {from,to,type,payload} and new A2A format {from,to,text}
      const from = body.from || 'unknown';
      const to   = body.to;
      const text = body.text || body.payload?.text || body.payload?.body || body.payload || '';
      const replyTo = body.reply_to || null;
      if (!to || !text) { res.writeHead(400, _H); return res.end(JSON.stringify({ error: 'to and text required' })); }
      const { sendA2AMessage } = await import('./a2a.mjs');
      const result = await sendA2AMessage({ from, to, text: String(text), replyTo, awaitResponse: body.await || false });
      res.writeHead(200, _H); return res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, _H); return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/api/a2a/capabilities' && req.method === 'GET') {
    try {
      const { default: caps } = await import('./a2a-protocol.mjs').then(m => ({ default: Object.entries(m.findBestAgent ? m : {}) }));
      // Return capabilities directly
      const { AGENT_CAPABILITIES } = await import('./a2a-protocol.mjs');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(AGENT_CAPABILITIES || {}));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({}));
    }
  }

  // ── SOP Engine API ──────────────────────────────────────────────────
  if (url === '/api/sop/templates' && req.method === 'GET') {
    try {
      const { getSopDefinitions } = await import('./sop-engine.mjs');
      const defs = getSopDefinitions();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(defs));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/api/sop/trigger' && req.method === 'POST') {
    try {
      const chunks = []; req.on("data", c => chunks.push(c)); await new Promise(r => req.on("end", r)); const body = JSON.parse(Buffer.concat(chunks).toString());
      const { sopId, trigger } = body;
      const { createProcess, executeCurrentStep } = await import('./sop-engine.mjs');
      const process = createProcess(sopId, trigger || 'Manual trigger');
      // Auto-dispatch first step
      const dispatch = await executeCurrentStep(process.id);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ process, dispatch: dispatch?.dispatchResult }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/api/sop/active' && req.method === 'GET') {
    try {
      const { getActiveProcesses } = await import('./sop-engine.mjs');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(getActiveProcesses()));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify([]));
    }
  }

  if (urlPath.startsWith('/api/sop/step/') && req.method === 'POST') {
    try {
      const processId = urlPath.split('/')[4];
      const chunks = []; req.on("data", c => chunks.push(c)); await new Promise(r => req.on("end", r)); const body = JSON.parse(Buffer.concat(chunks).toString());
      const { advanceProcess, executeCurrentStep } = await import('./sop-engine.mjs');
      const process = advanceProcess(processId, body.output);
      if (process && process.status === 'active') {
        await executeCurrentStep(processId);
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(process));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (urlPath.startsWith('/api/sop/bpmn/') && req.method === 'GET') {
    try {
      const sopId = urlPath.split('/')[4];
      const { getSopBpmn } = await import('./sop-engine.mjs');
      const xml = getSopBpmn(sopId);
      if (!xml) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ error: 'SOP not found' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' });
      return res.end(xml);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // NATS Event Bus status
  if (url === '/api/nats/status' && req.method === 'GET') {
    try {
      const { isConnected, getWatchMatrix } = await import('./nats-bus.mjs');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ connected: isConnected(), watchMatrix: getWatchMatrix() }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ connected: false, error: e.message }));
    }
  }

  // NATS publish event
  if (url === '/api/nats/publish' && req.method === 'POST') {
    try {
      const chunks = []; req.on("data", c => chunks.push(c)); await new Promise(r => req.on("end", r)); const body = JSON.parse(Buffer.concat(chunks).toString());
      const { publishEvent } = await import('./nats-bus.mjs');
      const ok = await publishEvent(body.event, body.payload || {});
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ ok, event: body.event }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/api/sop/execute-bpmn' && req.method === 'POST') {
    try {
      const chunks = []; req.on("data", c => chunks.push(c)); await new Promise(r => req.on("end", r)); const body = JSON.parse(Buffer.concat(chunks).toString());
      const { executeBpmn } = await import('./sop-engine.mjs');
      const result = await executeBpmn(body.xml, body.variables || {});
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Agent Performance Metrics ─────────────────────────────────────
  if (url === '/api/agents/metrics' && req.method === 'GET') {
    try {
      const { calculateAgentMetrics } = await import('./agent-metrics.mjs');
      const metrics = await calculateAgentMetrics();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(metrics));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Uptime Kuma Alert Webhook ─────────────────────────────────────────────
  if (url === '/api/webhook/kuma' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const monitorName = body.monitor?.name || body.heartbeat?.monitor_name || 'unknown';
      const status = body.heartbeat?.status === 0 ? 'DOWN' : 'UP';
      const msg = body.heartbeat?.msg || '';
      console.log(`[Kuma Webhook] ${monitorName}: ${status} — ${msg}`);
      if (status === 'DOWN') {
        // Dedup: only dispatch once per monitor per 10 minutes
        if (!global._kumaAlertCache) global._kumaAlertCache = {};
        const cacheKey = `${monitorName}:DOWN`;
        const lastAlert = global._kumaAlertCache[cacheKey] || 0;
        const now = Date.now();
        if (now - lastAlert > 10 * 60 * 1000) {
          global._kumaAlertCache[cacheKey] = now;
          const agentUrl = new URL('http://localhost:5190/api/dispatch');
          await fetch(agentUrl.href, {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({
              agent: 'forge',
              title: `🚨 SERVICE DOWN: ${monitorName}`,
              body: `URL: ${body.monitor?.url || ''}\nHTTP: ${msg}\nCheck: PM2, Docker, Cloudflare tunnel`,
              source: 'uptime-kuma',
            }),
          }).catch(() => {});
          console.log(`[Kuma Webhook] Dispatched alert for ${monitorName}`);
        } else {
          console.log(`[Kuma Webhook] Deduped alert for ${monitorName} (last: ${Math.round((now-lastAlert)/1000)}s ago)`);
        }
      } else if (status === 'UP') {
        // Clear dedup cache on recovery
        if (global._kumaAlertCache) delete global._kumaAlertCache[`${monitorName}:DOWN`];
      }
      res.writeHead(200, _H); return res.end(JSON.stringify({ ok: true, received: { monitorName, status } }));
    } catch (e) { res.writeHead(200, _H); return res.end(JSON.stringify({ ok: true })); }
  }

// ── GitHub Webhook (auto-deploy) ──────────────────────────────────
  if (url === '/api/webhook/github' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    await new Promise(r => req.on('end', r));
    try {
      const { handleGitHubWebhook } = await import('./deploy-webhook.mjs');
      const result = await handleGitHubWebhook(body, req.headers);
      res.writeHead(result.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(result.body));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/api/terminal' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    await new Promise(res2 => req.on('end', res2));

    let cmd = '', agent = 'forge';
    try { const p = JSON.parse(body); cmd = p.cmd; agent = p.agent; } catch {}

    // Whitelist — safe read-only commands only
    const ALLOWED = [
      'ov status', 'ov doctor', 'ov costs', 'ov dashboard',
      'sd list', 'sd ready', 'sd stats', 'sd prime',
      'df -h', 'df -H', 'free -h', 'free -m', 'uptime', 'date',
      'git log --oneline', 'git status', 'git log -', 'git diff --stat',
      'ping -c', 'tailscale status', 'tailscale ping',
      'ps aux', 'ps -ef', 'uname -a', 'hostname',
      'ml query', 'ml prime',
      'ls', 'cat', 'echo', 'pwd', 'whoami',
      'pm2 list', 'pm2 status', 'pm2 logs',
      'node --version', 'npm --version', 'python3 --version',
      'curl -s http://localhost:5190/api/health',
      'curl -s http://localhost:18789',
      'curl -s http://localhost:7600',
      'mac-agent',
      'openclaw status',
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale status',
    ];

    // Special mac-agent commands → proxy to API
    if (cmd?.startsWith('mac-agent ')) {
      const sub = cmd.replace('mac-agent ', '').trim();
      const MAC_KEY = 'forge-mac-agent-2026-secret';
      let ep = '/health';
      if (sub === 'stats') ep = '/stats';
      else if (sub === 'jobs') ep = '/jobs';
      else if (sub === 'health') ep = '/health';
      try {
        const r = await fetch(`http://localhost:7600${ep}`, { headers: { 'X-API-Key': MAC_KEY }, signal: AbortSignal.timeout(3000) });
        const d = await r.json();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ stdout: JSON.stringify(d, null, 2), agent: 'forge', cmd, ts: Date.now() }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ stdout: `Mac Agent API error: ${e.message}`, agent: 'forge', cmd, ts: Date.now() }));
      }
    }

    if (!cmd || !ALLOWED.some(p => cmd.trim().startsWith(p))) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: `Command not allowed: "${cmd.slice(0,40)}"` }));
    }

    // For Forge (local) — run directly via child_process
    if (agent === 'forge' || !agent) {
      try {
        const { promisify } = await import('util');
        const { exec: cpExec } = await import('child_process');
        const execAsync = promisify(cpExec);
        const { stdout: localOut, stderr } = await execAsync(cmd, { timeout: 10000, env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/sbin' } });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ stdout: (localOut + (stderr ? '\n[stderr] ' + stderr : '')).trim() || '(no output)', agent: 'forge', cmd, ts: Date.now() }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ stdout: `Error: ${e.message}`, agent: 'forge', cmd, ts: Date.now() }));
      }
    }

    const agentIPs = { iron: '100.114.136.87', mesa: '100.100.40.27', atlas: '100.99.197.46', titan: '100.83.105.111' };
    const ip = agentIPs[agent];
    if (!ip) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: `Unknown agent: ${agent}` }));
    }

    try {
      const stdout = await ssh(ip, cmd, '(no output)');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ stdout, agent, cmd, ts: Date.now() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }

  // ── CFO: model selector ──────────────────────────────────────────
  if (url === '/api/cfo/select-model') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const qs = new URLSearchParams(req.url.split('?')[1] ?? '');
      const title    = qs.get('title') || '';
      const body_    = qs.get('body') || '';
      const priority = qs.get('priority') || 'medium';
      const { optimizeDispatch } = await import('./optimization-architect.mjs');
      const result = optimizeDispatch({ title, body: body_, priority, agentId: 'api-caller' });
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ...result, ts: Date.now() }));
    } catch (e) {
      // Legacy fallback
      const qs = new URLSearchParams(req.url.split('?')[1] ?? '');
      const complexity = qs.get('complexity') ?? 'standard';
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ model: 'claude-sonnet-4-6', reason: 'fallback', complexity, ts: Date.now() }));
    }
  }

  // ── Optimization Architect stats ─────────────────────────────────
  // ── A2A Protocol endpoints ────────────────────────────────────────────────
  // GET /api/a2a/agents[?capability=backend_development]
  if (url === '/api/a2a/agents' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getAllAgentCards } = await import('./a2a.mjs');
      const capFilter = params.get('capability');
      let cards = getAllAgentCards();
      if (capFilter) cards = cards.filter(c => (c.capabilities || []).includes(capFilter));
      res.writeHead(200, _H); return res.end(JSON.stringify(cards));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/a2a/agents/:id
  if (url.match(/^\/api\/a2a\/agents\/[^/]+$/) && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const agentId = url.split('/')[4];
    try {
      const { getAgentCard } = await import('./a2a.mjs');
      const card = getAgentCard(agentId);
      if (!card) { res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Agent not found' })); }
      res.writeHead(200, _H); return res.end(JSON.stringify(card));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/a2a/receive  — receive incoming A2A message from another agent gateway
  if (url === '/api/a2a/receive' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const chunks = []; req.on('data', c => chunks.push(c));
    await new Promise(r => req.on('end', r));
    let envelope = {}; try { envelope = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    const { to = 'forge', from = 'unknown', id, message } = envelope;
    if (!message?.parts?.[0]?.text) { res.writeHead(400, _H); return res.end(JSON.stringify({ error: 'Invalid A2A envelope' })); }
    try {
      // Store in local inbox + task inbox for pickup
      const inboxDir = path.join(USER_HOME_DIR, '.openclaw/workspace/tasks/inbox');
      fs.mkdirSync(inboxDir, { recursive: true });
      fs.writeFileSync(path.join(inboxDir, `a2a-${id || Date.now()}.json`), JSON.stringify({
        task_id: `a2a-${id}`, from, type: 'a2a_message',
        title: `[A2A from ${from}] ${message.parts[0].text.slice(0, 80)}`,
        body: message.parts[0].text, created: envelope.created || new Date().toISOString(), source: 'a2a',
      }, null, 2));
      console.log(`[A2A] 📥 Received from ${from}: ${message.parts[0].text.slice(0, 60)}`);
      res.writeHead(200, _H); return res.end(JSON.stringify({ ok: true, id }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/a2a/inbox/:agentId
  if (url.match(/^\/api\/a2a\/inbox\/[^/]+$/) && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const agentId = url.split('/')[4];
    try {
      const { readInbox } = await import('./a2a.mjs');
      const msgs = readInbox(agentId, { limit: 20 });
      res.writeHead(200, _H); return res.end(JSON.stringify({ agentId, messages: msgs, count: msgs.length }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // ── Checkpoint endpoints ──────────────────────────────────────────────────
  // POST /api/tasks/:id/checkpoint  { agent, step, progress, context? }
  if (url.match(/^\/api\/tasks\/[^/]+\/checkpoint$/) && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const taskId = url.split('/')[3];
    const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
    let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    try {
      const { writeCheckpoint } = await import('./checkpoint.mjs');
      const ckpt = writeCheckpoint({ taskId, ...body });
      res.writeHead(200, _H); return res.end(JSON.stringify({ ok: true, checkpoint: ckpt }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/tasks/checkpoints
  if (url === '/api/tasks/checkpoints' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getCheckpointStats } = await import('./checkpoint.mjs');
      res.writeHead(200, _H); return res.end(JSON.stringify(getCheckpointStats()));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/context/orgon — Living Context Doc content
  if (url === '/api/context/orgon' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { readContext } = await import('./living-context.mjs');
      const maxChars = parseInt(params.get('maxChars') || '4000');
      res.writeHead(200, _H); return res.end(JSON.stringify({ content: readContext(maxChars) }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/context/orgon/decision  { agent, decision, rationale }
  if (url === '/api/context/orgon/decision' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
    let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    try {
      const { appendDecision } = await import('./living-context.mjs');
      res.writeHead(200, _H); return res.end(JSON.stringify(appendDecision(body)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // ── Dead Letter Queue endpoints ───────────────────────────────────────────
  // GET /api/tasks/dlq
  if (url === '/api/tasks/dlq' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getDLQItems, getDLQStats, getDueRetries } = await import('./dlq.mjs');
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ stats: getDLQStats(), items: getDLQItems(), due_retries: getDueRetries() }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/tasks/dlq/:id/retry — manual requeue
  if (url.match(/^\/api\/tasks\/dlq\/[^/]+\/retry$/) && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const taskId = url.split('/')[4];
    try {
      const { requeueFromDLQ } = await import('./dlq.mjs');
      const result = requeueFromDLQ(taskId);
      res.writeHead(result.ok ? 200 : 404, _H);
      return res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/swarm/dispatch — fan-out to multiple agents
  if (url === '/api/swarm/dispatch' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let body2 = '';
    for await (const chunk of req) body2 += chunk;
    try {
      const { title, body: taskBody, agents, strategy = 'best', timeout_min = 10 } = JSON.parse(body2);
      if (!title || !agents?.length) { res.writeHead(400, _H); return res.end(JSON.stringify({ error: 'title and agents[] required' })); }
      const { fanOut } = await import('./swarm.mjs');
      const swarm = await fanOut({ title, body: taskBody, agents, strategy, timeoutMin: timeout_min });
      res.writeHead(200, _H); return res.end(JSON.stringify(swarm));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/swarm — list swarms | GET /api/swarm/:id — swarm detail
  if (url === '/api/swarm' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { listSwarms } = await import('./swarm.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(listSwarms())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/swarm/') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const swarmId = url.split('/')[3];
    try { const { loadSwarm } = await import('./swarm.mjs'); const s = loadSwarm(swarmId); res.writeHead(s ? 200 : 404, _H); return res.end(JSON.stringify(s || { error: 'not found' })); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/sprints/auto/status — autonomous sprint status
  if (url === '/api/sprints/auto/status' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getSprintStatus } = await import('./autonomous-sprints.mjs');
      const result = await getSprintStatus();
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, ...result }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/sprints/auto/trigger { agent } — manually trigger sprint for agent
  if (url === '/api/sprints/auto/trigger' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { agent } = JSON.parse(body);
      const { createAgentSprint } = await import('./autonomous-sprints.mjs');
      const result = agent ? await createAgentSprint(agent) : (await import('./autonomous-sprints.mjs')).weeklySprintKickoff();
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, ...result }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/sprints/auto/generate?agent={agent} — preview sprint tasks
  if (url.startsWith('/api/sprints/auto/generate') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const agent = params.get('agent');
      if (!agent) { res.writeHead(400, _H); return res.end(JSON.stringify({ error: 'agent required' })); }
      const { generateSprintTasks } = await import('./autonomous-sprints.mjs');
      const result = await generateSprintTasks(agent);
      res.writeHead(result.error ? 400 : 200, _H);
      return res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/goals — list | POST /api/goals — create | GET /api/goals/:id | PATCH /api/goals/:id/progress
  if (url === '/api/goals' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { listGoals, getGoalStats } = await import('./goal-tracker.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify({ goals: listGoals(), stats: getGoalStats() })); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/goals' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let body2 = '';
    for await (const chunk of req) body2 += chunk;
    try { const { createGoal } = await import('./goal-tracker.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(createGoal(JSON.parse(body2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.match(/^\/api\/goals\/[^/]+$/) && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const goalId = url.split('/')[3];
    try { const { getGoal } = await import('./goal-tracker.mjs'); const g = getGoal(goalId); res.writeHead(g ? 200 : 404, _H); return res.end(JSON.stringify(g || { error: 'not found' })); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.match(/^\/api\/goals\/[^/]+\/progress$/) && req.method === 'PATCH') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const goalId = url.split('/')[3];
    let body2 = '';
    for await (const chunk of req) body2 += chunk;
    try { const { updateGoalProgress } = await import('./goal-tracker.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(updateGoalProgress(goalId, JSON.parse(body2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/kg/stats | GET /api/kg/query?entity=... | POST /api/kg/entity | POST /api/kg/relation
  if (url === '/api/kg/stats' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getKGStats } = await import('./knowledge-graph.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getKGStats())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/kg/query') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const entity = params.get('entity') || ''; const depth = parseInt(params.get('depth') || '1');
    try { const { queryGraph } = await import('./knowledge-graph.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(queryGraph(entity, depth))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/kg/entity' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { addEntity } = await import('./knowledge-graph.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(addEntity(JSON.parse(b2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/kg/relation' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { addRelation } = await import('./knowledge-graph.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(addRelation(JSON.parse(b2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Spec Cache: POST /api/speccache/lookup|store|evict | GET /api/speccache/stats
  if (url === '/api/speccache/stats' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getStats } = await import('./spec-cache.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getStats())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/speccache') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { lookup, store, evict } = await import('./spec-cache.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/speccache/lookup') { res.writeHead(200, _H); return res.end(JSON.stringify(lookup(body2))); }
      if (url === '/api/speccache/store')  { res.writeHead(200, _H); return res.end(JSON.stringify(store(body2))); }
      if (url === '/api/speccache/evict')  { res.writeHead(200, _H); return res.end(JSON.stringify(evict(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Narrative Memory: POST /api/narrative/add|search|arc | GET /api/narrative/recent|soul/:id
  if (url.startsWith('/api/narrative') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getRecent, getSoul } = await import('./narrative-memory.mjs');
      if (url === '/api/narrative/recent') { res.writeHead(200, _H); return res.end(JSON.stringify(getRecent())); }
      if (url.startsWith('/api/narrative/soul/')) { res.writeHead(200, _H); return res.end(JSON.stringify(getSoul(url.replace('/api/narrative/soul/', '')))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown endpoint' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/narrative') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { addEvent, search, buildArc } = await import('./narrative-memory.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/narrative/add')    { res.writeHead(200, _H); return res.end(JSON.stringify(addEvent(body2))); }
      if (url === '/api/narrative/search') { res.writeHead(200, _H); return res.end(JSON.stringify(search(body2))); }
      if (url === '/api/narrative/arc')    { res.writeHead(200, _H); return res.end(JSON.stringify(buildArc(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Plan Validator: POST /api/planval/validate|fix | GET /api/planval/history
  if (url.startsWith('/api/planval') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getHistory } = await import('./plan-validator.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getHistory())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/planval') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { validatePlan, fixPlan } = await import('./plan-validator.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/planval/validate') { res.writeHead(200, _H); return res.end(JSON.stringify(validatePlan(body2))); }
      if (url === '/api/planval/fix')      { res.writeHead(200, _H); return res.end(JSON.stringify(fixPlan(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Handoff Protocol: POST /api/handoff/create|accept|complete | GET /api/handoff/:id|chain/:id
  if (url.startsWith('/api/handoff') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getHandoff, getChain } = await import('./handoff-protocol.mjs');
      if (url.startsWith('/api/handoff/chain/')) { res.writeHead(200, _H); return res.end(JSON.stringify(getChain(url.replace('/api/handoff/chain/', '')))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getHandoff(url.replace('/api/handoff/', ''))));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/handoff') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { createHandoff, acceptHandoff, completeHandoff } = await import('./handoff-protocol.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/handoff/create')   { res.writeHead(200, _H); return res.end(JSON.stringify(createHandoff(body2))); }
      if (url === '/api/handoff/accept')   { res.writeHead(200, _H); return res.end(JSON.stringify(acceptHandoff(body2))); }
      if (url === '/api/handoff/complete') { res.writeHead(200, _H); return res.end(JSON.stringify(completeHandoff(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Memory Scorer: POST /api/mscore/score|batch|gc | GET /api/mscore/stats
  if (url.startsWith('/api/mscore') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getStats } = await import('./memory-scorer.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getStats())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/mscore') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { scoreMemory, batchScore, gcMemories } = await import('./memory-scorer.mjs');
      const body2 = JSON.parse(b2 || '{}');
      if (url === '/api/mscore/score') { res.writeHead(200, _H); return res.end(JSON.stringify(scoreMemory(body2))); }
      if (url === '/api/mscore/batch') { res.writeHead(200, _H); return res.end(JSON.stringify(batchScore(body2))); }
      if (url === '/api/mscore/gc')    { res.writeHead(200, _H); return res.end(JSON.stringify(await gcMemories(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Stream Output: GET /api/stream/active|:id | POST /api/stream/start|emit|close|simulate
  if (url.startsWith('/api/stream') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getStream, getActiveStreams } = await import('./stream-output.mjs');
      if (url === '/api/stream/active') { res.writeHead(200, _H); return res.end(JSON.stringify(getActiveStreams())); }
      const streamId = url.replace('/api/stream/', '');
      res.writeHead(200, _H); return res.end(JSON.stringify(getStream(streamId)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/stream') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { startStream, emitEvent, closeStream, simulateStream } = await import('./stream-output.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/stream/start')    { res.writeHead(200, _H); return res.end(JSON.stringify(startStream(body2))); }
      if (url === '/api/stream/emit')     { res.writeHead(200, _H); return res.end(JSON.stringify(emitEvent(body2))); }
      if (url === '/api/stream/close')    { res.writeHead(200, _H); return res.end(JSON.stringify(closeStream(body2))); }
      if (url === '/api/stream/simulate') { res.writeHead(200, _H); return res.end(JSON.stringify(simulateStream(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Trust Boundary: POST /api/trust/verify|register | GET /api/trust/report|identities
  if (url.startsWith('/api/trust') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getViolations, getIdentities } = await import('./trust-boundary.mjs');
      if (url === '/api/trust/report')     { res.writeHead(200, _H); return res.end(JSON.stringify(getViolations())); }
      if (url === '/api/trust/identities') { res.writeHead(200, _H); return res.end(JSON.stringify(getIdentities())); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown endpoint' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/trust') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { verify, registerIdentity } = await import('./trust-boundary.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/trust/verify')   { res.writeHead(200, _H); return res.end(JSON.stringify(verify(body2))); }
      if (url === '/api/trust/register') { res.writeHead(200, _H); return res.end(JSON.stringify(registerIdentity(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Lazy Context: POST /api/ctx/build|expand | GET /api/ctx/stats
  if (url.startsWith('/api/ctx') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getStats } = await import('./lazy-context.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getStats())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/ctx') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { buildContext, expandContext } = await import('./lazy-context.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/ctx/build')  { res.writeHead(200, _H); return res.end(JSON.stringify(buildContext(body2))); }
      if (url === '/api/ctx/expand') { res.writeHead(200, _H); return res.end(JSON.stringify(expandContext(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Smart Router: POST /api/router/route|outcome | GET /api/router/stats|profile/:id
  if (url.startsWith('/api/router') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getStats, getAgentProfile } = await import('./smart-router.mjs');
      if (url === '/api/router/stats') { res.writeHead(200, _H); return res.end(JSON.stringify(getStats())); }
      const agentId = url.replace('/api/router/profile/', '');
      res.writeHead(200, _H); return res.end(JSON.stringify(getAgentProfile(agentId)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/router') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { routeTask, recordOutcome } = await import('./smart-router.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/router/route')   { res.writeHead(200, _H); return res.end(JSON.stringify(routeTask(body2))); }
      if (url === '/api/router/outcome') { res.writeHead(200, _H); return res.end(JSON.stringify(recordOutcome(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Self Healer: GET /api/heal/status|history | POST /api/heal/scan|fix
  if (url.startsWith('/api/heal') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getStatus, getHistory } = await import('./self-healer.mjs');
      if (url === '/api/heal/status')  { res.writeHead(200, _H); return res.end(JSON.stringify(getStatus())); }
      if (url === '/api/heal/history') { res.writeHead(200, _H); return res.end(JSON.stringify(getHistory())); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown endpoint' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/heal') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { scan } = await import('./self-healer.mjs');
      const body2 = JSON.parse(b2 || '{}');
      if (url === '/api/heal/scan') { res.writeHead(200, _H); return res.end(JSON.stringify(await scan({ force: body2.force }))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Shadow Mode: GET /api/shadow/active|:id | POST /api/shadow/register|record|promote|discard
  if (url.startsWith('/api/shadow') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getShadow, getActiveShadows } = await import('./shadow-mode.mjs');
      if (url === '/api/shadow/active') { res.writeHead(200, _H); return res.end(JSON.stringify(getActiveShadows())); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getShadow(url.replace('/api/shadow/', ''))));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/shadow') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { registerShadow, recordPair, promoteShadow, discardShadow } = await import('./shadow-mode.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/shadow/register') { res.writeHead(200, _H); return res.end(JSON.stringify(registerShadow(body2))); }
      if (url === '/api/shadow/record')   { res.writeHead(200, _H); return res.end(JSON.stringify(recordPair(body2))); }
      if (url === '/api/shadow/promote')  { res.writeHead(200, _H); return res.end(JSON.stringify(promoteShadow(body2.shadowId))); }
      if (url === '/api/shadow/discard')  { res.writeHead(200, _H); return res.end(JSON.stringify(discardShadow(body2.shadowId))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Goal Decomposer: GET /api/goal/active|:id | POST /api/goal/decompose|complete|replan
  if (url.startsWith('/api/goal') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getPlan, getActivePlans } = await import('./goal-decomposer.mjs');
      if (url === '/api/goal/active') { res.writeHead(200, _H); return res.end(JSON.stringify(getActivePlans())); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getPlan(url.replace('/api/goal/', ''))));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/goal') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { decomposeGoal, completeSubgoal } = await import('./goal-decomposer.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/goal/decompose') { res.writeHead(200, _H); return res.end(JSON.stringify(decomposeGoal(body2))); }
      if (url === '/api/goal/complete')  { res.writeHead(200, _H); return res.end(JSON.stringify(completeSubgoal(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Workload Model: GET /api/workload/:agentId|overview | POST /api/workload/update|can-accept
  if (url.startsWith('/api/workload') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getWorkload, getOverview } = await import('./workload-model.mjs');
      if (url === '/api/workload/overview') { res.writeHead(200, _H); return res.end(JSON.stringify(getOverview())); }
      const agentId = url.replace('/api/workload/', '');
      res.writeHead(200, _H); return res.end(JSON.stringify(getWorkload(agentId)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/workload') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { updateWorkload, canAccept } = await import('./workload-model.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/workload/update')     { res.writeHead(200, _H); return res.end(JSON.stringify(updateWorkload(body2))); }
      if (url === '/api/workload/can-accept') { res.writeHead(200, _H); return res.end(JSON.stringify(canAccept(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Durable Audit: GET /api/durable/runs|run/:id|replay/:id|checkpoint/:id | POST /api/durable/event|checkpoint
  if (url.startsWith('/api/durable') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getRun, replayRun, getRecentRuns, getCheckpoint } = await import('./durable-audit.mjs');
      if (url === '/api/durable/runs') { res.writeHead(200, _H); return res.end(JSON.stringify(getRecentRuns())); }
      if (url.startsWith('/api/durable/run/'))     { res.writeHead(200, _H); return res.end(JSON.stringify(getRun(url.replace('/api/durable/run/', '')))); }
      if (url.startsWith('/api/durable/replay/'))  { res.writeHead(200, _H); return res.end(JSON.stringify(replayRun(url.replace('/api/durable/replay/', '')))); }
      if (url.startsWith('/api/durable/checkpoint/')) { res.writeHead(200, _H); return res.end(JSON.stringify(getCheckpoint(url.replace('/api/durable/checkpoint/', '')))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown durable endpoint' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/durable') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { appendEvent, saveCheckpoint } = await import('./durable-audit.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/durable/event')      { res.writeHead(200, _H); return res.end(JSON.stringify(appendEvent(body2))); }
      if (url === '/api/durable/checkpoint') { res.writeHead(200, _H); return res.end(JSON.stringify(saveCheckpoint(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Dep Learner: GET /api/deps/suggest|graph | POST /api/deps/record|reset
  if (url.startsWith('/api/deps') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { suggestFollowups, getGraph } = await import('./dep-learner.mjs');
      if (url === '/api/deps/graph') { res.writeHead(200, _H); return res.end(JSON.stringify(getGraph())); }
      const taskType = new URL(url, 'http://x').searchParams.get('taskType') || url.replace('/api/deps/suggest?taskType=', '').replace('/api/deps/suggest', '');
      res.writeHead(200, _H); return res.end(JSON.stringify(suggestFollowups(taskType)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/deps') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { recordObservation } = await import('./dep-learner.mjs');
      res.writeHead(200, _H); return res.end(JSON.stringify(recordObservation(JSON.parse(b2))));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Rollup: GET /api/rollup/active|:id | POST /api/rollup/create|contribute|synthesize
  if (url.startsWith('/api/rollup') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getRollup, getActive } = await import('./rollup-aggregator.mjs');
      if (url === '/api/rollup/active') { res.writeHead(200, _H); return res.end(JSON.stringify(getActive())); }
      const id = url.replace('/api/rollup/', '');
      res.writeHead(200, _H); return res.end(JSON.stringify(getRollup(id)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/rollup') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { createRollup, contribute, synthesize } = await import('./rollup-aggregator.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/rollup/create')     { res.writeHead(200, _H); return res.end(JSON.stringify(createRollup(body2))); }
      if (url === '/api/rollup/contribute') { res.writeHead(200, _H); return res.end(JSON.stringify(await contribute(body2))); }
      if (url === '/api/rollup/synthesize') { res.writeHead(200, _H); return res.end(JSON.stringify(await synthesize(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Adaptive Sampler: GET /api/sample/:agentId|schedule | POST /api/sample/report|tick
  if (url.startsWith('/api/sample') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getAgentSampling, getSchedule } = await import('./adaptive-sampler.mjs');
      if (url === '/api/sample/schedule') { res.writeHead(200, _H); return res.end(JSON.stringify(getSchedule())); }
      const agentId = url.replace('/api/sample/', '');
      res.writeHead(200, _H); return res.end(JSON.stringify(getAgentSampling(agentId)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/sample') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { reportEvent, shouldPoll } = await import('./adaptive-sampler.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/sample/report') { res.writeHead(200, _H); return res.end(JSON.stringify(reportEvent(body2))); }
      if (url === '/api/sample/tick')   { res.writeHead(200, _H); return res.end(JSON.stringify(shouldPoll(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Shared Whiteboard: GET /api/wb/read|:section | POST /api/wb/write|pickup | DELETE /api/wb/clear
  if (url.startsWith('/api/wb') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { read } = await import('./shared-whiteboard.mjs');
      if (url === '/api/wb/read') { res.writeHead(200, _H); return res.end(JSON.stringify(read())); }
      const section = url.replace('/api/wb/', '');
      res.writeHead(200, _H); return res.end(JSON.stringify(read(section)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/wb') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { write, pickup } = await import('./shared-whiteboard.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/wb/write')  { res.writeHead(200, _H); return res.end(JSON.stringify(write(body2))); }
      if (url === '/api/wb/pickup') { res.writeHead(200, _H); return res.end(JSON.stringify(pickup(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/wb') && req.method === 'DELETE') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { clear } = await import('./shared-whiteboard.mjs');
      res.writeHead(200, _H); return res.end(JSON.stringify(clear(JSON.parse(b2))));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Time-aware: GET /api/time/context|window | POST /api/time/should-run|optimal-slot
  if (url.startsWith('/api/time') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getTimeContext } = await import('./time-aware.mjs');
      res.writeHead(200, _H); return res.end(JSON.stringify(getTimeContext()));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/time') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { shouldRun, optimalSlot } = await import('./time-aware.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/time/should-run')   { res.writeHead(200, _H); return res.end(JSON.stringify(shouldRun(body2))); }
      if (url === '/api/time/optimal-slot') { res.writeHead(200, _H); return res.end(JSON.stringify(optimalSlot(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Persona: GET /api/persona/list | POST /api/persona/detect|override
  if (url === '/api/persona/list' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { listPersonas } = await import('./persona-switch.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(listPersonas())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/persona') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { detectAndApply, overridePersona } = await import('./persona-switch.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/persona/detect')   { res.writeHead(200, _H); return res.end(JSON.stringify(detectAndApply(body2))); }
      if (url === '/api/persona/override') { res.writeHead(200, _H); return res.end(JSON.stringify(overridePersona(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Reputation: GET /api/rep/board | /rep/:agentId | POST /api/rep/event|peer-review
  if (url.startsWith('/api/rep') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getReputation, getLeaderboard } = await import('./reputation-system.mjs');
      if (url === '/api/rep/board') { res.writeHead(200, _H); return res.end(JSON.stringify(getLeaderboard())); }
      const agentId = url.replace('/api/rep/', '');
      res.writeHead(200, _H); return res.end(JSON.stringify(getReputation(agentId)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/rep') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { applyEvent, peerReview } = await import('./reputation-system.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/rep/event')       { res.writeHead(200, _H); return res.end(JSON.stringify(applyEvent(body2))); }
      if (url === '/api/rep/peer-review') { res.writeHead(200, _H); return res.end(JSON.stringify(peerReview(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Proactive: POST /api/suggest/scan|apply|dismiss | GET /api/suggest/pending
  if (url.startsWith('/api/suggest') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getPending } = await import('./proactive-suggest.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getPending())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/suggest') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { scan, applySuggestion, dismissSuggestion } = await import('./proactive-suggest.mjs');
      const body2 = JSON.parse(b2 || '{}');
      if (url === '/api/suggest/scan')    { res.writeHead(200, _H); return res.end(JSON.stringify(await scan({ force: body2.force }))); }
      if (url === '/api/suggest/apply')   { res.writeHead(200, _H); return res.end(JSON.stringify(applySuggestion(body2.suggestionId))); }
      if (url === '/api/suggest/dismiss') { res.writeHead(200, _H); return res.end(JSON.stringify(dismissSuggestion(body2.suggestionId))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Dedup: POST /api/dedup/check|register | DELETE /api/dedup/:taskId | GET /api/dedup/index
  if (url.startsWith('/api/dedup') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getIndex } = await import('./semantic-dedup.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getIndex())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/dedup') && req.method === 'DELETE') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { removeTask } = await import('./semantic-dedup.mjs'); const taskId = url.replace('/api/dedup/', ''); res.writeHead(200, _H); return res.end(JSON.stringify(removeTask(taskId))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/dedup') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { checkDedup, registerTask } = await import('./semantic-dedup.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/dedup/check')    { res.writeHead(200, _H); return res.end(JSON.stringify(checkDedup(body2))); }
      if (url === '/api/dedup/register') { res.writeHead(200, _H); return res.end(JSON.stringify(registerTask(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // AutoDoc: GET /api/doc/changelog | /doc/agent/:id | POST /api/doc/changelog-entry|agent-card|sprint-summary
  if (url.startsWith('/api/doc') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getChangelog, getAgentCard } = await import('./auto-doc.mjs');
      if (url === '/api/doc/changelog') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }); return res.end(getChangelog()); }
      if (url.startsWith('/api/doc/agent/')) { const agentId = url.replace('/api/doc/agent/', ''); res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }); return res.end(getAgentCard(agentId) || 'Agent card not found'); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown doc path' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/doc') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { addChangelogEntry, generateAgentCard, generateSprintSummary } = await import('./auto-doc.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/doc/changelog-entry') { res.writeHead(200, _H); return res.end(JSON.stringify(addChangelogEntry(body2))); }
      if (url === '/api/doc/agent-card')       { res.writeHead(200, _H); return res.end(JSON.stringify(generateAgentCard(body2.agentId))); }
      if (url === '/api/doc/sprint-summary')   { res.writeHead(200, _H); return res.end(JSON.stringify(generateSprintSummary(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown doc action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // VMem: GET /api/vmem/read/:agentId/:key | /vmem/log/:agentId/:key | /vmem/snapshot/:agentId | POST /api/vmem/write|rollback
  if (url.startsWith('/api/vmem') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { read, log, snapshot, diff } = await import('./versioned-memory.mjs');
      const parts = url.replace('/api/vmem/', '').split('/');
      if (parts[0] === 'snapshot' && parts[1]) { res.writeHead(200, _H); return res.end(JSON.stringify(snapshot(parts[1]))); }
      if (parts[0] === 'read'     && parts[1] && parts[2]) { res.writeHead(200, _H); return res.end(JSON.stringify(read(parts[1], parts[2]))); }
      if (parts[0] === 'log'      && parts[1] && parts[2]) { res.writeHead(200, _H); return res.end(JSON.stringify(log(parts[1], parts[2]))); }
      if (parts[0] === 'diff'     && parts[1] && parts[2] && parts[3] && parts[4]) { res.writeHead(200, _H); return res.end(JSON.stringify(diff(parts[1], parts[2], parts[3], parts[4]))); }
      res.writeHead(400, _H); return res.end(JSON.stringify({ error: 'Invalid path' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/vmem') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { write: vmWrite, rollback: vmRollback } = await import('./versioned-memory.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/vmem/write')    { res.writeHead(200, _H); return res.end(JSON.stringify(vmWrite(body2))); }
      if (url === '/api/vmem/rollback') { res.writeHead(200, _H); return res.end(JSON.stringify(vmRollback(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // Coalition: POST /api/coalition/form|dissolve | GET /api/coalition/active | /coalition/:id
  if (url.startsWith('/api/coalition') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getActiveCoalitions, getCoalition } = await import('./coalition-builder.mjs');
      if (url === '/api/coalition/active') { res.writeHead(200, _H); return res.end(JSON.stringify(getActiveCoalitions())); }
      const id = url.replace('/api/coalition/', '');
      res.writeHead(200, _H); return res.end(JSON.stringify(getCoalition(id)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/coalition') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { formCoalition, dissolveCoalition } = await import('./coalition-builder.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/coalition/form')    { res.writeHead(200, _H); return res.end(JSON.stringify(formCoalition(body2))); }
      if (url === '/api/coalition/dissolve') { res.writeHead(200, _H); return res.end(JSON.stringify(dissolveCoalition(body2.coalitionId))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/speculative/predict|warm|hit | GET /api/speculative/cache
  if (url.startsWith('/api/speculative') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getCacheStats } = await import('./speculative-fetch.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getCacheStats())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/speculative') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { predict, recordHit } = await import('./speculative-fetch.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/speculative/predict') { res.writeHead(200, _H); return res.end(JSON.stringify(predict(body2))); }
      if (url === '/api/speculative/hit')     { res.writeHead(200, _H); return res.end(JSON.stringify(recordHit(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/contract/generate|validate | GET /api/contract/:id | /contract/list/:agentId
  if (url.startsWith('/api/contract') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getContract, listContracts } = await import('./contract-validator.mjs');
      if (url.startsWith('/api/contract/list/')) { const agentId = url.replace('/api/contract/list/', ''); res.writeHead(200, _H); return res.end(JSON.stringify(listContracts(agentId))); }
      const id = url.replace('/api/contract/', '');
      res.writeHead(200, _H); return res.end(JSON.stringify(getContract(id)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/contract') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { generateContract, validateContract } = await import('./contract-validator.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/contract/generate') { res.writeHead(200, _H); return res.end(JSON.stringify(generateContract(body2))); }
      if (url === '/api/contract/validate') { res.writeHead(200, _H); return res.end(JSON.stringify(validateContract(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/reward/shape | GET /api/reward/signals/:agentId | /api/reward/leaderboard
  if (url.startsWith('/api/reward') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getLeaderboard, getAgentSignals } = await import('./reward-shaper.mjs');
      if (url === '/api/reward/leaderboard') { res.writeHead(200, _H); return res.end(JSON.stringify(getLeaderboard())); }
      const agentId = url.replace('/api/reward/signals/', '');
      res.writeHead(200, _H); return res.end(JSON.stringify(getAgentSignals(agentId)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/reward/shape' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { shapeReward } = await import('./reward-shaper.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(shapeReward(JSON.parse(b2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/queue/enqueue|dequeue|preempt|complete | GET /api/queue/status | /queue/:agentId
  if (url.startsWith('/api/queue') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getQueueStatus, getAgentQueue } = await import('./priority-queue.mjs');
      if (url === '/api/queue/status') { res.writeHead(200, _H); return res.end(JSON.stringify(getQueueStatus())); }
      const agentId = url.replace('/api/queue/', '');
      res.writeHead(200, _H); return res.end(JSON.stringify(getAgentQueue(agentId)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/queue') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { enqueue, dequeue, preempt, complete: qComplete } = await import('./priority-queue.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/queue/enqueue')  { res.writeHead(200, _H); return res.end(JSON.stringify(enqueue(body2))); }
      if (url === '/api/queue/dequeue')  { res.writeHead(200, _H); return res.end(JSON.stringify(dequeue(body2.agentId))); }
      if (url === '/api/queue/preempt')  { res.writeHead(200, _H); return res.end(JSON.stringify(preempt(body2))); }
      if (url === '/api/queue/complete') { res.writeHead(200, _H); return res.end(JSON.stringify(qComplete(body2))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown queue action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/journal/summary | /journal/:agentId | /journal/:agentId/:date | POST /api/journal/entry
  if (url.startsWith('/api/journal') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getJournal, getJournalSummary } = await import('./agent-journal.mjs');
      if (url === '/api/journal/summary') { res.writeHead(200, _H); return res.end(JSON.stringify(getJournalSummary())); }
      const parts = url.replace('/api/journal/', '').split('/');
      const agentId = parts[0], date = parts[1];
      if (agentId) { res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }); return res.end(getJournal(agentId, date || null)); }
      res.writeHead(400, _H); return res.end(JSON.stringify({ error: 'agentId required' }));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/journal/entry' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { writeEntry } = await import('./agent-journal.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(writeEntry(JSON.parse(b2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/pipeline/recent | /pipeline/:id | POST /api/pipeline/start|layer|finish
  if (url.startsWith('/api/pipeline') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getRecentSnapshots, getSnapshot } = await import('./pipeline-snapshot.mjs');
      if (url === '/api/pipeline/recent') { res.writeHead(200, _H); return res.end(JSON.stringify(getRecentSnapshots())); }
      const id = url.replace('/api/pipeline/', '');
      if (id) { res.writeHead(200, _H); return res.end(JSON.stringify(getSnapshot(id))); }
      res.writeHead(400, _H); return res.end(JSON.stringify({ error: 'id required' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/pipeline') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { startSnapshot, addLayer, finishSnapshot, snapshotDispatch } = await import('./pipeline-snapshot.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/pipeline/start')  { res.writeHead(200, _H); return res.end(JSON.stringify(startSnapshot(body2))); }
      if (url === '/api/pipeline/layer')  { res.writeHead(200, _H); return res.end(JSON.stringify(addLayer(body2))); }
      if (url === '/api/pipeline/finish') { res.writeHead(200, _H); return res.end(JSON.stringify(finishSnapshot(body2))); }
      if (url === '/api/pipeline/demo')   { res.writeHead(200, _H); return res.end(JSON.stringify(snapshotDispatch(body2.dispatchId || `demo_${Date.now()}`, body2.title, body2.to, body2.priority, body2.model, body2.layers || []))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown pipeline action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/social/pool|doctrines | POST /api/social/observe|learn
  if (url.startsWith('/api/social') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getPool, getDoctrines } = await import('./social-learner.mjs');
      if (url.includes('/doctrines')) { res.writeHead(200, _H); return res.end(JSON.stringify(getDoctrines())); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getPool()));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/social') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { logObservation, learnFromPeers } = await import('./social-learner.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/social/learn') { res.writeHead(200, _H); return res.end(JSON.stringify(learnFromPeers(body2.agentId))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(logObservation(body2)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/prompt/adapt|feedback | GET /api/prompt/genome/:agentId
  if (url.startsWith('/api/prompt') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getGenome } = await import('./adaptive-prompt.mjs');
      const agentId = url.split('/').pop();
      res.writeHead(200, _H); return res.end(JSON.stringify(getGenome(agentId)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/prompt') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { adaptPrompt, recordFeedback } = await import('./adaptive-prompt.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/prompt/feedback') { res.writeHead(200, _H); return res.end(JSON.stringify(recordFeedback(body2))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(adaptPrompt(body2)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/chaos/run|inject | GET /api/chaos/results|score
  if (url.startsWith('/api/chaos') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getResults, getResilienceScores } = await import('./chaos-tester.mjs');
      if (url.includes('/score')) { res.writeHead(200, _H); return res.end(JSON.stringify(getResilienceScores())); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getResults()));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/chaos') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { runChaosTest, inject } = await import('./chaos-tester.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/chaos/inject') { res.writeHead(200, _H); return res.end(JSON.stringify(inject(body2))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(await runChaosTest(body2)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/distill/teach|inject | GET /api/distill/tips|map
  if (url.startsWith('/api/distill') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getTips, getTeacherMap } = await import('./knowledge-distiller.mjs');
      if (url.includes('/map')) { res.writeHead(200, _H); return res.end(JSON.stringify(getTeacherMap())); }
      const agent = url.split('/').pop(); const tips = getTips(agent !== 'tips' ? agent : null);
      res.writeHead(200, _H); return res.end(JSON.stringify(tips));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/distill') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { teachTip, injectDistilledKnowledge } = await import('./knowledge-distiller.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/distill/teach')  { res.writeHead(200, _H); return res.end(JSON.stringify(teachTip(body2))); }
      if (url === '/api/distill/inject') { res.writeHead(200, _H); return res.end(JSON.stringify(injectDistilledKnowledge(body2.studentAgent, body2.taskTitle))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown distill action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/migrate | GET /api/migrate/history | POST /api/migrate/checkpoint
  if (url.startsWith('/api/migrate') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getMigrationHistory } = await import('./task-migrator.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getMigrationHistory())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/migrate') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { migrateTask, saveCheckpoint } = await import('./task-migrator.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/migrate/checkpoint') { res.writeHead(200, _H); return res.end(JSON.stringify(saveCheckpoint(body2))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(await migrateTask(body2)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/verify | GET /api/verify/history|stats
  if (url.startsWith('/api/verify') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getVerificationHistory, getVerificationStats } = await import('./outcome-verifier.mjs');
      if (url.includes('/stats')) { res.writeHead(200, _H); return res.end(JSON.stringify(getVerificationStats())); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getVerificationHistory()));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/verify' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { verify } = await import('./outcome-verifier.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(await verify(JSON.parse(b2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/agent-ops/dashboard|activity|burn-rate|efficiency | POST /api/agent-ops/record
  if (url.startsWith('/api/agent-ops') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getDashboard, getLiveActivity, getBurnRate } = await import('./agent-ops.mjs');
      if (url.includes('/activity'))   { res.writeHead(200, _H); return res.end(JSON.stringify(getLiveActivity())); }
      if (url.includes('/burn-rate'))  { res.writeHead(200, _H); return res.end(JSON.stringify(getBurnRate())); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getDashboard()));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/agent-ops/record' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { recordOps } = await import('./agent-ops.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify({ ok: true, ...recordOps(JSON.parse(b2)) })); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/registry | /registry/:agentId | POST /api/registry/advertise|discover|heartbeat
  if (url.startsWith('/api/registry') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getRegistry } = await import('./capability-registry.mjs');
      const agentId = url.replace('/api/registry/', '').replace('/api/registry', '').trim();
      const reg = getRegistry();
      if (agentId) { res.writeHead(200, _H); return res.end(JSON.stringify(reg[agentId] || null)); }
      res.writeHead(200, _H); return res.end(JSON.stringify(reg));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/registry') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { advertise, discover, heartbeat } = await import('./capability-registry.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/registry/advertise')  { res.writeHead(200, _H); return res.end(JSON.stringify(advertise(body2))); }
      if (url === '/api/registry/discover')   { res.writeHead(200, _H); return res.end(JSON.stringify(discover(body2))); }
      if (url === '/api/registry/heartbeat')  { res.writeHead(200, _H); return res.end(JSON.stringify(heartbeat(body2.agentId, body2.availability))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown registry action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/batch/queue|stats | POST /api/batch/enqueue|flush
  if (url.startsWith('/api/batch') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getQueueState, getBatchStats } = await import('./task-batcher.mjs');
      if (url.includes('/stats')) { res.writeHead(200, _H); return res.end(JSON.stringify(getBatchStats())); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getQueueState()));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/batch') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { enqueueTask, flushBatches } = await import('./task-batcher.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/batch/flush') { res.writeHead(200, _H); return res.end(JSON.stringify(flushBatches(body2))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(enqueueTask(body2)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/hmem/tree | POST /api/hmem/store|recall|reflect
  if (url.startsWith('/api/hmem') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getTree } = await import('./hmem.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getTree())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/hmem') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { storeTrace, recall, reflectCategory } = await import('./hmem.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/hmem/store')   { res.writeHead(200, _H); return res.end(JSON.stringify(storeTrace(body2))); }
      if (url === '/api/hmem/recall')  { res.writeHead(200, _H); return res.end(JSON.stringify(recall(body2))); }
      if (url === '/api/hmem/reflect') { res.writeHead(200, _H); return res.end(JSON.stringify(reflectCategory(body2.domain, body2.category))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown hmem action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/roles | POST /api/roles/route | /validate
  if (url.startsWith('/api/roles') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getRoleManifest } = await import('./role-router.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getRoleManifest())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/roles') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { routeByRole, validateRoleAssignment } = await import('./role-router.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/roles/validate') { res.writeHead(200, _H); return res.end(JSON.stringify(validateRoleAssignment(body2.agentId, body2.taskTitle))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(routeByRole(body2)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/model-pin | /model-pin/:agentId | POST /api/model-pin/set|rollback|override|score
  if (url.startsWith('/api/model-pin') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getAllPins, getPinnedModel } = await import('./model-version-pin.mjs');
      const agentId = url.replace('/api/model-pin/', '').replace('/api/model-pin', '').trim();
      if (agentId) { res.writeHead(200, _H); return res.end(JSON.stringify(getPinnedModel(agentId))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getAllPins()));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/model-pin') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { pinModel, rollbackModel, setOverride, recordScore } = await import('./model-version-pin.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/model-pin/set')      { res.writeHead(200, _H); return res.end(JSON.stringify(pinModel(body2.agentId, body2.model))); }
      if (url === '/api/model-pin/rollback') { res.writeHead(200, _H); return res.end(JSON.stringify(rollbackModel(body2.agentId))); }
      if (url === '/api/model-pin/override') { res.writeHead(200, _H); return res.end(JSON.stringify(setOverride(body2.agentId, body2.model, body2.taskId))); }
      if (url === '/api/model-pin/score')    { res.writeHead(200, _H); return res.end(JSON.stringify(recordScore(body2.agentId, body2.score))); }
      res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Unknown model-pin action' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/narrative/feed | POST /api/narrative/task | /sprint
  if (url.startsWith('/api/narrative') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getNarrativeFeed } = await import('./narrative.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getNarrativeFeed())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/narrative') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { generateTaskNarrative, generateSprintNarrative } = await import('./narrative.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/narrative/sprint') { res.writeHead(200, _H); return res.end(JSON.stringify(generateSprintNarrative(body2.agentIds, body2.limit))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(generateTaskNarrative(body2)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/curriculum | /curriculum/:agentId | POST /api/curriculum/record | /assess
  if (url.startsWith('/api/curriculum') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getAllCurriculum, getAgentCurriculum } = await import('./curriculum.mjs');
      const agentId = url.replace('/api/curriculum/', '').replace('/api/curriculum', '').trim();
      if (agentId) { res.writeHead(200, _H); return res.end(JSON.stringify(getAgentCurriculum(agentId))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getAllCurriculum()));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/curriculum') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { recordCompletion, assessComplexity } = await import('./curriculum.mjs');
      const body2 = JSON.parse(b2);
      if (url === '/api/curriculum/assess') { res.writeHead(200, _H); return res.end(JSON.stringify({ complexity: assessComplexity(body2.title, body2.priority) })); }
      res.writeHead(200, _H); return res.end(JSON.stringify(recordCompletion(body2)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/reputation | /leaderboard | /reputation/:agentId | POST /api/reputation/event
  if (url.startsWith('/api/reputation') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getAllReputation, getLeaderboard, getAgentReputation } = await import('./reputation.mjs');
      if (url === '/api/reputation/leaderboard') { res.writeHead(200, _H); return res.end(JSON.stringify(getLeaderboard())); }
      const agentId = url.replace('/api/reputation/', '').replace('/api/reputation', '').trim();
      if (agentId) { res.writeHead(200, _H); return res.end(JSON.stringify(getAgentReputation(agentId))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getAllReputation()));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/reputation/event' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { recordEvent } = await import('./reputation.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(recordEvent(JSON.parse(b2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/objectives/rank | GET /api/objectives/weights | POST /api/objectives/weights
  if (url.startsWith('/api/objectives') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getWeights } = await import('./multi-objective.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getWeights())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/objectives') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { rankOptions, updateWeights } = await import('./multi-objective.mjs');
      if (url === '/api/objectives/weights') { res.writeHead(200, _H); return res.end(JSON.stringify(updateWeights(JSON.parse(b2)))); }
      const { options, weights } = JSON.parse(b2);
      res.writeHead(200, _H); return res.end(JSON.stringify(rankOptions(options, weights)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/intent/analyze | GET /api/intent/taxonomy
  if (url.startsWith('/api/intent') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getIntentTaxonomy } = await import('./intent-recognizer.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getIntentTaxonomy())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/intent/analyze' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { analyzeIntent } = await import('./intent-recognizer.mjs'); const { title, desc, to, priority } = JSON.parse(b2); res.writeHead(200, _H); return res.end(JSON.stringify(analyzeIntent(title, desc, to, priority))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/ttl/status | /expired | POST /api/ttl/register | /complete | /sweep
  if (url.startsWith('/api/ttl') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getStatus, getExpired } = await import('./task-ttl.mjs');
      if (url === '/api/ttl/expired') { res.writeHead(200, _H); return res.end(JSON.stringify(getExpired())); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getStatus()));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/ttl') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { registerTask, completeTask, sweepExpired } = await import('./task-ttl.mjs');
      if (url === '/api/ttl/sweep')    { res.writeHead(200, _H); return res.end(JSON.stringify(sweepExpired())); }
      if (url === '/api/ttl/complete') { const { taskId } = JSON.parse(b2); res.writeHead(200, _H); return res.end(JSON.stringify(completeTask(taskId))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(registerTask(JSON.parse(b2))));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/ledger | GET /api/ledger/verify | GET /api/ledger/search | POST /api/ledger/append
  if (url.startsWith('/api/ledger') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getLedger, verifyLedger, searchLedger } = await import('./immutable-ledger.mjs');
      if (url === '/api/ledger/verify') { res.writeHead(200, _H); return res.end(JSON.stringify(verifyLedger())); }
      if (url.startsWith('/api/ledger/search')) {
        const sp = new URL('http://x' + url).searchParams;
        res.writeHead(200, _H); return res.end(JSON.stringify(searchLedger({ agentId: sp.get('agentId'), action: sp.get('action') })));
      }
      res.writeHead(200, _H); return res.end(JSON.stringify(getLedger()));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/ledger/append' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { ledgerAppend } = await import('./immutable-ledger.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(ledgerAppend(JSON.parse(b2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/context-window/stats | POST /api/context-window/build
  if (url === '/api/context-window/stats' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getBudgetConfig } = await import('./context-window.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getBudgetConfig())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/context-window/build' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { buildContext } = await import('./context-window.mjs'); const { blocks } = JSON.parse(b2); res.writeHead(200, _H); return res.end(JSON.stringify(buildContext(blocks))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/scheduler/forecast | /heatmap | /busy | POST /api/scheduler/record | /whatif
  if (url.startsWith('/api/scheduler') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { forecast, getHeatmap, getBusiest } = await import('./predictive-scheduler.mjs');
      if (url === '/api/scheduler/heatmap') { res.writeHead(200, _H); return res.end(JSON.stringify(getHeatmap())); }
      if (url === '/api/scheduler/busy')    { res.writeHead(200, _H); return res.end(JSON.stringify(getBusiest())); }
      res.writeHead(200, _H); return res.end(JSON.stringify(forecast()));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/scheduler') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { recordDispatch, whatIf } = await import('./predictive-scheduler.mjs');
      if (url === '/api/scheduler/whatif') { res.writeHead(200, _H); return res.end(JSON.stringify(whatIf(JSON.parse(b2)))); }
      const { agentId } = JSON.parse(b2); recordDispatch(agentId);
      res.writeHead(200, _H); return res.end(JSON.stringify({ ok: true, agentId }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/federated/pool | GET /api/federated/insights | POST /api/federated/contribute | POST /api/federated/aggregate
  if (url.startsWith('/api/federated') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getPool, getGlobalInsights } = await import('./federated-knowledge.mjs');
      const sp = new URL('http://x' + url).searchParams;
      if (url.includes('/insights')) { res.writeHead(200, _H); return res.end(JSON.stringify(getGlobalInsights(sp.get('topic') || '', 10))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getPool()));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/federated') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { contribute, aggregate } = await import('./federated-knowledge.mjs');
      if (url === '/api/federated/aggregate') { res.writeHead(200, _H); return res.end(JSON.stringify(aggregate())); }
      res.writeHead(200, _H); return res.end(JSON.stringify(contribute(JSON.parse(b2))));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/canary | GET /api/canary/:featureId | POST /api/canary/*
  if (url.startsWith('/api/canary') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getAllCanaries, getCanary } = await import('./canary.mjs');
      const featureId = url.replace('/api/canary/', '').replace('/api/canary', '').trim();
      if (featureId) { res.writeHead(200, _H); return res.end(JSON.stringify(getCanary(featureId))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getAllCanaries()));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/canary') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { registerCanary, recordOutcome, forceAdvance, forceRollback } = await import('./canary.mjs');
      if (url.includes('/advance/')) { const fid = url.split('/advance/')[1]; res.writeHead(200, _H); return res.end(JSON.stringify(forceAdvance(fid))); }
      if (url.includes('/rollback/')) { const fid = url.split('/rollback/')[1]; res.writeHead(200, _H); return res.end(JSON.stringify(forceRollback(fid))); }
      if (url === '/api/canary/record') { res.writeHead(200, _H); return res.end(JSON.stringify(recordOutcome(JSON.parse(b2)))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(registerCanary(JSON.parse(b2))));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/blast-radius | GET /api/blast-radius/:agentId | POST /api/blast-radius/check
  if (url.startsWith('/api/blast-radius') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getAllBlastRadii, getAgentBlastRadius } = await import('./blast-radius.mjs');
      const agentId = url.replace('/api/blast-radius/', '').replace('/api/blast-radius', '').trim();
      if (agentId) { res.writeHead(200, _H); return res.end(JSON.stringify(getAgentBlastRadius(agentId))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getAllBlastRadii()));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/blast-radius/check' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { checkBlastRadius } = await import('./blast-radius.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(checkBlastRadius(JSON.parse(b2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/throttle/status | POST /api/throttle/check | POST /api/throttle/reset/:agentId
  if (url.startsWith('/api/throttle') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getThrottleStatus } = await import('./throttle.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getThrottleStatus())); }
    catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/throttle/check' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { checkThrottle } = await import('./throttle.mjs'); const { agentId } = JSON.parse(b2); res.writeHead(200, _H); return res.end(JSON.stringify(checkThrottle(agentId))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url.startsWith('/api/throttle/reset/') && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const agentId = url.replace('/api/throttle/reset/', '');
    try { const { resetThrottle } = await import('./throttle.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(resetThrottle(agentId))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/cot | GET /api/cot/:traceId | POST /api/cot/append
  if (url.startsWith('/api/cot') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getCot, listCot } = await import('./cot-logger.mjs');
      const traceId = url.replace('/api/cot/', '').replace('/api/cot', '');
      if (traceId) { res.writeHead(200, _H); return res.end(JSON.stringify(getCot(traceId))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(listCot()));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/config | GET /api/config/history | POST /api/config/update | POST /api/config/reset
  if (url.startsWith('/api/config') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getConfig, getConfigHistory } = await import('./hot-config.mjs');
      if (url === '/api/config/history') { res.writeHead(200, _H); return res.end(JSON.stringify(getConfigHistory())); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getConfig()));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/config/update' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { updateConfig } = await import('./hot-config.mjs'); const { key, value } = JSON.parse(b2); res.writeHead(200, _H); return res.end(JSON.stringify(updateConfig(key, value))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/config/reset' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { resetConfig } = await import('./hot-config.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(resetConfig())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/confidence/stats | GET /api/confidence/flags | POST /api/confidence/score
  if (url.startsWith('/api/confidence') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getConfidenceStats, getFlags } = await import('./confidence.mjs');
      if (url === '/api/confidence/flags') { res.writeHead(200, _H); return res.end(JSON.stringify(getFlags())); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getConfidenceStats()));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/confidence/score' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { calibrateConfidence } = await import('./confidence.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(calibrateConfidence(JSON.parse(b2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/budget/status | GET /api/budget/forecast | POST /api/budget/record
  if (url.startsWith('/api/budget') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getBudgetStatus, getForecast } = await import('./token-budget.mjs');
      if (url === '/api/budget/forecast') { res.writeHead(200, _H); return res.end(JSON.stringify(getForecast())); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getBudgetStatus()));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/budget/record' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { recordUsage } = await import('./token-budget.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(recordUsage(JSON.parse(b2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/reflect/stats | GET /api/reflect/lessons | POST /api/reflect/pre | POST /api/reflect/post | POST /api/reflect/milestone
  if (url.startsWith('/api/reflect') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getLessons, getReflectionStats } = await import('./reflection.mjs');
      if (url === '/api/reflect/stats') { res.writeHead(200, _H); return res.end(JSON.stringify(getReflectionStats())); }
      const agentId = new URL('http://x' + url).searchParams.get('agentId');
      res.writeHead(200, _H); return res.end(JSON.stringify(getLessons(agentId)));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/reflect/pre' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { reflectPre } = await import('./reflection.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(await reflectPre(JSON.parse(b2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/reflect/milestone' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { reflectMilestone } = await import('./reflection.mjs');
      const { agentId } = JSON.parse(b2);
      res.writeHead(200, _H); res.end(JSON.stringify({ ok: true, status: 'started' }));
      reflectMilestone(agentId).catch(() => {});
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/namespace | GET /api/namespace/:project | POST /api/namespace/check | POST /api/namespace/register
  if (url.startsWith('/api/namespace') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { listNamespaces, getNamespace } = await import('./namespace.mjs');
      const proj = url.replace('/api/namespace/', '').replace('/api/namespace', '');
      if (proj) { res.writeHead(200, _H); return res.end(JSON.stringify(getNamespace(proj))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(listNamespaces()));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/namespace/check' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { checkNamespacePerm } = await import('./namespace.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(checkNamespacePerm(JSON.parse(b2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/tools | GET /api/tools/stats | GET /api/tools/:name | POST /api/tools/register | POST /api/tools/invoke
  if (url.startsWith('/api/tools') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { searchTools, getTool, getToolStats } = await import('./tool-registry.mjs');
      if (url === '/api/tools/stats') { res.writeHead(200, _H); return res.end(JSON.stringify(getToolStats())); }
      const toolName = url.replace('/api/tools/', '').replace('/api/tools', '');
      if (toolName && toolName !== '?') {
        const q = new URL('http://x' + url).searchParams.get('q');
        if (q) { res.writeHead(200, _H); return res.end(JSON.stringify(searchTools(q))); }
        res.writeHead(200, _H); return res.end(JSON.stringify(getTool(toolName)));
      }
      res.writeHead(200, _H); return res.end(JSON.stringify(searchTools()));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/tools/register' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { registerTool } = await import('./tool-registry.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(registerTool(JSON.parse(b2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/tools/invoke' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { invokeTool } = await import('./tool-registry.mjs');
      const { tool, params, invoker } = JSON.parse(b2);
      res.writeHead(200, _H); return res.end(JSON.stringify(await invokeTool(tool, params || {}, invoker || 'api')));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/dag | GET /api/dag/:runId | POST /api/dag/run | POST /api/dag/done
  if (url.startsWith('/api/dag') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { listDAGs, getDAGRun } = await import('./dag.mjs');
      const runId = url.replace('/api/dag/', '').replace('/api/dag', '');
      if (runId) { res.writeHead(200, _H); return res.end(JSON.stringify(getDAGRun(runId))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(listDAGs()));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/dag/run' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { runDAG } = await import('./dag.mjs'); const { name, params } = JSON.parse(b2); res.writeHead(200, _H); return res.end(JSON.stringify(await runDAG(name, params || {}))); }
    catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/dag/done' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { markNodeDone } = await import('./dag.mjs'); const { runId, nodeId } = JSON.parse(b2); res.writeHead(200, _H); return res.end(JSON.stringify(await markNodeDone(runId, nodeId))); }
    catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/anomaly/status | GET /api/anomaly/alerts | POST /api/anomaly/record
  if (url.startsWith('/api/anomaly') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getAnomalyStatus, getActiveAlerts } = await import('./anomaly-detector.mjs');
      if (url === '/api/anomaly/alerts') { res.writeHead(200, _H); return res.end(JSON.stringify(getActiveAlerts())); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getAnomalyStatus()));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/anomaly/record' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { recordMetric } = await import('./anomaly-detector.mjs'); const { agentId, metric, value } = JSON.parse(b2); recordMetric(agentId, metric, value); res.writeHead(200, _H); return res.end(JSON.stringify({ ok: true })); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/schema/types | GET /api/schema/stats | POST /api/schema/validate
  if (url.startsWith('/api/schema') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      if (url === '/api/schema/stats') { const { getSchemaStats } = await import('./schema-enforcer.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getSchemaStats())); }
      const { listSchemas } = await import('./schema-enforcer.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(listSchemas()));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/schema/validate' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { validateOutput } = await import('./schema-enforcer.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(validateOutput(JSON.parse(b2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/debate/start | GET /api/debate/stats | GET /api/debate/:id
  if (url.startsWith('/api/debate') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getDebateStats } = await import('./debate.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getDebateStats())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/debate/start' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { runDebate } = await import('./debate.mjs');
      const params = JSON.parse(b2);
      res.writeHead(200, _H); res.end(JSON.stringify({ ok: true, debateId: params.debateId || 'pending', status: 'started' }));
      runDebate(params).then(r => console.log(`[Debate] Done: ${r.id} conf=${r.confidence}`)).catch(() => {});
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/fsm/:taskId | GET /api/fsm/stats | POST /api/fsm/transition
  if (url.startsWith('/api/fsm') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getTaskFSM, getFSMStats } = await import('./fsm.mjs');
      const taskId = url.replace('/api/fsm/', '').replace('/api/fsm', '');
      if (taskId && taskId !== 'stats') { res.writeHead(200, _H); return res.end(JSON.stringify(getTaskFSM(taskId))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getFSMStats()));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/fsm/transition' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { transition } = await import('./fsm.mjs'); const r = transition(JSON.parse(b2)); res.writeHead(200, _H); return res.end(JSON.stringify(r)); }
    catch (e) { res.writeHead(400, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/model-router/status | POST /api/model-router/record | POST /api/model-router/reset
  if (url.startsWith('/api/model-router') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getModelRouterStatus } = await import('./model-router.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getModelRouterStatus())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/model-router/record' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { recordModelCall } = await import('./model-router.mjs'); recordModelCall(JSON.parse(b2)); res.writeHead(200, _H); return res.end(JSON.stringify({ ok: true })); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/context-guard/stats
  if (url === '/api/context-guard/stats' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getContextStats } = await import('./context-guard.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getContextStats())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/sla/active | GET /api/sla/stats | POST /api/sla/register | POST /api/sla/complete
  if (url.startsWith('/api/sla') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getActiveSLA, getSLAStats } = await import('./sla-monitor.mjs');
      if (url === '/api/sla/stats') { res.writeHead(200, _H); return res.end(JSON.stringify(getSLAStats())); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getActiveSLA()));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/playbook/run { name, params } | GET /api/playbook | GET /api/playbook/:runId | POST /api/playbook/define
  if (url.startsWith('/api/playbook') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { listPlaybooks, getRunStatus } = await import('./playbook.mjs');
      const runId = url.replace('/api/playbook/', '').replace('/api/playbook', '');
      if (runId && runId !== '/api/playbook') { res.writeHead(200, _H); return res.end(JSON.stringify(getRunStatus(runId))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(listPlaybooks()));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/playbook/run' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { runPlaybook } = await import('./playbook.mjs'); const { name, params } = JSON.parse(b2); res.writeHead(200, _H); return res.end(JSON.stringify(await runPlaybook(name, params || {}))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/playbook/define' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { definePlaybook } = await import('./playbook.mjs'); const { name, steps, description } = JSON.parse(b2); res.writeHead(200, _H); return res.end(JSON.stringify(definePlaybook(name, { description, steps }))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/self-critic/stats | POST /api/self-critic/review
  if (url === '/api/self-critic/stats' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getSelfCriticStats } = await import('./self-critic.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getSelfCriticStats())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/self-critic/review' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { reviewBeforeSubmit } = await import('./self-critic.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(await reviewBeforeSubmit(JSON.parse(b2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/skills/:agentId | /api/skills/:agentId/:skill
  if (url.startsWith('/api/skills/') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const parts = url.split('/').filter(Boolean); // ['api','skills','agentId','skill?']
      const agentId = parts[2]; const skill = parts[3];
      const { listSkills } = await import('./skill-injector.mjs');
      res.writeHead(200, _H); return res.end(JSON.stringify(listSkills(agentId)));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/handoff/stats | GET /api/handoff/:taskId | POST /api/handoff/create
  if (url.startsWith('/api/handoff') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getHandoff, getHandoffStats } = await import('./context-handoff.mjs');
      if (url === '/api/handoff/stats') { res.writeHead(200, _H); return res.end(JSON.stringify(getHandoffStats())); }
      const taskId = url.split('/api/handoff/')[1];
      if (taskId) { res.writeHead(200, _H); return res.end(JSON.stringify(getHandoff(taskId))); }
      res.writeHead(400, _H); return res.end(JSON.stringify({ error: 'taskId required' }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/handoff/create' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { createHandoff } = await import('./context-handoff.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(await createHandoff(JSON.parse(b2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/errors/clusters | GET /api/errors/stats | POST /api/errors/report
  if (url.startsWith('/api/errors') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getClusters, getErrorStats } = await import('./error-cluster.mjs');
      if (url === '/api/errors/stats') { res.writeHead(200, _H); return res.end(JSON.stringify(getErrorStats())); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getClusters({ minCount: parseInt(params.get('min') || '1') })));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/errors/report' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { reportError } = await import('./error-cluster.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(await reportError(JSON.parse(b2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/memory/decay/stats | POST /api/memory/decay/reinforce | POST /api/memory/decay/gc
  if (url.startsWith('/api/memory/decay') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getDecayStats } = await import('./memory-decay.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getDecayStats())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/memory/decay/reinforce' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { reinforceMemory } = await import('./memory-decay.mjs'); const { memoryId, memoryType } = JSON.parse(b2); res.writeHead(200, _H); return res.end(JSON.stringify({ strength: reinforceMemory(memoryId, memoryType) })); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/memory/decay/gc' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { gcStaleMemories } = await import('./memory-decay.mjs'); const removed = gcStaleMemories(); res.writeHead(200, _H); return res.end(JSON.stringify({ removed: removed.length, items: removed })); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/traces?agent=...&limit=20 | GET /api/traces/:traceId | GET /api/traces/stats
  if (url.startsWith('/api/traces') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getTraces, getTraceStats } = await import('./tracer.mjs');
      if (url === '/api/traces/stats') { res.writeHead(200, _H); return res.end(JSON.stringify(getTraceStats())); }
      const traceId = url.split('/api/traces/')[1];
      if (traceId && traceId !== 'stats') { res.writeHead(200, _H); return res.end(JSON.stringify(getTraces({ traceId }))); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getTraces({ agent: params.get('agent'), limit: parseInt(params.get('limit') || '20') })));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/contracts/violations | GET /api/contracts/stats
  if (url.startsWith('/api/contracts') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getContractViolations, getContractStats } = await import('./output-validator.mjs');
      if (url === '/api/contracts/stats') { res.writeHead(200, _H); return res.end(JSON.stringify(getContractStats())); }
      res.writeHead(200, _H); return res.end(JSON.stringify(getContractViolations(parseInt(params.get('limit') || '20'))));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/webhook/github — GitHub webhook receiver → fires trigger events
  if (url === '/api/webhook/github' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const ghEvent = req.headers['x-github-event'] || 'unknown';
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const payload = JSON.parse(b2);
      const { fireEvent } = await import('./trigger-engine.mjs');
      let result = { event: ghEvent, fired: 0 };
      if (ghEvent === 'pull_request' && payload.action === 'opened') {
        result = await fireEvent('github.pr_opened', {
          pr_title: payload.pull_request?.title || 'PR',
          pr_number: payload.pull_request?.number || '?',
          author: payload.pull_request?.user?.login || 'unknown',
          branch: payload.pull_request?.head?.ref || 'unknown',
          files: `${payload.pull_request?.changed_files || '?'} files`,
          repo: payload.repository?.name || 'unknown',
        });
      } else if (ghEvent === 'push') {
        result = await fireEvent('github.push', {
          repo: payload.repository?.name || 'unknown',
          branch: (payload.ref || '').replace('refs/heads/', ''),
          commit_count: payload.commits?.length || 1,
          files: payload.commits?.flatMap(c => c.added?.concat(c.modified) || []).slice(0, 5).join(', ') || 'unknown',
          pusher: payload.pusher?.name || 'unknown',
        });
      } else if (ghEvent === 'issues' && payload.action === 'opened') {
        result = await fireEvent('github.push', {
          repo: payload.repository?.name || 'unknown',
          branch: 'issue',
          commit_count: 0,
          files: payload.issue?.title || 'new issue',
          pusher: payload.issue?.user?.login || 'unknown',
        });
      }
      res.writeHead(200, _H); return res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(200, _H); return res.end(JSON.stringify({ ok: true, skipped: true, error: e.message })); }
  }

  // POST /api/triggers/fire { event, payload } — fire an event trigger
  if (url === '/api/triggers/fire' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try {
      const { event, payload } = JSON.parse(b2);
      if (!event) { res.writeHead(400, _H); return res.end(JSON.stringify({ error: 'event required' })); }
      const { fireEvent } = await import('./trigger-engine.mjs');
      const result = await fireEvent(event, payload || {});
      res.writeHead(200, _H); return res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/triggers — list rules | POST — add rule
  if (url === '/api/triggers' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { listRules } = await import('./trigger-engine.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(listRules())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/triggers' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let b2 = ''; for await (const c of req) b2 += c;
    try { const { addRule } = await import('./trigger-engine.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(addRule(JSON.parse(b2)))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/triggers/log' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getTriggerLog } = await import('./trigger-engine.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getTriggerLog(parseInt(params.get('limit') || '20')))); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/cache/stats — prompt cache hit rate
  if (url === '/api/cache/stats' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getCacheStats } = await import('./prompt-cache.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getCacheStats())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/agents/self-improver — skill delta stats
  if (url === '/api/agents/self-improver' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try { const { getSelfImproverStats } = await import('./self-improver.mjs'); res.writeHead(200, _H); return res.end(JSON.stringify(getSelfImproverStats())); }
    catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

    // GET /api/costs/guard — budget status & recommendations
  if (url === '/api/costs/guard' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { checkBudgetStatus, shouldPauseTasks, shouldUseCheapModelsOnly } = await import('./cost-guard.mjs');
      const status = checkBudgetStatus();
      res.writeHead(200, _H);
      return res.end(JSON.stringify({
        ok: status.ok,
        data: status,
        pause_tasks: shouldPauseTasks(),
        use_cheap_only: shouldUseCheapModelsOnly(),
      }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/costs/spend — detailed spend breakdown by model/agent
  if (url === '/api/costs/spend' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getSpendBreakdown } = await import('./cost-guard.mjs');
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, ...getSpendBreakdown() }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // PATCH /api/costs/limit { daily_limit_usd }
  if (url === '/api/costs/limit' && req.method === 'PATCH') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { daily_limit_usd } = JSON.parse(body);
      const { setDailyBudget } = await import('./cost-guard.mjs');
      const result = setDailyBudget(daily_limit_usd);
      res.writeHead(result.ok ? 200 : 400, _H);
      return res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/costs/record { agent, model, input_tokens, output_tokens }
  if (url === '/api/costs/record' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { agent, model, input_tokens, output_tokens } = JSON.parse(body);
      const { recordCost } = await import('./cost-guard.mjs');
      const result = recordCost(agent, model, input_tokens, output_tokens);
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, ...result }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

// GET /api/costs/optimizer — cost optimizer stats (tier distribution)
  if (url === '/api/costs/optimizer' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getCostOptimizerStats, checkDailyBudget } = await import('./cost-optimizer.mjs');
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ stats: getCostOptimizerStats(), budget: checkDailyBudget() }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/sos/status — SOS protocol status & leadership
  if (url === '/api/sos/status' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getSOSReport } = await import('./sos-protocol.mjs');
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, ...getSOSReport() }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/sos/check — run health check (manual trigger)
  if (url === '/api/sos/check' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { sosHealthCheck } = await import('./sos-protocol.mjs');
      const result = await sosHealthCheck();
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, ...result }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/sos/leadership — current command structure
  if (url === '/api/sos/leadership' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getLeadership } = await import('./sos-protocol.mjs');
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, ...getLeadership() }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/sos/delegate { task_type } — get routing decision
  if (url === '/api/sos/delegate' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { task_type } = JSON.parse(body);
      const { getDelegateAgent, getLeadership } = await import('./sos-protocol.mjs');
      const agent = getDelegateAgent(task_type);
      res.writeHead(200, _H);
      return res.end(JSON.stringify({
        ok: true,
        agent,
        task_type,
        leadership: getLeadership(),
      }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/agents/health — full agent health dashboard
  if (url === '/api/agents/health' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const [{ getRateLimitStats }, { getTriageStats }, { getConsensusStats }, { getEvalMetrics }, { getCostOptimizerStats, checkDailyBudget }] = await Promise.all([
        import('./rate-limiter.mjs'),
        import('./triage-agent.mjs'),
        import('./stochastic-consensus.mjs'),
        import('./quality-judge.mjs'),
        import('./cost-optimizer.mjs'),
      ]);
      const dashboard = {
        ts: Date.now(),
        rateLimits: getRateLimitStats(),
        triage: getTriageStats(),
        consensus: getConsensusStats(),
        evalMetrics: getEvalMetrics(),
        costOptimizer: getCostOptimizerStats(),
        budget: checkDailyBudget(),
      };
      res.writeHead(200, _H); return res.end(JSON.stringify(dashboard));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/agents/triage — triage log stats
  if (url === '/api/agents/triage' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getTriageStats } = await import('./triage-agent.mjs');
      res.writeHead(200, _H); return res.end(JSON.stringify(getTriageStats()));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/agents/consensus — stochastic consensus stats
  if (url === '/api/agents/consensus' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getConsensusStats } = await import('./stochastic-consensus.mjs');
      res.writeHead(200, _H); return res.end(JSON.stringify(getConsensusStats()));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/rate-limits — per-agent rate limit stats
  if (url === '/api/rate-limits' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getRateLimitStats } = await import('./rate-limiter.mjs');
      res.writeHead(200, _H); return res.end(JSON.stringify(getRateLimitStats()));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/memory/shared?q=... — cross-agent memory query
  // Learning API endpoints
  // === VECTOR EMBEDDINGS ENDPOINTS ===
  if (url.startsWith('/api/embeddings/')) {
    // GET /api/embeddings/search?query=...&type=all&topK=5
    if (url.startsWith('/api/embeddings/search') && req.method === 'GET') {
      const searchParams = new URL(`http://localhost:5190${url}`).searchParams;
      const query = searchParams.get('query') || '';
      const type = searchParams.get('type') || 'all';
      const topK = parseInt(searchParams.get('topK') || '5');
      
      const results = vectorEmbeddings.semanticSearch(query, type, topK);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, results, query, count: results.length }));
      return;
    }
    
    // GET /api/embeddings/stats
    if (url === '/api/embeddings/stats' && req.method === 'GET') {
      const stats = vectorEmbeddings.getIndexStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stats }));
      return;
    }
  }
  
  // === REASONING TRACES ENDPOINTS ===
  if (url.startsWith('/api/traces/')) {
    // GET /api/traces/stats?agent=forge
    if (url.startsWith('/api/traces/stats') && req.method === 'GET') {
      const agent = new URL(`http://localhost:5190${url}`).searchParams.get('agent');
      const stats = reasoningTraces.getTracesStats(agent);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stats }));
      return;
    }
    
    // GET /api/traces/patterns?agent=forge
    if (url.startsWith('/api/traces/patterns') && req.method === 'GET') {
      const agent = new URL(`http://localhost:5190${url}`).searchParams.get('agent');
      const patterns = reasoningTraces.extractDecisionPatterns(agent);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, patterns }));
      return;
    }
  }
  
  // === REFLECTION LOOP ENDPOINTS ===
  if (url.startsWith('/api/reflection/')) {
    // GET /api/reflection/metrics?agent=forge
    if (url.startsWith('/api/reflection/metrics') && req.method === 'GET') {
      const agent = new URL(`http://localhost:5190${url}`).searchParams.get('agent');
      const metrics = reflectionLoop.getReflectionMetrics(agent);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, metrics }));
      return;
    }
  }
  
  // === CONTEXT COMPRESSION ENDPOINTS ===
  if (url.startsWith('/api/compression/')) {
    // POST /api/compression/compress
    if (url === '/api/compression/compress' && req.method === 'POST') {
      const result = contextCompression.compressAll();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }
    
    // GET /api/compression/hierarchy
    if (url === '/api/compression/hierarchy' && req.method === 'GET') {
      const hierarchy = contextCompression.getMemoryHierarchy();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, hierarchy }));
      return;
    }
    
    // GET /api/compression/archive-stats
    if (url === '/api/compression/archive-stats' && req.method === 'GET') {
      const stats = contextCompression.getArchiveStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stats }));
      return;
    }
  }
  
  // === CONFIDENCE SCORING ENDPOINTS ===
  if (url.startsWith('/api/confidence/')) {
    // GET /api/confidence/metrics?agent=forge
    if (url.startsWith('/api/confidence/metrics') && req.method === 'GET') {
      const metrics = confidenceScoring.getConfidenceMetrics();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, metrics }));
      return;
    }
    
    // POST /api/confidence/score - Score an item
    if (url === '/api/confidence/score' && req.method === 'POST') {
      const body = await parseJSON(req).catch(() => ({}));
      const scored = confidenceScoring.scoreItem(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, scored }));
      return;
    }
  }
  
  // === FAILURE RECOVERY ENDPOINTS ===
  if (url.startsWith('/api/recovery/')) {
    // POST /api/recovery/checkpoint?agent=forge
    if (url.startsWith('/api/recovery/checkpoint') && req.method === 'POST') {
      const agent = new URL(`http://localhost:5190${url}`).searchParams.get('agent') || 'forge';
      const state = sessionState.loadAgentState(agent) || {};
      const checkpoint = failureRecovery.createCheckpoint(agent, state);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, checkpoint }));
      return;
    }
    
    // POST /api/recovery/handoff?agent=forge
    if (url.startsWith('/api/recovery/handoff') && req.method === 'POST') {
      const agent = new URL(`http://localhost:5190${url}`).searchParams.get('agent') || 'forge';
      const handoff = failureRecovery.executeHandoff(agent);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, handoff }));
      return;
    }
    
    // GET /api/recovery/stats
    if (url === '/api/recovery/stats' && req.method === 'GET') {
      const stats = failureRecovery.getRecoveryStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stats }));
      return;
    }
    
    // GET /api/recovery/history?agent=forge
    if (url.startsWith('/api/recovery/history') && req.method === 'GET') {
      const agent = new URL(`http://localhost:5190${url}`).searchParams.get('agent');
      const history = failureRecovery.getRecoveryHistory(agent);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, history }));
      return;
    }
  }

  // === ENTITY GRAPH ENDPOINTS ===
  if (url.startsWith('/api/graph/')) {
    // POST /api/graph/node - Add node
    if (url === '/api/graph/node' && req.method === 'POST') {
      const body = await parseJSON(req).catch(() => ({}));
      const node = entityGraph.addNode(body.id, body.type, body.data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, node }));
      return;
    }
    
    // POST /api/graph/edge - Add edge
    if (url === '/api/graph/edge' && req.method === 'POST') {
      const body = await parseJSON(req).catch(() => ({}));
      const edge = entityGraph.addEdge(body.from, body.to, body.relation_type, body.weight);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, edge }));
      return;
    }
    
    // GET /api/graph/node/:id - Get node and relations
    if (url.startsWith('/api/graph/node/') && req.method === 'GET') {
      const id = url.split('/').pop();
      const data = entityGraph.getNodeAndRelations(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data }));
      return;
    }
    
    // GET /api/graph/path?from=X&to=Y - Find path
    if (url.startsWith('/api/graph/path') && req.method === 'GET') {
      const params = new URL(`http://localhost:5190${url}`).searchParams;
      const from = params.get('from');
      const to = params.get('to');
      const path = entityGraph.findPath(from, to);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path }));
      return;
    }
    
    // GET /api/graph/influence/:id - Influence chain
    if (url.startsWith('/api/graph/influence/') && req.method === 'GET') {
      const id = url.split('/').pop();
      const chain = entityGraph.getInfluenceChain(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, chain }));
      return;
    }
    
    // GET /api/graph/stats - Graph statistics
    if (url === '/api/graph/stats' && req.method === 'GET') {
      const stats = entityGraph.getGraphStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stats }));
      return;
    }
  }

  // === ANOMALY DETECTION ENDPOINTS ===
  if (url.startsWith('/api/anomalies/')) {
    // POST /api/anomalies/detect - Detect anomalies
    if (url === '/api/anomalies/detect' && req.method === 'POST') {
      const body = await parseJSON(req).catch(() => ({}));
      const result = anomalyDetection.detectAnomalies(body.metrics || {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }
    
    // GET /api/anomalies/history - Anomaly history
    if (url === '/api/anomalies/history' && req.method === 'GET') {
      const history = anomalyDetection.getAnomalyHistory();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, history }));
      return;
    }
    
    // GET /api/anomalies/health - System health
    if (url === '/api/anomalies/health' && req.method === 'GET') {
      const health = anomalyDetection.getSystemHealth();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, health }));
      return;
    }
  }

  // === ML EMBEDDINGS ENDPOINTS ===
  if (url.startsWith('/api/embeddings-ml/')) {
    // POST /api/embeddings-ml/index - Index with ML embeddings
    if (url === '/api/embeddings-ml/index' && req.method === 'POST') {
      const body = await parseJSON(req).catch(() => ({}));
      const indexed = embeddingsML.indexItemML(body, body.type);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, indexed }));
      return;
    }
    
    // GET /api/embeddings-ml/search - ML-powered semantic search
    if (url.startsWith('/api/embeddings-ml/search') && req.method === 'GET') {
      const query = new URL(`http://localhost:5190${url}`).searchParams.get('q') || '';
      const topK = parseInt(new URL(`http://localhost:5190${url}`).searchParams.get('topK') || '5');
      const results = embeddingsML.semanticSearchML(query, topK);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, results }));
      return;
    }
    
    // GET /api/embeddings-ml/clusters - Pattern discovery
    if (url === '/api/embeddings-ml/clusters' && req.method === 'GET') {
      const clusters = embeddingsML.discoverPatternClusters();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, clusters }));
      return;
    }
    
    // GET /api/embeddings-ml/stats - ML embeddings stats
    if (url === '/api/embeddings-ml/stats' && req.method === 'GET') {
      const stats = embeddingsML.getMLEmbeddingStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stats }));
      return;
    }
  }
  
  // === ADVANCED ANALYTICS ENDPOINTS ===
  if (url.startsWith('/api/analytics/')) {
    // POST /api/analytics/report - Generate full analytics
    if (url === '/api/analytics/report' && req.method === 'POST') {
      const body = await parseJSON(req).catch(() => ({}));
      const report = advancedAnalytics.generateAnalyticsReport(body.stats || {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, report }));
      return;
    }
    
    // GET /api/analytics/recommendations - Get recommendations
    if (url.startsWith('/api/analytics/recommendations') && req.method === 'GET') {
      const body = await parseJSON(req).catch(() => ({}));
      const recommendations = advancedAnalytics.generateRecommendations(body.stats || {});
      const ranked = advancedAnalytics.calculateROI(recommendations);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, recommendations: ranked }));
      return;
    }
  }

  // === CROSS-SESSION LEARNING ENDPOINTS ===
  if (url.startsWith('/api/learning/')) {
    // POST /api/learning/compare?agent1=forge&agent2=atlas
    if (url.startsWith('/api/learning/compare') && req.method === 'POST') {
      const params = new URL(`http://localhost:5190${url}`).searchParams;
      const agent1 = params.get('agent1') || 'forge';
      const agent2 = params.get('agent2') || 'atlas';
      const focusArea = params.get('focus') || null;
      
      const comparison = crossSessionLearning.compareAgentSessions(agent1, agent2, focusArea);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, comparison }));
      return;
    }
    
    // GET /api/learning/team-insights
    if (url === '/api/learning/team-insights' && req.method === 'GET') {
      const insights = crossSessionLearning.extractTeamInsights();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, insights }));
      return;
    }
    
    // GET /api/learning/best-practices
    if (url === '/api/learning/best-practices' && req.method === 'GET') {
      const doc = crossSessionLearning.generateBestPracticesDoc();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, doc }));
      return;
    }
    
    // GET /api/learning/stats
    if (url === '/api/learning/stats' && req.method === 'GET') {
      const stats = crossSessionLearning.getCrossSessionStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stats }));
      return;
    }
  }

  // === REALTIME SYNC ENDPOINTS ===
  if (url.startsWith('/api/sync/')) {
    // GET /api/sync/stats - Realtime sync statistics
    if (url === '/api/sync/stats' && req.method === 'GET') {
      const stats = realtimeSync.getStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stats }));
      return;
    }
    
    // GET /api/sync/events - Event history
    if (url === '/api/sync/events' && req.method === 'GET') {
      const limit = new URL(`http://localhost:5190${url}`).searchParams.get('limit') || 50;
      const events = realtimeSync.getEventHistory(parseInt(limit));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, events }));
      return;
    }
    
    // POST /api/sync/broadcast - Manual broadcast event
    if (url === '/api/sync/broadcast' && req.method === 'POST') {
      const body = await parseJSON(req).catch(() => ({}));
      realtimeSync.broadcast(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  // === SESSION STATE ENDPOINTS ===
  if (url.startsWith('/api/state/')) {
    // GET /api/state/agent/:agent - Get agent state
    if (url.startsWith('/api/state/agent/') && req.method === 'GET') {
      const agent = url.split('/api/state/agent/')[1];
      const state = sessionState.loadAgentState(agent);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, state }));
      return;
    }
    
    // GET /api/state/all - Get all agent states
    if (url === '/api/state/all' && req.method === 'GET') {
      const states = sessionState.getAllAgentStates();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, states }));
      return;
    }
    
    // POST /api/state/agent/:agent - Save agent state
    if (url.startsWith('/api/state/agent/') && req.method === 'POST') {
      const agent = url.split('/api/state/agent/')[1];
      const body = await parseJSON(req).catch(() => ({}));
      sessionState.saveAgentState(agent, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    
    // GET /api/state/incidents - Get active incidents
    if (url === '/api/state/incidents' && req.method === 'GET') {
      const incidents = sessionState.getActiveIncidents();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, incidents }));
      return;
    }
    
    // GET /api/state/decisions - Get decisions
    if (url === '/api/state/decisions' && req.method === 'GET') {
      const decisions = sessionState.getDecisions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, decisions }));
      return;
    }
    
    // GET /api/state/lessons - Get lessons
    if (url === '/api/state/lessons' && req.method === 'GET') {
      const lessons = sessionState.getLessons();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, lessons }));
      return;
    }
    
    // GET /api/state/metrics - Get state metrics
    if (url === '/api/state/metrics' && req.method === 'GET') {
      const metrics = sessionState.getMetrics();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, metrics }));
      return;
    }
  }

  // === NARRATIVE MEMORY ENDPOINTS ===
  if (url.startsWith('/api/narrative/')) {
    // POST /api/narrative/record - Record an event
    if (url === '/api/narrative/record' && req.method === 'POST') {
      const body = await parseJSON(req);
      const event = await narrativeMemory.recordEvent(body.agent, body.type, body.data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, event }));
      return;
    }
    
    // GET /api/narrative/search?query=...&mode=SEMANTIC
    if (url.startsWith('/api/narrative/search') && req.method === 'GET') {
      const params = new URL(`http://localhost:5190${url}`).searchParams;
      const query = params.get('query') || '';
      const mode = params.get('mode') || 'SEMANTIC';
      
      const results = await narrativeMemory.narrativeSearch(query, mode);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, results, count: results.length }));
      return;
    }
    
    // POST /api/narrative/arc - Build story arc
    if (url === '/api/narrative/arc' && req.method === 'POST') {
      const body = await parseJSON(req);
      const arc = await narrativeMemory.buildNarrativeArc(body.topic);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...arc }));
      return;
    }
    
    // GET /api/narrative/agents/:agent - Agent timeline
    if (url.startsWith('/api/narrative/agents/') && req.method === 'GET') {
      const agent = url.split('/api/narrative/agents/')[1];
      const timeline = await narrativeMemory.getAgentTimeline(agent);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...timeline }));
      return;
    }
    
    // GET /api/narrative/metrics - Overall metrics
    if (url === '/api/narrative/metrics' && req.method === 'GET') {
      const metrics = await narrativeMemory.getNarrativeMetrics();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...metrics }));
      return;
    }
  }

  // === CLOUDFLARE API ENDPOINTS ===
  if (url.startsWith('/api/cloudflare/')) {
    const CF_TOKEN = 'process.env.CF_API_TOKEN';
    const CF_ZONE_ID = '5aa37039abd7a1462c8426cf7685d11d';
    
    // GET /api/cloudflare/dns - List DNS records
    if (url === '/api/cloudflare/dns' && req.method === 'GET') {
      try {
        const result = await new Promise((resolve, reject) => {
          https.get({
            hostname: 'api.cloudflare.com',
            path: `/client/v4/zones/${CF_ZONE_ID}/dns_records`,
            headers: { 'Authorization': `Bearer ${CF_TOKEN}` }
          }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                resolve(json.result || []);
              } catch {
                reject(new Error('Parse error'));
              }
            });
          }).on('error', reject);
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, records: result }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }
    
    // GET /api/cloudflare/status - Check token status
    if (url === '/api/cloudflare/status' && req.method === 'GET') {
      try {
        const result = await new Promise((resolve, reject) => {
          https.get({
            hostname: 'api.cloudflare.com',
            path: '/client/v4/user/tokens/verify',
            headers: { 'Authorization': `Bearer ${CF_TOKEN}` }
          }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                resolve({
                  valid: json.success,
                  status: json.result?.status || 'unknown',
                  message: json.messages?.[0]?.message || 'OK'
                });
              } catch {
                reject(new Error('Parse error'));
              }
            });
          }).on('error', reject);
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }
  }

  if (url === '/api/learning/status' && req.method === 'GET') {
    const { getLearningStats } = await import('./learning-api.mjs');
    try {
      const stats = getLearningStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...stats }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (url === '/api/learning/trigger' && req.method === 'POST') {
    exec('cd ~/projects/ASYSTEM/learning && node youtube-learning-agent.mjs cycle > /tmp/learning-cycle.log 2>&1 &');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Learning cycle triggered' }));
    return;
  }

  if (url === '/api/memory/shared' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { querySharedMemory } = await import('./shared-memory.mjs');
      const q = params.get('q') || '';
      const top = parseInt(params.get('top') || '5');
      if (!q) { res.writeHead(400, _H); return res.end(JSON.stringify({ error: 'q required' })); }
      const results = await querySharedMemory(q, { topK: top });
      res.writeHead(200, _H); return res.end(JSON.stringify({ query: q, results }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // POST /api/memory/shared { content, agent, tags } — add to shared memory
  if (url === '/api/memory/shared' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { content, agent, tags = [] } = JSON.parse(body);
      const { addToSharedMemory } = await import('./shared-memory.mjs');
      const result = await addToSharedMemory(content, agent, { tags });
      res.writeHead(result.ok ? 200 : 400, _H);
      return res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/memory/agents/{agent}?q=... — memory from specific agent
  if (url.match(/^\/api\/memory\/agents\/[\w-]+/) && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const agent = url.split('/')[4];
      const q = params.get('q') || '';
      const limit = parseInt(params.get('limit') || '10');
      const { getAgentMemory } = await import('./shared-memory.mjs');
      const result = await getAgentMemory(agent, q, limit);
      res.writeHead(result.ok ? 200 : 404, _H);
      return res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/memory/search?q=...&agent=... — search all agents
  if (url.startsWith('/api/memory/search') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const q = params.get('q') || '';
      const agent = params.get('agent') || null;
      const top = parseInt(params.get('top') || '5');
      const { searchAllAgents } = await import('./shared-memory.mjs');
      const result = await searchAllAgents(q, { top, agentFilter: agent });
      res.writeHead(200, _H);
      return res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/memory/stats — shared memory statistics
  if (url === '/api/memory/stats' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getMemoryStats } = await import('./shared-memory.mjs');
      const result = await getMemoryStats();
      res.writeHead(result.ok ? 200 : 500, _H);
      return res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/decision-trace[?limit=50] — Decision trace log (WHY agents acted)
  if (url === '/api/decision-trace' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const limit = parseInt(params.get('limit') || '50');
      const traceFile = path.join(os.homedir(), '.openclaw/workspace/decision-trace.jsonl');
      let entries = [];
      try {
        entries = fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch {}
      const recent = entries.slice(-limit).reverse();
      const blocked = recent.filter(e => e.decision === 'blocked').length;
      const injections = recent.filter(e => e.type === 'dispatch.injection').length;
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ total: entries.length, showing: recent.length, blocked, injections, entries: recent }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/agents/profile/:agentId — Behavioral profile (Observability pattern)
  if (url.match(/^\/api\/agents\/profile\/[^/]+$/) && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const agentId = url.split('/')[4];
    try {
      const metricsFile = path.join(os.homedir(), '.openclaw/workspace/eval-metrics.json');
      const traceFile   = path.join(os.homedir(), '.openclaw/workspace/decision-trace.jsonl');
      let metrics = {}; try { metrics = JSON.parse(fs.readFileSync(metricsFile, 'utf8')); } catch {}
      let traces  = []; try {
        traces = fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
          .filter(t => t.actor === agentId);
      } catch {}
      const agentMetrics = metrics.byAgent?.[agentId] || {};
      const blockedCount = traces.filter(t => t.decision === 'blocked').length;
      const profile = {
        agentId,
        tasksTotal:    agentMetrics.total    || 0,
        tasksPassed:   agentMetrics.passed   || 0,
        tasksFailed:   agentMetrics.failed   || 0,
        avgScore:      agentMetrics.avgScore || null,
        passRate:      agentMetrics.total ? Math.round(agentMetrics.passed / agentMetrics.total * 100) : null,
        blockedDispatches: blockedCount,
        recentDecisions: traces.slice(-10).reverse(),
        anomaly: agentMetrics.avgScore && agentMetrics.avgScore < 4
          ? `Low average score (${agentMetrics.avgScore.toFixed(1)}) — possible quality degradation` : null,
      };
      res.writeHead(200, _H); return res.end(JSON.stringify(profile));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/eval/metrics — Layer 1 persistent eval metrics + regression detection
  if (url === '/api/eval/metrics' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getEvalMetrics } = await import('./quality-judge.mjs');
      const metrics = getEvalMetrics();
      // Regression alert
      if (metrics.regression?.regression) {
        console.warn(`[EvalMetrics] ⚠️ REGRESSION DETECTED: pass rate dropped ${metrics.regression.drop}% vs 7-day avg`);
      }
      res.writeHead(200, _H);
      return res.end(JSON.stringify(metrics, null, 2));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  if (url === '/api/optimization/stats' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getCostStats, getShadowStats, getCircuitBreakers } = await import('./optimization-architect.mjs');
      const { getJudgeStats, getEvalMetrics } = await import('./quality-judge.mjs');
      const { getDecomposerStats } = await import('./task-decomposer.mjs');
      const evalMetrics = getEvalMetrics();
      res.writeHead(200, _H);
      return res.end(JSON.stringify({
        costs:           getCostStats(),
        shadow:          getShadowStats(),
        circuitBreakers: getCircuitBreakers(),
        judge:           getJudgeStats(),
        fractals:        getDecomposerStats(),
        evalMetrics,                                   // Layer 1: persistent metrics
        regression:      evalMetrics.regression,       // quick access
        ts:              Date.now(),
      }));
    } catch (e) {
      res.writeHead(500, _H);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── CFO: session token stats (from session_status) ───────────────
  if (url === '/api/cfo/stats') {
    // Real token stats from session JSONL files
    const sessionsDir = path.join(USER_HOME_DIR, '.openclaw/agents/main/sessions');
    let todayIn = 0, todayOut = 0, todayCost = 0, todayCacheRead = 0, todayCacheWrite = 0;
    let weekIn = 0, weekOut = 0, weekCost = 0;
    let todaySessions = 0, weekSessions = 0;
    const modelCosts = {};
    const now = Date.now();
    const DAY_MS = 86400000;
    const WEEK_MS = 7 * DAY_MS;
    try {
      const sessionFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
      for (const file of sessionFiles) {
        const filePath = path.join(sessionsDir, file);
        const stat = fs.statSync(filePath);
        const fileAge = now - stat.mtimeMs;
        if (fileAge > WEEK_MS * 2) continue; // skip old files
        const lines = fs.readFileSync(filePath, 'utf8').split('\n');
        let fileInDay = 0, fileInWeek = 0, fileCostDay = 0, fileCostWeek = 0;
        let hasDay = false, hasWeek = false;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (d.type !== 'message') continue;
            const msg = d.message ?? {};
            const usage = msg.usage;
            if (!usage) continue;
            const ts = new Date(d.timestamp ?? 0).getTime();
            const age = now - ts;
            const model = msg.model ?? 'unknown';
            const cost = usage.cost?.total ?? 0;
            const inTok = usage.input ?? 0;
            const outTok = usage.output ?? 0;
            const cacheR = usage.cacheRead ?? 0;
            const cacheW = usage.cacheWrite ?? 0;
            if (age < DAY_MS) {
              fileInDay += inTok; fileCostDay += cost; hasDay = true;
              todayCacheRead += cacheR; todayCacheWrite += cacheW;
              todayOut += outTok;
            }
            if (age < WEEK_MS) {
              fileInWeek += inTok; fileCostWeek += cost; hasWeek = true;
              weekOut += outTok;
              modelCosts[model] = (modelCosts[model] ?? { cost: 0, tokens: 0 });
              modelCosts[model].cost += cost;
              modelCosts[model].tokens += inTok + outTok;
            }
          } catch {}
        }
        if (hasDay) { todayIn += fileInDay; todayCost += fileCostDay; todaySessions++; }
        if (hasWeek) { weekIn += fileInWeek; weekCost += fileCostWeek; weekSessions++; }
      }
    } catch {}
    // Cache hit rate
    const totalCacheTokens = todayCacheRead + todayCacheWrite;
    const cacheHitRate = totalCacheTokens > 0 ? Math.round((todayCacheRead / totalCacheTokens) * 100) : 0;
    // Model breakdown
    const totalCost = Object.values(modelCosts).reduce((s, m) => s + m.cost, 0) || 1;
    const models = Object.entries(modelCosts)
      .map(([model, m]) => ({ model, pct: Math.round((m.cost / totalCost) * 100), cost: parseFloat(m.cost.toFixed(4)) }))
      .sort((a, b) => b.pct - a.pct).slice(0, 5);

    const stats = {
      today: { inputTokens: todayIn, outputTokens: todayOut, cost: parseFloat(todayCost.toFixed(4)), sessions: todaySessions },
      week:  { inputTokens: weekIn, outputTokens: weekOut, cost: parseFloat(weekCost.toFixed(4)), sessions: weekSessions },
      models: models.length ? models : [{ model: 'claude-sonnet-4-6', pct: 100, cost: 0 }],
      cacheHitRate,
      cacheReadTokens: todayCacheRead,
      cacheWriteTokens: todayCacheWrite,
      recommendations: [
        cacheHitRate < 40 ? 'Включи prompt cache — текущий hit rate < 40%' : `Cache hit rate ${cacheHitRate}% — хорошо!`,
        todayCost > 2 ? 'Высокий расход сегодня → переключи рутинные задачи на Haiku' : 'Расход в норме',
        'Тяжёлый анализ → Gemini Pro (дешевле Opus на 60%)',
      ],
      source: 'real',
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(stats));
  }

  // ── Real Intel / Analytics stats ────────────────────────────────
  // ── CF Analytics — traffic per zone ─────────────────────────────────
  if (url.startsWith('/api/cloudflare/analytics')) {
    const CF_KEY   = 'eae1f47bf14a5ffa450893e4ecc1f35c9b8ce';
    const CF_EMAIL = 'urmatdigital@gmail.com';
    const CF_ACCT  = '1ac78bbd68e3a81a2750288ebb4e2d41';
    const ZONE_IDS = {
      'asystem.kg': '5aa37039abd7a1462c8426cf7685d11d',
      'aurva.kg': 'bf9c8199c66b286fac19e9b98aa50425',
      'fiatex.kg': 'c1d0392b5ccdbd9e928a7e394f3df1e0',
      'twinbridge.kg': '09954e104effe520a983ab40f5966e31',
      'aconsult.kg': '325eef5055d6ecca276f3ce6160b2e83',
      'voltera.kg': '1661f2abcf0ece9ed63d4d251051d7a5',
      'evpower.kg': 'b65a2660442f5cc595a1b741e9e2ee58',
    };
    // DNS Analytics via GraphQL (works for DNS-only zones; HTTP REST API is sunset)
    const gqlDateTo   = new Date().toISOString().slice(0, 10);
    const gqlDateFrom = (() => { const d = new Date(); d.setDate(d.getDate() - 6); return d.toISOString().slice(0,10); })();
    const gqlYesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0,10); })();

    const cfGQL = (body) => new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify(body);
      const req = https.request({
        hostname: 'api.cloudflare.com',
        path: '/client/v4/graphql',
        method: 'POST',
        headers: { 'X-Auth-Email': CF_EMAIL, 'X-Auth-Key': CF_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
        timeout: 15000,
      }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); });
      req.on('error', reject); req.write(bodyStr); req.end();
    });

    try {
      const results = await Promise.all(
        Object.entries(ZONE_IDS).map(async ([name, id]) => {
          // DNS query totals by day (7 days)
          const dnsResp = await cfGQL({
            query: `{
              viewer {
                zones(filter: { zoneTag: "${id}" }) {
                  dnsAnalyticsAdaptiveGroups(
                    limit: 7
                    filter: { date_geq: "${gqlDateFrom}", date_leq: "${gqlDateTo}" }
                    orderBy: [date_ASC]
                  ) {
                    count
                    dimensions { date }
                  }
                }
              }
            }`
          }).catch(() => null);

          const dnsGroups = dnsResp?.data?.viewer?.zones?.[0]?.dnsAnalyticsAdaptiveGroups ?? [];
          const weekDns   = dnsGroups.reduce((s, g) => s + (g.count ?? 0), 0);
          const todayDns  = dnsGroups.find(g => g.dimensions?.date === gqlYesterday)?.count ?? dnsGroups[dnsGroups.length - 1]?.count ?? 0;
          const history   = dnsGroups.map(g => ({ date: g.dimensions?.date ?? '', requests: g.count ?? 0, uniques: 0 }));

          return {
            zone: name, id,
            today:   { requests: todayDns, bytes: 0, threats: 0, uniques: 0 },
            week:    { requests: weekDns,  bytes: 0, threats: 0, pageViews: 0 },
            history,
            dnsOnly: true,
          };
        })
      );
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ zones: results, ts: Date.now() }));
    } catch (e) {
      res.writeHead(503); return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/api/intel/stats') {
    const execP = promisify(exec);
    const projectsDir = path.join(USER_HOME_DIR, 'projects');
    let commitsWeek = 0, filesChanged = 0, activeBranches = 0;

    // Git commits across ~/projects in last 7 days
    try {
      const { stdout } = await execP(
        // Exclude auto-backup commits (bd: backup, auto-, Auto commits)
        `find "${projectsDir}" -name ".git" -maxdepth 3 -type d 2>/dev/null | head -15 | while read d; do git -C "$(dirname $d)" log --oneline --since="7 days ago" 2>/dev/null | grep -v "bd: backup\\|^[a-f0-9]* auto-\\|^[a-f0-9]* Auto "; done | wc -l`,
        { timeout: 10000, shell: true }
      );
      commitsWeek = parseInt(stdout.trim()) || 0;
    } catch {}

    // Count Veritas done tasks this week
    let issuesClosedWeek = 0;
    try {
      const keyMatch = fs.existsSync(path.join(USER_HOME_DIR, 'projects/veritas/server/.env'))
        ? fs.readFileSync(path.join(USER_HOME_DIR, 'projects/veritas/server/.env'), 'utf8').match(/VERITAS_ADMIN_KEY=(.+)/)
        : null;
      const vKey = keyMatch ? keyMatch[1].trim() : '';
      if (vKey) {
        const tasksData = await new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('timeout')), 3000);
          http.get(`http://localhost:3002/api/v1/tasks`, { headers: { 'x-api-key': vKey } }, (r) => {
            clearTimeout(timer);
            let body = ''; r.on('data', d => body += d); r.on('end', () => { try { res(JSON.parse(body)); } catch { res({}); } });
          }).on('error', rej);
        });
        issuesClosedWeek = (tasksData?.data ?? []).filter(t => t.status === 'done').length;
      }
    } catch {}

    // Count Squad Chat events as swarm proxy
    let squadMessages = 0;
    try {
      const keyMatch2 = fs.existsSync(path.join(USER_HOME_DIR, 'projects/veritas/server/.env'))
        ? fs.readFileSync(path.join(USER_HOME_DIR, 'projects/veritas/server/.env'), 'utf8').match(/VERITAS_ADMIN_KEY=(.+)/)
        : null;
      const vKey2 = keyMatch2 ? keyMatch2[1].trim() : '';
      if (vKey2) {
        const chatData = await new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('timeout')), 2000);
          http.get(`http://localhost:3002/api/v1/chat/squad`, { headers: { 'x-api-key': vKey2 } }, (r) => {
            clearTimeout(timer); let body = ''; r.on('data', d => body += d); r.on('end', () => res(JSON.parse(body)));
          }).on('error', rej);
        });
        squadMessages = (chatData?.data ?? []).length;
      }
    } catch {}

    // Session count from openclaw sessions dir (try multiple paths)
    let sessionCount = 0;
    try {
      const sessDir1 = path.join(USER_HOME_DIR, '.openclaw/agents/main/sessions');
      const sessDir2 = path.join(USER_HOME_DIR, '.openclaw/sessions');
      const files1 = fs.existsSync(sessDir1) ? fs.readdirSync(sessDir1).filter(f => f.endsWith('.jsonl')).length : 0;
      const files2 = fs.existsSync(sessDir2) ? fs.readdirSync(sessDir2).filter(f => f.endsWith('.json')).length : 0;
      sessionCount = files1 + files2;
    } catch {}

    // Learnings count
    const learningsDir = path.join(USER_HOME_DIR, '.openclaw/workspace/.learnings');
    let learningsCount = 0, errorsCount = 0;
    try {
      const errText = fs.readFileSync(path.join(learningsDir, 'ERRORS.md'), 'utf8');
      errorsCount = (errText.match(/^###/gm) ?? []).length;
      const lText = fs.readFileSync(path.join(learningsDir, 'LEARNINGS.md'), 'utf8');
      learningsCount = (lText.match(/^\| 20/gm) ?? []).length;
    } catch {}

    // Real cost today from session JSONL
    let costToday = 0;
    try {
      const sessDir = path.join(USER_HOME_DIR, '.openclaw/agents/main/sessions');
      // Use UTC+6 (Bishkek) day boundary — align with user's timezone
      const tzOffset = 6 * 60; // minutes
      const nowLocal = new Date(Date.now() + tzOffset * 60000);
      const todayStr = nowLocal.toISOString().slice(0, 10);
      const todayStartMs = new Date(todayStr + 'T00:00:00Z').getTime() - tzOffset * 60000; // UTC start of local day
      const sessFiles = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
      for (const sf of sessFiles) {
        const sfPath = path.join(sessDir, sf);
        const stat = fs.statSync(sfPath);
        // Skip files not touched today at all (fast filter)
        if (stat.mtimeMs < todayStartMs) continue;
        const lines = fs.readFileSync(sfPath, 'utf8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (d.type !== 'message') continue;
            // Use message timestamp, not file mtime — accurate per-message
            const msgTs = d.timestamp ? new Date(d.timestamp).getTime() : 0;
            if (msgTs > 0 && msgTs < todayStartMs) continue; // message from yesterday
            const usage = d.message?.usage;
            costToday += usage?.cost?.total ?? 0;
          } catch {}
        }
      }
    } catch {}
    costToday = parseFloat(costToday.toFixed(4));

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({
      commitsWeek, issuesClosedWeek, squadMessages,
      sessionCount, learningsCount, errorsCount,
      costToday,
      swarmRuns: Math.max(1, Math.floor(squadMessages / 3)),
      avgAgentsPerRun: 3,
      ts: Date.now(),
    }));
  }

  // ── Memory system stats ──────────────────────────────────────────
  // ── Memory Consolidation (Agent Zero pattern) ───────────────────
  if (url.startsWith('/api/memory/consolidate') && req.method === 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const scriptPath = path.join(USER_HOME_DIR, '.openclaw/workspace/scripts/memory-consolidate.py');
    const dryRun = req.url.includes('dry_run=true') || req.url.includes('dry-run=true');

    if (!fs.existsSync(scriptPath)) {
      res.writeHead(404);
      return res.end(JSON.stringify({ error: 'consolidation script not found', path: scriptPath }));
    }

    res.writeHead(200);
    res.write(JSON.stringify({ status: 'started', dryRun, ts: Date.now() }) + '\n');

    const args = `python3 "${scriptPath}"${dryRun ? ' --dry-run' : ''}`;
    const child = exec_child(args, { cwd: path.join(USER_HOME_DIR, '.openclaw/workspace') });
    let stderr = '';

    child.stdout.on('data', d => {
      const lines = d.toString().split('\n').filter(Boolean);
      lines.forEach(line => {
        if (!res.writableEnded) res.write(JSON.stringify({ progress: line }) + '\n');
      });
    });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => {
      if (!res.writableEnded) {
        res.end(JSON.stringify({ status: code === 0 ? 'done' : 'error', code, stderr: stderr.slice(0, 500) }) + '\n');
      }
    });
    return;
  }

  // ── Semantic Memory (OpenAI embeddings → Qdrant) ─────────────────────
  if (url === '/api/memory/embed' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const chunks = []; req.on('data', c => chunks.push(c));
    await new Promise(r => req.on('end', r));
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const { storeEmbedding } = await import('./embeddings.mjs');
      const result = await storeEmbedding(body);
      res.writeHead(result.ok ? 200 : 500, _H);
      return res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify({ error: e.message })); }
  }

  if (url.startsWith('/api/memory/recall') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const params = new URLSearchParams(req.url.split('?')[1] || '');
      const { recallMemory } = await import('./embeddings.mjs');
      const results = await recallMemory({
        query: params.get('q') || '',
        agent: params.get('agent') || undefined,
        limit: parseInt(params.get('limit') || '5'),
      });
      res.writeHead(200, _H); return res.end(JSON.stringify({ ok: true, results }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // ── ReMe semantic memory search ─────────────────────────────────────
  if (url === '/api/memory/reme/add' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const content = body.content || '';
      if (!content) { res.writeHead(400, _H); return res.end(JSON.stringify({ error: 'content required' })); }
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      const envPath = path.join(USER_HOME_DIR, '.openclaw', '.env');
      const envVars = {};
      try { const c = await fs.promises.readFile(envPath, 'utf8'); for (const l of c.split('\n')) { const [k,...v]=l.split('='); if(k&&v.length) envVars[k.trim()]=v.join('=').trim().replace(/^"|"$/g,''); } } catch {}
      const zvecPy2    = path.join(USER_HOME_DIR, '.zvec-env/bin/python3');
      const scriptPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'reme_search_zvec.py');
      const memType    = body.type || body.memory_type || 'fact';
      const memTarget  = body.target || body.memory_target || 'forge';
      const { stdout } = await execFileAsync(zvecPy2, [scriptPath, '--add', content, '--type', memType, '--target', memTarget], { env: { ...process.env, ...envVars }, timeout: 15000 });
      const result = JSON.parse(stdout || '{}');
      res.writeHead(200, _H); return res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // ── AI Assist (Phi-4 via OpenRouter) ──────────────────────────────────
  if (url === '/api/ai-assist' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const chunks = []; req.on('data', c => chunks.push(c));
    await new Promise(r => req.on('end', r));
    const { content = '', instruction = '', model = 'microsoft/phi-4' } = (() => {
      try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; }
    })();
    try {
      const body = JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: `You are a professional technical writer for ASYSTEM (AI agent infrastructure company). The user asks you to modify the following document according to the instruction.\n\nInstruction: ${instruction}\n\nDocument:\n${content.slice(0, 6000)}\n\nReturn only the updated document content in the same markdown format. Do not add explanations.`,
        }],
        max_tokens: 2048,
      });
      const result = await new Promise((resolve, reject) => {
        const req2 = https.request({
          hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer process.env.OPENROUTER_API_KEY`,
            'HTTP-Referer': 'https://os.asystem.kg', 'X-Title': 'ASYSTEM Docs AI',
            'Content-Length': Buffer.byteLength(body),
          }, timeout: 60000,
        }, res2 => {
          let d = '';
          res2.on('data', c => d += c);
          res2.on('end', () => {
            try { const r = JSON.parse(d); resolve(r?.choices?.[0]?.message?.content || ''); }
            catch { reject(new Error('parse error')); }
          });
        });
        req2.on('error', reject); req2.on('timeout', () => { req2.destroy(); reject(new Error('timeout')); });
        req2.write(body); req2.end();
      });
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ result }));
    } catch (e) {
      res.writeHead(500, _H);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Docs API (server-side persistence) ────────────────────────────────
  if (url.startsWith('/api/docs') && ['GET','POST','PUT','DELETE'].includes(req.method)) {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const DOCS_FILE = path.join(USER_HOME_DIR, 'projects/ASYSTEM/api/docs.json');
    const loadDocs = async () => { try { return JSON.parse(await fs.promises.readFile(DOCS_FILE,'utf8')); } catch { return {}; } };
    const saveDocs = async (d) => fs.promises.writeFile(DOCS_FILE, JSON.stringify(d, null, 2));

    if (req.method === 'GET') {
      const docs = await loadDocs();
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ docs }));
    }
    const chunks = []; req.on('data', c => chunks.push(c));
    await new Promise(r => req.on('end', r));
    const body = (() => { try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; } })();

    if (req.method === 'POST') {
      const docs = await loadDocs();
      const id = body.id || `doc-${Date.now()}`;
      docs[id] = { ...body, id, updatedAt: new Date().toISOString() };
      await saveDocs(docs);
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, id, doc: docs[id] }));
    }
    if (req.method === 'PUT') {
      const docs = await loadDocs();
      const id = body.id || url.split('/')[3];
      if (!docs[id]) { res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Not found' })); }
      docs[id] = { ...docs[id], ...body, updatedAt: new Date().toISOString() };
      await saveDocs(docs);
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, doc: docs[id] }));
    }
    if (req.method === 'DELETE') {
      const docs = await loadDocs();
      const id = url.split('/api/docs/')[1]?.split('?')[0] || body.id;
      delete docs[id];
      await saveDocs(docs);
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true }));
    }
  }

  // ── Minecraft Event Bus (SSE) ─────────────────────────────────────────
  if (!global.mcEventClients) global.mcEventClients = new Set();
  if (!global.mcEventLog)     global.mcEventLog = [];   // last 100 events

  // SSE stream: GET /api/mc/events
  if (url.startsWith('/api/mc/events') && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    // Replay last 50 events
    global.mcEventLog.slice(-50).forEach(ev => res.write(`data: ${JSON.stringify(ev)}\n\n`));
    const client = { res, id: Date.now() };
    global.mcEventClients.add(client);
    req.on('close', () => global.mcEventClients.delete(client));
    return;
  }

  // POST /api/mc/event — agents post events here
  if (url === '/api/mc/event' && req.method === 'POST') {
    const body = await new Promise(resolve => {
      let d = ''; req.on('data', c => d += c); req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    const ev = { ...body, ts: Date.now() };
    global.mcEventLog.push(ev);
    if (global.mcEventLog.length > 100) global.mcEventLog.shift();
    global.mcEventClients.forEach(c => {
      try { c.res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {}
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Minecraft RCON + Agent Position API ───────────────────────────────
// SSH-based RCON: more reliable than direct TCP from Mac Mini
const { execFile } = await import('child_process');
const sshRcon = (command) => new Promise(resolve => {
  const s = net.createConnection({ host: '100.79.117.102', port: 25575 });
  s.setTimeout(5000);
  let rbuf = Buffer.alloc(0), authed = false;
  const pkt = (id, type, payload) => {
    const p = Buffer.from(payload + '\x00', 'utf8');
    const b = Buffer.alloc(12 + p.length);
    b.writeInt32LE(8 + p.length, 0); b.writeInt32LE(id, 4); b.writeInt32LE(type, 8);
    p.copy(b, 12); s.write(b);
  };
  s.on('connect', () => pkt(1, 3, 'asystem-rcon-2026'));
  s.on('data', d => {
    rbuf = Buffer.concat([rbuf, d]);
    if (rbuf.length < 4) return;
    const len = rbuf.readInt32LE(0);
    if (rbuf.length < 4 + len) return;
    const id = rbuf.readInt32LE(4);
    if (!authed) { authed = true; pkt(2, 2, command); return; }
    s.destroy(); resolve(rbuf.slice(12, 4 + len - 2).toString('utf8').replace(/§./g, '').trim());
  });
  s.on('timeout', () => { s.destroy(); resolve(''); });
  s.on('error', () => resolve(''));
});
// Cache for MC status
if (!global._mcOnlinePlayers) global._mcOnlinePlayers = [];
if (!global._mcOnlineCount) global._mcOnlineCount = 0;
// Refresh MC status every 30s
setInterval(async () => {
  try {
    const result = await sshRcon('list');
    const m = result.match(/(\d+)/g);
    const pm = result.match(/:\s*(.+)$/);
    global._mcOnlineCount = m ? parseInt(m[0]) : 0;
    global._mcOnlinePlayers = pm ? pm[1].split(',').map(p=>p.trim()).filter(Boolean) : [];
    global._mcStatusCache = { ts: Date.now(), mc: { online: global._mcOnlineCount, max: 30, players: global._mcOnlinePlayers }, bluemap: 'https://bluemap.te.kg' };
  } catch {}
}, 30000);
// Initial fetch
setTimeout(async () => {
  try {
    const result = await sshRcon('list');
    const m = result.match(/(\d+)/g);
    const pm = result.match(/:\s*(.+)$/);
    global._mcOnlineCount = m ? parseInt(m[0]) : 0;
    global._mcOnlinePlayers = pm ? pm[1].split(',').map(p=>p.trim()).filter(Boolean) : [];
    global._mcStatusCache = { ts: Date.now(), mc: { online: global._mcOnlineCount, max: 30, players: global._mcOnlinePlayers }, bluemap: 'https://bluemap.te.kg' };
  } catch {}
}, 5000);


  if (url.startsWith('/api/mc') && (req.method === 'POST' || req.method === 'GET')) {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const mcUrl = url.split('?')[0];

    if (mcUrl === '/api/mc/rcon' && req.method === 'POST') {
      // Execute RCON command on MC server
      const body = await new Promise(resolve => {
        let d = ''; req.on('data', c => d += c); req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
      });
      const { command } = body;
      if (!command) { res.writeHead(400, _H); return res.end(JSON.stringify({ error: 'command required' })); }
      try {
        const net = await import('net');
        const result = await new Promise((resolve, reject) => {
          const s = net.createConnection({ host: '100.79.117.102', port: 25575 });
          s.setTimeout(5000);
          let buf = Buffer.alloc(0);
          const pkt = (id, type, payload) => {
            const p = Buffer.from(payload, 'utf8');
            const b = Buffer.alloc(14 + p.length);
            b.writeInt32LE(10 + p.length, 0);
            b.writeInt32LE(id, 4); b.writeInt32LE(type, 8);
            p.copy(b, 12); b.writeUInt16LE(0, 12 + p.length);
            s.write(b);
          };
          s.on('connect', () => { pkt(1, 3, 'asystem-rcon-2026'); });
          s.on('data', (data) => {
            buf = Buffer.concat([buf, data]);
            if (buf.length < 4) return;
            const len = buf.readInt32LE(0);
            if (buf.length < 4 + len) return;
            const reqId = buf.readInt32LE(4);
            if (reqId === 1) { pkt(2, 2, command); return; }
            if (reqId === 2) {
              const str = buf.slice(12, 4 + len - 2).toString('utf8');
              s.destroy(); resolve(str);
            }
          });
          s.on('timeout', () => { s.destroy(); reject(new Error('timeout')); });
          s.on('error', reject);
        });
        res.writeHead(200, _H); res.end(JSON.stringify({ ok: true, result }));
      } catch (e) { res.writeHead(500, _H); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    if (mcUrl === '/api/mc/agents' && req.method === 'GET') {
      // Return cached positions
      res.writeHead(200, _H);
      res.end(JSON.stringify({ status: 'online', agents: Array.from(global._mcPositions ? Object.entries(global._mcPositions).map(([name,pos]) => ({name,...pos})) : []) }));
      return;
    }

    // POST /api/mc/positions — agents push their positions here
    if (mcUrl === '/api/mc/positions' && req.method === 'POST') {
      const chunks = []; req.on('data', c => chunks.push(c));
      await new Promise(r => req.on('end', r));
      try {
        const { positions } = JSON.parse(Buffer.concat(chunks).toString());
        global._mcPositions = { ...(global._mcPositions || {}), ...positions };
        res.writeHead(200, _H); res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400, _H); res.end(JSON.stringify({ error: 'bad json' })); }
      return;
    }

    // GET /api/mc/positions — live positions for Panel map
    if (mcUrl === '/api/mc/positions' && req.method === 'GET') {
      res.writeHead(200, _H);
      res.end(JSON.stringify({ positions: global._mcPositions || {}, ts: Date.now() }));
      return;
    }

    // POST /api/mc/broadcast — Panel sends message to MC world via mc-agents relay
    if (mcUrl === '/api/mc/broadcast' && req.method === 'POST') {
      const chunks = []; req.on('data', c => chunks.push(c));
      await new Promise(r => req.on('end', r));
      try {
        const { agent = 'Panel', message = '', command } = JSON.parse(Buffer.concat(chunks).toString());
        if (!message.trim() && !command) { res.writeHead(400, _H); return res.end(JSON.stringify({ error: 'empty message' })); }
        // Relay via mc-viewer on MC server (Tailscale direct) — was: mc.te.kg/relay/broadcast (Hetzner, retired 2026-03-13)
        const relay = await fetch('http://100.79.117.102:8100/relay/broadcast', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ agent, message, command }),
          signal: AbortSignal.timeout(6000),
        }).catch(() => null);
        if (relay?.ok) {
          const result = await relay.json().catch(() => ({}));
          res.writeHead(200, _H); res.end(JSON.stringify(result));
        } else {
          // Fallback: direct RCON tellraw
          const net2 = await import('node:net');
          const rconMsg = command || `/tellraw @a {"text":"[${agent}] ${message.slice(0,200)}","color":"aqua"}`;
          await new Promise(resolve => {
            const s = net2.default.createConnection({ host: '100.79.117.102', port: 25575 });
            s.setTimeout(4000);
            const pkt = (id, type, payload) => {
              const p = Buffer.from(payload, 'utf8');
              const b = Buffer.alloc(14 + p.length);
              b.writeInt32LE(10 + p.length, 0); b.writeInt32LE(id, 4); b.writeInt32LE(type, 8);
              p.copy(b, 12); b.writeUInt16LE(0, 12 + p.length); s.write(b);
            };
            s.on('connect', () => pkt(1, 3, 'asystem-rcon-2026'));
            let authed = false;
            s.on('data', () => { if (!authed) { authed = true; pkt(2, 2, rconMsg); } else { s.destroy(); resolve(); } });
            s.on('error', resolve); s.on('timeout', () => { s.destroy(); resolve(); });
          });
          res.writeHead(200, _H); res.end(JSON.stringify({ ok: true, method: 'rcon-fallback' }));
        }
      } catch(e) { res.writeHead(500, _H); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // GET /api/mc/status — fast status via cached RCON
    if (mcUrl === '/api/mc/status' && req.method === 'GET') {
      // Return last known MC status + Convex task counts
      const cached = global._mcStatusCache;
      if (cached && Date.now() - cached.ts < 30000) {
        res.writeHead(200, _H); return res.end(JSON.stringify(cached));
      }
      // Refresh in background
      (async () => {
        try {
          const mcResult = await new Promise((resolve) => {
            const s = net.createConnection({ host: '100.79.117.102', port: 25575 });
            s.setTimeout(4000);
            let buf = Buffer.alloc(0);
            const pkt = (id, type, payload) => {
              const p = Buffer.from(payload, 'utf8');
              const b = Buffer.alloc(14 + p.length);
              b.writeInt32LE(10 + p.length, 0); b.writeInt32LE(id, 4); b.writeInt32LE(type, 8);
              p.copy(b, 12); b.writeUInt16LE(0, 12 + p.length); s.write(b);
            };
            s.on('connect', () => pkt(1, 3, 'asystem-rcon-2026'));
            s.on('data', (data) => {
              buf = Buffer.concat([buf, data]);
              if (buf.length < 4) return;
              const len = buf.readInt32LE(0);
              if (buf.length < 4 + len) return;
              const reqId = buf.readInt32LE(4);
              if (reqId === 1) { pkt(2, 2, 'list'); return; }
              if (reqId === 2) {
                const str = buf.slice(12, 4+len-2).toString('utf8').replace(/§./g,'');
                s.destroy();
                const m = str.match(/(\d+)/g);
                const pm = str.match(/:\s*(.+)$/);
                resolve({
                  online: m ? parseInt(m[0]) : 0,
                  max: m ? parseInt(m[1]) : 30,
                  players: pm ? pm[1].split(',').map(p=>p.trim()).filter(Boolean) : []
                });
              }
            });
            s.on('timeout', () => { s.destroy(); resolve(global._mcStatusCache?.mc || { online: 0, max: 30, players: [] }); });
            s.on('error', () => resolve(global._mcStatusCache?.mc || { online: 0, max: 30, players: [] }));
          });
          global._mcStatusCache = { ts: Date.now(), mc: mcResult, bluemap: 'https://bluemap.te.kg' };
        } catch {}
      })();
      const fallback = global._mcStatusCache || { ts: Date.now(), mc: { online: 0, max: 30, players: [] }, bluemap: 'https://bluemap.te.kg' };
      res.writeHead(200, _H); res.end(JSON.stringify(fallback));
      return;
    }

    // POST /api/mc/sync-tasks — Sync Convex tasks → Minecraft world state
    if (mcUrl === '/api/mc/sync-tasks' && req.method === 'POST') {
      const AGENT_PLOTS = {
        forge:  [100,-62,-10], atlas: [140,-62,-10], iron: [180,-62,-10],
        mesa:   [100,-62,30],  pixel: [140,-62,30],  dana: [180,-62,30],
        nurlan: [100,-62,70],  ainura:[140,-62,70],  marat:[180,-62,70],
        bekzat: [100,-62,110]
      };
      const STATUS_BLOCKS = {
        idle:'gray_concrete', todo:'white_concrete', 'in_progress':'lime_concrete',
        done:'diamond_block', blocked:'red_concrete', review:'gold_block',
        working:'lime_concrete', pending:'yellow_concrete'
      };
      const WORK_ZONES = {
        forge:  [105,-59,-5], atlas: [145,-59,-5], iron: [185,-59,-5],
        mesa:   [105,-59,35], pixel: [145,-59,35], dana: [185,-59,35],
        nurlan: [105,-59,75], ainura:[145,-59,75], marat:[185,-59,75],
        bekzat: [105,-59,115]
      };

      const mcRcon = (cmd) => new Promise((resolve) => {
        const MC_HOST = '100.79.117.102', MC_PORT = 25575, MC_PASS = 'asystem-rcon-2026';
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

      try {
        const body = await new Promise(resolve => {
          let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(JSON.parse(d || '{}')));
        });
        const tasks = body.tasks || [];
        const synced = [];

        for (const task of tasks) {
          const agent = (task.assignee || '').toLowerCase().trim();
          const plot = AGENT_PLOTS[agent];
          if (!plot) continue;
          const [px, py, pz] = plot;
          const status = task.status || 'idle';
          const block = STATUS_BLOCKS[status] || 'gray_concrete';
          const capAgent = agent.charAt(0).toUpperCase() + agent.slice(1);

          // 1. Color block at plot base
          await mcRcon(`setblock ${px} ${py} ${pz} minecraft:${block}`);

          // 2. Token budget → XP bar
          const tokenEst = Math.min(200, Math.floor((task.title || '').length * 3));
          await mcRcon(`xp set ${capAgent} ${tokenEst} points`);

          // 3. Scoreboard load counter
          await mcRcon(`scoreboard players set ${capAgent} load ${tasks.filter(t => (t.assignee||'').toLowerCase() === agent && t.status !== 'done').length}`);

          // 4. Status effects (visual)
          if (status === 'working' || status === 'in_progress') {
            const wz = WORK_ZONES[agent];
            if (wz) await mcRcon(`tp ${capAgent} ${wz[0]} ${wz[1]} ${wz[2]}`);
            await mcRcon(`particle minecraft:flame ${px} ${py+4} ${pz} 0.3 0.5 0.3 0 8 force`);
          } else if (status === 'done') {
            await mcRcon(`scoreboard players add ${capAgent} tasks_done 1`);
            await mcRcon(`particle minecraft:firework ${px} ${py+5} ${pz} 1 1 1 0 20 force`);
          } else if (status === 'blocked') {
            await mcRcon(`particle minecraft:smoke ${px} ${py+4} ${pz} 0.5 1 0.5 0.05 15 force`);
          }

          synced.push({ agent, status, block, tokenEst });
          await new Promise(r => setTimeout(r, 300)); // RCON rate limit
        }

        // Broadcast summary to world
        if (synced.length > 0) {
          const working = synced.filter(s => s.status === 'in_progress' || s.status === 'working').length;
          const done = synced.filter(s => s.status === 'done').length;
          await mcRcon(`say §b[SYNC] §f${synced.length} агентов синхронизированы: §a${working} работают §f| §e${done} завершили`);
        }

        res.writeHead(200, _H);
        res.end(JSON.stringify({ ok: true, synced: synced.length, agents: synced }));
      } catch(e) {
        res.writeHead(500, _H);
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // POST /api/mc/task-event — Single task event → instant world update
    if (mcUrl === '/api/mc/task-event' && req.method === 'POST') {
      const body = await new Promise(resolve => {
        let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(JSON.parse(d || '{}')));
      });
      const { agent, status, title, priority } = body;
      const AGENT_PLOTS = {
        forge:[100,-62,-10], atlas:[140,-62,-10], iron:[180,-62,-10],
        mesa:[100,-62,30], pixel:[140,-62,30], dana:[180,-62,30],
        nurlan:[100,-62,70], ainura:[140,-62,70], marat:[180,-62,70], bekzat:[100,-62,110]
      };
      const STATUS_BLOCKS = {
        todo:'white_concrete', 'in_progress':'lime_concrete', done:'diamond_block',
        blocked:'red_concrete', review:'gold_block', idle:'gray_concrete'
      };
      const mcRcon2 = (cmd) => new Promise(resolve => {
          const s = net.createConnection({ host: '100.79.117.102', port: 25575 });
          s.setTimeout(5000);
          let buf2 = Buffer.alloc(0), authed2 = false;
          const pkt2 = (id, type, payload) => {
            const p = Buffer.from(payload + '\x00', 'utf8');
            const b = Buffer.alloc(12 + p.length);
            b.writeInt32LE(8 + p.length, 0); b.writeInt32LE(id, 4); b.writeInt32LE(type, 8);
            p.copy(b, 12); s.write(b);
          };
          s.on('connect', () => pkt2(1, 3, 'asystem-rcon-2026'));
          s.on('data', d => {
            buf2 = Buffer.concat([buf2, d]);
            while (buf2.length >= 4) {
              const len2 = buf2.readInt32LE(0);
              if (buf2.length < 4 + len2) break;
              const id2 = buf2.readInt32LE(4);
              const body2 = buf2.slice(12, 4 + len2 - 2).toString('utf8');
              buf2 = buf2.slice(4 + len2);
              if (!authed2) { authed2 = true; pkt2(2, 2, cmd); }
              else { s.destroy(); resolve(body2); return; }
            }
          });
          s.on('timeout', () => { s.destroy(); resolve(''); });
          s.on('error', () => resolve(''));
      });

      const agentKey = (agent||'').toLowerCase();
      const plot = AGENT_PLOTS[agentKey];
      if (plot) {
        const block = STATUS_BLOCKS[status] || 'gray_concrete';
        await mcRcon2(`setblock ${plot[0]} ${plot[1]} ${plot[2]} minecraft:${block}`);
        
        // NPC nameplate reaction
        const NPC_IDS = {forge:0,atlas:1,iron:2,mesa:3,pixel:4,dana:5,nurlan:6,ainura:7,marat:8,bekzat:9};
        const STATUS_COLORS = {
          in_progress:'§a', 'in-progress':'§a', working:'§a', done:'§b',
          blocked:'§c', review:'§e', todo:'§7', idle:'§8'
        };
        const npcId = NPC_IDS[agentKey];
        if (npcId !== undefined) {
          const color = STATUS_COLORS[status] || '§7';
          const statusTag = status === 'in_progress' || status === 'working' ? '⚙' :
                            status === 'done' ? '✓' : status === 'blocked' ? '✗' :
                            status === 'review' ? '?' : '○';
          const capName = agentKey.charAt(0).toUpperCase() + agentKey.slice(1);
          const newName = `${color}[${statusTag}] ${capName}`;
          await mcRcon2(`npc rename ${newName} --id ${npcId}`);
        }
        
        res.writeHead(200, _H);
        res.end(JSON.stringify({ ok: true, agent, status, block }));
      } else {
        res.writeHead(404, _H);
        res.end(JSON.stringify({ error: 'agent not found' }));
      }
      return;
    }

    // POST /api/mc/bluemap-update — trigger BlueMap re-render of agent zone
    if (mcUrl === '/api/mc/bluemap-update' && req.method === 'POST') {
      // Update only the agent zone (chunks around plots)
      const updates = [
        'bluemap update world',
      ];
      const results = [];
      for (const cmd of updates) {
        const r = await sshRcon(cmd);
        results.push(r);
      }
      res.writeHead(200, _H);
      res.end(JSON.stringify({ ok: true, results }));
      return;
    }

    // GET /api/mc/world-state — Single source of truth: Convex + MC combined
    if (mcUrl === '/api/mc/world-state' && req.method === 'GET') {
      try {
        // Get MC online players
        const mcPlayers = await new Promise((resolve) => {
          const s = net.createConnection({ host: '100.79.117.102', port: 25575 });
          s.setTimeout(4000);
          let buf = Buffer.alloc(0);
          const pkt = (id, type, payload) => {
            const p = Buffer.from(payload, 'utf8');
            const b = Buffer.alloc(14 + p.length);
            b.writeInt32LE(10 + p.length, 0); b.writeInt32LE(id, 4); b.writeInt32LE(type, 8);
            p.copy(b, 12); b.writeUInt16LE(0, 12 + p.length); s.write(b);
          };
          s.on('connect', () => pkt(1, 3, 'asystem-rcon-2026'));
          s.on('data', (data) => {
            buf = Buffer.concat([buf, data]);
            if (buf.length < 4) return;
            const len = buf.readInt32LE(0);
            if (buf.length < 4 + len) return;
            const reqId = buf.readInt32LE(4);
            if (reqId === 1) { pkt(2, 2, 'list'); return; }
            if (reqId === 2) {
              const str = buf.slice(12, 4+len-2).toString('utf8').replace(/§./g,'');
              s.destroy();
              const m = str.match(/(\d+).*?(\d+)/);
              const pm = str.match(/:\s*(.+)$/);
              resolve({
                online: m ? parseInt(m[1]) : 0,
                max: m ? parseInt(m[2]) : 30,
                players: pm ? pm[1].split(',').map(p=>p.trim()).filter(Boolean) : []
              });
            }
          });
          s.on('timeout', () => { s.destroy(); resolve({ online: 0, max: 30, players: [] }); });
          s.on('error', () => resolve({ online: 0, max: 30, players: [] }));
        });

        // Get Convex tasks
        let convexTasks = [];
        try {
          const cr = await fetch('https://expert-dachshund-299.convex.cloud/api/query', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: 'tasks:list', args: {} }),
            signal: AbortSignal.timeout(6000)
          });
          const cd = await cr.json();
          convexTasks = cd.value || cd.result || [];
        } catch {}

        // Merge: agent → { mcOnline, convexTasks, status }
        const AGENTS = ['Forge','Atlas','Iron','Mesa','Pixel','Dana','Nurlan','Ainura','Marat','Bekzat'];
        const agentState = {};
        for (const a of AGENTS) {
          const key = a.toLowerCase();
          const tasks = convexTasks.filter(t => (t.assignee||'').toLowerCase() === key);
          const active = tasks.find(t => ['in-progress','in_progress','working'].includes(t.status));
          const blocked = tasks.find(t => t.status === 'blocked');
          const done = tasks.filter(t => t.status === 'done').length;
          agentState[a] = {
            mcOnline: mcPlayers.players.includes(a),
            activeTask: active ? active.title : null,
            blockedTask: blocked ? blocked.title : null,
            totalTasks: tasks.length,
            doneTasks: done,
            status: blocked ? 'blocked' : active ? 'in_progress' : (done > 0 ? 'idle' : 'idle'),
          };
        }

        res.writeHead(200, _H);
        res.end(JSON.stringify({
          ts: Date.now(),
          mc: mcPlayers,
          agents: agentState,
          totalConvexTasks: convexTasks.length,
        }));
      } catch (e) {
        res.writeHead(500, _H);
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // MC Agent Profiles — served from local JSON file
    if (mcUrl.startsWith('/api/mc/profiles')) {
      const profilesFile = path.join(USER_HOME_DIR, 'projects/ASYSTEM/api/mc_agent_profiles.json');
      const suffix = mcUrl.slice('/api/mc/profiles'.length);

      // POST /api/mc/profiles/apply/:name → RCON equip on Hetzner
      if (req.method === 'POST' && suffix.startsWith('/apply/')) {
        const agentName = suffix.split('/')[2];
        try {
          const db = JSON.parse(fs.readFileSync(profilesFile, 'utf8'));
          const profile = db.profiles.find(p => p.mc_username === agentName || p.id === agentName.toLowerCase());
          if (!profile) { res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Not found' })); }
          // Apply via RCON: gamemode + XP + teleport + equipment
          const rconCmds = [
            `gamemode creative ${profile.mc_username}`,
            `xp set ${profile.mc_username} ${profile.mc_stats.xp_level} levels`,
            `tp ${profile.mc_username} ${profile.spawn.x} ${profile.spawn.y} ${profile.spawn.z}`,
            ...profile.hotbar.slice(0, 5).map(h => `give ${profile.mc_username} ${h.item} ${h.count}`),
            `title ${profile.mc_username} title {"text":"${profile.emoji} ${profile.mc_username}","bold":true}`,
          ];
          // Fire RCON commands (best effort, no await)
          const rconApply = async () => {
            const net = await import('net');
            for (const cmd of rconCmds) {
              await new Promise((resolve) => {
                const s = net.createConnection({ host: '100.79.117.102', port: 25575 });
                s.setTimeout(3000);
                const pkt = (id, t, pl) => { const p = Buffer.from(pl,'utf8'); const b = Buffer.alloc(14+p.length); b.writeInt32LE(10+p.length,0); b.writeInt32LE(id,4); b.writeInt32LE(t,8); p.copy(b,12); b.writeUInt16LE(0,12+p.length); s.write(b); };
                s.on('connect', () => pkt(1,3,'asystem-rcon-2026'));
                s.on('data', (d) => { if(d[8]===1){ pkt(2,2,cmd); } else { s.destroy(); resolve(); } });
                s.on('error', resolve); s.on('timeout', () => { s.destroy(); resolve(); });
              });
            }
          };
          rconApply().catch(() => {});
          res.writeHead(200, _H);
          return res.end(JSON.stringify({ ok: true, applied: agentName, commands: rconCmds.length }));
        } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
      }

      // GET /api/mc/profiles/:id
      if (req.method === 'GET' && suffix.length > 1) {
        const name = suffix.slice(1);
        try {
          const db = JSON.parse(fs.readFileSync(profilesFile, 'utf8'));
          const profile = db.profiles.find(p => p.mc_username === name || p.id === name.toLowerCase());
          if (!profile) { res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Not found' })); }
          res.writeHead(200, _H); return res.end(JSON.stringify(profile));
        } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
      }

      // GET /api/mc/profiles → all profiles
      try {
        const db = JSON.parse(fs.readFileSync(profilesFile, 'utf8'));
        res.writeHead(200, _H);
        return res.end(JSON.stringify({ profiles: db.profiles, count: db.profiles.length, updated: db.updated }));
      } catch (e) { res.writeHead(200, _H); return res.end(JSON.stringify({ profiles: [], count: 0, error: e.message })); }
    }

    res.writeHead(404, _H); res.end(JSON.stringify({ error: 'mc endpoint not found' }));
    return;
  }

// ── Visual Insights API ────────────────────────────────────────────────
  if (url.startsWith('/api/visual-insights') && (req.method === 'POST' || req.method === 'GET')) {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const subpath = url.replace('/api/visual-insights', '').split('?')[0];

    // GET /api/visual-insights/last — recent results
    if (req.method === 'GET' && subpath === '/last') {
      try {
        const logPath = path.join(USER_HOME_DIR, 'projects/ASYSTEM/api/visual-insights.jsonl');
        let results = [];
        try {
          const content = await fs.promises.readFile(logPath, 'utf8');
          results = content.trim().split('\n').filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean).reverse().slice(0, 20);
        } catch {}
        res.writeHead(200, _H);
        return res.end(JSON.stringify({ results }));
      } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
    }

    // POST /api/visual-insights/analyze — run metrics analysis
    if (req.method === 'POST' && subpath === '/analyze') {
      res.writeHead(200, _H);
      res.end(JSON.stringify({ status: 'started', message: 'Analysis running in background' }));
      // Run async
      import('./visual_insights.mjs').then(m => m.analyzeMetrics()).catch(e => console.error('[VI] metrics error:', e.message));
      return;
    }

    // POST /api/visual-insights/ui-check — UI regression check
    if (req.method === 'POST' && subpath === '/ui-check') {
      const chunks = []; req.on('data', c => chunks.push(c));
      await new Promise(r => req.on('end', r));
      const body = (() => { try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; } })();
      res.writeHead(200, _H);
      res.end(JSON.stringify({ status: 'started', project: body.project }));
      import('./visual_insights.mjs').then(m => m.checkUIRegression(body)).catch(e => console.error('[VI] ui error:', e.message));
      return;
    }

    res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Not found' }));
  }

  // ── Security Audit API (Trivy) ─────────────────────────────────────────
  if (url.startsWith('/api/security') && (req.method === 'GET' || req.method === 'POST')) {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const subpath = url.replace('/api/security', '').split('?')[0];

    // GET /api/security/last — last scan results
    if (subpath === '/last' || subpath === '') {
      try {
        const logPath = path.join(USER_HOME_DIR, 'projects/ASYSTEM/api/security-scan.json');
        const { readFile } = await import('node:fs/promises');
        const raw = await readFile(logPath, 'utf8').catch(() => '{}');
        const data = JSON.parse(raw);
        res.writeHead(200, _H);
        return res.end(JSON.stringify(data));
      } catch(e) {
        res.writeHead(200, _H);
        return res.end(JSON.stringify({ status: 'no_scan', message: 'Run POST /api/security/scan first' }));
      }
    }

    // POST /api/security/scan — run trivy scan
    if (subpath === '/scan' && req.method === 'POST') {
      const { exec: execCmd } = await import('node:child_process');
      const outPath = path.join(USER_HOME_DIR, 'projects/ASYSTEM/api/security-scan.json');
      const scanPath = path.join(USER_HOME_DIR, 'projects/ASYSTEM');
      res.writeHead(200, _H);
      res.end(JSON.stringify({ status: 'started', message: 'Trivy scan running in background' }));
      // Run async
      execCmd(
        `trivy fs --scanners secret,vuln --severity HIGH,CRITICAL --skip-dirs node_modules --skip-dirs .git --skip-dirs dist --format json "${scanPath}" 2>/dev/null`,
        { maxBuffer: 10 * 1024 * 1024 },
        async (err, stdout) => {
          try {
            const result = JSON.parse(stdout || '{}');
            const summary = {
              scannedAt: new Date().toISOString(),
              target: scanPath,
              findings: [],
              totals: { critical: 0, high: 0, medium: 0, secrets: 0 }
            };
            for (const r of (result.Results || [])) {
              for (const v of (r.Vulnerabilities || [])) {
                summary.findings.push({ type: 'vuln', severity: v.Severity, id: v.VulnerabilityID, pkg: v.PkgName, file: r.Target });
                if (v.Severity === 'CRITICAL') summary.totals.critical++;
                else if (v.Severity === 'HIGH') summary.totals.high++;
                else summary.totals.medium++;
              }
              for (const s of (r.Secrets || [])) {
                summary.findings.push({ type: 'secret', severity: s.Severity, id: s.RuleID, file: r.Target });
                summary.totals.secrets++;
              }
            }
            const { writeFile } = await import('node:fs/promises');
            writeFile(outPath, JSON.stringify(summary, null, 2)).catch(()=>{});
          } catch(e2) { /* ignore */ }
        }
      );
      return;
    }

    res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'not found' }));
  }

  // ── Symphony: Test Results API ─────────────────────────────────────────
  if (url.startsWith('/api/test-results') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const params = new URLSearchParams(req.url.split('?')[1] || '');
      const limit = parseInt(params.get('limit') || '10');
      // Read from symphony test log file (written by agent_task_loop)
      const logPath = path.join(USER_HOME_DIR, 'projects/ASYSTEM/api/symphony-tests.jsonl');
      let results = [];
      try {
        const content = await fs.promises.readFile(logPath, 'utf8');
        results = content.trim().split('\n')
          .filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean)
          .reverse()
          .slice(0, limit);
      } catch {} // file may not exist yet
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ results, count: results.length }));
    } catch (e) {
      res.writeHead(500, _H);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url.startsWith('/api/memory/reme') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const params = new URLSearchParams(req.url.split('?')[1] || '');
      const query = params.get('q') || '';
      const user = params.get('user') || 'forge';
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      const envPath = path.join(USER_HOME_DIR, '.openclaw', '.env');
      const envVars = {};
      try {
        const envContent = await fs.promises.readFile(envPath, 'utf8');
        for (const line of envContent.split('\n')) {
          const [k, ...v] = line.split('=');
          if (k && v.length) envVars[k.trim()] = v.join('=').trim().replace(/^"|"$/g, '');
        }
      } catch {}
      // ZVec-powered search (reme_search_zvec.py) — fast vector search, ~1-2s
      const zvecPy   = path.join(USER_HOME_DIR, '.zvec-env/bin/python3');
      const scriptPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'reme_search_zvec.py');
      const topK  = params.get('top') || '5';
      const mtype = params.get('type') || params.get('mtype') || '';  // semantic|episodic|personal|system
      const zvecArgs = [scriptPath, '--query', query, '--top', topK];
      if (mtype) zvecArgs.push('--mtype', mtype);
      const { stdout } = await execFileAsync(zvecPy, zvecArgs, {
        env: { ...process.env, ...envVars },
        timeout: 15000,
      });
      const parsed = JSON.parse(stdout || '{}');
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, results: parsed.results || [], query }));
    } catch (e) {
      res.writeHead(500, _H);
      return res.end(JSON.stringify({ error: e.message, results: [] }));
    }
  }

  if (url === '/api/memory/vector/stats' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getCollectionInfo } = await import('./embeddings.mjs');
      const info = await getCollectionInfo();
      res.writeHead(200, _H); return res.end(JSON.stringify({ ok: true, ...info }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message, count: 0 })); }
  }

  if (url === '/api/memory/stats') {
    const memoryFile = path.join(USER_HOME_DIR, '.openclaw/workspace/MEMORY.md');
    const knowledgeDir = path.join(USER_HOME_DIR, '.openclaw/workspace/knowledge');
    const skillsDir = path.join(USER_HOME_DIR, '.openclaw-cli/skills');
    let memLines = 0, knowledgeFiles = 0, skillsCount = 0;
    try { memLines = fs.readFileSync(memoryFile, 'utf8').split('\n').length; } catch {}
    try { knowledgeFiles = fs.readdirSync(knowledgeDir).filter(f => f.endsWith('.md')).length; } catch {}
    try { skillsCount = fs.readdirSync(skillsDir).length; } catch {}

    const sessionDir = path.join(USER_HOME_DIR, '.openclaw/sessions');
    let sessionCount = 0;
    try {
      const entries = fs.readdirSync(sessionDir);
      // count session files (json or subdirs)
      sessionCount = entries.filter(f => f.endsWith('.json') || !f.includes('.')).length;
    } catch {}

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({
      working:    { label: 'Working Memory',    type: 'context-window', desc: 'OpenClaw session context', tokens: 42000, maxTokens: 200000 },
      episodic:   { label: 'Episodic Memory',   type: 'session-logs',   desc: 'История сессий', count: sessionCount, storage: '~/.openclaw/sessions/' },
      semantic:   { label: 'Semantic Memory',   type: 'knowledge-base', desc: 'MEMORY.md + knowledge/', lines: memLines, files: knowledgeFiles },
      procedural: { label: 'Procedural Memory', type: 'skills-protocols',desc: 'skills/ + PROTOCOLS.md', skills: skillsCount },
      ts: Date.now(),
    }));
  }

  // ── Meta-Cognitive Observer ──────────────────────────────────────
  if (url === '/api/meta/report' || (url === '/api/meta/run' && req.method === 'POST')) {
    const isRun = url === '/api/meta/run';
    try {
      const script = path.join(USER_HOME_DIR, '.openclaw/workspace/scripts/meta-cognitive-observer.py');
      const stdout = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 20000);
        exec(`python3 "${script}" --format json`, { env: { ...process.env } }, (err, out) => {
          clearTimeout(t);
          err ? reject(err) : resolve(out);
        });
      });
      let data = {};
      try { data = JSON.parse(stdout); } catch {}
      // Also run without --format json to post to Squad if it's a "run"
      if (isRun) {
        exec(`python3 "${script}"`, { env: { ...process.env } }, () => {});
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }

  // ── Memory Browser: list + read files ───────────────────────────
  if (url.startsWith('/api/memory/files')) {
    const wsDir     = path.join(USER_HOME_DIR, '.openclaw/workspace');
    const memDir    = path.join(wsDir, 'memory');
    const knowDir   = path.join(wsDir, 'knowledge');
    const learnDir  = path.join(wsDir, '.learnings');
    const fileParam = params.get('file');

    if (fileParam) {
      // Read specific file
      const allowed = [wsDir, memDir, knowDir, learnDir];
      const safe = fileParam.replace(/\.\./g, '');
      let found = null;
      for (const dir of allowed) {
        const full = path.join(dir, path.basename(safe));
        if (fs.existsSync(full)) { found = full; break; }
      }
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ error: 'not found' }));
      }
      const content = fs.readFileSync(found, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ file: path.basename(found), content }));
    }

    // List all memory files
    const collect = (dir, label) => {
      try {
        return fs.readdirSync(dir).filter(f => f.endsWith('.md') || f.endsWith('.jsonl') || f.endsWith('.yaml'))
          .map(f => {
            const full = path.join(dir, f);
            const stat = fs.statSync(full);
            return { name: f, label, size: stat.size, mtime: stat.mtimeMs };
          });
      } catch { return []; }
    };

    const files = [
      ...collect(wsDir, 'workspace').filter(f => ['MEMORY.md','SOUL.md','PROTOCOLS.md','HEARTBEAT.md','AGENTS.md','USER.md'].includes(f.name)),
      ...collect(memDir, 'memory'),
      ...collect(knowDir, 'knowledge'),
      ...collect(learnDir, 'learnings'),
    ].sort((a, b) => b.mtime - a.mtime);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ files, ts: Date.now() }));
  }

  // ── Git Activity: recent commits across projects ──────────────────
  if (url === '/api/projects' && req.method === 'GET') {
    try {
      const { execSync } = await import('child_process');
      const projectsDir = path.join(USER_HOME_DIR, 'projects');
      const projectsCapDir = path.join(USER_HOME_DIR, 'Projects');

      // Known projects with metadata
      const KNOWN = [
        { id: 'orgon',   name: 'ORGON',          color: '#8b5cf6', dir: 'ORGON',                status: 'active' },
        { id: 'aurwa',   name: 'AURWA',           color: '#06b6d4', dir: 'AURWA',                status: 'active' },
        { id: 'voltera', name: 'Voltera',         color: '#f97316', dir: 'Voltera-mobile',       status: 'active' },
        { id: 'fiatex',  name: 'FiatexKG',        color: '#eab308', dir: 'fiatexkg',             status: 'active' },
        { id: 'panel',   name: 'ASYSTEM Panel',   color: '#3b82f6', dir: '../Projects/ASYSTEM/panel', status: 'active' },
        { id: 'gastown', name: 'GasTown',         color: '#22c55e', dir: 'gt',                   status: 'active' },
        { id: 'finuchet',name: 'Finuchet',        color: '#ec4899', dir: 'apps/finuchet',        status: 'planned' },
        { id: 'fiatexcl',name: 'Fiatex Client',   color: '#a78bfa', dir: 'clients/fiatex',      status: 'active' },
      ];

      const projects = KNOWN.map(p => {
        const fullDir = p.dir.startsWith('..') 
          ? path.join(USER_HOME_DIR, p.dir.replace('..',''))
          : path.join(projectsDir, p.dir);
        
        let lastCommit = null, commitCount = 0, stack = [], progress = 0;
        try {
          lastCommit = execSync(`git -C "${fullDir}" log -1 --format="%ar|%s" 2>/dev/null`, { timeout: 3000 }).toString().trim();
          commitCount = parseInt(execSync(`git -C "${fullDir}" rev-list --count HEAD 2>/dev/null`, { timeout: 2000 }).toString().trim()) || 0;
        } catch {}
        try {
          const pkgRaw = fs.readFileSync(path.join(fullDir, 'package.json'), 'utf8');
          const pkg = JSON.parse(pkgRaw);
          stack = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })
            .filter(k => ['react','vue','next','nuxt','vite','nestjs','fastapi','postgres','prisma','convex','tailwindcss','typescript'].some(s => k.includes(s)))
            .slice(0, 4);
        } catch {}
        
        // Progress estimate from commit count
        progress = Math.min(95, Math.round((commitCount / 200) * 100));
        
        const [ago, msg] = (lastCommit || '|').split('|');
        return {
          ...p,
          path: fullDir,
          lastCommit: ago || null,
          lastMsg: msg?.slice(0, 60) || null,
          commitCount,
          stack: stack.length ? stack : ['—'],
          progress,
          agents: p.id === 'panel' ? 5 : p.id === 'orgon' ? 3 : 1,
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ projects, ts: Date.now() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/api/git/activity') {
    const projects = ['ASYSTEM/panel', 'AURWA', 'Voltera-mobile', 'clients/fiatex', 'ORGONASYSTEM', 'ASYSTEM'];
    const projectsDir = path.join(USER_HOME_DIR, 'projects');
    const results = [];
    for (const proj of projects) {
      const dir = path.join(projectsDir, proj);
      if (!fs.existsSync(path.join(dir, '.git'))) continue;
      try {
        const stdout = await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('timeout')), 5000);
          exec(
            `git -C "${dir}" log --oneline --pretty="%H|%an|%ar|%s" -8 2>/dev/null`,
            (err, out) => { clearTimeout(t); resolve(out ?? ''); }
          );
        });
        const commits = stdout.trim().split('\n').filter(Boolean).map(line => {
          const [hash, author, rel, ...msgParts] = line.split('|');
          return { hash: hash?.slice(0,7), author, rel, msg: msgParts.join('|') };
        });
        if (commits.length) results.push({ project: proj.split('/').pop(), commits });
      } catch {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ projects: results, ts: Date.now() }));
  }

  // ── Cost breakdown by model per day ──────────────────────────────
  if (url === '/api/costs/breakdown') {
    const sessionDir = path.join(USER_HOME_DIR, '.openclaw/agents/main/sessions');
    const modelCosts = {};
    const dailyCosts = {};
    try {
      const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
      for (const file of files.slice(-50)) { // last 50 sessions
        const lines = fs.readFileSync(path.join(sessionDir, file), 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type !== 'message' || obj.message?.role !== 'assistant') continue;
            const usage = obj.message?.usage;
            const cost = usage?.cost?.total ?? 0;
            const model = (obj.message?.model ?? 'unknown').replace('claude-','').replace('-20250219','').slice(0, 20);
            const day = (obj.timestamp ?? obj.message?.timestamp ?? 0);
            const dayStr = day ? new Date(typeof day === 'number' ? day : parseInt(day)).toISOString().slice(0, 10) : 'unknown';
            if (cost > 0) {
              modelCosts[model] = (modelCosts[model] ?? 0) + cost;
              if (!dailyCosts[dayStr]) dailyCosts[dayStr] = {};
              dailyCosts[dayStr][model] = (dailyCosts[dayStr][model] ?? 0) + cost;
            }
          } catch {}
        }
      }
    } catch {}
    const models = Object.entries(modelCosts).sort((a, b) => b[1] - a[1]).map(([model, cost]) => ({ model, cost: +cost.toFixed(4) }));
    const days = Object.entries(dailyCosts).sort(([a],[b]) => a.localeCompare(b)).slice(-7).map(([date, byModel]) => ({
      date, byModel, total: +Object.values(byModel).reduce((s, c) => s + c, 0).toFixed(4)
    }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ models, days, ts: Date.now() }));
  }

  // ── Agent Cost Attribution ─────────────────────────────────────────
  if (url === '/api/costs/agents') {
    // Each agent's gateway check tells us if they're online; session cost is always Forge's
    // We attribute cost by looking at audit log entries (dispatch = agent got work)
    // Plus estimate: online_agents * assumed cost rate from /api/agents
    const agentDefs = [
      { id:'forge', name:'Forge', color:'#06b6d4', model:'claude-sonnet-4-6', rate: 0.003 },
      { id:'atlas', name:'Atlas', color:'#f59e0b', model:'claude-opus-4-5',   rate: 0.015 },
      { id:'iron',  name:'IRON',  color:'#ef4444', model:'gemini-pro',        rate: 0.001 },
      { id:'mesa',  name:'MESA',  color:'#8b5cf6', model:'claude-sonnet-4-6', rate: 0.002 },
      { id:'pixel', name:'PIXEL', color:'#ec4899', model:'gemini-3.1-pro',    rate: 0.008 },
    ];
    // Read audit log for dispatch events (proxy for agent activity)
    const auditPath = path.join(USER_HOME_DIR, '.openclaw/workspace/audit-log.jsonl');
    const dispatchCounts = {};
    try {
      const lines = fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean);
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
      for (const l of lines) {
        try {
          const e = JSON.parse(l);
          if (e.ts > cutoff && (e.type === 'dispatch' || e.action === 'dispatch') && e.target) {
            dispatchCounts[e.target] = (dispatchCounts[e.target] ?? 0) + 1;
          }
        } catch {}
      }
    } catch {}
    // Read Forge's own session cost (it's the main agent)
    const sessionDir = path.join(USER_HOME_DIR, '.openclaw/agents/main/sessions');
    let forgeCost = 0;
    try {
      const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
      for (const file of files.slice(-50)) {
        const lines2 = fs.readFileSync(path.join(sessionDir, file), 'utf8').split('\n').filter(Boolean);
        for (const line of lines2) {
          try {
            const obj = JSON.parse(line);
            if (obj.type !== 'message' || obj.message?.role !== 'assistant') continue;
            const cost = obj.message?.usage?.cost?.total ?? 0;
            const day = typeof (obj.timestamp ?? 0) === "number" ? (obj.timestamp ?? 0) : new Date(obj.timestamp || 0).getTime();
            if (cost > 0 && day > Date.now() - 7 * 24 * 3600 * 1000) forgeCost += cost;
          } catch {}
        }
      }
    } catch {}
    const agents = agentDefs.map(ag => {
      const dispatches = dispatchCounts[ag.id] ?? 0;
      const cost = ag.id === 'forge' ? +forgeCost.toFixed(4) : +(dispatches * ag.rate * 10).toFixed(4);
      return { ...ag, dispatches, cost, costEstimate: ag.id !== 'forge' };
    });
    const H2c = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
    res.writeHead(200, H2c);
    return res.end(JSON.stringify({ agents, ts: Date.now() }));
  }

  // ── Prompt Registry: list files ─────────────────────────────────
  if (url === '/api/prompts') {
    const registryDir = path.join(USER_HOME_DIR, 'projects/ASYSTEM/prompt-registry');
    const result = { agents: [], workers: [], sops: [], templates: [] };
    try {
      for (const folder of ['agents', 'workers', 'sops', 'templates']) {
        const dir = path.join(registryDir, folder);
        try {
          const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
          result[folder] = files.map(f => {
            const content = fs.readFileSync(path.join(dir, f), 'utf8');
            const lines = content.split('\n');
            const title = lines.find(l => l.startsWith('# '))?.replace('# ', '') ?? f.replace('.md', '');
            const desc = lines.find(l => l.startsWith('> Role:') || l.startsWith('> Owner:') || l.startsWith('> Type:'))?.replace(/^> /, '') ?? '';
            return { id: f.replace('.md', ''), file: f, folder, title, desc, lines: lines.length };
          });
        } catch {}
      }
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ ...result, ts: Date.now() }));
  }

  // ── Prompt Registry: get file content ───────────────────────────
  if (url.startsWith('/api/prompts/')) {
    const parts = url.replace('/api/prompts/', '').split('/');
    if (parts.length === 2) {
      const [folder, fileId] = parts;
      const filePath = path.join(USER_HOME_DIR, 'projects/ASYSTEM/prompt-registry', folder, fileId + '.md');
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ content, folder, file: fileId, ts: Date.now() }));
      } catch {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ error: 'Not found' }));
      }
    }
  }

  // ── Knowledge Base: read ~/workspace/knowledge/*.md ──────────────
  if (url === '/api/knowledge' && req.method === 'GET') {
    const knowledgeDir = path.join(USER_HOME_DIR, '.openclaw/workspace/knowledge');
    const items = [];
    function scanDir(dir, prefix = '') {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const fullPath = path.join(dir, e.name);
          if (e.isDirectory()) {
            scanDir(fullPath, prefix ? `${prefix}/${e.name}` : e.name);
          } else if (e.name.endsWith('.md')) {
            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              const lines = content.split('\n');
              const title = (lines.find(l => l.startsWith('# ')) ?? '').replace(/^# /, '') || e.name.replace('.md','');
              const preview = lines.filter(l => l.trim() && !l.startsWith('#')).slice(0, 3).join(' ').slice(0, 200);
              const stat = fs.statSync(fullPath);
              // Extract tags from filename and headers
              const tags = [
                prefix || 'root',
                ...lines.filter(l => l.startsWith('## ')).slice(0,3).map(l => l.replace(/^## /,'').toLowerCase().split(':')[0].trim().slice(0,20)),
              ].filter(Boolean).slice(0, 6);
              items.push({
                id: (prefix ? `${prefix}/` : '') + e.name.replace('.md',''),
                title, preview, tags,
                path: fullPath.replace(USER_HOME_DIR, '~'),
                size: content.length,
                lines: lines.length,
                updatedAt: stat.mtimeMs,
                content: content.slice(0, 3000),
              });
            } catch {}
          }
        }
      } catch {}
    }
    scanDir(knowledgeDir);
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ items, total: items.length, ts: Date.now() }));
  }

  // ── Knowledge: GET single doc ──────────────────────────────────────
  if (url.startsWith('/api/knowledge/') && req.method === 'GET') {
    const id = decodeURIComponent(url.replace('/api/knowledge/', ''));
    const fullPath = path.join(USER_HOME_DIR, '.openclaw/workspace/knowledge', id + '.md');
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ id, content, path: fullPath.replace(USER_HOME_DIR, '~') }));
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  // ── Sprint Velocity: tasks by day from Veritas ────────────────────
  if (url === '/api/sprints/stats') {
    const CONVEX_SITE = 'https://expert-dachshund-299.convex.site';
    try {
      // Get all tasks + sprints from Convex
      const [tasksRes, sprintsRes] = await Promise.all([
        fetch(`${CONVEX_SITE}/agent/tasks/list`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()),
        fetch(`${CONVEX_SITE}/agent/sprints`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()),
      ]);
      const tasks = Array.isArray(tasksRes) ? tasksRes : (tasksRes.tasks ?? tasksRes.data ?? []);
      const sprints = Array.isArray(sprintsRes) ? sprintsRes : (sprintsRes.sprints ?? sprintsRes.data ?? []);

      // Daily velocity: tasks created vs done per day (last 7 days)
      const DAY_MS = 86400000;
      const now = Date.now();
      const days = 7;
      const buckets = Array.from({ length: days }, (_, i) => {
        const dayStart = now - (days - 1 - i) * DAY_MS;
        return {
          date: new Date(dayStart).toISOString().slice(0, 10),
          created: 0, done: 0, inProgress: 0,
        };
      });
      tasks.forEach(t => {
        const createdMs = t.createdAt ?? (t.created ? new Date(t.created).getTime() : 0);
        const updatedMs = t.updatedAt ?? (t.updated ? new Date(t.updated).getTime() : 0);
        const createdIdx = days - 1 - Math.floor((now - createdMs) / DAY_MS);
        const updatedIdx = t.status === 'done' ? days - 1 - Math.floor((now - (updatedMs || createdMs)) / DAY_MS) : -1;
        if (createdIdx >= 0 && createdIdx < days) buckets[createdIdx].created++;
        if (updatedIdx >= 0 && updatedIdx < days) buckets[updatedIdx].done++;
      });
      // Sprint summary from Convex sprints + tasks
      const sprintSummary = sprints.slice(-5).map(s => {
        const sid = s._id ?? s.id;
        const sprintTasks = tasks.filter(t => t.sprintId === sid);
        return { id: sid, label: s.name ?? s.label, created: s.createdAt ? new Date(s.createdAt).toISOString() : (s.created ?? ''),
          taskCount: sprintTasks.length, doneCount: sprintTasks.filter(t => t.status === 'done').length };
      });
      // Overall stats
      const total = tasks.length;
      const done = tasks.filter(t => t.status === 'done').length;
      const inProgress = tasks.filter(t => t.status === 'in-progress').length;
      const byAgent = {};
      tasks.forEach(t => {
        const a = t.agent ?? 'unknown';
        byAgent[a] = byAgent[a] ?? { total: 0, done: 0 };
        byAgent[a].total++;
        if (t.status === 'done') byAgent[a].done++;
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ buckets, sprints: sprintSummary, total, done, inProgress, byAgent, ts: Date.now() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Host Metrics: CPU/RAM/Disk (macOS) ────────────────────────────
  // ── Netdata Proxy — rich time-series metrics ─────────────────────────────
  if (urlPath.startsWith('/api/netdata/')) {
    const netdataPath = urlPath.replace('/api/netdata', '');
    const netdataUrl = `http://localhost:19999${netdataPath}${req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;
    try {
      const resp = await fetch(netdataUrl, { signal: AbortSignal.timeout(5000) });
      const data = await resp.json();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
      return res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: 'Netdata unavailable', detail: e.message }));
    }
  }

  if (url === '/api/host/metrics') {
    const execP = promisify(exec);
    try {
      const [vmRes, swapRes, diskRes, loadRes, uptimeRes] = await Promise.allSettled([
        execP('vm_stat', { timeout: 3000 }),
        execP('/usr/sbin/sysctl -n hw.memsize', { timeout: 2000 }),
        execP('df -h / | tail -1', { timeout: 2000 }),
        execP('/usr/sbin/sysctl -n vm.loadavg', { timeout: 2000 }),
        execP('/usr/sbin/sysctl -n kern.boottime', { timeout: 2000 }),
      ]);

      // Parse vm_stat → RAM usage
      let ramUsedGb = 0, ramTotalGb = 0, ramPct = 0;
      if (vmRes.status === 'fulfilled' && swapRes.status === 'fulfilled') {
        const vmOut = vmRes.value.stdout;
        // Parse page size from vm_stat header (e.g. "page size of 16384 bytes")
        const pageSizeMatch = vmOut.match(/page size of (\d+) bytes/);
        const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1]) : 16384;
        const totalBytes = parseInt(swapRes.value.stdout.trim());
        ramTotalGb = parseFloat((totalBytes / 1e9).toFixed(1));
        const wireMatch = vmOut.match(/Pages wired down:\s+(\d+)/);
        const activeMatch = vmOut.match(/Pages active:\s+(\d+)/);
        const compressedMatch = vmOut.match(/Pages occupied by compressor:\s+(\d+)/);
        const wired = wireMatch ? parseInt(wireMatch[1]) : 0;
        const active = activeMatch ? parseInt(activeMatch[1]) : 0;
        const compressed = compressedMatch ? parseInt(compressedMatch[1]) : 0;
        const usedBytes = (wired + active + compressed) * pageSize;
        ramUsedGb = parseFloat((usedBytes / 1e9).toFixed(1));
        ramPct = Math.round((ramUsedGb / ramTotalGb) * 100);
      }

      // Parse disk
      let diskTotal = '?', diskUsed = '?', diskPct = 0;
      if (diskRes.status === 'fulfilled') {
        const parts = diskRes.value.stdout.trim().split(/\s+/);
        diskTotal = parts[1] ?? '?';
        diskUsed = parts[2] ?? '?';
        const pctStr = parts[4] ?? '0%';
        diskPct = parseInt(pctStr.replace('%', '')) || 0;
      }

      // Parse load average
      let load1 = 0, load5 = 0, load15 = 0;
      if (loadRes.status === 'fulfilled') {
        const m = loadRes.value.stdout.match(/\{ ([\d.]+) ([\d.]+) ([\d.]+) /);
        if (m) { load1 = parseFloat(m[1]); load5 = parseFloat(m[2]); load15 = parseFloat(m[3]); }
      }
      // CPU % ≈ load1 / core_count * 100
      const coreCount = 10; // M4 10-core
      const cpuPct = Math.min(Math.round((load1 / coreCount) * 100), 100);

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({
        cpu: { pct: cpuPct, load1, load5, load15, cores: coreCount },
        ram: { usedGb: ramUsedGb, totalGb: ramTotalGb, pct: ramPct },
        disk: { total: diskTotal, used: diskUsed, pct: diskPct },
        host: 'mac-mini.tail70fd.ts.net', ts: Date.now(),
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Audit Log: persist events to JSONL ────────────────────────────
  const AUDIT_LOG = path.join(USER_HOME_DIR, '.openclaw/workspace/audit-log.jsonl');

// ── Timeline: recent git commits across ~/projects ────────────────────────────
  if (url === '/api/timeline/commits' && req.method === 'GET') {
    try {
      const execP = promisify(exec);
      const projectsDir = path.join(USER_HOME_DIR, 'projects');
      const { stdout } = await execP(
        `find "${projectsDir}" -name ".git" -maxdepth 3 -type d 2>/dev/null | head -20 | while read d; do
          repo=$(basename $(dirname $d))
          git -C "$(dirname $d)" log --since="7 days ago" --format="%H|%as|%s|%an" 2>/dev/null | head -20 | while IFS='|' read hash date msg author; do
            echo "$repo|$hash|$date|$msg|$author"
          done
        done | sort -t'|' -k3 -r | head -100`,
        { timeout: 12000, shell: true }
      );
      const lines = stdout.trim().split('\n').filter(Boolean);
      const commits = lines.map(l => {
        const parts = l.split('|');
        return {
          repo: parts[0] ?? '',
          hash: parts[1]?.slice(0, 8) ?? '',
          date: parts[2] ?? '',
          message: parts[3] ?? '',
          author: parts[4] ?? '',
          ts: new Date(parts[2] ?? Date.now()).getTime(),
        };
      }).filter(c => c.repo && c.message);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ commits, count: commits.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message, commits: [] }));
    }
  }

  if (url === '/api/audit/events' && req.method === 'GET') {
    const qp = new URL(url, 'http://localhost').searchParams;
    const limit = parseInt(qp.get('limit') ?? '100');
    const typeFilter = qp.get('type') ?? '';
    try {
      const lines = fs.existsSync(AUDIT_LOG)
        ? fs.readFileSync(AUDIT_LOG, 'utf8').split('\n').filter(Boolean) : [];
      let events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (typeFilter) events = events.filter(e => e.type === typeFilter);
      events = events.slice(-limit).reverse();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ events, total: events.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Squad Chat: sync Veritas → Convex ─────────────────────────────────────
  if (url === '/api/squad/sync' && req.method === 'POST') {
    const CONVEX_URL = 'https://expert-dachshund-299.convex.cloud';
    try {
      // Read Veritas API key from .env
      const envPath = path.join(os.homedir(), '.openclaw', 'workspace', '.env');
      let vKey = '';
      try {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const m = envContent.match(/VERITAS_API_KEY\s*=\s*["']?([^"'\s]+)/);
        if (m) vKey = m[1];
      } catch {}

      if (!vKey) {
        // Try panel .env
        const panelEnv = path.join(os.homedir(), 'projects', 'ASYSTEM', 'panel', '.env');
        try {
          const c = fs.readFileSync(panelEnv, 'utf8');
          const m = c.match(/VERITAS_API_KEY\s*=\s*["']?([^"'\s]+)/);
          if (m) vKey = m[1];
        } catch {}
      }

      // Fetch from Veritas
      const veritasRes = await fetch('http://localhost:3002/api/v1/chat/squad', {
        headers: { 'x-api-key': vKey }
      });
      const veritasData = await veritasRes.json();
      const msgs = Array.isArray(veritasData?.data) ? veritasData.data : [];

      // Sync each to Convex chat table (skip duplicates by checking existing)
      let synced = 0;
      for (const m of msgs.slice(-20)) { // last 20
        try {
          await fetch(`${CONVEX_URL}/api/mutation`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              path: 'chat:send',
              args: {
                agent: m.agent ?? 'System',
                message: m.message ?? '',
                tags: [...(m.tags ?? []), 'veritas-sync'],
              }
            })
          });
          synced++;
        } catch {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ ok: true, synced, total: msgs.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

// ── Agent Manifests API ────────────────────────────────────────────────────
  if (url.startsWith('/api/agent-manifests') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const manifestsDir = path.join(USER_HOME_DIR, 'projects/ASYSTEM/api/agent-manifests');
    try {
      const agentId = url.replace('/api/agent-manifests/', '').replace('/api/agent-manifests', '').split('?')[0];
      if (agentId && fs.existsSync(path.join(manifestsDir, `${agentId}.yaml`))) {
        const content = fs.readFileSync(path.join(manifestsDir, `${agentId}.yaml`), 'utf8');
        res.writeHead(200, _H);
        return res.end(JSON.stringify({ id: agentId, yaml: content }));
      }
      const files = fs.existsSync(manifestsDir) ? fs.readdirSync(manifestsDir).filter(f => f.endsWith('.yaml')) : [];
      const manifests = {};
      for (const f of files) { manifests[f.replace('.yaml','')] = fs.readFileSync(path.join(manifestsDir, f), 'utf8'); }
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ manifests, count: files.length, ts: Date.now() }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

if (url === '/api/audit/events' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    await new Promise(r => req.on('end', r));
    try {
      const event = JSON.parse(Buffer.concat(chunks).toString());
      const entry = { ...event, ts: event.ts ?? Date.now(), serverTs: Date.now() };
      fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + '\n');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Dispatch: send task to agent via inbox file + Squad Chat + Telegram ──
  if (url === '/api/dispatch' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    await new Promise(r => req.on('end', r));
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      let { to, title, body: desc = '', type = 'task', priority = 'medium', taskId, tags: _bodyTags } = body;
      const _tags = Array.isArray(_bodyTags) ? _bodyTags : [];

      // ── Security: injection scan + loop guard + rate limiter ─────────────
      const _source = body.source || 'unknown';
      const _skipSecurity = ['health-monitor', 'loop-guard', 'cost-guard', 'task-loop-escalation'].includes(_source);

      // ── Role Router: warn on role mismatch ───────────────────────────────────
      if (to && title && !_skipSecurity) {
        try {
          const { validateRoleAssignment, routeByRole } = await import('./role-router.mjs');
          const roleCheck = validateRoleAssignment(to, title);
          if (!roleCheck.allowed) {
            const altRoute = routeByRole({ title, priority, preferredAgent: to });
            console.warn(`[RoleRouter] ⚠️ ${to} role mismatch. Suggest: ${altRoute.suggestedAgent} (${altRoute.role})`);
          }
        } catch {}
      }

      // ── Model Version Pin: inject pinned model into dispatch context ──────────
      if (to) {
        try {
          const { getPinnedModel } = await import('./model-version-pin.mjs');
          const pin = getPinnedModel(to, dispatchId);
          if (!body.model) body.model = pin.model; // inject if not overridden by caller
        } catch {}
      }

      // ── Reputation: check trust level before dispatch ────────────────────────
      if (!_skipSecurity && to && priority) {
        try {
          const { isTrustedFor } = await import('./reputation.mjs');
          if (!isTrustedFor(to, priority)) {
            console.warn(`[Reputation] ⚠️ ${to} not trusted for ${priority} priority tasks`);
            // Non-blocking warn only (don't block — could be first task)
          }
        } catch {}
      }

      // ── Intent Recognizer: warn on high ambiguity ────────────────────────────
      let _intentWarning = null;
      if (title && !_skipSecurity) {
        try {
          const { analyzeIntent } = await import('./intent-recognizer.mjs');
          const intent = analyzeIntent(title, desc, to, priority);
          if (intent.recommendation === 'CLARIFY_BEFORE_DISPATCH') _intentWarning = intent;
          if (intent.ambiguity > 0) console.log(`[Intent] ${intent.emoji} ${intent.intent} ambiguity=${intent.ambiguity} → ${intent.recommendation}`);
        } catch {}
      }

      // ── Predictive Scheduler: record dispatch event ───────────────────────────
      if (to) { (async () => { try { const { recordDispatch } = await import('./predictive-scheduler.mjs'); recordDispatch(to); } catch {} })(); }

      // ── Federated Knowledge: inject global insights into dispatch ────────────
      if (!_skipSecurity && to && title) {
        try {
          const { getGlobalInsights } = await import('./federated-knowledge.mjs');
          const insights = getGlobalInsights(title, 3);
          if (insights.length > 0) {
            const fedBlock = '\n\n[FEDERATED KNOWLEDGE]\n' + insights.map(i => `• [${i.contributors.join('+')}] ${i.insight.slice(0, 150)}`).join('\n');
            if (!dispatchBody) dispatchBody = {};
            dispatchBody._federated = fedBlock;
          }
        } catch {}
      }

      // ── CoT Start: begin chain-of-thought trace ───────────────────────────────
      let _cotId = _traceId || `cot-${Date.now()}`;
      if (!_skipSecurity && to) {
        try {
          const { cotStart } = await import('./cot-logger.mjs');
          cotStart({ traceId: _cotId, taskId: dispatchId, to, title, priority });
        } catch {}
      }

      // ── Reflection PRE: score task for likely success (MODE 1: in-action) ────
      if (!_skipSecurity && to && title) {
        (async () => {
          try {
            const { reflectPre } = await import('./reflection.mjs');
            const pre = await reflectPre({ to, title, body: desc || '' });
            if (pre.score < 50) console.warn(`[Reflection] ⚠️  Pre-score LOW: ${to}/${title.slice(0,30)} = ${pre.score} — ${pre.recommendation}`);
          } catch {}
        })();
      }

      // ── Namespace Context: inject project role + skills into dispatch ────────
      if (!_skipSecurity && to) {
        try {
          const { getNamespaceContext } = await import('./namespace.mjs');
          const nsCtx = getNamespaceContext(to, body?.project);
          if (nsCtx) desc = (desc ? desc + '\n' : '') + nsCtx;
        } catch {}
      }

      // ── Context Guard: token ceiling check before dispatch ───────────────────
      // Video: "Unbeatable Local AI Coding Workflow 2026" (3zSANOIBHYw)
      if (!_skipSecurity && (desc || body?.body)) {
        try {
          const { guardTaskBody, trackAgentContext, estimateTokens } = await import('./context-guard.mjs');
          const allInjections = ''; // will be filled after injections below — pre-check body only
          const guard = guardTaskBody(title || '', desc || '', '');
          if (guard.trimmed || guard.split) desc = guard.body;
          if (guard.warnings.length) console.warn(`[ContextGuard] ${guard.warnings.join(' | ')}`);
          if (to) trackAgentContext(to, estimateTokens((title || '') + (desc || '')));
        } catch {}
      }

      // ── CoT: log namespace context ────────────────────────────────────────────
      if (_cotId && !_skipSecurity) { (async () => { try { const { cotAppend } = await import('./cot-logger.mjs'); cotAppend(_cotId, 'namespace', 'injected', to); } catch {} })(); }

      // ── Auto-Priority Scorer: Urgency × Impact matrix ────────────────────────
      // Pattern: Eisenhower matrix applied to task title/body
      if (!_skipSecurity && (title || desc)) {
        try {
          const { autoScorePriority, agentPriorityBoost } = await import('./priority-scorer.mjs');
          const scored = autoScorePriority(title || '', desc || '', priority || 'medium');
          if (scored.upgraded) {
            priority = agentPriorityBoost(to, scored.priority);
            console.log(`[PriorityScorer] ⬆️  "${(title||'').slice(0,40)}" ${scored.computed !== scored.priority ? scored.computed : body?.priority || 'medium'} → ${priority} (U=${scored.scores.urgency} I=${scored.scores.impact} E=${scored.scores.effort})`);
          } else {
            priority = agentPriorityBoost(to, priority || 'medium');
          }
        } catch {}
      }

      // ── Distributed Trace: start root span for this dispatch ─────────────────
      // Video: "Braintrust TRACE 2026" (lVnF6eu_3dc)
      let _traceId = null, _rootSpanId = null;
      if (!_skipSecurity) {
        try {
          const { startTrace } = await import('./tracer.mjs');
          const t = startTrace({ name: `dispatch:${to}`, agentId: to, taskId: null, attrs: { title: (title || '').slice(0, 50), from: from || source } });
          _traceId = t.traceId; _rootSpanId = t.spanId;
        } catch {}
      }

      // ── Prompt Cache: semantic dedup (Batch Caching pattern) ─────────────────
      // Video: "Build Hour: Prompt Caching" (tECAkJAI_Vk)
      // + "Batch Caching — Speed up Local AI" (O_pQG6x9dvY)
      if (title && to && !_skipSecurity) {
        try {
          const { checkCache } = await import('./prompt-cache.mjs');
          const cached = checkCache(to, title || '');
          if (cached.hit && cached.result) {
            console.log(`[PromptCache] Returning cached result for "${title?.slice(0,40)}" → ${to}`);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-Cache': 'HIT' });
            return res.end(JSON.stringify({ ok: true, cached: true, taskId: cached.taskId, result: cached.result, similarity: cached.similarity }));
          }
        } catch {}
      }

      // ── Post-injection Context Guard: trim if injections bloated body ────────
      if (!_skipSecurity && desc) {
        try {
          const { guardTaskBody } = await import('./context-guard.mjs');
          const g2 = guardTaskBody(title || '', body?.body || '', desc);
          if (g2.trimmed) desc = g2.injections; // trim injections if over budget
        } catch {}
      }

      // ── Blast Radius Check (3P Security) ─────────────────────────────────────
      if (!_skipSecurity && to) {
        try {
          const { checkBlastRadius } = await import('./blast-radius.mjs');
          const br = checkBlastRadius({ agentId: to, title: title || '', priority, project: body?.project || '', from: body?.from || '' });
          if (!br.allowed) {
            (async () => { try { const { ledgerEvent } = await import('./immutable-ledger.mjs'); ledgerEvent('blast_radius_blocked', to, { violations: br.violations, title: (title || '').slice(0,60) }); } catch {} })();
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'blast_radius_exceeded', violations: br.violations }));
          }
        } catch {}
      }

      // ── Per-Agent Throttle (exponential backoff) ──────────────────────────────
      if (!_skipSecurity && to) {
        try {
          const { checkThrottle } = await import('./throttle.mjs');
          const tr = checkThrottle(to);
          if (!tr.allowed) {
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': Math.ceil(tr.retryAfterMs / 1000) });
            return res.end(JSON.stringify({ error: 'throttled', reason: tr.reason, retryAfterMs: tr.retryAfterMs, quotaStatus: tr.quotaStatus }));
          }
        } catch {}
      }

      // ── Token Budget: pre-dispatch check ─────────────────────────────────────
      if (!_skipSecurity && to) {
        try {
          const { checkBudget } = await import('./token-budget.mjs');
          const estTokens = Math.ceil(((title || '').length + (desc || '').length) / 4);
          const budgetCheck = checkBudget(estTokens, to);
          if (!budgetCheck.allowed) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'token_budget_exceeded', reason: budgetCheck.reason, pct: budgetCheck.pct }));
          }
        } catch {}
      }

      // ── Rate Limiter: 3P Framework (Purpose/Privilege/Protection) ──────────
      if (!_skipSecurity) {
        try {
          const { checkRateLimit } = await import('./rate-limiter.mjs');
          const rl = checkRateLimit(_source);
          if (!rl.ok) {
            console.warn(`[RateLimit] ⛔ ${_source}: ${rl.reason}`);
            fs.appendFileSync(path.join(process.env.HOME, '.openclaw/workspace/audit-log.jsonl'),
              JSON.stringify({ ts: Date.now(), type: 'ratelimit.blocked', source: _source, reason: rl.reason }) + '\n');
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': rl.retryAfterSec || 60 });
            return res.end(JSON.stringify({ error: 'rate_limited', reason: rl.reason, retryAfterSec: rl.retryAfterSec }));
          }
        } catch (rlErr) { console.warn('[RateLimit] non-fatal:', rlErr.message); }
      }

      if (!_skipSecurity) {
        try {
          const { checkDispatch, sanitizeInput, estimateImpact, traceDecision } = await import('./security-utils.mjs');

          // ── Input Sanitization (Privilege Escalation video pattern) ────────
          const titleSan = sanitizeInput(title || '', { maxLen: 400, source: _source });
          const bodySan  = sanitizeInput(desc  || '', { maxLen: 8000, source: _source });
          if (!titleSan.ok || !bodySan.ok) {
            const injErr = `Input injection detected from ${_source}: ${[...titleSan.warnings, ...bodySan.warnings].join('; ')}`;
            fs.appendFileSync(path.join(process.env.HOME, '.openclaw/workspace/audit-log.jsonl'),
              JSON.stringify({ ts: Date.now(), type: 'dispatch.injection', reason: injErr, source: _source, title: (title||'').slice(0,100) }) + '\n');
            traceDecision({ type: 'dispatch.injection', actor: _source, taskId: null, decision: 'blocked', reasoning: injErr, gates: ['sanitizeInput'] });
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ error: 'Input validation failed', detail: injErr }));
          }
          // Use sanitized values
          if (titleSan.sanitized) title = titleSan.sanitized;
          if (bodySan.sanitized)  desc  = bodySan.sanitized;

          // ── Impact Radius (Observability video pattern) ────────────────────
          const impact = estimateImpact({ title: title||'', body: desc||'', priority: priority||'medium' });
          if (impact.severity === 'critical' && !_tags.includes('approved')) {
            if (impact.requiresApproval) {
              console.warn(`[Dispatch] ⚠️ High-impact task: ${impact.summary} | task="${(title||'').slice(0,60)}"`);
            }
          }

          // ── Security gates (existing) ──────────────────────────────────────
          const secCheck = checkDispatch({
            agentId: to || 'unknown', title: title || '', body: desc || '',
            from: body.from || _source, to: to || 'unknown',
            priority: priority || 'medium', tags: _tags,
          });

          // ── Decision Trace (Observability video pattern) ───────────────────
          traceDecision({
            type: secCheck.ok ? 'dispatch.allowed' : 'dispatch.blocked',
            actor: _source, taskId: body.taskId || null,
            decision: secCheck.ok ? 'allowed' : 'blocked',
            reasoning: secCheck.ok
              ? `Passed all security gates. Impact: ${impact.summary}`
              : secCheck.error,
            gates: ['sanitizeInput', 'checkDispatch'],
            impact,
          });

          if (!secCheck.ok) {
            console.warn(`[Dispatch Security] ⛔ Blocked: ${secCheck.error} | title="${(title||'').slice(0,60)}" source=${_source}`);
            fs.appendFileSync(path.join(process.env.HOME, '.openclaw/workspace/audit-log.jsonl'),
              JSON.stringify({ ts: Date.now(), type: 'dispatch.blocked', reason: secCheck.error, details: secCheck.details, title: (title||'').slice(0,100), source: _source }) + '\n');
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ error: secCheck.error, details: secCheck.details }));
          }
        } catch (secErr) {
          console.warn('[Dispatch Security] utils import error (non-fatal):', secErr.message);
        }
      }

      // ── Context Handoff: inject prior agent's compressed summary ─────────────
      // Video: "Anthropic's Agent Harness: 200+ Features Built Autonomously" (Tlqe0A8ED8o)
      if (!_skipSecurity && body?.handoff_from && taskId_param) {
        try {
          const { buildHandoffContext } = await import('./context-handoff.mjs');
          const handoffCtx = buildHandoffContext(taskId_param);
          if (handoffCtx) desc = `${desc}\n\n${handoffCtx}`;
        } catch {}
      }

      // ── Progressive Skill Injection: Tier 1/2 (Inside Agent Skills pattern) ──
      // Video: "Inside Agent Skills: How One File Turns AI Into a Specialist" (hl76xUaWNSc)
      if (!_skipSecurity && to) {
        try {
          const { buildSkillContext } = await import('./skill-injector.mjs');
          const skillCtx = buildSkillContext(to, `${title || ''} ${desc || ''}`);
          if (skillCtx) desc = `${desc}\n\n${skillCtx}`;
        } catch {}
      }

      // ── Knowledge Graph context: inject known facts (KG pattern) ───────────────
      // Video: "Agent Swarms and Knowledge Graphs" (0AKQm4zow_E)
      if (!_skipSecurity && to && desc !== undefined) {
        try {
          const { buildKGContext } = await import('./knowledge-graph.mjs');
          const kgCtx = buildKGContext(to, body?.project);
          if (kgCtx) desc = `${desc}\n\n${kgCtx}`;
        } catch {}
      }

      // ── Eureka Self-Improvement: inject skill deltas ──────────────────────────
      // Video: "AI Agentic System Design Fundamentals 2026" (8ZXyxY0UtDQ)
      if (!_skipSecurity && to && desc !== undefined) {
        try {
          const { retrieveSkillDeltas } = await import('./self-improver.mjs');
          const deltas = await retrieveSkillDeltas(to);
          if (deltas) desc = `${desc}\n\n${deltas}`;
        } catch {}
      }

      // ── Goal Context: inject active goals for agent (persistent background pattern)
      // Video: "How I'm Using AI Agents in 2026" (BikPUaT76i8)
      if (!_skipSecurity && to && desc !== undefined) {
        try {
          const { buildGoalContext } = await import('./goal-tracker.mjs');
          const goalCtx = buildGoalContext(to, body?.project);
          if (goalCtx) desc = `${desc}\n\n${goalCtx}`;
        } catch {}
      }

      // ── Cost Optimizer: select cheapest sufficient model tier ─────────────────
      // Video: "Building a Cloud Cost Optimizer" (c4bdsRLyALQ, ODSC 2026)
      let _selectedModel;
      if (!_skipSecurity) {
        try {
          const { selectModelTier, recordCostDecision } = await import('./cost-optimizer.mjs');
          const _optScore = body?.complexity_score || 50;
          const _tier = selectModelTier(to || 'forge', title || '', desc || '', _optScore, priority || 'medium');
          _selectedModel = _tier.model;
          recordCostDecision({ taskId: taskId || 'new', agentId: to, title, selectedTier: _tier, defaultModel: 'anthropic/claude-sonnet-4-6' });
        } catch {}
      }

      // ── Persona Router: 4 Persona System (Planner/Architect/Implementer/Reviewer)
      // Video: "How I code with AI — The 4 Persona System" (MOEgv91p9vQ)
      let _persona = null;
      if (!_skipSecurity && desc !== undefined) {
        try {
          const { injectPersona } = await import('./persona-router.mjs');
          const pi = injectPersona(to || 'forge', title || '', desc || '');
          desc = pi.enhancedBody;
          _persona = pi.persona;
          console.log(`[Persona] ${pi.emoji} ${pi.persona} → ${to}`);
        } catch {}
      }

      // ── Shared Memory: inject cross-agent context (9-type taxonomy) ─────────
      if (!_skipSecurity && desc !== undefined) {
        try {
          const { buildMemoryContext } = await import('./shared-memory.mjs');
          const memCtx = await buildMemoryContext(title || '', desc || '');
          if (memCtx) {
            desc = `${desc}\n\n${memCtx}`;
            console.log(`[SharedMemory] 💡 Injected context into ${to} task`);
          }
        } catch (smErr) { /* non-fatal */ }
      }

      // ── Optimization Architect: complexity score + model routing ──────────
      let _optResult = null;
      try {
        const { optimizeDispatch } = await import('./optimization-architect.mjs');
        _optResult = optimizeDispatch({ title: title || '', body: desc || '', priority, agentId: to || 'unknown' });
        console.log(`[OptArch] score=${_optResult.score} → ${_optResult.model} (${_optResult.tier}) | saved=$${_optResult.savedVsSonnet} | ${_optResult.reason}`);
      } catch (optErr) {
        console.warn('[OptArch] import error (non-fatal):', optErr.message);
      }

      // ── Fractals: composite task decomposition ────────────────────────────
      // Skip if already a decomposed subtask (prevent recursion)
      const _isDecomposed = (_tags || []).includes('decomposed') || _source === 'fractals-decomposer' || (body?.retry_count > 0);
      if (!_isDecomposed && _optResult?.score > 70) {
        try {
          const { classifyTask, decomposeTask, recordClassification, recordDecomposition } = await import('./task-decomposer.mjs');
          const taskType = classifyTask({ title: title || '', body: desc || '', score: _optResult.score });
          recordClassification(taskType);

          if (taskType === 'composite') {
            console.log(`[Fractals] 🌿 composite task detected (score=${_optResult.score}) — decomposing...`);
            const result = await decomposeTask({ title: title || '', body: desc || '', parentTaskId: dispatchId, priority });

            if (result.decomposed && result.subtasks.length >= 2) {
              recordDecomposition(result.subtasks.length);
              console.log(`[Fractals] → ${result.subtasks.length} subtasks: ${result.subtasks.map(s => `${s.to}:${s.title.slice(0,30)}`).join(' | ')}`);

              // Dispatch all subtasks (async, non-blocking)
              const parentSummary = `Decomposed from: "${(title||'').slice(0,80)}" → ${result.subtasks.length} parallel subtasks. Reason: ${result.reason}`;
              Promise.all(result.subtasks.map(st =>
                fetch('http://localhost:5190/api/dispatch', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ to: st.to, title: st.title, body: st.body, priority: st.priority, tags: st.tags, source: st.source }),
                }).catch(e => console.warn('[Fractals] subtask dispatch error:', e.message))
              )).then(() => console.log(`[Fractals] ✅ all ${result.subtasks.length} subtasks dispatched`));

              // Return early with decomposition info
              res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              return res.end(JSON.stringify({
                ok: true, decomposed: true, parentId: dispatchId,
                subtasks: result.subtasks.map(s => ({ to: s.to, title: s.title })),
                reason: result.reason,
              }));
            }
          }
        } catch (fracErr) {
          console.warn('[Fractals] decompose error (non-fatal):', fracErr.message);
        }
      }

      // @mention routing: "@atlas сделай архитектуру" → to=atlas, title=stripped
      if (!to && title) {
        const mentionMatch = title.match(/^@(\w+)\s+(.+)/);
        if (mentionMatch) { to = mentionMatch[1].toLowerCase(); title = mentionMatch[2]; }
      }
      if (!to && desc) {
        const mentionMatch = desc.match(/^@(\w+)\s+/);
        if (mentionMatch) { to = mentionMatch[1].toLowerCase(); }
      }

      // Auto-assign by keywords if 'to' not specified
      if (!to && title) {
        const lTitle = title.toLowerCase();
        const ROLE_KEYWORDS = {
          bekzat:  ['backend', 'api', 'postgresql', 'migration', 'database', 'db', 'nest', 'fastapi', 'server'],
          ainura:  ['frontend', 'ui', 'ux', 'react', 'vue', 'css', 'mobile', 'pwa', 'responsive', 'design'],
          marat:   ['test', 'qa', 'quality', 'e2e', 'cypress', 'jest', 'bug', 'regression'],
          nurlan:  ['devops', 'ci', 'cd', 'docker', 'deploy', 'pipeline', 'k8s', 'nginx', 'infra', 'proxmox'],
          dana:    ['pm', 'sprint', 'roadmap', 'milestone', 'ticket', 'jira', 'plan', 'meeting', 'scope'],
          iron:    ['security', 'audit', 'firewall', 'ssl', 'cert', 'auth', 'vulnerability', 'pentest'],
          mesa:    ['analytics', 'data', 'report', 'metric', 'dashboard', 'chart', 'simulation', 'forecast'],
          atlas:   ['architecture', 'strategy', 'integration', 'review', 'api design', 'system'],
          pixel:   ['design', 'figma', 'logo', 'brand', 'visual', 'mockup', 'illustration'],
          forge:   ['panel', 'command center', 'openclaw', 'build', 'fix', 'feature'],
        };
        for (const [agent, keywords] of Object.entries(ROLE_KEYWORDS)) {
          if (keywords.some(kw => lTitle.includes(kw))) { to = agent; break; }
        }
        if (!to) to = 'forge'; // Default to forge
      }
      
      if (!to || !title) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ error: 'to + title required' }));
      }

      // ── Auto Context-Inject from ReMe memory (кейс #33) ─────────────────
      if (desc && desc.length < 300) {
        try {
          const memQ = encodeURIComponent(`${title} ${to}`.substring(0, 80));
          const memResp = await fetch(`http://localhost:5190/api/memory/reme?q=${memQ}&top=2`);
          const memData = await memResp.json();
          const relevant = (memData.results || []).filter(r => r.score > 0.4);
          if (relevant.length) {
            const ctx = relevant.map(r => r.content.substring(0, 150)).join('\n');
            desc = `${desc}\n\n[Context from memory]:\n${ctx}`;
          }
        } catch {}
      }

      const dispatchId = taskId ?? `dispatch-${Date.now()}`;
      const VERITAS_KEY = (() => {
        try { return (fs.readFileSync(path.join(USER_HOME_DIR, 'projects/veritas/server/.env'), 'utf8').match(/VERITAS_ADMIN_KEY=(.+)/) ?? [])[1]?.trim(); } catch { return null; }
      })();
      const GW_TOKEN = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(USER_HOME_DIR, '.openclaw/openclaw.json'), 'utf8'))?.gateway?.auth?.token; } catch { return null; }
      })();

      // KNOWN agent IPs (for remote inbox delivery)
      const AGENT_IPS = {
        iron: '100.114.136.87', atlas: '100.68.144.79', mesa: '100.100.40.27',
        titan: '100.83.105.111', pixel: '10.10.10.53',
        // PVE2 agents (Tailscale IPs)
        dana: '100.114.5.104', bekzat: '100.66.219.32',
        ainura: '100.112.184.63', marat: '100.107.171.121',
        nurlan: '11.12.1.2', // PVE2 LXC internal IP (Tailscale 100.83.188.95)
      };
      const isSelf = to === 'forge';

      let delivered = false;
      const deliveryMethods = [];

      // EMPO2: retrieve tips for the target agent and inject into task body
      let _empo2Tips = '';
      try {
        const { retrieveTips } = await import('./quality-judge.mjs');
        _empo2Tips = await retrieveTips(to, title) || '';
      } catch { /* non-fatal */ }

      // Method 1: Local inbox (for forge/self tasks)
      if (isSelf) {
        const inboxPath = path.join(USER_HOME_DIR, '.openclaw/workspace/tasks/inbox');
        fs.mkdirSync(inboxPath, { recursive: true });
        const taskFile = path.join(inboxPath, `${dispatchId}.json`);
        const _selfSafety = (priority === 'critical' || priority === 'high')
          ? '\n\n⚠️ SAFETY: Before executing — state in ONE sentence what you will do and what you will NOT touch. Technical completion ≠ success.'
          : '';
        fs.writeFileSync(taskFile, JSON.stringify({
          task_id: dispatchId, from: 'forge', type, title, body: (desc || '') + _selfSafety + _empo2Tips, priority,
          created: new Date().toISOString(), source: 'panel-dispatch',
        }, null, 2));
        delivered = true;
        deliveryMethods.push('inbox-file');
      }

      // Method 2: Remote inbox via HTTP (for other agents)
      if (!isSelf && AGENT_IPS[to]) {
        const ip = AGENT_IPS[to];
        try {
          // Safety reminder injected for sensitive/high-priority tasks
          const _SAFETY_REMINDER = (priority === 'critical' || priority === 'high')
            ? '\n\n⚠️ SAFETY: Before executing — state in ONE sentence what you will do and what you will NOT touch. Technical completion ≠ success: never remove/disable existing systems to complete this task.'
            : '';
          const inboxPayload = {
            task_id: dispatchId, from: 'forge', type, title, body: (desc || '') + _SAFETY_REMINDER + _empo2Tips, priority,
            created: new Date().toISOString(), source: 'panel-dispatch',
          };
          // Try webhook endpoint first
          const webhookRes = await fetch(`http://${ip}:18790/task`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forge-Signature': 'sha256=panel' },
            body: JSON.stringify(inboxPayload),
            signal: AbortSignal.timeout(3000),
          }).catch(() => null);
          if (webhookRes?.ok) { delivered = true; deliveryMethods.push(`webhook→${ip}`); }
        } catch {}

        // Fallback: OpenClaw gateway send
        if (!delivered && GW_TOKEN) {
          try {
            const gwRes = await fetch(`http://${ip}:18789/sessions`, {
              headers: { 'Authorization': `Bearer ${GW_TOKEN}` },
              signal: AbortSignal.timeout(2000),
            }).catch(() => null);
            if (gwRes) { deliveryMethods.push(`gateway→${ip}:checked`); }
          } catch {}
        }
      }

      // Method 3: Squad Chat notification (via Convex — Veritas :3002 retired)
      {
        await fetch('https://expert-dachshund-299.convex.cloud/api/mutation', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: 'chat:send',
            args: {
              agent: 'forge',
              message: `📡 [dispatch→${to}] ${title}${desc ? '\n' + desc.slice(0, 200) : ''}\nID: ${dispatchId} | priority: ${priority}`,
              tags: ['dispatch', to, priority],
            }
          }),
        }).catch(() => {});
        deliveryMethods.push('squad-chat');
      }

      // Method 4: Telegram notify (OpenClaw gateway on this machine)
      if (GW_TOKEN) {
        try {
          const tgBody = `📡 *Dispatch → ${to.toUpperCase()}*\n*${title}*${desc ? '\n' + desc.slice(0, 300) : ''}\nID: \`${dispatchId}\` · ${priority}`;
          await fetch(`http://100.87.107.50:18789/api/telegram/send`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GW_TOKEN}` },
            body: JSON.stringify({ text: tgBody, parse_mode: 'Markdown' }),
            signal: AbortSignal.timeout(2000),
          }).catch(() => {});
          deliveryMethods.push('telegram-attempted');
        } catch {}
      }

      // Method 5: Mac Mini Agent routing (for automation/gui/runtime tasks)
      const MAC_AGENT_KEYWORDS = ['gui', 'automation', 'screenshot', 'steer', 'drive', 'mac-agent', 'generate', 'create script', 'write code'];
      const isMacAgentTask = MAC_AGENT_KEYWORDS.some(kw => (title + ' ' + desc).toLowerCase().includes(kw));
      if (isMacAgentTask && isSelf) {
        try {
          const macAgentRes = await fetch('http://localhost:7600/job', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': 'forge-mac-agent-2026-secret' },
            body: JSON.stringify({ prompt: `${title}${desc ? '. ' + desc : ''}`, runtime: 'gemini' }),
            signal: AbortSignal.timeout(5000),
          });
          if (macAgentRes.ok) {
            const macJob = await macAgentRes.json();
            deliveryMethods.push(`mac-agent→${macJob.job_id}`);
            delivered = true;
          }
        } catch (e) { console.warn('[dispatch mac-agent]', e.message); }
      }

      // Method 6: Convex task create — DISABLED (was causing infinite dispatch loop)
      // Tasks are created via /api/braindump or Kanban UI, not via dispatch
      deliveryMethods.push('convex-disabled');

      // Method 7: NATS publish — agent-specific dispatch subject (autonomous watch-loop)
      try {
        const { publishEvent } = await import('./nats-events.mjs');
        await publishEvent(`sop.agent.dispatched.${to}`, {
          id: dispatchId, title, body: desc, type, priority,
          from: 'forge', created: new Date().toISOString(),
        });
        deliveryMethods.push('nats');
      } catch (e) { console.warn('[dispatch nats]', e.message); }

      // Persist to audit
      const AUDIT_LOG = path.join(USER_HOME_DIR, '.openclaw/workspace/audit-log.jsonl');
      fs.appendFileSync(AUDIT_LOG, JSON.stringify({
        id: `dispatch-${dispatchId}`, type: 'task.created', from: 'forge',
        severity: 'info', message: `[dispatch→${to}] ${title}`,
        agent: to, taskId: dispatchId, priority, deliveryMethods,
        timestamp: new Date().toISOString(), ts: Date.now(),
      }) + '\n');

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      // Broadcast dispatch event to all WS clients
      broadcast({ type: 'dispatch', data: { to, title, taskId: dispatchId, priority, deliveryMethods, ts: Date.now() } });
      // FSM: transition to in_progress on dispatch
      if (!_skipSecurity && dispatchId) {
        try {
          const { ensureState, autoTransition } = await import('./fsm.mjs');
          ensureState(dispatchId, 'queued');
          autoTransition(dispatchId, 'dispatched');
        } catch {}
      }

      // SLA Registration — track deadline for dispatched task
      if (!_skipSecurity && dispatchId && to) {
        try {
          const { registerSLA } = await import('./sla-monitor.mjs');
          registerSLA({ taskId: dispatchId, agentId: to, priority: priority || 'medium', title: title || '' });
        } catch {}
      }

      // CoT finish
      if (_cotId) { (async () => { try { const { cotFinish } = await import('./cot-logger.mjs'); cotFinish(_cotId, 'dispatched'); } catch {} })(); }

      // TTL register
      if (dispatchId && to) { (async () => { try { const { registerTask } = await import('./task-ttl.mjs'); registerTask({ taskId: dispatchId, agentId: to, title: title || '', priority }); } catch {} })(); }

      // Close trace
      if (_traceId) { try { const { finishTrace } = await import('./tracer.mjs'); finishTrace({ traceId: _traceId, status: 'ok', attrs: { taskId: dispatchId } }); } catch {} }
      return res.end(JSON.stringify({ ok: true, dispatched: { to, title, taskId: dispatchId }, delivered, methods: deliveryMethods, traceId: _traceId }));
    } catch (e) {
      if (_traceId) { try { const { finishTrace } = await import('./tracer.mjs'); finishTrace({ traceId: _traceId, status: 'error', error: e.message }); } catch {} }
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Proxmox multi-node ───────────────────────────────────────────────
  // In-memory cache (30s TTL) to avoid 18s SSH+PVE2 on every request
  if (!globalThis._pveCache) globalThis._pveCache = { data: null, ts: 0 };
  if (url === '/api/proxmox/vms' || url.startsWith('/api/proxmox/vms?')) {
    const now = Date.now();
    if (globalThis._pveCache.data && now - globalThis._pveCache.ts < 30000) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-Cache': 'HIT' });
      return res.end(JSON.stringify(globalThis._pveCache.data));
    }
    const execP = promisify(exec);

    // PVE1 (asystem Hetzner, 135.181.112.60) — через SSH proxy
    const PVE1_TOKEN = 'root@pam!asystem-panel=process.env.PVE1_API_TOKEN';
    const fetchPVE1 = async (apiPath) => {
      try {
        const cmd = `curl -sk "https://127.0.0.1:8006/api2/json${apiPath}" -H "Authorization: PVEAPIToken=${PVE1_TOKEN}"`;
        const { stdout } = await execP(
          `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 -i ~/.ssh/id_ed25519_asystemkg root@135.181.112.60 '${cmd}'`,
          { timeout: 15000 }
        );
        return JSON.parse(stdout.trim()).data ?? [];
      } catch (e) { return []; }
    };

    // PVE2 (cluster01, 100.122.3.73 via Tailscale) — прямой HTTPS
    const PVE2_URL_API = 'https://77.235.20.172:8038';
    let PVE2_TICKET = null;
    const fetchPVE2auth = async () => {
      const { stdout } = await execP(
        `curl -sk -X POST "${PVE2_URL_API}/api2/json/access/ticket" -d "username=root@pam&password=hJXRWe0!!"`,
        { timeout: 10000 }
      ).catch(() => ({ stdout: '{}' }));
      const d = JSON.parse(stdout.trim());
      return d?.data?.ticket ?? null;
    };
    const fetchPVE2 = async (apiPath) => {
      try {
        if (!PVE2_TICKET) PVE2_TICKET = await fetchPVE2auth();
        const { stdout } = await execP(
          `curl -sk "${PVE2_URL_API}/api2/json${apiPath}" -H "Cookie: PVEAuthCookie=${PVE2_TICKET}"`,
          { timeout: 15000 }
        );
        return JSON.parse(stdout.trim()).data ?? [];
      } catch (e) { return []; }
    };

    try {
      const [vms1, lxcs1, vms2, lxcs2, stats1, stats2] = await Promise.all([
        fetchPVE1('/nodes/asystem/qemu'),
        fetchPVE1('/nodes/asystem/lxc'),
        fetchPVE2('/nodes/cluster01/qemu'),
        fetchPVE2('/nodes/cluster01/lxc'),
        fetchPVE1('/nodes/asystem/status').catch(() => null),
        fetchPVE2('/nodes/cluster01/status').catch(() => null),
      ]);

      const mapVM = (v, node) => ({
        id: v.vmid, name: v.name, status: v.status, kind: v.kind ?? 'qemu', node,
        cpu: Math.round((v.cpu ?? 0) * 1000) / 10,
        mem: Math.round((v.mem ?? 0) / 1024 / 1024),
        maxmem: Math.round((v.maxmem ?? 0) / 1024 / 1024),
        disk: Math.round((v.disk ?? 0) / 1024 / 1024 / 1024 * 10) / 10,
        uptime: v.uptime ?? 0,
      });

      const allVMs = [
        ...(vms1 || []).map(v => mapVM({ ...v, kind: 'qemu' }, 'asystem')),
        ...(lxcs1 || []).map(v => mapVM({ ...v, kind: 'lxc' }, 'asystem')),
        ...(vms2 || []).map(v => mapVM({ ...v, kind: 'qemu' }, 'cluster01')),
        ...(lxcs2 || []).map(v => mapVM({ ...v, kind: 'lxc' }, 'cluster01')),
      ].sort((a, b) => (a.node + String(a.id)).localeCompare(b.node + String(b.id)));

      const mkNode = (s, label) => s ? {
        label, cpu: Math.round((s.cpu ?? 0) * 1000) / 10,
        mem: Math.round((s.memory?.used ?? 0) / 1024 / 1024),
        maxmem: Math.round((s.memory?.total ?? 0) / 1024 / 1024),
        cores: s.cpuinfo?.cpus ?? 0,
      } : null;

      const pveResp = {
        vms: allVMs,
        node: mkNode(stats1, 'asystem (Hetzner)'),
        nodes: [
          mkNode(stats1, 'asystem (Hetzner PVE1)'),
          mkNode(stats2, 'cluster01 (PVE2 — 314GB)'),
        ].filter(Boolean),
        ts: Date.now(),
      };
      globalThis._pveCache = { data: pveResp, ts: Date.now() };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(pveResp));
    } catch (e) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message, vms: [] }));
    }
  }

  // ── Cloudflare inventory ─────────────────────────────────────────────
  if (url === '/api/cloudflare/inventory') {
    const CF_KEY   = 'eae1f47bf14a5ffa450893e4ecc1f35c9b8ce';
    const CF_EMAIL = 'urmatdigital@gmail.com';
    const CF_ACCT  = '1ac78bbd68e3a81a2750288ebb4e2d41';
    const cfFetch  = (path) => new Promise((resolve, reject) => {
      https.get(`https://api.cloudflare.com/client/v4${path}`, {
        headers: { 'X-Auth-Email': CF_EMAIL, 'X-Auth-Key': CF_KEY, 'Content-Type': 'application/json' },
        timeout: 10000,
      }, resp => {
        let d = ''; resp.on('data', c => d += c);
        resp.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
      }).on('error', reject).on('timeout', () => reject(new Error('cf timeout')));
    });
    try {
      const [zonesResp, tunnelsResp] = await Promise.all([
        cfFetch('/zones?per_page=50'),
        cfFetch(`/accounts/${CF_ACCT}/cfd_tunnel?per_page=50&is_deleted=false`),
      ]);
      const zones   = zonesResp.result ?? [];
      const tunnels = tunnelsResp.result ?? [];
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({
        zones: zones.map(z => ({ name: z.name, id: z.id, status: z.status, plan: z.plan?.name })),
        tunnels: tunnels.map(t => ({
          name: t.name, id: t.id,
          online: (t.connections?.length ?? 0) > 0,
          connections: t.connections?.length ?? 0,
          dc: t.connections?.[0]?.colo_name ?? null,
        })),
        ts: Date.now(),
      }));
    } catch (e) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Cloudflare DNS for a zone ────────────────────────────────────────
  if (url.startsWith('/api/cloudflare/dns/')) {
    const urlParts = url.replace('/api/cloudflare/dns/', '').split('/');
    const zoneName = urlParts[0].split('?')[0];
    const recordId = urlParts[1]?.split('?')[0]; // for DELETE /api/cloudflare/dns/{zone}/{id}
    const CF_KEY   = 'eae1f47bf14a5ffa450893e4ecc1f35c9b8ce';
    const CF_EMAIL = 'urmatdigital@gmail.com';
    const CF_ACCT  = '1ac78bbd68e3a81a2750288ebb4e2d41';
    const ZONE_IDS = {
      'asystem.kg': '5aa37039abd7a1462c8426cf7685d11d',
      'aurva.kg': 'bf9c8199c66b286fac19e9b98aa50425',
      'fiatex.kg': 'c1d0392b5ccdbd9e928a7e394f3df1e0',
      'twinbridge.kg': '09954e104effe520a983ab40f5966e31',
      'aconsult.kg': '325eef5055d6ecca276f3ce6160b2e83',
      'voltera.kg': '1661f2abcf0ece9ed63d4d251051d7a5',
      'evpower.kg': 'b65a2660442f5cc595a1b741e9e2ee58',
    };
    const CF_HDR = { 'X-Auth-Email': CF_EMAIL, 'X-Auth-Key': CF_KEY, 'Content-Type': 'application/json' };
    const zoneId = ZONE_IDS[zoneName];
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    if (!zoneId) { res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'Zone not found' })); }

    // DELETE /api/cloudflare/dns/{zone}/{recordId}
    if (req.method === 'DELETE' && recordId) {
      try {
        const delResp = await new Promise((resolve, reject) => {
          const reqOpts = { hostname: 'api.cloudflare.com', path: `/client/v4/zones/${zoneId}/dns_records/${recordId}`, method: 'DELETE', headers: CF_HDR, timeout: 10000 };
          const r = https.request(reqOpts, resp => { let d=''; resp.on('data', c => d+=c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); });
          r.on('error', reject); r.end();
        });
        res.writeHead(200, _H);
        return res.end(JSON.stringify({ ok: delResp.success ?? true, id: recordId }));
      } catch (e) { res.writeHead(503, _H); return res.end(JSON.stringify({ error: e.message })); }
    }

    // POST /api/cloudflare/dns/{zone} — create record
    if (req.method === 'POST') {
      const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
      const body = (() => { try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; } })();
      try {
        const postBody = JSON.stringify({ type: body.type || 'A', name: body.name, content: body.content, proxied: body.proxied ?? false, ttl: body.ttl || 1 });
        const createResp = await new Promise((resolve, reject) => {
          const reqOpts = { hostname: 'api.cloudflare.com', path: `/client/v4/zones/${zoneId}/dns_records`, method: 'POST', headers: { ...CF_HDR, 'Content-Length': Buffer.byteLength(postBody) }, timeout: 10000 };
          const r = https.request(reqOpts, resp => { let d=''; resp.on('data', c => d+=c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); });
          r.on('error', reject); r.write(postBody); r.end();
        });
        res.writeHead(createResp.success ? 200 : 400, _H);
        return res.end(JSON.stringify({ ok: createResp.success, record: createResp.result, errors: createResp.errors }));
      } catch (e) { res.writeHead(503, _H); return res.end(JSON.stringify({ error: e.message })); }
    }

    // GET /api/cloudflare/dns/{zone}
    try {
      const resp = await new Promise((resolve, reject) => {
        https.get(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?per_page=100`, {
          headers: CF_HDR, timeout: 10000,
        }, r => { let d=''; r.on('data', c => d+=c); r.on('end', () => resolve(JSON.parse(d))); })
        .on('error', reject);
      });
      res.writeHead(200, { ..._H, 'Cache-Control': 'public, max-age=60' });
      return res.end(JSON.stringify({
        zone: zoneName,
        records: (resp.result ?? []).map(r => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied, ttl: r.ttl })),
        ts: Date.now(),
      }));
    } catch (e) {
      res.writeHead(503, _H); return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── AI Network Operator ───────────────────────────────────────────────
  if (url === '/api/network/ai-operator' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
    const { message = '' } = (() => { try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; } })();
    try {
      // Gather network context
      const CF_KEY = 'eae1f47bf14a5ffa450893e4ecc1f35c9b8ce';
      const CF_EMAIL = 'urmatdigital@gmail.com';
      const CF_ACCT = '1ac78bbd68e3a81a2750288ebb4e2d41';
      const TS_API_KEY = 'process.env.TS_API_KEY';

      const [tsResp, cfResp] = await Promise.allSettled([
        new Promise((resolve, reject) => {
          https.get('https://api.tailscale.com/api/v2/tailnet/-/devices?fields=all', { headers: { 'Authorization': `Bearer ${TS_API_KEY}` }, timeout: 8000 },
            r => { let d=''; r.on('data', c => d+=c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); }).on('error', reject);
        }),
        new Promise((resolve, reject) => {
          https.get(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCT}/cfd_tunnel?per_page=50&is_deleted=false`, { headers: { 'X-Auth-Email': CF_EMAIL, 'X-Auth-Key': CF_KEY }, timeout: 8000 },
            r => { let d=''; r.on('data', c => d+=c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); }).on('error', reject);
        }),
      ]);

      const now = Date.now();
      const tsNodes = (tsResp.status === 'fulfilled' ? tsResp.value.devices ?? [] : []).map(d => ({
        name: d.name?.split('.')[0], ip: d.addresses?.[0],
        online: d.lastSeen ? (now - new Date(d.lastSeen).getTime() < 5 * 60 * 1000) : false,
        os: d.os,
      }));
      const tunnels = (cfResp.status === 'fulfilled' ? cfResp.value.result ?? [] : []).map(t => ({
        name: t.name, id: t.id.slice(0,8),
        status: (t.connections?.length ?? 0) > 0 ? 'healthy' : 'inactive',
        connections: t.connections?.length ?? 0,
      }));

      const context = `ASYSTEM Network Status:\n\nTailscale Nodes (${tsNodes.length}):\n${tsNodes.map(n => `- ${n.name} (${n.ip}) — ${n.online ? 'ONLINE' : 'OFFLINE'}, OS: ${n.os}`).join('\n')}\n\nCloudflare Tunnels (${tunnels.length}):\n${tunnels.map(t => `- ${t.name} [${t.id}] — ${t.status}, connections: ${t.connections}`).join('\n')}`;

      const promptBody = JSON.stringify({
        model: 'anthropic/claude-sonnet-4-6',
        messages: [
          { role: 'system', content: `You are the ASYSTEM Network Operator — an AI assistant managing ASYSTEM infrastructure. You have access to real-time network data. Be concise, technical, and helpful. Format output clearly. Current context:\n\n${context}` },
          { role: 'user', content: message },
        ],
        max_tokens: 1024,
      });

      const aiResp = await new Promise((resolve, reject) => {
        const r = https.request({
          hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer process.env.OPENROUTER_API_KEY`, 'HTTP-Referer': 'https://os.asystem.kg', 'X-Title': 'ASYSTEM Network Operator', 'Content-Length': Buffer.byteLength(promptBody) },
          timeout: 30000,
        }, resp => { let d=''; resp.on('data', c => d+=c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); });
        r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('AI timeout')); });
        r.write(promptBody); r.end();
      });

      const response = aiResp?.choices?.[0]?.message?.content ?? 'Нет ответа от AI';
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ response, timestamp: Date.now() }));
    } catch (e) {
      res.writeHead(500, _H);
      return res.end(JSON.stringify({ error: e.message, response: `Ошибка: ${e.message}`, timestamp: Date.now() }));
    }
  }

  // ── Tailscale nodes (from asystem server) ───────────────────────────
  if (url === '/api/tailscale/nodes') {
    // Official Tailscale API — authoritative, includes tags, routes, lastSeen
    const TS_API_KEY = 'process.env.TS_API_KEY';
    try {
      const tsDevices = await new Promise((resolve, reject) => {
        https.get('https://api.tailscale.com/api/v2/tailnet/-/devices?fields=all', {
          headers: { 'Authorization': `Bearer ${TS_API_KEY}` },
          timeout: 10000,
        }, r => {
          let d = ''; r.on('data', c => d += c);
          r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
        }).on('error', reject).on('timeout', () => reject(new Error('ts timeout')));
      });
      const devices = tsDevices.devices ?? [];
      // Determine online: lastSeen within 5 min
      const now = Date.now();
      const nodes = devices.map(d => ({
        id: d.id, name: d.name?.split('.')[0] ?? d.hostname,
        ip: d.addresses?.[0] ?? null,
        os: d.os, tags: d.tags ?? [],
        routes: d.advertisedRoutes ?? [],
        lastSeen: d.lastSeen,
        online: d.lastSeen ? (now - new Date(d.lastSeen).getTime() < 5 * 60 * 1000) : false,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ nodes, tailnet: 'tail70fd.ts.net', ts: Date.now() }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ nodes: [], error: e.message, ts: Date.now() }));
    }
  }


  // ── Tailscale live ping (latency) ────────────────────────────────────
  if (url === '/api/tailscale/ping' && req.method === 'POST') {
    const chunks3 = []; req.on('data', c => chunks3.push(c));
    await new Promise(r => req.on('end', r));
    let ips = [];
    try { ips = JSON.parse(Buffer.concat(chunks3).toString()).ips ?? []; } catch {}
    ips = ips.slice(0, 20); // max 20

    const { promisify } = await import('util');
    const { exec: cpExec } = await import('child_process');
    const execAsync = promisify(cpExec);

    const results = await Promise.allSettled(ips.map(async ip => {
      const start = Date.now();
      try {
        // Use ICMP ping with 1 packet, 2s timeout
        await execAsync(`ping -c1 -W2 ${ip}`, { timeout: 3000 });
        return { ip, ms: Date.now() - start, online: true };
      } catch {
        // Try TCP connect to port 18789 (openclaw gateway)
        try {
          await execAsync(`nc -z -w2 ${ip} 18789`, { timeout: 3000 });
          return { ip, ms: Date.now() - start, online: true };
        } catch {
          return { ip, ms: null, online: false };
        }
      }
    }));

    const pings = results.map(r => r.status === 'fulfilled' ? r.value : { ip: r.reason?.ip ?? '?', ms: null, online: false });
    const H2p = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
    res.writeHead(200, H2p);
    return res.end(JSON.stringify({ pings, ts: Date.now() }));
  }

  // ── Tailscale device management ──────────────────────────────────────
  if (url.startsWith('/api/tailscale/device/') && req.method === 'DELETE') {
    const devId = url.replace('/api/tailscale/device/', '');
    const TS_API_KEY = 'process.env.TS_API_KEY';
    try {
      await new Promise((resolve, reject) => {
        const reqDel = https.request(`https://api.tailscale.com/api/v2/device/${devId}`, {
          method: 'DELETE', headers: { 'Authorization': `Bearer ${TS_API_KEY}` },
        }, r => { r.resume(); r.on('end', resolve); });
        reqDel.on('error', reject); reqDel.end();
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500); return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Tailscale routes approve ─────────────────────────────────────────
  if (url.startsWith('/api/tailscale/routes/') && req.method === 'POST') {
    const devId = url.replace('/api/tailscale/routes/', '');
    const TS_API_KEY = 'process.env.TS_API_KEY';
    let body = ''; req.on('data', c => body += c);
    await new Promise(r => req.on('end', r));
    const { routes } = JSON.parse(body || '{}');
    try {
      await new Promise((resolve, reject) => {
        const data = JSON.stringify({ routes });
        const r = https.request(`https://api.tailscale.com/api/v2/device/${devId}/routes`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${TS_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, resp => { resp.resume(); resp.on('end', resolve); });
        r.on('error', reject); r.write(data); r.end();
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
  }

  // ── Alerts: real-time system alerts ──────────────────────────────────
  if (url === '/api/alerts') {
    const alerts = [];
    try {
      // Check budget
      const BUDGET_FILE_A = path.join(USER_HOME_DIR, '.openclaw/workspace/.budget.json');
      const budget = JSON.parse(fs.readFileSync(BUDGET_FILE_A,'utf8').toString());
      // Get today's cost (quick estimate from JSONL)
      const tzOffset = 6 * 60;
      const nowLocal = new Date(Date.now() + tzOffset * 60000);
      const todayStr = nowLocal.toISOString().slice(0, 10);
      const todayStartMs = new Date(todayStr + 'T00:00:00Z').getTime() - tzOffset * 60000;
      let costToday = 0;
      const sessDir = path.join(USER_HOME_DIR, '.openclaw/agents/main/sessions');
      const sessFiles = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
      for (const sf of sessFiles) {
        const sfPath = path.join(sessDir, sf);
        if (fs.statSync(sfPath).mtimeMs < todayStartMs) continue;
        for (const line of fs.readFileSync(sfPath,'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (d.type !== 'message') continue;
            const ts = d.timestamp ? new Date(d.timestamp).getTime() : 0;
            if (ts > 0 && ts < todayStartMs) continue;
            costToday += d.message?.usage?.cost?.total ?? 0;
          } catch {}
        }
      }
      const dailyLimit  = budget.daily_limit ?? 300;
      const weeklyLimit = budget.weekly_limit ?? 1500;
      const isUnlimited = budget.plan_unlimited ?? false;
      const planLabel   = budget.plan_label ?? 'Custom';
      const threshold   = budget.alert_threshold ?? 0.85;
      const pct = costToday / dailyLimit;

      // Get week cost from /api/cfo/stats (already computed)
      let costWeek = 0;
      try {
        const cfoData = JSON.parse(fs.readFileSync(path.join(USER_HOME_DIR,'.openclaw/agents/main/sessions/sessions.json'),'utf8'));
        // weekly cost approximated: 7x daily (sessions.json doesn't store weekly natively)
        costWeek = costToday * 7 / (new Date().getDay() || 7); // rough estimate
      } catch {}

      // Only alert if genuinely anomalous (>threshold of limit)
      const isAnomaly = pct >= threshold;
      const weeklyAnomaly = weeklyLimit > 0 && costWeek > weeklyLimit * threshold;

      if (isAnomaly || weeklyAnomaly) {
        const planNote = isUnlimited ? ` [${planLabel} — не биллится]` : '';
        const alertMsg = `📊 Usage Alert: $${costToday.toFixed(2)}/день (лимит $${dailyLimit})${planNote}`;
        const severity = isUnlimited ? 'info' : (pct >= 1 ? 'error' : 'warning');
        alerts.push({ id:'budget', type:'Usage Alert', severity,
          message: alertMsg, ts: Date.now() });

        // Telegram notify — send once per day max (not per hour)
        if (budget.telegram_notify) {
          const flagFile = path.join(USER_HOME_DIR, '.openclaw/workspace/.budget-alert-sent');
          let shouldSend = true;
          try {
            const lastSent = parseInt(fs.readFileSync(flagFile,'utf8').trim());
            const lastDate = new Date(lastSent).toISOString().slice(0,10);
            const todayDate = new Date().toISOString().slice(0,10);
            if (lastDate === todayDate) shouldSend = false; // once per day
          } catch {}
          if (shouldSend) {
            const TG_TOKEN = '8400727128:AAEDiXtE0P2MfUJirXtN8zDjpU9kN03ork0';
            const TG_CHAT  = String(budget.telegram_chat_id ?? '861276843');
            const emoji = pct >= 1.5 ? '🚨' : pct >= 1 ? '⚠️' : 'ℹ️';
            const planLine = isUnlimited
              ? `\n💳 <b>Тариф:</b> ${planLabel} — стоимость информационная`
              : `\n❌ РЕАЛЬНЫЙ ЛИМИТ ПРЕВЫШЕН`;
            const tgText = `${emoji} <b>ASYSTEM Usage Alert</b>${planLine}\n📊 Сегодня: <b>$${costToday.toFixed(2)}</b> из $${dailyLimit} (${Math.round(pct*100)}%)\n📅 Неделя: $${costWeek.toFixed(2)} из $${weeklyLimit}`;
            https.request({
              hostname: 'api.telegram.org',
              path: `/bot${TG_TOKEN}/sendMessage`,
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            }, () => {}).end(JSON.stringify({ chat_id: TG_CHAT, text: tgText, parse_mode: 'HTML' }));
            try { fs.writeFileSync(flagFile, String(Date.now())); } catch {}
          }
        }
      }
    } catch {}

    // Check agent pings (offline > 30 min)
    const AGENT_IPS = { iron: '100.114.136.87', atlas: '100.68.144.79', mesa: '100.100.40.27', titan: '100.83.105.111' };
    const PING_CACHE_FILE = path.join(USER_HOME_DIR, '.openclaw/workspace/.ping-cache.json');
    let pingCache = {};
    try { pingCache = JSON.parse(fs.readFileSync(PING_CACHE_FILE,'utf8')); } catch {}
    const now = Date.now();
    for (const [agent, ip] of Object.entries(AGENT_IPS)) {
      const last = pingCache[agent];
      if (last && (now - last.ts) > 30 * 60 * 1000 && last.online === false) {
        alerts.push({ id:`offline-${agent}`, type:'Agent Offline', severity: (now-last.ts)>120*60*1000 ? 'error' : 'warning',
          message:`${agent.toUpperCase()} (${ip}) offline for ${Math.round((now-last.ts)/60000)} min`,
          ts: last.ts });
      }
    }

    // Check recent error-severity audit events
    const AUDIT_LOG_A = path.join(USER_HOME_DIR, '.openclaw/workspace/audit-log.jsonl');
    try {
      const lines = fs.readFileSync(AUDIT_LOG_A,'utf8').split('\n').filter(Boolean);
      const recent = lines.slice(-50).map(l => { try { return JSON.parse(l); } catch { return null; }}).filter(Boolean);
      const errorEvents = recent.filter(e => e.severity === 'error' && (now - (e.ts ?? 0)) < 30 * 60 * 1000);
      if (errorEvents.length > 0) {
        alerts.push({ id:'audit-errors', type:'Recent Errors', severity:'error',
          message:`${errorEvents.length} error event(s) in last 30 min: ${errorEvents[0]?.message?.slice(0,60)}`,
          ts: errorEvents[0]?.ts ?? now });
      }
    } catch {}

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ alerts, ts: Date.now() }));
  }

// ── Budget threshold: GET/PATCH ────────────────────────────────────
  const BUDGET_FILE = path.join(USER_HOME_DIR, '.openclaw/workspace/.budget.json');
  if (url === '/api/budget/threshold') {
    if (req.method === 'GET') {
      let cfg = { limit: 200, notifyOnPct: 80, alerted: false, lastAlertDate: null };
      try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')) }; } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(cfg));
    }
    if (req.method === 'PATCH') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      await new Promise(r => req.on('end', r));
      try {
        const patch = JSON.parse(Buffer.concat(chunks).toString());
        let cfg = { limit: 200, notifyOnPct: 80, alerted: false, lastAlertDate: null };
        try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')) }; } catch {}
        const updated = { ...cfg, ...patch };
        fs.writeFileSync(BUDGET_FILE, JSON.stringify(updated, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ ok: true, ...updated }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }
  }

  // ── Search: full-text across tasks + issues + agents ───────────────
  if (url.startsWith('/api/search') && req.method === 'GET') {
    const q = (params.get('q') || '').toLowerCase().trim();
    const H2s = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
    if (!q) { res.writeHead(200, H2s); return res.end(JSON.stringify({ results: [] })); }
    const results = [];
    // Pages
    const PAGES = [
      {title:'HQ — Command Bridge',path:'/'},{title:'C-Suite',path:'/csuite'},
      {title:'Corporation — Org Chart',path:'/corporation'},{title:'Kanban — Задачи',path:'/kanban'},
      {title:'War Room',path:'/warroom'},{title:'Live Feed',path:'/feed'},
      {title:'Building — HQ',path:'/building'},{title:'Intelligence',path:'/intel'},
      {title:'Network — Граф',path:'/network'},{title:'Topology — Shumoku',path:'/topology'},
      {title:'Proxmox — VMs',path:'/proxmox'},{title:'Cloudflare',path:'/cloudflare'},{title:'Audit Trail',path:'/audit'},
      {title:'Meta-Cognitive',path:'/meta'},{title:'Terminal',path:'/terminal'},
      {title:'Settings',path:'/settings'},{title:'Logs — Логи агентов',path:'/logs'},
      {title:'Analytics',path:'/analytics'},{title:'Sprints',path:'/sprints'},
      {title:'Memory',path:'/memory'},{title:'Projects',path:'/projects'},
    ];
    for (const p of PAGES) if (p.title.toLowerCase().includes(q)) results.push({ kind:'page', title:p.title, path:p.path, score:4 });
    // Agents
    const AGENTS_S = [
      {name:'Forge',id:'forge',role:'COO',color:'#06b6d4'},{name:'Atlas',id:'atlas',role:'CTO',color:'#f59e0b'},
      {name:'IRON',id:'iron',role:'CISO',color:'#ef4444'},{name:'MESA',id:'mesa',role:'CSO',color:'#8b5cf6'},
      {name:'PIXEL',id:'pixel',role:'CMO',color:'#ec4899'},{name:'Dana',id:'dana',role:'DIR-PM',color:'#22c55e'},
      {name:'Bekzat',id:'bekzat',role:'LEAD-BE',color:'#3b82f6'},{name:'Ainura',id:'ainura',role:'LEAD-FE',color:'#a78bfa'},
      {name:'Marat',id:'marat',role:'LEAD-QA',color:'#f97316'},{name:'Nurlan',id:'nurlan',role:'DIR-OPS',color:'#64748b'},
    ];
    for (const a of AGENTS_S) {
      if (a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q) || a.id.includes(q))
        results.push({ kind:'agent', title:a.name+' — '+a.role, path:'/building', color:a.color, score:5 });
    }
    // Convex tasks
    try {
      const convexRes = await fetch('https://expert-dachshund-299.convex.site/agent/tasks/list').then(r=>r.json()).catch(()=>({tasks:[]}));
      for (const t of (convexRes.tasks ?? [])) {
        if ((t.title||'').toLowerCase().includes(q) || (t.description||'').toLowerCase().includes(q) || (t.agent||'').toLowerCase().includes(q)) {
          results.push({ kind:'task', title:t.title, subtitle:(t.agent||'?')+' · '+t.status, path:'/kanban', status:t.status, score:t.status==='in-progress'?6:3 });
        }
      }
    } catch {}
    // Knowledge + memory files
    const searchDirs2 = [
      { dir: path.join(USER_HOME_DIR, '.openclaw/workspace/knowledge'), kind:'knowledge', nav:'/memory' },
      { dir: path.join(USER_HOME_DIR, '.openclaw/workspace/memory'),    kind:'memory',    nav:'/memory' },
      { dir: path.join(USER_HOME_DIR, '.openclaw/workspace/.learnings'), kind:'learning', nav:'/intel' },
    ];
    for (const sd of searchDirs2) {
      try {
        for (const f of fs.readdirSync(sd.dir).filter(x => x.endsWith('.md'))) {
          if (f.toLowerCase().includes(q)) { results.push({ kind:sd.kind, title:f.replace('.md',''), path:sd.nav, score:2 }); continue; }
          try {
            const txt = fs.readFileSync(path.join(sd.dir,f),'utf8').toLowerCase();
            const idx2 = txt.indexOf(q);
            if (idx2 >= 0) results.push({ kind:sd.kind, title:f.replace('.md',''), subtitle:txt.slice(Math.max(0,idx2-30),idx2+80).trim(), path:sd.nav, score:1 });
          } catch {}
        }
      } catch {}
    }
    results.sort((a,b) => b.score - a.score);
    res.writeHead(200, H2s);
    return res.end(JSON.stringify({ results: results.slice(0,15) }));
  }

  // ── Settings: GET current config ──────────────────────────────────
  if (url === '/api/settings' && req.method === 'GET') {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(USER_HOME_DIR, '.openclaw/openclaw.json'), 'utf8'));
      const model = cfg?.agents?.defaults?.model?.primary ?? 'unknown';
      const maxConcurrent = cfg?.agents?.defaults?.maxConcurrent ?? 4;
      const heartbeat = cfg?.agents?.defaults?.heartbeat?.every ?? '30m';
      const mediaMaxMb = cfg?.agents?.defaults?.mediaMaxMb ?? 50;
      const contextPruning = cfg?.agents?.defaults?.contextPruning ?? {};
      // Collect service ports — dynamically check
      const execP2 = promisify(exec);
      const checkPort = async (p) => {
        try { await execP2(`lsof -i :${p} 2>/dev/null | grep LISTEN`, { timeout: 1000 }); return 'online'; } catch { return 'offline'; }
      };
      const [gwSt] = await Promise.all([checkPort(18789)]);
      // API is self — if we're responding, it's online
      const services = [
        { name: 'ASYSTEM API', port: PORT, status: 'online' },
        { name: 'OpenClaw Gateway', port: 18789, status: gwSt },
        { name: 'CF Tunnel', port: null, status: 'online' },
        { name: 'Convex', port: null, status: 'online', url: 'https://expert-dachshund-299.convex.cloud' },
        { name: 'PVE1 (asystem)', port: 8006, status: 'proxied' },
        { name: 'PVE2 (cluster01)', port: 8038, status: 'proxied' },
      ];
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({
        model, maxConcurrent, heartbeat, mediaMaxMb, contextPruning,
        services, workspace: cfg?.agents?.defaults?.workspace ?? '~/.openclaw/workspace',
        version: cfg?.meta?.lastTouchedVersion ?? 'unknown',
        ts: Date.now(),
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Settings: PATCH update model ──────────────────────────────────
  if (url === '/api/settings' && req.method === 'PATCH') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    await new Promise(r => req.on('end', r));
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const cfgPath = path.join(USER_HOME_DIR, '.openclaw/openclaw.json');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (body.model) cfg.agents.defaults.model.primary = body.model;
      if (body.maxConcurrent) cfg.agents.defaults.maxConcurrent = body.maxConcurrent;
      if (body.heartbeat) cfg.agents.defaults.heartbeat.every = body.heartbeat;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ ok: true, updated: Object.keys(body) }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Seeds Issues for WarRoom ───────────────────────────────────────
  if (url === '/api/seeds/issues') {
    const execP = promisify(exec);
    try {
      const bunBin = path.join(USER_HOME_DIR, '.bun/bin/bun');
      const sdBin = path.join(USER_HOME_DIR, '.bun/bin/sd');
      const gasDir = path.join(USER_HOME_DIR, 'projects/gastown');
      const { stdout } = await execP(
        `cd "${gasDir}" && "${bunBin}" "${sdBin}" list --json`,
        { timeout: 5000, cwd: gasDir }
      );
      const data = JSON.parse(stdout);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ issues: data.issues ?? [], total: (data.issues ?? []).length }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ issues: [], error: e.message }));
    }
  }

  // ── Analytics: daily cost + commits (7 days) ──────────────────────
  if (url === '/api/analytics/daily') {
    const sessionsDir = path.join(USER_HOME_DIR, '.openclaw/agents/main/sessions');
    const days = 7;
    const DAY_MS = 86400000;
    const now = Date.now();
    // Build day buckets
    const buckets = Array.from({ length: days }, (_, i) => {
      const dayStart = now - (days - 1 - i) * DAY_MS;
      const d = new Date(dayStart);
      return { date: d.toISOString().slice(0, 10), cost: 0, tokens: 0, sessions: 0 };
    });
    try {
      const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const fpath = path.join(sessionsDir, file);
        const stat = fs.statSync(fpath);
        if (now - stat.mtimeMs > days * DAY_MS * 1.5) continue;
        const lines = fs.readFileSync(fpath, 'utf8').split('\n');
        let fileHasData = false;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (d.type !== 'message') continue;
            const usage = d.message?.usage;
            if (!usage?.cost) continue;
            // Use message timestamp; fallback to file mtime only if no timestamp
            const ts = d.timestamp ? new Date(d.timestamp).getTime() : stat.mtimeMs;
            const dayIdx = days - 1 - Math.floor((now - ts) / DAY_MS);
            if (dayIdx >= 0 && dayIdx < days) {
              buckets[dayIdx].cost += usage.cost.total ?? 0;
              buckets[dayIdx].tokens += (usage.input ?? 0) + (usage.output ?? 0);
              fileHasData = true;
            }
          } catch {}
        }
        if (fileHasData) {
          const fileDate = new Date(stat.mtimeMs).toISOString().slice(0, 10);
          const b = buckets.find(b => b.date === fileDate);
          if (b) b.sessions++;
        }
      }
    } catch {}
    // Round costs
    buckets.forEach(b => { b.cost = parseFloat(b.cost.toFixed(4)); });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ days: buckets, ts: Date.now() }));
  }

  // ── Analytics: cost per agent (last 7 days) ──────────────────────
  if (url === '/api/analytics/agents') {
    const sessionsDir = path.join(USER_HOME_DIR, '.openclaw/agents/main/sessions');
    const days = 7; const DAY_MS = 86400000; const now = Date.now();
    const agentCosts = {};
    try {
      const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const fpath = path.join(sessionsDir, file);
        const stat = fs.statSync(fpath);
        if (now - stat.mtimeMs > days * DAY_MS * 1.5) continue;
        const lines = fs.readFileSync(fpath, 'utf8').split('\n');
        let fileAgent = 'forge';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (d.agentId) { fileAgent = d.agentId; break; }
          } catch {}
        }
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (d.type !== 'message') continue;
            const usage = d.message?.usage;
            const costVal = usage?.cost?.total ?? usage?.cost ?? 0;
            if (!costVal) continue;
            const ag = d.agentId || fileAgent;
            if (!agentCosts[ag]) agentCosts[ag] = { cost: 0, tokens: 0, sessions: 0 };
            agentCosts[ag].cost += costVal;
            agentCosts[ag].tokens += (usage.input_tokens || 0) + (usage.output_tokens || 0);
          } catch {}
        }
        const ag = fileAgent;
        if (!agentCosts[ag]) agentCosts[ag] = { cost: 0, tokens: 0, sessions: 0 };
        agentCosts[ag].sessions += 1;
      }
    } catch {}
    const agents = Object.entries(agentCosts).map(([id, v]) => ({
      id, cost: Math.round(v.cost * 100) / 100, tokens: v.tokens, sessions: v.sessions
    })).sort((a, b) => b.cost - a.cost);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ agents, ts: Date.now() }));
  }

// ── Deep Health Check ─────────────────────────────────────────────
  if (url === '/api/health/deep') {
    const execP = promisify(exec);
    const checks = {};

    // Veritas Kanban
    try {
      const r = await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timeout')), 2000);
        http.get('http://localhost:3002/api/health', (resp) => {
          clearTimeout(t);
          resp.resume();
          res(resp.statusCode);
        }).on('error', rej);
      });
      checks.veritas = { ok: r === 200, status: r, port: 3002 };
    } catch (e) { checks.veritas = { ok: false, error: e.message, port: 3002 }; }

    // OpenClaw Gateway — check process is listening on 18789 (binds to Tailscale IP)
    try {
      const { stdout } = await execP("/usr/sbin/lsof -i :18789 2>/dev/null | grep LISTEN | wc -l", { timeout: 2000 });
      const listening = parseInt(stdout.trim()) > 0;
      checks.gateway = { ok: listening, status: listening ? 'listening' : 'not-listening', port: 18789, note: 'Tailscale bind' };
    } catch (e) { checks.gateway = { ok: false, error: e.message, port: 18789 }; }

    // Tailscale
    try {
      const { stdout } = await execP('/Applications/Tailscale.app/Contents/MacOS/Tailscale status --json', { timeout: 3000 });
      const ts = JSON.parse(stdout);
      checks.tailscale = { ok: ts.BackendState === 'Running', state: ts.BackendState };
    } catch { checks.tailscale = { ok: false, error: 'tailscale not available' }; }

    // Disk
    try {
      const { stdout } = await execP("df -h / | tail -1 | awk '{print $5, $4}'", { timeout: 2000 });
      const [usedPct, avail] = stdout.trim().split(' ');
      const pct = parseInt(usedPct);
      checks.disk = { ok: pct < 90, usedPercent: pct, available: avail };
    } catch { checks.disk = { ok: false, error: 'disk check failed' }; }

    // PM2 processes
    try {
      const { stdout } = await execP('pm2 jlist', { timeout: 3000 });
      const procs = JSON.parse(stdout);
      const online = procs.filter(p => p.pm2_env?.status === 'online');
      checks.pm2 = { ok: online.length > 0, total: procs.length, online: online.length,
        processes: online.map(p => ({ name: p.name, pid: p.pid, uptime: p.pm2_env?.pm_uptime })) };
    } catch { checks.pm2 = { ok: false, error: 'pm2 not available' }; }

    const allOk = Object.values(checks).every(c => c.ok);
    const okCount = Object.values(checks).filter(c => c.ok).length;
    const total = Object.keys(checks).length;
    const score = Math.round((okCount / total) * 100);

    res.writeHead(allOk ? 200 : 207, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({
      ok: allOk, score, summary: `${okCount}/${total} checks passed`,
      checks, ts: Date.now(),
    }));
  }

  // ── Logs SSE Stream ────────────────────────────────────────────────
  if (url === '/api/logs/stream') {
    const sessDir = path.join(USER_HOME_DIR, '.openclaw/agents/main/sessions');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    // Track last seen line count per session file
    let lastFile = null;
    let lastLineCount = 0;
    let intervalId;

    const readLatestSession = () => {
      try {
        const allFiles = fs.readdirSync(sessDir)
          .filter(f => f.endsWith('.jsonl') && !f.includes('.reset.'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(sessDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        if (!allFiles.length) return;
        const latest = allFiles[0];
        const filePath = path.join(sessDir, latest.name);
        const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);

        // New file opened — reset
        if (latest.name !== lastFile) { lastFile = latest.name; lastLineCount = 0; }

        if (lines.length > lastLineCount) {
          const newLines = lines.slice(lastLineCount);
          lastLineCount = lines.length;
          for (const line of newLines) {
            try {
              const obj = JSON.parse(line);
              if (obj.type !== 'message') continue;
              const role = obj.message?.role;
              if (!role || !['user','assistant','system'].includes(role)) continue;
              let text = '';
              const content = obj.message?.content;
              if (typeof content === 'string') text = content;
              else if (Array.isArray(content)) text = content.filter(b=>b.type==='text').map(b=>b.text).join('');
              if (!text.trim()) continue;
              const ts_raw = obj.timestamp ?? 0;
              const ts = typeof ts_raw === 'number' ? ts_raw : new Date(ts_raw).getTime();
              const entry = { type:'message', role, text: text.slice(0,2000), ts, id: obj.id ?? ts.toString() };
              res.write(`data: ${JSON.stringify(entry)}\n\n`);
            } catch {}
          }
        }
      } catch {}
    };

    // Send heartbeat to keep connection alive
    const heartbeatId = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    intervalId = setInterval(readLatestSession, 2000);
    readLatestSession(); // immediate first read

    req.on('close', () => {
      clearInterval(intervalId);
      clearInterval(heartbeatId);
    });
    return; // SSE — don't close normally
  }

  // ── Logs API + Search + Approve/Reject ─────────────────────────────
  const H2 = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
  if (url === '/api/logs') {
    try {
      const sessDir = path.join(USER_HOME_DIR, '.openclaw/agents/main/sessions');
      const agentParam = params.get('agent'); // filter by agent id (maps to cwd or hostname)
      const allFiles = fs.readdirSync(sessDir)
        .filter(f => f.endsWith('.jsonl') && !f.includes('.reset.'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(sessDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

      // For agent filtering: check first few lines of each file for hostname/cwd hint
      let files = allFiles;
      if (agentParam && agentParam !== 'forge') {
        // Remote agents have sessions in their own dirs — Forge only has its own sessions
        // For now: return empty for non-forge agents (they run on separate machines)
        files = []; // Will show "No history" cleanly
      }

      const limit = parseInt(params.get('limit') || '100', 10);
      const sessionParam = params.get('session');
      const target = sessionParam && sessionParam !== 'latest'
        ? files.find(f => f.name.startsWith(sessionParam))
        : files[0];
      if (!target) {
        res.writeHead(200, H2);
        return res.end(JSON.stringify({ entries: [], sessions: [] }));
      }
      const raw = fs.readFileSync(path.join(sessDir, target.name), 'utf8');
      const entries = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.type === 'message' && d.message) {
            const role = d.message.role;
            const content = d.message.content;
            let text = '';
            if (Array.isArray(content)) {
              for (const c of content) {
                if (c.type === 'text') text += c.text;
                else if (c.type === 'tool_use') text += `[🔧 ${c.name}(${JSON.stringify(c.input||{}).slice(0,60)})]`;
                else if (c.type === 'tool_result') text += `[✅ result]`;
              }
            } else if (typeof content === 'string') text = content;
            entries.push({ type: 'message', role, text: text.slice(0, 600), ts: new Date(d.timestamp).getTime(), id: d.id });
          } else if (d.type === 'custom' && d.customType === 'model-snapshot') {
            const cost = d.data?.cost?.total || 0;
            if (cost > 0) entries.push({ type: 'cost', text: `$${cost.toFixed(4)} · ${d.data?.modelAlias || d.data?.modelId || ''}`, ts: d.data?.timestamp || Date.now(), role: 'system' });
          }
        } catch {}
      }
      const sessions = files.slice(0, 25).map(f => ({ id: f.name.replace('.jsonl',''), mtime: f.mtime }));
      res.writeHead(200, H2);
      return res.end(JSON.stringify({ entries: entries.slice(-limit), currentSession: target.name.replace('.jsonl',''), sessions }));
    } catch(e) { res.writeHead(500, H2); return res.end(JSON.stringify({ error: e.message })); }
  }

  // ── Search API ───────────────────────────────────────────────────────
  if (url === '/api/search') {
    try {
      const q = (params.get('q') || '').toLowerCase().trim();
      if (!q) { res.writeHead(200, H2); return res.end(JSON.stringify({ results: [] })); }
      const results = [];
      const PAGES = [
        {title:'HQ — Command Bridge',path:'/'},{title:'C-Suite — Топ-менеджмент',path:'/csuite'},
        {title:'Corporation — Org Chart',path:'/corporation'},{title:'Kanban — Задачи',path:'/kanban'},
        {title:'War Room',path:'/warroom'},{title:'Live Feed',path:'/feed'},
        {title:'Building — HQ Isometric',path:'/building'},{title:'Intelligence',path:'/intel'},
        {title:'Network — Граф сети',path:'/network'},{title:'Topology — Shumoku',path:'/topology'},{title:'Proxmox — VMs',path:'/proxmox'},
        {title:'Cloudflare',path:'/cloudflare'},{title:'Audit Trail',path:'/audit'},
        {title:'Meta-Cognitive',path:'/meta'},{title:'Terminal',path:'/terminal'},
        {title:'Settings',path:'/settings'},{title:'Logs — Логи агентов',path:'/logs'},
      ];
      for (const p of PAGES) if (p.title.toLowerCase().includes(q)) results.push({ kind:'page', title:p.title, path:p.path, score:4 });
      // Agents
      const AGENT_LIST = [
        {name:'Forge',id:'forge',role:'COO',color:'#06b6d4'},{name:'Atlas',id:'atlas',role:'CTO',color:'#f59e0b'},
        {name:'IRON',id:'iron',role:'CISO',color:'#ef4444'},{name:'MESA',id:'mesa',role:'CSO',color:'#8b5cf6'},
        {name:'PIXEL',id:'pixel',role:'CMO',color:'#ec4899'},{name:'Dana',id:'dana',role:'DIR-PM',color:'#22c55e'},
        {name:'Bekzat',id:'bekzat',role:'LEAD-BE',color:'#3b82f6'},{name:'Ainura',id:'ainura',role:'LEAD-FE',color:'#a78bfa'},
        {name:'Marat',id:'marat',role:'LEAD-QA',color:'#f97316'},{name:'Nurlan',id:'nurlan',role:'DIR-OPS',color:'#64748b'},
      ];
      for (const a of AGENT_LIST) {
        if (a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q) || a.id.includes(q))
          results.push({ kind:'agent', title:`${a.name} — ${a.role}`, path:`/building/floor/3`, color:a.color, score:3 });
      }
      // Convex tasks (via HTTP action)
      try {
        const convexRes = await fetch('https://expert-dachshund-299.convex.site/agent/tasks/list').then(r=>r.json()).catch(()=>({tasks:[]}));
        const tasks = convexRes.tasks ?? [];
        for (const t of tasks) {
          if ((t.title||'').toLowerCase().includes(q) || (t.description||'').toLowerCase().includes(q) || (t.agent||'').toLowerCase().includes(q)) {
            results.push({ kind:'task', title:t.title, subtitle:`${t.agent||'?'} · ${t.status}`, path:'/kanban', status:t.status, score: t.status==='in-progress'?5:2 });
          }
        }
      } catch {}
      // Knowledge + memory files
      const searchDirs = [
        { dir: path.join(USER_HOME_DIR, '.openclaw/workspace/knowledge'), kind:'knowledge', nav:'/memory' },
        { dir: path.join(USER_HOME_DIR, '.openclaw/workspace/memory'),    kind:'memory',    nav:'/memory' },
        { dir: path.join(USER_HOME_DIR, '.openclaw/workspace/.learnings'), kind:'learning', nav:'/intel' },
      ];
      for (const sd of searchDirs) {
        try {
          for (const f of fs.readdirSync(sd.dir).filter(x => x.endsWith('.md'))) {
            if (f.toLowerCase().includes(q)) { results.push({ kind:sd.kind, title:f.replace('.md',''), path:sd.nav, score:2 }); continue; }
            try {
              const txt = fs.readFileSync(path.join(sd.dir,f),'utf8').toLowerCase();
              const idx2 = txt.indexOf(q);
              if (idx2 >= 0) results.push({ kind:sd.kind, title:f.replace('.md',''), subtitle:txt.slice(Math.max(0,idx2-30),idx2+80).trim(), path:sd.nav, score:1 });
            } catch {}
          }
        } catch {}
      }
      results.sort((a,b) => b.score - a.score);
      res.writeHead(200, H2);
      return res.end(JSON.stringify({ results: results.slice(0,15) }));
    } catch(e) { res.writeHead(500, H2); return res.end(JSON.stringify({ error: e.message })); }
  }


  // ── Agent Chat (SSE streaming) ────────────────────────────────────────────
  if (req.method === 'POST' && url.startsWith('/api/chat/')) {
    const agentId = url.split('/')[3];
    const chunksCh = []; req.on('data', c => chunksCh.push(c));
    await new Promise(r => req.on('end', r));
    let bodyCh = {};
    try { bodyCh = JSON.parse(Buffer.concat(chunksCh).toString()); } catch {}
    const userMessage = bodyCh.message ?? '';

    // SSE helper
    const SSE_HEADERS = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    };
    const sendSSE = (data) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const endSSE = (reply, remote = false) => {
      sendSSE({ done: true, reply, agent: agentId, ts: Date.now(), remote });
      res.write('data: [DONE]\n\n');
      res.end();
    };

    const knownAgents = ['forge', 'atlas', 'iron', 'mesa', 'titan', 'pixel', 'dana', 'nurlan', 'bekzat', 'ainura', 'marat'];
    if (!knownAgents.includes(agentId)) {
      res.writeHead(404, H2); return res.end(JSON.stringify({ error: `Unknown agent: ${agentId}` }));
    }

    // Start SSE stream
    res.writeHead(200, SSE_HEADERS);
    sendSSE({ text: '', status: 'connecting', agent: agentId });

    // ── Forge (self) — stream via child_process spawn ───────────────────
    if (agentId === 'forge') {
      try {
        const { spawn } = await import('child_process');
        const sessionId = bodyCh.sessionId ?? 'panel-chat-forge';
        const escaped = userMessage.replace(/'/g, "'\\''");
        const proc = spawn('openclaw', ['agent', '--local', '--session-id', sessionId, '--message', userMessage, '--json'], {
          env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
          timeout: 55000,
        });
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => {
          stdout += d.toString();
          // Stream partial text lines as they arrive
          const match = stdout.match(/"text":\s*"((?:[^"\\]|\\.)*)"/g);
          if (match) {
            const lastText = match[match.length - 1].replace(/"text":\s*"/, '').replace(/"$/, '').replace(/\\n/g, '\n').replace(/\\"/g, '"');
            sendSSE({ text: lastText, status: 'streaming' });
          }
        });
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', () => {
          let reply = '';
          try {
            const start = stdout.indexOf('{');
            const end = stdout.lastIndexOf('}');
            if (start >= 0 && end > start) {
              const parsed = JSON.parse(stdout.slice(start, end + 1));
              reply = (parsed.payloads ?? [])[0]?.text ?? parsed.text ?? parsed.reply ?? '';
            }
          } catch {}
          if (!reply) {
            const m = stdout.match(/"text":\s*"((?:[^"\\]|\\.)*)"/);
            reply = m ? m[1].replace(/\\n/g,'\n').replace(/\\"/g,'"') : stdout.trim().slice(0, 1000);
          }
          // Detect Anthropic 529 overload / rate limit → fallback to local Ollama
          const isOverload = !reply || (
            reply.includes('overloaded') || reply.includes('rate limit') ||
            reply.includes('529') || reply.includes('temporarily') ||
            stderr.includes('overloaded') || stderr.includes('rate_limit_error') ||
            reply.includes('API rate limit')
          );
          if (isOverload) {
            sendSSE({ text: '⚡ Anthropic перегружен → переключаюсь на локальную модель (qwen2.5:14b)...', status: 'streaming', fallback: true });
            // ── Ollama fallback (Symphony local model) ──────────────────────
            try {
              const ollamaBody = JSON.stringify({
                model: 'qwen2.5:14b',
                messages: [{ role: 'user', content: userMessage }],
                stream: true,
              });
              const ollamaReq = http.request({
                hostname: '127.0.0.1', port: 11434,
                path: '/api/chat', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ollamaBody) },
                timeout: 60000,
              }, (ollamaRes) => {
                let fullReply = '';
                ollamaRes.on('data', chunk => {
                  try {
                    const lines = chunk.toString().split('\n').filter(Boolean);
                    for (const line of lines) {
                      const parsed = JSON.parse(line);
                      const token = parsed?.message?.content || '';
                      if (token) {
                        fullReply += token;
                        sendSSE({ text: fullReply, status: 'streaming', model: 'qwen2.5:14b', fallback: true });
                      }
                      if (parsed.done) {
                        endSSE(`🤖 [qwen2.5:14b] ${fullReply}`, false);
                      }
                    }
                  } catch {}
                });
                ollamaRes.on('error', () => endSSE('⚠️ Anthropic перегружен, Ollama тоже недоступен.'));
              });
              ollamaReq.on('error', () => endSSE('⚠️ Anthropic перегружен. Запустите Ollama для fallback.'));
              ollamaReq.on('timeout', () => { ollamaReq.destroy(); endSSE('⚠️ Ollama timeout.'); });
              ollamaReq.write(ollamaBody);
              ollamaReq.end();
            } catch (fallbackErr) {
              endSSE(`⚠️ Anthropic перегружен (529). Ollama fallback error: ${fallbackErr.message}`);
            }
          } else {
            endSSE(reply || '(нет ответа)');
          }
        });
        proc.on('error', e => endSSE(`⚠️ Forge: ${e.message}`));
      } catch (e) {
        endSSE(`⚠️ Forge недоступен: ${e.message.slice(0,100)}`);
      }
      return; // SSE handles response lifecycle
    }

    // Remote agents — SSH relay
    // Map: agentId → { sshUser, sshHost, sessionPrefix }
    const REMOTE_AGENTS = {
      atlas: { user: 'asystem', host: '100.68.144.79',  session: 'atlas-panel' },
      iron:  { user: 'asystem', host: '100.114.136.87', session: 'iron-panel'  },
      mesa:  { user: 'asystem', host: '100.100.40.27',  session: 'mesa-panel'  },
      // PVE2 LXC agents — lxc-attach relay via 100.122.3.73
      dana:  { user: 'root', host: '11.12.1.1', session: 'dana-panel',   proxy: '100.122.3.73', lxcId: '501' },
      nurlan:{ user: 'root', host: '11.12.1.2', session: 'nurlan-panel', proxy: '100.122.3.73', lxcId: '502' },
      bekzat:{ user: 'root', host: '11.12.1.3', session: 'bekzat-panel', proxy: '100.122.3.73', lxcId: '503' },
      ainura:{ user: 'root', host: '11.12.1.4', session: 'ainura-panel', proxy: '100.122.3.73', lxcId: '504' },
      marat: { user: 'root', host: '11.12.1.5', session: 'marat-panel',  proxy: '100.122.3.73', lxcId: '505' },
    };

    const remote = REMOTE_AGENTS[agentId];
    if (!remote) {
      res.writeHead(200, H2ch);
      return res.end(JSON.stringify({ reply: `Агент ${agentId} не настроен`, agent: agentId, ts: Date.now() }));
    }

    // ── Remote agents — SSH + SSE ──────────────────────────────────────────
    try {
      const { spawn } = await import('child_process');
      const sessionId = bodyCh.sessionId ?? `${remote.session}`;
      const AGENT_OR = 'process.env.OPENROUTER_API_KEY';

      let spawnArgs, spawnCmd;
      if (remote.lxcId) {
        const msgB64 = Buffer.from(userMessage.slice(0, 2000)).toString('base64');
        spawnCmd = 'ssh';
        spawnArgs = [
          '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes',
          `root@${remote.proxy}`,
          `lxc-attach -n ${remote.lxcId} -- runuser -l asystem -c '/tmp/agent-chat.sh ${msgB64} ${sessionId}'`,
        ];
      } else {
        spawnCmd = 'ssh';
        const escaped = userMessage.replace(/'/g, "'\\''").slice(0, 2000);
        spawnArgs = [
          '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes',
          `${remote.user}@${remote.host}`,
          `openclaw agent --local --session-id '${sessionId}' --message '${escaped}' --json 2>/dev/null`,
        ];
      }

      // Send "thinking" heartbeat every 3s while waiting
      sendSSE({ text: '⏳', status: 'thinking', agent: agentId });
      const heartbeat = setInterval(() => sendSSE({ text: '', status: 'thinking' }), 3000);

      const proc = spawn(spawnCmd, spawnArgs, {
        env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
      });
      let stdout = '';
      proc.stdout.on('data', d => {
        stdout += d.toString();
        // Stream partial text as it arrives
        const m = stdout.match(/"text":\s*"((?:[^"\\]|\\.)*)"/g);
        if (m) {
          const last = m[m.length - 1].replace(/"text":\s*"/, '').replace(/"$/, '').replace(/\\n/g, '\n').replace(/\\"/g, '"');
          if (last.length > 5) sendSSE({ text: last, status: 'streaming' });
        }
      });
      proc.on('close', (code) => {
        clearInterval(heartbeat);
        let reply = '';
        // Strategy 1: find the outermost JSON object in stdout
        try {
          const start = stdout.indexOf('{');
          const end = stdout.lastIndexOf('}');
          if (start >= 0 && end > start) {
            const parsed = JSON.parse(stdout.slice(start, end + 1));
            reply = (parsed.payloads ?? [])[0]?.text ?? parsed.text ?? parsed.reply ?? parsed.message ?? '';
          }
        } catch {}
        // Strategy 2: regex extract "text" field value
        if (!reply) {
          const m2 = stdout.match(/"text":\s*"((?:[^"\\]|\\.)*)"/);
          reply = m2 ? m2[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : '';
        }
        // Strategy 3: raw stdout as last resort
        if (!reply) {
          reply = stdout.trim().slice(0, 1000) || `[${agentId.toUpperCase()} — нет ответа]`;
        }
        endSSE(reply, true);
      });
      proc.on('error', e => {
        clearInterval(heartbeat);
        endSSE(`⚠️ ${agentId}: ${e.message.slice(0, 80)}`);
      });
      // Timeout safety
      setTimeout(() => {
        if (!res.writableEnded) {
          clearInterval(heartbeat);
          proc.kill();
          endSSE(`[${agentId.toUpperCase()} — timeout 55s]`, true);
        }
      }, 55000);

    } catch (e) {
      endSSE(`⚠️ ${agentId}: ${e.message.slice(0, 100)}`);
    }
    return; // SSE handles response lifecycle
  }



  // ── Cost Forecast ─────────────────────────────────────────────────────
  if (url === '/api/costs/forecast') {
    try {
      const sessDir = path.join(USER_HOME_DIR, '.openclaw/agents/main/sessions');
      // Read last 7 days of cost per day
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const dayStart = new Date(); dayStart.setUTCHours(-6, 0, 0, 0); dayStart.setDate(dayStart.getDate() - i);
        const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
        let dayCost = 0;
        try {
          for (const file of fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl')).slice(-100)) {
            for (const line of fs.readFileSync(path.join(sessDir, file), 'utf8').split('\n').filter(Boolean)) {
              try {
                const obj = JSON.parse(line);
                if (obj.type !== 'message' || obj.message?.role !== 'assistant') continue;
                const cost = obj.message?.usage?.cost?.total ?? 0;
                const ts_raw = obj.timestamp ?? 0;
                const ts = typeof ts_raw === 'number' ? ts_raw : new Date(ts_raw).getTime();
                if (cost > 0 && ts >= dayStart.getTime() && ts < dayEnd.getTime()) dayCost += cost;
              } catch {}
            }
          }
        } catch {}
        const label = dayStart.toLocaleDateString('ru', { month: 'short', day: 'numeric', timeZone: 'Asia/Bishkek' });
        days.push({ label, cost: +dayCost.toFixed(2), ts: dayStart.getTime() });
      }

      // Forecast: average of last 3 days * remaining days in month
      const last3 = days.slice(-3).map(d => d.cost);
      const avgDay = last3.reduce((a, b) => a + b, 0) / Math.max(last3.length, 1);
      const now = new Date();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const dayOfMonth = now.getDate();
      const remainingDays = daysInMonth - dayOfMonth;
      const costSoFarMonth = days.slice(-dayOfMonth).reduce((a, d) => a + d.cost, 0);
      const forecastMonth = costSoFarMonth + avgDay * remainingDays;
      const forecastWeek = avgDay * 7;

      const H2f = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
      res.writeHead(200, H2f);
      return res.end(JSON.stringify({
        days, avgPerDay: +avgDay.toFixed(2),
        forecastMonth: +forecastMonth.toFixed(2),
        forecastWeek: +forecastWeek.toFixed(2),
        remainingDays, daysInMonth,
        limits: { daily: 50, weekly: 300, monthly: 1000 },
        ts: Date.now(),
      }));
    } catch(e) {
      const H2f = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      res.writeHead(500, H2f);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Daily Digest ─────────────────────────────────────────────────────
  if ((url === '/api/digest' || url === '/api/costs/forecast') && req.method === 'GET') {
    try {
      const { promisify } = await import('util');
      const { exec: cpExec } = await import('child_process');
      const execAsync = promisify(cpExec);
      const now = new Date();
      const dateStr = now.toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Bishkek' });

      // 1. Agent statuses from /api/agents cache
      let agentSummary = '';
      try {
        const agRes = await fetch('http://127.0.0.1:5190/api/agents');
        const agData = await agRes.json();
        const ags = agData.agents ?? [];
        const online = ags.filter(a => a.online);
        agentSummary = `Онлайн: ${online.map(a => a.name).join(', ')} (${online.length}/${ags.length})`;
      } catch { agentSummary = 'N/A'; }

      // 2. Tasks from Convex
      let taskSummary = '';
      try {
        const txRes = await fetch('https://expert-dachshund-299.convex.site/agent/tasks/list');
        const txData = await txRes.json();
        const tasks = txData.tasks ?? [];
        const done = tasks.filter(t => t.status === 'done').length;
        const ip = tasks.filter(t => t.status === 'in-progress').length;
        const todo = tasks.filter(t => t.status === 'todo').length;
        taskSummary = `Задачи: ✅ ${done} done / 🔄 ${ip} in-progress / 📋 ${todo} todo`;
      } catch { taskSummary = 'N/A'; }

      // 3. Cost today from JSONL
      let costToday = 0;
      try {
        const sessDir = path.join(USER_HOME_DIR, '.openclaw/agents/main/sessions');
        const today = new Date(); today.setUTCHours(-6, 0, 0, 0); // BST = UTC+6, today starts at 18:00 UTC prev day
        for (const file of fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl')).slice(-50)) {
          for (const line of fs.readFileSync(path.join(sessDir,file),'utf8').split('\n').filter(Boolean)) {
            try {
              const obj = JSON.parse(line);
              if (obj.type !== 'message' || obj.message?.role !== 'assistant') continue;
              const cost = obj.message?.usage?.cost?.total ?? 0;
              const ts = typeof obj.timestamp === 'number' ? obj.timestamp : new Date(obj.timestamp || 0).getTime();
              if (cost > 0 && ts > today.getTime()) costToday += cost;
            } catch {}
          }
        }
      } catch {}

      // 4. Git commits today
      let gitSummary = '';
      try {
        const projectsDir = path.join(USER_HOME_DIR, 'projects');
        const repos = fs.readdirSync(projectsDir).filter(d => {
          try { return fs.existsSync(path.join(projectsDir, d, '.git')); } catch { return false; }
        }).slice(0, 8);
        const commits = [];
        for (const repo of repos) {
          try {
            const { stdout } = await execAsync(`git -C "${path.join(projectsDir, repo)}" log --oneline --since="24 hours ago" 2>/dev/null`);
            const lines = stdout.trim().split('\n').filter(Boolean);
            if (lines.length) commits.push(`${repo}: ${lines.length} commit${lines.length>1?'s':''}`);
          } catch {}
        }
        gitSummary = commits.length ? commits.join(', ') : 'Нет коммитов сегодня';
      } catch { gitSummary = 'N/A'; }

      // 5. Disk usage
      let diskSummary = '';
      try {
        const { stdout: dfOut } = await execAsync('df -h / | tail -1');
        const parts = dfOut.trim().split(/\s+/);
        diskSummary = `Disk: ${parts[2]} / ${parts[1]} (${parts[4]} used)`;
      } catch { diskSummary = 'N/A'; }

      // Build markdown digest
      const md = `# 📊 ASYSTEM Daily Digest
**${dateStr}**

## 🤖 Агенты
${agentSummary}

## 📋 Задачи
${taskSummary}

## 💰 Cost Today
$${costToday.toFixed(2)} (бюджет: $50/день)

## 🔧 Git Activity (24h)
${gitSummary}

## 💾 Система
${diskSummary}

---
*Сгенерировано: ${now.toLocaleTimeString('ru', { timeZone: 'Asia/Bishkek' })} BST*`;

      const H2d = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
      res.writeHead(200, H2d);
      return res.end(JSON.stringify({
        md, dateStr, agentSummary, taskSummary,
        costToday: +costToday.toFixed(2), gitSummary, diskSummary,
        ts: Date.now(),
      }));
    } catch(e) {
      const H2d = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      res.writeHead(500, H2d);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Tasks: GET pending (for n8n Agent Loop) ──────────────────────────────
  if (url === '/api/tasks/pending' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const _CXURL = 'https://expert-dachshund-299.convex.cloud';
      const params = new URLSearchParams(req.url.split('?')[1] || '');
      const limit = parseInt(params.get('limit') || '3');
      const assignee = params.get('agent') || null;
      const resp = await fetch(`${_CXURL}/api/query`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'tasks:list', args: { status: 'todo' } }),
      });
      const data = await resp.json();
      let tasks = (data.value || data.result || []);
      if (assignee) tasks = tasks.filter(t => !t.assignedTo || t.assignedTo === assignee || t.assignedTo === 'forge');

      // Dedup by title — keep first, immediately mark duplicates as done in Convex
      const seenTitles = new Map(); // title → kept _id
      const dupIds = [];
      tasks = tasks.filter(t => {
        const key = (t.title || '').trim().toLowerCase();
        if (seenTitles.has(key)) { dupIds.push(t._id); return false; }
        seenTitles.set(key, t._id);
        return true;
      });

      // Paperclip pattern: Atomic Task Checkout — skip already claimed tasks
      // claimed_by = agentId + timestamp (set when agent picks up task)
      const _claimTtlMs = 10 * 60_000; // 10 min stale claim TTL
      const _now = Date.now();
      tasks = tasks.filter(t => {
        if (!t.claimed_by) return true; // unclaimed → available
        const [, claimedAt] = (t.claimed_by || '').split(':');
        if (claimedAt && (_now - parseInt(claimedAt)) < _claimTtlMs) {
          console.log(`[checkout] Task "${(t.title||'').slice(0,40)}" claimed by ${t.claimed_by} — skipping`);
          return false; // still claimed → skip
        }
        return true; // stale claim (>10min) → re-available
      });
      // Fire-and-forget: mark duplicates done
      if (dupIds.length) {
        const _CX = 'https://expert-dachshund-299.convex.cloud';
        Promise.all(dupIds.map(id => fetch(`${_CX}/api/mutation`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: 'tasks:updateStatus', args: { id, status: 'done' } }),
        }).catch(() => {}))).then(() => {
          if (dupIds.length > 0) console.log(`[pending] Auto-deduped ${dupIds.length} duplicate tasks`);
        });
      }

      // Protocol Gate Layer — deterministic checks (LLM cannot bypass these)
      // Gate 1: Destructive ops require 'approved' tag
      const DESTRUCTIVE_PATTERNS = /delete|drop|truncate|rm -rf|destroy|wipe|reset.*db|migrate.*prod/i;
      // Gate 2: Sensitive ops require 'sensitive-ok' tag
      const SENSITIVE_PATTERNS_TASK = /deploy.*prod|push.*main|merge.*main|send.*telegram|notify.*all|\.env|sudo|chmod\s*7/i;

      tasks = tasks.filter(t => {
        const content = t.title + ' ' + (t.description || '');
        const tags = Array.isArray(t.tags) ? t.tags : [];

        // Gate 1: Destructive
        if (DESTRUCTIVE_PATTERNS.test(content)) {
          if (!tags.includes('approved')) {
            console.warn(`[ProtocolGate] ⛔ Destructive task blocked (needs 'approved' tag): "${t.title}"`);
            return false;
          }
        }

        // Gate 2: Sensitive (non-destructive but risky)
        if (SENSITIVE_PATTERNS_TASK.test(content)) {
          if (!tags.includes('sensitive-ok') && !tags.includes('approved')) {
            console.warn(`[ProtocolGate] 🔒 Sensitive task blocked (needs 'sensitive-ok' tag): "${t.title}"`);
            return false;
          }
        }

        return true;
      });

      tasks = tasks.slice(0, limit);
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, tasks, count: tasks.length }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/tasks/:id — single task detail
  if (req.method === 'GET' && /^\/api\/tasks\/[a-zA-Z0-9]+$/.test(url)) {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const taskId = url.split('/').pop();
    try {
      const resp = await fetch('https://expert-dachshund-299.convex.cloud/api/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'tasks:get', args: { id: taskId } }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await resp.json();
      const task = data?.value || data?.result || null;
      if (!task) { res.writeHead(404, _H); return res.end(JSON.stringify({ error: 'not found' })); }
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, task }));
    } catch (e) {
      res.writeHead(500, _H);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Brain Dump → Task Generation (кейс #5) ───────────────────────────────
    // GET /api/tasks/priority-queue?agent=forge&limit=5 — Priority + SLA routing
  if (url.startsWith('/api/tasks/priority-queue') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const params = new URLSearchParams(req.url.split('?')[1] || '');
      const agent = params.get('agent') || 'forge';
      const limit = parseInt(params.get('limit') || '2');
      const { getPriorityQueue } = await import('./task-priority-sla.mjs');
      const result = await getPriorityQueue(agent, limit);
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, ...result }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // GET /api/tasks/overdue — List tasks past SLA deadline
  if (url === '/api/tasks/overdue' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { getOverdueTasks } = await import('./task-priority-sla.mjs');
      const overdue = await getOverdueTasks();
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, overdue, count: overdue.length }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // PATCH /api/tasks/:id/priority { priority, sla_minutes } — Update task priority/SLA
  if (url.match(/^\/api\/tasks\/[a-zA-Z0-9]+\/priority$/) && req.method === 'PATCH') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const taskId = url.split('/')[3];
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { priority, sla_minutes } = JSON.parse(body);
      const { updateTaskPrioritySLA } = await import('./task-priority-sla.mjs');
      const result = await updateTaskPrioritySLA(taskId, { priority, sla_minutes });
      res.writeHead(result.ok ? 200 : 500, _H);
      return res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

if (url === '/api/braindump' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
    try {
      const { text = '', goals = [], max_tasks = 5 } = JSON.parse(Buffer.concat(chunks).toString());
      const input = text || goals.join('\n');
      if (!input.trim()) { res.writeHead(400, _H); return res.end(JSON.stringify({ error: 'text required' })); }

      // Use OpenAI API to parse brain dump into tasks
      const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
      const prompt = `Parse this brain dump into ${max_tasks} concrete tasks for ASYSTEM dev team.\nFor each: {"title":"...","body":"...","priority":"high|medium|low","assignedTo":"forge|atlas|ainura|bekzat|nurlan|dana|mesa|marat|iron|pixel"}\nOutput ONLY a JSON array, no markdown.\n\nBrain dump:\n${input}`;
      const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 800 }),
      });
      const aiData = await aiResp.json();
      const rawOutput = aiData.choices?.[0]?.message?.content || '[]';

      // Extract JSON array from output
      const match = rawOutput.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('No JSON array in LLM response');
      const tasks = JSON.parse(match[0]).slice(0, max_tasks);

      // Create tasks in Convex
      const _CXURL = 'https://expert-dachshund-299.convex.cloud';
      const created = [];
      for (const t of tasks) {
        const r = await fetch(`${_CXURL}/api/mutation`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: 'tasks:create', args: { title: t.title, description: t.body, priority: t.priority || 'medium', agent: t.assignedTo || 'forge', status: 'todo', type: 'task' } }),
        });
        const d = await r.json();
        if (d.value) created.push({ id: d.value, ...t });
      }

      // Save to memory
      await fetch('http://localhost:5190/api/memory/reme/add', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ content: `Brain dump processed ${new Date().toISOString()}: ${tasks.map(t=>t.title).join(', ')}` }),
      }).catch(() => {});

      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, created: created.length, tasks: created }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

// ── Dynamic Dashboard — Parallel Subagent Data Collector (кейс #20) ──────
  if (url === '/api/dashboard/snapshot' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFA = promisify(execFile);

      // Collect all data points in parallel
      const [tsStatus, pm2Status, pendingTasks, recentMemory] = await Promise.allSettled([
        // Tailscale
        execFA('/Applications/Tailscale.app/Contents/MacOS/Tailscale', ['status', '--json'], { timeout: 8000 })
          .then(({stdout}) => {
            const d = JSON.parse(stdout);
            const peers = Object.values(d.Peer || {});
            return { online: peers.filter(p=>p.Online).length, total: peers.length,
              agents: peers.filter(p=>p.Online).map(p=>p.HostName).slice(0,10) };
          }),
        // PM2
        execFA('pm2', ['jlist'], { timeout: 5000, env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` } })
          .then(({stdout}) => {
            const procs = JSON.parse(stdout);
            return { online: procs.filter(p=>p.pm2_env?.status==='online').length, total: procs.length,
              processes: procs.map(p=>({ name: p.name, status: p.pm2_env?.status, mem: Math.round((p.monit?.memory||0)/1024/1024) })) };
          }),
        // Pending tasks
        fetch('http://localhost:5190/api/tasks/pending?limit=10').then(r=>r.json()),
        // Recent memory
        fetch('http://localhost:5190/api/memory/reme?q=ASYSTEM+recent+task&top=3').then(r=>r.json()),
      ]);

      res.writeHead(200, _H);
      return res.end(JSON.stringify({
        ts: Date.now(),
        tailscale: tsStatus.status === 'fulfilled' ? tsStatus.value : { error: tsStatus.reason?.message },
        pm2: pm2Status.status === 'fulfilled' ? pm2Status.value : { error: pm2Status.reason?.message },
        tasks: pendingTasks.status === 'fulfilled' ? pendingTasks.value : { count: 0 },
        memory: recentMemory.status === 'fulfilled' ? recentMemory.value : { results: [] },
      }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

// ── STATE.yaml — CEO coordination (кейс #12) ─────────────────────────────
  if (url === '/api/state' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const statePath = path.join(USER_HOME_DIR, 'projects/ASYSTEM/api/state.yaml');
      const raw = fs.readFileSync(statePath, 'utf8');
      res.writeHead(200, _H); return res.end(JSON.stringify({ ok: true, state: raw }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (url === '/api/state' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
    try {
      const { patch: statePatch, agent: patchAgent = 'unknown', decision } = JSON.parse(Buffer.concat(chunks).toString());
      const statePath = path.join(USER_HOME_DIR, 'projects/ASYSTEM/api/state.yaml');
      let raw = fs.readFileSync(statePath, 'utf8');
      // Update last_updated + updated_by
      raw = raw.replace(/last_updated: ".*?"/, `last_updated: "${new Date().toISOString()}"`);
      raw = raw.replace(/updated_by: \w+/, `updated_by: ${patchAgent}`);
      // Append decision if provided
      if (decision) {
        const entry = `  - date: "${new Date().toISOString().split('T')[0]}"\n    decision: "${decision}"\n    by: ${patchAgent}\n`;
        raw = raw.replace('decisions:\n', `decisions:\n${entry}`);
      }
      // Apply free-form patch if provided
      if (statePatch) raw += `\n# patch by ${patchAgent}:\n${statePatch}\n`;
      fs.writeFileSync(statePath, raw);
      res.writeHead(200, _H); return res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

// ── Deploy Pipeline Hook ──────────────────────────────────────────────────

  // ── Git Workflow: commit + push + PR after coding task ─────────────────────
  if (url === '/api/git/workflow' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const chunks = []; req.on('data', c => chunks.push(c)); await new Promise(r => req.on('end', r));
    try {
      const { repo = '~/projects/ASYSTEM', task_title = 'auto', create_pr = false } = JSON.parse(Buffer.concat(chunks).toString());
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFA = promisify(execFile);
      const repoPath = repo.replace('~', USER_HOME_DIR);
      const { stdout: statusOut } = await execFA('git', ['status', '--porcelain'], { cwd: repoPath, timeout: 10000 });
      if (!statusOut.trim()) {
        res.writeHead(200, _H); return res.end(JSON.stringify({ ok: true, message: 'Nothing to commit', changed: false }));
      }
      await execFA('git', ['add', '-A'], { cwd: repoPath, timeout: 10000 });
      const { stdout: commitOut } = await execFA('git', ['commit', '-m', `auto: ${task_title}`], { cwd: repoPath, timeout: 10000 });
      await execFA('git', ['push', 'origin', 'HEAD'], { cwd: repoPath, timeout: 30000 });
      let prUrl = null;
      if (create_pr) {
        try {
          const { stdout: prOut } = await execFA('gh', ['pr', 'create',
            '--title', `Auto: ${task_title}`,
            '--body', `Auto-created by ASYSTEM task loop\n\nTask: ${task_title}`,
            '--base', 'main',
          ], { cwd: repoPath, timeout: 30000, env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` } });
          prUrl = prOut.trim().split('\n').pop();
        } catch {}
      }
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, changed: true, commit: commitOut.trim().split('\n')[0], prUrl }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }


  // ── LiveKit Token — generate room access token ─────────────────────────────
  // POST /api/tasks/:id/claim  { agent } — Paperclip atomic checkout
  // Agent calls this before starting a task to prevent double-work
  if (req.method === 'POST' && url.match(/^\/api\/tasks\/[^/]+\/claim$/)) {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const taskId = url.split('/')[3];
    const chunks = []; req.on('data', c => chunks.push(c));
    await new Promise(r => req.on('end', r));
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    const { agent = 'unknown', release = false } = body;

    try {
      const claimValue = release ? null : `${agent}:${Date.now()}`;
      await fetch('https://expert-dachshund-299.convex.cloud/api/mutation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'tasks:updateStatus', args: { id: taskId, status: release ? 'todo' : 'in_progress' } }),
      });
      console.log(`[checkout] Task ${taskId} ${release ? 'released' : 'claimed'} by ${agent}`);
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, taskId, claimed_by: claimValue, agent, release }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // PATCH /api/tasks/:id/status — update task status
  if (req.method === 'PATCH' && /^\/api\/tasks\/[a-zA-Z0-9]+\/status$/.test(url)) {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const taskId = url.split('/')[3];
    try {
      const body = await new Promise((resolve) => {
        let d = ''; req.on('data', c => d += c);
        req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
      });
      const { status } = body;
      const resp = await fetch('https://expert-dachshund-299.convex.cloud/api/mutation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'tasks:updateStatus', args: { id: taskId, status } }),
        signal: AbortSignal.timeout(5000),
      });
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, status, id: taskId }));
    } catch (e) {
      res.writeHead(500, _H);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // GET /api/livekit/token?room=hq&identity=urmat
  if (url.startsWith('/api/livekit/token') && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const params = new URLSearchParams(req.url.split('?')[1] || '');
      const room = params.get('room') || 'hq-command';
      const identity = params.get('identity') || 'user';
      const name = params.get('name') || identity;

      const apiKey = process.env.LIVEKIT_API_KEY || 'asystem-livekit-8e293b79';
      const secret = process.env.LIVEKIT_SECRET || '4a44ccb2ecf365ca30b4a841ff8b0096fb628690d1beeda586d11808579b7dae';
      const wsUrl = process.env.LIVEKIT_URL || 'wss://livekit.te.kg';

      // Build LiveKit AccessToken JWT manually
      const { createHmac } = await import('crypto');

      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: apiKey,
        sub: identity,
        iat: now,
        exp: now + 3600, // 1 hour
        name,
        video: {
          roomJoin: true,
          room,
          canPublish: true,
          canSubscribe: true,
          canPublishData: true,
        },
      };
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const sigInput = `${header}.${payload}`;
      const sig = createHmac('sha256', secret).update(sigInput).digest('base64url');
      const token = `${sigInput}.${sig}`;

      res.writeHead(200, _H);
      return res.end(JSON.stringify({ token, wsUrl, room, identity }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // ── LiveKit Config ──────────────────────────────────────────────────────────
  if (url === '/api/livekit/config' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    res.writeHead(200, _H);
    return res.end(JSON.stringify({
      wsUrl: process.env.LIVEKIT_URL || 'wss://livekit.te.kg',
      apiKey: process.env.LIVEKIT_API_KEY || 'asystem-livekit-8e293b79',
    }));
  }

  // GET /api/livekit/context — live context for Voice RAG
  if (url === '/api/livekit/context' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      // Fetch tasks + agents in parallel
      const [tasksRes, agentsData] = await Promise.allSettled([
        fetch('https://expert-dachshund-299.convex.cloud/api/query', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: 'tasks:list', args: { status: 'in_progress' } }),
          signal: AbortSignal.timeout(4000),
        }).then(r => r.json()),
        fetchAgentStatus(),
      ]);
      const inProgress = (tasksRes.status === 'fulfilled' ? (tasksRes.value?.value || tasksRes.value?.result || []) : []).slice(0, 8);
      const agents = agentsData.status === 'fulfilled' ? (agentsData.value?.agents || []) : [];
      const onlineAgents = agents.filter(a => a.online).map(a => a.name || a.id);
      const offlineAgents = agents.filter(a => !a.online).map(a => a.name || a.id);

      // Build context text for LLM
      let ctx = `=== ASYSTEM Live Context (${new Date().toLocaleString('ru', { timeZone: 'Asia/Bishkek' })}) ===\n`;
      ctx += `\nАгенты онлайн: ${onlineAgents.join(', ') || 'нет'}`;
      ctx += `\nАгенты офлайн: ${offlineAgents.join(', ') || 'нет'}`;
      ctx += `\n\nАктивные задачи (${inProgress.length}):`;
      if (inProgress.length === 0) {
        ctx += ' нет активных задач';
      } else {
        for (const t of inProgress) {
          ctx += `\n- [${t.agent || 'unassigned'}] ${t.title || '?'} (${t.priority || 'medium'})`;
        }
      }

      // Also fetch recent done tasks
      try {
        const doneRes = await fetch('https://expert-dachshund-299.convex.cloud/api/query', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: 'tasks:list', args: { status: 'done' } }),
          signal: AbortSignal.timeout(3000),
        });
        const doneData = await doneRes.json();
        const recent = (doneData?.value || doneData?.result || []).slice(-5);
        if (recent.length) {
          ctx += `\n\nПоследние выполненные задачи:`;
          for (const t of recent) ctx += `\n- [${t.agent || '?'}] ${t.title || '?'}`;
        }
      } catch {}

      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, context: ctx, onlineAgents, offlineAgents, activeTasks: inProgress.length }));
    } catch (e) {
      res.writeHead(500, _H);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── Costs Today ────────────────────────────────────────────────────────────
  if (url === '/api/costs/today' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const today = new Date().toISOString().split('T')[0];
      const costsPath = path.join(USER_HOME_DIR, '.openclaw/workspace/costs-today.json');
      let costs = { date: today, total: 0, by_agent: {}, entries: 0 };
      try { const d = JSON.parse(fs.readFileSync(costsPath, 'utf8')); if (d.date === today) costs = d; } catch {}
      try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFA = promisify(execFile);
        const logPath = path.join(USER_HOME_DIR, '.openclaw/workspace/audit-log.jsonl');
        const { stdout } = await execFA('tail', ['-n', '300', logPath], { timeout: 3000 });
        let counted = 0;
        for (const line of stdout.split('\n').filter(Boolean)) {
          try {
            const e = JSON.parse(line);
            const eDate = new Date(e.ts).toISOString().split('T')[0];
            if (eDate === today && e.type === 'task.complete' && e.cost_usd) {
              costs.total += parseFloat(e.cost_usd);
              costs.by_agent[e.actor] = (costs.by_agent[e.actor] || 0) + parseFloat(e.cost_usd);
              counted++;
            }
          } catch {}
        }
        costs.entries = counted;
      } catch {}
      res.writeHead(200, _H);
      return res.end(JSON.stringify(costs));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // ── Cost Guard ─────────────────────────────────────────────────────────────
  if (url === '/api/costs/guard' && req.method === 'GET') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const DAILY_LIMIT = parseFloat(process.env.DAILY_COST_LIMIT || '10');
      let todaySpend = 0;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(USER_HOME_DIR, '.openclaw/workspace/costs-today.json'), 'utf8'));
        if (d.date === new Date().toISOString().split('T')[0]) todaySpend = d.total || 0;
      } catch {}
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: todaySpend < DAILY_LIMIT, todaySpend: +todaySpend.toFixed(4), limit: DAILY_LIMIT, remaining: +Math.max(0, DAILY_LIMIT - todaySpend).toFixed(4) }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  if (url === '/api/deploy/panel' && req.method === 'POST') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const { exec: execCb } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(execCb);
      res.writeHead(200, _H);
      res.end(JSON.stringify({ ok: true, message: 'Deploy pipeline started', ts: Date.now() }));
      // Async — не блокируем ответ
      (async () => {
        const panelDir = `${USER_HOME_DIR}/projects/ASYSTEM/panel`;
        const apiDir = `${USER_HOME_DIR}/projects/ASYSTEM/api`;
        try {
          console.log('[DEPLOY] git pull...');
          await execAsync('git pull --ff-only', { cwd: `${USER_HOME_DIR}/projects/ASYSTEM`, timeout: 30000 });
          console.log('[DEPLOY] pnpm build...');
          await execAsync('pnpm build', { cwd: panelDir, timeout: 180000 });
          console.log('[DEPLOY] rsync...');
          await execAsync(`rsync -avz --delete ${panelDir}/dist/ root@135.181.112.60:/var/www/os.asystem.kg/`, { timeout: 60000 });
          console.log('[DEPLOY] ✅ Done');
          // Notify squad (via Convex)
          await fetch('https://expert-dachshund-299.convex.cloud/api/mutation', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ path: 'chat:send', args: { agent: 'forge', message: '✅ Auto-deploy completed: Panel deployed to os.asystem.kg', tags: ['deploy','auto'] } }),
          }).catch(() => {});
        } catch (err) {
          console.error('[DEPLOY] ❌', err.message);
        }
      })();
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // ── Task Complete Callback — agent self-reports result ───────────────────
  // POST /api/tasks/:id/complete  { result, agent, duration_ms? }
  if (req.method === 'POST' && url.match(/^\/api\/tasks\/[^/]+\/complete$/)) {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const taskId = url.split('/')[3];
    const chunks = []; req.on('data', c => chunks.push(c));
    await new Promise(r => req.on('end', r));
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    const { result = '', agent = 'unknown', duration_ms = 0, status = 'done',
            model = null, retry_count = 0, original_body = '', title: taskTitle = '',
            // Symphony proof-of-work fields
            ci_status = null,        // 'pass' | 'fail' | null
            summary = null,          // one-sentence what was done
            files_changed = null,    // array or count
            complexity_score = null, // 0-10 how complex was the task
            pr_url = null,           // PR link if applicable
          } = body;

    try {
      // 1. Update Convex task status
      const _CX = 'https://expert-dachshund-299.convex.cloud';
      const convexResp = await fetch(`${_CX}/api/mutation`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'tasks:updateStatus', args: { id: taskId, status } }),
      });
      const cd = await convexResp.json().catch(() => ({}));

      // 2. Save result to ReMe memory
      if (result) {
        const snippet = result.slice(0, 400);
        fetch('http://localhost:5190/api/memory/reme/add', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `Task ${taskId} completed by ${agent}: ${snippet}` }),
        }).catch(() => {});
      }

      // 2b. Stripe Blueprint: deterministic post-steps (lint/test) for ORGON tasks
      if (result && status === 'done' && agent && ['bekzat', 'ainura', 'orgon-bekzat', 'orgon-ainura'].includes(agent)) {
        (async () => {
          try {
            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const ef = promisify(execFile);
            const orgonDir = path.join(os.homedir(), 'projects/ORGONASYSTEM');
            let ciPassed = true;
            let ciLog = '';

            // Bekzat → ruff lint backend
            if (['bekzat','orgon-bekzat'].includes(agent)) {
              try {
                const { stdout } = await ef('bash', ['-c', `cd ${orgonDir} && source venv/bin/activate 2>/dev/null && ruff check backend/ --select=E,F --quiet 2>&1 || true`], { timeout: 20000 });
                ciLog = stdout.trim() || 'ruff: ok';
                if (/error|Error/i.test(stdout) && stdout.trim().length > 0) ciPassed = false;
              } catch { ciLog = 'ruff: skipped (venv missing)'; }
            }

            // Ainura → eslint frontend
            if (['ainura','orgon-ainura'].includes(agent)) {
              try {
                const { stdout } = await ef('bash', ['-c', `cd ${orgonDir}/frontend && npm run lint 2>&1 | tail -5`], { timeout: 30000 });
                ciLog = stdout.trim() || 'eslint: ok';
                if (/error/i.test(stdout) && !/0 error/i.test(stdout)) ciPassed = false;
              } catch { ciLog = 'eslint: skipped'; }
            }

            console.log(`[Blueprint] ${agent} CI: ${ciPassed ? '✅' : '❌'} | ${ciLog.slice(0,100)}`);

            // Update proof-of-work ci_status in audit log (append)
            const auditPath = path.join(os.homedir(), '.openclaw/workspace/audit-log.jsonl');
            const bpEntry = { ts: Date.now(), type: 'blueprint.ci', actor: agent, taskId, ci_passed: ciPassed, ci_log: ciLog.slice(0,200) };
            fs.appendFileSync(auditPath, JSON.stringify(bpEntry) + '\n');

            // BlackBox pattern: "Call you when done" — auto-PR if CI passed
            if (ciPassed) {
              try {
                const branchName = `agent/${agent}/${taskId.slice(0,8)}-${Date.now().toString(36)}`;
                const prTitle = `[${agent}] ${(title||'Task').slice(0,72)}`;
                const prBody = [
                  `## Auto-PR by ${agent} 🤖`,
                  `**Task:** ${title || taskId}`,
                  `**Agent:** ${agent}`,
                  `**CI:** ✅ ${['bekzat','orgon-bekzat'].includes(agent) ? 'ruff' : 'eslint'} passed`,
                  `**Task ID:** \`${taskId}\``,
                  ``,
                  `### Result`,
                  (result || '').slice(0, 500),
                  ``,
                  `> Auto-generated by ASYSTEM Blueprint CI (Stripe pattern)`,
                ].join('\n');

                // git add + commit + push + PR (ORGON repo)
                const gitCmd = [
                  `cd ${orgonDir}`,
                  `git checkout -b "${branchName}" 2>/dev/null || git checkout "${branchName}"`,
                  `git add -A`,
                  `git diff --cached --quiet && echo "no_changes" || git commit -m "${prTitle.replace(/"/g, "'")}"`,
                  `git push origin "${branchName}" 2>&1`,
                  `gh pr create --title "${prTitle.replace(/"/g, "'")}" --body "${prBody.replace(/"/g, "'").replace(/\n/g, '\\n').slice(0,1000)}" --head "${branchName}" 2>&1 | tail -3`,
                ].join(' && ');

                const { stdout: prOut } = await ef('bash', ['-c', gitCmd], { timeout: 45000, env: process.env });

                if (prOut.includes('no_changes')) {
                  console.log(`[Auto-PR] No file changes to commit for ${agent}/${taskId}`);
                } else if (prOut.includes('github.com') || prOut.includes('pull/')) {
                  const prUrl = prOut.match(/https:\/\/github\.com[^\s]+/)?.[0] || '';
                  console.log(`[Auto-PR] ✅ PR created: ${prUrl}`);
                  // Notify Урмат via Telegram-style Convex message
                  fetch('https://expert-dachshund-299.convex.cloud/api/mutation', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: 'chat:send', args: {
                      agent, message: `🔀 Auto-PR создан!\n**${prTitle}**\n${prUrl}\nCI ✅ | task: ${taskId}`, tags: ['pr', 'auto', agent],
                    }}),
                  }).catch(() => {});
                  fs.appendFileSync(auditPath, JSON.stringify({ ts: Date.now(), type: 'auto.pr', actor: agent, taskId, pr_url: prUrl, branch: branchName }) + '\n');
                } else {
                  console.log(`[Auto-PR] git output: ${prOut.slice(0, 200)}`);
                }
              } catch (prErr) {
                console.warn('[Auto-PR] PR creation failed (non-fatal):', prErr.message.slice(0,100));
              }
            }
          } catch (e) {
            console.warn('[Blueprint] CI step error (non-fatal):', e.message);
          }
        })();
      }

      // 2b1. Checkpoint: clear on task completion (done or failed)
      if (taskId) {
        (async () => {
          try {
            const { clearCheckpoint } = await import('./checkpoint.mjs');
            clearCheckpoint(taskId);
          } catch {}
        })();
      }

      // 2b2. Dead Letter Queue + Autonomous Triage (Mirantis pattern)
      if (status === 'failed' || status === 'error') {
        (async () => {
          try {
            const { recordFailure } = await import('./dlq.mjs');
            const decision = recordFailure({
              taskId, title, agent: agentId || 'unknown',
              error: result || 'task failed', body: desc,
            });
            if (decision.action === 'dead') {
              console.log(`[DLQ] ☠️ ${taskId} → DLQ. Running autonomous triage...`);
              // Autonomous triage — decide what to do without human
              const { triageFailedTask } = await import('./triage-agent.mjs');
              const triage = await triageFailedTask({
                taskId, title, body: desc,
                errorMsg: result || 'task failed',
                attemptCount: decision.retries || 3,
                currentAgent: agentId || 'forge',
              });
              // Only notify human if triage says escalate
              if (triage.action === 'escalate') {
                fetch('https://expert-dachshund-299.convex.cloud/api/mutation', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ path: 'chat:send', args: {
                    agent: agentId || 'system',
                    message: `☠️ DLQ escalate: "${title || taskId}" needs human review\nReason: ${triage.reasoning}\n/api/tasks/dlq`,
                    tags: ['dlq', 'alert', 'needs-human'],
                  }}),
                }).catch(() => {});
              } else {
                console.log(`[Triage] Auto-handled: ${triage.action} → ${triage.targetAgent}`);
              }
            } else if (decision.action === 'retry') {
              const mins = Math.round(decision.delayMs / 60000);
              console.log(`[DLQ] Retry #${decision.retries} для ${taskId} через ${mins}мин`);
            }
          } catch (e) { console.warn('[DLQ] recordFailure error (non-fatal):', e.message); }
        })();
      }

      // 2b0-journal. Write journal entry on task done/failed
      if (taskId && (status === 'done' || status === 'failed') && body?.from) {
        (async () => {
          try {
            const { writeEntry } = await import('./agent-journal.mjs');
            writeEntry({ agentId: body.from, type: status === 'done' ? 'completed' : 'failed', title: title || taskData?.title || 'Unknown task', content: result || '', score: body?.score, meta: { priority, durationMs: body?.pipelineMs } });
          } catch {}
        })();
      }

      // 2b0-narrative. Generate task narrative
      if (taskId && status === 'done' && (title || result)) {
        (async () => {
          try {
            const { generateTaskNarrative } = await import('./narrative.mjs');
            generateTaskNarrative({ taskId, agentId: body?.from || 'unknown', title: title || taskData?.title || '', result: result || '', score: body?.score, priority, pipelineMs: body?.pipelineMs });
          } catch {}
        })();
      }

      // 2b0-curriculum. Record curriculum completion
      if (taskId && status === 'done' && body?.from) {
        (async () => {
          try {
            const { recordCompletion, assessComplexity } = await import('./curriculum.mjs');
            const complexity = assessComplexity(title || taskData?.title || '', priority);
            recordCompletion({ agentId: body.from, taskId, score: body?.score, complexity });
          } catch {}
        })();
      }

      // 2b0-model-pin. Record score for version regression check
      if (body?.from && body?.score !== undefined) {
        (async () => { try { const { recordScore } = await import('./model-version-pin.mjs'); recordScore(body.from, body.score); } catch {} })();
      }

      // 2b0-reputation. Update reputation on task outcome
      if (taskId && (status === 'done' || status === 'failed')) {
        (async () => {
          try {
            const { recordEvent } = await import('./reputation.mjs');
            const agentId = body?.from || 'unknown';
            if (status === 'done') {
              const event = `task_done_${priority || 'medium'}`;
              recordEvent({ agentId, event, meta: { taskId, karpathyScore: body?.score } });
              if (body?.score >= 8) recordEvent({ agentId, event: 'karpathy_high', meta: { score: body?.score } });
              else if (body?.score < 5 && body?.score !== undefined) recordEvent({ agentId, event: 'karpathy_low', meta: { score: body?.score } });
            } else {
              recordEvent({ agentId, event: 'task_failed', meta: { taskId } });
            }
          } catch {}
        })();
      }

      // 2b0-ttl. Complete TTL on task done
      if (taskId && status === 'done') { (async () => { try { const { completeTask } = await import('./task-ttl.mjs'); completeTask(taskId); } catch {} })(); }

      // 2b0-ledger. Ledger task completion
      if (taskId && (status === 'done' || status === 'failed')) {
        (async () => { try { const { ledgerEvent } = await import('./immutable-ledger.mjs'); ledgerEvent(`task_${status}`, body?.from || 'system', { taskId, score: body?.score, priority }); } catch {} })();
      }

      // 2b0-confidence. Calibrate confidence on task complete
      if (taskId && status === 'done' && result) {
        (async () => {
          try {
            const { calibrateConfidence } = await import('./confidence.mjs');
            calibrateConfidence({ agentId: body?.from || 'unknown', result, priority: taskData?.priority || 'medium' });
          } catch {}
        })();
      }

      // 2b0-reflect. Reflection Loop (MODE 2: on-action) — post-task lesson extraction
      if (taskId && (status === 'done' || status === 'failed')) {
        (async () => {
          try {
            const { reflectPost } = await import('./reflection.mjs');
            await reflectPost({
              taskId, agentId: body?.from || 'unknown',
              title: taskData?.title || taskId,
              result, status,
            });
          } catch {}
        })();
      }

      // 2b0-anomaly. Anomaly Detector — record completion metrics
      if (taskId && (status === 'done' || status === 'failed')) {
        (async () => {
          try {
            const { recordTaskCompletion } = await import('./anomaly-detector.mjs');
            recordTaskCompletion(body?.from || 'unknown', { status });
          } catch {}
        })();
      }

      // 2b0-schema. Schema Enforcer — validate output structure
      if (taskId && (status === 'done') && result) {
        (async () => {
          try {
            const { validateOutput } = await import('./schema-enforcer.mjs');
            const validation = validateOutput({
              agentId: body?.from || 'unknown',
              title: taskData?.title || '',
              result,
            });
            if (!validation.valid && validation.errors.length > 0) {
              console.warn(`[SchemaEnforcer] ❌ ${body?.from}: ${validation.errors.join('; ')}`);
            }
          } catch {}
        })();
      }

      // 2b0-fsm. FSM transition on task complete/fail
      if (taskId && (status === 'done' || status === 'failed')) {
        (async () => {
          try {
            const { autoTransition } = await import('./fsm.mjs');
            autoTransition(taskId, status === 'done' ? 'completed' : 'failed');
          } catch {}
        })();
      }

      // 2b0-reporter. Agent Reporter — report notable completions
      if (taskId && (status === 'done' || status === 'failed')) {
        (async () => {
          try {
            const { reportTask } = await import('./agent-reporter.mjs');
            await reportTask({
              taskId, agentId: body?.from || 'unknown', title: taskData?.title || taskId,
              status, priority: taskData?.priority || 'medium',
            });
          } catch {}
        })();
      }

      // 2b0-sla. SLA Completion — mark task done in SLA tracker
      if (status === 'done' || status === 'failed') {
        (async () => {
          try { const { completeSLA } = await import('./sla-monitor.mjs'); completeSLA(taskId); } catch {}
        })();
      }

      // 2b0-critic. Self-Critique — review result before storing (pre-submission)
      // Video: "Advanced RAG: Self-Correcting AI Agents" (WnA3hFSTPtI)
      // + "Self-Improving AI Agent: Recursive Skill Learning" (FQsklvKKDfg)
      if (status === 'done' && result && result.length >= 100) {
        try {
          const { reviewBeforeSubmit } = await import('./self-critic.mjs');
          const review = await reviewBeforeSubmit({ agentId: agentId || agent, result, title, priority: body?.priority || 'medium', taskId });
          if (review.revised && review.result) {
            result = review.result; // Use revised result for all downstream hooks
            console.log(`[SelfCritic] Result revised for ${agentId} task "${title?.slice(0,40)}"`);
          }
        } catch {}
      }

      // 2b0-errors. Error Clustering — report failed task to cluster engine
      // Video: "AI Catching Its Own Mistakes" (83ZbIf9WvB0)
      if (status === 'failed' || status === 'error') {
        (async () => {
          try {
            const { reportError } = await import('./error-cluster.mjs');
            await reportError({ agentId: agentId || agent, error: result || 'task failed', context: title, taskId });
          } catch {}
        })();
      }

      // 2b0-validate. Output Validation Contract — check result before storing
      // Video: "Factory AI Validation Contracts" (P3c5UnTuISc)
      if (status === 'done' && result && result.length > 5) {
        (async () => {
          try {
            const { validateOutput } = await import('./output-validator.mjs');
            const validation = validateOutput(agentId || agent, result);
            if (!validation.pass) {
              console.warn(`[Contracts] ${agentId} result failed validation (score=${validation.score}): ${validation.violations.join(' | ')}`);
              // Fire security event if hallucination detected
              if (validation.violations.some(v => v.startsWith('HALLUCINATION'))) {
                const { fireEvent } = await import('./trigger-engine.mjs');
                await fireEvent('security.injection_detected', { source: agentId, pattern: validation.violations[0] });
              }
            }
          } catch {}
        })();
      }

      // 2b0. Event Trigger Engine — fire events based on task completion
      // Video: "Automate AI Coding with Kilo Cloud Agents" (eDJhpdDhgAA)
      (async () => {
        try {
          const { fireEvent } = await import('./trigger-engine.mjs');
          if (status === 'done' && (reqBody?.tags || []).includes('swarm')) {
            const swarmTag = (reqBody?.tags || []).find(t => t?.startsWith?.('swarm:'));
            if (swarmTag) await fireEvent('swarm.done', { swarm_id: swarmTag.split(':')[1], task_title: title, winner: agentId });
          }
        } catch {}
      })();

      // 2b2-cache. Prompt Cache — store result for future dedup
      // Video: "Build Hour: Prompt Caching" (tECAkJAI_Vk)
      if (status === 'done' && result && title) {
        (async () => {
          try {
            const { storeInCache } = await import('./prompt-cache.mjs');
            storeInCache(agentId || agent, title, result, taskId);
          } catch {}
        })();
      }

      // 2b2-kg. Knowledge Graph extraction — extract entity triples from result
      // Video: "Agent Swarms and Knowledge Graphs" (0AKQm4zow_E)
      if (status === 'done' && result && result.length > 50) {
        (async () => {
          try {
            const { extractFromTask } = await import('./knowledge-graph.mjs');
            await extractFromTask({ title, result, agentId: agentId || agent });
          } catch {}
        })();
      }

      // 2b2a. Swarm Fan-in — if task has swarm tag, aggregate results
      if (status === 'done' && result) {
        const swarmTag = (reqBody?.tags || []).find(t => t?.startsWith?.('swarm:'));
        if (swarmTag) {
          const swarmId = swarmTag.split(':')[1];
          (async () => {
            try {
              const { fanIn } = await import('./swarm.mjs');
              await fanIn(swarmId, agentId || agent, result);
            } catch {}
          })();
        }
      }

      // 2b2b. Shared Memory broadcast — store completed task to ZVec (cross-agent)
      if (status === 'done' && result) {
        (async () => {
          try {
            const { broadcastToSharedMemory } = await import('./shared-memory.mjs');
            await broadcastToSharedMemory({ agent: agentId, taskId, title, result, score: null });
          } catch {}
        })();
      }

      // 2b3. Living Context Doc — update ORGONASYSTEM/CONTEXT.md (ORGON agents only)
      const _orgonAgents = ['bekzat', 'orgon-bekzat', 'ainura', 'orgon-ainura'];
      if (status === 'done' && _orgonAgents.includes(agentId)) {
        (async () => {
          try {
            const { appendTaskToContext } = await import('./living-context.mjs');
            await appendTaskToContext({
              taskId, title, agent: agentId, result,
              ciPassed: null, // CI result injected by Blueprint block earlier
            });
          } catch (e) { console.warn('[LivingContext] non-fatal:', e.message); }
        })();
      }

      // 2c. Karpathy Loop — Quality Judge (async, non-blocking)
      if (result && status === 'done') {
        (async () => {
          try {
            const { judgeTask } = await import('./quality-judge.mjs');
            const judgment = await judgeTask({
              taskId, title: taskTitle || taskId, result,
              agent, model, retryCount: retry_count, originalBody: original_body,
            });
            console.log(`[KarpathyLoop] ${taskId} → action=${judgment.action} score=${judgment.score}`);

            // Eureka Self-Reward Loop — update agent skill based on score change
            // Video: "AI Agentic System Design Fundamentals 2026" (8ZXyxY0UtDQ)
            if (judgment.score !== undefined) {
              (async () => {
                try {
                  const { processEurekaLoop } = await import('./self-improver.mjs');
                  await processEurekaLoop({
                    agentId: agent, taskId, taskTitle: taskTitle || title,
                    taskResult: result, score: judgment.score, feedback: judgment.feedback,
                  });
                } catch {}
              })();
            }

            if (judgment.action === 'retry') {
              // Context Handoff: create compressed handoff packet before re-dispatch
              (async () => {
                try {
                  const { createHandoff } = await import('./context-handoff.mjs');
                  await createHandoff({ fromAgent: agent, toAgent: agent, taskId, lastResult: result, title: taskTitle || title });
                } catch {}
              })();
              // Re-dispatch with enriched context
              await fetch('http://localhost:5190/api/dispatch', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  to: agent, title: taskTitle || taskId,
                  body: judgment.enrichedBody,
                  priority: 'high',
                  tags: ['karpathy-retry', `retry-${judgment.retryCount}`],
                  source: 'quality-judge',
                  retry_count: judgment.retryCount,
                  original_body: original_body || result,
                }),
              }).catch(e => console.warn('[KarpathyLoop] re-dispatch failed:', e.message));

            } else if (judgment.action === 'escalate') {
              // Error Clustering — report low-quality result as error
              (async () => {
                try {
                  const { reportError } = await import('./error-cluster.mjs');
                  await reportError({ agentId: agent, error: `Low quality: score=${judgment.score}. ${judgment.feedback || ''}`, context: taskTitle || title, taskId });
                } catch {}
              })();

              // Stochastic Consensus — before human escalation, try dual sampling
              // Video: "AI Agents Full Course 2026" (EsTrWCV0Ph4)
              let finalEscalate = true;
              if (body?.priority === 'critical' || (judgment.score !== undefined && judgment.score < 4)) {
                try {
                  const { runConsensus } = await import('./stochastic-consensus.mjs');
                  const consensus = await runConsensus({ taskId, title, body: desc, originalResult: result, agentId: agent });
                  if (!consensus.skipped && consensus.consensus) {
                    // Consensus reached — use best result, don't escalate
                    finalEscalate = false;
                    console.log(`[Consensus] ✅ Agreement reached for ${taskId} — avoided human escalation`);
                    await fetch(`${_CX}/api/mutation`, {
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ path: 'tasks:updateStatus', args: { id: taskId, status: 'done' } }),
                    }).catch(() => {});
                  } else if (!consensus.skipped && consensus.needsHumanReview) {
                    console.warn(`[Consensus] ❌ No consensus for ${taskId} → escalating`);
                  }
                } catch { /* non-fatal */ }
              }
              if (finalEscalate) {
                // Tag task as needs_human_review in Convex
                await fetch(`${_CX}/api/mutation`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ path: 'tasks:updateStatus', args: { id: taskId, status: 'needs_human_review' } }),
                }).catch(() => {});
                console.warn(`[KarpathyLoop] ⚠️ ${taskId} escalated — score=${judgment.score}, feedback=${judgment.feedback}`);
              }
            }
          } catch (e) {
            console.warn('[KarpathyLoop] error (non-fatal):', e.message);
          }
        })();
      }

      // 3. Audit log (with Symphony proof-of-work)
      const pow = { ci_status, summary, files_changed, complexity_score, pr_url };
      const entry = { ts: Date.now(), type: 'task.complete', actor: agent, taskId, status, result: result.slice(0, 300), duration_ms,
                      proof_of_work: Object.fromEntries(Object.entries(pow).filter(([,v]) => v != null)) };
      fs.appendFileSync(path.join(USER_HOME_DIR, '.openclaw/workspace/audit-log.jsonl'), JSON.stringify(entry) + '\n');

      // 4. Update costs-today.json if cost provided
      if (body.cost_usd) {
        const costsPath = path.join(USER_HOME_DIR, '.openclaw/workspace/costs-today.json');
        const today = new Date().toISOString().split('T')[0];
        let costs = { date: today, total: 0, by_agent: {} };
        try { const d = JSON.parse(fs.readFileSync(costsPath, 'utf8')); if (d.date === today) costs = d; } catch {}
        costs.total = (costs.total || 0) + parseFloat(body.cost_usd);
        costs.by_agent[agent] = (costs.by_agent[agent] || 0) + parseFloat(body.cost_usd);
        fs.writeFileSync(costsPath, JSON.stringify(costs, null, 2));
      }

      // 5. Emit NATS event
      try {
        const { publishEvent } = await import('./nats-events.mjs');
        await publishEvent('sop.task.completed', { taskId, agent, status, result: result.slice(0,100), duration_ms });
      } catch {}

      console.log(`[task/complete] ${taskId} → ${status} by ${agent} (${duration_ms}ms)`);
      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: cd.status === 'success', taskId, status, convex: cd.status }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

  // ── A2A Webhook — inter-agent result delivery ─────────────────────────────
  // POST /api/a2a/result  { from, to, task_id, result, status, type }
  // Atlas/Iron/Mesa → Forge reporting back completion
  if (req.method === 'POST' && url === '/api/a2a/result') {
    const _H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const chunks = []; req.on('data', c => chunks.push(c));
    await new Promise(r => req.on('end', r));
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    const { from = 'unknown', to = 'forge', task_id, result = '', status = 'done', type = 'task_result' } = body;

    console.log(`[A2A] ${from} → ${to}: ${type} | task:${task_id} | status:${status}`);

    try {
      // 1. If it's a task result — update Convex
      if (task_id && (type === 'task_result' || type === 'complete')) {
        const _CX = 'https://expert-dachshund-299.convex.cloud';
        await fetch(`${_CX}/api/mutation`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: 'tasks:updateStatus', args: { id: task_id, status } }),
        }).catch(() => {});
        // Save to memory
        if (result) {
          await fetch('http://localhost:5190/api/memory/reme/add', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: `A2A: ${from} completed task ${task_id}: ${result.slice(0,300)}` }),
          }).catch(() => {});
        }
      }

      // 2. If it's an assignment from Atlas — create a task for Forge
      if (type === 'assign' && from === 'atlas') {
        const _CX = 'https://expert-dachshund-299.convex.cloud';
        await fetch(`${_CX}/api/mutation`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: 'tasks:create', args: {
            title: body.title || result.slice(0,80),
            description: result,
            agent: to, status: 'todo', priority: body.priority || 'medium', type: 'task',
          }}),
        }).catch(() => {});
      }

      // 3. Audit + NATS
      const entry = { ts: Date.now(), type: 'a2a.result', from, to, task_id, status, result: result.slice(0,200) };
      fs.appendFileSync(path.join(USER_HOME_DIR, '.openclaw/workspace/audit-log.jsonl'), JSON.stringify(entry) + '\n');
      try {
        const { publishEvent } = await import('./nats-events.mjs');
        await publishEvent(`sop.a2a.${from}.${to}`, { task_id, status, result: result.slice(0,100) });
      } catch {}

      res.writeHead(200, _H);
      return res.end(JSON.stringify({ ok: true, processed: type, task_id }));
    } catch (e) { res.writeHead(500, _H); return res.end(JSON.stringify({ error: e.message })); }
  }

// ── Task Approve / Reject ─────────────────────────────────────────────
  // ── Task PATCH (agent lifecycle: start/complete/block) ───────────────────
  if (req.method === 'PATCH' && url.match(/^\/api\/tasks\/[^/]+$/)) {
    const taskId = url.split('/')[3];
    const chunks = []; req.on('data', c => chunks.push(c));
    await new Promise(r => req.on('end', r));
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    const { status, result, agent: agentName } = body;
    if (!status) { res.writeHead(400, H2); return res.end(JSON.stringify({ error: 'status required' })); }
    try {
      // Fix: use Convex cloud mutation directly (convex.site HTTP actions don't exist)
      const _convexCloud = 'https://expert-dachshund-299.convex.cloud';
      const convexResp = await fetch(`${_convexCloud}/api/mutation`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'tasks:updateStatus', args: { id: taskId, status } }),
      }).catch(e => { console.error('[task PATCH convex]', e.message); return null; });
      if (convexResp) {
        const cd = await convexResp.json().catch(() => ({}));
        if (cd.status !== 'success') console.warn('[task PATCH] Convex error:', cd.errorMessage?.slice(0,80));
      }
      const auditEntry = { ts: Date.now(), type: 'task.update', actor: agentName ?? 'system', taskId, status, result: result?.slice?.(0,200) };
      fs.appendFileSync(path.join(USER_HOME_DIR, '.openclaw/workspace/audit-log.jsonl'), JSON.stringify(auditEntry) + '\n');
      res.writeHead(200, H2);
      return res.end(JSON.stringify({ ok: true, taskId, status }));
    } catch(e) { res.writeHead(500, H2); return res.end(JSON.stringify({ error: e.message })); }
  }

  if (req.method === 'POST' && url.match(/^\/api\/tasks\/[^/]+\/(approve|reject)$/)) {
    const parts = url.split('/');
    const taskId = parts[3];
    const action = parts[4];
    const chunks = [];
    req.on('data', c => chunks.push(c));
    await new Promise(r => req.on('end', r));
    const { reason } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    try {
      const newStatus = action === 'approve' ? 'done' : 'blocked';
      const _convexCloud2 = 'https://expert-dachshund-299.convex.cloud';
      await fetch(`${_convexCloud2}/api/mutation`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'tasks:updateStatus', args: { id: taskId, status: newStatus } }),
      }).catch(() => {});
      const auditEntry = { ts: Date.now(), actor:'human', action:`task.${action}`, target:taskId, note:reason||'' };
      fs.appendFileSync(path.join(USER_HOME_DIR,'.openclaw/workspace/audit-log.jsonl'), JSON.stringify(auditEntry)+'\n');
      res.writeHead(200, H2);
      return res.end(JSON.stringify({ ok:true, action, taskId, newStatus }));
    } catch(e) { res.writeHead(500, H2); return res.end(JSON.stringify({ error: e.message })); }
  }

  return false; // not handled
};

// ── Static file server (replaces serve, proper cache headers) ────────
const DIST_DIR = path.join(USER_HOME_DIR, 'projects/ASYSTEM/panel/dist');
const MIME = {
  '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.html': 'text/html; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  const urlPath = req.url?.split('?')[0] ?? '/';
  // Only serve GET/HEAD for static
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  // API calls → skip
  if (urlPath.startsWith('/api/')) return false;
  // BlueMap proxy → skip (handled by originalHandler)
  if (urlPath.startsWith('/bluemap')) return false;

  const filePath = path.join(DIST_DIR, urlPath);
  const ext = path.extname(filePath).toLowerCase();
  const isAssetExt = ['.js','.css','.woff2','.png','.svg','.ico','.json'].includes(ext);

  // If requesting a JS/CSS/font asset that doesn't exist → 404 (do NOT fallback to HTML)
  // This prevents CF from caching index.html for missing chunks
  if (isAssetExt) {
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ error: 'Asset not found', path: urlPath }));
      return true;
    }
    try {
      const data = fs.readFileSync(filePath);
      const mime = MIME[ext] ?? 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': urlPath.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600',
        'Content-Length': data.length,
      });
      res.end(data);
      return true;
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Read error' }));
      return true;
    }
  }

  // GET /bluemap/* — Proxy to BlueMap on VM 105 via Tailscale (dead code — caught by early return above)
  if (false && urlPath.startsWith('/bluemap')) {
    const bmPath = url.replace('/bluemap', '') || '/';
    // Use raw net socket to fully control HTTP/1.0 request
    const bmSocket = net.createConnection({ host: '100.79.117.102', port: 8124, timeout: 30000 });
    let headersDone = false;
    let buffer = Buffer.alloc(0);
    
    bmSocket.on('connect', () => {
      console.log('[BlueMap] Connected, requesting:', bmPath || '/');
      const reqLine = `GET ${bmPath || '/'} HTTP/1.0\r\n`;
      const hdrs = `Host: 100.79.117.102:8124\r\nConnection: close\r\nAccept: */*\r\nAccept-Encoding: identity\r\n\r\n`;
      bmSocket.write(reqLine + hdrs);
    });
    
    bmSocket.on('data', chunk => {
      console.log('[BlueMap] Got chunk:', chunk.length, 'headersDone:', headersDone);
      buffer = Buffer.concat([buffer, chunk]);
      if (!headersDone) {
        const sep = buffer.indexOf('\r\n\r\n');
        if (sep === -1) return;
        headersDone = true;
        const headerStr = buffer.slice(0, sep).toString();
        const body = buffer.slice(sep + 4);
        buffer = Buffer.alloc(0);
        
        // Parse status
        const statusMatch = headerStr.match(/HTTP\/[\d.]+ (\d+)/);
        const statusCode = statusMatch ? parseInt(statusMatch[1]) : 200;
        
        // Parse headers
        const headerLines = headerStr.split('\r\n').slice(1);
        const headers = { 'access-control-allow-origin': '*' };
        for (const line of headerLines) {
          const idx = line.indexOf(': ');
          if (idx > 0) {
            const k = line.slice(0, idx).toLowerCase();
            if (!['transfer-encoding','connection'].includes(k)) {
              headers[k] = line.slice(idx + 2);
            }
          }
        }
        
        res.writeHead(statusCode, headers);
        if (body.length > 0) res.write(body);
      } else {
        res.write(chunk);
      }
    });
    
    bmSocket.on('end', () => { try { res.end(); } catch {} });
    bmSocket.on('error', (e) => {
      if (!res.headersSent) { res.writeHead(502); }
      try { res.end('BlueMap error: ' + e.message); } catch {}
    });
    bmSocket.on('timeout', () => { bmSocket.destroy(); try { res.end(); } catch {} });
    req.on('close', () => bmSocket.destroy());
    return;
  }

  // For HTML routes (SPA) → always serve index.html with no-cache
  const indexPath = path.join(DIST_DIR, 'index.html');
  try {
    const data = fs.readFileSync(indexPath);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Content-Length': data.length,
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

// ── Original request handler (extend) ────────────────────────────────
const originalHandler = server.listeners('request')[0];
// ── Panel Auth ─────────────────────────────────────────────────────────
const PANEL_TOKEN_FILE = path.join(USER_HOME_DIR, '.openclaw/workspace/.panel-token');
const PANEL_TOKEN = (() => { try { return fs.readFileSync(PANEL_TOKEN_FILE,'utf8').trim(); } catch { return null; } })();
const AUTH_SESSIONS = new Map(); // sessionId → expiry
const AUTH_SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days (was 24h)
// Deterministic session: hash(PANEL_TOKEN) so sessions survive PM2 restarts
const PANEL_TOKEN_HASH = PANEL_TOKEN ? createHash('sha256').update(PANEL_TOKEN).digest('hex').slice(0, 48) : null;
if (PANEL_TOKEN_HASH) AUTH_SESSIONS.set(PANEL_TOKEN_HASH, Date.now() + AUTH_SESSION_TTL);

function parseCookies(cookieHeader = '') {
  return Object.fromEntries(cookieHeader.split(';').map(c => c.trim().split('=').map(decodeURIComponent)));
}

// OIDC token validation cache (avoid hitting Keycloak on every request)
const OIDC_TOKEN_CACHE = new Map(); // token → { user, expiresAt }
const KC_USERINFO_URL = 'https://sso.asystem.kg/realms/asystem/protocol/openid-connect/userinfo';

async function validateOIDCToken(bearerToken) {
  const cached = OIDC_TOKEN_CACHE.get(bearerToken);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  return new Promise((resolve) => {
    const req = https.request(KC_USERINFO_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${bearerToken}` },
      timeout: 5000,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const user = JSON.parse(d);
          if (user.sub) {
            // Cache valid tokens for 4 min
            OIDC_TOKEN_CACHE.set(bearerToken, { user, expiresAt: Date.now() + 4 * 60 * 1000 });
            resolve(user);
          } else { resolve(null); }
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Periodically clean OIDC cache
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of OIDC_TOKEN_CACHE) { if (v.expiresAt < now) OIDC_TOKEN_CACHE.delete(k); }
}, 5 * 60 * 1000);

async function isAuthenticatedAsync(req) {
  if (!PANEL_TOKEN) return true; // No token → open
  const auth  = req.headers['authorization'] ?? '';
  const xkey  = req.headers['x-panel-token'] ?? '';

  // 1. Legacy panel token
  if (auth === `Bearer ${PANEL_TOKEN}` || xkey === PANEL_TOKEN) return true;

  // 2. OIDC Bearer token (Keycloak)
  if (auth.startsWith('Bearer ') && auth.length > 50) {
    const token = auth.slice(7);
    const user  = await validateOIDCToken(token);
    if (user) return true;
  }

  // 3. Cookie session (legacy + OIDC-established)
  const cookies = parseCookies(req.headers.cookie ?? '');
  const sid = cookies['panel_sid'];
  if (sid && AUTH_SESSIONS.has(sid) && AUTH_SESSIONS.get(sid) > Date.now()) return true;

  return false;
}

function isAuthenticated(req) {
  if (!PANEL_TOKEN) return true;
  const auth = req.headers['authorization'] ?? '';
  if (auth === `Bearer ${PANEL_TOKEN}`) return true;
  const xkey = req.headers['x-panel-token'] ?? '';
  if (xkey === PANEL_TOKEN) return true;
  const cookies = parseCookies(req.headers.cookie ?? '');
  const sid = cookies['panel_sid'];
  if (sid && AUTH_SESSIONS.has(sid) && AUTH_SESSIONS.get(sid) > Date.now()) return true;
  return false;
}

const LOGIN_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ASYSTEM OS — Login</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0f1117;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,sans-serif}
.box{background:#1a1f2e;border:1px solid #1e293b;border-radius:16px;padding:40px;width:360px;text-align:center}
.logo{font-size:24px;font-weight:800;color:#e2e8f0;letter-spacing:-.5px;margin-bottom:6px}
.sub{color:#64748b;font-size:13px;margin-bottom:32px}
input{width:100%;padding:12px 16px;background:#0f1117;border:1px solid #1e293b;border-radius:8px;color:#e2e8f0;font-size:14px;outline:none;margin-bottom:12px}
input:focus{border-color:#06b6d4}
button{width:100%;padding:12px;background:#06b6d4;border:none;border-radius:8px;color:#0f1117;font-weight:700;font-size:14px;cursor:pointer}
button:hover{background:#0891b2}.err{color:#ef4444;font-size:12px;margin-top:8px;min-height:16px}
</style></head><body>
<div class="box">
  <div class="logo">ASYSTEM OS</div>
  <div class="sub">Command Center · v2.0</div>
  <form method="POST" action="/auth/login">
    <input type="password" name="token" placeholder="Access token" autofocus autocomplete="current-password"/>
    <button type="submit">Enter</button>
    <div class="err">{{ERROR}}</div>
  </form>
</div></body></html>`;

server.removeAllListeners('request');
server.on('request', async (req, res) => {
  const origin = req.headers.origin ?? '';
  // Allow credentials for panel origins; wildcard for API clients
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization, x-panel-token');
  if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

  const urlPath = (req.url ?? '/').split('?')[0];

  // ── Auth endpoints (always public) ──
  if (urlPath === '/auth/login' && req.method === 'POST') {
    const chunks = []; req.on('data', c => chunks.push(c));
    await new Promise(r => req.on('end', r));
    const body = Buffer.concat(chunks).toString();
    const token = new URLSearchParams(body).get('token') ?? '';
    if (PANEL_TOKEN && token === PANEL_TOKEN) {
      const sid = randomBytes(24).toString('hex');
      AUTH_SESSIONS.set(sid, Date.now() + AUTH_SESSION_TTL);
      res.writeHead(302, {
        'Set-Cookie': `panel_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
        'Location': '/',
      });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(LOGIN_PAGE.replace('{{ERROR}}', 'Неверный токен'));
  }

  if (urlPath === '/auth/logout') {
    const cookies = parseCookies(req.headers.cookie ?? '');
    if (cookies['panel_sid']) AUTH_SESSIONS.delete(cookies['panel_sid']);
    res.writeHead(302, {
      'Set-Cookie': 'panel_sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'Location': '/auth/login',
    });
    return res.end();
  }

  // Health + auth status always public
  if (urlPath === '/health' || urlPath === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()) }));
  }

  // /api/auth/* — always public, handle inline before auth gate
  if (urlPath === '/api/auth/status') {
    const cookies = parseCookies(req.headers.cookie ?? '');
    const sid = cookies['panel_sid'];
    const authed = !PANEL_TOKEN || (sid && AUTH_SESSIONS.has(sid) && AUTH_SESSIONS.get(sid) > Date.now());
    const org = req.headers.origin ?? '*';
    res.writeHead(200, { 'Content-Type':'application/json','Access-Control-Allow-Origin':org,'Access-Control-Allow-Credentials':'true','Cache-Control':'no-store' });
    return res.end(JSON.stringify({ authenticated: !!authed, hasAuth: !!PANEL_TOKEN }));
  }
  if (urlPath === '/api/auth/login' && req.method === 'POST') {
    const chunks = []; req.on('data', c => chunks.push(c));
    await new Promise(r => req.on('end', r));
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const org = req.headers.origin ?? '*';
      if (PANEL_TOKEN && body.token === PANEL_TOKEN) {
        const sid = PANEL_TOKEN_HASH || randomBytes(24).toString('hex');
        AUTH_SESSIONS.set(sid, Date.now() + AUTH_SESSION_TTL);
        res.writeHead(200, { 'Content-Type':'application/json','Access-Control-Allow-Origin':org,'Access-Control-Allow-Credentials':'true',
          'Set-Cookie':`panel_sid=${sid}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=86400` });
        return res.end(JSON.stringify({ ok: true }));
      }
      res.writeHead(401, { 'Content-Type':'application/json','Access-Control-Allow-Origin':org,'Access-Control-Allow-Credentials':'true' });
      return res.end(JSON.stringify({ error: 'Invalid token' }));
    } catch(e) { console.error('[auth/login] catch:', e.message); res.writeHead(400); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (urlPath === '/api/auth/logout') {
    const cookies = parseCookies(req.headers.cookie ?? '');
    if (cookies['panel_sid']) AUTH_SESSIONS.delete(cookies['panel_sid']);
    const org = req.headers.origin ?? '*';
    res.writeHead(200, { 'Content-Type':'application/json','Access-Control-Allow-Origin':org,'Access-Control-Allow-Credentials':'true',
      'Set-Cookie':'panel_sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // ── Public API endpoints (no auth needed) ──
  // Convex HTTP actions call these from server-side
  const PUBLIC_PREFIXES = [
    '/api/proxmox/', '/api/tailscale/', '/api/agents', '/api/cloudflare/', '/api/network/', '/api/narrative/', '/api/state/', '/api/sync/',
    '/api/embeddings/', '/api/embeddings-ml/', '/api/traces/', '/api/reflection/', '/api/compression/', '/api/learning/', '/api/confidence/', '/api/recovery/', '/api/graph/', '/api/anomalies/', '/api/analytics/',
    '/api/tailscale/device/', '/api/tailscale/routes/', '/api/host/metrics', '/api/netdata/',
    '/api/intel/', '/api/analytics/', '/api/cfo/', '/api/sprints/',
    '/api/health', '/api/seeds/', '/api/settings', '/api/feed',
    '/api/budget/', '/api/knowledge', '/api/audit/', '/api/squad', '/api/timeline/',
    '/api/dispatch', '/api/chat/', '/api/terminal', '/api/digest', '/api/costs/forecast', '/api/memory/', '/api/inbox', '/api/swarms', '/api/logs', '/api/logs/stream', '/api/search',
    '/api/issues', '/api/meta/', '/api/veritas', '/api/alerts', '/api/prompts',
    '/api/memory/files', '/api/memory/consolidate', '/api/git/activity', '/api/sos/', '/api/costs/', '/api/costs/agents',
    '/api/tasks/', '/api/deploy/', '/api/braindump', '/api/livekit/', '/api/dashboard/', '/api/state', '/api/git/workflow', '/api/costs/guard', '/api/projects', '/api/webhook/', '/api/a2a/', '/api/agents/metrics',
    '/api/standup', '/api/anomalies', '/api/health/broadcast', '/api/sop/', '/api/nats/',
    '/api/metrics', '/api/alerts/', '/api/eval/', '/api/context/', '/api/decision-trace', '/api/rate-limits', '/api/memory/shared', '/api/agents/health', '/api/agents/triage', '/api/agents/consensus', '/api/costs/optimizer', '/api/swarm', '/api/goals', '/api/kg/', '/api/agents/self-improver', '/api/cache/', '/api/triggers', '/api/traces', '/api/contracts', '/api/errors', '/api/memory/decay', '/api/skills/', '/api/handoff', '/api/self-critic', '/api/webhook/', '/api/sla', '/api/playbook', '/api/model-router', '/api/context-guard', '/api/fsm', '/api/schema', '/api/debate', '/api/dag', '/api/anomaly', '/api/namespace', '/api/tools', '/api/reflect', '/api/confidence', '/api/budget', '/api/cot', '/api/config', '/api/blast-radius', '/api/throttle', '/api/federated', '/api/canary', '/api/scheduler', '/api/ledger', '/api/context-window', '/api/intent', '/api/ttl', '/api/reputation', '/api/objectives', '/api/narrative', '/api/curriculum', '/api/roles', '/api/model-pin', '/api/batch', '/api/hmem', '/api/agent-ops', '/api/registry', '/api/migrate', '/api/verify', '/api/chaos', '/api/distill', '/api/social', '/api/prompt', '/api/journal', '/api/pipeline', '/api/reward', '/api/queue', '/api/speculative', '/api/contract', '/api/vmem', '/api/coalition', '/api/dedup', '/api/doc', '/api/rep', '/api/suggest', '/api/time', '/api/persona', '/api/sample', '/api/wb', '/api/deps', '/api/rollup', '/api/workload', '/api/durable', '/api/shadow', '/api/goal', '/api/router', '/api/heal', '/api/trust', '/api/ctx', '/api/mscore', '/api/stream', '/api/planval', '/api/handoff', '/api/speccache', '/api/narrative', '/api/roles', '/api/model-pin', '/api/batch', '/api/hmem', '/api/agent-ops', '/api/registry', '/api/migrate', '/api/verify', '/api/chaos', '/api/distill', '/api/social', '/api/prompt', '/api/journal', '/api/pipeline', '/api/reward', '/api/queue', '/api/speculative', '/api/contract', '/api/vmem', '/api/coalition', '/api/dedup', '/api/doc', '/api/rep', '/api/suggest', '/api/time', '/api/persona', '/api/sample', '/api/wb', '/api/deps', '/api/rollup', '/api/workload', '/api/durable', '/api/shadow', '/api/goal', '/api/router', '/api/heal', '/api/trust', '/api/ctx', '/api/mscore', '/api/stream', '/api/planval', '/api/handoff', '/api/speccache', '/api/narrative',
    '/api/mc', '/api/mc/event', '/api/mc/events', '/api/visual-insights', '/api/test-results', '/api/docs', '/api/ai-assist', '/api/agent-manifests', '/api/security', '/api/optimization/',
    '/ops',
  ];
  if (PUBLIC_PREFIXES.some(p => urlPath.startsWith(p))) {
    // fall through to handlers below
  } else if (PANEL_TOKEN && !(await isAuthenticatedAsync(req))) {
    // Static assets and SPA routes → always serve (auth handled by React AuthGate/OIDC)
    const ext = path.extname(urlPath).toLowerCase();
    const isStaticAsset = ['.js','.css','.woff2','.png','.svg','.ico','.json','.webp','.ttf'].includes(ext);
    const isSpaRoute = !urlPath.startsWith('/api/') && !urlPath.startsWith('/auth/');
    if (isStaticAsset || isSpaRoute) {
      // Fall through — let serveStatic handle it
    } else if (urlPath.startsWith('/api/')) {
      // API calls → 401 JSON (React app handles redirect to login)
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="ASYSTEM Panel"' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
  }

  // Try v2 endpoints first
  const handled = await handleV2(req, res).catch(e => { console.error("[handleV2 error]", req.url, e.message); return false; });
  if (handled !== false) return;

  // Serve static panel files with proper cache headers
  if (serveStatic(req, res)) return;

  // Fall through to original handler
  originalHandler(req, res);
});

// ── WebSocket upgrade handler — proxy /ws/veritas to Veritas WS ──────
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws/veritas') {
    // Proxy to Veritas Kanban WS server
    const target = 'ws://localhost:3002';
    const ws_target = new URL(target);
    const proxyReq = http.request({
      host: ws_target.hostname,
      port: ws_target.port || 3002,
      path: '/ws',
      method: 'GET',
      headers: {
        ...req.headers,
        host: `localhost:3002`,
        'x-api-key': VERITAS_ADMIN_KEY,
      },
    });
    // Use raw TCP proxy for WS upgrade
    const upstream = net.connect(3002, 'localhost', () => {
      const upgradeReq = [
        `GET /ws HTTP/1.1`,
        `Host: localhost:3002`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: ${req.headers['sec-websocket-key'] || 'dGhlIHNhbXBsZSBub25jZQ=='}`,
        `Sec-WebSocket-Version: ${req.headers['sec-websocket-version'] || '13'}`,
        `x-api-key: ${VERITAS_ADMIN_KEY}`,
        '',
        '',
      ].join('\r\n');
      upstream.write(upgradeReq);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    return;
  }
  // Default WS upgrade (agent status WS)
  wss?.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// ── Heartbeat Scanner — pings agents via gateway, updates Convex ──────────
const HEARTBEAT_AGENTS = [
  { id: 'forge',  ip: '100.87.107.50' },
  { id: 'atlas',  ip: '100.68.144.79' },
  { id: 'iron',   ip: '100.114.136.87' },
  { id: 'mesa',   ip: '100.100.40.27' },
  { id: 'pixel',  ip: '100.99.197.46' },
  { id: 'titan',  ip: '100.79.35.34' },
  { id: 'dana',   ip: '100.114.5.104' },
  { id: 'nurlan', ip: '100.83.188.95' },
  { id: 'bekzat', ip: '100.66.219.32' },
  { id: 'ainura', ip: '100.112.184.63' },
  { id: 'marat',  ip: '100.107.171.121' },
];

async function runHeartbeatScan() {
  const CONVEX_URL = 'https://expert-dachshund-299.convex.site';
  const results = await Promise.allSettled(
    HEARTBEAT_AGENTS.map(async (agent) => {
      let online = false;
      try {
        // For self (forge), check localhost since gateway binds to loopback
        const ip = agent.id === 'forge' ? '127.0.0.1' : agent.ip;
        const r = await fetch(`http://${ip}:18789/`, { signal: AbortSignal.timeout(2500) });
        online = r.ok || r.status === 401 || r.status === 403; // 401/403 = gateway alive but auth needed
      } catch { online = false; }

      // Update Convex
      try {
        await fetch(`${CONVEX_URL}/agent/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: agent.id, online }),
          signal: AbortSignal.timeout(3000),
        });
      } catch {}
      return { id: agent.id, online };
    })
  );
  const summary = results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
  const onlineCount = summary.filter(a => a?.online).length;
  console.log(`[heartbeat] ${onlineCount}/${summary.length} agents online`);
  return summary;
}

// ── Telegram alert helper ─────────────────────────────────────────────────
async function sendTelegramAlert(text) {
  try {
    const GW_TOKEN = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(USER_HOME_DIR, '.openclaw/openclaw.json'), 'utf8'))?.gateway?.auth?.token; } catch { return null; }
    })();
    if (!GW_TOKEN) return;
    await fetch('http://127.0.0.1:18789/api/telegram/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GW_TOKEN}` },
      body: JSON.stringify({ text, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) { console.warn('[tg-alert]', e.message); }
}

// ── Alert checker — blocked tasks + offline agents → Telegram notify ──────
const alertedSet = new Set(); // Prevent duplicate alerts within restart cycle

async function runAlertCheck() {
  const CONVEX_URL = 'https://expert-dachshund-299.convex.site';
  try {
    const tasksRes = await fetch(`${CONVEX_URL}/agent/tasks/list`, { signal: AbortSignal.timeout(5000) });
    const tasksData = await tasksRes.json();
    const tasks = tasksData.tasks ?? [];

    // Check blocked tasks
    const blocked = tasks.filter(t => t.status === 'blocked');
    for (const t of blocked) {
      const key = `blocked:${t._id}`;
      if (alertedSet.has(key)) continue;
      alertedSet.add(key);
      console.log(`[alert] Blocked task: ${t.title} (${t.agent})`);
      // Send Telegram alert
      sendTelegramAlert(`⛔ *Blocked Task*\n*${t.title}*\nAgent: ${t.agent ?? 'unassigned'}\nID: \`${t._id}\``).catch(() => {});
    }

    // Check agents that went offline (from heartbeat results)
    const agentsRes = await fetch(`${CONVEX_URL}/agents/org`, { signal: AbortSignal.timeout(5000) });
    const agentsData = await agentsRes.json();
    const agents = agentsData.agents ?? [];
    const now = Date.now();
    const OFFLINE_THRESHOLD = 10 * 60 * 1000; // 10min

    for (const a of agents) {
      if (a.agentStatus !== 'real') continue;
      const wasOnline = a.online === true;
      const isStale = a.lastSeen && (now - a.lastSeen) > OFFLINE_THRESHOLD;
      if (wasOnline && isStale) {
        const key = `offline:${a.id}`;
        if (alertedSet.has(key)) continue;
        alertedSet.add(key);
        console.log(`[alert] Agent ${a.name} went offline (last seen ${Math.round((now - a.lastSeen)/60000)}m ago)`);
        sendTelegramAlert(`🔴 *Agent Offline*\n*${a.name}* (${a.id})\nLast seen: ${Math.round((now - a.lastSeen)/60000)}m ago`).catch(() => {});
      } else if (!isStale && a.online) {
        // Came back online — clear alert
        alertedSet.delete(`offline:${a.id}`);
      }
    }
  } catch (e) { console.warn('[alert-check]', e.message); }
}

// Run heartbeat every 3 minutes, alert check every 5 minutes
setInterval(() => runHeartbeatScan().catch(e => console.warn('[heartbeat err]', e.message)), 30 * 1000);
setInterval(() => runAlertCheck().catch(e => console.warn('[alert err]', e.message)), 5 * 60 * 1000);

// EADDRINUSE self-healing: kill the occupant, retry bind after 2s
server.on('error', async err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[FATAL] Port ${PORT} in use. Killing occupant and retrying...`);
    try {
      const { execSync } = await import('node:child_process');
      // Find PIDs of server.mjs that are NOT this process
      const raw = execSync(
        `ps aux | grep "[s]erver.mjs" | awk '{print $2}'`
      ).toString().trim();
      const pids = raw.split('\n').map(s => s.trim()).filter(p => p && p !== String(process.pid));
      if (pids.length > 0) {
        console.log(`[EADDRINUSE] Killing orphan PIDs: ${pids.join(', ')}`);
        execSync(`kill -9 ${pids.join(' ')}`, { stdio: 'ignore' });
        setTimeout(() => {
          server.listen(PORT, '0.0.0.0', () => {
            console.log(`[ASYSTEM API v2] re-bound on http://0.0.0.0:${PORT} after orphan kill`);
          });
        }, 2000);
      } else {
        console.error('[EADDRINUSE] No orphan found, exiting.');
        process.exit(1);
      }
    } catch (e) {
      console.error('[EADDRINUSE] Self-heal failed:', e.message);
      process.exit(1);
    }
  } else {
    console.error('[server error]', err.message);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ASYSTEM API v2] listening on http://0.0.0.0:${PORT}`);

  // Startup: Anomaly detector — silent agent check every 30 min
  setInterval(async () => {
    try { const { checkSilentAgents } = await import('./anomaly-detector.mjs'); checkSilentAgents(); }
    catch {}
  }, 30 * 60_000);

  // Startup: Agent Reporter — hourly batch flush + daily digest (18:00 UTC+6 = 12:00 UTC)
  setInterval(async () => {
    try { const { flushBatch } = await import('./agent-reporter.mjs'); await flushBatch(); }
    catch {}
  }, 60 * 60_000); // every 1 hour
  // Daily digest check (every 30 min — runs once at 18:00 UTC+6)
  let _digestSentToday = '';
  setInterval(async () => {
    try {
      const now = new Date();
      const utc6Hour = (now.getUTCHours() + 6) % 24;
      const today = now.toISOString().slice(0, 10);
      if (utc6Hour === 18 && _digestSentToday !== today) {
        _digestSentToday = today;
        const { dailyDigest } = await import('./agent-reporter.mjs');
        await dailyDigest();
      }
    } catch {}
  }, 30 * 60_000);

  // Startup: SLA monitor loop (every 2 min)
  setInterval(async () => {
    try { const { checkSLABreaches } = await import('./sla-monitor.mjs'); await checkSLABreaches(); }
    catch {}
  }, 2 * 60_000);

  // Startup: schedule nightly memory decay GC (03:00 UTC+6 = 21:00 UTC)
  const scheduleDecayGC = () => {
    const now = new Date();
    const next = new Date(); next.setUTCHours(21, 0, 0, 0); if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(async () => {
      try { const { gcStaleMemories } = await import('./memory-decay.mjs'); const r = gcStaleMemories(); if (r.length) console.log(`[MemoryDecay] Nightly GC: removed ${r.length} stale memories`); }
      catch {} scheduleDecayGC();
    }, next - now);
  };
  scheduleDecayGC();

  // Startup: seed Knowledge Graph
  (async () => {
    try {
      const { seedInitialKG } = await import('./knowledge-graph.mjs');
      seedInitialKG();
    } catch {}
  })();

  // Startup: initialize default goals (Goal Tracker)
  (async () => {
    try {
      const { initDefaultGoals } = await import('./goal-tracker.mjs');
      initDefaultGoals();
    } catch {}
  })();

  // Startup: recover stale checkpoints
  (async () => {
    try {
      const { recoverStaleCheckpoints } = await import('./checkpoint.mjs');
      const recovered = recoverStaleCheckpoints();
      if (recovered.length > 0) {
        console.log(`[Checkpoint] 🔄 Recovering ${recovered.length} stale task(s) on startup`);
        for (const { taskId, resumePayload } of recovered) {
          try {
            await fetch(`http://localhost:${PORT}/api/dispatch`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(resumePayload), signal: AbortSignal.timeout(5000),
            });
            console.log(`[Checkpoint] ✅ Resumed task ${taskId}`);
          } catch (e) { console.warn(`[Checkpoint] Resume dispatch failed for ${taskId}:`, e.message); }
        }
      }
    } catch (e) { console.warn('[Checkpoint] Startup recovery error (non-fatal):', e.message); }
  })();

  // Initialize WebSocket
  wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    console.log('[WS] Client connected');
    // Send initial agent status
    fetchAgentStatus().then(data => ws.send(JSON.stringify({ type: 'agents', data })));
    ws.on('close', () => console.log('[WS] Client disconnected'));
  });

  // Start polling + inbox watcher
  startPolling();
  watchInbox();
});

// Прогрев кеша при старте
fetchData().then(() => console.log('[ASYSTEM API] cache warm'));
fetchAgentStatus().then(() => console.log('[ASYSTEM API] agent status warm'));

