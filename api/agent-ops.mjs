/**
 * agent-ops.mjs — Agent Ops Observability Dashboard
 *
 * Video: "Stop Burning Cash: The 2026 Agent Ops Blueprint" (NTVRGWOGFCw)
 * Pattern: LLM Ops → Agent Ops upgrade: go beyond token counts to behavioral baselines,
 *          decision trace aggregation, cost-per-outcome, and real-time activity snapshot
 *
 * Agent Ops adds on top of existing LLM Ops:
 *   Behavioral Baselines: track reasoning chain length, action distribution, confidence drift
 *   Decision Trace Agg:   aggregate CoT traces by agent → top failure modes
 *   Cost-per-Outcome:     token cost / Karpathy score → "quality-adjusted cost"
 *   Live Activity:        what each agent is doing RIGHT NOW (last dispatch)
 *   Burn Rate:            tokens/hour, projected monthly cost
 *   Efficiency Score:     score/cost ratio → higher = better value
 *
 * API:
 *   GET /api/agent-ops/dashboard    → full ops view
 *   GET /api/agent-ops/activity     → live agent activity (last 30min)
 *   GET /api/agent-ops/burn-rate    → cost burn rate + projection
 *   GET /api/agent-ops/efficiency   → quality-adjusted cost per agent
 *   POST /api/agent-ops/record      { agentId, event, tokens?, cost?, score?, durationMs? }
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME     = os.homedir();
const OPS_LOG  = path.join(HOME, '.openclaw/workspace/agent-ops.jsonl');
const OPS_SNAP = path.join(HOME, '.openclaw/workspace/.agent-ops-snap.json');

// ── Record ops event ───────────────────────────────────────────────────────────
export function recordOps({ agentId, event, tokens = 0, cost = 0, score, durationMs = 0, taskId, title }) {
  const entry = { ts: Date.now(), agentId, event, tokens, cost, score, durationMs, taskId, title: title?.slice(0, 60) };
  try { fs.appendFileSync(OPS_LOG, JSON.stringify(entry) + '\n'); } catch {}

  // Update live snapshot
  try {
    const snap = loadSnap();
    if (!snap[agentId]) snap[agentId] = { lastEvent: null, totalTokens: 0, totalCost: 0, scores: [], tasks: 0 };
    snap[agentId].lastEvent  = entry;
    snap[agentId].totalTokens += tokens;
    snap[agentId].totalCost  += cost;
    snap[agentId].tasks++;
    if (score !== undefined) { snap[agentId].scores.push(score); if (snap[agentId].scores.length > 20) snap[agentId].scores.shift(); }
    saveSnap(snap);
  } catch {}
}

function loadSnap() { try { return JSON.parse(fs.readFileSync(OPS_SNAP, 'utf8')); } catch { return {}; } }
function saveSnap(d) { try { fs.writeFileSync(OPS_SNAP, JSON.stringify(d, null, 2)); } catch {} }

// ── Load recent events (last N hours) ────────────────────────────────────────
function loadEvents(hours = 24) {
  try {
    const cutoff = Date.now() - hours * 3600000;
    return fs.readFileSync(OPS_LOG, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && e.ts > cutoff);
  } catch { return []; }
}

// ── Full dashboard ─────────────────────────────────────────────────────────────
export function getDashboard() {
  const snap    = loadSnap();
  const events  = loadEvents(24);
  const now     = Date.now();
  const AGENTS  = ['forge','atlas','bekzat','ainura','marat','nurlan','dana','mesa','iron','pixel'];

  const byAgent = {};
  for (const a of AGENTS) {
    const s = snap[a] || {};
    const recentEvents = events.filter(e => e.agentId === a);
    const avgScore = s.scores?.length > 0 ? Math.round(s.scores.reduce((x, v) => x + v, 0) / s.scores.length * 10) / 10 : null;
    const costPerScore = s.totalCost > 0 && avgScore ? Math.round(s.totalCost / avgScore * 1000) / 1000 : null;
    const lastActive   = s.lastEvent?.ts ? Math.round((now - s.lastEvent.ts) / 60000) : null;
    const idleMins     = lastActive;

    byAgent[a] = {
      lastEvent:     s.lastEvent?.event || 'never',
      lastTitle:     s.lastEvent?.title || null,
      lastActiveMins: idleMins,
      status:        idleMins === null ? 'never' : idleMins < 30 ? '🟢 active' : idleMins < 120 ? '🟡 idle' : '⚫ offline',
      totalTokens:   s.totalTokens || 0,
      totalCost:     Math.round((s.totalCost || 0) * 10000) / 10000,
      tasks:         s.tasks || 0,
      avgScore,
      costPerScore,
      efficiency:    avgScore && s.totalCost > 0 ? Math.round((avgScore / Math.max(s.totalCost, 0.001)) * 100) / 100 : null,
      events24h:     recentEvents.length,
    };
  }

  // Totals
  const totalTokens = Object.values(snap).reduce((s, a) => s + (a.totalTokens || 0), 0);
  const totalCost   = Object.values(snap).reduce((s, a) => s + (a.totalCost || 0), 0);
  const totalTasks  = Object.values(snap).reduce((s, a) => s + (a.tasks || 0), 0);

  return { ts: now, byAgent, totals: { totalTokens, totalCost: Math.round(totalCost * 10000) / 10000, totalTasks, events24h: events.length } };
}

// ── Live activity (last 30 min) ─────────────────────────────────────────────────
export function getLiveActivity() {
  const events = loadEvents(0.5); // 30 min
  const snap   = loadSnap();
  const AGENTS = ['forge','atlas','bekzat','ainura','marat','nurlan','dana','mesa','iron','pixel'];
  return AGENTS.map(a => {
    const s = snap[a] || {};
    const recent = events.filter(e => e.agentId === a).slice(-3);
    return { agentId: a, lastEvent: s.lastEvent?.event, lastTitle: s.lastEvent?.title, recentEvents: recent };
  }).filter(a => a.lastEvent);
}

// ── Burn rate ─────────────────────────────────────────────────────────────────
export function getBurnRate() {
  const events24h = loadEvents(24);
  const totalTokens24h = events24h.reduce((s, e) => s + (e.tokens || 0), 0);
  const totalCost24h   = events24h.reduce((s, e) => s + (e.cost   || 0), 0);
  const tokensPerHour  = Math.round(totalTokens24h / 24);
  const costPerHour    = Math.round(totalCost24h / 24 * 10000) / 10000;
  const projectedMonthly = Math.round(costPerHour * 24 * 30 * 100) / 100;
  return { tokensPerHour, costPerHour, projectedMonthly, totalTokens24h, totalCost24h: Math.round(totalCost24h * 10000) / 10000, sampleEvents: events24h.length };
}
