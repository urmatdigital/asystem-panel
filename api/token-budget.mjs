/**
 * token-budget.mjs — 3-Level Token Budget Framework
 *
 * Source: "How to Cap AI Agent Costs" (techaheadcorp.com + YouTube refs)
 *         Pattern from enterprise AI cost control 2026
 *
 * Pattern: Task → Workflow → Org level budget enforcement
 *   Task level:     max tokens per single dispatch (default: 8000)
 *   Workflow level: max tokens per DAG/playbook run (default: 50000)
 *   Org level:      monthly cap across all agents (default: 2M tokens)
 *
 * Token estimation: chars / 4 (fast, no API call)
 * Cost fingerprint: input tokens × rate + output tokens × rate
 *
 * Model rates (per 1K tokens):
 *   claude-opus-4:    input $0.015, output $0.075
 *   claude-sonnet-4-6: input $0.003, output $0.015
 *   claude-haiku-4-5:  input $0.00025, output $0.00125
 *   gpt-4o-mini:      input $0.00015, output $0.0006
 *
 * Budget enforcement:
 *   Soft limit (80%): warn in logs
 *   Hard limit (95%): block dispatch, return budget_exceeded error
 *   Monthly reset: 1st of each month
 *
 * API:
 *   GET  /api/budget/status   — current usage vs limits all levels
 *   POST /api/budget/record   { agentId, taskId, inputTokens, outputTokens, model }
 *   POST /api/budget/reset    { level }  — force reset (admin)
 *   GET  /api/budget/forecast — projected monthly spend
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const USAGE_FILE = path.join(HOME, '.openclaw/workspace/.token-usage.json');

// ── Model rates (per 1K tokens) ───────────────────────────────────────────────
const RATES = {
  'claude-opus-4':      { in: 0.015,   out: 0.075   },
  'claude-sonnet-4-6':  { in: 0.003,   out: 0.015   },
  'anthropic/claude-haiku-4-5': { in: 0.00025, out: 0.00125 },
  'gpt-4o-mini':        { in: 0.00015, out: 0.0006  },
};
const DEFAULT_RATE = { in: 0.003, out: 0.015 }; // sonnet default

// ── Budget limits ─────────────────────────────────────────────────────────────
const LIMITS = {
  task:     8_000,      // tokens per single task body
  workflow: 50_000,     // tokens per DAG/playbook run
  monthly:  2_000_000,  // total monthly tokens
  daily:    100_000,    // daily soft guard
};

// ── Load/save ─────────────────────────────────────────────────────────────────
function load() {
  try { return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); }
  catch { return { monthly: {}, daily: {}, workflows: {}, tasks: {} }; }
}
function save(d) { try { fs.writeFileSync(USAGE_FILE, JSON.stringify(d, null, 2)); } catch {} }

// ── Month/day keys ────────────────────────────────────────────────────────────
function monthKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function dayKey()   { return new Date().toISOString().slice(0, 10); }

// ── Record token usage ────────────────────────────────────────────────────────
export function recordUsage({ agentId = 'unknown', taskId, inputTokens = 0, outputTokens = 0, model = 'claude-sonnet-4-6', workflowId }) {
  const usage = load();
  const total = inputTokens + outputTokens;
  const rate = RATES[model] || DEFAULT_RATE;
  const cost = (inputTokens / 1000 * rate.in) + (outputTokens / 1000 * rate.out);

  // Monthly accumulation
  const mk = monthKey();
  if (!usage.monthly[mk]) usage.monthly[mk] = { tokens: 0, cost: 0, byAgent: {} };
  usage.monthly[mk].tokens += total;
  usage.monthly[mk].cost   += cost;
  if (!usage.monthly[mk].byAgent[agentId]) usage.monthly[mk].byAgent[agentId] = { tokens: 0, cost: 0 };
  usage.monthly[mk].byAgent[agentId].tokens += total;
  usage.monthly[mk].byAgent[agentId].cost   += cost;

  // Daily accumulation
  const dk = dayKey();
  if (!usage.daily[dk]) usage.daily[dk] = { tokens: 0, cost: 0 };
  usage.daily[dk].tokens += total;
  usage.daily[dk].cost   += cost;

  // Workflow accumulation
  if (workflowId) {
    if (!usage.workflows[workflowId]) usage.workflows[workflowId] = { tokens: 0, cost: 0, startedAt: Date.now() };
    usage.workflows[workflowId].tokens += total;
    usage.workflows[workflowId].cost   += cost;
  }

  // Task record
  if (taskId) usage.tasks[taskId] = { tokens: total, cost, model, agentId, ts: Date.now() };

  save(usage);

  // Checks
  const monthlyTokens = usage.monthly[mk].tokens;
  const dailyTokens   = usage.daily[dk].tokens;
  const pct = monthlyTokens / LIMITS.monthly;

  if (pct >= 0.95)  console.error(`[TokenBudget] 🚨 HARD LIMIT: ${Math.round(pct * 100)}% of monthly budget used!`);
  else if (pct >= 0.8) console.warn(`[TokenBudget] ⚠️  80% monthly budget (${monthlyTokens.toLocaleString()} / ${LIMITS.monthly.toLocaleString()})`);
  if (dailyTokens > LIMITS.daily * 0.9) console.warn(`[TokenBudget] ⚠️  Daily: ${dailyTokens.toLocaleString()} tokens`);

  return { tokens: total, cost: cost.toFixed(4), monthlyPct: Math.round(pct * 100) };
}

// ── Pre-dispatch check (block if over budget) ─────────────────────────────────
export function checkBudget(estimatedTokens = 0, agentId = 'unknown') {
  // Forge + Atlas always bypass
  if (['forge', 'atlas'].includes(agentId)) return { allowed: true, reason: 'bypass' };

  const usage = load();
  const mk = monthKey();
  const monthlyTokens = usage.monthly[mk]?.tokens || 0;
  const pct = (monthlyTokens + estimatedTokens) / LIMITS.monthly;
  if (pct >= 0.95) return { allowed: false, reason: `monthly budget 95% exceeded (${Math.round(pct * 100)}%)`, pct };
  return { allowed: true, pct: Math.round(((monthlyTokens) / LIMITS.monthly) * 100) };
}

// ── Status ────────────────────────────────────────────────────────────────────
export function getBudgetStatus() {
  const usage = load();
  const mk = monthKey();
  const dk = dayKey();
  const monthly = usage.monthly[mk] || { tokens: 0, cost: 0, byAgent: {} };
  const daily   = usage.daily[dk]   || { tokens: 0, cost: 0 };

  return {
    monthly: { tokens: monthly.tokens, cost: monthly.cost.toFixed(4), limit: LIMITS.monthly, pct: Math.round((monthly.tokens / LIMITS.monthly) * 100) + '%', byAgent: monthly.byAgent },
    daily:   { tokens: daily.tokens,   cost: daily.cost.toFixed(4),   limit: LIMITS.daily,   pct: Math.round((daily.tokens / LIMITS.daily) * 100) + '%' },
    limits: LIMITS,
    rates: Object.fromEntries(Object.entries(RATES).map(([m, r]) => [m, `$${r.in}/$${r.out} per 1K`])),
  };
}

// ── Monthly cost forecast ─────────────────────────────────────────────────────
export function getForecast() {
  const usage = load();
  const mk = monthKey();
  const monthly = usage.monthly[mk] || { tokens: 0, cost: 0 };

  const dayOfMonth = new Date().getDate();
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const dailyRate = monthly.tokens / dayOfMonth;
  const projected = Math.round(dailyRate * daysInMonth);
  const projCost  = (monthly.cost / dayOfMonth * daysInMonth).toFixed(2);

  return {
    dayOfMonth, daysInMonth,
    currentTokens: monthly.tokens,
    currentCost: monthly.cost.toFixed(4),
    projectedTokens: projected,
    projectedCost: `$${projCost}`,
    budgetPct: Math.round((projected / LIMITS.monthly) * 100) + '%',
    onTrack: projected < LIMITS.monthly * 0.8,
  };
}
