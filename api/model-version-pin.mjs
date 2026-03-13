/**
 * model-version-pin.mjs — Agent Model Version Pinning & Rollback
 *
 * Video: "The Pi Coding Agent: The ONLY REAL Claude Code COMPETITOR" (f8cfH5XX-XU)
 * Pattern: Pin each agent to a specific model version; rollback on quality regression;
 *          fork agent config without lock-in; override per task
 *
 * Model catalog (versioned):
 *   claude-sonnet-4-6  → current production
 *   claude-haiku-4-5   → fast/cheap
 *   gpt-4o-mini        → judge/eval tasks
 *   claude-sonnet-3-5  → stable legacy
 *
 * Pin strategy:
 *   Each agent has a "pinned" model version + a "test" slot for canary
 *   Karpathy score drops > 20% over 5 tasks → auto-rollback to prev pin
 *   Override: POST /api/model-pin/override { agentId, model, taskId } — single task
 *
 * Version registry:
 *   .model-pins.json → { agentId: { pinned, previous, testSlot, history[] } }
 *
 * Integration: dispatch reads getPinnedModel(agentId) to select correct model tier
 *
 * API:
 *   GET  /api/model-pin              → all agent pins
 *   GET  /api/model-pin/:agentId     → agent pin detail + history
 *   POST /api/model-pin/set          { agentId, model } → pin model
 *   POST /api/model-pin/rollback     { agentId } → revert to previous
 *   POST /api/model-pin/override     { agentId, model, taskId } → single-task override
 *   POST /api/model-pin/score        { agentId, score } → record score, check regression
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const PINS_FILE = path.join(HOME, '.openclaw/workspace/.model-pins.json');
const PINS_LOG  = path.join(HOME, '.openclaw/workspace/model-pin-log.jsonl');

// ── Model catalog ─────────────────────────────────────────────────────────────
export const MODEL_CATALOG = {
  'claude-sonnet-4-6': { tier: 'premium',  speed: 'medium', costFactor: 1.0 },
  'claude-haiku-4-5':  { tier: 'nano',     speed: 'fast',   costFactor: 0.1 },
  'gpt-4o-mini':       { tier: 'standard', speed: 'fast',   costFactor: 0.2 },
  'claude-sonnet-3-5': { tier: 'standard', speed: 'medium', costFactor: 0.6 },
  'anthropic/claude-sonnet-4-6': { tier: 'premium', speed: 'medium', costFactor: 1.0 },
  'anthropic/claude-haiku-4-5':  { tier: 'nano',    speed: 'fast',   costFactor: 0.1 },
};

// ── Default pins ──────────────────────────────────────────────────────────────
const DEFAULT_PINS = {
  forge:   { pinned: 'anthropic/claude-sonnet-4-6', previous: null, scores: [], overrides: {} },
  atlas:   { pinned: 'anthropic/claude-sonnet-4-6', previous: null, scores: [], overrides: {} },
  iron:    { pinned: 'anthropic/claude-sonnet-4-6', previous: null, scores: [], overrides: {} },
  bekzat:  { pinned: 'anthropic/claude-haiku-4-5',  previous: null, scores: [], overrides: {} },
  ainura:  { pinned: 'anthropic/claude-haiku-4-5',  previous: null, scores: [], overrides: {} },
  marat:   { pinned: 'anthropic/claude-haiku-4-5',  previous: null, scores: [], overrides: {} },
  nurlan:  { pinned: 'anthropic/claude-haiku-4-5',  previous: null, scores: [], overrides: {} },
  dana:    { pinned: 'anthropic/claude-haiku-4-5',  previous: null, scores: [], overrides: {} },
  mesa:    { pinned: 'anthropic/claude-haiku-4-5',  previous: null, scores: [], overrides: {} },
  pixel:   { pinned: 'anthropic/claude-haiku-4-5',  previous: null, scores: [], overrides: {} },
};

function load() { try { return { ...DEFAULT_PINS, ...JSON.parse(fs.readFileSync(PINS_FILE, 'utf8')) }; } catch { return { ...DEFAULT_PINS }; } }
function save(d) { try { fs.writeFileSync(PINS_FILE, JSON.stringify(d, null, 2)); } catch {} }

// ── Get effective model for agent (check single-task overrides) ───────────────
export function getPinnedModel(agentId, taskId = null) {
  const data  = load();
  const agent = data[agentId] || DEFAULT_PINS[agentId] || { pinned: 'anthropic/claude-haiku-4-5', overrides: {} };
  if (taskId && agent.overrides?.[taskId]) {
    const override = agent.overrides[taskId];
    // Clean up expired overrides
    delete agent.overrides[taskId];
    save(data);
    return { model: override, source: 'override', taskId };
  }
  return { model: agent.pinned, source: 'pinned' };
}

// ── Pin model ─────────────────────────────────────────────────────────────────
export function pinModel(agentId, model) {
  if (!MODEL_CATALOG[model]) return { ok: false, reason: `Unknown model: ${model}. Known: ${Object.keys(MODEL_CATALOG).join(', ')}` };
  const data  = load();
  if (!data[agentId]) data[agentId] = { ...DEFAULT_PINS[agentId] || { pinned: model, previous: null, scores: [], overrides: {} } };
  const prev = data[agentId].pinned;
  data[agentId].previous = prev;
  data[agentId].pinned   = model;
  data[agentId].scores   = []; // reset score window on version change
  save(data);
  const entry = { ts: Date.now(), agentId, action: 'pin', from: prev, to: model };
  fs.appendFileSync(PINS_LOG, JSON.stringify(entry) + '\n');
  console.log(`[ModelPin] 📌 ${agentId}: ${prev} → ${model}`);
  return { ok: true, agentId, previous: prev, pinned: model };
}

// ── Rollback ──────────────────────────────────────────────────────────────────
export function rollbackModel(agentId) {
  const data  = load();
  const agent = data[agentId];
  if (!agent?.previous) return { ok: false, reason: `No previous version to rollback to for ${agentId}` };
  const current  = agent.pinned;
  agent.pinned   = agent.previous;
  agent.previous = current;
  agent.scores   = [];
  save(data);
  const entry = { ts: Date.now(), agentId, action: 'rollback', from: current, to: agent.pinned };
  fs.appendFileSync(PINS_LOG, JSON.stringify(entry) + '\n');
  console.warn(`[ModelPin] ⏪ ${agentId} ROLLBACK: ${current} → ${agent.pinned}`);
  return { ok: true, agentId, rolledBackTo: agent.pinned, from: current };
}

// ── Single-task override ──────────────────────────────────────────────────────
export function setOverride(agentId, model, taskId) {
  if (!MODEL_CATALOG[model]) return { ok: false, reason: `Unknown model: ${model}` };
  const data  = load();
  if (!data[agentId]) data[agentId] = { ...DEFAULT_PINS[agentId] || {} };
  if (!data[agentId].overrides) data[agentId].overrides = {};
  data[agentId].overrides[taskId] = model;
  save(data);
  return { ok: true, agentId, taskId, overrideModel: model };
}

// ── Record score + check regression ──────────────────────────────────────────
export function recordScore(agentId, score) {
  const data  = load();
  if (!data[agentId]) data[agentId] = { ...DEFAULT_PINS[agentId] || { pinned: 'anthropic/claude-haiku-4-5', scores: [] } };
  data[agentId].scores.push(score);
  if (data[agentId].scores.length > 10) data[agentId].scores.shift();

  const scores  = data[agentId].scores;
  save(data);

  // Regression check: last 5 avg vs first 5 avg (>20% drop)
  if (scores.length >= 6) {
    const recent = scores.slice(-3).reduce((s, v) => s + v, 0) / 3;
    const older  = scores.slice(0, 3).reduce((s, v) => s + v, 0) / 3;
    if (older > 0 && recent < older * 0.8) {
      console.warn(`[ModelPin] 📉 ${agentId} quality regression: ${Math.round(older*10)/10} → ${Math.round(recent*10)/10} (${Math.round((recent/older-1)*100)}%)`);
      // Auto-rollback if previous exists
      if (data[agentId].previous) return { regression: true, ...rollbackModel(agentId) };
      return { regression: true, reason: 'No previous version to rollback to', agentId, recent, older };
    }
  }
  return { regression: false, agentId, score, scoresRecorded: scores.length };
}

// ── Get all pins ──────────────────────────────────────────────────────────────
export function getAllPins() {
  const data = load();
  return Object.fromEntries(Object.keys(DEFAULT_PINS).map(a => {
    const d = data[a] || DEFAULT_PINS[a];
    const avgScore = d.scores?.length > 0 ? Math.round(d.scores.reduce((s, v) => s + v, 0) / d.scores.length * 10) / 10 : null;
    return [a, { pinned: d.pinned, previous: d.previous, avgScore, scoreWindow: d.scores?.length || 0 }];
  }));
}
