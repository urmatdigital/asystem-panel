/**
 * spec-cache.mjs — Spec-Driven Output Caching (Semantic + Structural)
 *
 * Video: "[SBS 2026] Spec Driven AI Development — Future of Enterprise Vibe Coding" (Te47m--1VWE)
 * Pattern: Don't cache by exact text match (too narrow) or pure embedding similarity (too broad).
 *   Cache by SPEC SIGNATURE: normalized structure of the task intent.
 *   Same spec = cache hit. Novel spec = LLM call + store.
 *   Production demos showed 14x speedup with 87% cache hit rate on repeated patterns.
 *
 * Spec signature = hash of:
 *   - action type (implement/review/test/deploy/analyze)
 *   - target domain (auth/database/api/frontend/security)
 *   - agent role (bekzat/marat/iron...)
 *   - key entities (extracted nouns: JWT, ORGON, PostgreSQL)
 *   - complexity band (simple/medium/complex)
 *
 * Cache levels:
 *   L1 EXACT   (MD5 of full task title)       — identical task → instant hit
 *   L2 SPEC    (spec signature hash)           — same intent, different wording
 *   L3 SIMILAR (BoW cosine similarity ≥ 0.75) — semantically close tasks
 *
 * Cache entry:
 *   { sig, result, score, agent, createdAt, hits, ttlMs, specTokens }
 *
 * Cost savings:
 *   Cache hit L1: save 100% of LLM cost for that call
 *   Cache hit L2: save 95% (may need minor adaptation)
 *   Cache hit L3: save 70% (result is a starting point, needs review)
 *
 * API:
 *   POST /api/speccache/lookup  { taskTitle, agentId, priority }
 *   POST /api/speccache/store   { taskTitle, agentId, result, score }
 *   POST /api/speccache/evict   { sig? } → evict by sig or clear expired
 *   GET  /api/speccache/stats   → hit rate, saved calls, top patterns
 */

import fs     from 'node:fs';
import path   from 'node:path';
import os     from 'node:os';
import crypto from 'node:crypto';

const HOME       = os.homedir();
const CACHE_FILE = path.join(HOME, '.openclaw/workspace/.spec-cache.json');
const CACHE_LOG  = path.join(HOME, '.openclaw/workspace/spec-cache-log.jsonl');

const MAX_ENTRIES = 300;
const DEFAULT_TTL = 4 * 60 * 60 * 1000; // 4 hours

// ── Action / Domain extractors ────────────────────────────────────────────────
const ACTION_PATTERNS = [
  { action: 'implement', re: /\b(implement|build|create|write|code|develop|add)\b/i },
  { action: 'review',    re: /\b(review|audit|check|inspect|analyze|evaluate)\b/i },
  { action: 'test',      re: /\b(test|qa|verify|validate|spec|coverage)\b/i },
  { action: 'deploy',    re: /\b(deploy|release|publish|push|ship)\b/i },
  { action: 'fix',       re: /\b(fix|debug|patch|repair|resolve|hotfix)\b/i },
  { action: 'plan',      re: /\b(plan|design|architect|spec|outline|draft)\b/i },
];

const DOMAIN_PATTERNS = [
  { domain: 'auth',     re: /\b(auth|jwt|oauth|login|token|session|password|sso)\b/i },
  { domain: 'database', re: /\b(database|db|sql|postgres|mongodb|schema|migration|query)\b/i },
  { domain: 'api',      re: /\b(api|rest|graphql|endpoint|route|controller|service)\b/i },
  { domain: 'frontend', re: /\b(frontend|ui|react|vue|component|css|page|layout)\b/i },
  { domain: 'security', re: /\b(security|vulnerability|cve|xss|injection|csrf|firewall)\b/i },
  { domain: 'infra',    re: /\b(deploy|docker|k8s|nginx|pm2|server|infrastructure|devops)\b/i },
  { domain: 'perf',     re: /\b(performance|latency|optimize|speed|cache|slow|bottleneck)\b/i },
];

// ── Spec signature extraction ─────────────────────────────────────────────────
function extractSpec(taskTitle, agentId) {
  const low = taskTitle.toLowerCase();

  const action  = ACTION_PATTERNS.find(p => p.re.test(low))?.action || 'general';
  const domain  = DOMAIN_PATTERNS.find(p => p.re.test(low))?.domain || 'general';

  // Extract key entities (nouns, proper nouns, tech terms)
  const entities = [...taskTitle.matchAll(/\b([A-Z][a-z]+|[A-Z]{2,}|[a-z]+-[a-z]+)\b/g)]
    .map(m => m[1].toLowerCase()).filter(e => e.length > 2).slice(0, 4).sort();

  // Complexity band from title length + special words
  const isComplex = /\b(architecture|system|migrate|refactor|integration|pipeline)\b/i.test(low);
  const isSimple  = /\b(add|fix|update|remove|rename|list|get)\b/i.test(low) && taskTitle.length < 40;
  const complexity = isComplex ? 'complex' : isSimple ? 'simple' : 'medium';

  return { action, domain, agentId, entities, complexity };
}

function specHash(spec) {
  const str = `${spec.action}:${spec.domain}:${spec.agentId}:${spec.entities.join(',')}:${spec.complexity}`;
  return crypto.createHash('md5').update(str).digest('hex').slice(0, 16);
}

function titleHash(title) { return crypto.createHash('md5').update(title.toLowerCase().trim()).digest('hex').slice(0, 16); }

