/**
 * adaptive-sampler.mjs — Adaptive Polling Frequency Scheduler
 *
 * Video: "Perceptive Humanoid Parkour: Chaining Dynamic Human Skills" (1zBqT7kqkWM)
 * Pattern: Adaptive sampling from robotics training — agent adjusts HOW OFTEN it checks
 *   based on failure rate, urgency, and cost. Instead of uniform polling:
 *   - Failing tasks → poll more frequently (catch regressions fast)
 *   - Stable tasks → poll less frequently (save tokens/CPU)
 *   - Critical agents → high-frequency baseline
 *   - Idle agents → minimal polling
 *
 * Sampling tiers (polling interval):
 *   CRITICAL   —  30s  (agent in crisis, failures detected)
 *   HIGH       —  2min (recent failures, elevated watch)
 *   NORMAL     —  5min (standard operation)
 *   LOW        — 15min (stable, healthy agent)
 *   MINIMAL    — 60min (idle, no tasks in queue)
 *
 * Tier transitions:
 *   3+ failures in last hour   → CRITICAL
 *   1-2 failures in last hour  → HIGH
 *   0 failures, queue > 0      → NORMAL
 *   0 failures, queue = 0      → LOW → MINIMAL (after 30min idle)
 *
 * API:
 *   POST /api/sample/report    { agentId, event: 'failure'|'success'|'idle' } → update tier
 *   GET  /api/sample/:agentId  → current tier + interval
 *   GET  /api/sample/schedule  → all agents with their poll intervals
 *   POST /api/sample/tick      { agentId } → should we poll this agent right now?
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME        = os.homedir();
const SAMPLE_FILE = path.join(HOME, '.openclaw/workspace/.sample-state.json');
const SAMPLE_LOG  = path.join(HOME, '.openclaw/workspace/sample-log.jsonl');

// ── Tier definitions (interval in ms) ────────────────────────────────────────
const TIERS = {
  CRITICAL: { interval: 30 * 1000,      label: 'CRITICAL', emoji: '🚨', desc: 'Crisis mode — 30s polling' },
  HIGH:     { interval: 2 * 60 * 1000,  label: 'HIGH',     emoji: '⚠️',  desc: 'Elevated watch — 2min' },
  NORMAL:   { interval: 5 * 60 * 1000,  label: 'NORMAL',   emoji: '🟡', desc: 'Standard — 5min' },
  LOW:      { interval: 15 * 60 * 1000, label: 'LOW',      emoji: '🟢', desc: 'Stable — 15min' },
  MINIMAL:  { interval: 60 * 60 * 1000, label: 'MINIMAL',  emoji: '💤', desc: 'Idle — 60min' },
};

// ── Agent baseline tiers (before any events) ─────────────────────────────────
const AGENT_BASELINES = {
  forge: 'NORMAL', atlas: 'NORMAL', iron: 'NORMAL',
  bekzat: 'NORMAL', ainura: 'LOW', marat: 'NORMAL',
  nurlan: 'LOW', dana: 'LOW', mesa: 'LOW', pixel: 'MINIMAL',
};

// ── Load / save state ─────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(SAMPLE_FILE, 'utf8')); }
  catch {
    const init = {};
    for (const [a, tier] of Object.entries(AGENT_BASELINES)) {
      init[a] = { tier, failures: [], successes: [], lastPollAt: 0, idleSince: Date.now() };
    }
    return init;
  }
}
function saveState(d) { try { fs.writeFileSync(SAMPLE_FILE, JSON.stringify(d, null, 2)); } catch {} }

// ── Recalculate tier based on recent history ──────────────────────────────────
function recalcTier(agentData) {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;

  // Count failures in last hour
  const recentFailures = (agentData.failures || []).filter(ts => now - ts < oneHour);
  const hasQueue = agentData.hasQueue || false;
  const idleMs   = now - (agentData.idleSince || now);

  if (recentFailures.length >= 3) return 'CRITICAL';
  if (recentFailures.length >= 1) return 'HIGH';
  if (hasQueue) return 'NORMAL';
  if (idleMs > 30 * 60 * 1000) return 'MINIMAL';  // idle 30+ min
  return 'LOW';
}

// ── Report an event (failure/success/idle) ────────────────────────────────────
export function reportEvent({ agentId, event, hasQueue = false }) {
  const state = loadState();
  if (!state[agentId]) state[agentId] = { tier: 'NORMAL', failures: [], successes: [], lastPollAt: 0, idleSince: Date.now() };

  const agent = state[agentId];
  const now   = Date.now();

  if (event === 'failure') {
    agent.failures = [...(agent.failures || []), now].slice(-20);  // keep last 20
    agent.idleSince = now;  // reset idle timer on activity
    agent.hasQueue  = hasQueue;
  } else if (event === 'success') {
    agent.successes = [...(agent.successes || []), now].slice(-20);
    agent.idleSince = now;
    agent.hasQueue  = hasQueue;
  } else if (event === 'idle') {
    // Don't update idleSince if already idle
    agent.hasQueue = false;
  }

  const prevTier = agent.tier;
  const newTier  = recalcTier(agent);
  agent.tier     = newTier;

  saveState(state);

  const tierChanged = prevTier !== newTier;
  const tierDef = TIERS[newTier];
  if (tierChanged) {
    console.log(`[AdaptiveSampler] ${tierDef.emoji} ${agentId}: ${prevTier} → ${newTier} (${event})`);
    fs.appendFileSync(SAMPLE_LOG, JSON.stringify({ ts: now, agentId, event, prevTier, newTier }) + '\n');
  }

  return { agentId, event, tier: newTier, interval: tierDef.interval, tierChanged, prevTier };
}

// ── Should we poll this agent right now? ──────────────────────────────────────
export function shouldPoll({ agentId }) {
  const state = loadState();
  const agent = state[agentId] || { tier: 'NORMAL', lastPollAt: 0 };
  const tier  = TIERS[agent.tier] || TIERS.NORMAL;
  const now   = Date.now();
  const elapsed = now - (agent.lastPollAt || 0);
  const due = elapsed >= tier.interval;

  if (due) {
    // Update last poll time
    if (state[agentId]) { state[agentId].lastPollAt = now; saveState(state); }
    console.log(`[AdaptiveSampler] 🔍 Poll ${agentId} (${tier.label}, ${Math.round(elapsed / 1000)}s since last)`);
  }

  return { agentId, poll: due, tier: agent.tier, intervalMs: tier.interval, elapsedMs: elapsed, nextPollIn: due ? 0 : tier.interval - elapsed };
}

// ── Get agent sampling status ─────────────────────────────────────────────────
export function getAgentSampling(agentId) {
  const state = loadState();
  const agent = state[agentId] || { tier: 'NORMAL', failures: [], lastPollAt: 0 };
  const tier  = TIERS[agent.tier] || TIERS.NORMAL;
  const now   = Date.now();
  const recentFailures = (agent.failures || []).filter(ts => now - ts < 60 * 60 * 1000).length;
  return { agentId, tier: agent.tier, emoji: tier.emoji, intervalMs: tier.interval, desc: tier.desc, recentFailures, lastPollAt: agent.lastPollAt };
}

// ── Full schedule ─────────────────────────────────────────────────────────────
export function getSchedule() {
  const state = loadState();
  return Object.entries(state).map(([agentId, data]) => {
    const tier = TIERS[data.tier] || TIERS.NORMAL;
    return { agentId, tier: data.tier, emoji: tier.emoji, intervalSec: tier.interval / 1000 };
  }).sort((a, b) => a.intervalSec - b.intervalSec);
}
