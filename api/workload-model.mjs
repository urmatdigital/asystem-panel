/**
 * workload-model.mjs — Agent Cognitive Load & Workload Model
 *
 * Video: "AI Is Now Farming — And It's Just Beginning" (ZnFI7I7YGkM)
 * Pattern: Agent as a "farm" — it has capacity, current load, and fatigue.
 *   When overloaded, it rejects/defers tasks automatically.
 *   When idle too long, it can proactively pick up work.
 *
 * Workload score: 0-100
 *   0-20:   IDLE       — under-utilized, proactively seeks tasks
 *   21-40:  LIGHT      — comfortable, accept all priority levels
 *   41-60:  MODERATE   — working well, accept medium+ priority
 *   61-80:  HEAVY      — busy, accept high+ priority only
 *   81-95:  SATURATED  — near capacity, critical only
 *   96-100: OVERLOADED — reject everything, trigger rebalance
 *
 * Load contributors:
 *   +30  CRITICAL task active
 *   +20  HIGH task active
 *   +10  MEDIUM task active
 *   +5   LOW task active
 *   +15  per queued task (backpressure)
 *   -5   per 5 min since last task completed (recovery)
 *
 * Fatigue:
 *   Tasks completed in last hour → fatigue score (max 50)
 *   High fatigue → longer recovery time between tasks
 *   Resets fully after 2h of idle
 *
 * API:
 *   POST /api/workload/update   { agentId, event: 'start'|'complete'|'fail'|'idle', priority? }
 *   GET  /api/workload/:agentId → current workload + acceptance policy
 *   GET  /api/workload/overview → all agents with load levels
 *   POST /api/workload/can-accept { agentId, priority } → yes/no/defer
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME    = os.homedir();
const WL_FILE = path.join(HOME, '.openclaw/workspace/.workload.json');
const WL_LOG  = path.join(HOME, '.openclaw/workspace/workload-log.jsonl');

const LOAD_LEVELS = [
  { min: 0,  max: 20,  level: 'IDLE',       emoji: '💤', accept: ['critical','high','medium','low'], desc: 'Under-utilized — seeking work' },
  { min: 21, max: 40,  level: 'LIGHT',      emoji: '🟢', accept: ['critical','high','medium','low'], desc: 'Comfortable capacity' },
  { min: 41, max: 60,  level: 'MODERATE',   emoji: '🟡', accept: ['critical','high','medium'],       desc: 'Working well' },
  { min: 61, max: 80,  level: 'HEAVY',      emoji: '🟠', accept: ['critical','high'],               desc: 'Busy — high priority only' },
  { min: 81, max: 95,  level: 'SATURATED',  emoji: '🔴', accept: ['critical'],                       desc: 'Near capacity — critical only' },
  { min: 96, max: 100, level: 'OVERLOADED', emoji: '💥', accept: [],                                 desc: 'Overloaded — rebalance needed' },
];

const PRIORITY_LOAD = { critical: 30, high: 20, medium: 10, low: 5 };

// ── Load / save ────────────────────────────────────────────────────────────────
function loadWL() {
  try { return JSON.parse(fs.readFileSync(WL_FILE, 'utf8')); }
  catch {
    const init = {};
    const agents = ['forge','atlas','bekzat','ainura','marat','nurlan','dana','mesa','iron','pixel'];
    for (const a of agents) init[a] = { load: 10, fatigue: 0, activeTasks: {}, completedRecent: [], lastCompleted: 0, lastUpdated: Date.now() };
    return init;
  }
}
function saveWL(d) { try { fs.writeFileSync(WL_FILE, JSON.stringify(d, null, 2)); } catch {} }

function getLevel(load) { return LOAD_LEVELS.find(l => load >= l.min && load <= l.max) || LOAD_LEVELS[0]; }

function recalcLoad(agent) {
  const now = Date.now();

  // Active tasks contribution
  let taskLoad = 0;
  for (const [, priority] of Object.entries(agent.activeTasks || {})) {
    taskLoad += PRIORITY_LOAD[priority] || 10;
  }

  // Queued backpressure (estimated from sampler)
  const queuedLoad = Math.min(30, (agent.queuedCount || 0) * 15);

  // Recovery: -5 per 5min since last completion
  const minutesSinceComplete = (now - (agent.lastCompleted || now)) / 60000;
  const recovery = Math.min(taskLoad, Math.floor(minutesSinceComplete / 5) * 5);

  // Fatigue (tasks in last hour)
  const oneHour = 60 * 60 * 1000;
  const recentCompleted = (agent.completedRecent || []).filter(ts => now - ts < oneHour).length;
  const fatigue = Math.min(50, recentCompleted * 8);

  const raw = Math.max(0, taskLoad + queuedLoad - recovery + (fatigue * 0.3));
  return Math.min(100, Math.round(raw));
}

// ── Update workload ───────────────────────────────────────────────────────────
export function updateWorkload({ agentId, event, priority = 'medium', taskId = null }) {
  const wl = loadWL();
  if (!wl[agentId]) wl[agentId] = { load: 10, fatigue: 0, activeTasks: {}, completedRecent: [], lastCompleted: 0, lastUpdated: Date.now() };

  const agent = wl[agentId];
  const now   = Date.now();
  const tid   = taskId || `task_${now}`;

  if (event === 'start') {
    agent.activeTasks[tid] = priority;
  } else if (event === 'complete' || event === 'fail') {
    delete agent.activeTasks[tid];
    agent.completedRecent = [...(agent.completedRecent || []), now].filter(ts => now - ts < 60 * 60 * 1000).slice(-20);
    agent.lastCompleted = now;
  } else if (event === 'idle') {
    // Natural idle recovery
  }

  const prevLoad  = agent.load;
  agent.load      = recalcLoad(agent);
  agent.lastUpdated = now;

  const prevLevel = getLevel(prevLoad);
  const newLevel  = getLevel(agent.load);
  saveWL(wl);

  const levelChanged = prevLevel.level !== newLevel.level;
  if (levelChanged) {
    console.log(`[Workload] ${newLevel.emoji} ${agentId}: ${prevLevel.level}→${newLevel.level} (load ${prevLoad}→${agent.load})`);
    fs.appendFileSync(WL_LOG, JSON.stringify({ ts: now, agentId, event, prevLevel: prevLevel.level, newLevel: newLevel.level, load: agent.load }) + '\n');
  }

  return { agentId, event, priority, load: agent.load, level: newLevel.level, emoji: newLevel.emoji, levelChanged };
}

// ── Can this agent accept a new task? ────────────────────────────────────────
export function canAccept({ agentId, priority = 'medium' }) {
  const wl    = loadWL();
  const agent = wl[agentId] || { load: 10 };
  const level = getLevel(agent.load);
  const ok    = level.accept.includes(priority);

  if (!ok) {
    // Find alternative agent with capacity
    const alternatives = Object.entries(wl)
      .filter(([id, a]) => id !== agentId && getLevel(a.load).accept.includes(priority))
      .sort((a, b) => a[1].load - b[1].load)
      .slice(0, 3)
      .map(([id, a]) => ({ agentId: id, load: a.load, level: getLevel(a.load).level }));
    return { ok: false, agentId, load: agent.load, level: level.level, reason: level.desc, alternatives };
  }

  return { ok: true, agentId, load: agent.load, level: level.level, emoji: level.emoji };
}

// ── Get agent workload ────────────────────────────────────────────────────────
export function getWorkload(agentId) {
  const wl    = loadWL();
  const agent = wl[agentId] || { load: 10, activeTasks: {}, completedRecent: [] };
  const load  = recalcLoad(agent);
  const level = getLevel(load);
  const now   = Date.now();
  const recentCompleted = (agent.completedRecent || []).filter(ts => now - ts < 60 * 60 * 1000).length;
  return { agentId, load, level: level.level, emoji: level.emoji, desc: level.desc, activeTasks: Object.keys(agent.activeTasks || {}).length, completedLastHour: recentCompleted, acceptPolicy: level.accept };
}

// ── Overview of all agents ────────────────────────────────────────────────────
export function getOverview() {
  const wl = loadWL();
  return Object.entries(wl).map(([agentId, data]) => {
    const load  = recalcLoad(data);
    const level = getLevel(load);
    return { agentId, load, level: level.level, emoji: level.emoji, activeTasks: Object.keys(data.activeTasks || {}).length };
  }).sort((a, b) => b.load - a.load);
}
