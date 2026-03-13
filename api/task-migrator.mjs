/**
 * task-migrator.mjs — Task Migration / Agent Handoff with State Preservation
 *
 * Video: "Reflexion, Human-in-the-Loop & Agentic RAG — AI Agent Intelligence Layer" (zvLt5TVOBNc)
 * Pattern: Safety checkpoints before state-changing actions + structured agent handoff
 *          when work needs to transfer between agents (overload, specialization, failure)
 *
 * Handoff packet (what gets transferred):
 *   - Original task context (title, body, priority)
 *   - Progress snapshot (what was done so far)
 *   - Partial artifacts (code written, decisions made)
 *   - Why handoff (reason: overload | timeout | specialization | failure)
 *   - Continuity prompt: "Continue from where {from} left off: {progress}"
 *
 * Migration triggers:
 *   1. Agent overloaded (throttle limit hit) → migrate to next available
 *   2. Agent timed out (45min SLA) → migrate to faster agent
 *   3. Specialization needed (complexity > agent.level) → migrate to expert
 *   4. Agent failed (DLQ) → migrate to backup agent
 *
 * Checkpoint before migration:
 *   Immutable ledger entry + human-approval for destructive/critical tasks
 *
 * API:
 *   POST /api/migrate           { taskId, fromAgent, toAgent, reason, progress?, artifacts? }
 *   GET  /api/migrate/history   → migration log
 *   POST /api/migrate/checkpoint { taskId, agentId, state } → save checkpoint before risky op
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const MIG_LOG   = path.join(HOME, '.openclaw/workspace/migration-log.jsonl');
const CKPT_FILE = path.join(HOME, '.openclaw/workspace/.migration-checkpoints.json');

const MIGRATION_REASONS = {
  overload:       { label: 'Agent overloaded',           urgency: 'medium', requiresApproval: false },
  timeout:        { label: 'SLA timeout (45min)',        urgency: 'high',   requiresApproval: false },
  specialization: { label: 'Needs specialist skills',    urgency: 'low',    requiresApproval: false },
  failure:        { label: 'Agent failed (DLQ)',         urgency: 'high',   requiresApproval: false },
  destructive:    { label: 'Destructive op — approval',  urgency: 'critical', requiresApproval: true },
};

// Fallback agents per role (if primary fails)
const BACKUP_AGENTS = {
  forge:  ['atlas', 'iron'],
  atlas:  ['forge'],
  bekzat: ['ainura', 'nurlan'],
  ainura: ['bekzat'],
  marat:  ['bekzat', 'ainura'],
  nurlan: ['bekzat', 'iron'],
  dana:   ['forge', 'atlas'],
  mesa:   ['forge'],
  iron:   ['nurlan', 'bekzat'],
  pixel:  ['ainura'],
};

// ── Build handoff packet ───────────────────────────────────────────────────────
function buildHandoffPacket({ taskId, fromAgent, toAgent, reason, progress = '', artifacts = [], title = '', body = '', priority = 'medium' }) {
  const reasonMeta = MIGRATION_REASONS[reason] || { label: reason, urgency: 'medium', requiresApproval: false };

  const continuityPrompt = [
    `[HANDOFF from ${fromAgent} → ${toAgent}]`,
    `Reason: ${reasonMeta.label}`,
    progress ? `Progress so far: ${progress}` : 'Task was not started yet.',
    artifacts.length > 0 ? `Artifacts: ${artifacts.join(', ')}` : '',
    `Original task: ${title}`,
    body ? `Context: ${body.slice(0, 300)}` : '',
    `Priority: ${priority}`,
    `\nPlease continue from where ${fromAgent} left off. Do NOT repeat completed work.`,
  ].filter(Boolean).join('\n');

  return { taskId, fromAgent, toAgent, reason, reasonMeta, continuityPrompt, progress, artifacts, title, priority, ts: Date.now() };
}

// ── Execute migration ─────────────────────────────────────────────────────────
export async function migrateTask({ taskId, fromAgent, toAgent, reason = 'timeout', progress = '', artifacts = [], title = '', body = '', priority = 'medium' }) {
  const packet = buildHandoffPacket({ taskId, fromAgent, toAgent, reason, progress, artifacts, title, body, priority });
  const reasonMeta = MIGRATION_REASONS[reason] || {};

  // Checkpoint in ledger
  try {
    const { ledgerAppend } = await import('./immutable-ledger.mjs');
    ledgerAppend({ agentId: fromAgent, action: 'task_migrated', data: { taskId, toAgent, reason }, severity: 'medium' });
  } catch {}

  // Log migration
  const entry = { ts: Date.now(), taskId, fromAgent, toAgent, reason, urgency: reasonMeta.urgency, progress: progress.slice(0, 100), requiresApproval: reasonMeta.requiresApproval };
  fs.appendFileSync(MIG_LOG, JSON.stringify(entry) + '\n');
  console.log(`[Migrator] 🔄 Task ${taskId}: ${fromAgent} → ${toAgent} [${reason}]`);

  return {
    ok: true,
    packet,
    requiresApproval: reasonMeta.requiresApproval,
    suggestedDispatch: {
      to:       toAgent,
      title:    `[CONTINUED] ${title}`,
      body:     packet.continuityPrompt,
      priority,
      tags:     ['handoff', 'migration', fromAgent],
      _migrationMeta: { fromAgent, reason, taskId },
    },
  };
}

// ── Save checkpoint ────────────────────────────────────────────────────────────
export function saveCheckpoint({ taskId, agentId, state = {} }) {
  const ckpts = loadCheckpoints();
  ckpts[taskId] = { agentId, state, ts: Date.now() };
  if (Object.keys(ckpts).length > 100) {
    // Prune oldest
    const sorted = Object.entries(ckpts).sort((a, b) => a[1].ts - b[1].ts);
    for (const [k] of sorted.slice(0, 20)) delete ckpts[k];
  }
  saveCheckpoints(ckpts);
  return { ok: true, taskId, agentId, checkpoint: ckpts[taskId] };
}

export function getCheckpoint(taskId) {
  const ckpts = loadCheckpoints();
  return ckpts[taskId] || null;
}

function loadCheckpoints() { try { return JSON.parse(fs.readFileSync(CKPT_FILE, 'utf8')); } catch { return {}; } }
function saveCheckpoints(d) { try { fs.writeFileSync(CKPT_FILE, JSON.stringify(d, null, 2)); } catch {} }

// ── Get backup agent ───────────────────────────────────────────────────────────
export function getBackupAgent(agentId) {
  return BACKUP_AGENTS[agentId]?.[0] || 'forge';
}

// ── Migration history ─────────────────────────────────────────────────────────
export function getMigrationHistory(limit = 20) {
  try {
    return fs.readFileSync(MIG_LOG, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean).slice(-limit).reverse();
  } catch { return []; }
}
