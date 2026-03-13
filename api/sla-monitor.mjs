/**
 * sla-monitor.mjs — Task SLA Deadline Monitoring & Escalation
 *
 * Pattern: Production systems need SLA guarantees
 *   Source: Three-Tier Architecture for AI Agents + n8n AI Agent Guide (np5xroxMp5o)
 *   Every dispatched task gets a deadline based on priority
 *   Monitor loop (every 2 min) checks for overdue tasks → escalates
 *
 * SLA deadlines by priority:
 *   critical → 15 minutes
 *   high     → 60 minutes
 *   medium   → 4 hours
 *   low      → 24 hours
 *
 * Escalation chain:
 *   1st breach: console warn + Convex status update (late)
 *   2nd breach (2x SLA): fireEvent(health.service_down) → alert + re-queue
 *
 * Storage: ~/.openclaw/workspace/.sla-tasks.json (active SLA tracking)
 * Log: ~/.openclaw/workspace/sla-violations.jsonl
 *
 * API:
 *   POST /api/sla/register  { taskId, agentId, priority, title }
 *   POST /api/sla/complete  { taskId }
 *   GET  /api/sla/active    — tasks approaching/past deadline
 *   GET  /api/sla/stats     — violation rate per agent
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const SLA_FILE  = path.join(HOME, '.openclaw/workspace/.sla-tasks.json');
const VIOL_LOG  = path.join(HOME, '.openclaw/workspace/sla-violations.jsonl');

// SLA deadlines (ms)
const SLA_MS = {
  critical: 15 * 60_000,      // 15 min
  high:     60 * 60_000,      // 1 hour
  medium:   4  * 60 * 60_000, // 4 hours
  low:      24 * 60 * 60_000, // 24 hours
};

// ── Load / save ───────────────────────────────────────────────────────────────
function load() { try { return JSON.parse(fs.readFileSync(SLA_FILE, 'utf8')); } catch { return {}; } }
function save(d) { try { fs.writeFileSync(SLA_FILE, JSON.stringify(d, null, 2)); } catch {} }

// ── Register task SLA ─────────────────────────────────────────────────────────
export function registerSLA({ taskId, agentId, priority = 'medium', title = '' }) {
  const slaMs  = SLA_MS[priority] || SLA_MS.medium;
  const tasks  = load();
  tasks[taskId] = {
    taskId, agentId, priority, title: title.slice(0, 80),
    registeredAt: Date.now(),
    deadline: Date.now() + slaMs,
    slaMs,
    breachCount: 0,
    status: 'active',
  };
  save(tasks);
}

// ── Complete task (remove from SLA tracking) ──────────────────────────────────
export function completeSLA(taskId) {
  const tasks = load();
  if (tasks[taskId]) {
    const elapsed = Date.now() - tasks[taskId].registeredAt;
    const onTime  = elapsed <= tasks[taskId].slaMs;
    console.log(`[SLA] ${taskId} completed ${onTime ? '✅ on-time' : '⚠️ late'} (${Math.round(elapsed / 60_000)}min vs ${Math.round(tasks[taskId].slaMs / 60_000)}min SLA)`);
    delete tasks[taskId];
    save(tasks);
    return { onTime, elapsedMin: Math.round(elapsed / 60_000) };
  }
}

// ── Check all active SLA tasks (called from monitor loop) ─────────────────────
export async function checkSLABreaches() {
  const tasks = load();
  const now   = Date.now();
  const breaches = [];

  for (const [id, task] of Object.entries(tasks)) {
    if (task.status !== 'active') continue;
    const overdue = now - task.deadline;
    if (overdue <= 0) continue;

    task.breachCount = (task.breachCount || 0) + 1;
    const overdueMin = Math.round(overdue / 60_000);

    // Log violation
    fs.appendFileSync(VIOL_LOG, JSON.stringify({
      ts: now, taskId: id, agentId: task.agentId, priority: task.priority,
      title: task.title, overdueMin, breach: task.breachCount,
    }) + '\n');

    console.warn(`[SLA] ⏰ BREACH #${task.breachCount}: ${task.agentId} task "${task.title.slice(0,40)}" overdue ${overdueMin}min`);
    breaches.push({ ...task, overdueMin });

    if (task.breachCount >= 2) {
      // Escalate: fire health.service_down trigger
      try {
        const { fireEvent } = await import('./trigger-engine.mjs');
        await fireEvent('health.service_down', {
          service: `SLA:${task.agentId}:${task.title.slice(0, 30)}`,
          host: task.agentId,
          since: new Date(task.deadline).toISOString(),
        });
        task.status = 'escalated';
        console.warn(`[SLA] 🚨 Escalated ${task.agentId} task ${id} after ${overdueMin}min delay`);
      } catch {}
    }
  }

  save(tasks);
  return breaches;
}

// ── Get active SLA tasks ──────────────────────────────────────────────────────
export function getActiveSLA() {
  const tasks = load();
  const now = Date.now();
  return Object.values(tasks)
    .filter(t => t.status === 'active' || t.status === 'escalated')
    .map(t => ({
      ...t,
      remainingMin: Math.round((t.deadline - now) / 60_000),
      overdueMin: t.deadline < now ? Math.round((now - t.deadline) / 60_000) : 0,
    }))
    .sort((a, b) => a.deadline - b.deadline);
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getSLAStats() {
  try {
    const lines = fs.readFileSync(VIOL_LOG, 'utf8').trim().split('\n').filter(Boolean);
    const byAgent = {};
    for (const l of lines) {
      try {
        const v = JSON.parse(l);
        if (!byAgent[v.agentId]) byAgent[v.agentId] = { violations: 0, totalOverdueMin: 0 };
        byAgent[v.agentId].violations++;
        byAgent[v.agentId].totalOverdueMin += v.overdueMin || 0;
      } catch {}
    }
    for (const ag of Object.values(byAgent)) ag.avgOverdueMin = Math.round(ag.totalOverdueMin / ag.violations);
    return {
      totalViolations: lines.length,
      active: Object.keys(load()).length,
      byAgent,
      slaLimits: { critical: '15min', high: '1hr', medium: '4hr', low: '24hr' },
    };
  } catch { return { totalViolations: 0, active: 0, byAgent: {} }; }
}
