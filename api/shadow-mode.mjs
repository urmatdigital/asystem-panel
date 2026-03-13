/**
 * shadow-mode.mjs — Shadow Mode Testing for Agent Versions
 *
 * Video: "Roundtable Discussion on AI in 2026, Session 5" (AcmTMbMYp2k)
 * Pattern: Run new agent version in SHADOW alongside production version.
 *   - Production: handles real requests, users see results
 *   - Shadow: receives same inputs async, logs outputs for comparison
 *   - Zero risk: shadow output never reaches users
 *   - Compare: agreement rate, latency delta, quality delta
 *   - Promote: if shadow agrees >95% and quality ≥ prod → full switch
 *
 * Use cases:
 *   - Testing new model (haiku→sonnet upgrade for nurlan)
 *   - Testing new prompt template
 *   - Testing new skill injection strategy
 *   - A/B comparing two dispatch strategies
 *
 * Shadow lifecycle:
 *   1. REGISTER shadow: { name, description, compareWith: 'production' }
 *   2. RECORD pairs: { shadowId, input, prodOutput, shadowOutput, latencyDelta, qualityDelta }
 *   3. ANALYZE: agreement rate, quality trend, latency impact
 *   4. PROMOTE or DISCARD based on analysis
 *
 * Agreement scoring:
 *   - exact: identical outputs → 1.0
 *   - semantic: BoW overlap ≥ 0.8 → counted as agree
 *   - quality: score comparison (shadow ≥ prod → positive)
 *
 * API:
 *   POST /api/shadow/register  { name, desc, agentId, variant }
 *   POST /api/shadow/record    { shadowId, input, prodOutput, shadowOutput, prodScore?, shadowScore? }
 *   GET  /api/shadow/:id       → shadow stats + agreement rate
 *   POST /api/shadow/promote   { shadowId } → mark as promoted to production
 *   POST /api/shadow/discard   { shadowId } → mark as discarded
 *   GET  /api/shadow/active    → all active shadows
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME         = os.homedir();
const SHADOW_DIR   = path.join(HOME, '.openclaw/workspace/.shadows');
const SHADOW_INDEX = path.join(SHADOW_DIR, '_index.json');
const SHADOW_LOG   = path.join(HOME, '.openclaw/workspace/shadow-log.jsonl');

if (!fs.existsSync(SHADOW_DIR)) fs.mkdirSync(SHADOW_DIR, { recursive: true });

// ── BoW similarity ─────────────────────────────────────────────────────────────
function bowSim(a = '', b = '') {
  const tokA = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  const tokB = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  if (!tokA.size || !tokB.size) return 0;
  const intersection = [...tokA].filter(t => tokB.has(t)).length;
  return Math.round((intersection / Math.max(tokA.size, tokB.size)) * 100) / 100;
}

// ── Register shadow ────────────────────────────────────────────────────────────
export function registerShadow({ name, desc = '', agentId, variant = 'new-prompt' }) {
  const id = `shadow_${Date.now()}`;
  const shadow = { id, name, desc, agentId, variant, status: 'active', createdAt: Date.now(), samples: [], stats: { total: 0, agree: 0, qualityWin: 0, qualityLose: 0, qualityTie: 0, avgLatencyDelta: 0 } };
  saveToIndex(id, shadow);
  fs.appendFileSync(SHADOW_LOG, JSON.stringify({ ts: Date.now(), action: 'register', id, name, agentId, variant }) + '\n');
  console.log(`[Shadow] 👥 Registered shadow: "${name}" (${variant}) for agent ${agentId}`);
  return { ok: true, shadowId: id, name, agentId, variant };
}

// ── Record a shadow/prod output pair ─────────────────────────────────────────
export function recordPair({ shadowId, input = '', prodOutput = '', shadowOutput = '', prodScore = null, shadowScore = null, latencyDeltaMs = 0 }) {
  const shadow = loadFromIndex(shadowId);
  if (!shadow) return { ok: false, reason: `Shadow ${shadowId} not found` };
  if (shadow.status !== 'active') return { ok: false, reason: 'Shadow is not active' };

  const sim   = bowSim(prodOutput, shadowOutput);
  const agree = sim >= 0.80;

  // Quality comparison
  let qualityVerdict = 'tie';
  if (prodScore !== null && shadowScore !== null) {
    if (shadowScore > prodScore + 0.5)  qualityVerdict = 'shadow_wins';
    else if (shadowScore < prodScore - 0.5) qualityVerdict = 'prod_wins';
  }

  shadow.stats.total++;
  if (agree) shadow.stats.agree++;
  if (qualityVerdict === 'shadow_wins') shadow.stats.qualityWin++;
  else if (qualityVerdict === 'prod_wins') shadow.stats.qualityLose++;
  else shadow.stats.qualityTie++;

  // Rolling avg latency delta
  const n = shadow.stats.total;
  shadow.stats.avgLatencyDelta = ((shadow.stats.avgLatencyDelta * (n - 1)) + latencyDeltaMs) / n;

  // Keep last 20 samples
  shadow.samples = [...shadow.samples.slice(-19), { input: input.slice(0, 50), sim, agree, qualityVerdict, prodScore, shadowScore, latencyDeltaMs, ts: Date.now() }];

  const agreementRate = Math.round((shadow.stats.agree / shadow.stats.total) * 100);
  shadow.stats.agreementRate = agreementRate;

  // Auto-decision: >20 samples + ≥95% agree + quality neutral/win → recommend promote
  if (shadow.stats.total >= 20 && agreementRate >= 95 && shadow.stats.qualityLose < 2) {
    shadow.recommendation = 'PROMOTE';
    console.log(`[Shadow] ✅ PROMOTE recommended: "${shadow.name}" agreement=${agreementRate}% quality_wins=${shadow.stats.qualityWin}`);
  } else if (shadow.stats.total >= 20 && agreementRate < 70) {
    shadow.recommendation = 'DISCARD';
    console.log(`[Shadow] ❌ DISCARD recommended: "${shadow.name}" agreement=${agreementRate}%`);
  }

  saveToIndex(shadowId, shadow);
  console.log(`[Shadow] 📊 ${shadowId} sample #${n}: sim=${sim} agree=${agree} quality=${qualityVerdict} latDelta=${latencyDeltaMs}ms`);
  return { ok: true, shadowId, sample: n, sim, agree, qualityVerdict, agreementRate, recommendation: shadow.recommendation || null };
}

// ── Get shadow stats ──────────────────────────────────────────────────────────
export function getShadow(shadowId) {
  const s = loadFromIndex(shadowId);
  if (!s) return { ok: false, reason: 'Not found' };
  return { ...s, ok: true };
}

// ── Promote / Discard ─────────────────────────────────────────────────────────
export function promoteShadow(shadowId) {
  const shadow = loadFromIndex(shadowId);
  if (!shadow) return { ok: false, reason: 'Not found' };
  shadow.status = 'promoted'; shadow.promotedAt = Date.now();
  saveToIndex(shadowId, shadow);
  fs.appendFileSync(SHADOW_LOG, JSON.stringify({ ts: Date.now(), action: 'promote', shadowId, agreementRate: shadow.stats.agreementRate }) + '\n');
  console.log(`[Shadow] 🚀 PROMOTED: "${shadow.name}" (${shadow.stats.agreementRate}% agreement, ${shadow.stats.total} samples)`);
  return { ok: true, shadowId, name: shadow.name, agreementRate: shadow.stats.agreementRate };
}

export function discardShadow(shadowId) {
  const shadow = loadFromIndex(shadowId);
  if (!shadow) return { ok: false, reason: 'Not found' };
  shadow.status = 'discarded'; shadow.discardedAt = Date.now();
  saveToIndex(shadowId, shadow);
  return { ok: true, shadowId };
}

// ── List active ───────────────────────────────────────────────────────────────
export function getActiveShadows() {
  const index = loadFullIndex();
  return Object.values(index).filter(s => s.status === 'active').map(s => ({ id: s.id, name: s.name, agentId: s.agentId, samples: s.stats.total, agreementRate: s.stats.agreementRate || 0, recommendation: s.recommendation || 'collecting' }));
}

function loadFromIndex(id) { const idx = loadFullIndex(); return idx[id] || null; }
function saveToIndex(id, data) { const idx = loadFullIndex(); idx[id] = data; try { fs.writeFileSync(SHADOW_INDEX, JSON.stringify(idx, null, 2)); } catch {} }
function loadFullIndex() { try { return JSON.parse(fs.readFileSync(SHADOW_INDEX, 'utf8')); } catch { return {}; } }
