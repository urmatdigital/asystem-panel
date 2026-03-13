/**
 * Model Router v3 — OpenRouter Live Models + Rate Limit Avoidance
 *
 * Иерархия (актуальные цены с OpenRouter 2026-03):
 * FREE   → qwen3-coder:free / llama-3.3-70b:free (0$/1M)
 * NANO   → gemini-2.0-flash-lite ($0.075/1M, 1M ctx)
 * MICRO  → deepseek-chat-v3-0324 ($0.20/1M, 163K ctx)
 * STD    → gemini-2.5-flash ($1.00/1M, 1M ctx) — для аналитики
 * SEARCH → perplexity/sonar ($1/1K req) — веб-поиск
 * CODE   → claude-haiku-4-5 ($4.8/1M direct) — код
 * PRO    → claude-sonnet-4-6 ($18/1M direct) — архитектура
 */

export const MODELS = {
  FREE: {
    id: "qwen/qwen3-coder:free",
    provider: "openrouter",
    costPer1M: 0,
    label: "Qwen3-Coder FREE",
    maxCtx: 262000,
    rateLimit: 20,   // req/min
  },
  NANO: {
    id: "google/gemini-2.0-flash-lite-001",
    provider: "openrouter",
    costPer1M: 0.075,
    label: "Gemini 2.0 Flash Lite",
    maxCtx: 1048576,
    rateLimit: 60,
  },
  MICRO: {
    id: "deepseek/deepseek-chat-v3-0324",
    provider: "openrouter",
    costPer1M: 0.20,
    label: "DeepSeek V3",
    maxCtx: 163840,
    rateLimit: 30,
  },
  STANDARD: {
    id: "google/gemini-2.5-flash",
    provider: "openrouter",
    costPer1M: 1.00,
    label: "Gemini 2.5 Flash",
    maxCtx: 1048576,
    rateLimit: 30,
  },
  SEARCH: {
    id: "perplexity/sonar",
    provider: "openrouter",
    costPer1Kreq: 1.0,
    label: "Perplexity Sonar",
    maxCtx: 4000,
    rateLimit: 10,
  },
  CODE: {
    id: "anthropic/claude-haiku-4-5",
    provider: "anthropic",
    costPer1M: 4.8,
    label: "Claude Haiku 4.5",
    maxCtx: 200000,
    rateLimit: 50,
  },
  PRO: {
    id: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    costPer1M: 18.0,
    label: "Claude Sonnet 4.6",
    maxCtx: 200000,
    rateLimit: 40,
  },
};

// Rate limit tracker (per model)
const _rateBuckets = new Map();

export function checkRateLimit(modelId, windowMs = 60000) {
  const model = Object.values(MODELS).find(m => m.id === modelId);
  const limit = model?.rateLimit || 20;
  const now = Date.now();
  const bucket = (_rateBuckets.get(modelId) || []).filter(t => now - t < windowMs);
  if (bucket.length >= limit) return false;
  bucket.push(now);
  _rateBuckets.set(modelId, bucket);
  return true;
}

// Task classifiers
const SEARCH_KW   = /research|найди|поиск|market|рынок|latest|актуальн|новости|compare|2025|2026/i;
const COMPLEX_KW  = /architect|refactor|design|implement.*multi|pipeline|orchestrat|migration|integration|security/i;
const CODE_KW     = /build|fix|feature|implement|create.*component|написать код|deploy|refactor/i;
const SIMPLE_KW   = /review|check|list|status|summary|log|report|monitor|ping|health|краткий|покажи/i;
const CRITICAL_KW = /critical|urgent|blocker|production|hotfix|сломалось|не работает/i;

export function classifyTask(task) {
  const text = `${task.title} ${task.body || ""} ${task.priority || ""}`;
  if (CRITICAL_KW.test(text) || task.priority === "critical") return "critical";
  if (SEARCH_KW.test(text)) return "search";
  if (CODE_KW.test(text)) return "code";
  if (COMPLEX_KW.test(text)) return "complex";
  if (SIMPLE_KW.test(text)) return "simple";
  if ((task.body || "").length > 600) return "complex";
  return "simple";
}

/**
 * Главная функция выбора модели с учётом rate limits
 */
