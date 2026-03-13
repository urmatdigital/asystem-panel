/**
 * reputation.mjs — Agent Reputation Score & Trust Network
 *
 * Video: "The NEW Way to Build AI Automations in 2026 (Antigravity)" (8MVRda34vjQ)
 * Pattern: Agents earn/lose reputation based on outcomes → trust routes tasks
 *
 * Reputation score (0-100) based on:
 *   + Task completions (weight by priority: critical=5, high=3, medium=2, low=1)
 *   + Karpathy quality scores (rolling avg last 20)
 *   + Peer review approvals (marat/ainura reviewing bekzat's code)
 *   - Failed tasks (-3 pts each)
 *   - Security violations (-10 pts each)
 *   - TTL expirations (-5 pts each)
 *   - Blast radius violations (-8 pts each)
 *
 * Trust levels:
 *   EXPERT    (85-100): can receive critical tasks, trusted reviewer
 *   RELIABLE  (70-84):  receives high tasks by default
 *   ADEQUATE  (50-69):  medium tasks, monitored
 *   PROBATION (30-49):  low tasks only, peer review required
 *   SUSPENDED (<30):    no autonomous dispatch, human approval required
 *
 * Trust routing: when multiple agents qualify, prefer higher reputation
 *
 * API:
 *   GET  /api/reputation          → all agent scores + trust levels
 *   GET  /api/reputation/:agentId → agent detail + history
 *   POST /api/reputation/event    { agentId, event, weight?, meta? }
 *   GET  /api/reputation/leaderboard → top 5 by score
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const REP_FILE  = path.join(HOME, '.openclaw/workspace/.reputation.json');
const REP_LOG   = path.join(HOME, '.openclaw/workspace/reputation-log.jsonl');

const AGENTS = ['forge','atlas','bekzat','ainura','marat','nurlan','dana','mesa','iron','pixel'];

// ── Trust levels ──────────────────────────────────────────────────────────────
const TRUST_LEVELS = [
  { min: 85,  label: 'EXPERT',    emoji: '🏆', maxPriority: 'critical' },
  { min: 70,  label: 'RELIABLE',  emoji: '✅', maxPriority: 'high' },
  { min: 50,  label: 'ADEQUATE',  emoji: '⚠️', maxPriority: 'medium' },
  { min: 30,  label: 'PROBATION', emoji: '🔶', maxPriority: 'low' },
  { min: 0,   label: 'SUSPENDED', emoji: '🚫', maxPriority: null },
];

function getTrustLevel(score) { return TRUST_LEVELS.find(t => score >= t.min) || TRUST_LEVELS[TRUST_LEVELS.length - 1]; }

// ── Event weights ─────────────────────────────────────────────────────────────
const EVENT_WEIGHTS = {
  task_done_critical:  +5,
  task_done_high:      +3,
  task_done_medium:    +2,
  task_done_low:       +1,
  task_failed:         -3,
  karpathy_high:       +2,  // score >= 8
  karpathy_low:        -1,  // score < 5
  peer_approved:       +2,
  peer_rejected:       -2,
  security_violation:  -10,
  ttl_expired:         -5,
  blast_radius:        -8,
  milestone_completed: +4,
};

// ── Load/save ─────────────────────────────────────────────────────────────────
function load() {
  try { return JSON.parse(fs.readFileSync(REP_FILE, 'utf8')); }
  catch {
    // Initialize all agents at 70 (RELIABLE baseline)
    const init = {};
    for (const a of AGENTS) init[a] = { score: 70, events: [], karpathyScores: [] };
    return init;
  }
}
function save(d) { try { fs.writeFileSync(REP_FILE, JSON.stringify(d, null, 2)); } catch {} }

// ── Record event ──────────────────────────────────────────────────────────────
export function recordEvent({ agentId, event, weight, meta = {} }) {
  const data  = load();
  if (!data[agentId]) data[agentId] = { score: 70, events: [], karpathyScores: [] };

  const delta   = weight !== undefined ? weight : (EVENT_WEIGHTS[event] || 0);
  const before  = data[agentId].score;
  data[agentId].score = Math.max(0, Math.min(100, before + delta));
  data[agentId].events.push({ ts: Date.now(), event, delta, score: data[agentId].score });

  // Keep last 50 events
  if (data[agentId].events.length > 50) data[agentId].events = data[agentId].events.slice(-50);

  // Track Karpathy scores separately
  if (meta.karpathyScore !== undefined) {
    data[agentId].karpathyScores.push(meta.karpathyScore);
    if (data[agentId].karpathyScores.length > 20) data[agentId].karpathyScores.shift();
  }

  save(data);

  const trust  = getTrustLevel(data[agentId].score);
  const change = delta >= 0 ? `+${delta}` : `${delta}`;
  const logEntry = { ts: Date.now(), agentId, event, delta, before, after: data[agentId].score, trust: trust.label, meta };
  fs.appendFileSync(REP_LOG, JSON.stringify(logEntry) + '\n');

  if (Math.abs(delta) >= 5) {
    console.log(`[Reputation] ${trust.emoji} ${agentId}: ${before} → ${data[agentId].score} (${change}) [${trust.label}]`);
  }

  return { agentId, before, after: data[agentId].score, delta, trust: trust.label, trustEmoji: trust.emoji };
}

// ── Get all scores ────────────────────────────────────────────────────────────
export function getAllReputation() {
  const data = load();
  return Object.fromEntries(AGENTS.map(a => {
    const d = data[a] || { score: 70, events: [] };
    const trust = getTrustLevel(d.score);
    const avgKarpathy = d.karpathyScores?.length > 0 ? Math.round(d.karpathyScores.reduce((s, v) => s + v, 0) / d.karpathyScores.length * 10) / 10 : null;
    return [a, { score: d.score, trust: trust.label, emoji: trust.emoji, maxPriority: trust.maxPriority, avgKarpathy, recentEvents: (d.events || []).slice(-3) }];
  }));
}

// ── Get leaderboard ───────────────────────────────────────────────────────────
export function getLeaderboard() {
  const data = load();
  return AGENTS.map(a => {
    const d = data[a] || { score: 70 };
    const trust = getTrustLevel(d.score);
    return { agentId: a, score: d.score, trust: trust.label, emoji: trust.emoji };
  }).sort((a, b) => b.score - a.score).slice(0, 5);
}

// ── Check if agent is trusted for priority ────────────────────────────────────
export function isTrustedFor(agentId, priority = 'medium') {
  const data = load();
  const score = data[agentId]?.score ?? 70;
  const trust = getTrustLevel(score);
  const LEVELS = { null: 0, low: 1, medium: 2, high: 3, critical: 4 };
  return LEVELS[trust.maxPriority] >= LEVELS[priority];
}

export function getAgentReputation(agentId) {
  const all = getAllReputation();
  return all[agentId] || null;
}
