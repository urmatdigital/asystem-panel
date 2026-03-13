/**
 * Simulation Engine — самообучаемые параллельные эксперименты
 * Karpathy pattern: run variants → score → keep best → improve
 *
 * Работает на Forge (Mesa как fallback когда вернётся онлайн).
 * Использует OpenRouter дешёвые модели для экспериментов.
 */

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";

const OR_KEY = process.env.OPENROUTER_API_KEY || "process.env.OPENROUTER_API_KEY";
const SIM_DIR = `${process.env.HOME}/.openclaw/workspace/simulations`;
const RESULTS_FILE = `${SIM_DIR}/results.json`;

mkdirSync(SIM_DIR, { recursive: true });

// Загрузить/сохранить историю симуляций
function loadResults() {
  if (!existsSync(RESULTS_FILE)) return { experiments: [], best: {} };
  try { return JSON.parse(readFileSync(RESULTS_FILE, "utf8")); } catch { return { experiments: [], best: {} }; }
}
function saveResults(data) { writeFileSync(RESULTS_FILE, JSON.stringify(data, null, 2)); }

/**
 * Запустить один вариант через OpenRouter (дёшево)
 * @param {string} task - задача/промпт
 * @param {object} variant - { model, systemPrompt, temperature }
 */
async function runVariant(task, variant, variantId) {
  const start = Date.now();
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: variant.model,
        max_tokens: variant.maxTokens || 1000,
        temperature: variant.temperature || 0.7,
        messages: [
          ...(variant.systemPrompt ? [{ role: "system", content: variant.systemPrompt }] : []),
          { role: "user", content: task }
        ],
      }),
    });
    const data = await resp.json();
    const result = data.choices?.[0]?.message?.content || "";
    return {
      variantId,
      model: variant.model,
      result,
      tokens: data.usage?.total_tokens || 0,
      cost: (data.usage?.total_tokens || 0) / 1_000_000 * (variant.costPer1M || 0.2),
      durationMs: Date.now() - start,
      error: null,
    };
  } catch (e) {
    return { variantId, model: variant.model, result: "", tokens: 0, cost: 0, durationMs: Date.now() - start, error: e.message };
  }
}

/**
 * Оценить результат варианта через judge модель
 */
async function scoreVariant(task, result, criteria = "quality, completeness, accuracy") {
  if (!result || result.length < 20) return 0;
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.0-flash-lite-001", // дешёвый judge
        max_tokens: 100,
        messages: [{
          role: "user",
          content: `Score this AI response 1-10 for: ${criteria}\nTASK: ${task.slice(0, 200)}\nRESPONSE: ${result.slice(0, 500)}\nReturn ONLY a number 1-10.`
        }],
      }),
    });
    const data = await resp.json();
    const score = parseInt(data.choices?.[0]?.message?.content?.trim()) || 5;
    return Math.min(10, Math.max(1, score));
  } catch { return 5; }
}

/**
 * Главная функция: запустить N вариантов параллельно, выбрать лучший
 * @param {string} task - задача
 * @param {array} variants - массив вариантов моделей/промптов
 * @param {string} experimentId - ID эксперимента
 */
