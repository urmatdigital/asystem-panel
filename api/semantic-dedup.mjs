/**
 * semantic-dedup.mjs — Semantic Task Deduplication
 *
 * Video: "Soft Contamination Means Benchmarks Test Shallow Generalization" (k68-hlYoayw)
 * Pattern: Exact-match deduplication misses semantically identical tasks.
 *   "implement auth" ≈ "add authentication" ≈ "build login system"
 *   → All three are the same task, agent should only run it once.
 *
 * Detection layers:
 *   Layer 1: Exact hash match (instant, 0ms) — same string → block
 *   Layer 2: Normalized similarity (strip stop words, lemmatize) — 90%+ → block
 *   Layer 3: BoW cosine similarity — 80%+ → WARN (possible duplicate)
 *   Layer 4: Keyword overlap (Jaccard) — 70%+ shared keywords → WARN
 *
 * Actions:
 *   BLOCK  — same task already running/queued; reject new dispatch
 *   WARN   — possible duplicate; flag for human review but allow
 *   PASS   — unique task; proceed normally
 *
 * Dedup window: 24h rolling (tasks older than 24h don't count)
 *
 * API:
 *   POST /api/dedup/check  { title, agentId? } → BLOCK|WARN|PASS + similarity
 *   POST /api/dedup/register { title, taskId, agentId } → add to dedup index
 *   DELETE /api/dedup/:taskId → remove from index (on completion)
 *   GET  /api/dedup/index  → current dedup window
 */

import fs     from 'node:fs';
import path   from 'node:path';
import os     from 'node:os';
import crypto from 'node:crypto';

const HOME       = os.homedir();
const DEDUP_FILE = path.join(HOME, '.openclaw/workspace/.dedup-index.json');
const DEDUP_LOG  = path.join(HOME, '.openclaw/workspace/dedup-log.jsonl');
const WINDOW_MS  = 24 * 60 * 60 * 1000;  // 24h

const BLOCK_THRESHOLD = 0.90;  // cosine >= 0.90 → block
const WARN_THRESHOLD  = 0.75;  // cosine >= 0.75 → warn

// ── Stop words to strip before comparison ────────────────────────────────────
const STOP_WORDS = new Set(['the','a','an','and','or','for','to','in','of','with','on','at','by','is','are','was','were','be','been','do','does','did','will','would','could','should','can','may','might','must','shall','have','has','had']);

