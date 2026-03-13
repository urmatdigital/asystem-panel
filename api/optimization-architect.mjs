/**
 * ⚡ Autonomous Optimization Architect — ASYSTEM
 * Inspired by agency-agents/engineering-autonomous-optimization-architect.md
 *
 * Features:
 *   1. Complexity Scoring   — score 0-100 based on task content
 *   2. Intelligent Routing  — haiku / sonnet / opus by score
 *   3. Circuit Breaker      — auto-fallback on model failures
 *   4. Cost Telemetry       — log estimated cost per dispatch
 *   5. Shadow Testing       — 5% traffic routed to shadow model (non-blocking)
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. MODEL REGISTRY — cost per 1M tokens (input/output averaged)
// ─────────────────────────────────────────────────────────────────────────────
export const MODELS = {
  'claude-haiku-4-5':  { costPer1M: 0.80,  tier: 'fast',     maxScore: 35  },
  'claude-sonnet-4-6': { costPer1M: 3.00,  tier: 'standard', maxScore: 75  },
  'claude-opus-4':     { costPer1M: 15.00, tier: 'power',    maxScore: 100 },
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. COMPLEXITY SCORER
//    Returns 0–100. Higher = needs smarter model.
// ─────────────────────────────────────────────────────────────────────────────

const COMPLEX_SIGNALS = [
  // Architecture & design
  { re: /architect|design.*system|system.*design|refactor.*entire|migrate/i, pts: 20 },
  // Multi-step reasoning
  { re: /analyz|compare|evaluate|research|investigat|strateg/i, pts: 15 },
  // Production-critical
  { re: /deploy.*prod|production|incident|outage|critical.*bug/i, pts: 20 },
  // Security / sensitive
  { re: /security|vuln|pentest|auth.*flow|oauth|firewall/i, pts: 15 },
  // Code generation (complex)
  { re: /implement.*from scratch|build.*new|create.*module|write.*service/i, pts: 10 },
  // Long body
];

const SIMPLE_SIGNALS = [
  { re: /^(list|show|get|check|ping|status|what is|who is|tell me)/i, pts: -20 },
  { re: /health.*check|uptime|version|hello|test/i, pts: -15 },
  { re: /summariz|brief|quick|short/i, pts: -10 },
];

/**
 * Score task complexity 0-100
 */
export function scoreComplexity({ title = '', body = '', priority = 'medium' }) {
  let score = 30; // baseline

  const content = `${title} ${body}`;

  // Complex signals → up
  for (const { re, pts } of COMPLEX_SIGNALS) {
    if (re.test(content)) score += pts;
  }

  // Simple signals → down
  for (const { re, pts } of SIMPLE_SIGNALS) {
    if (re.test(content)) score += pts; // pts are negative
  }

  // Body length bonus (long tasks = more complex)
  const words = content.split(/\s+/).length;
  if (words > 200) score += 15;
  else if (words > 80) score += 8;
  else if (words < 15) score -= 10;

  // Priority boost
  if (priority === 'critical') score += 25;
  else if (priority === 'high') score += 10;
  else if (priority === 'low') score -= 10;

  return Math.max(0, Math.min(100, score));
}

/**
 * Select optimal model for complexity score
 */
