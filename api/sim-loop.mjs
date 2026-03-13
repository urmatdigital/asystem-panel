/**
 * Simulation Loop — автономный цикл самообучения через симуляции
 *
 * Каждые 4 часа (cron):
 * 1. Берёт реальные задачи из истории
 * 2. Запускает параллельные варианты через sim-engine
 * 3. Обновляет model-router на основе результатов
 * 4. Постит отчёт в Squad Chat
 */

import { runExperiment, VARIANT_SETS, getBestModelFromHistory, getSimStats } from "./sim-engine.mjs";

const SQUAD_CHAT = "https://expert-dachshund-299.convex.cloud/api/mutation";
const API_BASE = "http://127.0.0.1:5190";

// Тестовые задачи для экспериментов (реальные типы из нашей системы)
const BENCHMARK_TASKS = [
  { id: "code-simple", type: "code", prompt: "Write a JavaScript function to validate email address. Return only the function, no explanation." },
  { id: "code-complex", type: "code", prompt: "Design a rate limiter class in JavaScript that supports sliding window algorithm with Redis-like interface." },
  { id: "analysis-task", type: "analysis", prompt: "Analyze the trade-offs between microservices and monolith architecture for a startup with 5 developers. Give 3 key points." },
  { id: "ops-task", type: "ab", prompt: "Write a bash script to check if a service is running and restart it if down. 10 lines max." },
];

async function postReport(msg) {
  try {
    await fetch(SQUAD_CHAT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "chat:send", args: { agent: "Forge", message: msg, tags: ["simulation", "learning"] } }),
    });
  } catch {}
}

async function runSimLoop() {
  console.log("[SimLoop] 🚀 Starting simulation cycle...");
  const stats = { experiments: 0, improvements: 0 };

  for (const benchmark of BENCHMARK_TASKS) {
    const variants = VARIANT_SETS[benchmark.type] || VARIANT_SETS.ab;
    const result = await runExperiment(benchmark.prompt, variants, `${benchmark.id}-${Date.now()}`);
    stats.experiments++;

    // Найти лучшую модель из истории для этого типа
    const bestFromHistory = getBestModelFromHistory(benchmark.id);
    if (bestFromHistory && bestFromHistory !== result.winner.model) {
      console.log(`[SimLoop] 📈 New best model for ${benchmark.id}: ${result.winner.model} (was ${bestFromHistory})`);
      stats.improvements++;
    }

    // Небольшая пауза между экспериментами
    await new Promise(r => setTimeout(r, 2000));
  }

  const simStats = getSimStats();
  const report = `🧪 [SIM-LOOP] Цикл симуляций завершён\n` +
    `Экспериментов: ${stats.experiments}\n` +
    `Улучшений: ${stats.improvements}\n` +
    `Всего экспериментов в БД: ${simStats.total}\n` +
    `Avg score (последние 10): ${simStats.recentAvgScore}/10\n` +
    `Потрачено (последние 10): ${simStats.recentTotalCost}`;

  await postReport(report);
  console.log("[SimLoop] ✅ Done:", report);
}

// CLI mode
const isMain = process.argv[1]?.endsWith("sim-loop.mjs");
if (isMain) runSimLoop().catch(e => console.error("[SimLoop] ERROR:", e.message));

export { runSimLoop };
