/**
 * Logician — детерминированный шлюз (ResonantOS паттерн)
 *
 * ВАЖНО: Это НЕ LLM. Это жёсткие бинарные if-then правила.
 * Запускается ПЕРЕД тем как задача попадёт к LLM.
 * LLM не может обойти эти правила.
 */

import { readFileSync, existsSync } from "node:fs";
import { injectProgramContext } from "./program-loader.mjs";

const FITNESS_YAML = `${process.env.HOME}/Projects/ASYSTEM/api/fitness.yaml`;

/**
 * Минимальный YAML парсер (для fitness.yaml)
 */
function parseYamlMinimal(content) {
  const result = { task_types: {}, agent_cycle: {} };
  const lines = content.split('\n');
  let currentSection = null;
  let currentTaskType = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (line.startsWith('task_types:')) {
      currentSection = 'task_types';
      continue;
    }
    if (line.startsWith('agent_cycle:')) {
      currentSection = 'agent_cycle';
      continue;
    }
    if (line.startsWith('global:')) {
      currentSection = 'global';
      continue;
    }

    if (currentSection === 'task_types' && line.startsWith('  ') && !line.startsWith('    ')) {
      const match = line.match(/^\s+(\w+):/);
      if (match) {
        currentTaskType = match[1];
        result.task_types[currentTaskType] = { keywords: [] };
      }
    } else if (currentTaskType && line.startsWith('    keywords:')) {
      const match = line.match(/\[(.*)\]/);
      if (match) {
        result.task_types[currentTaskType].keywords = match[1]
          .split(',')
          .map(k => k.trim().replace(/["']/g, ''));
      }
    } else if (currentTaskType && line.includes('preferred_model:')) {
      const match = line.match(/:\s*(.+)/);
      if (match) result.task_types[currentTaskType].preferred_model = match[1].trim();
    } else if (currentTaskType && line.includes('fitness:')) {
      const match = line.match(/:\s*"(.+)"/);
      if (match) result.task_types[currentTaskType].fitness = match[1];
    } else if (currentSection === 'agent_cycle' && line.includes('max_duration_minutes:')) {
      const match = line.match(/:\s*(\d+)/);
      if (match) result.agent_cycle.max_duration_minutes = parseInt(match[1]);
    }
  }

  return result;
}

// ── Правила Logician (бинарные if-then) ──────────────────────────────────

const RULES = [
  // Rule 1: Оркестратор НЕ пишет код сам — делегирует
  {
    id: "no-direct-code",
    check: (task) => {
      const isCode = /build|implement|create|fix.*bug|написать код/i.test(task.title);
      const isOrchestrator = (task.agent || "forge") === "atlas";
      return isCode && isOrchestrator;
    },
    action: "delegate",
    message: "Orchestrator cannot write code directly → delegate to forge/coding agent",
  },

  // Rule 2: Тело задачи > 800 символов → обязательно sub-agent
  {
    id: "large-task-delegate",
    check: (task) => (task.body || "").length > 800,
    action: "split",
    message: "Task body >800 chars → must be split or delegated to sub-agent",
  },

  // Rule 3: Нет заголовка → блокировать
  {
    id: "require-title",
    check: (task) => !task.title || task.title.trim().length < 3,
    action: "block",
    message: "Task must have a title (>=3 chars)",
  },

  // Rule 4: Critical без assignedTo → назначить forge
  {
    id: "critical-needs-agent",
    check: (task) => task.priority === "critical" && !task.assignedTo && !task.agent,
    action: "assign",
    assign_to: "forge",
    message: "Critical task must have an assigned agent → assigning forge",
  },

  // Rule 5: Промпт инъекция в заголовке → блокировать
  {
    id: "no-prompt-injection",
    check: (task) => /ignore.{0,20}previous|forget.{0,20}instruction|you are now|new persona|act as/i.test(`${task.title} ${task.body || ""}`),
    action: "block",
    message: "Prompt injection detected in task",
  },

  // Rule 6: Дедлайн в прошлом > 24ч → эскалировать сразу
  {
    id: "overdue-escalate",
    check: (task) => {
      if (!task.deadline) return false;
      const overdueMs = Date.now() - new Date(task.deadline).getTime();
      return overdueMs > 24 * 60 * 60_000;
    },
    action: "escalate",
    message: "Task overdue >24h → immediate escalation",
  },

  // Rule 7: Запретить "rm -rf" и деструктивные команды
  {
    id: "no-destructive-ops",
    check: (task) => /rm\s+-rf|DROP\s+TABLE|DELETE\s+FROM.*WHERE\s+1|format\s+c:/i.test(`${task.title} ${task.body || ""}`),
    action: "block",
    message: "Destructive operation detected → blocked by Logician",
  },
];

/**
 * Прогнать задачу через все правила Logician
 * @returns {{ passed: boolean, action: string, violations: array, task: object }}
 */
export function runLogician(task) {
  const violations = [];
  let finalAction = "pass";
  let modifiedTask = { ...task };

  for (const rule of RULES) {
    if (rule.check(task)) {
      violations.push({ id: rule.id, action: rule.action, message: rule.message });
      console.log(`[Logician] 🔒 Rule "${rule.id}" triggered: ${rule.message}`);

      // Применить действие
      if (rule.action === "block") {
        finalAction = "block";
      } else if (rule.action === "delegate" && finalAction !== "block") {
        finalAction = "delegate";
      } else if (rule.action === "split" && finalAction !== "block") {
        finalAction = "split";
      } else if (rule.action === "escalate" && finalAction !== "block") {
        finalAction = "escalate";
      } else if (rule.action === "assign") {
        modifiedTask.agent = rule.assign_to;
        modifiedTask.assignedTo = rule.assign_to;
        console.log(`[Logician] 📋 Auto-assigned to ${rule.assign_to}`);
      }
    }
  }

  const passed = finalAction === "pass";
  if (passed) {
    console.log(`[Logician] ✅ Task "${task.title?.slice(0,50)}" passed all rules`);
  } else {
    console.log(`[Logician] ❌ Task "${task.title?.slice(0,50)}" → action=${finalAction} (${violations.length} violations)`);
  }

  return { passed, action: finalAction, violations, task: modifiedTask };
}

/**
 * SST (Single Source of Truth) — инъекция контекста в промпт
 * Добавляет только релевантный контекст, убирает лишнее
 */
export function injectSST(prompt, task) {
  const parts = [];

  // Инъектировать program context из program.md агента (Karpathy паттерн)
  const agentId = task.agent || task.assignedTo || "forge";
  const programCtx = injectProgramContext("", agentId);
  if (programCtx.trim()) {
    parts.push(programCtx);
  }

  parts.push(prompt);

  // Загрузить fitness.yaml если есть
  if (existsSync(FITNESS_YAML)) {
    try {
      const fitness = parseYamlMinimal(readFileSync(FITNESS_YAML, "utf8"));
      const text = `${task.title} ${task.body || ""}`.toLowerCase();

      // Найти подходящий тип задачи
      for (const [type, cfg] of Object.entries(fitness.task_types || {})) {
        const keywords = cfg.keywords || [];
        if (keywords.some(kw => text.includes(kw))) {
          parts.push(`\n\n[FITNESS] Task type: ${type} | Success: ${cfg.fitness} | Model: ${cfg.preferred_model}`);
          break;
        }
      }

      // Агентский цикл
      const cycle = fitness.agent_cycle || {};
      if (cycle.max_duration_minutes) {
        parts.push(`\n[CONSTRAINT] Max duration: ${cycle.max_duration_minutes}min`);
      }
    } catch {}
  }

  // Добавить business context если critical
  if (task.priority === "critical") {
    parts.push("\n\n[LOGICIAN] CRITICAL TASK: Document root cause. Do not close without fix verified.");
  }

  // Graceful Failure (Nemotron паттерн)
  parts.push(
    "\n\n[RULE] If uncertain or lacking info → return explicit error. " +
    "Do NOT guess or hallucinate. Say: I cannot complete this because: [reason]"
  );
  return parts.join("");
}

/**
 * Статистика Logician
 */
const _stats = { passed: 0, blocked: 0, delegated: 0, escalated: 0, assigned: 0 };
export function logicianStats() { return { ..._stats }; }
export function recordLogicianResult(action) {
  if (action === "pass") _stats.passed++;
  else if (action === "block") _stats.blocked++;
  else if (action === "delegate") _stats.delegated++;
  else if (action === "escalate") _stats.escalated++;
  else if (action === "assign") _stats.assigned++;
}
