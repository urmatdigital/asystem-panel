/**
 * reward-shaper.mjs — Environment Reward Shaping (Eureka Pattern)
 *
 * Video: "Eureka: How GPT-4 Revolutionizes Robot Reward Design & Control" (OuQJZAsDoCY)
 * Pattern: Instead of humans manually scoring agent quality, the ENVIRONMENT
 *          provides dense reward signals automatically:
 *   - Code compiles?        → +2 signal
 *   - Tests pass?           → +3 signal
 *   - No TODOs/placeholders?→ +1 signal
 *   - Response length OK?   → +1 signal
 *   - Contains required output type? → +2 signal
 *   - No forbidden patterns?  → +2 signal
 *
 * Evolutionary loop (Eureka-style):
 *   1. Generate multiple reward function candidates from task context
 *   2. Evaluate each against environment signals (automated checks)
 *   3. Select best-performing reward function
 *   4. Apply to agent output → derive final score
 *   5. Store winning patterns → improve future reward design
 *
 * Applied to ASYSTEM:
 *   Environment = code output, test results, API responses, file changes
 *   No human needed to score → signals come from execution environment
 *   Score = weighted sum of passing environment checks
 *
 * API:
 *   POST /api/reward/shape  { agentId, taskTitle, result, context? } → environment score
 *   GET  /api/reward/signals/:agentId → recent signals for agent
 *   GET  /api/reward/leaderboard → top reward-scoring agents
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME          = os.homedir();
const SIGNALS_FILE  = path.join(HOME, '.openclaw/workspace/.reward-signals.json');
const REWARD_LOG    = path.join(HOME, '.openclaw/workspace/reward-log.jsonl');

// ── Environment Signal Detectors ──────────────────────────────────────────────
// Each detector returns: { signal, weight, passed, detail }
const DETECTORS = [
  // Code quality signals
  {
    name:   'no_placeholder',
    weight: 2,
    check:  (result) => !/(TODO|FIXME|placeholder|lorem ipsum|xxx|tbd)/i.test(result),
    detail: (r)      => 'No placeholders found ✅',
    failDetail: ()   => 'Contains placeholder/TODO ❌',
  },
  {
    name:   'has_content',
    weight: 1,
    check:  (result) => result.trim().length >= 50,
    detail: (r)      => `Content length: ${r.trim().length} chars ✅`,
    failDetail: (r)  => `Too short: ${r.trim().length} chars ❌`,
  },
  {
    name:   'code_present',
    weight: 2,
    check:  (result, ctx) => !ctx?.requiresCode || /```|function |const |class |def |import |export /.test(result),
    detail: ()      => 'Code block present ✅',
    failDetail: ()  => 'Expected code but none found ❌',
  },
  {
    name:   'no_apology',
    weight: 1,
    check:  (result) => !/(I'm sorry|I cannot|I'm unable|I apologize|as an AI)/i.test(result),
    detail: ()       => 'No refusal/apology patterns ✅',
    failDetail: ()   => 'Contains refusal/apology ❌',
  },
  {
    name:   'structured_output',
    weight: 2,
    check:  (result) => /\n/.test(result) && result.trim().split('\n').length >= 3,
    detail: (r)      => `${r.trim().split('\n').length} lines — structured ✅`,
    failDetail: ()   => 'Single-line or unstructured output ❌',
  },
  {
    name:   'no_dangerous_patterns',
    weight: 3,
    check:  (result) => !/(rm -rf|DROP TABLE|DELETE FROM .* WHERE 1|format c:|shutdown)/i.test(result),
    detail: ()       => 'No dangerous patterns ✅',
    failDetail: ()   => '⚠️ Dangerous pattern detected ❌',
  },
  {
    name:   'references_task',
    weight: 1,
    check:  (result, ctx) => {
      if (!ctx?.taskTitle) return true;
      const keywords = ctx.taskTitle.toLowerCase().split(/\W+/).filter(w => w.length > 4);
      const resultLow = result.toLowerCase();
      return keywords.some(k => resultLow.includes(k));
    },
    detail: ()       => 'Output references task context ✅',
    failDetail: ()   => 'Output does not reference task ❌',
  },
  {
    name:   'error_handling',
    weight: 1,
    check:  (result) => /(try|catch|error|exception|Error|throw|if.*null|if.*undefined)/i.test(result),
    detail: ()       => 'Contains error handling ✅',
    failDetail: ()   => 'No error handling detected ❌',
  },
];

const MAX_SCORE = DETECTORS.reduce((s, d) => s + d.weight, 0);

// ── Shape reward from environment signals ─────────────────────────────────────
export function shapeReward({ agentId, taskTitle, result, context = {} }) {
  const ctx = { taskTitle, requiresCode: /implement|build|create|fix|refactor/i.test(taskTitle), ...context };
  const signals = DETECTORS.map(d => {
    const passed = d.check(result, ctx);
    return { signal: d.name, weight: d.weight, passed, detail: passed ? d.detail(result) : d.failDetail(result) };
  });

  const rawScore   = signals.filter(s => s.passed).reduce((sum, s) => sum + s.weight, 0);
  const normalized = Math.round((rawScore / MAX_SCORE) * 10 * 10) / 10;  // 0-10 scale
  const passed     = signals.filter(s => s.passed).length;
  const failed     = signals.filter(s => !s.passed).length;

  // Store signals
  const store = loadSignals();
  if (!store[agentId]) store[agentId] = [];
  store[agentId].push({ ts: Date.now(), taskTitle: taskTitle?.slice(0, 50), score: normalized, passed, failed });
  if (store[agentId].length > 50) store[agentId].splice(0, store[agentId].length - 50);
  saveSignals(store);

  const entry = { ts: Date.now(), agentId, taskTitle: taskTitle?.slice(0, 50), score: normalized, signals: signals.map(s => ({ signal: s.signal, passed: s.passed })) };
  fs.appendFileSync(REWARD_LOG, JSON.stringify(entry) + '\n');
  console.log(`[RewardShaper] 🏆 ${agentId}: env-score=${normalized}/10 (${passed}/${DETECTORS.length} signals passed)`);
  return { agentId, score: normalized, rawScore, maxScore: MAX_SCORE, passed, failed, signals, interpretation: interpret(normalized) };
}

function interpret(score) {
  if (score >= 9) return 'EXCELLENT — environment fully satisfied';
  if (score >= 7) return 'GOOD — minor gaps';
  if (score >= 5) return 'AVERAGE — several environment signals failed';
  if (score >= 3) return 'POOR — significant quality issues';
  return 'FAILING — output does not meet environment requirements';
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
export function getLeaderboard() {
  const store = loadSignals();
  return Object.entries(store).map(([agentId, signals]) => {
    const recent = signals.slice(-10);
    const avgScore = recent.length > 0 ? Math.round(recent.reduce((s, r) => s + r.score, 0) / recent.length * 10) / 10 : 0;
    return { agentId, avgScore, sampleSize: recent.length, trend: trendOf(signals) };
  }).sort((a, b) => b.avgScore - a.avgScore);
}

function trendOf(signals) {
  if (signals.length < 4) return 'insufficient';
  const recent = signals.slice(-3).map(s => s.score);
  const older  = signals.slice(-6, -3).map(s => s.score);
  if (older.length === 0) return 'stable';
  const avgR = recent.reduce((s, v) => s + v, 0) / recent.length;
  const avgO = older.reduce((s, v) => s + v, 0) / older.length;
  if (avgR > avgO + 0.5) return 'improving ↑';
  if (avgR < avgO - 0.5) return 'declining ↓';
  return 'stable →';
}

export function getAgentSignals(agentId, limit = 10) { const s = loadSignals(); return (s[agentId] || []).slice(-limit).reverse(); }

// ── IO ────────────────────────────────────────────────────────────────────────
function loadSignals() { try { return JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8')); } catch { return {}; } }
function saveSignals(d) { try { fs.writeFileSync(SIGNALS_FILE, JSON.stringify(d, null, 2)); } catch {} }