export function selectModel(task, budget = {}) {
  const { percent_used = 0, pause_tasks = false } = budget;
  const complexity = classifyTask(task);

  // Построить приоритизированный список кандидатов
  let candidates = [];

  if (pause_tasks || percent_used >= 100) {
    candidates = [MODELS.FREE, MODELS.NANO];
  } else if (complexity === "critical") {
    candidates = [MODELS.PRO, MODELS.CODE];
  } else if (complexity === "search") {
    candidates = [MODELS.SEARCH, MODELS.STANDARD];
  } else if (complexity === "code" && percent_used < 80) {
    candidates = [MODELS.CODE, MODELS.MICRO, MODELS.NANO];
  } else if (complexity === "complex" && percent_used < 80) {
    candidates = [MODELS.CODE, MODELS.STANDARD, MODELS.MICRO];
  } else if (percent_used >= 80) {
    candidates = [MODELS.NANO, MODELS.FREE, MODELS.MICRO];
  } else {
    candidates = [MODELS.NANO, MODELS.FREE];
  }

  // Выбрать первую модель без rate limit
  for (const candidate of candidates) {
    if (checkRateLimit(candidate.id)) {
      return {
        ...candidate,
        runtime: candidate.provider === "anthropic" ? "claude" : "openrouter",
        complexity,
        reason: `${complexity}_budget${Math.round(percent_used)}pct`,
      };
    }
    console.warn(`[ModelRouter] ⚡ Rate limit hit: ${candidate.label}, trying next...`);
  }

  // Fallback: FREE модель всегда
  return { ...MODELS.FREE, runtime: "openrouter", complexity, reason: "rate_limit_fallback" };
}

export function selectModelAdaptive(task, budget = {}) {
  const choice = selectModel(task, budget);
  const successRate = getModelSuccessRate(choice.id);
  if (successRate < 0.7 && choice.id !== MODELS.PRO.id) {
    const hierarchy = [MODELS.FREE, MODELS.NANO, MODELS.MICRO, MODELS.STANDARD, MODELS.CODE, MODELS.PRO];
    const idx = hierarchy.findIndex(m => m.id === choice.id);
    const next = hierarchy[Math.min(idx + 1, hierarchy.length - 1)];
    if (checkRateLimit(next.id)) {
      return { ...next, runtime: next.provider === "anthropic" ? "claude" : "openrouter", reason: `escalated_low_sr_${Math.round(successRate*100)}pct`, complexity: choice.complexity };
    }
  }
  return choice;
}

// Feedback loop
const _modelStats = new Map();
export function recordModelOutcome(modelId, outcome, durationMs = 0) {
  const s = _modelStats.get(modelId) || { success: 0, fail: 0, totalMs: 0, count: 0 };
  outcome === "done" ? s.success++ : s.fail++;
  s.totalMs += durationMs; s.count++;
  _modelStats.set(modelId, s);
}
export function getModelSuccessRate(modelId) {
  const s = _modelStats.get(modelId);
  return (!s || s.count === 0) ? 1.0 : s.success / s.count;
}
export function getModelStats() {
  const r = {};
  for (const [id, s] of _modelStats) {
    r[id] = { ...s, successRate: s.count > 0 ? (s.success/s.count*100).toFixed(1)+"%" : "n/a", avgMs: s.count > 0 ? Math.round(s.totalMs/s.count) : 0 };
  }
  return r;
}
export function logModelChoice(task, choice, traceId = "") {
  const prefix = traceId ? `[TRACE:${traceId}]` : "[ModelRouter]";
  const cost = choice.costPer1M != null ? `$${choice.costPer1M}/1M` : `$${choice.costPer1Kreq}/1Kreq`;
  console.log(`${prefix} ✨ ${choice.label} | complexity=${choice.complexity} | cost=${cost} | reason=${choice.reason}`);
}
export function estimateSavings(choice, tokens = 1000) {
  const base = (tokens/1e6)*18;
  const actual = choice.costPer1M != null ? (tokens/1e6)*choice.costPer1M : choice.costPer1Kreq/1000;
  return { savedPercent: ((base-actual)/base*100).toFixed(0), actualCost: actual.toFixed(6) };
}

// ── Claude Max Strategy ───────────────────────────────────────────────────
// Max тариф: Anthropic токены уже оплачены → приоритет Anthropic
// OpenRouter = только fallback при rate limit

/**
 * Rate limit state для Claude Max
 * Отслеживаем rolling window 5 часов
 */
const _maxRateLimits = {
  "claude-sonnet-4-6": { limit: 45, windowMs: 5 * 60 * 60_000, calls: [] },
  "claude-haiku-4-5":  { limit: 100, windowMs: 5 * 60 * 60_000, calls: [] },
};

export function checkAnthropicRateLimit(modelId) {
  const tracker = _maxRateLimits[modelId];
  if (!tracker) return true; // не отслеживаем — разрешаем
  const now = Date.now();
  tracker.calls = tracker.calls.filter(t => now - t < tracker.windowMs);
  if (tracker.calls.length >= tracker.limit) {
    const resetIn = Math.round((tracker.calls[0] + tracker.windowMs - now) / 60_000);
    console.warn(`[MaxStrategy] ⚠️ ${modelId} rate limited. Reset in ~${resetIn}min`);
    return false;
  }
  tracker.calls.push(now);
  return true;
}

