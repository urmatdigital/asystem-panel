/**
 * Keep or Discard — автоматическое сохранение/откат изменений
 * Karpathy autoresearch: если метрика улучшилась → KEEP, иначе → DISCARD
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const METRICS_FILE = `${process.env.HOME}/Projects/ASYSTEM/.metrics.json`;

function loadMetrics() {
  if (!existsSync(METRICS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(METRICS_FILE, "utf8"));
  } catch (e) {
    console.warn("[KeepOrDiscard] Failed to load metrics file:", e.message);
    return {};
  }
}

function saveMetrics(m) {
  writeFileSync(METRICS_FILE, JSON.stringify(m, null, 2));
}

/**
 * Записать метрику после выполнения задачи
 */
export function recordMetric(agentId, metric, value) {
  const metrics = loadMetrics();
  if (!metrics[agentId]) metrics[agentId] = {};
  if (!metrics[agentId][metric]) metrics[agentId][metric] = [];

  metrics[agentId][metric].push({ value, ts: Date.now() });

  // Хранить последние 100 значений
  if (metrics[agentId][metric].length > 100) {
    metrics[agentId][metric] = metrics[agentId][metric].slice(-100);
  }

  saveMetrics(metrics);
  console.log(`[KeepOrDiscard] 📊 Recorded ${agentId}.${metric} = ${value}`);
}

/**
 * Улучшилась ли метрика? (keep or discard)
 * lower_is_better: true для cost/time, false для quality/tasks
 */
export function shouldKeep(agentId, metric, newValue, lowerIsBetter = false) {
  const metrics = loadMetrics();
  const history = metrics[agentId]?.[metric] || [];

  if (history.length < 2) {
    console.log(`[KeepOrDiscard] ✅ KEEP (первое измерение, нет истории)`);
    return true; // нет истории → keep
  }

  const recent = history.slice(-5).map(h => h.value);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;

  const improved = lowerIsBetter ? newValue < avg : newValue > avg;
  const change = ((newValue - avg) / Math.abs(avg) * 100).toFixed(1);

  const action = improved ? "KEEP ✅" : "DISCARD ❌";
  console.log(`[KeepOrDiscard] ${action} metric=${metric} new=${newValue.toFixed(2)} avg=${avg.toFixed(2)} change=${change}%`);

  return improved;
}

/**
 * Git commit если KEEP
 */
export function keepChanges(repoPath, message) {
  try {
    const output = execSync(`cd ${repoPath} && git add -A && git commit -m "${message.replace(/"/g, '\\"')}" --no-verify 2>&1`, { encoding: "utf8" });
    console.log(`[KeepOrDiscard] 📦 KEEP: committed "${message}"`);
    return true;
  } catch (e) {
    const msg = e.message || e.toString();
    if (msg.includes("nothing to commit")) {
      console.log(`[KeepOrDiscard] ℹ️  No changes to commit`);
      return true;
    }
    console.warn(`[KeepOrDiscard] ⚠️  Git commit failed: ${msg.slice(0, 100)}`);
    return false;
  }
}

/**
 * Git revert если DISCARD
 */
export function discardChanges(repoPath) {
  try {
    const output = execSync(`cd ${repoPath} && git checkout -- . 2>&1`, { encoding: "utf8" });
    console.log(`[KeepOrDiscard] 🗑️  DISCARD: changes reverted`);
    return true;
  } catch (e) {
    const msg = e.message || e.toString();
    console.warn(`[KeepOrDiscard] ⚠️  Git revert failed: ${msg.slice(0, 100)}`);
    return false;
  }
}

/**
 * Получить последние метрики агента
 */
export function getAgentMetrics(agentId) {
  const metrics = loadMetrics();
  return metrics[agentId] || {};
}

/**
 * Получить среднее значение метрики за последние N измерений
 */
export function getMetricAverage(agentId, metric, samples = 5) {
  const metrics = loadMetrics();
  const history = metrics[agentId]?.[metric] || [];
  if (history.length === 0) return null;

  const recent = history.slice(-samples).map(h => h.value);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}
