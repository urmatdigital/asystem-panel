/**
 * Pipeline Middleware — 7-stage processing for agent tasks
 *
 * Stages:
 *   1. Trace      — распределённый трейсинг (SHA256 traceId)
 *   2. RateLimit  — ограничение по приоритету
 *   3. Security   — защита от SQL injection, XSS
 *   4. Context    — handoff состояния в shared memory
 *   5. Priority   — динамический скоринг (дедлайны, staleness)
 */

import { createHash } from 'node:crypto';

// ── 1. TRACE: Start & Close ──────────────────────────────────────────────────
/**
 * Инициирует трейс задачи
 * @param {Object} task — объект задачи
 * @returns {Object} meta — { traceId, taskId, title, agent, startedAt, modelId }
 */
export function startTrace(task) {
  const traceId = createHash('sha256')
    .update(task._id + Date.now())
    .digest('hex')
    .slice(0, 12);

  const meta = {
    traceId,
    taskId: task._id,
    title: task.title,
    agent: task.agent || 'forge',
    startedAt: Date.now(),
    modelId: "",
  };

  console.log(`[TRACE:${traceId}] START task="${task.title}" agent=${meta.agent}`);
  return meta;
}

/**
 * Завершает трейс, логирует в Convex audit log
 * @param {Object} meta — метаданные из startTrace
 * @param {string} outcome — 'done' | 'fail' | 'retry' | 'blocked' | 'escalated'
 * @param {string} result — результат для аудита (опционально)
 */
export async function closeTrace(meta, outcome, result = '') {
  const durationMs = Date.now() - meta.startedAt;
  console.log(`[TRACE:${meta.traceId}] END outcome=${outcome} duration=${durationMs}ms`);

  // Отправить в Convex audit log
  try {
    await fetch('https://expert-dachshund-299.convex.cloud/api/mutation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'audit:log',
        args: {
          traceId: meta.traceId,
          taskId: meta.taskId,
          title: meta.title,
          agent: meta.agent,
          outcome,
          durationMs,
          result: String(result).slice(0, 500),
        },
      }),
    });
  } catch {
    // Ошибка аудита не блокирует выполнение
  }
}

// ── 2. RATE LIMITER ──────────────────────────────────────────────────────────
/**
 * Хранилище rate limit bucket'ов (в памяти)
 * Формат: agentId:PRIORITY -> [timestamps]
 */
const _rateBuckets = new Map();
const RATE_LIMITS = {
  HIGH: 20,   // 20 запросов в минуту
  MEDIUM: 10, // 10 запросов в минуту
  LOW: 5,     // 5 запросов в минуту
};

/**
 * Проверка лимита для агента
 * @param {string} agentId — ID агента
 * @param {string} priority — 'HIGH' | 'MEDIUM' | 'LOW'
 * @returns {boolean} true если в рамках лимита, false если превышен
 */
export function checkRateLimit(agentId, priority = 'MEDIUM') {
  const now = Date.now();
  const key = `${agentId}:${priority}`;
  const limit = RATE_LIMITS[priority] || 10;

  // Оставить только события из последней минуты
  const bucket = (_rateBuckets.get(key) || []).filter(t => now - t < 60_000);

  if (bucket.length >= limit) {
    console.warn(
      `[RateLimit] ${agentId} exceeded ${limit} req/min for ${priority}`
    );
    return false;
  }

  bucket.push(now);
  _rateBuckets.set(key, bucket);
  return true;
}

// ── 3. CONTEXT HANDOFF ───────────────────────────────────────────────────────
/**
 * Отправляет контекст задачи в shared memory перед выполнением
 * @param {Object} task — объект задачи
 * @param {Object} traceMeta — метаданные из startTrace
 */
export async function contextHandoff(task, traceMeta) {
  try {
    await fetch('http://127.0.0.1:5190/api/memory/shared', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `Task [${traceMeta.traceId}]: ${task.title}\n${task.body || ''}`,
        agent: traceMeta.agent,
        tags: ['task-handoff', task.priority || 'medium'],
      }),
    });
  } catch {
    // Ошибка handoff не блокирует выполнение
  }
}

