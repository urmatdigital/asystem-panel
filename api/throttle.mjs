/**
 * throttle.mjs — Per-Agent Rate Limiting with Exponential Backoff & Jitter
 *
 * Video: "Your AI Agent Security Strategy Is Broken" (PHfxLd6eVFM)
 * + Standard production retry pattern (Full Jitter — AWS recommendation)
 *
 * Per-agent quotas (per minute / per hour / per day):
 *   Primary agents (forge/atlas): unlimited
 *   Heavy agents (bekzat/ainura): 10/min, 100/hr, 500/day
 *   Review agents (marat/nurlan): 5/min, 50/hr, 200/day
 *   Planning agents (dana/mesa/pixel): 3/min, 30/hr, 100/day
 *   Iron: 10/min, 80/hr, 400/day
 *
 * Exponential backoff with Full Jitter (when throttled):
 *   base = 1s, cap = 60s
 *   sleep = random_between(0, min(cap, base * 2^attempt))
 *
 * API:
 *   POST /api/throttle/check { agentId } → { allowed, retryAfterMs, quotaStatus }
 *   GET  /api/throttle/status           → all agents quota status
 *   POST /api/throttle/reset/:agentId   → force reset (admin)
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME         = os.homedir();
const THROTTLE_LOG = path.join(HOME, '.openclaw/workspace/throttle-log.jsonl');
const STATE_FILE   = path.join(HOME, '.openclaw/workspace/.throttle-state.json');

// ── Quotas ────────────────────────────────────────────────────────────────────
const QUOTAS = {
  forge:  { perMin: Infinity, perHr: Infinity, perDay: Infinity },
  atlas:  { perMin: Infinity, perHr: Infinity, perDay: Infinity },
  bekzat: { perMin: 10,  perHr: 100, perDay: 500 },
  ainura: { perMin: 10,  perHr: 100, perDay: 500 },
  marat:  { perMin: 5,   perHr: 50,  perDay: 200 },
  nurlan: { perMin: 5,   perHr: 50,  perDay: 200 },
  dana:   { perMin: 3,   perHr: 30,  perDay: 100 },
  mesa:   { perMin: 3,   perHr: 30,  perDay: 100 },
  pixel:  { perMin: 3,   perHr: 30,  perDay: 100 },
  iron:   { perMin: 10,  perHr: 80,  perDay: 400 },
};
const DEFAULT_QUOTA = { perMin: 5, perHr: 50, perDay: 200 };

// ── Load/save state ───────────────────────────────────────────────────────────
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch {} }

// ── Window counters ───────────────────────────────────────────────────────────
function getWindows(timestamps) {
  const now = Date.now();
  const min = timestamps.filter(t => now - t < 60_000).length;
  const hr  = timestamps.filter(t => now - t < 3_600_000).length;
  const day = timestamps.filter(t => now - t < 86_400_000).length;
  return { min, hr, day };
}

// ── Exponential backoff with Full Jitter (AWS recommendation) ─────────────────
export function backoffMs(attempt, baseSec = 1, capSec = 60) {
  const base = baseSec * 1000;
  const cap  = capSec  * 1000;
  const ceiling = Math.min(cap, base * Math.pow(2, attempt));
  return Math.floor(Math.random() * ceiling); // Full Jitter
}

// ── Check & record throttle ───────────────────────────────────────────────────
export function checkThrottle(agentId) {
  if (agentId === 'forge' || agentId === 'atlas') return { allowed: true, reason: 'bypass', quotaStatus: null };

  const quota  = QUOTAS[agentId] || DEFAULT_QUOTA;
  const state  = loadState();
  if (!state[agentId]) state[agentId] = { timestamps: [], violations: 0 };

  // Prune old timestamps (> 24h)
  const now = Date.now();
  state[agentId].timestamps = state[agentId].timestamps.filter(t => now - t < 86_400_000);

  const { min, hr, day } = getWindows(state[agentId].timestamps);
  const quotaStatus = {
    perMin: { used: min, limit: quota.perMin, pct: quota.perMin === Infinity ? 0 : Math.round(min / quota.perMin * 100) },
    perHr:  { used: hr,  limit: quota.perHr,  pct: quota.perHr  === Infinity ? 0 : Math.round(hr  / quota.perHr  * 100) },
    perDay: { used: day, limit: quota.perDay, pct: quota.perDay === Infinity ? 0 : Math.round(day / quota.perDay * 100) },
  };

  let blocked = null;
  if (min  >= quota.perMin)  blocked = { window: 'minute', limit: quota.perMin,  used: min,  retryAfterMs: 60_000 };
  if (!blocked && hr   >= quota.perHr)  blocked = { window: 'hour',   limit: quota.perHr,   used: hr,   retryAfterMs: 3_600_000 };
  if (!blocked && day  >= quota.perDay) blocked = { window: 'day',    limit: quota.perDay,  used: day,  retryAfterMs: 86_400_000 };

  if (blocked) {
    state[agentId].violations = (state[agentId].violations || 0) + 1;
    const attempt = state[agentId].violations;
    const jitter  = backoffMs(attempt);
    const retryMs = Math.max(blocked.retryAfterMs, jitter);
    saveState(state);
    const entry = { ts: now, agentId, blocked: true, window: blocked.window, used: blocked.used, limit: blocked.limit, retryAfterMs: retryMs, attempt };
    fs.appendFileSync(THROTTLE_LOG, JSON.stringify(entry) + '\n');
    console.warn(`[Throttle] ⏸️  ${agentId} throttled (${blocked.window}: ${blocked.used}/${blocked.limit}) → retry in ${Math.round(retryMs / 1000)}s`);
    return { allowed: false, reason: `${blocked.window} quota exceeded`, retryAfterMs: retryMs, quotaStatus };
  }

  // Allow — record timestamp
  state[agentId].timestamps.push(now);
  state[agentId].violations = 0; // reset violations on success
  saveState(state);
  return { allowed: true, quotaStatus };
}

// ── Status for all agents ─────────────────────────────────────────────────────
export function getThrottleStatus() {
  const state = loadState();
  const result = {};
  for (const [agentId, quota] of Object.entries(QUOTAS)) {
    const ts = state[agentId]?.timestamps || [];
    const { min, hr, day } = getWindows(ts);
    result[agentId] = {
      perMin: `${min}/${quota.perMin === Infinity ? '∞' : quota.perMin}`,
      perHr:  `${hr}/${quota.perHr   === Infinity ? '∞' : quota.perHr}`,
      perDay: `${day}/${quota.perDay  === Infinity ? '∞' : quota.perDay}`,
      violations: state[agentId]?.violations || 0,
    };
  }
  return result;
}

export function resetThrottle(agentId) {
  const state = loadState();
  state[agentId] = { timestamps: [], violations: 0 };
  saveState(state);
  return { reset: true, agentId };
}
