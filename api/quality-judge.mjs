/**
 * 🏛️ Quality Judge — Karpathy Loop for ASYSTEM
 *
 * After task completion: LLM-as-Judge scores result 0-10.
 * Low score → re-dispatch with enriched context (max 2 retries).
 * Writes episodic memory to ZVec for long-term model routing stats.
 *
 * Inspired by: Karpathy Loop / autoresearch pattern
 * Judge model: claude-haiku-4-5 (fast, cheap — ~$0.001/eval)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);
const HOME = os.homedir();

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const JUDGE_THRESHOLD    = 6;   // score < 6 → retry
const ESCALATE_THRESHOLD = 4;   // score < 4 → human review (skip retry)
const MAX_RETRIES        = 2;   // judge fatigue protection
const JUDGE_MODEL        = 'claude-haiku-4-5';

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1: Persistent metrics (Senior Devs pattern)
// Survives restarts — tracks rolling daily windows for regression detection
// ─────────────────────────────────────────────────────────────────────────────
const METRICS_FILE = path.join(HOME, '.openclaw/workspace/eval-metrics.json');

function loadMetrics() {
  try {
    return JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
  } catch {
    return { days: {}, allTime: { judged: 0, passed: 0, retried: 0, escalated: 0, scoreSum: 0 } };
  }
}

function saveMetrics(m) {
  try { fs.writeFileSync(METRICS_FILE, JSON.stringify(m, null, 2)); } catch {}
}

function todayKey() { return new Date().toISOString().slice(0, 10); }

function recordMetric({ score, verdict, agent }) {
  const m = loadMetrics();
  const day = todayKey();
  if (!m.days[day]) m.days[day] = { judged: 0, passed: 0, retried: 0, escalated: 0, scoreSum: 0, byAgent: {} };
  const d = m.days[day];
  d.judged++; d.scoreSum += score || 0;
  if (verdict === 'pass') d.passed++;
  else if (verdict === 'retry') d.retried++;
  else if (verdict === 'escalate') d.escalated++;
  if (!d.byAgent[agent]) d.byAgent[agent] = { judged: 0, passed: 0, scoreSum: 0 };
  d.byAgent[agent].judged++;
  d.byAgent[agent].scoreSum += score || 0;
  if (verdict === 'pass') d.byAgent[agent].passed++;
  // allTime
  m.allTime.judged++; m.allTime.scoreSum += score || 0;
  if (verdict === 'pass') m.allTime.passed++;
  else if (verdict === 'retry') m.allTime.retried++;
  else if (verdict === 'escalate') m.allTime.escalated++;
  // prune old days (keep 30)
  const keys = Object.keys(m.days).sort();
  if (keys.length > 30) keys.slice(0, keys.length - 30).forEach(k => delete m.days[k]);
  saveMetrics(m);
  return m;
}

function detectRegression() {
  const m = loadMetrics();
  const days = Object.entries(m.days).sort(([a], [b]) => a.localeCompare(b));
  if (days.length < 2) return null;
  const today = days[days.length - 1][1];
  const prior = days.slice(-8, -1); // last 7 days before today
  if (!prior.length || today.judged < 5) return null;
  const priorAvgPass = prior.reduce((s, [, d]) => s + (d.judged ? d.passed / d.judged : 0), 0) / prior.length;
  const todayPassRate = today.judged ? today.passed / today.judged : 0;
  if (priorAvgPass > 0 && (priorAvgPass - todayPassRate) > 0.15) {
    return { regression: true, todayPassRate: +(todayPassRate * 100).toFixed(1), priorAvgPassRate: +(priorAvgPass * 100).toFixed(1), drop: +((priorAvgPass - todayPassRate) * 100).toFixed(1) };
  }
  return { regression: false, todayPassRate: +(todayPassRate * 100).toFixed(1), priorAvgPassRate: +(priorAvgPass * 100).toFixed(1) };
}

// Running stats (in-memory, reset on server restart)
const _stats = {
  judged: 0, passed: 0, retried: 0, escalated: 0,
  byAgent: {}, avgScore: 0, scoreSum: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Core judge — calls OpenAI-compatible API via python (reuses ZVec venv)
// ─────────────────────────────────────────────────────────────────────────────

const JUDGE_PROMPT = `You are a task quality evaluator for an AI agent system (ASYSTEM).
Score the task result from 0 to 10 based on these criteria:
- 10: Perfect — complete, correct, addresses all requirements
- 7-9: Good — mostly complete, minor gaps
- 5-6: Acceptable — partial completion, key parts done
- 3-4: Poor — significant gaps or errors
- 0-2: Fail — wrong direction, incomplete, or harmful

Task title: {TITLE}
Agent: {AGENT}
Result:
---
{RESULT}
---

Respond ONLY with valid JSON: {"score": <0-10>, "verdict": "<pass|retry|escalate>", "feedback": "<one sentence why>", "missing": "<what was not done, or null>"}
Verdict rules: score >= 6 → pass; score 4-5 → retry; score < 4 → escalate`;

async function callJudge(title, result, agent) {
  const prompt = JUDGE_PROMPT
    .replace('{TITLE}', title.slice(0, 200))
    .replace('{AGENT}', agent)
    .replace('{RESULT}', result.slice(0, 800));

  // Use python + openai SDK (available in zvec-env)
  const pyScript = `
import os, json, sys
from openai import OpenAI
client = OpenAI(api_key=os.environ.get('OPENAI_API_KEY',''))
resp = client.chat.completions.create(
    model='gpt-4o-mini',
    messages=[{'role':'user','content':${JSON.stringify(JSON.stringify(prompt).slice(1,-1))}],
    temperature=0,
    max_tokens=150,
)
print(resp.choices[0].message.content.strip())
`.replace("${JSON.stringify(JSON.stringify(prompt).slice(1,-1))}", JSON.stringify(prompt));

  const pyPath = path.join(HOME, '.zvec-env/bin/python3');
  const { stdout } = await execFileAsync(pyPath, ['-c', pyScript], {
    env: process.env,
    timeout: 15000,
  });

  const raw = stdout.trim();
  // Extract JSON from response
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Bad judge response: ${raw.slice(0, 100)}`);
  return JSON.parse(match[0]);
}

// ─────────────────────────────────────────────────────────────────────────────
// EMPO2 pattern: generate "tip" from task outcome → store in ZVec episodic
// Agent reads these tips before next similar task → improves without retraining
// ─────────────────────────────────────────────────────────────────────────────

// AMA-Agent pattern: causal triple format CAUSE→ACTION→OUTCOME
// Captures WHY something worked/failed, not just WHAT happened
const TIP_PROMPT = `You are distilling a causal lesson from an AI agent task for future reference.
Task: {TITLE}
Agent: {AGENT}
Score: {SCORE}/10
Feedback: {FEEDBACK}
Missing: {MISSING}
Result snippet: {RESULT}

Write ONE causal tip using this EXACT format:
CAUSE: [what triggered the situation] | ACTION: [what was done / should be done] | OUTCOME: [result/lesson]

Examples of good causal tips:
  "CAUSE: FastAPI route used sync DB call | ACTION: rewrite as async with asyncpg pool | OUTCOME: eliminated blocking, 10x speedup"
  "CAUSE: alembic migration modified directly | ACTION: always use 'alembic revision --autogenerate' | OUTCOME: avoids partial schema failures"
  "CAUSE: TypeScript strict mode caught implicit any | ACTION: declare all types explicitly | OUTCOME: zero type errors in CI"

Keep total length under 200 chars. Use | as separator. No extra text.`;

async function generateTip({ title, agent, score, feedback, missing, result }) {
  try {
    const prompt = TIP_PROMPT
      .replace('{TITLE}', title.slice(0, 150))
      .replace('{AGENT}', agent)
      .replace('{SCORE}', score)
      .replace('{FEEDBACK}', feedback || '')
      .replace('{MISSING}', missing || 'none')
      .replace('{RESULT}', (result || '').slice(0, 300));

    const pyPath = path.join(HOME, '.zvec-env/bin/python3');
    const pyScript = `
import os, json
from openai import OpenAI
client = OpenAI(api_key=os.environ.get('OPENAI_API_KEY',''))
resp = client.chat.completions.create(
    model='gpt-4o-mini',
    messages=[{'role':'user','content':${JSON.stringify(prompt)}}],
    temperature=0.3, max_tokens=80,
)
print(resp.choices[0].message.content.strip())
`;
    const { stdout } = await execFileAsync(pyPath, ['-c', pyScript], {
      env: process.env, timeout: 12000,
    });
    return stdout.trim().slice(0, 300);
  } catch (e) {
    console.warn('[EMPO2] tip generation failed (non-fatal):', e.message);
    return null;
  }
}

async function storeTip({ tip, agent, taskId, score }) {
  if (!tip) return;
  try {
    const zvecPy = path.join(HOME, '.zvec-env/bin/python3');
    const script = path.join(HOME, 'projects/ASYSTEM/api/reme_search_zvec.py');
    // AMA-Agent pattern: store as causal_chain type for better retrieval
    // Format: CAUSE: X | ACTION: Y | OUTCOME: Z → richer causal context than plain similarity
    const isCausal = tip.includes('CAUSE:') && tip.includes('ACTION:') && tip.includes('OUTCOME:');
    const memType = isCausal ? 'causal_chain' : 'episodic';
    const content = `[TIP:${agent}] ${tip} (task=${taskId}, score=${score}/10)`;
    await execFileAsync(zvecPy, [script, '--add', content, '--type', memType, '--target', agent], {
      env: process.env, timeout: 10000,
    });
    console.log(`[AMA/EMPO2] ${memType} tip stored for ${agent}: ${tip.slice(0, 80)}`);
  } catch (e) {
    console.warn('[EMPO2] tip storage failed (non-fatal):', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Write episodic memory to ZVec
// ─────────────────────────────────────────────────────────────────────────────

async function writeEpisodicMemory({ taskId, title, agent, score, verdict, model, retryCount }) {
  try {
    const content = `[TASK EVAL] id=${taskId} agent=${agent} model=${model||'unknown'} score=${score}/10 verdict=${verdict} retries=${retryCount} title="${title.slice(0,100)}"`;
    const zvecPy  = path.join(HOME, '.zvec-env/bin/python3');
    const script  = path.join(HOME, 'projects/ASYSTEM/api/reme_search_zvec.py');
    await execFileAsync(zvecPy, [script, '--add', content, '--type', 'episodic', '--target', agent], {
      env: process.env,
      timeout: 10000,
    });
  } catch (e) {
    console.warn('[QualityJudge] episodic memory write failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Track model performance in Optimization Architect
// ─────────────────────────────────────────────────────────────────────────────

async function trackModelPerformance(model, score) {
  try {
    const { recordModelResult } = await import('./optimization-architect.mjs');
    recordModelResult(model || JUDGE_MODEL, score >= JUDGE_THRESHOLD);
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export: judge a completed task
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Judge a completed task. Returns action to take.
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {string} opts.title       — original task title
 * @param {string} opts.result      — what the agent returned
 * @param {string} opts.agent       — agent id (forge, atlas, iron...)
 * @param {string} [opts.model]     — model used for task (for stats)
 * @param {number} [opts.retryCount] — how many times already retried
 * @param {string} [opts.originalBody] — original task body (for re-dispatch)
 *
 * @returns {{ action: 'pass'|'retry'|'escalate', score, feedback, enrichedBody? }}
 */
