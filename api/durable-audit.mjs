/**
 * durable-audit.mjs — Durable Execution Audit Trail (Temporal Pattern)
 *
 * Video: "Achieving AI Agent Reliability and Observability — Temporal" (PbADYQ1lkeo)
 * Pattern: Every agent action recorded in tamper-proof, replayable history.
 *   Inspired by Temporal's durable execution model:
 *   - Every step = event in the log
 *   - Log is append-only (never modified)
 *   - Any run can be replayed from event log
 *   - Compliance teams can see exactly WHY an agent made a decision
 *   - On failure: resume from last successful event
 *
 * Event types:
 *   TASK_RECEIVED     — task entered the system
 *   DISPATCH_STARTED  — dispatch pipeline began
 *   SECURITY_CHECK    — security gate result
 *   TOOL_CALLED       — agent called an external tool
 *   LLM_QUERIED       — agent queried LLM (model, tokens, cost)
 *   DECISION_MADE     — agent made a decision with reasoning
 *   RESULT_PRODUCED   — agent produced output
 *   TASK_COMPLETED    — task marked done
 *   TASK_FAILED       — task failed with reason
 *   CHECKPOINT_SET    — durable checkpoint saved
 *   RESUMED_FROM      — execution resumed from checkpoint
 *
 * Each event includes:
 *   { eventId, runId, taskId, agentId, type, data, reasoning, ts, seq }
 *
 * Replay: given a runId → replays all events in sequence → reconstructs full execution trace
 *
 * API:
 *   POST /api/durable/event     { runId, taskId, agentId, type, data, reasoning? }
 *   GET  /api/durable/run/:id   → all events for a run (full trace)
 *   GET  /api/durable/replay/:id → replay simulation (events as steps)
 *   GET  /api/durable/runs      → recent runs summary
 *   POST /api/durable/checkpoint { runId, taskId, state } → save checkpoint
 *   GET  /api/durable/checkpoint/:runId → latest checkpoint for run
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import crypto from 'node:crypto';

const HOME          = os.homedir();
const AUDIT_DIR     = path.join(HOME, '.openclaw/workspace/.durable-audit');
const RUNS_INDEX    = path.join(AUDIT_DIR, '_index.json');
const CHECKPOINTS   = path.join(AUDIT_DIR, '_checkpoints.json');

if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });

const VALID_TYPES = ['TASK_RECEIVED','DISPATCH_STARTED','SECURITY_CHECK','TOOL_CALLED',
                     'LLM_QUERIED','DECISION_MADE','RESULT_PRODUCED','TASK_COMPLETED',
                     'TASK_FAILED','CHECKPOINT_SET','RESUMED_FROM','VALIDATION','ESCALATION'];

// ── Append event (immutable, hash-chained) ────────────────────────────────────
export function appendEvent({ runId, taskId, agentId, type, data = {}, reasoning = null }) {
  if (!VALID_TYPES.includes(type)) return { ok: false, reason: `Invalid type: ${type}. Valid: ${VALID_TYPES.join(', ')}` };
  if (!runId) runId = `run_${Date.now()}`;

  const runFile = path.join(AUDIT_DIR, `${runId}.jsonl`);
  const seq     = (() => { try { return fs.readFileSync(runFile, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } })();
  const prevHash = (() => {
    try {
      const lines = fs.readFileSync(runFile, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length === 0) return '0000000000000000';
      const last = JSON.parse(lines[lines.length - 1]);
      return last.hash || '0000000000000000';
    } catch { return '0000000000000000'; }
  })();

  const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const payload = { eventId, runId, taskId, agentId, type, data, reasoning, ts: Date.now(), seq };
  const hash    = crypto.createHash('sha256').update(prevHash + JSON.stringify(payload)).digest('hex').slice(0, 16);
  const entry   = { ...payload, prevHash, hash };

  fs.appendFileSync(runFile, JSON.stringify(entry) + '\n');

  // Update runs index
  const index = loadIndex();
  if (!index[runId]) index[runId] = { runId, taskId, agentId, startedAt: Date.now(), lastEventAt: Date.now(), eventCount: 0, status: 'running' };
  index[runId].eventCount = seq + 1;
  index[runId].lastEventAt = Date.now();
  if (type === 'TASK_COMPLETED') index[runId].status = 'completed';
  if (type === 'TASK_FAILED')    index[runId].status = 'failed';
  saveIndex(index);

  console.log(`[DurableAudit] 📝 ${runId} seq=${seq} ${type} agentId=${agentId || '?'} hash=${hash}`);
  return { ok: true, eventId, runId, seq, hash, type };
}

// ── Get full run trace ────────────────────────────────────────────────────────
export function getRun(runId) {
  const runFile = path.join(AUDIT_DIR, `${runId}.jsonl`);
  try {
    const events = fs.readFileSync(runFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    // Verify chain integrity
    let chainOk = true;
    for (let i = 1; i < events.length; i++) {
      const expected = crypto.createHash('sha256').update(events[i - 1].hash + JSON.stringify({
        eventId: events[i].eventId, runId: events[i].runId, taskId: events[i].taskId,
        agentId: events[i].agentId, type: events[i].type, data: events[i].data,
        reasoning: events[i].reasoning, ts: events[i].ts, seq: events[i].seq
      })).digest('hex').slice(0, 16);
      if (events[i].hash !== expected) { chainOk = false; break; }
    }
    return { ok: true, runId, events, eventCount: events.length, chainIntegrity: chainOk };
  } catch { return { ok: false, reason: `Run ${runId} not found` }; }
}

// ── Replay simulation ─────────────────────────────────────────────────────────
export function replayRun(runId) {
  const run = getRun(runId);
  if (!run.ok) return run;
  const steps = run.events.map((e, i) => ({
    step: i + 1, type: e.type, agentId: e.agentId,
    summary: buildSummary(e),
    reasoning: e.reasoning,
    ts: new Date(e.ts).toISOString(),
  }));
  return { ok: true, runId, steps, totalSteps: steps.length, chainIntegrity: run.chainIntegrity };
}

function buildSummary(e) {
  const d = e.data || {};
  switch (e.type) {
    case 'TASK_RECEIVED':    return `Task received: "${d.title?.slice(0, 40)}"`;
    case 'DISPATCH_STARTED': return `Dispatch started for ${e.agentId}`;
    case 'SECURITY_CHECK':   return `Security check: ${d.passed ? '✅ PASSED' : '❌ BLOCKED'} (${d.gate || '?'})`;
    case 'TOOL_CALLED':      return `Tool called: ${d.tool} → ${d.result?.slice?.(0, 30) || 'done'}`;
    case 'LLM_QUERIED':      return `LLM query: model=${d.model} tokens=${d.tokens} cost=$${d.cost}`;
    case 'DECISION_MADE':    return `Decision: ${d.decision?.slice(0, 50)}`;
    case 'RESULT_PRODUCED':  return `Result produced: ${d.chars || 0} chars, score=${d.score || '?'}`;
    case 'TASK_COMPLETED':   return `✅ Task completed`;
    case 'TASK_FAILED':      return `❌ Task failed: ${d.reason?.slice(0, 40)}`;
    case 'CHECKPOINT_SET':   return `💾 Checkpoint saved at seq ${d.seq}`;
    case 'RESUMED_FROM':     return `↩️ Resumed from checkpoint at seq ${d.seq}`;
    default:                 return `${e.type}: ${JSON.stringify(d).slice(0, 50)}`;
  }
}

// ── Checkpoint ────────────────────────────────────────────────────────────────
export function saveCheckpoint({ runId, taskId, state }) {
  const cps = loadCheckpoints();
  cps[runId] = { runId, taskId, state, savedAt: Date.now() };
  saveCheckpoints(cps);
  appendEvent({ runId, taskId, type: 'CHECKPOINT_SET', data: { seq: Object.keys(state).length } });
  return { ok: true, runId };
}

export function getCheckpoint(runId) {
  const cps = loadCheckpoints();
  return cps[runId] || null;
}

// ── Recent runs ───────────────────────────────────────────────────────────────
export function getRecentRuns(limit = 10) {
  const index = loadIndex();
  return Object.values(index).sort((a, b) => b.lastEventAt - a.lastEventAt).slice(0, limit);
}

function loadIndex() { try { return JSON.parse(fs.readFileSync(RUNS_INDEX, 'utf8')); } catch { return {}; } }
function saveIndex(d) { try { fs.writeFileSync(RUNS_INDEX, JSON.stringify(d, null, 2)); } catch {} }
function loadCheckpoints() { try { return JSON.parse(fs.readFileSync(CHECKPOINTS, 'utf8')); } catch { return {}; } }
function saveCheckpoints(d) { try { fs.writeFileSync(CHECKPOINTS, JSON.stringify(d, null, 2)); } catch {} }