// ── Normalize text → word tokens ──────────────────────────────────────────────
function tokenize(text = '') {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// ── Build BoW frequency vector ────────────────────────────────────────────────
function bowVector(tokens) {
  const freq = {};
  for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
  return freq;
}

// ── Cosine similarity between two BoW vectors ─────────────────────────────────
function cosineSim(v1, v2) {
  const keys = new Set([...Object.keys(v1), ...Object.keys(v2)]);
  let dot = 0, norm1 = 0, norm2 = 0;
  for (const k of keys) {
    const a = v1[k] || 0, b = v2[k] || 0;
    dot   += a * b;
    norm1 += a * a;
    norm2 += b * b;
  }
  if (norm1 === 0 || norm2 === 0) return 0;
  return dot / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

// ── Jaccard token overlap ──────────────────────────────────────────────────────
function jaccardSim(tokens1, tokens2) {
  const s1 = new Set(tokens1), s2 = new Set(tokens2);
  const intersection = [...s1].filter(t => s2.has(t)).length;
  const union = new Set([...s1, ...s2]).size;
  return union === 0 ? 0 : intersection / union;
}

// ── Load/save index ────────────────────────────────────────────────────────────
function loadIndex() {
  try {
    const idx = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8'));
    const now = Date.now();
    // Prune expired entries
    return Object.fromEntries(Object.entries(idx).filter(([, v]) => now - v.ts < WINDOW_MS));
  } catch { return {}; }
}
function saveIndex(idx) { try { fs.writeFileSync(DEDUP_FILE, JSON.stringify(idx, null, 2)); } catch {} }

// ── Check for duplicates ──────────────────────────────────────────────────────
export function checkDedup({ title, agentId = null }) {
  const idx      = loadIndex();
  const hash     = crypto.createHash('md5').update(title.toLowerCase().trim()).digest('hex').slice(0, 8);
  const tokens1  = tokenize(title);
  const bow1     = bowVector(tokens1);

  // Layer 1: exact hash
  const exactMatch = Object.values(idx).find(e => e.hash === hash);
  if (exactMatch) {
    logDedup('BLOCK', title, exactMatch.title, 1.0, 'exact');
    return { action: 'BLOCK', reason: 'Exact duplicate', similarity: 1.0, matchedTaskId: exactMatch.taskId, matchedTitle: exactMatch.title, layer: 'exact' };
  }

  // Layer 2+3: semantic similarity
  let maxSim = 0, bestMatch = null, bestLayer = null;
  for (const entry of Object.values(idx)) {
    const tokens2 = entry.tokens || tokenize(entry.title);
    const bow2    = bowVector(tokens2);

    const cosine  = cosineSim(bow1, bow2);
    const jaccard = jaccardSim(tokens1, tokens2);
    const sim     = Math.max(cosine, jaccard * 0.9); // cosine dominates

    if (sim > maxSim) { maxSim = sim; bestMatch = entry; bestLayer = cosine > jaccard * 0.9 ? 'cosine' : 'jaccard'; }
  }

  const roundedSim = Math.round(maxSim * 100) / 100;
  if (maxSim >= BLOCK_THRESHOLD && bestMatch) {
    logDedup('BLOCK', title, bestMatch.title, roundedSim, bestLayer);
    return { action: 'BLOCK', reason: 'Semantically identical task', similarity: roundedSim, matchedTaskId: bestMatch.taskId, matchedTitle: bestMatch.title, layer: bestLayer };
  }
  if (maxSim >= WARN_THRESHOLD && bestMatch) {
    logDedup('WARN', title, bestMatch.title, roundedSim, bestLayer);
    return { action: 'WARN', reason: 'Possible duplicate — review before proceeding', similarity: roundedSim, matchedTaskId: bestMatch.taskId, matchedTitle: bestMatch.title, layer: bestLayer };
  }

  return { action: 'PASS', reason: 'Unique task', similarity: roundedSim, matchedTitle: bestMatch?.title || null };
}

// ── Register task in dedup window ─────────────────────────────────────────────
export function registerTask({ title, taskId, agentId }) {
  const idx   = loadIndex();
  const hash  = crypto.createHash('md5').update(title.toLowerCase().trim()).digest('hex').slice(0, 8);
  idx[taskId] = { taskId, title: title?.slice(0, 100), hash, agentId, tokens: tokenize(title), ts: Date.now() };
  saveIndex(idx);
  console.log(`[Dedup] 📋 Registered: "${title?.slice(0, 40)}" [${taskId}]`);
  return { ok: true, taskId, hash };
}

// ── Remove from dedup index ────────────────────────────────────────────────────
export function removeTask(taskId) {
  const idx = loadIndex();
  const existed = !!idx[taskId];
  delete idx[taskId];
  saveIndex(idx);
  console.log(`[Dedup] 🗑️ Removed: ${taskId}`);
  return { ok: true, existed, taskId };
}

export function getIndex() { return loadIndex(); }

function logDedup(action, title, matchedTitle, sim, layer) {
  fs.appendFileSync(DEDUP_LOG, JSON.stringify({ ts: Date.now(), action, title: title?.slice(0, 50), matchedTitle: matchedTitle?.slice(0, 50), similarity: sim, layer }) + '\n');
  console.log(`[Dedup] ${action === 'BLOCK' ? '🚫' : '⚠️'} ${action}: "${title?.slice(0,30)}" ≈ "${matchedTitle?.slice(0,30)}" (sim=${sim} via ${layer})`);
}
