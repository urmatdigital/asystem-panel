/**
 * cost-optimizer.mjs — LLM Cost Optimizer
 *
 * Video: "Building a Cloud Cost Optimizer From One Prompt" (c4bdsRLyALQ, ODSC AI 2026)
 * Pattern: Model tiering — match task complexity to cheapest sufficient model
 *   reserved (haiku) / on-demand (sonnet) / spot (opus) — like cloud instances
 *   Goal: 30-36% LLM cost reduction without quality loss
 *
 * Model tiers:
 *   NANO   — claude-haiku-4-5 / gpt-4o-mini  (simple, fast, cheap)
 *   STANDARD — claude-sonnet-4-6             (default, balanced)
 *   PREMIUM — claude-opus-4                  (complex reasoning only)
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME         = os.homedir();
const COST_LOG     = path.join(HOME, '.openclaw/workspace/cost-optimizer-log.jsonl');
const BUDGET_FILE  = path.join(HOME, '.openclaw/workspace/.budget.json');

// ── Model tiers (like cloud: reserved/on-demand/spot) ────────────────────────
export const MODEL_TIERS = {
  NANO: {
    model: 'anthropic/claude-haiku-4-5',
    costPer1k: 0.00025,   // $0.00025 per 1k tokens
    label: 'nano',
    maxComplexity: 30,    // complexity score threshold
  },
  STANDARD: {
    model: 'anthropic/claude-sonnet-4-6',
    costPer1k: 0.003,     // $0.003 per 1k tokens
    label: 'standard',
    maxComplexity: 70,
  },
  PREMIUM: {
    model: 'anthropic/claude-opus-4',
    costPer1k: 0.015,     // $0.015 per 1k tokens
    label: 'premium',
    maxComplexity: 100,
  },
};

// ── Task signals that indicate complexity ─────────────────────────────────────
const NANO_SIGNALS = [
  /status|check|ping|health|list|get|fetch|read|show|display|verify/i,
  /simple|quick|fast|brief|short|summary/i,
  /echo|log|print|notify|alert/i,
];

const PREMIUM_SIGNALS = [
  /architect|design|system|complex|critical|production|refactor/i,
  /security audit|penetration|vulnerability|compliance/i,
  /multi.?step|pipeline|orchestrat|coordinate/i,
  /analyze.*full|comprehensive|in.?depth|thorough/i,
  /debug.*production|root cause|post.?mortem/i,
];

// ── Per-agent model overrides (workers use cheaper models) ────────────────────
const AGENT_MODEL_OVERRIDE = {
  dana:  MODEL_TIERS.NANO.model,    // PM tasks → nano
  marat: MODEL_TIERS.NANO.model,    // QA simple checks → nano
  // bekzat/ainura/nurlan → complexity-based
  // forge/atlas/iron/mesa → always standard+
};

// ── Select optimal model tier ─────────────────────────────────────────────────
export function selectModelTier(agentId, title = '', body = '', complexityScore = 50, priority = 'medium') {
  // Agent override
  if (AGENT_MODEL_OVERRIDE[agentId]) {
    return { ...MODEL_TIERS.NANO, model: AGENT_MODEL_OVERRIDE[agentId], reason: `agent-override:${agentId}` };
  }

  // Force premium for critical
  if (priority === 'critical') {
    return { ...MODEL_TIERS.PREMIUM, reason: 'priority:critical' };
  }

  const text = `${title} ${body}`.slice(0, 500);

  // Check nano signals (cheap enough)
  if (NANO_SIGNALS.some(p => p.test(text)) && complexityScore < 35 && priority !== 'high') {
    return { ...MODEL_TIERS.NANO, reason: 'nano-signals' };
  }

  // Check premium signals
  if (PREMIUM_SIGNALS.some(p => p.test(text)) || complexityScore >= 75) {
    return { ...MODEL_TIERS.PREMIUM, reason: 'premium-signals' };
  }

  // Default: standard
  return { ...MODEL_TIERS.STANDARD, reason: 'complexity-based' };
}

// ── Estimate task cost ────────────────────────────────────────────────────────
export function estimateTaskCost(model, estimatedTokens = 2000) {
  const tier = Object.values(MODEL_TIERS).find(t => t.model === model) || MODEL_TIERS.STANDARD;
  return {
    model,
    estimatedTokens,
    estimatedCostUSD: (estimatedTokens / 1000) * tier.costPer1k,
    tier: tier.label,
  };
}

// ── Record cost decision ──────────────────────────────────────────────────────
export function recordCostDecision({ taskId, agentId, title, selectedTier, defaultModel, savedModel }) {
  const record = {
    ts: Date.now(), taskId, agentId,
    title: title?.slice(0, 50),
    selected: selectedTier.model,
    default: defaultModel,
    reason: selectedTier.reason,
    isCheaper: selectedTier.model !== defaultModel && selectedTier.costPer1k < MODEL_TIERS.STANDARD.costPer1k,
  };
  fs.appendFileSync(COST_LOG, JSON.stringify(record) + '\n');
  if (record.isCheaper) {
    console.log(`[CostOptimizer] 💰 ${agentId} → ${selectedTier.label} (${selectedTier.reason}) saved vs standard`);
  }
  return record;
}

// ── Daily cost summary ────────────────────────────────────────────────────────
export function getCostOptimizerStats() {
  try {
    const lines = fs.readFileSync(COST_LOG, 'utf8').trim().split('\n').filter(Boolean);
    const records = lines.map(l => JSON.parse(l));
    const today = Date.now() - 86400000;
    const recent = records.filter(r => r.ts > today);
    const downgraded = recent.filter(r => r.isCheaper).length;
    const byTier = {};
    for (const r of recent) {
      const tier = r.reason?.includes('nano') ? 'nano' : r.selected?.includes('haiku') ? 'nano' : r.selected?.includes('opus') ? 'premium' : 'standard';
      byTier[tier] = (byTier[tier] || 0) + 1;
    }
    return {
      total24h: recent.length,
      downgraded,
      downgradedPct: recent.length ? Math.round((downgraded / recent.length) * 100) : 0,
      byTier,
    };
  } catch { return { total24h: 0, downgraded: 0, downgradedPct: 0, byTier: {} }; }
}

// ── Check if daily budget is within safe limits ───────────────────────────────
export function checkDailyBudget(agentId = '') {
  try {
    const b = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
    const today = new Date().toISOString().split('T')[0];
    const used = b.daily?.[today] || 0;
    const limit = b.dailyLimit || 50;
    const pct = (used / limit) * 100;
    return { ok: pct < 95, used, limit, pct: Math.round(pct) };
  } catch { return { ok: true, used: 0, limit: 50, pct: 0 }; }
}
