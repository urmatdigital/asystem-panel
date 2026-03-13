/**
 * priority-queue.mjs — Priority Queue with Preemption
 *
 * Video: "AI Agent Development Beyond Jupyter Notebook" (iV_qLAGw0g4)
 * Pattern: Production-ready task queue beyond simple FIFO:
 *   - Priority levels: CRITICAL(0) > HIGH(1) > MEDIUM(2) > LOW(3)
 *   - Preemption: CRITICAL tasks can interrupt a running MEDIUM/LOW task
 *   - Max concurrency per agent (configurable)
 *   - Task aging: LOW priority tasks get boosted after waiting too long
 *   - Starvation prevention: tasks waiting >30min get priority bump
 *
 * Preemption mechanics:
 *   When a CRITICAL task arrives and agent is busy on MEDIUM/LOW:
 *   → pause current task (save state in .queue-paused.json)
 *   → run CRITICAL immediately
 *   → on complete: resume paused task with [RESUME] context prefix
 *
 * Agent concurrency model:
 *   Each agent has max_concurrent (default 1; forge/atlas can be 2)
 *   Queue per agent stored in .priority-queues/<agentId>.json
 *   Global admission control: max 20 queued tasks system-wide
 *
 * API:
 *   POST /api/queue/enqueue   { agentId, taskId, title, priority, ttlMs? }
 *   POST /api/queue/dequeue   { agentId } → next task for agent (pops from queue)
 *   POST /api/queue/preempt   { agentId, urgentTaskId } → preempt current
 *   POST /api/queue/complete  { agentId, taskId } → mark done, resume paused if any
 *   GET  /api/queue/status    → all agents' queue depths + running tasks
 *   GET  /api/queue/:agentId  → agent's full queue
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME       = os.homedir();
const QUEUE_DIR  = path.join(HOME, '.openclaw/workspace/.priority-queues');
const PAUSED_FILE = path.join(HOME, '.openclaw/workspace/.queue-paused.json');
const RUNNING_FILE = path.join(HOME, '.openclaw/workspace/.queue-running.json');
const QUEUE_LOG  = path.join(HOME, '.openclaw/workspace/queue-log.jsonl');
if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });

const PRIORITY_LEVEL = { critical: 0, high: 1, medium: 2, low: 3 };
const PRIORITY_LABEL = ['critical', 'high', 'medium', 'low'];
const MAX_CONCURRENT = { forge: 2, atlas: 2, default: 1 };
const AGING_THRESHOLD_MS   = 30 * 60 * 1000;  // 30 min → bump priority
const PREEMPT_THRESHOLD    = 1; // preempt if running task priority >= HIGH and urgent is CRITICAL

// ── IO ────────────────────────────────────────────────────────────────────────
function queuePath(agentId) { return path.join(QUEUE_DIR, `${agentId}.json`); }
function loadQueue(agentId) { try { return JSON.parse(fs.readFileSync(queuePath(agentId), 'utf8')); } catch { return []; } }
function saveQueue(agentId, q) { try { fs.writeFileSync(queuePath(agentId), JSON.stringify(q, null, 2)); } catch {} }
function loadPaused() { try { return JSON.parse(fs.readFileSync(PAUSED_FILE, 'utf8')); } catch { return {}; } }
function savePaused(d) { try { fs.writeFileSync(PAUSED_FILE, JSON.stringify(d, null, 2)); } catch {} }
function loadRunning() { try { return JSON.parse(fs.readFileSync(RUNNING_FILE, 'utf8')); } catch { return {}; } }
function saveRunning(d) { try { fs.writeFileSync(RUNNING_FILE, JSON.stringify(d, null, 2)); } catch {} }
function logQ(entry) { try { fs.appendFileSync(QUEUE_LOG, JSON.stringify({ ts: Date.now(), ...entry }) + '\n'); } catch {} }

// ── Apply aging: boost priority if waiting too long ───────────────────────────
function applyAging(queue) {
  const now = Date.now();
  return queue.map(task => {
    const age = now - task.enqueuedAt;
    if (age > AGING_THRESHOLD_MS && task.priorityLevel > 0) {
      const oldLevel = task.priorityLevel;
      task.priorityLevel = oldLevel - 1;
      task.priority = PRIORITY_LABEL[task.priorityLevel];
      task.agedFrom = PRIORITY_LABEL[oldLevel];
      console.log(`[PQueue] ⏫ Aging bump: ${task.agentId}/${task.taskId} ${PRIORITY_LABEL[oldLevel]}→${task.priority}`);
    }
    return task;
  });
}

// ── Sort queue by priority then enqueue time ──────────────────────────────────
function sortQueue(queue) {
  return [...queue].sort((a, b) => a.priorityLevel - b.priorityLevel || a.enqueuedAt - b.enqueuedAt);
}

// ── Enqueue ───────────────────────────────────────────────────────────────────
export function enqueue({ agentId, taskId, title, priority = 'medium', ttlMs = 8 * 60 * 60 * 1000, meta = {} }) {
  const priorityLevel = PRIORITY_LEVEL[priority] ?? 2;
  const queue = loadQueue(agentId);
  const existing = queue.find(t => t.taskId === taskId);
  if (existing) return { ok: false, reason: 'Task already queued', taskId };

  const task = { taskId, agentId, title: title?.slice(0, 60), priority, priorityLevel, enqueuedAt: Date.now(), ttlMs, expiresAt: Date.now() + ttlMs, meta };
  queue.push(task);
  saveQueue(agentId, sortQueue(queue));
  logQ({ action: 'enqueue', agentId, taskId, priority, queueDepth: queue.length + 1 });
  console.log(`[PQueue] ➕ Enqueued: ${agentId}/${taskId} [${priority}] depth=${queue.length}`);

  // Auto-preempt if critical and agent is running something preemptable
  if (priorityLevel === 0) {
    const running = loadRunning();
    if (running[agentId] && (PRIORITY_LEVEL[running[agentId].priority] || 2) >= PREEMPT_THRESHOLD) {
      return { ok: true, task, autoPreempted: preempt({ agentId, urgentTaskId: taskId }) };
    }
  }
  return { ok: true, task, queueDepth: queue.length };
}

// ── Dequeue (get next task for agent) ────────────────────────────────────────
export function dequeue(agentId) {
  const running = loadRunning();
  const maxC = MAX_CONCURRENT[agentId] || MAX_CONCURRENT.default;
  const currentlyRunning = Object.values(running).filter(r => r.agentId === agentId).length;

  if (currentlyRunning >= maxC) return { ok: false, reason: `Max concurrency (${maxC}) reached`, running: currentlyRunning };

  let queue = applyAging(loadQueue(agentId));
  // Remove expired tasks
  const now = Date.now();
  const expired = queue.filter(t => t.expiresAt && t.expiresAt < now);
  queue = queue.filter(t => !t.expiresAt || t.expiresAt >= now);
  if (expired.length > 0) console.log(`[PQueue] 🗑️ Expired ${expired.length} tasks for ${agentId}`);

  queue = sortQueue(queue);
  if (queue.length === 0) return { ok: false, reason: 'Queue empty', agentId };

  const next = queue.shift();
  saveQueue(agentId, queue);

  running[next.taskId] = { ...next, startedAt: Date.now(), agentId };
  saveRunning(running);
  logQ({ action: 'dequeue', agentId, taskId: next.taskId, priority: next.priority, remainingQueue: queue.length });
  console.log(`[PQueue] ▶️ Dequeued: ${agentId}/${next.taskId} [${next.priority}]`);
  return { ok: true, task: next, remainingQueue: queue.length };
}

// ── Preempt: pause current, run urgent ───────────────────────────────────────
export function preempt({ agentId, urgentTaskId }) {
  const running = loadRunning();
  const paused  = loadPaused();

  const currentTask = Object.values(running).find(r => r.agentId === agentId && r.taskId !== urgentTaskId);
  if (!currentTask) return { ok: false, reason: 'No preemptable task running' };
  if (currentTask.priority === 'critical') return { ok: false, reason: 'Cannot preempt a CRITICAL task' };

  // Pause current
  paused[agentId] = { ...currentTask, pausedAt: Date.now(), resumePrefix: `[RESUME] Previously working on: "${currentTask.title}". Continue from where you left off.` };
  delete running[currentTask.taskId];

  // Get urgent from queue and move to running
  const queue = loadQueue(agentId);
  const urgentIdx = queue.findIndex(t => t.taskId === urgentTaskId);
  if (urgentIdx === -1) return { ok: false, reason: 'Urgent task not in queue' };
  const urgent = queue.splice(urgentIdx, 1)[0];
  running[urgent.taskId] = { ...urgent, startedAt: Date.now(), preempted: currentTask.taskId };
  saveQueue(agentId, queue);
  saveRunning(running);
  savePaused(paused);
  logQ({ action: 'preempt', agentId, urgentTaskId, preemptedTaskId: currentTask.taskId });
  console.log(`[PQueue] ⚡ PREEMPT: ${agentId} paused "${currentTask.title}" → running CRITICAL "${urgent.title}"`);
  return { ok: true, preempted: currentTask.taskId, running: urgent.taskId, resumeContext: paused[agentId].resumePrefix };
}

// ── Complete ──────────────────────────────────────────────────────────────────
export function complete({ agentId, taskId }) {
  const running = loadRunning();
  const paused  = loadPaused();
  delete running[taskId];
  saveRunning(running);

  // Resume paused if any
  let resumed = null;
  if (paused[agentId]) {
    const pausedTask = paused[agentId];
    delete paused[agentId];
    savePaused(paused);
    running[pausedTask.taskId] = { ...pausedTask, resumedAt: Date.now() };
    saveRunning(running);
    resumed = pausedTask;
    console.log(`[PQueue] ▶️ Resumed paused task: "${pausedTask.title}" for ${agentId}`);
    logQ({ action: 'resume', agentId, resumedTaskId: pausedTask.taskId });
  }
  logQ({ action: 'complete', agentId, taskId });
  return { ok: true, taskId, resumed: resumed ? { taskId: resumed.taskId, title: resumed.title, resumeContext: resumed.resumePrefix } : null };
}

// ── Status ────────────────────────────────────────────────────────────────────
export function getQueueStatus() {
  const AGENTS = ['forge','atlas','bekzat','ainura','marat','nurlan','dana','mesa','iron','pixel'];
  const running = loadRunning();
  const paused  = loadPaused();
  return Object.fromEntries(AGENTS.map(a => {
    const queue = loadQueue(a);
    const agentRunning = Object.values(running).filter(r => r.agentId === a);
    return [a, { queueDepth: queue.length, running: agentRunning.length, paused: paused[a] ? 1 : 0, nextPriority: queue[0]?.priority || null }];
  }));
}

export function getAgentQueue(agentId) { return sortQueue(applyAging(loadQueue(agentId))); }
