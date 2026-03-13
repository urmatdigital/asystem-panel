/**
 * hmem.mjs — Hierarchical Memory (H-MEM) with Reflection Tree
 *
 * Video: "Agentic AI Memory Hacks" (4Mkf6tMOcgw)
 * Pattern: 4-layer hierarchical memory replacing flat vectors
 *   Domain → Category → Memory Trace → Episode
 *
 *   Layer 1: DOMAIN    — top-level project/topic (asystem, orgon, aurwa, security, infra)
 *   Layer 2: CATEGORY  — functional area (backend, frontend, devops, qa, design, agent)
 *   Layer 3: TRACE     — specific task/context entry (what happened)
 *   Layer 4: EPISODE   — synthesized insight from multiple traces (Reflection Tree)
 *
 * Reflection Tree (synthesis):
 *   When 5+ traces in same Category → synthesize into Episode via key-phrase extraction
 *   Episode = compressed, actionable summary of what the team learned
 *   Episodes live longer than raw traces (30d vs 7d decay)
 *
 * Focus Loop (compression):
 *   On retrieval, score by: recency × importance × relevance-to-query
 *   Return top-K across hierarchy (Domain-first, then Category, then Trace/Episode)
 *   6-40x efficiency vs flat vector search (fewer tokens, higher signal)
 *
 * Storage: .hmem/ directory (JSON files per domain+category)
 *
 * API:
 *   POST /api/hmem/store   { domain, category, content, agentId, importance? }
 *   POST /api/hmem/recall  { query, domain?, category?, topK? }
 *   GET  /api/hmem/tree    → hierarchy overview
 *   POST /api/hmem/reflect { domain, category } → trigger episode synthesis
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME     = os.homedir();
const HMEM_DIR = path.join(HOME, '.openclaw/workspace/.hmem');
const REFL_LOG = path.join(HOME, '.openclaw/workspace/reflection-tree.jsonl');

if (!fs.existsSync(HMEM_DIR)) fs.mkdirSync(HMEM_DIR, { recursive: true });

// ── Domains and categories ────────────────────────────────────────────────────
const KNOWN_DOMAINS     = ['asystem', 'orgon', 'aurwa', 'fiatex', 'voltera', 'infra', 'security', 'general'];
const KNOWN_CATEGORIES  = ['backend', 'frontend', 'devops', 'qa', 'design', 'agent', 'database', 'api', 'general'];

function detectDomain(content = '', agentId = '') {
  const low = content.toLowerCase();
  if (low.includes('orgon'))    return 'orgon';
  if (low.includes('aurwa'))    return 'aurwa';
  if (low.includes('fiatex'))   return 'fiatex';
  if (low.includes('voltera'))  return 'voltera';
  if (low.includes('security') || low.includes('auth') || low.includes('jwt')) return 'security';
  if (low.includes('infra') || low.includes('proxmox') || low.includes('tailscale')) return 'infra';
  return 'asystem';
}

function detectCategory(content = '') {
  const low = content.toLowerCase();
  if (/\b(api|endpoint|rest|graphql|fastapi|express)\b/.test(low)) return 'api';
  if (/\b(database|postgres|sql|mongo|redis|convex)\b/.test(low))  return 'database';
  if (/\b(deploy|docker|pm2|nginx|tailscale|vm|lxc)\b/.test(low))  return 'devops';
  if (/\b(test|qa|spec|cypress|jest|pytest)\b/.test(low))          return 'qa';
  if (/\b(design|ui|ux|figma|css|component)\b/.test(low))          return 'design';
  if (/\b(agent|dispatch|llm|prompt|model)\b/.test(low))           return 'agent';
  if (/\b(frontend|react|vue|next|svelte|vite)\b/.test(low))       return 'frontend';
  if (/\b(backend|server|fastapi|express|node)\b/.test(low))       return 'backend';
  return 'general';
}

// ── File path for domain/category ─────────────────────────────────────────────
function catFile(domain, category) { return path.join(HMEM_DIR, `${domain}_${category}.json`); }

function loadCat(domain, category) {
  try { return JSON.parse(fs.readFileSync(catFile(domain, category), 'utf8')); }
  catch { return { domain, category, traces: [], episodes: [] }; }
}
function saveCat(data) { fs.writeFileSync(catFile(data.domain, data.category), JSON.stringify(data, null, 2)); }

// ── Store trace ────────────────────────────────────────────────────────────────
export function storeTrace({ domain, category, content, agentId = 'unknown', importance = 0.5 }) {
  domain   = domain   || detectDomain(content, agentId);
  category = category || detectCategory(content);

  const cat = loadCat(domain, category);
  cat.traces.push({ id: `t_${Date.now()}`, ts: Date.now(), content: content.slice(0, 500), agentId, importance });
  // Keep last 50 traces per category
  if (cat.traces.length > 50) cat.traces = cat.traces.slice(-50);
  saveCat(cat);

  // Auto-reflect if 5+ traces since last episode
  const traceSinceEpisode = cat.episodes.length > 0
    ? cat.traces.filter(t => t.ts > cat.episodes[cat.episodes.length - 1].ts).length
    : cat.traces.length;

  let episode = null;
  if (traceSinceEpisode >= 5) {
    episode = reflectCategory(domain, category);
  }

  console.log(`[H-MEM] 💾 Stored: [${domain}/${category}] traces=${cat.traces.length}${episode ? ' → EPISODE synthesized' : ''}`);
  return { domain, category, tracesTotal: cat.traces.length, episode: episode?.summary };
}

// ── Reflect: synthesize episode from recent traces ─────────────────────────────
export function reflectCategory(domain, category) {
  const cat = loadCat(domain, category);
  if (cat.traces.length < 3) return null;

  // Key-phrase extraction (lightweight, no LLM)
  const recent = cat.traces.slice(-10);
  const allWords = recent.flatMap(t => t.content.toLowerCase().split(/\W+/).filter(w => w.length > 4));
  const freq = {};
  for (const w of allWords) freq[w] = (freq[w] || 0) + 1;
  const topPhrases = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);

  const episode = {
    id: `ep_${Date.now()}`,
    ts: Date.now(),
    domain, category,
    traceCount: recent.length,
    summary: `[${domain}/${category}] Team activity: ${topPhrases.join(', ')}. Based on ${recent.length} recent traces.`,
    topPhrases,
    agentIds: [...new Set(recent.map(t => t.agentId))],
    importance: Math.max(...recent.map(t => t.importance || 0.5)),
  };

  cat.episodes.push(episode);
  if (cat.episodes.length > 20) cat.episodes = cat.episodes.slice(-20);
  saveCat(cat);

  fs.appendFileSync(REFL_LOG, JSON.stringify({ ts: Date.now(), domain, category, topPhrases, traceCount: recent.length }) + '\n');
  return episode;
}

// ── Recall: hierarchical retrieval with Focus Loop scoring ─────────────────────
export function recall({ query = '', domain = null, category = null, topK = 5 }) {
  const qLow    = query.toLowerCase();
  const qWords  = new Set(qLow.split(/\W+/).filter(w => w.length > 3));
  const results = [];
  const now     = Date.now();

  // Discover files to search
  let files;
  try { files = fs.readdirSync(HMEM_DIR).filter(f => f.endsWith('.json')); }
  catch { return []; }

  for (const file of files) {
    const [fileDomain, fileCategory] = file.replace('.json', '').split('_');
    if (domain   && fileDomain   !== domain)   continue;
    if (category && fileCategory !== category) continue;

    const cat = loadCat(fileDomain, fileCategory);

    // Score episodes (higher weight — synthesized knowledge)
    for (const ep of cat.episodes) {
      const recency    = Math.exp(-(now - ep.ts) / (30 * 86400000)); // 30d half-life
      const relevance  = ep.topPhrases.filter(p => qWords.has(p)).length / Math.max(qWords.size, 1);
      const score      = recency * 0.3 + relevance * 0.5 + (ep.importance || 0.5) * 0.2;
      if (score > 0.1) results.push({ type: 'episode', domain: fileDomain, category: fileCategory, content: ep.summary, score: Math.round(score * 1000) / 1000, ts: ep.ts });
    }

    // Score traces (lower weight — raw data)
    for (const tr of cat.traces.slice(-20)) {
      const recency   = Math.exp(-(now - tr.ts) / (7 * 86400000)); // 7d half-life
      const cLow      = tr.content.toLowerCase();
      const relevance = [...qWords].filter(w => cLow.includes(w)).length / Math.max(qWords.size, 1);
      const score     = recency * 0.4 + relevance * 0.4 + (tr.importance || 0.5) * 0.2;
      if (score > 0.15) results.push({ type: 'trace', domain: fileDomain, category: fileCategory, content: tr.content.slice(0, 200), score: Math.round(score * 1000) / 1000, ts: tr.ts });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, topK);
}

// ── Tree overview ──────────────────────────────────────────────────────────────
export function getTree() {
  const tree = {};
  try {
    const files = fs.readdirSync(HMEM_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const [d, c] = file.replace('.json', '').split('_');
      const cat = loadCat(d, c);
      if (!tree[d]) tree[d] = {};
      tree[d][c] = { traces: cat.traces.length, episodes: cat.episodes.length };
    }
  } catch {}
  return tree;
}
