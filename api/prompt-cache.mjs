/**
 * prompt-cache.mjs — Semantic Prompt Cache + Prefix Stability
 *
 * Video: "Build Hour: Prompt Caching" (tECAkJAI_Vk)
 * + "Batch Caching — Speed up Local AI & Coding Agents" (O_pQG6x9dvY)
 *
 * Pattern 1: Stable prefix cache
 *   System prompt + tools + persona headers stay IDENTICAL across tasks
 *   → Claude/OpenAI KV cache hits = 90% token savings on prefix
 *
 * Pattern 2: Semantic response cache
 *   Hash (agent + normalized_title) → if seen recently → return cached result
 *   Prevents re-running identical tasks (same title submitted twice)
 *   TTL: 10 minutes (configurable)
 *
 * Pattern 3: Embedding similarity cache
 *   For dispatch: if title is >85% similar to recent task → skip or attach result
 *   Uses cosine similarity on simple bag-of-words (no API call needed)
 *
 * Storage: in-memory Map + ~/.openclaw/workspace/.prompt-cache.json (persist)
 */

import { createHash } from 'node:crypto';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME        = os.homedir();
const CACHE_FILE  = path.join(HOME, '.openclaw/workspace/.prompt-cache.json');
const CACHE_TTL   = 10 * 60_000;    // 10 minutes
const MAX_ENTRIES = 500;

// ── In-memory cache ───────────────────────────────────────────────────────────
const cache = new Map(); // key → { result, ts, hits }
let cacheHits = 0, cacheMisses = 0;

// Load persisted cache on startup
function loadCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const now = Date.now();
    for (const [k, v] of Object.entries(data)) {
      if (now - v.ts < CACHE_TTL) cache.set(k, v);
    }
    console.log(`[PromptCache] Loaded ${cache.size} entries`);
  } catch {}
}
loadCache();

function persistCache() {
  try {
    const obj = {};
    for (const [k, v] of cache) obj[k] = v;
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
  } catch {}
}

// ── Cache key generation ──────────────────────────────────────────────────────
function makeCacheKey(agentId, title) {
  const normalized = title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100);
  return createHash('md5').update(`${agentId}:${normalized}`).digest('hex').slice(0, 12);
}

// ── Simple bag-of-words similarity (no embedding API needed) ──────────────────
function bowSimilarity(a, b) {
  const tokenize = s => new Set(s.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const setA = tokenize(a), setB = tokenize(b);
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

// ── Check cache ───────────────────────────────────────────────────────────────
export function checkCache(agentId, title) {
  const key = makeCacheKey(agentId, title);
  const now = Date.now();

  // Exact cache hit
  if (cache.has(key)) {
    const entry = cache.get(key);
    if (now - entry.ts < CACHE_TTL) {
      entry.hits++;
      cacheHits++;
      console.log(`[PromptCache] 🎯 HIT (${entry.hits}x): ${agentId} "${title.slice(0, 40)}"`);
      return { hit: true, key, result: entry.result, taskId: entry.taskId, cachedAt: entry.ts };
    }
    cache.delete(key);
  }

  // Semantic similarity check (bag-of-words, threshold 0.85)
  for (const [k, v] of cache) {
    if (now - v.ts >= CACHE_TTL) { cache.delete(k); continue; }
    if (v.agentId !== agentId) continue;
    const sim = bowSimilarity(title, v.title || '');
    if (sim >= 0.85) {
      v.hits++;
      cacheHits++;
      console.log(`[PromptCache] 🎯 SEMANTIC HIT (sim=${sim.toFixed(2)}): "${title.slice(0, 40)}"`);
      return { hit: true, key: k, result: v.result, taskId: v.taskId, similarity: sim, cachedAt: v.ts };
    }
  }

  cacheMisses++;
  return { hit: false, key };
}

// ── Store result in cache ─────────────────────────────────────────────────────
export function storeInCache(agentId, title, result, taskId) {
  if (!result || result.length < 20) return; // Don't cache empty/trivial results

  // Evict oldest if at capacity
  if (cache.size >= MAX_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) cache.delete(oldest[0]);
  }

  const key = makeCacheKey(agentId, title);
  cache.set(key, { result, taskId, agentId, title, ts: Date.now(), hits: 0 });

  // Persist every 10 stores
  if (cache.size % 10 === 0) persistCache();
}

// ── Stable prefix builder (for Anthropic prompt cache headers) ───────────────
export function buildStablePrefix(agentId, persona = '') {
  // This prefix stays IDENTICAL across calls → KV cache hits on Anthropic side
  return [
    `You are ${agentId}, a specialized AI agent in the ASYSTEM multi-agent network.`,
    `Network: forge (Mac Mini M4) → bekzat/ainura/marat/nurlan (ORGON) → iron/mesa/atlas.`,
    `Convex DB for tasks/sprints. ZVec for memory. FastAPI + Next.js 16 stack.`,
    persona ? `\nYour role this task: ${persona}` : '',
    `\nRespond concisely. Code: production-ready. Always include error handling.`,
  ].filter(Boolean).join('\n');
}

// ── Invalidate cache for agent (after skill delta) ───────────────────────────
export function invalidateAgentCache(agentId) {
  let removed = 0;
  for (const [k, v] of cache) {
    if (v.agentId === agentId) { cache.delete(k); removed++; }
  }
  if (removed) console.log(`[PromptCache] Invalidated ${removed} entries for ${agentId}`);
  return removed;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getCacheStats() {
  const now = Date.now();
  const active = [...cache.values()].filter(v => now - v.ts < CACHE_TTL).length;
  const totalHits = [...cache.values()].reduce((s, v) => s + v.hits, 0);
  return {
    size: cache.size,
    active,
    cacheHits,
    cacheMisses,
    hitRate: (cacheHits + cacheMisses) ? Math.round((cacheHits / (cacheHits + cacheMisses)) * 100) : 0,
    totalHits,
    ttlMin: CACHE_TTL / 60_000,
  };
}