export function selectModel(score, circuitBreakers = {}) {
  let model, reason;

  if (score <= 35) {
    model = 'claude-haiku-4-5';
    reason = `low complexity (score=${score}) → fast/cheap`;
  } else if (score <= 75) {
    model = 'claude-sonnet-4-6';
    reason = `standard complexity (score=${score})`;
  } else {
    model = 'claude-sonnet-4-6'; // use sonnet not opus (cost control)
    reason = `high complexity (score=${score}) → sonnet with extended thinking`;
  }

  // Circuit breaker: if primary is tripped, fallback
  if (circuitBreakers[model]?.tripped) {
    const fallback = model === 'claude-haiku-4-5' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5';
    reason = `CB tripped for ${model} → fallback to ${fallback}`;
    model = fallback;
  }

  const meta = MODELS[model] || MODELS['claude-sonnet-4-6'];
  return { model, reason, costPer1M: meta.costPer1M, tier: meta.tier };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. CIRCUIT BREAKER
//    Trips after N failures in TTL window. Auto-recovers after cooldown.
// ─────────────────────────────────────────────────────────────────────────────

const CB_FAILURE_THRESHOLD = 3;
const CB_WINDOW_MS         = 5 * 60_000;  // 5 min observation
const CB_COOLDOWN_MS       = 10 * 60_000; // 10 min recovery

const _circuitBreakers = {}; // model → { failures, firstFailure, tripped, trippedAt }

export function recordModelResult(model, success) {
  const now = Date.now();
  let cb = _circuitBreakers[model] ?? { failures: 0, firstFailure: now, tripped: false, trippedAt: null };

  // Auto-recover from trip
  if (cb.tripped && now - cb.trippedAt > CB_COOLDOWN_MS) {
    cb = { failures: 0, firstFailure: now, tripped: false, trippedAt: null };
    console.log(`[OptArch] ✅ Circuit breaker RECOVERED for ${model}`);
  }

  if (success) {
    cb.failures = Math.max(0, cb.failures - 1); // partial recovery on success
  } else {
    // Reset window if stale
    if (now - cb.firstFailure > CB_WINDOW_MS) {
      cb.failures = 0; cb.firstFailure = now;
    }
    cb.failures++;
    if (cb.failures >= CB_FAILURE_THRESHOLD && !cb.tripped) {
      cb.tripped = true;
      cb.trippedAt = now;
      console.warn(`[OptArch] 🔴 Circuit breaker TRIPPED for ${model} (${cb.failures} failures)`);
    }
  }

  _circuitBreakers[model] = cb;
}

export function getCircuitBreakers() {
  return { ..._circuitBreakers };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. COST TELEMETRY
//    Estimate cost per dispatch and accumulate stats
// ─────────────────────────────────────────────────────────────────────────────

const _costStats = {
  totalDispatches: 0,
  totalEstimatedCost: 0,
  byModel: {},
  byTier: { fast: 0, standard: 0, power: 0 },
  savedVsAlwaysSonnet: 0,
};

const AVG_TOKENS_PER_TASK = 2000; // rough estimate

export function recordDispatchCost(model, taskId = '') {
  const meta = MODELS[model] || MODELS['claude-sonnet-4-6'];
  const estimatedCost = (AVG_TOKENS_PER_TASK / 1_000_000) * meta.costPer1M;
  const sonnetCost    = (AVG_TOKENS_PER_TASK / 1_000_000) * MODELS['claude-sonnet-4-6'].costPer1M;

  _costStats.totalDispatches++;
  _costStats.totalEstimatedCost += estimatedCost;
  _costStats.byModel[model] = (_costStats.byModel[model] ?? 0) + estimatedCost;
  _costStats.byTier[meta.tier] = (_costStats.byTier[meta.tier] ?? 0) + 1;
  _costStats.savedVsAlwaysSonnet += (sonnetCost - estimatedCost);

  return { estimatedCost: +estimatedCost.toFixed(6), savedVsSonnet: +(sonnetCost - estimatedCost).toFixed(6) };
}

export function getCostStats() {
  return {
    ..._costStats,
    totalEstimatedCost: +_costStats.totalEstimatedCost.toFixed(4),
    savedVsAlwaysSonnet: +_costStats.savedVsAlwaysSonnet.toFixed(4),
    avgCostPerDispatch: _costStats.totalDispatches
      ? +(_costStats.totalEstimatedCost / _costStats.totalDispatches).toFixed(6)
      : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. SHADOW TESTING (non-blocking, 5% traffic)
//    Compares shadow model output to primary — logs score diff
// ─────────────────────────────────────────────────────────────────────────────

const SHADOW_RATE = 0.05; // 5% of tasks
const SHADOW_MODEL = 'claude-haiku-4-5';

const _shadowStats = { tested: 0, wins: 0, losses: 0, ties: 0 };

/**
 * Decide if this dispatch should be shadow-tested
 * Returns true if shadow test should run (non-blocking)
 */
export function shouldShadowTest(primaryModel) {
  if (primaryModel === SHADOW_MODEL) return false; // no point testing same model
  return Math.random() < SHADOW_RATE;
}

export function recordShadowResult(primaryScore, shadowScore) {
  _shadowStats.tested++;
  if (shadowScore >= primaryScore * 0.95) _shadowStats.wins++;      // shadow ≥ 95% quality
  else if (shadowScore >= primaryScore * 0.80) _shadowStats.ties++; // shadow ≥ 80%
  else _shadowStats.losses++;

  // Auto-promote haiku if win rate > 80% over 20+ tests
  const { wins, tested } = _shadowStats;
  if (tested >= 20 && wins / tested > 0.80) {
    console.log(`[OptArch] 🎉 Shadow model ${SHADOW_MODEL} win rate ${(wins/tested*100).toFixed(0)}% — consider routing more traffic`);
  }
}

export function getShadowStats() {
  return {
    ..._shadowStats,
    winRate: _shadowStats.tested ? +(_shadowStats.wins / _shadowStats.tested).toFixed(3) : 0,
    shadowModel: SHADOW_MODEL,
    shadowRate: SHADOW_RATE,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. MAIN: analyze task and return routing decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full optimization decision for a dispatch
 * @returns {{ model, reason, score, estimatedCost, savedVsSonnet, shadow }}
 */
export function optimizeDispatch({ title, body, priority, agentId }) {
  const score    = scoreComplexity({ title, body, priority });
  const routing  = selectModel(score, getCircuitBreakers());
  const costs    = recordDispatchCost(routing.model, agentId);
  const shadow   = shouldShadowTest(routing.model);

  return {
    model:          routing.model,
    reason:         routing.reason,
    tier:           routing.tier,
    score,
    estimatedCost:  costs.estimatedCost,
    savedVsSonnet:  costs.savedVsSonnet,
    shadow,
    shadowModel:    shadow ? SHADOW_MODEL : null,
  };
}
