/**
 * goal-tracker.mjs — Persistent long-term goal tracking
 *
 * Video: "How I'm Using AI Agents in 2026" (BikPUaT76i8)
 * Pattern: Background execution + persistent goals across sessions
 *   Agents know current progress → avoid redundant work
 *
 * Goals are stored in ~/.openclaw/workspace/goals/
 * Structure: goal.json with milestones, progress, linked tasks
 *
 * API:
 *   POST /api/goals              { title, description, milestones[], project, assignee }
 *   GET  /api/goals              — list all goals
 *   GET  /api/goals/:id          — goal detail + progress
 *   PATCH /api/goals/:id/progress { milestone, status, evidence }
 *   GET  /api/goals/agent/:agentId — goals assigned to agent
 */

import { randomUUID } from 'node:crypto';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const GOALS_DIR = path.join(HOME, '.openclaw/workspace/goals');
const AUDIT_LOG = path.join(HOME, '.openclaw/workspace/audit-log.jsonl');

fs.mkdirSync(GOALS_DIR, { recursive: true });

// ── CRUD ──────────────────────────────────────────────────────────────────────
export function createGoal({ title, description, milestones = [], project = 'ASYSTEM', assignee = 'forge', priority = 'medium' }) {
  const id = randomUUID().slice(0, 8);
  const goal = {
    id, title, description, project, assignee, priority,
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    milestones: milestones.map((m, i) => ({
      id: `m${i+1}`,
      title: typeof m === 'string' ? m : m.title,
      status: 'pending',
      completedAt: null,
      evidence: null,
    })),
    linkedTasks: [],
    progress: 0,
  };
  fs.writeFileSync(path.join(GOALS_DIR, `${id}.json`), JSON.stringify(goal, null, 2));
  fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ts: Date.now(), type: 'goal.created', goalId: id, title, assignee }) + '\n');
  console.log(`[GoalTracker] 🎯 Goal created: "${title}" → ${id}`);
  return goal;
}

export function getGoal(goalId) {
  try { return JSON.parse(fs.readFileSync(path.join(GOALS_DIR, `${goalId}.json`), 'utf8')); }
  catch { return null; }
}

export function listGoals({ project, assignee, status } = {}) {
  try {
    return fs.readdirSync(GOALS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(GOALS_DIR, f), 'utf8')))
      .filter(g => (!project || g.project === project) && (!assignee || g.assignee === assignee) && (!status || g.status === status))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch { return []; }
}

export function updateGoalProgress(goalId, { milestone, status, evidence, linkedTaskId }) {
  const goal = getGoal(goalId);
  if (!goal) return null;

  if (milestone) {
    const m = goal.milestones.find(m => m.id === milestone || m.title === milestone);
    if (m) {
      m.status = status || 'done';
      m.completedAt = status === 'done' ? Date.now() : null;
      m.evidence = evidence || null;
    }
  }

  if (linkedTaskId && !goal.linkedTasks.includes(linkedTaskId)) {
    goal.linkedTasks.push(linkedTaskId);
  }

  // Recalculate progress
  const done = goal.milestones.filter(m => m.status === 'done').length;
  goal.progress = goal.milestones.length > 0 ? Math.round((done / goal.milestones.length) * 100) : 0;
  goal.updatedAt = Date.now();

  // Auto-complete if all milestones done
  if (goal.progress === 100) {
    goal.status = 'completed';
    console.log(`[GoalTracker] ✅ Goal COMPLETED: "${goal.title}"`);
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ts: Date.now(), type: 'goal.completed', goalId, title: goal.title }) + '\n');
  }

  fs.writeFileSync(path.join(GOALS_DIR, `${goalId}.json`), JSON.stringify(goal, null, 2));
  return goal;
}

// ── Build context for agent dispatch — inject active goals ────────────────────
export function buildGoalContext(agentId, project) {
  const goals = listGoals({ assignee: agentId, status: 'active', project });
  if (!goals.length) return null;

  const lines = goals.slice(0, 3).map(g => {
    const pendingMilestones = g.milestones.filter(m => m.status === 'pending').map(m => m.title).slice(0, 3);
    return `• [${g.progress}%] "${g.title}" — next: ${pendingMilestones.join(', ') || 'all done'}`;
  });

  return `[Active Goals for ${agentId}]\n${lines.join('\n')}\nCheck if this task advances any of these goals.`;
}

// ── Initialize default ASYSTEM goals ─────────────────────────────────────────
export function initDefaultGoals() {
  const existing = listGoals();
  if (existing.length > 0) return; // Already initialized

  // ORGON project goals
  createGoal({
    title: 'ORGON Phase 2: Safina Integration',
    description: 'Complete Safina payment gateway integration for ORGON multi-sig wallet',
    project: 'ORGON',
    assignee: 'bekzat',
    priority: 'high',
    milestones: [
      'Safina API endpoints implemented',
      'Multi-sig transaction flow tested',
      'JWT auth for Safina webhook',
      'Frontend payment UI complete',
      'E2E tests passing',
    ],
  });

  createGoal({
    title: 'ORGON Frontend: Next.js 16 Migration',
    description: 'Migrate ORGON frontend to Next.js 16 with Aceternity UI components',
    project: 'ORGON',
    assignee: 'ainura',
    priority: 'medium',
    milestones: [
      'Next.js 16 setup + TypeScript strict',
      'Aceternity UI components library integrated',
      'Dashboard layout complete',
      'Mobile responsive',
      'Lighthouse score > 90',
    ],
  });

  createGoal({
    title: 'ASYSTEM Panel Sprint 3 Ops',
    description: 'AI automation pipeline from YouTube videos',
    project: 'ASYSTEM',
    assignee: 'forge',
    priority: 'high',
    milestones: [
      'Security gates + 7-chain dispatch',
      'ZVec memory migration',
      'Karpathy Loop + EMPO2',
      'DLQ + Checkpoint + Living Context',
      'A2A Protocol',
      'Rate Limiter + Shared Memory',
      'Triage + Consensus + Personas',
      'Cost Optimizer + Swarm',
    ],
  });

  console.log('[GoalTracker] 🎯 Default goals initialized');
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getGoalStats() {
  const all = listGoals();
  return {
    total: all.length,
    active: all.filter(g => g.status === 'active').length,
    completed: all.filter(g => g.status === 'completed').length,
    avgProgress: all.length ? Math.round(all.reduce((s, g) => s + g.progress, 0) / all.length) : 0,
    byProject: all.reduce((acc, g) => { acc[g.project] = (acc[g.project] || 0) + 1; return acc; }, {}),
  };
}
