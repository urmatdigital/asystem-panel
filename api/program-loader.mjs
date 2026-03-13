/**
 * Program Loader — читает program.md агентов перед выполнением задачи
 * Karpathy autoresearch паттерн: "программировать программу через MD файлы"
 */

import { readFileSync, existsSync } from "node:fs";

const AGENTS_DIR = `${process.env.HOME}/Projects/ASYSTEM/agents`;

// Кеш program.md (обновляется каждые 10 мин)
const _programCache = new Map();
const CACHE_TTL = 10 * 60_000;

/**
 * Загрузить program.md для агента
 */
export function loadProgram(agentId) {
  const cacheKey = agentId;
  const cached = _programCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.content;

  const path = `${AGENTS_DIR}/${agentId}/program.md`;
  if (!existsSync(path)) return null;

  const content = readFileSync(path, "utf8");
  _programCache.set(cacheKey, { content, ts: Date.now() });
  console.log(`[ProgramLoader] 📋 Loaded program for agent=${agentId} (${content.length} chars)`);
  return content;
}

/**
 * Извлечь текущие цели из program.md
 */
export function extractGoals(programContent) {
  if (!programContent) return [];
  const goalsMatch = programContent.match(/## Текущие цели\n([\s\S]*?)(?=\n##|$)/);
  if (!goalsMatch) return [];
  return goalsMatch[1]
    .split("\n")
    .filter(l => l.trim().startsWith("-") || /^\d\./.test(l.trim()))
    .map(l => l.replace(/^[-\d.]\s*/, "").trim())
    .filter(Boolean);
}

/**
 * Получить val_metric из program.md
 */
export function getValMetric(programContent) {
  if (!programContent) return null;
  const match = programContent.match(/val_metric:\s*(.+)/);
  return match ? match[1].trim() : null;
}

/**
 * Получить ограничения из program.md
 */
export function extractConstraints(programContent) {
  if (!programContent) return [];
  const constraintsMatch = programContent.match(/## Ограничения[^\n]*\n([\s\S]*?)(?=\n##|$)/);
  if (!constraintsMatch) return [];
  return constraintsMatch[1]
    .split("\n")
    .filter(l => l.trim().startsWith("-") || /^[-*]/.test(l.trim()))
    .map(l => l.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

/**
 * Инжектировать program context в промпт задачи
 */
export function injectProgramContext(prompt, agentId) {
  const program = loadProgram(agentId);
  if (!program) return prompt;

  const goals = extractGoals(program);
  const constraints = extractConstraints(program);
  const valMetric = getValMetric(program);

  if (goals.length === 0 && constraints.length === 0) return prompt;

  let contextStr = "[AGENT PROGRAM CONTEXT]\n";

  if (valMetric) {
    contextStr += `📊 METRICS: ${valMetric}\n`;
  }

  if (goals.length > 0) {
    contextStr += "🎯 GOALS (приоритет):\n";
    goals.slice(0, 3).forEach((g, i) => {
      contextStr += `  ${i+1}. ${g}\n`;
    });
  }

  if (constraints.length > 0) {
    contextStr += "⚠️  CONSTRAINTS (жёсткие):\n";
    constraints.slice(0, 3).forEach(c => {
      contextStr += `  • ${c}\n`;
    });
  }

  return `${prompt}\n\n${contextStr}`;
}

/**
 * Очистить кеш (для тестирования)
 */
export function clearCache() {
  _programCache.clear();
}
