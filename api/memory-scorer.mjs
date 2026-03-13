/**
 * memory-scorer.mjs — Memory Importance Scoring & Intelligent Forgetting
 *
 * Video: "Give Your AI Agents a Permanent Brain with ReMe Memory Management" (6A1wMI51A00)
 * Pattern: "Intelligent forgetting improves AI reliability."
 *   Not all memories are equal. Score each by utility → keep high-scoring,
 *   decay/remove low-scoring. Like a librarian who culls unused books.
 *
 * Importance formula (0-100):
 *   recency:    50 × e^(-days/half_life)     — recent memories score higher
 *   retrieval:  20 × min(1, access_count/5)  — accessed memories stay relevant
 *   type_weight: 15 × type_factor            — some memory types matter more
 *   uniqueness:  10 × (1 - similarity_max)   — unique info valued over duplicates
 *   critical:    bonus 5 if tagged critical   — manually flagged always-keep
 *
 * Memory types and half-lives:
 *   causal_chain   30d  — cause→action→outcome patterns (very valuable)
 *   semantic       60d  — facts, domain knowledge
 *   episodic        7d  — specific events (decays fast)
 *   personal       90d  — user preferences, context
 *   system         14d  — system state, configs
 *
 * Actions:
 *   KEEP (score ≥ 60):   high utility, retain
 *   REVIEW (30-59):       moderate, reconsider in next cycle
 *   ARCHIVE (15-29):      low utility, move to cold storage
 *   FORGET (< 15):        remove — actively hurts reasoning
 *
 * API:
 *   POST /api/mscore/score    { content, memoryType, createdAt, accessCount, tags? }
 *   POST /api/mscore/batch    { memories: [...] } → bulk scoring
 *   POST /api/mscore/gc       { dryRun? } → garbage collect low-score ZVec memories
 *   GET  /api/mscore/stats    → scoring distribution stats
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME        = os.homedir();
const SCORE_LOG   = path.join(HOME, '.openclaw/workspace/mscore-log.jsonl');
const SCORE_STATS = path.join(HOME, '.openclaw/workspace/.mscore-stats.json');

// ── Type weights and half-lives ───────────────────────────────────────────────
const TYPE_CONFIG = {
  causal_chain: { halfLife: 30, typeWeight: 1.0 },
  semantic:     { halfLife: 60, typeWeight: 0.9 },
  personal:     { halfLife: 90, typeWeight: 0.8 },
  system:       { halfLife: 14, typeWeight: 0.7 },
  episodic:     { halfLife:  7, typeWeight: 0.5 },
  general:      { halfLife: 30, typeWeight: 0.6 },
};

// ── Decision thresholds ────────────────────────────────────────────────────────
const DECISIONS = [
  { min: 60, max: 100, action: 'KEEP',    emoji: '✅', desc: 'High utility — retain' },
  { min: 30, max: 59,  action: 'REVIEW',  emoji: '🟡', desc: 'Moderate — reconsider next cycle' },
  { min: 15, max: 29,  action: 'ARCHIVE', emoji: '📦', desc: 'Low utility — cold storage' },
  { min: 0,  max: 14,  action: 'FORGET',  emoji: '🗑️', desc: 'Remove — hurts reasoning' },
];

// ── Score a single memory ─────────────────────────────────────────────────────
export function scoreMemory({ content = '', memoryType = 'general', createdAt = Date.now(), accessCount = 0, tags = [], isCritical = false }) {
  const config = TYPE_CONFIG[memoryType] || TYPE_CONFIG.general;
  const now    = Date.now();
  const daysSince = (now - createdAt) / (24 * 60 * 60 * 1000);

  // 1. Recency score (50 pts max) — exponential decay
  const recencyScore = 50 * Math.exp(-daysSince / config.halfLife);

  // 2. Retrieval score (20 pts max) — how often accessed
  const retrievalScore = 20 * Math.min(1, accessCount / 5);

  // 3. Type weight (15 pts max)
  const typeScore = 15 * config.typeWeight;

  // 4. Content quality (10 pts max) — length + structured content
  const words   = content.split(/\s+/).length;
  const hasCode = /```|function|const |class |import |SELECT |CREATE /.test(content);
  const qualityScore = Math.min(10, (words / 20) + (hasCode ? 3 : 0));

  // 5. Critical bonus (5 pts)
  const criticalBonus = (isCritical || tags.includes('critical') || tags.includes('important')) ? 5 : 0;

  const total = Math.min(100, Math.round(recencyScore + retrievalScore + typeScore + qualityScore + criticalBonus));
  const decision = DECISIONS.find(d => total >= d.min && total <= d.max) || DECISIONS[3];

  return {
    score: total, action: decision.action, emoji: decision.emoji, desc: decision.desc,
    breakdown: { recency: Math.round(recencyScore), retrieval: Math.round(retrievalScore), type: Math.round(typeScore), quality: Math.round(qualityScore), critical: criticalBonus },
    memoryType, daysSince: Math.round(daysSince * 10) / 10,
  };
}

// ── Batch score multiple memories ─────────────────────────────────────────────
export function batchScore({ memories = [] }) {
  const results = memories.map((m, i) => ({ index: i, id: m.id || `mem_${i}`, ...scoreMemory(m) }));
  const distribution = { KEEP: 0, REVIEW: 0, ARCHIVE: 0, FORGET: 0 };
  for (const r of results) distribution[r.action]++;
  const avgScore = results.length > 0 ? Math.round(results.reduce((s, r) => s + r.score, 0) / results.length) : 0;

  // Update stats
  updateStats(distribution, avgScore, results.length);

  console.log(`[MemScorer] 📊 Batch ${results.length}: KEEP=${distribution.KEEP} REVIEW=${distribution.REVIEW} ARCHIVE=${distribution.ARCHIVE} FORGET=${distribution.FORGET} avg=${avgScore}`);
  return { ok: true, total: results.length, distribution, avgScore, results: results.sort((a, b) => b.score - a.score) };
}

// ── Garbage collect ZVec memories (simulated) ────────────────────────────────
export async function gcMemories({ dryRun = true } = {}) {
  // In real system: query ZVec for all memories, score each, delete FORGET ones
  // Simulated here for testing
  const simulatedMemories = [
    { id: 'mem_1', content: 'CAUSE: JWT expired | ACTION: refresh token | OUTCOME: user session restored', memoryType: 'causal_chain', createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000, accessCount: 8 },
    { id: 'mem_2', content: 'System restarted at 3am', memoryType: 'episodic', createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000, accessCount: 0 },
    { id: 'mem_3', content: 'ORGON uses PostgreSQL 16 with pgvector extension for embeddings', memoryType: 'semantic', createdAt: Date.now() - 5 * 24 * 60 * 60 * 1000, accessCount: 12 },
    { id: 'mem_4', content: 'ok', memoryType: 'episodic', createdAt: Date.now() - 60 * 24 * 60 * 60 * 1000, accessCount: 0 },
  ];

  const results = simulatedMemories.map(m => ({ id: m.id, ...scoreMemory(m) }));
  const toForget  = results.filter(r => r.action === 'FORGET');
  const toArchive = results.filter(r => r.action === 'ARCHIVE');

  if (!dryRun) {
    fs.appendFileSync(SCORE_LOG, JSON.stringify({ ts: Date.now(), action: 'gc', deleted: toForget.length, archived: toArchive.length }) + '\n');
    console.log(`[MemScorer] 🧹 GC: deleted=${toForget.length} archived=${toArchive.length}`);
  }

  return { ok: true, dryRun, scanned: results.length, toForget: toForget.map(r => ({ id: r.id, score: r.score })), toArchive: toArchive.map(r => ({ id: r.id, score: r.score })), wouldDelete: toForget.length, results: results.map(r => ({ id: r.id, score: r.score, action: r.action, emoji: r.emoji })) };
}

function updateStats(dist, avg, count) {
  let s; try { s = JSON.parse(fs.readFileSync(SCORE_STATS, 'utf8')); } catch { s = { total: 0, KEEP: 0, REVIEW: 0, ARCHIVE: 0, FORGET: 0, totalScore: 0 }; }
  s.total += count; s.totalScore = (s.totalScore || 0) + avg * count;
  for (const [k, v] of Object.entries(dist)) s[k] = (s[k] || 0) + v;
  s.avgScore = Math.round(s.totalScore / s.total);
  try { fs.writeFileSync(SCORE_STATS, JSON.stringify(s, null, 2)); } catch {}
}

export function getStats() { try { return JSON.parse(fs.readFileSync(SCORE_STATS, 'utf8')); } catch { return { total: 0 }; } }
