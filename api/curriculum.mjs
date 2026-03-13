/**
 * curriculum.mjs — Curriculum Scheduler (Easy→Hard Task Progression)
 *
 * Video: "Immersive AI Training: Personalised Learning at Scale" (IuskmkZ2Pzg)
 * Pattern: Adaptive difficulty progression — agents get tasks matched to their current level
 *
 * Agent skill levels (1-5):
 *   1: NOVICE    — low tasks only, max 3 concurrent
 *   2: LEARNER   — medium tasks, max 5 concurrent
 *   3: COMPETENT — high tasks, max 8 concurrent
 *   4: PROFICIENT— critical tasks, max 10 concurrent
 *   5: EXPERT    — unlimited, becomes reviewer
 *
 * Level progression: based on rolling Karpathy score avg + completed task count
 *   Level up: avg >= 8.0 AND tasks_at_level >= threshold
 *   Level down: avg < 5.0 AND tasks_at_level >= 5
 *
 * Task complexity scoring:
 *   simple (1-2):   fix/test/document, short title, no dependencies
 *   medium (3):     implement/configure, standard task
 *   complex (4-5):  refactor/deploy/architect, critical priority, dependencies
 *
 * Curriculum injection: dispatch includes [CURRICULUM] block with:
 *   current level, skills to practice, difficulty match %, next milestone
 *
 * API:
 *   GET  /api/curriculum/:agentId  → level, stats, next milestone
 *   POST /api/curriculum/record    { agentId, taskId, score, complexity }
 *   GET  /api/curriculum           → all agents' levels
 *   POST /api/curriculum/assess    { agentId, title, priority } → complexity + match
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const CURR_FILE = path.join(HOME, '.openclaw/workspace/.curriculum.json');
const CURR_LOG  = path.join(HOME, '.openclaw/workspace/curriculum-log.jsonl');

const AGENTS = ['forge','atlas','bekzat','ainura','marat','nurlan','dana','mesa','iron','pixel'];

// ── Level config ──────────────────────────────────────────────────────────────
const LEVELS = {
  1: { name: 'NOVICE',     maxComplexity: 2, maxConcurrent: 3,  threshold: 5,  upgradeAvg: 8.0 },
  2: { name: 'LEARNER',    maxComplexity: 3, maxConcurrent: 5,  threshold: 8,  upgradeAvg: 8.0 },
  3: { name: 'COMPETENT',  maxComplexity: 4, maxConcurrent: 8,  threshold: 10, upgradeAvg: 8.0 },
  4: { name: 'PROFICIENT', maxComplexity: 5, maxConcurrent: 10, threshold: 15, upgradeAvg: 8.5 },
  5: { name: 'EXPERT',     maxComplexity: 5, maxConcurrent: 999,threshold: 999, upgradeAvg: 10 },
};

// Complexity keywords
const COMPLEX_KEYWORDS = ['refactor','architect','migrate','design system','overhaul','rewrite','infrastructure','deploy','production','critical'];
const SIMPLE_KEYWORDS  = ['fix typo','fix lint','update readme','add comment','test','document','review','check'];

// ── Load/save ─────────────────────────────────────────────────────────────────
function load() {
  try { return JSON.parse(fs.readFileSync(CURR_FILE, 'utf8')); }
  catch {
    const init = {};
    for (const a of AGENTS) init[a] = { level: 3, scores: [], tasksAtLevel: 0, totalTasks: 0 };
    return init;
  }
}
function save(d) { try { fs.writeFileSync(CURR_FILE, JSON.stringify(d, null, 2)); } catch {} }

// ── Assess task complexity (1-5) ──────────────────────────────────────────────
export function assessComplexity(title = '', priority = 'medium') {
  const low = title.toLowerCase();
  if (SIMPLE_KEYWORDS.some(k => low.includes(k))) return 1;
  if (COMPLEX_KEYWORDS.some(k => low.includes(k))) return priority === 'critical' ? 5 : 4;
  if (priority === 'critical') return 4;
  if (priority === 'high') return 3;
  if (priority === 'low') return 2;
  return 3; // medium default
}

// ── Record completion + check level ───────────────────────────────────────────
export function recordCompletion({ agentId, taskId, score, complexity }) {
  const data = load();
  if (!data[agentId]) data[agentId] = { level: 3, scores: [], tasksAtLevel: 0, totalTasks: 0 };

  const agent = data[agentId];
  if (score !== undefined) {
    agent.scores.push(score);
    if (agent.scores.length > 20) agent.scores.shift();
  }
  agent.tasksAtLevel++;
  agent.totalTasks++;

  const avgScore = agent.scores.length > 0 ? agent.scores.reduce((s, v) => s + v, 0) / agent.scores.length : 7;
  const levelCfg = LEVELS[agent.level] || LEVELS[3];
  const prevLevel = agent.level;
  let action = 'none';

  // Level up
  if (agent.level < 5 && avgScore >= levelCfg.upgradeAvg && agent.tasksAtLevel >= levelCfg.threshold) {
    agent.level = Math.min(5, agent.level + 1);
    agent.tasksAtLevel = 0;
    action = 'level_up';
    console.log(`[Curriculum] 🎓 ${agentId} leveled UP: ${LEVELS[prevLevel].name} → ${LEVELS[agent.level].name} (avg=${Math.round(avgScore*10)/10})`);
  }
  // Level down
  else if (agent.level > 1 && avgScore < 5.0 && agent.tasksAtLevel >= 5) {
    agent.level = Math.max(1, agent.level - 1);
    agent.tasksAtLevel = 0;
    action = 'level_down';
    console.warn(`[Curriculum] ⬇️  ${agentId} leveled DOWN: ${LEVELS[prevLevel].name} → ${LEVELS[agent.level].name} (avg=${Math.round(avgScore*10)/10})`);
  }

  save(data);
  const entry = { ts: Date.now(), agentId, taskId, score, complexity, level: agent.level, action, avgScore: Math.round(avgScore * 10) / 10 };
  fs.appendFileSync(CURR_LOG, JSON.stringify(entry) + '\n');
  return { level: agent.level, levelName: LEVELS[agent.level].name, action, avgScore: Math.round(avgScore * 10) / 10 };
}

// ── Get agent curriculum state ────────────────────────────────────────────────
export function getAgentCurriculum(agentId) {
  const data = load();
  const agent = data[agentId] || { level: 3, scores: [], tasksAtLevel: 0, totalTasks: 0 };
  const levelCfg = LEVELS[agent.level] || LEVELS[3];
  const avgScore = agent.scores.length > 0 ? Math.round(agent.scores.reduce((s, v) => s + v, 0) / agent.scores.length * 10) / 10 : null;
  const toNextLevel = agent.level < 5 ? Math.max(0, levelCfg.threshold - agent.tasksAtLevel) : 0;

  return {
    agentId, level: agent.level, levelName: levelCfg.name,
    maxComplexity: levelCfg.maxComplexity, maxConcurrent: levelCfg.maxConcurrent,
    avgScore, tasksAtLevel: agent.tasksAtLevel, totalTasks: agent.totalTasks,
    toNextLevel, nextLevel: agent.level < 5 ? LEVELS[agent.level + 1]?.name : 'MAX',
    curriculumBlock: `[CURRICULUM] Level: ${levelCfg.name} (${agent.level}/5) | Avg quality: ${avgScore || '?'}/10 | ${toNextLevel > 0 ? `${toNextLevel} more tasks to level up` : 'Ready to advance'}`,
  };
}

export function getAllCurriculum() {
  const data = load();
  return Object.fromEntries(AGENTS.map(a => {
    const d = data[a] || { level: 3 };
    return [a, { level: d.level, name: LEVELS[d.level]?.name || 'COMPETENT', tasks: d.totalTasks || 0 }];
  }));
}
