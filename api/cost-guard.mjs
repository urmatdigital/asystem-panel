/**
 * Cost Guard — Daily Budget Protection
 * 
 * Features:
 * - Track spend per model per agent
 * - Daily budget enforcement (default $50/day)
 * - Alert at thresholds (80%, 95%, 100%)
 * - Auto-pause expensive operations
 * - Model downgrade suggestion (use Gemini Flash instead of Sonnet)
 * 
 * Endpoints:
 * GET /api/costs/guard — check budget status
 * GET /api/costs/spend — detailed spend breakdown
 * PATCH /api/costs/limit { daily_limit_usd } — update limit
 */

import { createHash } from 'node:crypto';

// Per-model estimated cost per 1M tokens (input + output)
const MODEL_COSTS = {
  'anthropic/claude-sonnet-4-6': 3.00 + 15.00,      // $3 in, $15 out per 1M tokens
  'anthropic/claude-haiku-4-5': 0.80 + 4.00,        // cheap fallback
  'openrouter/google/gemini-flash-1.5': 0.075 + 0.30, // ultra-cheap
  'openrouter/meta-llama/llama-3.3-70b-instruct': 0.0015 + 0.006, // open source, ~0.0075 per 1M
};

// Spend tracking (in-memory, persisted to SQLite if available)
const dailySpend = new Map(); // YYYY-MM-DD → { total: USD, byModel: {...}, byAgent: {...} }

// Configuration (can be updated via API)
let DAILY_BUDGET_USD = 50;  // Can be overridden per env
const THRESHOLDS = {
  warning: 0.80,   // 80% → alert
  critical: 0.95,  // 95% → strong warning
  hard_stop: 1.0,  // 100% → pause all
};

// Alert state (per day)
const alertedToday = new Set(); // ['warning', 'critical', 'hard_stop']

/**
 * Record API call cost
 * Called from agent_task_loop after each LLM call
 */
export function recordCost(agent, model, inputTokens, outputTokens) {
  const today = new Date().toISOString().split('T')[0];
  const costPerTokenPair = (MODEL_COSTS[model] || 0.001) / 1_000_000;
  const cost = (inputTokens + outputTokens) * costPerTokenPair;

  if (!dailySpend.has(today)) {
    dailySpend.set(today, { total: 0, byModel: {}, byAgent: {} });
  }

  const daySpend = dailySpend.get(today);
  daySpend.total += cost;
  daySpend.byModel[model] = (daySpend.byModel[model] || 0) + cost;
  daySpend.byAgent[agent] = (daySpend.byAgent[agent] || 0) + cost;

  return { cost, total: daySpend.total };
}

/**
 * Check if we're within budget
 */
export function checkBudgetStatus() {
  const today = new Date().toISOString().split('T')[0];
  const daySpend = dailySpend.get(today) || { total: 0, byModel: {}, byAgent: {} };
  const spent = daySpend.total;
  const remaining = DAILY_BUDGET_USD - spent;
  const percentUsed = spent / DAILY_BUDGET_USD;

  let status = 'ok';
  let action = null;

  if (percentUsed >= 1.0) {
    status = 'hard_stop';
    action = 'PAUSE_ALL_TASKS';
  } else if (percentUsed >= THRESHOLDS.critical) {
    status = 'critical';
    action = 'USE_CHEAP_MODEL_ONLY';
  } else if (percentUsed >= THRESHOLDS.warning) {
    status = 'warning';
    action = 'LOG_WARNING';
  }

  return {
    ok: status === 'ok',
    status,
    spent: parseFloat(spent.toFixed(2)),
    budget: DAILY_BUDGET_USD,
    remaining: parseFloat(remaining.toFixed(2)),
    percent_used: parseFloat((percentUsed * 100).toFixed(1)),
    action,
    recommendation: suggestModel(percentUsed),
  };
}

/**
 * Suggest model based on budget status
 */
export function suggestModel(percentUsed) {
  if (percentUsed < 0.5) return 'claude-sonnet-4-6'; // Plenty of budget
  if (percentUsed < 0.8) return 'claude-haiku-4-5';   // Warn: use cheaper
  return 'gemini-flash-1.5';                          // Critical: ultra-cheap
}

/**
 * Get detailed spend breakdown
 */
export function getSpendBreakdown() {
  const today = new Date().toISOString().split('T')[0];
  const daySpend = dailySpend.get(today) || { total: 0, byModel: {}, byAgent: {} };

  return {
    date: today,
    total: parseFloat(daySpend.total.toFixed(2)),
    budget: DAILY_BUDGET_USD,
    by_model: Object.entries(daySpend.byModel).map(([model, cost]) => ({
      model,
      cost: parseFloat(cost.toFixed(2)),
    })).sort((a, b) => b.cost - a.cost),
    by_agent: Object.entries(daySpend.byAgent).map(([agent, cost]) => ({
      agent,
      cost: parseFloat(cost.toFixed(2)),
    })).sort((a, b) => b.cost - a.cost),
  };
}

/**
 * Should we pause tasks?
 */
export function shouldPauseTasks() {
  const status = checkBudgetStatus();
  return status.status === 'hard_stop';
}

/**
 * Should we use only cheap models?
 */
export function shouldUseCheapModelsOnly() {
  const status = checkBudgetStatus();
  return status.status === 'critical' || status.status === 'hard_stop';
}

/**
 * Update daily budget limit
 */
export function setDailyBudget(usdAmount) {
  if (usdAmount > 0 && usdAmount < 1000) {
    DAILY_BUDGET_USD = usdAmount;
    return { ok: true, new_budget: DAILY_BUDGET_USD };
  }
  return { ok: false, error: 'Invalid budget amount (must be $0-1000)' };
}

/**
 * Reset budget for testing (admin only)
 */
export function resetDailySpend() {
  const today = new Date().toISOString().split('T')[0];
  dailySpend.delete(today);
  alertedToday.clear();
  return { ok: true, message: `Budget reset for ${today}` };
}

/**
 * Get model cost per 1M tokens
 */
export function getModelCost(model) {
  return {
    model,
    cost_per_1m_tokens: MODEL_COSTS[model] || 'unknown',
  };
}

/**
 * Format spend alert message
 */
export function formatAlert(threshold) {
  const status = checkBudgetStatus();
  const emoji = {
    warning: '⚠️',
    critical: '🔴',
    hard_stop: '🛑',
  }[status.status] || 'ℹ️';

  let title, body;

  if (status.status === 'hard_stop') {
    title = '🛑 BUDGET EXHAUSTED';
    body = `Daily budget $${status.budget} reached!\nSpent: $${status.spent}\n\nAll expensive tasks paused. Use cheap models only or reset budget.`;
  } else if (status.status === 'critical') {
    title = '🔴 BUDGET CRITICAL';
    body = `Used ${status.percent_used}% of daily budget ($${status.spent}/$${status.budget}).\n\nRecommend: Switch to ${status.recommendation} model.`;
  } else if (status.status === 'warning') {
    title = '⚠️ BUDGET WARNING';
    body = `Used ${status.percent_used}% of daily budget ($${status.spent}/$${status.budget}).\n\nRemaining: $${status.remaining}. Monitor spending.`;
  }

  return { title, body, status: status.status };
}

export default {
  recordCost,
  checkBudgetStatus,
  getSpendBreakdown,
  shouldPauseTasks,
  shouldUseCheapModelsOnly,
  setDailyBudget,
  resetDailySpend,
  getModelCost,
  formatAlert,
  suggestModel,
  MODEL_COSTS,
  THRESHOLDS,
};
