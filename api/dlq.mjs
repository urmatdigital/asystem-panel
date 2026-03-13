/**
 * dlq.mjs — Dead Letter Queue for ASYSTEM
 *
 * Google multi-agent production pattern: tasks that fail 3+ times go to DLQ.
 * Retry with exponential backoff: 5min → 30min → DLQ.
 *
 * DLQ storage: ~/.openclaw/workspace/tasks/dlq/*.json
 * Retry state:  ~/.openclaw/workspace/tasks/retry/*.json
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME     = os.homedir();
const DLQ_DIR  = path.join(HOME, '.openclaw/workspace/tasks/dlq');
const RETRY_DIR= path.join(HOME, '.openclaw/workspace/tasks/retry');
const AUDIT_LOG= path.join(HOME, '.openclaw/workspace/audit-log.jsonl');

const MAX_RETRIES   = 3;
const RETRY_DELAYS  = [5 * 60_000, 30 * 60_000]; // 5min, 30min → then DLQ

function ensureDirs() {
  fs.mkdirSync(DLQ_DIR,   { recursive: true });
  fs.mkdirSync(RETRY_DIR, { recursive: true });
}

// ── Retry state ───────────────────────────────────────────────────────────────
export function getRetryState(taskId) {
  ensureDirs();
  const p = path.join(RETRY_DIR, `${taskId}.json`);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function saveRetryState(taskId, state) {
  ensureDirs();
  fs.writeFileSync(path.join(RETRY_DIR, `${taskId}.json`), JSON.stringify(state, null, 2));
}

function removeRetryState(taskId) {
  try { fs.unlinkSync(path.join(RETRY_DIR, `${taskId}.json`)); } catch {}
}

// ── Core: record a task failure, return retry decision ───────────────────────
export function recordFailure({ taskId, title, agent, error, body }) {
  ensureDirs();
  const existing = getRetryState(taskId) || { taskId, title, agent, retries: 0, history: [], body };
  existing.retries += 1;
  existing.history.push({ ts: Date.now(), error: (error||'unknown').slice(0, 200), agent });
  existing.lastFailed = new Date().toISOString();

  fs.appendFileSync(AUDIT_LOG, JSON.stringify({
    ts: Date.now(), type: 'task.failed', taskId, agent, retries: existing.retries, error: (error||'').slice(0,100),
  }) + '\n');

  if (existing.retries >= MAX_RETRIES) {
    // Move to DLQ
    const dlqEntry = { ...existing, deadAt: new Date().toISOString(), status: 'dead' };
    fs.writeFileSync(path.join(DLQ_DIR, `${taskId}.json`), JSON.stringify(dlqEntry, null, 2));
    removeRetryState(taskId);
    console.log(`[DLQ] ☠️ Task ${taskId} → DLQ after ${existing.retries} failures`);
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ts: Date.now(), type: 'task.dlq', taskId, agent, retries: existing.retries }) + '\n');
    return { action: 'dead', retries: existing.retries, dlqPath: path.join(DLQ_DIR, `${taskId}.json`) };
  }

  // Schedule retry with backoff
  const delayMs = RETRY_DELAYS[existing.retries - 1] || RETRY_DELAYS.at(-1);
  const retryAt = Date.now() + delayMs;
  existing.retryAt = retryAt;
  existing.retryAtIso = new Date(retryAt).toISOString();
  saveRetryState(taskId, existing);

  const mins = Math.round(delayMs / 60000);
  console.log(`[DLQ] ⚠️ Task ${taskId} failed (attempt ${existing.retries}/${MAX_RETRIES}) → retry in ${mins}min`);
  return { action: 'retry', retries: existing.retries, retryAt, delayMs };
}

// ── Check which tasks are due for retry ───────────────────────────────────────
export function getDueRetries() {
  ensureDirs();
  const now = Date.now();
  try {
    return fs.readdirSync(RETRY_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(RETRY_DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .filter(r => r.retryAt && r.retryAt <= now);
  } catch { return []; }
}

// ── Re-dispatch a retry (returns body for /api/dispatch) ─────────────────────
export function buildRetryPayload(retryState) {
  return {
    to:       retryState.agent || 'forge',
    title:    `[RETRY ${retryState.retries}/${MAX_RETRIES}] ${retryState.title || retryState.taskId}`,
    body:     retryState.body || '',
    priority: 'high',
    tags:     ['retry', `attempt_${retryState.retries + 1}`],
    source:   'dlq-retry',
    retry_count: retryState.retries,
    original_task_id: retryState.taskId,
  };
}

// ── DLQ list ──────────────────────────────────────────────────────────────────
export function getDLQItems() {
  ensureDirs();
  try {
    return fs.readdirSync(DLQ_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(DLQ_DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => new Date(b.deadAt) - new Date(a.deadAt));
  } catch { return []; }
}

// ── Manual retry from DLQ (resets retry counter) ─────────────────────────────
export function requeueFromDLQ(taskId) {
  const p = path.join(DLQ_DIR, `${taskId}.json`);
  try {
    const entry = JSON.parse(fs.readFileSync(p, 'utf8'));
    entry.retries = 0;
    entry.history = entry.history || [];
    entry.status  = 'requeued';
    entry.retryAt = Date.now();
    saveRetryState(taskId, entry);
    fs.unlinkSync(p);
    console.log(`[DLQ] 🔄 Task ${taskId} requeued from DLQ`);
    return { ok: true, taskId, payload: buildRetryPayload(entry) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getDLQStats() {
  const dlq   = getDLQItems();
  const retries = getDueRetries();
  try {
    const pending = fs.readdirSync(RETRY_DIR).filter(f => f.endsWith('.json')).length;
    return { dlq_count: dlq.length, pending_retries: pending, due_now: retries.length };
  } catch { return { dlq_count: dlq.length, pending_retries: 0, due_now: 0 }; }
}
