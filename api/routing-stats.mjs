/**
 * Routing Stats API — статистика моделей и ошибок
 * GET /api/routing/stats
 */
import { getModelStats } from "./model-router.mjs";
import { getErrorPatternStats } from "./pipeline.mjs";
import { logicianStats } from "./logician.mjs";

export function routingStatsHandler(res) {
  const data = {
    models: getModelStats(),
    errorPatterns: getErrorPatternStats(),
    logician: logicianStats(),
    timestamp: new Date().toISOString(),
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}
