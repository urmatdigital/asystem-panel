/**
 * task-ttl.mjs — Task TTL, Expiry Enforcement & Stale Task Cleanup
 *
 * Video: "Tasks That Route Themselves: AI Agents for Small Business | ClickUp" (3PnZF8IeLqs)
 * Pattern: Tasks have a time-to-live → auto-cancel stale tasks, warn on approaching deadline
 *
 * TTL rules by priority:
 *   critical: 2h  (must complete fast, auto-escalate at 1h)
 *   high:     8h  (business day, escalate at 6h)
 *   medium:   24h (one day, warn at 20h)
 *   low:      72h (three days, warn at 60h)
 *
 * States:
 *   active   → within TTL
 *   warning  → >75% of TTL elapsed → warn to squad chat
 *   expired  → >100% of TTL → auto-cancel + DLQ + ledger event
 *   done     → completed before TTL
 *
 * Enforcement runs every 5 minutes (called from cron or heartbeat)
 *
 * Storage: .task-ttl.json — { taskId: { agentId, title, priority, startedAt, ttlMs, status } }
 *
 * API:
 *   POST /api/ttl/register    { taskId, agentId, title, priority, customTtlMs? }
 *   POST /api/ttl/complete    { taskId } → mark done
 *   GET  /api/ttl/status      → all active tasks + time remaining
 *   POST /api/ttl/sweep       → run expiry enforcement now
 *   GET  /api/ttl/expired     → recently expired tasks
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const TTL_FILE  = path.join(HOME, '.openclaw/workspace/.task-ttl.json');
const TTL_LOG   = path.join(HOME, '.openclaw/workspace/ttl-log.jsonl');

// ── TTL by priority (ms) ──────────────────────────────────────────────────────
const TTL_BY_PRIORITY = {
  critical: 2  * 60 * 60_000,  // 2h
  high:     8  * 60 * 60_000,  // 8h
  medium:   24 * 60 * 60_000,  // 24h
  low:      72 * 60 * 60_000,  // 72h
};
const WARN_PCT = 0.75; // warn at 75% elapsed

// ── Load/save ─────────────────────────────────────────────────────────────────
function load() { try { return JSON.parse(fs.readFileSync(TTL_FILE, 'utf8')); } catch { return {}; } }
function save(d) { try { fs.writeFileSync(TTL_FILE, JSON.stringify(d, null, 2)); } catch {} }

// ── Register task ─────────────────────────────────────────────────────────────
export function registerTask({ taskId, agentId, title = '', priority = 'medium', customTtlMs }) {
  const tasks = load();
  if (tasks[taskId]) return { ok: false, reason: 'already registered' };

  const ttlMs = customTtlMs || TTL_BY_PRIORITY[priority] || TTL_BY_PRIORITY.medium;
  tasks[taskId] = {
    taskId, agentId, title: title.slice(0, 60), priority,
    ttlMs, startedAt: Date.now(), status: 'active',
    expiresAt: Date.now() + ttlMs,
    warnedAt: null, expiredAt: null,
  };
  save(tasks);

  const h = Math.round(ttlMs / 3_600_000 * 10) / 10;
  console.log(`[TTL] ⏱️  ${taskId} registered → ${agentId} (${priority}, TTL=${h}h)`);
  return { ok: true, ttlMs, expiresAt: new Date(tasks[taskId].expiresAt).toISOString() };
}

// ── Complete task (before expiry) ─────────────────────────────────────────────
export function completeTask(taskId) {
  const tasks = load();
  if (!tasks[taskId]) return { ok: false, reason: 'not registered' };
  tasks[taskId].status = 'done';
  tasks[taskId].completedAt = Date.now();
  const elapsed = tasks[taskId].completedAt - tasks[taskId].startedAt;
  save(tasks);
  fs.appendFileSync(TTL_LOG, JSON.stringify({ ts: Date.now(), taskId, event: 'completed', elapsed }) + '\n');
  return { ok: true, elapsed, withinTtl: elapsed < tasks[taskId].ttlMs };
}

// ── Sweep: enforce TTL ────────────────────────────────────────────────────────
export function sweepExpired() {
  const tasks = load();
  const now = Date.now();
  const warnings = [];
  const expired  = [];

  for (const [taskId, task] of Object.entries(tasks)) {
    if (task.status !== 'active') continue;

    const elapsed = now - task.startedAt;
    const pct     = elapsed / task.ttlMs;

    // Expired
    if (elapsed >= task.ttlMs && !task.expiredAt) {
      task.status    = 'expired';
      task.expiredAt = now;
      expired.push({ taskId, agentId: task.agentId, title: task.title, priority: task.priority, elapsedH: Math.round(elapsed / 3_600_000 * 10) / 10 });
      fs.appendFileSync(TTL_LOG, JSON.stringify({ ts: now, taskId, event: 'expired', agentId: task.agentId, priority: task.priority }) + '\n');
      console.error(`[TTL] 🔴 EXPIRED: ${taskId} (${task.agentId}) — ${task.title.slice(0, 40)}`);
    }
    // Warning zone
    else if (pct >= WARN_PCT && !task.warnedAt) {
      task.warnedAt = now;
      const remainMin = Math.round((task.ttlMs - elapsed) / 60_000);
      warnings.push({ taskId, agentId: task.agentId, title: task.title, remainMin });
      fs.appendFileSync(TTL_LOG, JSON.stringify({ ts: now, taskId, event: 'warning', remainMin, agentId: task.agentId }) + '\n');
      console.warn(`[TTL] ⚠️  WARNING: ${taskId} (${task.agentId}) — ${remainMin} min remaining`);
    }
  }

  save(tasks);
  return { warnings, expired, swept: Object.keys(tasks).length };
}

// ── Status ────────────────────────────────────────────────────────────────────
export function getStatus() {
  const tasks = load();
  const now   = Date.now();
  return Object.values(tasks).map(t => {
    const elapsed  = now - t.startedAt;
    const remainMs = Math.max(0, t.ttlMs - elapsed);
    const pct      = Math.min(100, Math.round((elapsed / t.ttlMs) * 100));
    return {
      taskId: t.taskId, agentId: t.agentId, title: t.title,
      priority: t.priority, status: t.status,
      elapsedMin: Math.round(elapsed / 60_000),
      remainMin:  Math.round(remainMs / 60_000),
      pct, urgency: pct >= 100 ? 'EXPIRED' : pct >= 75 ? 'WARNING' : 'OK',
    };
  }).sort((a, b) => b.pct - a.pct);
}

export function getExpired() {
  return Object.values(load()).filter(t => t.status === 'expired');
}
