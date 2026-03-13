/**
 * knowledge-distiller.mjs — Teacher→Student Knowledge Distillation
 *
 * Video: "jina-embeddings-v5: Task-Targeted Embedding Distillation (Feb 2026)" (uWsKSHqMXnA)
 * Pattern: Larger/premium agents (forge, atlas) distill compressed knowledge
 *          to smaller/cheaper agents (dana, marat, pixel) — close performance gap
 *
 * Distillation mechanism:
 *   Teacher agents (forge, atlas) accumulate high-quality task results (score ≥8)
 *   These become "distilled tips" — compressed insights injected into student dispatches
 *   Student agents gradually improve without increasing their model tier
 *
 * Teacher → Student mapping:
 *   forge  → [bekzat, nurlan, iron]      (coding/infra patterns)
 *   atlas  → [dana, mesa]                (planning/analysis patterns)
 *   bekzat → [marat, ainura]             (backend/review patterns)
 *   iron   → [nurlan]                    (infra/security patterns)
 *
 * Distillation types:
 *   PATTERN    — "When implementing auth, always include refresh token rotation"
 *   ANTI_PATTERN — "Never hardcode credentials; always use env vars"
 *   HEURISTIC  — "Tasks >300 tokens typically need decomposition"
 *   SHORTCUT   — "For ORGON auth tasks, start with /src/auth/middleware.ts"
 *
 * Injection:
 *   Student dispatch gets [DISTILLED KNOWLEDGE] block with top-3 relevant tips
 *
 * API:
 *   POST /api/distill/teach    { teacherAgent, content, score, taskType } → store distilled tip
 *   POST /api/distill/inject   { studentAgent, taskTitle } → get relevant tips to inject
 *   GET  /api/distill/tips     { agent? } → view teacher's tip library
 *   GET  /api/distill/map      → teacher-student mapping
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME        = os.homedir();
const DISTILL_FILE = path.join(HOME, '.openclaw/workspace/.distilled-tips.json');
const DISTILL_LOG  = path.join(HOME, '.openclaw/workspace/distill-log.jsonl');

// ── Teacher → Student mapping ──────────────────────────────────────────────────
const TEACHER_MAP = {
  forge:   ['bekzat', 'nurlan', 'iron', 'dana'],
  atlas:   ['dana', 'mesa', 'marat'],
  bekzat:  ['marat', 'ainura', 'nurlan'],
  iron:    ['nurlan'],
  ainura:  ['pixel'],
};

// Reverse: who teaches each student
const STUDENT_TEACHERS = {};
for (const [teacher, students] of Object.entries(TEACHER_MAP)) {
  for (const s of students) {
    if (!STUDENT_TEACHERS[s]) STUDENT_TEACHERS[s] = [];
    STUDENT_TEACHERS[s].push(teacher);
  }
}

// ── Load/save ──────────────────────────────────────────────────────────────────
function load() { try { return JSON.parse(fs.readFileSync(DISTILL_FILE, 'utf8')); } catch { return {}; } }
function save(d) { try { fs.writeFileSync(DISTILL_FILE, JSON.stringify(d, null, 2)); } catch {} }

// ── Classify distillation type from content ────────────────────────────────────
function classifyTipType(content = '') {
  const low = content.toLowerCase();
  if (/never|avoid|don't|do not|always use/.test(low))       return 'ANTI_PATTERN';
  if (/start with|begin with|first step|shortcut/.test(low)) return 'SHORTCUT';
  if (/typically|usually|pattern|when.*always/.test(low))    return 'PATTERN';
  return 'HEURISTIC';
}

// ── Keyword extraction (simple BoW) ────────────────────────────────────────────
function extractKeywords(text = '') {
  const stopwords = new Set(['the', 'and', 'for', 'are', 'with', 'that', 'this', 'from', 'not', 'have', 'will', 'been', 'has', 'its', 'they', 'into', 'also', 'can', 'all']);
  return text.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !stopwords.has(w)).slice(0, 10);
}

// ── Store distilled tip ────────────────────────────────────────────────────────
export function teachTip({ teacherAgent, content, score = 8, taskType = 'general', title = '' }) {
  if (!TEACHER_MAP[teacherAgent]) return { ok: false, reason: `${teacherAgent} is not a teacher agent` };
  if (score < 8) return { ok: false, reason: `Score ${score} < 8 — only high-quality tips distilled` };

  const data = load();
  if (!data[teacherAgent]) data[teacherAgent] = [];

  const tip = {
    id:       `tip_${Date.now()}`,
    ts:       Date.now(),
    teacher:  teacherAgent,
    content:  content.slice(0, 300),
    score,
    taskType,
    title:    title.slice(0, 60),
    tipType:  classifyTipType(content),
    keywords: extractKeywords(content + ' ' + title),
    students: TEACHER_MAP[teacherAgent],
    usageCount: 0,
  };

  data[teacherAgent].push(tip);
  if (data[teacherAgent].length > 100) data[teacherAgent] = data[teacherAgent].slice(-100);
  save(data);

  const entry = { ts: Date.now(), teacherAgent, tipType: tip.tipType, score, students: tip.students };
  fs.appendFileSync(DISTILL_LOG, JSON.stringify(entry) + '\n');
  console.log(`[Distiller] 📚 ${teacherAgent} → ${tip.tipType} tip distilled for ${tip.students.join('/')} (score ${score})`);
  return { ok: true, tip };
}

// ── Inject tips into student dispatch ─────────────────────────────────────────
export function injectDistilledKnowledge(studentAgent, taskTitle = '') {
  const teachers = STUDENT_TEACHERS[studentAgent] || [];
  if (teachers.length === 0) return null;

  const data = load();
  const qKeywords = extractKeywords(taskTitle);
  const candidates = [];

  for (const teacher of teachers) {
    const tips = data[teacher] || [];
    for (const tip of tips) {
      const overlap = tip.keywords.filter(k => qKeywords.includes(k)).length;
      if (overlap > 0 || qKeywords.length === 0) {
        candidates.push({ ...tip, relevanceScore: overlap / Math.max(qKeywords.length, 1) });
      }
    }
  }

  if (candidates.length === 0) return null;

  // Top 3 most relevant
  const topTips = candidates.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, 3);

  // Increment usage
  const data2 = load();
  for (const tip of topTips) {
    const teacher = tip.teacher;
    if (data2[teacher]) {
      const found = data2[teacher].find(t => t.id === tip.id);
      if (found) found.usageCount = (found.usageCount || 0) + 1;
    }
  }
  save(data2);

  const block = `[DISTILLED KNOWLEDGE from ${teachers.join('/')}]\n` +
    topTips.map((t, i) => `${i + 1}. [${t.tipType}] ${t.content}`).join('\n');

  return { block, tipCount: topTips.length, teachers, tips: topTips.map(t => ({ id: t.id, tipType: t.tipType, content: t.content.slice(0, 80) })) };
}

export function getTips(agentId = null) {
  const data = load();
  if (agentId) return data[agentId] || [];
  return data;
}

export function getTeacherMap() {
  return { teacherMap: TEACHER_MAP, studentTeachers: STUDENT_TEACHERS };
}
