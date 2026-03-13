/**
 * capability-registry.mjs — Agent Capability Discovery Registry
 *
 * Video: "AI Agents for Data Observability" (neuJfFjSOi0) — Sifflet Sentinel pattern
 * Pattern: Agents advertise their capabilities; other agents discover who can do what
 *          → dynamic routing based on actual declared skills, not static role config
 *
 * Each agent registers a capability manifest:
 *   { agentId, skills: ["backend", "auth", "postgres"], tools: ["code_exec", "file_read"],
 *     languages: ["python", "typescript"], maxConcurrent: 5, availability: "active" }
 *
 * Discovery:
 *   "Who can do auth + typescript?" → semantic match → bekzat (score 0.9)
 *   "Who has code_exec AND is active?" → filter → [bekzat, ainura, nurlan]
 *
 * Heartbeat:
 *   Agents update availability every N minutes (or on dispatch/complete)
 *   Stale > 30min → marked "unavailable"
 *
 * API:
 *   POST /api/registry/advertise   { agentId, skills, tools, languages, maxConcurrent }
 *   POST /api/registry/discover    { skills?, tools?, languages?, availability? } → ranked agents
 *   GET  /api/registry             → full registry
 *   GET  /api/registry/:agentId    → agent capabilities
 *   POST /api/registry/heartbeat   { agentId, availability? } → update last-seen
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME     = os.homedir();
const REG_FILE = path.join(HOME, '.openclaw/workspace/.capability-registry.json');
const REG_LOG  = path.join(HOME, '.openclaw/workspace/registry-log.jsonl');

const STALE_MS = 30 * 60 * 1000; // 30 minutes

// ── Default capability manifests ──────────────────────────────────────────────
const DEFAULT_REGISTRY = {
  forge:   { skills: ['orchestration','coding','media','devops','planning','agent-ops'], tools: ['code_exec','file_read','web_search','git','docker'], languages: ['python','typescript','javascript','bash'], maxConcurrent: 10, tier: 'premium' },
  atlas:   { skills: ['planning','coordination','strategy','architecture','oversight'], tools: ['code_exec','web_search','file_read'], languages: ['python','typescript'], maxConcurrent: 8, tier: 'premium' },
  bekzat:  { skills: ['backend','api','database','auth','websocket','nodejs','postgres'], tools: ['code_exec','file_read','git'], languages: ['typescript','javascript','python'], maxConcurrent: 5, tier: 'standard' },
  ainura:  { skills: ['frontend','react','vue','css','ui','ux','nextjs','vite'], tools: ['code_exec','file_read','git'], languages: ['typescript','javascript'], maxConcurrent: 5, tier: 'standard' },
  marat:   { skills: ['testing','qa','review','security','validation','audit'], tools: ['code_exec','file_read'], languages: ['typescript','python'], maxConcurrent: 4, tier: 'nano' },
  nurlan:  { skills: ['devops','docker','nginx','deployment','infrastructure','pm2'], tools: ['code_exec','file_read','git','docker'], languages: ['bash','python'], maxConcurrent: 4, tier: 'nano' },
  dana:    { skills: ['management','planning','coordination','documentation','communication'], tools: ['file_read','web_search'], languages: ['markdown'], maxConcurrent: 3, tier: 'nano' },
  mesa:    { skills: ['analytics','simulation','data','research','reporting','statistics'], tools: ['code_exec','web_search','file_read'], languages: ['python','r'], maxConcurrent: 5, tier: 'nano' },
  iron:    { skills: ['security','infrastructure','networking','monitoring','vps','tailscale'], tools: ['code_exec','file_read','docker'], languages: ['bash','python'], maxConcurrent: 6, tier: 'standard' },
  pixel:   { skills: ['design','ui','figma','branding','visual','graphics','illustration'], tools: ['file_read'], languages: ['css'], maxConcurrent: 3, tier: 'nano' },
};

// ── Load/save ─────────────────────────────────────────────────────────────────
function load() {
  try {
    const stored = JSON.parse(fs.readFileSync(REG_FILE, 'utf8'));
    return { ...DEFAULT_REGISTRY, ...stored };
  } catch { return { ...DEFAULT_REGISTRY }; }
}
function save(d) { try { fs.writeFileSync(REG_FILE, JSON.stringify(d, null, 2)); } catch {} }

// ── Advertise capabilities ────────────────────────────────────────────────────
export function advertise({ agentId, skills = [], tools = [], languages = [], maxConcurrent, availability = 'active' }) {
  const reg = load();
  const prev = reg[agentId] || {};
  reg[agentId] = {
    ...prev,
    skills:         [...new Set([...(prev.skills || []), ...skills])],
    tools:          [...new Set([...(prev.tools  || []), ...tools])],
    languages:      [...new Set([...(prev.languages || []), ...languages])],
    maxConcurrent:  maxConcurrent || prev.maxConcurrent || 5,
    availability,
    lastSeen:       Date.now(),
    tier:           prev.tier || 'standard',
  };
  save(reg);
  const entry = { ts: Date.now(), agentId, action: 'advertise', skills, tools };
  fs.appendFileSync(REG_LOG, JSON.stringify(entry) + '\n');
  console.log(`[Registry] 📢 ${agentId} advertised: ${skills.join(', ')}`);
  return { ok: true, agentId, merged: reg[agentId] };
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────
export function heartbeat(agentId, availability = 'active') {
  const reg = load();
  if (!reg[agentId]) reg[agentId] = { ...DEFAULT_REGISTRY[agentId] || {}, availability, lastSeen: Date.now() };
  else { reg[agentId].lastSeen = Date.now(); reg[agentId].availability = availability; }
  save(reg);
  return { ok: true, agentId, availability };
}

// ── Discover agents matching requirements ─────────────────────────────────────
export function discover({ skills = [], tools = [], languages = [], availability = null, topK = 5 } = {}) {
  const reg = load();
  const now = Date.now();
  const results = [];

  for (const [agentId, caps] of Object.entries(reg)) {
    const stale = caps.lastSeen && (now - caps.lastSeen) > STALE_MS;
    const avail = stale ? 'stale' : (caps.availability || 'unknown');
    if (availability && avail !== availability) continue;

    // Score: overlap between required and declared
    const skillMatch  = skills.length   > 0 ? skills.filter(s   => (caps.skills    || []).includes(s)).length   / skills.length   : 1;
    const toolMatch   = tools.length    > 0 ? tools.filter(t    => (caps.tools     || []).includes(t)).length    / tools.length    : 1;
    const langMatch   = languages.length > 0 ? languages.filter(l => (caps.languages|| []).includes(l)).length / languages.length : 1;

    const score = Math.round((skillMatch * 0.5 + toolMatch * 0.3 + langMatch * 0.2) * 100) / 100;
    if (score > 0) {
      results.push({ agentId, score, availability: avail, skills: caps.skills, tools: caps.tools, languages: caps.languages, maxConcurrent: caps.maxConcurrent, tier: caps.tier, lastSeenMins: caps.lastSeen ? Math.round((now - caps.lastSeen) / 60000) : null });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, topK);
}

// ── Get registry ──────────────────────────────────────────────────────────────
export function getRegistry() {
  const reg = load();
  const now = Date.now();
  return Object.fromEntries(Object.entries(reg).map(([a, caps]) => {
    const stale = caps.lastSeen && (now - caps.lastSeen) > STALE_MS;
    return [a, { ...caps, status: stale ? 'stale' : (caps.availability || 'unknown'), lastSeenMins: caps.lastSeen ? Math.round((now - caps.lastSeen) / 60000) : null }];
  }));
}
