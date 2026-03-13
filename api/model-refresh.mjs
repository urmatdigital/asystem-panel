/**
 * model-refresh.mjs — Автообновление моделей из OpenRouter
 * Запускать cron раз в сутки
 */

const OR_KEY = process.env.OPENROUTER_API_KEY || "process.env.OPENROUTER_API_KEY";
const CACHE_FILE = `${process.env.HOME}/.openclaw/workspace/cache/openrouter-models.json`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export async function fetchModels() {
  // Проверить кеш
  if (existsSync(CACHE_FILE)) {
    const cached = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      console.log(`[ModelRefresh] Using cached models (${cached.models.length} total)`);
      return cached.models;
    }
  }

  console.log("[ModelRefresh] Fetching fresh models from OpenRouter...");
  const resp = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${OR_KEY}` },
  });
  const data = await resp.json();
  const models = (data.data || []).map(m => ({
    id: m.id,
    name: m.name,
    costPer1M: parseFloat(m.pricing?.prompt || 0) * 1_000_000,
    context: m.context_length,
    isFree: (parseFloat(m.pricing?.prompt || 0) === 0),
  })).sort((a, b) => a.costPer1M - b.costPer1M);

  mkdirSync(dirname(CACHE_FILE), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), models }, null, 2));
  console.log(`[ModelRefresh] Cached ${models.length} models`);
  return models;
}

export async function getBestModelForTask(complexity, budgetPct = 0) {
  const models = await fetchModels();

  const filters = {
    critical: m => m.id.includes("claude-sonnet") || m.id.includes("gpt-4o"),
    code:     m => m.id.includes("claude-haiku") || m.id.includes("deepseek"),
    search:   m => m.id.includes("sonar") || m.id.includes("perplexity"),
    complex:  m => m.costPer1M >= 0.5 && m.costPer1M <= 5,
    simple:   m => m.costPer1M <= 0.2 || m.isFree,
  };

  const filter = filters[complexity] || filters.simple;

  // При высоком бюджете — только дешёвые
  const maxCost = budgetPct > 80 ? 0.5 : budgetPct > 95 ? 0.1 : Infinity;

  const match = models.find(m => filter(m) && m.costPer1M <= maxCost && m.context >= 32000);
  return match || models.find(m => m.isFree) || models[0];
}

// CLI режим: node model-refresh.mjs
if (process.argv[1].endsWith("model-refresh.mjs")) {
  const models = await fetchModels();
  console.log("\nТоп-10 моделей по цене:");
  models.slice(0, 10).forEach(m =>
    console.log(`  ${m.costPer1M.toFixed(4)}/1M | ${m.context.toLocaleString()} ctx | ${m.id}`)
  );
}
