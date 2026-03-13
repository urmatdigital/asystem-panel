/**
 * reflection.mjs — Post-Task Reflection Loop (3 Modes)
 *
 * Video: "Learning from Trials and Errors: Reflective Test-Time Planning
 *         for Embodied LLMs" (Kf92O6salFc) — Feb 2026
 *
 * Pattern: 3 reflection modes → 10.6% → 44.7% success rate (+34%)
 *   1. Reflection-in-action  (PRE): Simulate outcomes before dispatch
 *   2. Reflection-on-action  (POST): Analyze what happened after task done
 *   3. Retrospective         (MILESTONE): Review batches at goal milestones
 *
 * Implementation for ASYSTEM:
 *   Pre-dispatch: score the task for likely success (0-100)
 *   Post-task: extract lessons (what worked, what failed, what to change)
 *   Milestone: every 10 completed tasks → batch retrospective → persist to ZVec
 *
 * Lesson format (stored in ZVec as causal_chain):
 *   TASK: <title>
 *   AGENT: <agentId>
 *   OUTCOME: success|partial|failed
 *   LESSON: <what was learned>
 *   APPLY: <how to apply this in future>
 *
 * API:
 *   POST /api/reflect/pre     { to, title, body }  — pre-dispatch score
 *   POST /api/reflect/post    { taskId, agentId, title, result, score, status }
 *   POST /api/reflect/milestone { agentId }         — force milestone retrospective
 *   GET  /api/reflect/lessons  ?agentId=...         — get lessons for agent
 *   GET  /api/reflect/stats                          — reflection stats
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME     = os.homedir();
const LOG_FILE = path.join(HOME, '.openclaw/workspace/reflection-log.jsonl');
const CTR_FILE = path.join(HOME, '.openclaw/workspace/.reflection-counters.json');

const OPENAI_KEY = process.env.OPENAI_API_KEY;

// ── Counters (task count per agent for milestone trigger) ─────────────────────
function loadCounters() { try { return JSON.parse(fs.readFileSync(CTR_FILE, 'utf8')); } catch { return {}; } }
function saveCounters(c) { try { fs.writeFileSync(CTR_FILE, JSON.stringify(c, null, 2)); } catch {} }

// ── LLM call ──────────────────────────────────────────────────────────────────
async function llm(system, user, temp = 0.4) {
  if (!OPENAI_KEY) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 400, temperature: temp }),
      signal: AbortSignal.timeout(12000),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim();
  } catch { return null; }
}

// ── MODE 1: Reflection-in-action (PRE-dispatch score) ────────────────────────
export async function reflectPre({ to, title, body = '' }) {
  // Fast heuristic scoring (no LLM cost unless task is complex)
  const taskLen = (title + body).length;
  const hasContext = body.length > 100;
  const isComplex = title.match(/implement|refactor|migrate|architect|design/i);
  const isSimple  = title.match(/fix|update|check|verify|add/i);

  let score = 70; // base
  if (hasContext) score += 10;
  if (isSimple)   score += 10;
  if (isComplex)  score -= 15;
  if (taskLen > 2000) score -= 10; // too much context can confuse
  score = Math.max(10, Math.min(100, score));

  const prediction = score >= 75 ? 'likely_success' : score >= 50 ? 'uncertain' : 'likely_struggle';
  console.log(`[Reflection] PRE: ${to} ← "${title.slice(0, 40)}" score=${score} (${prediction})`);

  return { score, prediction, recommendation: score < 50 ? 'Consider decomposing or adding more context' : 'Proceed' };
}

// ── MODE 2: Reflection-on-action (POST-task lesson extraction) ────────────────
export async function reflectPost({ taskId, agentId, title, result = '', score, status }) {
  const outcome = status === 'done' && (score === undefined || score >= 6) ? 'success' : status === 'done' ? 'partial' : 'failed';

  // Fast path: store basic lesson without LLM if outcome is success
  let lesson = null;
  let apply  = null;

  if (outcome !== 'success' && OPENAI_KEY) {
    const prompt = `Agent: ${agentId}\nTask: "${title}"\nOutcome: ${outcome}\nScore: ${score ?? 'N/A'}\nResult snippet: ${String(result).slice(0, 300)}\n\nExtract:\nLESSON: (what went wrong or what pattern worked)\nAPPLY: (how to use this lesson in future similar tasks)`;
    const resp = await llm('You are an AI agent retrospective analyst. Extract concise lessons from task outcomes in 1-2 sentences each.', prompt);
    if (resp) {
      const lessonMatch = resp.match(/LESSON:\s*(.+?)(?:APPLY:|$)/is);
      const applyMatch  = resp.match(/APPLY:\s*(.+?)$/is);
      lesson = lessonMatch?.[1]?.trim()?.slice(0, 200);
      apply  = applyMatch?.[1]?.trim()?.slice(0, 200);
    }
  }

  if (!lesson) lesson = outcome === 'success' ? `Task "${title.slice(0, 50)}" completed successfully.` : `Task "${title.slice(0, 50)}" ${outcome} — review approach.`;
  if (!apply)  apply  = outcome === 'success' ? 'Reuse same approach for similar tasks.' : 'Break into smaller steps or add more context.';

  const entry = {
    ts: Date.now(), taskId, agentId, title: title.slice(0, 80), outcome, score,
    lesson, apply,
    causal: `CAUSE: ${title.slice(0, 50)} | ACTION: dispatched to ${agentId} | OUTCOME: ${outcome} (score:${score ?? 'N/A'})`,
  };
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');

  // Store in ZVec as causal_chain
  (async () => {
    try {
      const { execSync } = await import('node:child_process');
      const content = `TASK: ${title.slice(0, 60)}\nAGENT: ${agentId}\nOUTCOME: ${outcome}\nLESSON: ${lesson}\nAPPLY: ${apply}`;
      const zvecScript = `
import sys; sys.path.insert(0, '/Users/urmatmyrzabekov/projects/ASYSTEM/api')
from reme_search_zvec import store_memory
store_memory("${content.replace(/"/g, "'").replace(/\n/g, '\\n')}", memory_type="causal_chain", memory_target="${agentId}")
`;
      execSync(`/Users/urmatmyrzabekov/.zvec-env/bin/python3 -c '${zvecScript}'`, { timeout: 10000 });
    } catch {}
  })();

  // Check milestone
  const counters = loadCounters();
  counters[agentId] = (counters[agentId] || 0) + 1;
  saveCounters(counters);
  if (counters[agentId] % 10 === 0) {
    console.log(`[Reflection] 🏁 MILESTONE: ${agentId} hit ${counters[agentId]} tasks → triggering retrospective`);
    reflectMilestone(agentId).catch(() => {});
  }

  console.log(`[Reflection] POST: ${agentId}/${taskId} → ${outcome}, lesson stored`);
  return { outcome, lesson, apply };
}

// ── MODE 3: Retrospective (MILESTONE — batch review) ─────────────────────────
export async function reflectMilestone(agentId) {
  if (!OPENAI_KEY) return;
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const recent = lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && e.agentId === agentId)
      .slice(-10); // last 10 tasks for this agent

    if (recent.length < 3) return;

    const summary = recent.map(e => `${e.outcome.toUpperCase()}: "${e.title}" → ${e.lesson}`).join('\n');
    const resp = await llm(
      'You are reviewing an AI agent\'s last 10 tasks. Identify systemic patterns (what this agent consistently does wrong or right) and give 2-3 improvement directives.',
      `Agent: ${agentId}\nTask history:\n${summary}\n\nProvide:\nPATTERN: (systemic finding)\nDIRECTIVES: (1. ... 2. ... 3. ...)`
    );

    if (resp) {
      fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: Date.now(), type: 'milestone', agentId, tasks: recent.length, analysis: resp.slice(0, 500) }) + '\n');
      console.log(`[Reflection] 📊 Milestone retrospective for ${agentId}:\n${resp.slice(0, 200)}`);
    }
  } catch {}
}

// ── Get lessons ───────────────────────────────────────────────────────────────
export function getLessons(agentId) {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && (!agentId || e.agentId === agentId) && e.lesson)
      .slice(-20);
  } catch { return []; }
}

export function getReflectionStats() {
  const counters = loadCounters();
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const byOutcome = {};
    for (const e of entries.filter(e => e.outcome)) byOutcome[e.outcome] = (byOutcome[e.outcome] || 0) + 1;
    return { totalReflections: entries.length, byOutcome, counters, milestones: entries.filter(e => e.type === 'milestone').length };
  } catch { return { totalReflections: 0, byOutcome: {}, counters, milestones: 0 }; }
}
