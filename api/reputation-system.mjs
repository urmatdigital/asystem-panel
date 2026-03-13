/**
 * reputation-system.mjs — Cross-Agent Reputation & Trust Scoring
 *
 * Video: "Roundtable Discussion on AI in 2026, Session 4" (R3zgolOc6g8)
 * Pattern: Agents earn/lose reputation based on:
 *   - Task quality scores (Karpathy/environment reward)
 *   - Peer reviews from other agents
 *   - SLA compliance (on-time delivery)
 *   - Security incidents (violations → penalty)
 *   - Successful collaborations (coalition outcomes)
 *
 * Reputation score: 0-100
 *   0-30:   PROBATION — extra quality gates, requires review
 *   31-50:  DEVELOPING — guided mode, skill injections prioritized
 *   51-70:  COMPETENT — standard operation
 *   71-85:  SENIOR — can act as coalition LEAD, fewer gates
 *   86-100: EXPERT — trusted, can bypass some checks, mentor others
 *
 * Reputation events:
 *   +5   task completed score ≥ 9
 *   +3   task completed score 7-8
 *   +1   task completed score 5-6
 *   -2   task failed (non-critical)
 *   -5   task failed (critical)
 *   +3   peer review approved by high-reputation agent
 *   -3   security violation flagged by iron
 *   +2   SLA met (on-time delivery)
 *   -1   SLA missed
 *   +4   coalition successfully delivered
 *
 * API:
 *   POST /api/rep/event    { agentId, event, meta? } → update reputation
 *   GET  /api/rep/:agentId → agent reputation + level
 *   GET  /api/rep/board    → all agents leaderboard
 *   POST /api/rep/peer-review { fromAgent, toAgent, score, taskId }
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME     = os.homedir();
const REP_FILE = path.join(HOME, '.openclaw/workspace/.reputation.json');
const REP_LOG  = path.join(HOME, '.openclaw/workspace/reputation-log.jsonl');

// ── Reputation events and deltas ──────────────────────────────────────────────
const EVENTS = {
  task_excellent:      { delta: +5, desc: 'Task completed with score ≥9' },
  task_good:           { delta: +3, desc: 'Task completed with score 7-8' },
  task_ok:             { delta: +1, desc: 'Task completed with score 5-6' },
  task_poor:           { delta: -1, desc: 'Task completed with score <5' },
  task_failed:         { delta: -2, desc: 'Task failed (non-critical)' },
  task_failed_critical:{ delta: -5, desc: 'Critical task failed' },
  peer_review_positive:{ delta: +3, desc: 'Peer review approved by senior agent' },
  peer_review_negative:{ delta: -2, desc: 'Peer review flagged issues' },
  security_violation:  { delta: -3, desc: 'Security gate violation' },
  sla_met:             { delta: +2, desc: 'SLA met — on-time delivery' },
  sla_missed:          { delta: -1, desc: 'SLA missed' },
  coalition_success:   { delta: +4, desc: 'Coalition successfully delivered' },
  coalition_fail:      { delta: -3, desc: 'Coalition failed delivery' },
  knowledge_shared:    { delta: +1, desc: 'Contributed to federated knowledge' },
  blast_radius_hit:    { delta: -4, desc: 'Blast radius violation — dangerous action' },
};

const LEVELS = [
  { min: 0,  max: 30,  level: 'PROBATION',  emoji: '🔴', perks: [] },
  { min: 31, max: 50,  level: 'DEVELOPING', emoji: '🟠', perks: ['skill_injection_priority'] },
  { min: 51, max: 70,  level: 'COMPETENT',  emoji: '🟡', perks: ['standard_ops'] },
  { min: 71, max: 85,  level: 'SENIOR',     emoji: '🟢', perks: ['coalition_lead', 'fewer_gates'] },
  { min: 86, max: 100, level: 'EXPERT',     emoji: '⭐', perks: ['bypass_some_checks', 'can_mentor', 'coalition_lead'] },
];

// ── Initial reputation per agent ──────────────────────────────────────────────
const INITIAL_REPS = {
  forge: 85, atlas: 85, bekzat: 65, ainura: 65,
  marat: 60, nurlan: 60, dana: 55, mesa: 60, iron: 70, pixel: 55,
};

// ── Load/save ──────────────────────────────────────────────────────────────────
function loadRep() {
  try { return JSON.parse(fs.readFileSync(REP_FILE, 'utf8')); }
  catch {
    const init = {};
    for (const [a, score] of Object.entries(INITIAL_REPS)) {
      init[a] = { score, events: [], lastUpdated: Date.now() };
    }
    return init;
  }
}
function saveRep(d) { try { fs.writeFileSync(REP_FILE, JSON.stringify(d, null, 2)); } catch {} }

function getLevel(score) { return LEVELS.find(l => score >= l.min && score <= l.max) || LEVELS[0]; }

// ── Apply reputation event ────────────────────────────────────────────────────
export function applyEvent({ agentId, event, meta = {} }) {
  const def = EVENTS[event];
  if (!def) return { ok: false, reason: `Unknown event: ${event}` };

  const rep = loadRep();
  if (!rep[agentId]) rep[agentId] = { score: 50, events: [], lastUpdated: Date.now() };

  const prevScore = rep[agentId].score;
  const newScore  = Math.max(0, Math.min(100, prevScore + def.delta));
  rep[agentId].score = newScore;
  rep[agentId].lastUpdated = Date.now();
  rep[agentId].events = [...(rep[agentId].events || []).slice(-20), { ts: Date.now(), event, delta: def.delta, score: newScore, meta }];

  const prevLevel = getLevel(prevScore);
  const newLevel  = getLevel(newScore);
  const levelChanged = prevLevel.level !== newLevel.level;
  saveRep(rep);

  const entry = { ts: Date.now(), agentId, event, delta: def.delta, prevScore, newScore };
  fs.appendFileSync(REP_LOG, JSON.stringify(entry) + '\n');

  const dir = def.delta > 0 ? '📈' : '📉';
  console.log(`[Rep] ${dir} ${agentId}: ${event} → ${prevScore}→${newScore} (${def.delta > 0 ? '+' : ''}${def.delta})${levelChanged ? ` 🎯 LEVEL UP: ${newLevel.level}!` : ''}`);
  return { ok: true, agentId, event, delta: def.delta, prevScore, newScore, level: newLevel, levelChanged };
}

// ── Peer review ───────────────────────────────────────────────────────────────
export function peerReview({ fromAgent, toAgent, score, taskId }) {
  const rep = loadRep();
  const reviewerScore = rep[fromAgent]?.score || 50;

  // Weight review by reviewer's own reputation
  const weightedScore = score * (reviewerScore / 100);
  const event = weightedScore >= 7 ? 'peer_review_positive' : 'peer_review_negative';
  const result = applyEvent({ agentId: toAgent, event, meta: { fromAgent, reviewScore: score, taskId } });
  console.log(`[Rep] 👥 Peer review: ${fromAgent}(rep=${reviewerScore}) → ${toAgent}: score=${score} → ${event}`);
  return { ok: true, fromAgent, toAgent, reviewScore: score, weightedScore: Math.round(weightedScore * 10) / 10, event, result };
}

// ── Get reputation ────────────────────────────────────────────────────────────
export function getReputation(agentId) {
  const rep = loadRep();
  const agent = rep[agentId] || { score: 50, events: [] };
  const level = getLevel(agent.score);
  return { agentId, score: agent.score, level: level.level, emoji: level.emoji, perks: level.perks, recentEvents: (agent.events || []).slice(-5), lastUpdated: agent.lastUpdated };
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
export function getLeaderboard() {
  const rep = loadRep();
  return Object.entries(rep).map(([agentId, data]) => {
    const level = getLevel(data.score);
    return { agentId, score: data.score, level: level.level, emoji: level.emoji };
  }).sort((a, b) => b.score - a.score);
}

// ── Auto-apply reputation from task completion (called by task complete hook) ──
export function applyTaskScore({ agentId, score, priority }) {
  let event;
  if (score >= 9)      event = 'task_excellent';
  else if (score >= 7) event = 'task_good';
  else if (score >= 5) event = 'task_ok';
  else                 event = 'task_poor';
  return applyEvent({ agentId, event, meta: { score, priority } });
}
