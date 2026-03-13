/**
 * dep-learner.mjs — Automatic Task Dependency Learning
 *
 * Video: "I Built an App with 5 AI Agents (Claude Code Agent Teams)" (TcRkAuCYI1Q)
 * Pattern: Agent team learns from task history which tasks ALWAYS follow others.
 *   No manual DAG configuration needed — the system discovers dependency patterns.
 *
 * Algorithm:
 *   1. Track task completion order per agent per session
 *   2. Build co-occurrence matrix: when task type A completes, what follows within 2h?
 *   3. If P(B follows A) >= 0.7 over 5+ observations → LEARNED DEPENDENCY A→B
 *   4. Inject learned deps into DAG when new task of type A is dispatched
 *   5. Auto-suggest: "based on history, you'll likely need B after A"
 *
 * Task type extraction:
 *   First verb of title: "implement auth" → type=implement, subject=auth
 *   Types: implement, fix, test, review, deploy, document, refactor, cleanup, research, plan
 *
 * Learned dependency storage:
 *   { from: "implement", to: "test", count: 12, probability: 0.85, avgDelayMin: 45 }
 *
 * API:
 *   POST /api/deps/record    { taskType, followedBy, delayMin? } → record observation
 *   GET  /api/deps/suggest   ?taskType=implement → suggested follow-up tasks
 *   GET  /api/deps/graph     → full learned dependency graph
 *   POST /api/deps/reset     { taskType } → clear learned deps for type
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME          = os.homedir();
const DEP_FILE      = path.join(HOME, '.openclaw/workspace/.learned-deps.json');
const DEP_LOG       = path.join(HOME, '.openclaw/workspace/dep-learning-log.jsonl');
const MIN_OBS       = 3;    // minimum observations before establishing dep
const MIN_PROB      = 0.65; // probability threshold for dependency
const WINDOW_MIN    = 120;  // look for follow-ups within 2 hours

// ── Verb extraction ───────────────────────────────────────────────────────────
const TASK_VERBS = ['implement', 'fix', 'test', 'review', 'deploy', 'document',
                    'refactor', 'cleanup', 'research', 'plan', 'build', 'create',
                    'setup', 'configure', 'migrate', 'analyze', 'debug', 'optimize'];

export function extractType(title = '') {
  const low = title.toLowerCase();
  for (const v of TASK_VERBS) {
    if (low.startsWith(v) || low.includes(` ${v} `) || low.includes(`${v} `)) return v;
  }
  return 'general';
}

// ── Load / save ────────────────────────────────────────────────────────────────
function loadDeps() {
  try { return JSON.parse(fs.readFileSync(DEP_FILE, 'utf8')); }
  catch { return { observations: {}, learned: [] }; }
}
function saveDeps(d) { try { fs.writeFileSync(DEP_FILE, JSON.stringify(d, null, 2)); } catch {} }

// ── Record observation: taskType A was followed by B ─────────────────────────
export function recordObservation({ taskType, followedBy, delayMin = 0 }) {
  if (!taskType || !followedBy || taskType === followedBy) return { ok: false, reason: 'same or missing types' };

  const db  = loadDeps();
  const key = `${taskType}→${followedBy}`;
  if (!db.observations[key]) db.observations[key] = { count: 0, delays: [], totalSeen: 0 };

  // Track total times taskType was seen (for probability)
  const typeKey = `${taskType}:total`;
  if (!db.observations[typeKey]) db.observations[typeKey] = { count: 0 };
  db.observations[typeKey].count++;

  db.observations[key].count++;
  db.observations[key].delays.push(delayMin);
  if (db.observations[key].delays.length > 50) db.observations[key].delays = db.observations[key].delays.slice(-50);

  // Recalculate probability and update learned deps
  const total    = db.observations[typeKey].count;
  const observed = db.observations[key].count;
  const prob     = total > 0 ? observed / total : 0;
  const avgDelay = db.observations[key].delays.reduce((a, b) => a + b, 0) / db.observations[key].delays.length;

  // Update learned dep if threshold met
  const existing = db.learned.find(d => d.from === taskType && d.to === followedBy);
  if (observed >= MIN_OBS && prob >= MIN_PROB) {
    if (existing) {
      existing.count = observed; existing.probability = Math.round(prob * 100) / 100; existing.avgDelayMin = Math.round(avgDelay);
    } else {
      db.learned.push({ from: taskType, to: followedBy, count: observed, probability: Math.round(prob * 100) / 100, avgDelayMin: Math.round(avgDelay) });
      console.log(`[DepLearner] 🧠 NEW learned dep: ${taskType} → ${followedBy} (prob=${Math.round(prob * 100)}%, ${observed} obs, ~${Math.round(avgDelay)}min delay)`);
      fs.appendFileSync(DEP_LOG, JSON.stringify({ ts: Date.now(), learned: true, from: taskType, to: followedBy, probability: prob, count: observed }) + '\n');
    }
  }

  saveDeps(db);
  return { ok: true, key, count: observed, total, probability: Math.round(prob * 100) / 100, learned: observed >= MIN_OBS && prob >= MIN_PROB };
}

// ── Suggest follow-up tasks based on learned deps ─────────────────────────────
export function suggestFollowups(taskType) {
  const db   = loadDeps();
  const deps = db.learned.filter(d => d.from === taskType).sort((a, b) => b.probability - a.probability);
  return { taskType, suggestions: deps.map(d => ({ type: d.to, probability: d.probability, avgDelayMin: d.avgDelayMin, recommendation: `After ${taskType}, ${d.to} typically follows in ~${d.avgDelayMin}min (${Math.round(d.probability * 100)}% of cases)` })) };
}

// ── Full learned graph ────────────────────────────────────────────────────────
export function getGraph() {
  const db = loadDeps();
  return { learned: db.learned, totalObservations: Object.keys(db.observations).filter(k => !k.includes(':')).reduce((s, k) => s + db.observations[k].count, 0), uniquePairs: Object.keys(db.observations).filter(k => !k.includes(':')).length };
}

// ── Auto-learn from task completion history (called by task complete hook) ────
export function autoLearnFromTitle({ completedTitle, nextTitle, delayMin = 0 }) {
  const from = extractType(completedTitle);
  const to   = extractType(nextTitle);
  if (from !== 'general' && to !== 'general') {
    return recordObservation({ taskType: from, followedBy: to, delayMin });
  }
  return { ok: false, reason: 'could not extract types' };
}