export function getAnthropicRateLimitStatus() {
  const status = {};
  const now = Date.now();
  for (const [model, tracker] of Object.entries(_maxRateLimits)) {
    const active = tracker.calls.filter(t => now - t < tracker.windowMs);
    const resetIn = active.length > 0
      ? Math.round((active[0] + tracker.windowMs - now) / 60_000)
      : 0;
    status[model] = {
      used: active.length,
      limit: tracker.limit,
      remaining: tracker.limit - active.length,
      resetInMin: resetIn,
      pct: Math.round(active.length / tracker.limit * 100),
    };
  }
  return status;
}

/**
 * Главная функция для Claude Max пользователей
 * Приоритет: Anthropic Max → OpenRouter Free → OpenRouter Paid
 */
export function selectModelMax(task, budget = {}) {
  const { percent_used = 0 } = budget;
  const complexity = classifyTask(task);

  // ── Tier 1: Anthropic Max (уже оплачен, используем по максимуму) ──
  if (complexity === "critical") {
    if (checkAnthropicRateLimit("claude-sonnet-4-6")) {
      return { ...MODELS.PRO, runtime: "claude", reason: "max_critical", complexity };
    }
  }

  // Для кода и сложных задач — сначала Haiku (меньше лимитов тратим)
  if (complexity === "code" || complexity === "complex") {
    if (checkAnthropicRateLimit("claude-haiku-4-5")) {
      return { ...MODELS.CODE, runtime: "claude", reason: "max_code", complexity };
    }
    // Haiku rate limited → попробовать Sonnet
    if (checkAnthropicRateLimit("claude-sonnet-4-6")) {
      return { ...MODELS.PRO, runtime: "claude", reason: "max_sonnet_fallback", complexity };
    }
  }

  // Простые задачи — сначала Haiku
  if (complexity === "simple") {
    if (checkAnthropicRateLimit("claude-haiku-4-5")) {
      return { ...MODELS.CODE, runtime: "claude", reason: "max_simple", complexity };
    }
  }

  // Поиск — Perplexity независимо от лимитов
  if (complexity === "search") {
    return { ...MODELS.SEARCH, runtime: "openrouter", reason: "search_task", complexity };
  }

  // ── Tier 2: OpenRouter FREE (когда Anthropic rate-limited) ──
  const freeModel = {
    id: "qwen/qwen3-coder:free",
    provider: "openrouter",
    costPer1M: 0,
    label: "Qwen3-Coder FREE",
    maxCtx: 262000,
  };
  if (complexity === "code" || complexity === "complex") {
    if (checkRateLimit(freeModel.id)) {
      console.log("[MaxStrategy] 🔄 Anthropic rate limited → Qwen3-Coder FREE");
      return { ...freeModel, runtime: "openrouter", reason: "or_free_fallback", complexity };
    }
  }

  // ── Tier 3: OpenRouter PAID (крайний случай) ──
  console.log("[MaxStrategy] 💰 Using OpenRouter paid (all Anthropic slots used)");
  if (complexity === "code") {
    return { ...MODELS.MICRO, runtime: "openrouter", reason: "or_paid_fallback", complexity };
  }
  return { ...MODELS.NANO, runtime: "openrouter", reason: "or_nano_fallback", complexity };
}

// ── Reasoning Budget (Nemotron паттерн) ───────────────────────────────────
export const TOKEN_BUDGET = {
  simple:   500,
  code:     4000,
  complex:  6000,
  critical: 8000,
  search:   2000,
};

export function getTokenBudget(task, override = null) {
  if (override) return override;
  const complexity = classifyTask(task);
  const budget = TOKEN_BUDGET[complexity] || 4000;
  console.log(`[TokenBudget] complexity=${complexity} → max_tokens=${budget}`);
  return budget;
}

// ── Thinking Mode (GPT-5.4 паттерн: thinking для complex/critical) ────────
export function getThinkingMode(task) {
  const complexity = classifyTask(task);
  if (complexity === "critical") return { enabled: true, budget: 8000 };
  if (complexity === "complex")  return { enabled: true, budget: 4000 };
  return { enabled: false, budget: 0 };
}

// ── Simulation-Aware Routing ──────────────────────────────────────────────
import { getBestModelFromHistory } from "./sim-engine.mjs";

/**
 * Выбор модели с учётом истории симуляций
 * Если у нас есть данные что модель X лучше для этого типа → используем X
 */
export async function selectModelWithHistory(task, budget = {}) {
  const complexity = classifyTask(task);

  // Попробовать найти лучшую модель из истории симуляций
  const bestFromSim = getBestModelFromHistory(complexity);

  if (bestFromSim) {
    // Найти объект модели
    const modelObj = Object.values(MODELS).find(m => m.id === bestFromSim);
    if (modelObj && checkRateLimit(modelObj.id)) {
      console.log(`[ModelRouter] 🎯 Sim-informed: ${modelObj.label} (best for ${complexity})`);
      return { ...modelObj, runtime: modelObj.provider === "anthropic" ? "claude" : "openrouter", reason: "sim_history_best", complexity };
    }
  }

  // Fallback на стандартный выбор
  return selectModelMax(task, budget);
}
