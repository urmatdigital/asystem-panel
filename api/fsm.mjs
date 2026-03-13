/**
 * fsm.mjs — Finite State Machine for Task Workflows
 *
 * Video: "Your AI Agents Need a Map: State Machines serve better than Prompt Loops"
 *        (jsFRiGoErzk)
 *
 * Pattern: Replace prompt loops with explicit state maps
 *   States are explicit, transitions have conditions
 *   No hallucination — invalid transitions rejected
 *   Every state change is logged
 *
 * ASYSTEM Task States:
 *   QUEUED → CLAIMED → IN_PROGRESS → REVIEW → DONE
 *                             ↓              ↓
 *                            FAILED         FAILED
 *                             ↓
 *                            DLQ
 *
 * Playbook states:
 *   PENDING → DISPATCHED → PARTIAL → COMPLETE → FAILED
 *
 * API:
 *   POST /api/fsm/transition  { taskId, from, to, actor, reason }
 *   GET  /api/fsm/:taskId     — current state + history
 *   GET  /api/fsm/stats       — transition counts per state
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME     = os.homedir();
const FSM_FILE = path.join(HOME, '.openclaw/workspace/.fsm-state.json');
const FSM_LOG  = path.join(HOME, '.openclaw/workspace/fsm-transitions.jsonl');

// ── Valid transition map ───────────────────────────────────────────────────────
const TRANSITIONS = {
  // Task workflow
  queued:      ['claimed', 'failed', 'cancelled'],
  claimed:     ['in_progress', 'queued', 'failed'],        // unclaim → back to queued
  in_progress: ['review', 'done', 'failed', 'blocked'],
  review:      ['done', 'in_progress', 'failed'],          // back to in_progress if review fails
  blocked:     ['in_progress', 'failed', 'cancelled'],
  failed:      ['queued', 'dlq'],                          // retry → queued; give up → dlq
  dlq:         ['queued', 'cancelled'],                    // manual rescue
  done:        [],                                         // terminal
  cancelled:   [],                                         // terminal
};

// ── State metadata ────────────────────────────────────────────────────────────
const STATE_META = {
  queued:      { label: '📋 Queued',      terminal: false },
  claimed:     { label: '🔒 Claimed',     terminal: false },
  in_progress: { label: '⚙️  In Progress', terminal: false },
  review:      { label: '🔍 Review',      terminal: false },
  blocked:     { label: '🚫 Blocked',     terminal: false },
  failed:      { label: '❌ Failed',      terminal: false },
  dlq:         { label: '💀 DLQ',         terminal: false },
  done:        { label: '✅ Done',         terminal: true  },
  cancelled:   { label: '🚫 Cancelled',   terminal: true  },
};

// ── Load/save ─────────────────────────────────────────────────────────────────
function load() { try { return JSON.parse(fs.readFileSync(FSM_FILE, 'utf8')); } catch { return {}; } }
function save(d) { try { fs.writeFileSync(FSM_FILE, JSON.stringify(d, null, 2)); } catch {} }

// ── Transition ────────────────────────────────────────────────────────────────
export function transition({ taskId, from, to, actor = 'system', reason = '' }) {
  if (!taskId) throw new Error('taskId required');

  const states = load();
  const current = states[taskId]?.state || 'queued';
  const effectiveFrom = from || current;

  // Validate
  const allowed = TRANSITIONS[effectiveFrom] || [];
  if (!allowed.includes(to)) {
    const err = `[FSM] ❌ Invalid transition: ${effectiveFrom} → ${to} (allowed: ${allowed.join(', ') || 'none'})`;
    console.warn(err);
    throw new Error(err);
  }

  // Apply
  if (!states[taskId]) states[taskId] = { taskId, state: effectiveFrom, history: [] };
  const prev = states[taskId].state;
  states[taskId].state = to;
  states[taskId].updatedAt = Date.now();
  states[taskId].history = [...(states[taskId].history || []).slice(-19), {
    from: prev, to, actor, reason: reason.slice(0, 100), at: Date.now(),
  }];

  save(states);

  // Log
  const logEntry = { ts: Date.now(), taskId, from: prev, to, actor, reason: reason.slice(0, 100) };
  fs.appendFileSync(FSM_LOG, JSON.stringify(logEntry) + '\n');
  console.log(`[FSM] ${taskId}: ${STATE_META[prev]?.label || prev} → ${STATE_META[to]?.label || to} (${actor})`);

  return { taskId, from: prev, to, allowed: TRANSITIONS[to] || [], terminal: STATE_META[to]?.terminal };
}

// ── Get task state ────────────────────────────────────────────────────────────
export function getTaskFSM(taskId) {
  const states = load();
  return states[taskId] || { taskId, state: 'queued', history: [] };
}

// ── Initialize (or ensure) a task state ──────────────────────────────────────
export function ensureState(taskId, initialState = 'queued') {
  const states = load();
  if (!states[taskId]) {
    states[taskId] = { taskId, state: initialState, history: [], createdAt: Date.now(), updatedAt: Date.now() };
    save(states);
  }
  return states[taskId];
}

// ── Bulk transition (from dispatch) ──────────────────────────────────────────
export function autoTransition(taskId, event) {
  // Map events to transitions
  const EVENT_MAP = {
    dispatched:  { to: 'in_progress' },
    claimed:     { to: 'claimed' },
    completed:   { to: 'done' },
    failed:      { to: 'failed' },
    retrying:    { to: 'queued' },
    reviewing:   { to: 'review' },
    blocked:     { to: 'blocked' },
    dlq:         { to: 'dlq' },
  };
  const t = EVENT_MAP[event];
  if (!t) return;
  try { return transition({ taskId, to: t.to, actor: 'system', reason: `event:${event}` }); }
  catch {} // ignore invalid transitions silently
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getFSMStats() {
  const states = load();
  const byStat = {};
  for (const t of Object.values(states)) {
    byStat[t.state] = (byStat[t.state] || 0) + 1;
  }
  try {
    const lines = fs.readFileSync(FSM_LOG, 'utf8').trim().split('\n').filter(Boolean);
    const transitionCount = lines.length;
    return { tasks: Object.keys(states).length, byState: byStat, totalTransitions: transitionCount, validStates: Object.keys(TRANSITIONS) };
  } catch {
    return { tasks: Object.keys(states).length, byState: byStat, totalTransitions: 0, validStates: Object.keys(TRANSITIONS) };
  }
}