// ── 4. SECURITY GATE ─────────────────────────────────────────────────────────
/**
 * Паттерны SQL injection
 */
const SQL_PATTERNS = [
  /(\bSELECT\b|\bDROP\b|\bINSERT\b|\bDELETE\b)\s/i,
  /--\s*$/,
  /\/\*/,
];

/**
 * Паттерны XSS
 */
const XSS_PATTERNS = [
  /<script/i,
  /javascript:/i,
  /on\w+=/i,
];

/**
 * Проверка задачи на основные угрозы безопасности
 * @param {Object} task — объект задачи
 * @returns {boolean} true если задача безопасна, false если обнаружена угроза
 */
export function securityGate(task) {
  const text = `${task.title || ''} ${task.body || ''}`;

  // Проверка на control characters
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
    console.warn(`[Security] Control chars in task ${task._id}`);
    return false;
  }

  // Проверка на SQL injection паттерны
  for (const pattern of SQL_PATTERNS) {
    if (pattern.test(text)) {
      console.warn(`[Security] SQL injection pattern in task ${task._id}`);
      return false;
    }
  }

  // Проверка на XSS паттерны
  for (const pattern of XSS_PATTERNS) {
    if (pattern.test(text)) {
      console.warn(`[Security] XSS pattern in task ${task._id}`);
      return false;
    }
  }

  return true;
}

// ── 5. PRIORITY SCORER ───────────────────────────────────────────────────────
/**
 * Базовые оценки приоритета
 */
const PRIORITY_SCORES = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
};

/**
 * Динамический скоринг приоритета с учётом дедлайна и staleness
 * @param {Object} task — объект задачи
 * @returns {number} итоговая оценка (0-150+)
 */
export function scoreTask(task) {
  let score = PRIORITY_SCORES[task.priority] || 50;
  const now = Date.now();

  // Бонус за просроченность (дедлайн)
  if (task.deadline) {
    const overdueMin = (now - new Date(task.deadline).getTime()) / 60_000;
    if (overdueMin > 0) {
      score += Math.min(overdueMin, 50);
    }
  }

  // Бонус за задачи, стоящие на месте (stalling)
  if (task.updatedAt) {
    const stalledMin = (now - new Date(task.updatedAt).getTime()) / 60_000;
    if (stalledMin > 30) {
      score += 25;
    }
  }

  return Math.round(score);
}

// ── MODEL SELECTION ──────────────────────────────────────────────────────
import { selectModel, classifyTask, logModelChoice } from "./model-router.mjs";
export { selectModel, classifyTask, logModelChoice };

// ── Self-Healing Pattern (из видео: Agentic Self-Healing Pipeline) ──────────
// Проактивное восстановление вместо реактивного firefighting

const _errorPatterns = new Map(); // pattern → { count, lastSeen, fix }

// Кеш исправлений (Self-Healing видео: 41s → 7s после кеширования)
const _fixCache = new Map(); // errorHash → { fix, pattern, usedCount, cachedAt }

function _hashError(errorMsg) {
  // Нормализуем ошибку для стабильного хеша
  return String(errorMsg)
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, "X") // убираем IDs/хеши
    .replace(/\d+/g, "N")           // убираем числа
    .slice(0, 100);
}

const KNOWN_FIXES = {
  "timeout":        "Retry with smaller chunk or simpler prompt",
  "rate.?limit":    "Switch to cheaper model + add 30s delay",
  "context.?length": "Truncate task body to 500 chars",
  "syntax.?error":  "Add explicit code format instructions to prompt",
  "not found":      "Verify file paths before execution",
};

/**
 * Анализировать ошибку и предложить fix
 */
