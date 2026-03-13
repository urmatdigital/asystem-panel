/**
 * Task Priority & SLA Manager
 * 
 * Features:
 * - Priority routing (critical > high > medium > low)
 * - SLA tracking (task created_at + sla_minutes = deadline)
 * - Auto-escalation (overdue tasks bump priority)
 * - Rate limiting (prevent one agent from hogging resources)
 * 
 * API endpoints:
 * GET /api/tasks/priority-queue?agent=forge&limit=5 — get next tasks by priority
 * PATCH /api/tasks/:id/priority { priority, sla_minutes } — update priority/SLA
 * GET /api/tasks/overdue — list tasks past SLA deadline
 */

import { createHash } from 'node:crypto';

// Priority levels (used for sorting)
export const PRIORITY_LEVELS = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
};

// Default SLA minutes by priority
export const DEFAULT_SLA = {
  critical: 15,
  high: 60,
  medium: 240,    // 4 hours
  low: 1440,      // 24 hours
};

// Per-agent rate limit (tasks picked per cycle to prevent starvation)
const AGENT_RATE_LIMIT = {
  forge: 3,
  atlas: 1,
  iron: 1,
  mesa: 1,
  pixel: 1,
  dana: 1,
  nurlan: 1,
  ainura: 1,
  marat: 1,
};

// Track claimed tasks per agent (resets every minute)
const agentClaimWindow = new Map();

/**
 * Get next tasks from priority queue
 * 
 * Scoring logic:
 *   base_score = PRIORITY_LEVELS[priority]
 *   if overdue: score += 50 (escalate overdue to critical-level)
 *   if stalled > 30min: score += 25 (task stuck on same agent)
 * 
 * Sort by: score DESC, created_at ASC (FIFO for equal priority)
 */
export async function getPriorityQueue(agent, limit = 2) {
  const API_BASE = 'http://127.0.0.1:5190';

  // Get all pending tasks from Convex
  const res = await fetch(`${API_BASE}/api/tasks/pending?limit=100`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }).then(r => r.json()).catch(() => ({ tasks: [] }));

  const allTasks = res.tasks || [];
  const now = Date.now();

  // Enrich tasks with scoring
  const scored = allTasks.map(t => {
    let score = PRIORITY_LEVELS[t.priority || 'medium'] || PRIORITY_LEVELS.medium;
    const createdAtMs = new Date(t.created_at || now).getTime();
    const slaMinutes = t.sla_minutes || DEFAULT_SLA[t.priority || 'medium'] || 240;
    const deadlineMs = createdAtMs + slaMinutes * 60_000;

    // Escalate overdue tasks
    if (now > deadlineMs) {
      const overdueMin = Math.floor((now - deadlineMs) / 60_000);
      score += Math.min(overdueMin * 10, 75); // escalate up to critical level
      t._overdueMinutes = overdueMin;
    }

    // Escalate stalled tasks (no progress update > 30min)
    if (t.last_updated_at) {
      const lastUpdateMs = new Date(t.last_updated_at).getTime();
      const stalledMin = Math.floor((now - lastUpdateMs) / 60_000);
      if (stalledMin > 30) {
        score += 25;
        t._stalledMinutes = stalledMin;
      }
    }

    return { ...t, _score: score, _deadlineMs: deadlineMs };
  });

  // Filter by agent and apply rate limit
  const claimCount = agentClaimWindow.get(agent) || 0;
  const rateLimit = AGENT_RATE_LIMIT[agent] || 2;
  const available = rateLimit - claimCount;

  if (available <= 0) {
    return {
      agent,
      queue: [],
      note: `Agent rate limit reached (${claimCount}/${rateLimit} claimed this cycle)`,
    };
  }

  // Sort by score DESC, then by created_at (oldest first)
  scored.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  // Take up to available slots
  const queue = scored.slice(0, Math.min(limit, available));

  // Record claim in window
  agentClaimWindow.set(agent, claimCount + queue.length);

  // Reset window after 60 seconds
  if (!agentClaimWindow.has(`_timer_${agent}`)) {
    agentClaimWindow.set(`_timer_${agent}`, setTimeout(() => {
      agentClaimWindow.delete(agent);
      agentClaimWindow.delete(`_timer_${agent}`);
    }, 60_000));
  }

  return {
    agent,
    queue: queue.map(t => ({
      id: t._id,
      title: t.title,
      priority: t.priority || 'medium',
      status: t.status,
      score: t._score,
      created_at: t.created_at,
      deadline: new Date(t._deadlineMs).toISOString(),
      overdue_minutes: t._overdueMinutes || 0,
      stalled_minutes: t._stalledMinutes || 0,
    })),
    agent_limit: rateLimit,
    agent_claimed_this_cycle: claimCount + queue.length,
  };
}

/**
 * List tasks past SLA deadline
 */
export async function getOverdueTasks() {
  const API_BASE = 'http://127.0.0.1:5190';
  const res = await fetch(`${API_BASE}/api/tasks/pending?limit=100`).then(r => r.json()).catch(() => ({ tasks: [] }));
  
  const now = Date.now();
  const overdue = [];

  for (const t of res.tasks || []) {
    const createdAtMs = new Date(t.created_at).getTime();
    const slaMinutes = t.sla_minutes || DEFAULT_SLA[t.priority || 'medium'] || 240;
    const deadlineMs = createdAtMs + slaMinutes * 60_000;

    if (now > deadlineMs) {
      overdue.push({
        id: t._id,
        title: t.title,
        priority: t.priority || 'medium',
        created_at: t.created_at,
        deadline: new Date(deadlineMs).toISOString(),
        overdue_minutes: Math.floor((now - deadlineMs) / 60_000),
      });
    }
  }

  return overdue.sort((a, b) => b.overdue_minutes - a.overdue_minutes);
}

/**
 * Update task priority and SLA
 * Called from server.mjs PATCH /api/tasks/:id/priority
 */
export async function updateTaskPrioritySLA(taskId, { priority, sla_minutes }) {
  const { default: https } = await import('node:https');
  
  const updates = {};
  if (priority) updates.priority = priority;
  if (sla_minutes) updates.sla_minutes = sla_minutes;

  const body = JSON.stringify({
    path: 'tasks:updatePriority',
    args: { id: taskId, ...updates },
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'expert-dachshund-299.convex.cloud',
      path: '/api/mutation',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 8000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          resolve({ ok: r.status === 'success', ...r });
        } catch {
          resolve({ ok: false, error: 'parse error' });
        }
      });
    });

    req.on('error', err => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });

    req.write(body);
    req.end();
  });
}

export default {
  getPriorityQueue,
  getOverdueTasks,
  updateTaskPrioritySLA,
  PRIORITY_LEVELS,
  DEFAULT_SLA,
};