export async function judgeTask({ taskId, title, result, agent, model, retryCount = 0, originalBody = '' }) {
  // Judge fatigue protection
  if (retryCount >= MAX_RETRIES) {
    console.log(`[QualityJudge] Max retries (${MAX_RETRIES}) reached for ${taskId} — escalating`);
    return { action: 'escalate', score: null, feedback: `Max retries reached (${MAX_RETRIES})`, retryCount };
  }

  // Skip judging trivially short results (likely acknowledgement, not real output)
  if (!result || result.trim().length < 20) {
    return { action: 'pass', score: 7, feedback: 'Short acknowledgement — pass by default', retryCount };
  }

  try {
    const judgment = await callJudge(title, result, agent);
    const { score, verdict, feedback, missing } = judgment;

    // Update stats
    _stats.judged++;
    _stats.scoreSum += score;
    _stats.avgScore = _stats.scoreSum / _stats.judged;
    _stats.byAgent[agent] = _stats.byAgent[agent] ?? { judged: 0, scoreSum: 0 };
    _stats.byAgent[agent].judged++;
    _stats.byAgent[agent].scoreSum += score;

    // Layer 1: persist metrics for regression detection
    recordMetric({ score, verdict, agent });

    // Write episodic memory (async, non-blocking)
    writeEpisodicMemory({ taskId, title, agent, score, verdict, model, retryCount }).catch(() => {});
    trackModelPerformance(model, score).catch(() => {});

    // EMPO2: generate + store tip for agent (success AND failure — both are learnings)
    const shouldGenerateTip = score <= 5 || score >= 8; // learn from failures AND great successes
    if (shouldGenerateTip) {
      generateTip({ title, agent, score, feedback, missing, result })
        .then(tip => storeTip({ tip, agent, taskId, score }))
        .catch(() => {});
    }

    console.log(`[QualityJudge] ${taskId} | agent=${agent} | score=${score}/10 | verdict=${verdict} | ${feedback}`);

    if (score >= JUDGE_THRESHOLD) {
      _stats.passed++;
      return { action: 'pass', score, feedback, retryCount };
    }

    if (score < ESCALATE_THRESHOLD) {
      _stats.escalated++;
      return { action: 'escalate', score, feedback, missing, retryCount };
    }

    // retry: build enriched body
    _stats.retried++;
    const enrichedBody = [
      originalBody || title,
      `\n\n---`,
      `[RETRY ${retryCount + 1}/${MAX_RETRIES}] Previous attempt scored ${score}/10.`,
      `Judge feedback: ${feedback}`,
      missing ? `Missing: ${missing}` : '',
      `Please address the gaps and provide a complete response.`,
    ].filter(Boolean).join('\n');

    return { action: 'retry', score, feedback, missing, enrichedBody, retryCount: retryCount + 1 };

  } catch (e) {
    console.warn('[QualityJudge] judge call failed (non-fatal):', e.message);
    return { action: 'pass', score: null, feedback: `Judge unavailable: ${e.message}`, retryCount };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EMPO2: retrieve tips for agent before dispatch (inject into prompt)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retrieve top-3 relevant tips for an agent given a task title.
 * Used in /api/dispatch to enrich the prompt before sending.
 *
 * @param {string} agent  — agent id
 * @param {string} query  — task title / description
 * @returns {string|null} — formatted tip block or null if none
 */
export async function retrieveTips(agent, query) {
  try {
    const zvecPy = path.join(HOME, '.zvec-env/bin/python3');
    const script = path.join(HOME, 'projects/ASYSTEM/api/reme_search_zvec.py');
    // AMA-Agent: retrieve BOTH causal_chain and episodic tips
    // causal tips preferred (richer context) — retrieved first
    const [causalOut, episodicOut] = await Promise.all([
      execFileAsync(zvecPy, [script, '--query', `TIP:${agent} ${query}`, '--top', '2', '--mtype', 'causal_chain'], { env: process.env, timeout: 8000 }).catch(() => ({ stdout: '' })),
      execFileAsync(zvecPy, [script, '--query', `TIP:${agent} ${query}`, '--top', '2', '--mtype', 'episodic'],      { env: process.env, timeout: 8000 }).catch(() => ({ stdout: '' })),
    ]);
    const allLines = [
      ...causalOut.stdout.trim().split('\n').filter(l => l.includes('[TIP:') && l.includes(agent)),
      ...episodicOut.stdout.trim().split('\n').filter(l => l.includes('[TIP:') && l.includes(agent)),
    ].slice(0, 3);
    const lines = allLines;
    if (!lines.length) return null;
    return `\n\n[Agent Memory — causal + episodic tips]\n${lines.map((l, i) => `${i + 1}. ${l.replace(/^\[.*?\]\s*/, '').split('(task=')[0].trim()}`).join('\n')}`;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 exports: eval metrics + regression detection
// ─────────────────────────────────────────────────────────────────────────────

export function getEvalMetrics() {
  const m = loadMetrics();
  const days = Object.entries(m.days).sort(([a], [b]) => a.localeCompare(b)).slice(-7);
  const regression = detectRegression();
  const trend = days.map(([date, d]) => ({
    date,
    judged: d.judged,
    passRate: d.judged ? +(d.passed / d.judged * 100).toFixed(1) : null,
    avgScore: d.judged ? +(d.scoreSum / d.judged).toFixed(2) : null,
    escalated: d.escalated,
  }));
  return {
    allTime: {
      judged: m.allTime.judged,
      passRate: m.allTime.judged ? +(m.allTime.passed / m.allTime.judged * 100).toFixed(1) : null,
      avgScore: m.allTime.judged ? +(m.allTime.scoreSum / m.allTime.judged).toFixed(2) : null,
    },
    trend7d: trend,
    regression,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────

export function getJudgeStats() {
  const byAgent = {};
  for (const [agent, s] of Object.entries(_stats.byAgent)) {
    byAgent[agent] = { judged: s.judged, avgScore: s.judged ? +(s.scoreSum / s.judged).toFixed(2) : 0 };
  }
  return {
    ..._stats,
    avgScore:      +_stats.avgScore.toFixed(2),
    passRate:      _stats.judged ? +(_stats.passed  / _stats.judged).toFixed(3) : 0,
    retryRate:     _stats.judged ? +(_stats.retried / _stats.judged).toFixed(3) : 0,
    escalateRate:  _stats.judged ? +(_stats.escalated / _stats.judged).toFixed(3) : 0,
    byAgent,
    judgeModel:    JUDGE_MODEL,
    thresholds:    { pass: JUDGE_THRESHOLD, escalate: ESCALATE_THRESHOLD, maxRetries: MAX_RETRIES },
  };
}
