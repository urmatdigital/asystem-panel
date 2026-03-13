/**
 * rate-limiter.mjs — Per-agent rate limiting + circuit breaker
 *
 * Video: "Your AI Agent Security Strategy Is Broken"
 * Pattern: 3P Framework — Purpose/Privilege/Protection
 *   • Purpose:   agents have defined job descriptions (scope)
 *   • Privilege: per-agent dispatch limits (junior dev with credit card)
 *   • Protection: circuit breaker + spend cap + 5-min pulse check
 *
 * Storage: ~/.openclaw/workspace/.rate-limits.json (ephemeral, reset hourly)
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME        = os.homedir();
const STATE_FILE  = path.join(HOME, '.openclaw/workspace/.rate-limits.json');
const AUDIT_LOG   = path.join(HOME, '.openclaw/workspace/audit-log.jsonl');

// Per-agent limits (dispatches per hour)
const AGENT_LIMITS = {
  forge:        { perHour: 500, burstPerMin: 30, priority: 'primary' },
  atlas:        { perHour: 500, burstPerMin: 30, priority: 'primary' },
  iron:         { perHour: 200, burstPerMin: 20, priority: 'secondary' },
  mesa:         { perHour: 200, burstPerMin: 20, priority: 'secondary' },
  bekzat:       { perHour: 100, burstPerMin: 10, priority: 'worker' },
  ainura:       { perHour: 100, burstPerMin: 10, priority: 'worker' },
  marat:        { perHour: 100, burstPerMin: 10, priority: 'worker' },
  nurlan:       { perHour: 100, burstPerMin: 10, priority: 'worker' },
  dana:         { perHour:  50, burstPerMin:  5, priority: 'worker' },
  pixel:        { perHour:  50, burstPerMin:  5, priority: 'worker' },
  // Special: internal system processes exempt
  'health-monitor':     { perHour: 9999, burstPerMin: 999, priority: 'system' },
  'loop-guard':         { perHour: 9999, burstPerMin: 999, priority: 'system' },
  'cost-guard':         { perHour: 9999, burstPerMin: 999, priority: 'system' },
  'task-loop-escalation': { perHour: 9999, burstPerMin: 999, priority: 'system' },
  'fractals-decomposer':{ perHour: 9999, burstPerMin: 999, priority: 'system' },
  'dlq-retry':          { perHour: 9999, burstPerMin: 999, priority: 'system' },
  'checkpoint-recovery':{ perHour: 9999, burstPerMin: 999, priority: 'system' },
  'unknown':            { perHour: 60,  burstPerMin:  5, priority: 'unknown' },
};
const DEFAULT_LIMIT = { perHour: 60, burstPerMin: 5, priority: 'unknown' };

// Circuit breaker state (in-memory)
const circuitBreakers = new Map(); // agentId → { state: 'closed'|'open'|'half-open', openedAt, failures }
const CIRCUIT_OPEN_DURATION = 5 * 60_000; // 5 min
const CIRCUIT_FAIL_THRESHOLD = 10;         // 10 failures → open circuit

// ── State persistence ─────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
}

// ── Core: check rate limit ────────────────────────────────────────────────────
export function checkRateLimit(agentId) {
  const limits = AGENT_LIMITS[agentId] || DEFAULT_LIMIT;
  if (limits.priority === 'system') return { ok: true, reason: 'system-exempt' };

  const now = Date.now();
  const state = loadState();
  const key = agentId;

  if (!state[key]) state[key] = { hour: { ts: now, count: 0 }, min: { ts: now, count: 0 } };
  const s = state[key];

  // Reset windows
  if (now - s.hour.ts > 3_600_000) { s.hour = { ts: now, count: 0 }; }
  if (now - s.min.ts  >    60_000) { s.min  = { ts: now, count: 0 }; }

  // Check circuit breaker
  const cb = circuitBreakers.get(key) || { state: 'closed', failures: 0 };
  if (cb.state === 'open') {
    if (now - cb.openedAt < CIRCUIT_OPEN_DURATION) {
      return { ok: false, reason: `circuit_open for ${agentId} (too many failures, retry in ${Math.round((CIRCUIT_OPEN_DURATION - (now - cb.openedAt))/60000)}min)`, circuitBreaker: true };
    }
    cb.state = 'half-open';
    circuitBreakers.set(key, cb);
  }

  // Check burst (per minute)
  if (s.min.count >= limits.burstPerMin) {
    return { ok: false, reason: `burst_limit for ${agentId}: ${s.min.count}/${limits.burstPerMin} per min`, retryAfterSec: 60 };
  }

  // Check hourly
  if (s.hour.count >= limits.perHour) {
    return { ok: false, reason: `hourly_limit for ${agentId}: ${s.hour.count}/${limits.perHour} per hour`, retryAfterSec: Math.round((3_600_000 - (now - s.hour.ts)) / 1000) };
  }

  // Increment counters
  s.hour.count++;
  s.min.count++;
  state[key] = s;
  saveState(state);

  return { ok: true, used: { hour: s.hour.count, min: s.min.count }, limits };
}

// ── Record failure (feeds circuit breaker) ────────────────────────────────────
export function recordAgentFailure(agentId) {
  const cb = circuitBreakers.get(agentId) || { state: 'closed', failures: 0 };
  cb.failures++;
  if (cb.failures >= CIRCUIT_FAIL_THRESHOLD && cb.state === 'closed') {
    cb.state = 'open';
    cb.openedAt = Date.now();
    console.warn(`[RateLimit] 🔴 Circuit OPEN for ${agentId} (${cb.failures} failures)`);
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ts: Date.now(), type: 'circuit.open', agentId, failures: cb.failures }) + '\n');
  }
  circuitBreakers.set(agentId, cb);
}

export function recordAgentSuccess(agentId) {
  const cb = circuitBreakers.get(agentId);
  if (cb?.state === 'half-open') {
    cb.state = 'closed';
    cb.failures = 0;
    circuitBreakers.set(agentId, cb);
    console.log(`[RateLimit] 🟢 Circuit CLOSED for ${agentId}`);
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getRateLimitStats() {
  const state = loadState();
  const result = {};
  for (const [id, limits] of Object.entries(AGENT_LIMITS)) {
    if (limits.priority === 'system') continue;
    const s = state[id] || { hour: { count: 0 }, min: { count: 0 } };
    const cb = circuitBreakers.get(id) || { state: 'closed', failures: 0 };
    result[id] = {
      hourly: `${s.hour?.count || 0}/${limits.perHour}`,
      burst:  `${s.min?.count  || 0}/${limits.burstPerMin}`,
      circuit: cb.state,
    };
  }
  return result;
}
