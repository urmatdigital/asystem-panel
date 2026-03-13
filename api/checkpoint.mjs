/**
 * checkpoint.mjs — Task Checkpoint/Resume for ASYSTEM
 *
 * Problem: if server restarts mid-task (>30min), task progress is lost.
 * Solution: agents write checkpoints; on restart, stale claimed tasks
 * are detected and either resumed or re-queued.
 *
 * Storage: ~/.openclaw/workspace/tasks/checkpoints/{taskId}.json
 * TTL: claimed task without checkpoint update > 45min → stale
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME        = os.homedir();
const CKPT_DIR    = path.join(HOME, '.openclaw/workspace/tasks/checkpoints');
const AUDIT_LOG   = path.join(HOME, '.openclaw/workspace/audit-log.jsonl');
const STALE_TTL   = 45 * 60_000; // 45 minutes

function ensureDir() { fs.mkdirSync(CKPT_DIR, { recursive: true }); }

// ── Write checkpoint ──────────────────────────────────────────────────────────
export function writeCheckpoint({ taskId, agent, title, step, progress, context = {} }) {
  ensureDir();
  const ckpt = {
    taskId, agent, title, step, progress,
    context, updatedAt: Date.now(), updatedAtIso: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(CKPT_DIR, `${taskId}.json`), JSON.stringify(ckpt, null, 2));
  return ckpt;
}

// ── Read checkpoint ───────────────────────────────────────────────────────────
export function readCheckpoint(taskId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CKPT_DIR, `${taskId}.json`), 'utf8'));
  } catch { return null; }
}

// ── Complete/clear checkpoint ─────────────────────────────────────────────────
export function clearCheckpoint(taskId) {
  try { fs.unlinkSync(path.join(CKPT_DIR, `${taskId}.json`)); } catch {}
}

// ── Scan for stale checkpoints (not updated > 45min) ─────────────────────────
export function getStaleCheckpoints() {
  ensureDir();
  const now = Date.now();
  try {
    return fs.readdirSync(CKPT_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(CKPT_DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .filter(c => now - c.updatedAt > STALE_TTL);
  } catch { return []; }
}

// ── All active checkpoints ────────────────────────────────────────────────────
export function getAllCheckpoints() {
  ensureDir();
  try {
    return fs.readdirSync(CKPT_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(CKPT_DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch { return []; }
}

// ── Startup recovery: detect stale, emit resume payloads ─────────────────────
export function recoverStaleCheckpoints() {
  const stale = getStaleCheckpoints();
  if (!stale.length) return [];

  const recovered = [];
  for (const ckpt of stale) {
    console.log(`[Checkpoint] 🔄 Stale task detected: ${ckpt.taskId} (agent=${ckpt.agent}, step=${ckpt.step}, age=${Math.round((Date.now()-ckpt.updatedAt)/60000)}min)`);
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({
      ts: Date.now(), type: 'checkpoint.stale', taskId: ckpt.taskId,
      agent: ckpt.agent, step: ckpt.step, staleMinutes: Math.round((Date.now()-ckpt.updatedAt)/60000),
    }) + '\n');
    recovered.push({
      taskId: ckpt.taskId,
      resumePayload: {
        to: ckpt.agent, title: `[RESUME] ${ckpt.title || ckpt.taskId}`,
        body: `Task was interrupted at step "${ckpt.step}" (progress: ${ckpt.progress||'?'}). Context: ${JSON.stringify(ckpt.context).slice(0,300)}. Please resume from checkpoint.`,
        priority: 'high', tags: ['resume', 'checkpoint'],
        source: 'checkpoint-recovery', original_task_id: ckpt.taskId,
      },
    });
    // Clear stale checkpoint (fresh one will be written when resumed)
    clearCheckpoint(ckpt.taskId);
  }
  return recovered;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getCheckpointStats() {
  const all   = getAllCheckpoints();
  const stale = getStaleCheckpoints();
  return { active: all.length, stale: stale.length, checkpoints: all.map(c => ({
    taskId: c.taskId, agent: c.agent, step: c.step, ageMin: Math.round((Date.now()-c.updatedAt)/60000),
  })) };
}
