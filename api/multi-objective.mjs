/**
 * multi-objective.mjs — Multi-Objective Optimization & Pareto Trade-off Resolution
 *
 * Video: "NRF 2026 - AWS Supply Chain: AI Agents Detect Disruptions & Optimize Inventory" (97iYJyHQ7Uw)
 * Pattern: Competing goals (speed vs quality vs cost) resolved via Pareto frontier
 *
 * When multiple dispatch options exist (which agent? which model? which strategy?),
 * score each option across N objectives and find the Pareto-dominant choice.
 *
 * Objectives (configurable weights, must sum to 1.0):
 *   speed:   how fast will this likely complete? (based on scheduler histogram)
 *   quality: expected output quality (based on agent's Karpathy rolling avg)
 *   cost:    estimated token cost (based on model tier)
 *   risk:    blast radius + confidence risk
 *
 * Pareto dominance: option A dominates B if A is ≥ B on all objectives AND > B on at least one
 * If no single dominant option → use weighted scoring (compromise solution)
 *
 * Use cases:
 *   1. Which agent to dispatch to? (bekzat vs ainura for a full-stack task)
 *   2. Which model tier? (nano vs standard vs premium)
 *   3. Which retry strategy? (immediate vs backoff vs escalate)
 *
 * API:
 *   POST /api/objectives/rank  { options: [{id, speed, quality, cost, risk}], weights? }
 *   GET  /api/objectives/weights → current default weights
 *   POST /api/objectives/weights → update weights
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME        = os.homedir();
const WEIGHTS_FILE = path.join(HOME, '.openclaw/workspace/.objective-weights.json');
const OBJ_LOG     = path.join(HOME, '.openclaw/workspace/objectives-log.jsonl');

// ── Default weights ───────────────────────────────────────────────────────────
const DEFAULT_WEIGHTS = { speed: 0.3, quality: 0.4, cost: 0.2, risk: 0.1 };

function loadWeights() { try { return JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8')); } catch { return { ...DEFAULT_WEIGHTS }; } }

// ── Normalize all options to [0,1] per objective ──────────────────────────────
function normalize(options, key) {
  const vals = options.map(o => o[key] || 0);
  const min  = Math.min(...vals);
  const max  = Math.max(...vals);
  if (max === min) return options.map(() => 0.5);
  return vals.map(v => (v - min) / (max - min));
}

// ── Pareto dominance check ────────────────────────────────────────────────────
// Higher is better for speed, quality; lower is better for cost, risk
// Normalize so higher = better for all
function isDominated(a, b, objectives) {
  // a is dominated by b if b >= a on all and b > a on at least one
  let allGe = true, atLeastOne = false;
  for (const obj of objectives) {
    if (b[obj] < a[obj]) { allGe = false; break; }
    if (b[obj] > a[obj]) atLeastOne = true;
  }
  return allGe && atLeastOne;
}

// ── Rank options ──────────────────────────────────────────────────────────────
export function rankOptions(rawOptions = [], customWeights = null) {
  if (rawOptions.length === 0) return { ranked: [], paretoFront: [], recommendation: null };

  const weights = { ...loadWeights(), ...(customWeights || {}) };
  const OBJECTIVES = ['speed', 'quality', 'cost_inv', 'risk_inv'];

  // Invert cost and risk (lower = better → invert for Pareto)
  const options = rawOptions.map(o => ({
    ...o,
    cost_inv: 1 - (o.cost || 0),
    risk_inv: 1 - (o.risk || 0),
  }));

  // Normalize each objective
  const norms = {};
  for (const obj of OBJECTIVES) {
    const ns = normalize(options, obj);
    options.forEach((o, i) => { if (!norms[o.id]) norms[o.id] = {}; norms[o.id][obj] = ns[i]; });
  }

  // Map weights to normalized objectives
  const effectiveWeights = { speed: weights.speed, quality: weights.quality, cost_inv: weights.cost, risk_inv: weights.risk };

  // Weighted score
  const scored = options.map(o => {
    const norm = norms[o.id];
    const score = OBJECTIVES.reduce((s, obj) => s + (effectiveWeights[obj] || 0) * (norm[obj] || 0), 0);
    return { ...o, _norm: norm, _score: Math.round(score * 1000) / 1000 };
  }).sort((a, b) => b._score - a._score);

  // Pareto front (non-dominated set)
  const paretoFront = scored.filter(a => !scored.some(b => b.id !== a.id && isDominated(norms[a.id], norms[b.id], OBJECTIVES)));

  const recommendation = scored[0];
  const entry = { ts: Date.now(), optionCount: rawOptions.length, recommendation: recommendation?.id, paretoSize: paretoFront.length, weights };
  try { fs.appendFileSync(OBJ_LOG, JSON.stringify(entry) + '\n'); } catch {}

  console.log(`[MultiObj] 🎯 Best: '${recommendation?.id}' (score=${recommendation?._score}) | Pareto front: ${paretoFront.length} options`);

  return {
    ranked: scored.map(o => ({ id: o.id, score: o._score, norm: o._norm })),
    paretoFront: paretoFront.map(o => o.id),
    recommendation: { id: recommendation?.id, score: recommendation?._score, reason: `Highest weighted score across speed(${weights.speed})/quality(${weights.quality})/cost(${weights.cost})/risk(${weights.risk})` },
    weights,
  };
}

export function getWeights() { return loadWeights(); }
export function updateWeights(w) {
  const current = loadWeights();
  const updated = { ...current, ...w };
  const sum = Object.values(updated).reduce((s, v) => s + v, 0);
  if (Math.abs(sum - 1.0) > 0.05) return { ok: false, reason: `Weights must sum to ~1.0 (got ${sum.toFixed(2)})` };
  try { fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(updated, null, 2)); } catch {}
  return { ok: true, weights: updated };
}

// ── Helper: build options from dispatch context ───────────────────────────────
export function buildAgentOptions(candidates = [], histData = {}, karpathyData = {}) {
  const COST_TIER = { forge: 0.9, atlas: 0.9, iron: 0.5, bekzat: 0.5, ainura: 0.5, marat: 0.3, nurlan: 0.4, dana: 0.2, mesa: 0.3, pixel: 0.3 };
  return candidates.map(agentId => ({
    id:      agentId,
    speed:   1 - Math.min(1, (histData[agentId]?.avgLoad || 0) / 10),
    quality: Math.min(1, (karpathyData[agentId] || 7) / 10),
    cost:    COST_TIER[agentId] || 0.5,
    risk:    ['forge', 'atlas'].includes(agentId) ? 0.1 : 0.3,
  }));
}