export async function runExperiment(task, variants, experimentId) {
  console.log(`[SimEngine] 🧪 Experiment: ${experimentId} | ${variants.length} variants | task="${task.slice(0,60)}"`);

  // Запустить все варианты параллельно
  const results = await Promise.all(
    variants.map((v, i) => runVariant(task, v, `v${i+1}`))
  );

  // Оценить каждый результат
  const scored = await Promise.all(
    results.map(async r => ({
      ...r,
      score: r.error ? 0 : await scoreVariant(task, r.result),
    }))
  );

  // Найти победителя
  const winner = scored.reduce((best, r) => r.score > best.score ? r : best, scored[0]);

  // Вычислить метрики
  const totalCost = scored.reduce((s, r) => s + r.cost, 0);
  const avgScore = scored.reduce((s, r) => s + r.score, 0) / scored.length;
  const scorePerDollar = totalCost > 0 ? winner.score / totalCost : winner.score * 1000;

  // Сохранить результаты
  const db = loadResults();
  const experiment = {
    id: experimentId,
    task: task.slice(0, 200),
    ts: new Date().toISOString(),
    variants: scored.map(r => ({ variantId: r.variantId, model: r.model, score: r.score, tokens: r.tokens, cost: r.cost, durationMs: r.durationMs })),
    winner: { variantId: winner.variantId, model: winner.model, score: winner.score },
    metrics: { totalCost: parseFloat(totalCost.toFixed(6)), avgScore: parseFloat(avgScore.toFixed(2)), scorePerDollar: parseFloat(scorePerDollar.toFixed(2)) },
  };
  db.experiments.push(experiment);
  db.experiments = db.experiments.slice(-200); // хранить последние 200

  // Обновить best per model
  if (!db.best[winner.model] || winner.score > db.best[winner.model].score) {
    db.best[winner.model] = { score: winner.score, experimentId, ts: experiment.ts };
  }
  saveResults(db);

  console.log(`[SimEngine] ✅ Winner: ${winner.model} score=${winner.score}/10 | cost=$${totalCost.toFixed(6)}`);
  scored.forEach(r => console.log(`  ${r.variantId}: ${r.model.split("/")[1]?.slice(0,20).padEnd(20)} score=${r.score} tokens=${r.tokens}`));

  return { winner, scored, metrics: experiment.metrics };
}

/**
 * Стандартные варианты моделей для экспериментов
 */
export const VARIANT_SETS = {
  // Для кодинга — 3 модели разной цены
  code: [
    { model: "deepseek/deepseek-chat-v3-0324",       costPer1M: 0.20, maxTokens: 2000, temperature: 0.3 },
    { model: "google/gemini-2.0-flash-lite-001",      costPer1M: 0.075, maxTokens: 2000, temperature: 0.3 },
    { model: "anthropic/claude-haiku-4-5",            costPer1M: 4.8, maxTokens: 2000, temperature: 0.3 },
  ],
  // Для аналитики — фокус на качестве
  analysis: [
    { model: "google/gemini-2.5-flash",               costPer1M: 1.0, maxTokens: 3000, temperature: 0.5 },
    { model: "deepseek/deepseek-chat-v3-0324",        costPer1M: 0.20, maxTokens: 3000, temperature: 0.5 },
    { model: "qwen/qwen3-coder:free",                 costPer1M: 0,   maxTokens: 2000, temperature: 0.5 },
  ],
  // Быстрый A/B тест — только 2 варианта
  ab: [
    { model: "google/gemini-2.0-flash-lite-001",      costPer1M: 0.075, maxTokens: 1000, temperature: 0.7 },
    { model: "deepseek/deepseek-chat-v3-0324",        costPer1M: 0.20,  maxTokens: 1000, temperature: 0.7 },
  ],
};

/**
 * Self-improvement: найти лучшую модель для типа задачи на основе истории
 */
export function getBestModelFromHistory(taskType) {
  const db = loadResults();
  const relevant = db.experiments
    .filter(e => e.id.includes(taskType))
    .slice(-20); // последние 20 экспериментов

  if (relevant.length < 3) return null; // нет достаточно данных

  // Считаем avg score per model
  const modelScores = {};
  for (const exp of relevant) {
    for (const v of exp.variants) {
      if (!modelScores[v.model]) modelScores[v.model] = { total: 0, count: 0 };
      modelScores[v.model].total += v.score;
      modelScores[v.model].count++;
    }
  }

  // Находим лучшую модель по avg score
  let best = null, bestScore = 0;
  for (const [model, stats] of Object.entries(modelScores)) {
    const avg = stats.total / stats.count;
    if (avg > bestScore) { bestScore = avg; best = model; }
  }

  if (best) console.log(`[SimEngine] 📊 Best model for ${taskType}: ${best} (avg score=${bestScore.toFixed(1)})`);
  return best;
}

/**
 * Статистика симуляций
 */
export function getSimStats() {
  const db = loadResults();
  const total = db.experiments.length;
  const recent = db.experiments.slice(-10);
  const avgScore = recent.length > 0
    ? (recent.reduce((s, e) => s + e.metrics.avgScore, 0) / recent.length).toFixed(2)
    : 0;
  const totalCost = recent.reduce((s, e) => s + e.metrics.totalCost, 0).toFixed(4);
  return { total, recentAvgScore: avgScore, recentTotalCost: `$${totalCost}`, best: db.best };
}