// ── BoW similarity ────────────────────────────────────────────────────────────
function bowSim(a, b) {
  const wa = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const wb = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const inter = [...wa].filter(w => wb.has(w)).length;
  return inter / Math.max(1, Math.max(wa.size, wb.size));
}

// ── Load / save cache ─────────────────────────────────────────────────────────
function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return { entries: {}, stats: { hits: 0, misses: 0, l1: 0, l2: 0, l3: 0, stores: 0 } }; } }
function saveCache(c) { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c)); } catch {} }

// ── Lookup ────────────────────────────────────────────────────────────────────
export function lookup({ taskTitle = '', agentId = '', priority = 'medium' }) {
  // Critical priority → bypass cache (always fresh)
  if (priority === 'critical') return { hit: false, level: null, reason: 'critical priority bypasses cache' };

  const cache = loadCache();
  const now   = Date.now();

  // L1: exact title hash
  const l1key = `l1_${titleHash(taskTitle)}`;
  const l1    = cache.entries[l1key];
  if (l1 && now - l1.createdAt < l1.ttlMs) {
    l1.hits++; cache.stats.hits++; cache.stats.l1++; saveCache(cache);
    console.log(`[SpecCache] 🟢 L1 HIT: "${taskTitle.slice(0, 40)}" → score=${l1.score}`);
    return { hit: true, level: 'L1', result: l1.result, score: l1.score, savings: '100%' };
  }

  // L2: spec signature
  const spec  = extractSpec(taskTitle, agentId);
  const l2key = `l2_${specHash(spec)}`;
  const l2    = cache.entries[l2key];
  if (l2 && now - l2.createdAt < l2.ttlMs) {
    l2.hits++; cache.stats.hits++; cache.stats.l2++; saveCache(cache);
    console.log(`[SpecCache] 🟡 L2 HIT: spec=${spec.action}/${spec.domain} → score=${l2.score}`);
    return { hit: true, level: 'L2', result: l2.result, score: l2.score, spec, savings: '95%', note: 'Spec match — minor adaptation may be needed' };
  }

  // L3: BoW similarity scan (max 50 entries for perf)
  const candidates = Object.values(cache.entries).filter(e => now - e.createdAt < e.ttlMs && e.taskTitle).slice(-50);
  const best = candidates.map(e => ({ e, sim: bowSim(taskTitle, e.taskTitle) })).filter(x => x.sim >= 0.75).sort((a, b) => b.sim - a.sim)[0];
  if (best) {
    best.e.hits++; cache.stats.hits++; cache.stats.l3++; saveCache(cache);
    console.log(`[SpecCache] 🔵 L3 HIT: sim=${best.sim.toFixed(2)} → "${best.e.taskTitle.slice(0, 40)}"`);
    return { hit: true, level: 'L3', result: best.e.result, score: best.e.score, similarity: best.sim, savings: '70%', note: 'Semantic match — review before using' };
  }

  cache.stats.misses++;
  saveCache(cache);
  console.log(`[SpecCache] ❌ MISS: "${taskTitle.slice(0, 40)}" spec=${spec.action}/${spec.domain}`);
  return { hit: false, level: null, spec, reason: 'No cache match found' };
}

// ── Store result ──────────────────────────────────────────────────────────────
export function store({ taskTitle = '', agentId = '', result = '', score = 7, ttlMs = DEFAULT_TTL }) {
  const cache = loadCache();
  const spec  = extractSpec(taskTitle, agentId);
  const now   = Date.now();

  // Enforce max size
  const keys = Object.keys(cache.entries);
  if (keys.length >= MAX_ENTRIES) {
    const oldest = keys.sort((a, b) => cache.entries[a].createdAt - cache.entries[b].createdAt)[0];
    delete cache.entries[oldest];
  }

  const entry = { taskTitle, agentId, result: result.slice(0, 500), score, createdAt: now, ttlMs, hits: 0, spec };
  cache.entries[`l1_${titleHash(taskTitle)}`] = entry;
  cache.entries[`l2_${specHash(spec)}`]       = entry;
  cache.stats.stores++;
  saveCache(cache);
  fs.appendFileSync(CACHE_LOG, JSON.stringify({ ts: now, action: 'store', taskTitle: taskTitle.slice(0, 40), spec: `${spec.action}/${spec.domain}`, score }) + '\n');
  console.log(`[SpecCache] 💾 STORED: "${taskTitle.slice(0, 40)}" spec=${spec.action}/${spec.domain} score=${score}`);
  return { ok: true, l1: `l1_${titleHash(taskTitle)}`, l2: `l2_${specHash(spec)}`, spec };
}

export function evict({ sig } = {}) {
  const cache = loadCache();
  if (sig) { delete cache.entries[sig]; saveCache(cache); return { ok: true, evicted: 1 }; }
  const now = Date.now(); let evicted = 0;
  for (const [k, e] of Object.entries(cache.entries)) { if (now - e.createdAt > e.ttlMs) { delete cache.entries[k]; evicted++; } }
  saveCache(cache); return { ok: true, evicted };
}

export function getStats() {
  const c = loadCache();
  const total = c.stats.hits + c.stats.misses;
  return { ...c.stats, total, hitRate: total > 0 ? `${Math.round(c.stats.hits / total * 100)}%` : '0%', entries: Object.keys(c.entries).length };
}