export function analyzeError(errorMsg, task) {
  const cacheKey = _hashError(errorMsg);

  // Проверить кеш
  const cached = _fixCache.get(cacheKey);
  if (cached) {
    cached.usedCount++;
    console.log(`[SelfHeal] ⚡ Cache hit: pattern="${cached.pattern}" (used ${cached.usedCount}x)`);
    return { ...cached, fromCache: true };
  }

  const msg = String(errorMsg).toLowerCase();

  // Поиск известного паттерна
  for (const [pattern, fix] of Object.entries(KNOWN_FIXES)) {
    if (new RegExp(pattern, "i").test(msg)) {
      // Записать паттерн
      const key = pattern;
      const entry = _errorPatterns.get(key) || { count: 0, lastSeen: null, fix };
      entry.count++;
      entry.lastSeen = new Date().toISOString();
      _errorPatterns.set(key, entry);

      // Сохранить в кеш
      const result = { pattern, fix, isKnown: true };
      _fixCache.set(cacheKey, { ...result, usedCount: 1, cachedAt: new Date().toISOString() });

      console.log(`[SelfHeal] 🔧 Pattern="${pattern}" → Fix: ${fix} (cached)`);
      return result;
    }
  }

  const unknown = { pattern: "unknown", fix: "Retry with default settings", isKnown: false };
  _fixCache.set(cacheKey, { ...unknown, usedCount: 1, cachedAt: new Date().toISOString() });
  return unknown;
}

/**
 * Применить авто-фикс к задаче перед retry
 */
export function applyHeal(task, errorMsg) {
  const { pattern, fix } = analyzeError(errorMsg, task);
  const healed = { ...task };

  if (/context.?length/i.test(pattern)) {
    healed.body = (task.body || "").slice(0, 500) + "\n[truncated for context]";
    console.log(`[SelfHeal] Truncated task body: ${task.body?.length || 0} → 500 chars`);
  }

  if (/timeout/i.test(pattern)) {
    healed._healHint = "Use shorter timeout, split if possible";
  }

  healed._selfHealApplied = true;
  healed._healFix = fix;

  return healed;
}

/**
 * Статистика ошибок
 */
export function getErrorPatternStats() {
  return Object.fromEntries(_errorPatterns);
}

/**
 * Статистика кеша фиксов
 */
export function getFixCacheStats() {
  const entries = Array.from(_fixCache.entries()).map(([k, v]) => ({ key: k.slice(0, 40), ...v }));
  return { size: _fixCache.size, entries: entries.slice(0, 10) };
}

// ── Failure Memory (Карпаты pattern: каждый провал = урок для роя) ──────────

/**
 * Записать провал в shared memory для обучения других агентов
 * LangGraph: только финальный результат, не внутренние шаги
 */
export async function recordFailureToMemory(task, errorMsg, traceMeta = {}) {
  const pattern = analyzeError(errorMsg, task);

  // LangGraph: только финальный результат, не внутренние шаги
  const content = JSON.stringify({
    type: "failure-pattern",
    title: task.title?.slice(0, 100),
    agent: traceMeta.agent || task.agent || "unknown",
    pattern: pattern.pattern,
    fix: pattern.fix,
    traceId: traceMeta.traceId || null,
    ts: new Date().toISOString(),
  });

  try {
    await fetch("http://127.0.0.1:5190/api/memory/shared", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        agent: traceMeta.agent || "forge",
        tags: ["failure-pattern", pattern.pattern],
      }),
    });
    console.log(`[FailureMemory] 📝 Saved (structured JSON, pattern=${pattern.pattern})`);
  } catch {}
}

/**
 * Достать похожие failure-паттерны перед выполнением задачи
 * Возвращает строку с предупреждениями для промпта
 */
export async function getFailureWarnings(task) {
  try {
    const q = encodeURIComponent(task.title.slice(0, 80));
    const resp = await fetch(`http://127.0.0.1:5190/api/memory/shared?q=${q}+failure+error&top=3`);
    if (!resp.ok) return "";
    const data = await resp.json();
    const items = (data.results || data.items || [])
      .filter(r => String(r.content || "").includes("FAILURE-PATTERN"))
      .slice(0, 2);
    if (items.length === 0) return "";
    const warnings = items.map(r => r.content || "").join("\n");
    console.log(`[FailureMemory] ⚠️ Found ${items.length} similar failure(s) for this task`);
    return `\n\n⚠️ KNOWN FAILURE PATTERNS (avoid these):\n${warnings}`;
  } catch {
    return "";
  }
}
