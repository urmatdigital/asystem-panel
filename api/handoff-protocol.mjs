/**
 * handoff-protocol.mjs — Structured Agent Handoff Protocol (Antigravity Pattern)
 *
 * Video: "Antigravity + Claude Code IS INCREDIBLE! NEW AI Coding Workflow" (aw_k00T4UFk)
 * Pattern: Primary agent creates structured task list, then hands off EACH PHASE
 *   to a sub-agent with: (a) full context summary, (b) what was already done,
 *   (c) what exactly this sub-agent must do, (d) what NOT to touch.
 *
 * Handoff envelope fields:
 *   from:        source agent
 *   to:          target agent
 *   phase:       which phase of work (PLAN/BUILD/TEST/REVIEW/DEPLOY)
 *   context:     full project context snapshot (what this is, why, goals)
 *   completed:   summary of what previous agents already did
 *   task:        specific thing for THIS agent to do (no more, no less)
 *   constraints: what NOT to touch, what assumptions to follow
 *   artifacts:   files/outputs produced by previous steps
 *   returnTo:    who collects the result
 *   deadline:    expected completion time
 *
 * Protocol flow:
 *   1. POST /api/handoff/create   → create handoff envelope
 *   2. POST /api/handoff/accept   → target agent acknowledges receipt
 *   3. POST /api/handoff/complete → target agent marks phase done + passes to next
 *   4. GET  /api/handoff/:id      → inspect handoff state
 *   5. GET  /api/handoff/chain/:rootId → full handoff chain for a task
 *
 * Anti-pattern prevention:
 *   - No "do everything" handoffs → task must be phase-specific
 *   - No context loss → completed summary required from each agent
 *   - No ghost tasks → accept timeout = 5 min, else re-route
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME         = os.homedir();
const HANDOFF_DIR  = path.join(HOME, '.openclaw/workspace/.handoffs');
const HANDOFF_LOG  = path.join(HOME, '.openclaw/workspace/handoff-log.jsonl');

if (!fs.existsSync(HANDOFF_DIR)) fs.mkdirSync(HANDOFF_DIR, { recursive: true });

const PHASES = ['PLAN', 'ARCHITECT', 'BUILD', 'TEST', 'REVIEW', 'DEPLOY', 'MONITOR'];
const KNOWN_AGENTS = ['forge', 'atlas', 'bekzat', 'ainura', 'marat', 'nurlan', 'dana', 'mesa', 'iron', 'pixel'];

// ── Create a handoff envelope ─────────────────────────────────────────────────
export function createHandoff({ from, to, phase, context = '', completed = '', task = '', constraints = [], artifacts = [], returnTo = null, deadline = null, rootId = null, taskId = null }) {
  if (!KNOWN_AGENTS.includes(from)) return { ok: false, reason: `Unknown source agent: ${from}` };
  if (!KNOWN_AGENTS.includes(to))   return { ok: false, reason: `Unknown target agent: ${to}` };
  if (!PHASES.includes(phase))       return { ok: false, reason: `Unknown phase: ${phase}. Valid: ${PHASES.join(', ')}` };
  if (!task || task.length < 10)     return { ok: false, reason: 'task field is required and must be descriptive (≥10 chars)' };
  if (!context || context.length < 20) return { ok: false, reason: 'context field is required (≥20 chars). The receiving agent needs full background.' };

  const handoffId = `ho_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
  const handoff = {
    handoffId,
    rootId: rootId || handoffId,
    taskId, from, to, phase,
    context, completed, task, constraints, artifacts,
    returnTo: returnTo || from,
    deadline: deadline || new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    status: 'PENDING',
    createdAt: Date.now(),
    acceptedAt: null, completedAt: null,
    result: null, resultArtifacts: [],
  };

  saveHandoff(handoff);
  fs.appendFileSync(HANDOFF_LOG, JSON.stringify({ ts: Date.now(), action: 'create', handoffId, from, to, phase }) + '\n');
  console.log(`[Handoff] 📨 ${from} → ${to} [${phase}]: "${task.slice(0, 50)}"`);
  return { ok: true, handoffId, rootId: handoff.rootId, from, to, phase, status: 'PENDING', acceptDeadline: new Date(Date.now() + 5 * 60 * 1000).toISOString() };
}

// ── Accept a handoff ──────────────────────────────────────────────────────────
export function acceptHandoff({ handoffId, agentId, acknowledgement = '' }) {
  const h = loadHandoff(handoffId);
  if (!h) return { ok: false, reason: `Handoff ${handoffId} not found` };
  if (h.to !== agentId) return { ok: false, reason: `Handoff addressed to ${h.to}, not ${agentId}` };
  if (h.status !== 'PENDING') return { ok: false, reason: `Handoff is already ${h.status}` };

  h.status = 'ACCEPTED';
  h.acceptedAt = Date.now();
  h.acknowledgement = acknowledgement;
  saveHandoff(h);
  fs.appendFileSync(HANDOFF_LOG, JSON.stringify({ ts: Date.now(), action: 'accept', handoffId, agentId, phase: h.phase }) + '\n');
  console.log(`[Handoff] ✅ ${agentId} accepted [${h.phase}] handoff ${handoffId}`);
  return { ok: true, handoffId, phase: h.phase, task: h.task, context: h.context, completed: h.completed, constraints: h.constraints, artifacts: h.artifacts };
}

// ── Complete a handoff and optionally create next ─────────────────────────────
export function completeHandoff({ handoffId, agentId, result = '', resultArtifacts = [], nextAgent = null, nextPhase = null, nextTask = null }) {
  const h = loadHandoff(handoffId);
  if (!h) return { ok: false, reason: `Handoff ${handoffId} not found` };
  if (h.to !== agentId) return { ok: false, reason: `Only ${h.to} can complete this handoff` };
  if (h.status !== 'ACCEPTED') return { ok: false, reason: `Handoff must be ACCEPTED before completing (status: ${h.status})` };
  if (!result || result.length < 10) return { ok: false, reason: 'result field required (≥10 chars). Document what you produced.' };

  h.status = 'COMPLETED';
  h.completedAt = Date.now();
  h.result = result;
  h.resultArtifacts = resultArtifacts;
  saveHandoff(h);
  fs.appendFileSync(HANDOFF_LOG, JSON.stringify({ ts: Date.now(), action: 'complete', handoffId, agentId, phase: h.phase, resultLen: result.length }) + '\n');
  console.log(`[Handoff] 🏁 ${agentId} completed [${h.phase}]: "${result.slice(0, 50)}"`);

  // Auto-create next handoff if specified
  let nextHandoff = null;
  if (nextAgent && nextPhase && nextTask) {
    // Build up completed summary: accumulate previous work
    const updatedCompleted = `${h.completed}\n\n[${h.phase} by ${agentId}]: ${result}`.trim();
    const next = createHandoff({
      from: agentId, to: nextAgent, phase: nextPhase,
      context: h.context, completed: updatedCompleted, task: nextTask,
      constraints: h.constraints, artifacts: [...h.artifacts, ...resultArtifacts],
      returnTo: h.returnTo, rootId: h.rootId, taskId: h.taskId,
    });
    nextHandoff = next;
  }

  return { ok: true, handoffId, phase: h.phase, result: result.slice(0, 100), returnTo: h.returnTo, nextHandoff };
}

// ── Get handoff by ID ─────────────────────────────────────────────────────────
export function getHandoff(handoffId) {
  const h = loadHandoff(handoffId);
  if (!h) return { ok: false, reason: 'Not found' };
  return { ok: true, ...h };
}

// ── Get full chain for a root ID ──────────────────────────────────────────────
export function getChain(rootId) {
  try {
    const all = fs.readdirSync(HANDOFF_DIR).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(HANDOFF_DIR, f), 'utf8')); } catch { return null; } }).filter(Boolean);
    const chain = all.filter(h => h.rootId === rootId).sort((a, b) => a.createdAt - b.createdAt);
    return { ok: true, rootId, length: chain.length, chain: chain.map(h => ({ handoffId: h.handoffId, from: h.from, to: h.to, phase: h.phase, status: h.status, result: h.result?.slice(0, 80) })) };
  } catch { return { ok: false, reason: 'Error loading chain' }; }
}

function loadHandoff(id) { try { return JSON.parse(fs.readFileSync(path.join(HANDOFF_DIR, `${id}.json`), 'utf8')); } catch { return null; } }
function saveHandoff(h) { try { fs.writeFileSync(path.join(HANDOFF_DIR, `${h.handoffId}.json`), JSON.stringify(h, null, 2)); } catch {} }
