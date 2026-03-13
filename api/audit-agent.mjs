/**
 * Audit Agent — логический QA после выполнения задачи (GPT-5.4 паттерн)
 *
 * Запускается после каждой завершённой задачи.
 * Использует дешёвую модель (Haiku/DeepSeek) для быстрой проверки.
 * Задаёт 3 вопроса: Соответствие, Аномалии, Полнота.
 */

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "process.env.OPENROUTER_API_KEY";
const AUDIT_MODEL = "anthropic/claude-haiku-4-5"; // быстро и дёшево
const API_BASE = "http://127.0.0.1:5190";

/**
 * Запустить аудит результата задачи
 * @param {object} task - исходная задача
 * @param {string} result - результат выполнения
 * @returns {{ passed: boolean, issues: string[], score: number, recommendation: string }}
 */
export async function auditResult(task, result) {
  if (!result || result.length < 50) {
    return { passed: true, issues: [], score: 10, recommendation: "Result too short to audit" };
  }

  const prompt = `You are a QA engineer auditing an AI agent output. Be strict and brief.

TASK: ${task.title}
TASK BODY: ${(task.body || "").slice(0, 300)}
RESULT: ${String(result).slice(0, 1000)}

Answer these 3 questions in JSON only:
1. Does the result actually match the task? (yes/no + reason)
2. Are there obvious logical errors or anomalies? (list them or "none")
3. Is the result complete or partial? (complete/partial + what is missing)

Return ONLY this JSON:
{
  "matches_task": true/false,
  "match_reason": "...",
  "anomalies": ["issue1", "issue2"] or [],
  "completeness": "complete" or "partial",
  "missing": "..." or null,
  "score": 1-10,
  "passed": true/false
}`;

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: AUDIT_MODEL,
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || "{}";
    const clean = text.replace(/```json?/g, "").replace(/```/g, "").trim();
    const audit = JSON.parse(clean);

    const issues = [];
    if (!audit.matches_task) issues.push(`Mismatch: ${audit.match_reason}`);
    if (audit.anomalies?.length) issues.push(...audit.anomalies);
    if (audit.completeness === "partial") issues.push(`Incomplete: ${audit.missing}`);

    const passed = audit.passed !== false && audit.score >= 6;

    if (!passed) {
      console.log(`[AuditAgent] ❌ FAILED score=${audit.score}/10 issues=${issues.length}`);
      issues.forEach(i => console.log(`  - ${i}`));
    } else {
      console.log(`[AuditAgent] ✅ PASSED score=${audit.score}/10`);
    }

    return {
      passed,
      issues,
      score: audit.score || 5,
      recommendation: passed ? "ok" : `Issues found: ${issues.join("; ")}`,
      raw: audit,
    };
  } catch (e) {
    console.warn(`[AuditAgent] ⚠️ Audit failed: ${e.message} → skipping`);
    return { passed: true, issues: [], score: -1, recommendation: "audit_error" };
  }
}

/**
 * Должны ли мы аудировать эту задачу?
 * Пропускаем: health checks, мониторинг, очень простые задачи
 */
export function shouldAudit(task) {
  const text = `${task.title} ${task.body || ""}`.toLowerCase();
  const skip = /ping|health|status check|monitor|log|список|list tasks/i.test(text);
  const isSimpleTask = (task.body || "").length < 30 && !/implement|build|fix|deploy/i.test(text);
  return !skip && !isSimpleTask;
}

/**
 * Записать результат аудита в shared memory если провал
 */
export async function recordAuditFailure(task, auditResult) {
  if (auditResult.passed || auditResult.issues.length === 0) return;
  try {
    await fetch(`${API_BASE}/api/memory/shared`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: JSON.stringify({
          type: "audit-failure",
          taskTitle: task.title?.slice(0, 80),
          issues: auditResult.issues,
          score: auditResult.score,
          ts: new Date().toISOString(),
        }),
        agent: task.agent || "forge",
        tags: ["audit-failure", "qa"],
      }),
    });
  } catch {}
}
