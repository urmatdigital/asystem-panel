/**
 * 🌿 Task Decomposer — Fractals Pattern for ASYSTEM
 * Inspired by: TinyAGI/fractals — recursive agentic task orchestrator
 *
 * classify(task) →
 *   atomic    → dispatch directly (score ≤ COMPOSITE_THRESHOLD)
 *   composite → decompose() → 2-4 subtasks → dispatch each to right agent
 *
 * Key rules (anti-abuse):
 *   - Max decomposition depth: 1 (no recursive decompose)
 *   - Max subtasks: 4
 *   - Only decompose if score > 70 AND body has multiple distinct steps
 *   - Source tag 'decomposed' is skipped by decomposer (no recursion)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const HOME = os.homedir();

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const COMPOSITE_THRESHOLD = 70;  // complexity score above this → try decompose
const MAX_SUBTASKS = 4;

// ASYSTEM agent routing (keyword → agent)
const AGENT_KEYWORDS = {
  bekzat:  ['backend', 'api', 'database', 'db', 'postgresql', 'migration', 'nestjs', 'fastapi', 'server', 'endpoint'],
  ainura:  ['frontend', 'ui', 'ux', 'react', 'vue', 'css', 'mobile', 'pwa', 'design', 'component'],
  marat:   ['test', 'qa', 'quality', 'e2e', 'cypress', 'jest', 'bug', 'regression', 'coverage'],
  nurlan:  ['devops', 'ci', 'cd', 'docker', 'deploy', 'pipeline', 'nginx', 'infra', 'proxmox', 'kubernetes'],
  mesa:    ['analytics', 'data', 'simulation', 'report', 'metrics', 'chart', 'analysis', 'statistics'],
  iron:    ['security', 'firewall', 'ssl', 'hardening', 'audit', 'pentest', 'auth'],
  atlas:   ['architecture', 'strategy', 'planning', 'system design', 'review', 'decision'],
  pixel:   ['design', 'figma', 'wireframe', 'visual', 'brand', 'icon', 'color'],
};

function routeSubtask(subtaskTitle) {
  const lower = subtaskTitle.toLowerCase();
  for (const [agent, keywords] of Object.entries(AGENT_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return agent;
  }
  return 'forge'; // default
}

// ─────────────────────────────────────────────────────────────────────────────
// Classify: atomic vs composite
// ─────────────────────────────────────────────────────────────────────────────

export function classifyTask({ title = '', body = '', score = 0 }) {
  if (score <= COMPOSITE_THRESHOLD) return 'atomic';

  // Multi-step signals in body
  const steps = body.match(/\n\s*\d+\./g)?.length || 0;        // numbered list
  const bullets = body.match(/\n\s*[-*•]/g)?.length || 0;       // bullet list
  const sections = body.match(/\n#+\s/g)?.length || 0;          // markdown headers
  const andCount = (title.match(/\band\b/gi) || []).length;     // "X and Y and Z"

  const multipleSignals = steps + bullets + sections + andCount;
  return multipleSignals >= 2 ? 'composite' : 'atomic';
}

// ─────────────────────────────────────────────────────────────────────────────
// Decompose: call LLM to split into subtasks
// ─────────────────────────────────────────────────────────────────────────────

const DECOMPOSE_PROMPT = `You are a task decomposer for an AI agent system.
Split this task into 2-4 independent, atomic subtasks that can run in parallel.

Rules:
- Each subtask must be truly independent (no shared state)
- Each subtask should take 10-30 minutes for an AI agent
- Use domain keywords so we can route to the right specialist:
  bekzat=backend/api/db, ainura=frontend/ui/react, marat=tests/qa,
  nurlan=devops/docker/deploy, mesa=analytics/data, iron=security/infra,
  atlas=architecture/strategy, pixel=design/figma
- If task CANNOT be split (already atomic), return subtasks: []

Task title: {TITLE}
Task body: {BODY}

Respond ONLY with valid JSON:
{
  "can_decompose": true|false,
  "reason": "one sentence why",
  "subtasks": [
    {"title": "...", "body": "...", "priority": "high|medium|low"},
    ...
  ]
}`;

export async function decomposeTask({ title, body, parentTaskId, priority = 'medium' }) {
  const prompt = DECOMPOSE_PROMPT
    .replace('{TITLE}', title.slice(0, 200))
    .replace('{BODY}', (body || '').slice(0, 600));

  const pyPath = path.join(HOME, '.zvec-env/bin/python3');
  const pyScript = `
import os, json
from openai import OpenAI
client = OpenAI(api_key=os.environ.get('OPENAI_API_KEY',''))
resp = client.chat.completions.create(
    model='gpt-4o-mini',
    messages=[{'role':'user','content':${JSON.stringify(prompt)}}],
    temperature=0,
    max_tokens=600,
)
print(resp.choices[0].message.content.strip())
`;

  const { stdout } = await execFileAsync(pyPath, ['-c', pyScript], {
    env: process.env,
    timeout: 20000,
  });

  const match = stdout.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Bad decompose response: ${stdout.slice(0, 100)}`);
  const parsed = JSON.parse(match[0]);

  if (!parsed.can_decompose || !parsed.subtasks?.length) {
    return { decomposed: false, reason: parsed.reason || 'task is atomic', subtasks: [] };
  }

  // Limit subtasks + add routing
  const subtasks = parsed.subtasks.slice(0, MAX_SUBTASKS).map((st, i) => ({
    title: st.title,
    body: `${st.body || ''}\n\n[Parent task: ${title}] [Subtask ${i + 1}/${Math.min(parsed.subtasks.length, MAX_SUBTASKS)}]`,
    to: routeSubtask(st.title),
    priority: st.priority || priority,
    tags: ['decomposed', `parent:${parentTaskId || 'none'}`],
    source: 'fractals-decomposer',
  }));

  return { decomposed: true, reason: parsed.reason, subtasks };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────
const _stats = { classified: 0, atomic: 0, composite: 0, decomposed: 0, subtasksCreated: 0 };

export function recordClassification(type) {
  _stats.classified++;
  _stats[type]++;
}
export function recordDecomposition(subtaskCount) {
  _stats.decomposed++;
  _stats.subtasksCreated += subtaskCount;
}
export function getDecomposerStats() {
  return {
    ..._stats,
    compositeRate: _stats.classified ? +(_stats.composite / _stats.classified).toFixed(3) : 0,
    decomposedRate: _stats.composite ? +(_stats.decomposed / _stats.composite).toFixed(3) : 0,
    avgSubtasks: _stats.decomposed ? +(_stats.subtasksCreated / _stats.decomposed).toFixed(1) : 0,
  };
}
