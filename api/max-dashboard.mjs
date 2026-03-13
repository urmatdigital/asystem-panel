/**
 * Claude Max Dashboard — мониторинг использования лимитов
 * GET /api/max/status
 */
import { getAnthropicRateLimitStatus, getModelStats } from "./model-router.mjs";

export function maxStatusHandler(res) {
  const limits = getAnthropicRateLimitStatus();
  const stats = getModelStats();

  // Рекомендация
  let recommendation = "✅ Claude Max: все слоты свободны";
  const sonnet = limits["claude-sonnet-4-6"];
  const haiku  = limits["claude-haiku-4-5"];

  if (haiku?.pct > 80 && sonnet?.pct > 80) {
    recommendation = "⚠️ Оба лимита заняты → переключись на OpenRouter FREE";
  } else if (haiku?.pct > 80) {
    recommendation = "⚡ Haiku занят → используй Sonnet или Qwen3-Coder FREE";
  } else if (sonnet?.pct > 80) {
    recommendation = "⚡ Sonnet занят → используй Haiku (ещё есть слоты)";
  }

  const data = {
    strategy: "Claude Max + OpenRouter Fallback",
    recommendation,
    anthropic: {
      sonnet: { ...sonnet, model: "claude-sonnet-4-6" },
      haiku:  { ...haiku,  model: "claude-haiku-4-5"  },
    },
    openrouter_fallback: [
      { id: "qwen/qwen3-coder:free", cost: "$0/1M", use: "когда Anthropic занят" },
      { id: "google/gemini-2.0-flash-lite-001", cost: "$0.075/1M", use: "качественный fallback" },
      { id: "deepseek/deepseek-chat-v3-0324", cost: "$0.20/1M", use: "код + OR" },
    ],
    modelStats: stats,
    ts: new Date().toISOString(),
  };

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}
