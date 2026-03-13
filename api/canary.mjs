/**
 * canary.mjs — Canary Rollout & Auto-Rollback for Agent Capabilities
 *
 * Video: "Multi-Agent Systems Explained | AutoGen & CrewAI 2026" (jKEgaQPmJz0)
 * Pattern: Gradual capability rollout with automatic rollback on regression
 *
 * Use case: When introducing new dispatch pipeline features (new module, new prompt
 * strategy, new agent), don't flip 100% immediately. Roll out gradually:
 *   0% → 10% → 25% → 50% → 100% (canary stages)
 *
 * Rollback trigger: If error rate > threshold in canary group → auto-rollback to 0%
 *
 * Canary tracks:
 *   { featureId, stage, pct, errorCount, successCount, rollbackThreshold, status }
 *
 * Stage progression rules:
 *   Auto-advance: after minSuccesses in current stage with errorRate < threshold
 *   Auto-rollback: errorRate > rollbackThreshold → status='rolled_back', pct=0
 *
 * Implementation: deterministic routing via hash(taskId + featureId) % 100 < pct
 *
 * API:
 *   POST /api/canary/register  { featureId, description, rollbackThreshold=0.15, startPct=10 }
 *   GET  /api/canary           → all canary features + status
 *   POST /api/canary/advance/:featureId  → force advance to next stage (admin)
 *   POST /api/canary/rollback/:featureId → force rollback (admin)
 *   POST /api/canary/record    { featureId, taskId, success }  → record outcome
 *   GET  /api/canary/:featureId → feature status + metrics
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { createHash } from 'node:crypto';

const HOME        = os.homedir();
const CANARY_FILE = path.join(HOME, '.openclaw/workspace/.canary-state.json');
const CANARY_LOG  = path.join(HOME, '.openclaw/workspace/canary-log.jsonl');

// ── Canary stages ─────────────────────────────────────────────────────────────
const STAGES = [0, 10, 25, 50, 100];
const MIN_SAMPLES_PER_STAGE = 10; // min outcomes before advancing/rolling back

// ── Load/save ─────────────────────────────────────────────────────────────────
function load() { try { return JSON.parse(fs.readFileSync(CANARY_FILE, 'utf8')); } catch { return {}; } }
function save(d) { try { fs.writeFileSync(CANARY_FILE, JSON.stringify(d, null, 2)); } catch {} }

// ── Register a new feature for canary rollout ─────────────────────────────────
export function registerCanary({ featureId, description = '', rollbackThreshold = 0.15, startPct = 10 }) {
  const state = load();
  if (state[featureId]) return { ok: false, reason: 'already registered', current: state[featureId] };

  const stageIdx = STAGES.indexOf(startPct);
  state[featureId] = {
    featureId, description,
    pct: startPct, stageIdx: stageIdx >= 0 ? stageIdx : 1,
    status: 'canary',        // canary | stable | rolled_back
    rollbackThreshold,
    errorCount: 0, successCount: 0,
    history: [{ ts: Date.now(), event: 'registered', pct: startPct }],
    registeredAt: new Date().toISOString(),
  };
  save(state);
  const entry = { ts: Date.now(), featureId, event: 'registered', pct: startPct, description };
  fs.appendFileSync(CANARY_LOG, JSON.stringify(entry) + '\n');
  console.log(`[Canary] 🐤 Registered '${featureId}' at ${startPct}%`);
  return { ok: true, feature: state[featureId] };
}

// ── Is task in canary group? (deterministic) ──────────────────────────────────
export function inCanaryGroup(featureId, taskId = '') {
  const state = load();
  const feat = state[featureId];
  if (!feat || feat.status === 'rolled_back') return false;
  if (feat.status === 'stable' || feat.pct >= 100) return true;

  const hash = createHash('md5').update(featureId + taskId).digest('hex');
  const bucket = parseInt(hash.slice(0, 8), 16) % 100;
  return bucket < feat.pct;
}

// ── Record outcome ────────────────────────────────────────────────────────────
export function recordOutcome({ featureId, taskId = '', success = true }) {
  const state = load();
  const feat = state[featureId];
  if (!feat) return { ok: false, reason: 'not registered' };

  if (success) feat.successCount++;
  else feat.errorCount++;

  const total = feat.errorCount + feat.successCount;
  const errorRate = total > 0 ? feat.errorCount / total : 0;

  const entry = { ts: Date.now(), featureId, taskId, success, errorRate: Math.round(errorRate * 100) / 100 };
  fs.appendFileSync(CANARY_LOG, JSON.stringify(entry) + '\n');

  // Rollback check
  if (total >= MIN_SAMPLES_PER_STAGE && errorRate > feat.rollbackThreshold) {
    feat.status = 'rolled_back';
    feat.pct = 0;
    feat.history.push({ ts: Date.now(), event: 'auto_rollback', errorRate, total });
    save(state);
    console.error(`[Canary] 🚨 AUTO-ROLLBACK '${featureId}': errorRate=${Math.round(errorRate * 100)}% > ${Math.round(feat.rollbackThreshold * 100)}% (${total} samples)`);
    return { ok: true, action: 'rolled_back', errorRate };
  }

  // Auto-advance check
  if (total >= MIN_SAMPLES_PER_STAGE && errorRate <= feat.rollbackThreshold * 0.5 && feat.status === 'canary') {
    const nextIdx = feat.stageIdx + 1;
    if (nextIdx < STAGES.length) {
      const prevPct = feat.pct;
      feat.stageIdx = nextIdx;
      feat.pct = STAGES[nextIdx];
      feat.errorCount = 0; feat.successCount = 0; // reset for new stage
      feat.history.push({ ts: Date.now(), event: 'auto_advance', from: prevPct, to: feat.pct });
      if (feat.pct >= 100) feat.status = 'stable';
      save(state);
      console.log(`[Canary] 🚀 '${featureId}' advanced: ${prevPct}% → ${feat.pct}%${feat.status === 'stable' ? ' (STABLE ✅)' : ''}`);
      return { ok: true, action: 'advanced', from: prevPct, to: feat.pct };
    }
  }

  save(state);
  return { ok: true, action: 'recorded', errorRate: Math.round(errorRate * 100) / 100, total };
}

// ── Force advance / rollback ──────────────────────────────────────────────────
export function forceAdvance(featureId) {
  const state = load();
  const feat = state[featureId];
  if (!feat) return { ok: false };
  const nextIdx = Math.min(feat.stageIdx + 1, STAGES.length - 1);
  const prev = feat.pct;
  feat.stageIdx = nextIdx; feat.pct = STAGES[nextIdx];
  feat.status = feat.pct >= 100 ? 'stable' : 'canary';
  feat.errorCount = 0; feat.successCount = 0;
  feat.history.push({ ts: Date.now(), event: 'forced_advance', from: prev, to: feat.pct });
  save(state);
  fs.appendFileSync(CANARY_LOG, JSON.stringify({ ts: Date.now(), featureId, event: 'forced_advance', from: prev, to: feat.pct }) + '\n');
  return { ok: true, from: prev, to: feat.pct };
}

export function forceRollback(featureId) {
  const state = load();
  const feat = state[featureId];
  if (!feat) return { ok: false };
  const prev = feat.pct;
  feat.status = 'rolled_back'; feat.pct = 0;
  feat.history.push({ ts: Date.now(), event: 'forced_rollback', from: prev });
  save(state);
  fs.appendFileSync(CANARY_LOG, JSON.stringify({ ts: Date.now(), featureId, event: 'forced_rollback', from: prev }) + '\n');
  console.warn(`[Canary] ↩️  FORCE ROLLBACK '${featureId}' from ${prev}%`);
  return { ok: true, rolledBack: featureId };
}

export function getAllCanaries() { return load(); }
export function getCanary(featureId) { return load()[featureId] || null; }
