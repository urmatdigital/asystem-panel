/**
 * goal-decomposer.mjs — Autonomous Goal → Subgoal Decomposition
 *
 * Video: "Agentic AI is not LLMs + tools." (01avEiOONf0)
 * Pattern: True agentic system doesn't execute ONE prompt for ONE task.
 *   It takes a HIGH-LEVEL GOAL → decomposes autonomously:
 *     Goal → Subgoals → Steps → Checkpoints → Execution Order → Re-plan on failure
 *
 * Decomposition algorithm:
 *   1. Parse goal intent (verb + domain + constraints)
 *   2. Match against goal templates (SHIP_FEATURE, SECURITY_AUDIT, ONBOARD, etc.)
 *   3. Generate subgoals with dependencies
 *   4. Assign each subgoal to best-fit agent
 *   5. Return executable plan with DAG order
 *
 * Goal templates:
 *   SHIP_FEATURE:     plan → design → implement → test → review → deploy → monitor
 *   SECURITY_AUDIT:   discover → analyze → report → remediate → verify
 *   ONBOARD_AGENT:    configure → deploy → test → integrate → document
 *   PERFORMANCE_FIX:  profile → identify → implement → benchmark → deploy
 *   DATA_MIGRATION:   schema → backup → migrate → validate → cutover
 *   BUG_FIX:          reproduce → diagnose → fix → test → deploy
 *   RESEARCH_SPIKE:   gather → analyze → prototype → document → present
 *
 * Re-planning:
 *   If subgoal fails → check if blocking or non-blocking
 *   Blocking fail → pause dependent subgoals → alert forge/atlas
 *   Non-blocking → log → continue → fix later
 *
 * API:
 *   POST /api/goal/decompose { goal, context?, priority?, deadline? }
 *   GET  /api/goal/:planId   → plan status + subgoal progress
 *   POST /api/goal/complete  { planId, subgoalId, result, success }
 *   GET  /api/goal/active    → all active plans
 *   POST /api/goal/replan    { planId, subgoalId, reason } → re-plan after failure
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const GOALS_DIR = path.join(HOME, '.openclaw/workspace/.goal-plans');
const GOALS_LOG = path.join(HOME, '.openclaw/workspace/goal-log.jsonl');

if (!fs.existsSync(GOALS_DIR)) fs.mkdirSync(GOALS_DIR, { recursive: true });

// ── Agent skill map ────────────────────────────────────────────────────────────
const AGENT_SKILLS = {
  forge:  ['orchestrate', 'architecture', 'deploy', 'monitor', 'review'],
  atlas:  ['plan', 'design', 'review', 'present', 'approve'],
  bekzat: ['implement', 'fix', 'configure', 'migrate', 'benchmark'],
  ainura: ['implement', 'design', 'prototype', 'document'],
  marat:  ['test', 'verify', 'diagnose', 'reproduce', 'validate'],
  nurlan: ['deploy', 'configure', 'backup', 'cutover', 'monitor'],
  dana:   ['plan', 'document', 'present', 'onboard'],
  mesa:   ['analyze', 'profile', 'gather', 'research'],
  iron:   ['discover', 'analyze', 'remediate', 'security', 'audit'],
  pixel:  ['design', 'prototype', 'document'],
};

// ── Goal templates ────────────────────────────────────────────────────────────
const GOAL_TEMPLATES = {
  SHIP_FEATURE: {
    subgoals: [
      { id: 'plan',      verb: 'plan',      desc: 'Define requirements and approach',   deps: [],         blocking: true },
      { id: 'design',    verb: 'design',    desc: 'Architecture and API design',         deps: ['plan'],   blocking: true },
      { id: 'implement', verb: 'implement', desc: 'Write code and unit tests',           deps: ['design'], blocking: true },
      { id: 'test',      verb: 'test',      desc: 'QA testing and integration tests',    deps: ['implement'], blocking: true },
      { id: 'review',    verb: 'review',    desc: 'Code review and approval',            deps: ['test'],   blocking: true },
      { id: 'deploy',    verb: 'deploy',    desc: 'Deploy to production',                deps: ['review'], blocking: true },
      { id: 'monitor',   verb: 'monitor',   desc: 'Monitor for errors post-deploy',      deps: ['deploy'], blocking: false },
    ],
  },
  SECURITY_AUDIT: {
    subgoals: [
      { id: 'discover',  verb: 'discover',  desc: 'Discover attack surface',             deps: [],                   blocking: true },
      { id: 'analyze',   verb: 'analyze',   desc: 'Analyze vulnerabilities',             deps: ['discover'],         blocking: true },
      { id: 'report',    verb: 'report',    desc: 'Generate security report',            deps: ['analyze'],          blocking: true },
      { id: 'remediate', verb: 'remediate', desc: 'Fix identified vulnerabilities',      deps: ['report'],           blocking: true },
      { id: 'verify',    verb: 'verify',    desc: 'Verify fixes in staging',             deps: ['remediate'],        blocking: true },
    ],
  },
  BUG_FIX: {
    subgoals: [
      { id: 'reproduce', verb: 'reproduce', desc: 'Reproduce the bug reliably',          deps: [],                   blocking: true },
      { id: 'diagnose',  verb: 'diagnose',  desc: 'Root cause analysis',                 deps: ['reproduce'],        blocking: true },
      { id: 'fix',       verb: 'implement', desc: 'Implement the fix',                   deps: ['diagnose'],         blocking: true },
      { id: 'test',      verb: 'test',      desc: 'Test fix and regression suite',       deps: ['fix'],              blocking: true },
      { id: 'deploy',    verb: 'deploy',    desc: 'Deploy fix to production',            deps: ['test'],             blocking: true },
    ],
  },
  PERFORMANCE_FIX: {
    subgoals: [
      { id: 'profile',   verb: 'profile',   desc: 'Profile to find bottlenecks',         deps: [],                   blocking: true },
      { id: 'identify',  verb: 'analyze',   desc: 'Identify top optimization targets',   deps: ['profile'],          blocking: true },
      { id: 'implement', verb: 'implement', desc: 'Implement optimizations',             deps: ['identify'],         blocking: true },
      { id: 'benchmark', verb: 'benchmark', desc: 'Benchmark before vs after',           deps: ['implement'],        blocking: true },
      { id: 'deploy',    verb: 'deploy',    desc: 'Deploy optimizations',                deps: ['benchmark'],        blocking: true },
    ],
  },
  RESEARCH_SPIKE: {
    subgoals: [
      { id: 'gather',    verb: 'gather',    desc: 'Gather information and resources',    deps: [],                   blocking: false },
      { id: 'analyze',   verb: 'analyze',   desc: 'Analyze findings',                    deps: ['gather'],           blocking: true },
      { id: 'prototype', verb: 'prototype', desc: 'Build proof of concept',              deps: ['analyze'],          blocking: false },
      { id: 'document',  verb: 'document',  desc: 'Document findings and recommendations', deps: ['analyze'],        blocking: true },
      { id: 'present',   verb: 'present',   desc: 'Present findings to team',            deps: ['document'],         blocking: false },
    ],
  },
};

// ── Detect goal template from goal text ───────────────────────────────────────
function detectTemplate(goal = '') {
  const low = goal.toLowerCase();
  if (/\b(ship|launch|release|build|create|add feature)\b/.test(low)) return 'SHIP_FEATURE';
  if (/\b(security|audit|pentest|vulnerability|CVE)\b/.test(low))      return 'SECURITY_AUDIT';
  if (/\b(bug|fix|broken|crash|error|regression)\b/.test(low))         return 'BUG_FIX';
  if (/\b(slow|performance|latency|optimize|bottleneck)\b/.test(low))  return 'PERFORMANCE_FIX';
  if (/\b(research|spike|investigate|explore|POC|prototype)\b/.test(low)) return 'RESEARCH_SPIKE';
  return 'SHIP_FEATURE'; // default
}

// ── Assign best agent to subgoal verb ─────────────────────────────────────────
function assignAgent(verb) {
  for (const [agent, skills] of Object.entries(AGENT_SKILLS)) {
    if (skills.includes(verb)) return agent;
  }
  return 'forge';
}

// ── Decompose a goal ──────────────────────────────────────────────────────────
export function decomposeGoal({ goal, context = '', priority = 'medium', deadline = null }) {
  const template = detectTemplate(goal);
  const tmpl     = GOAL_TEMPLATES[template];
  const planId   = `plan_${Date.now()}`;

  const subgoals = tmpl.subgoals.map(sg => ({
    ...sg,
    planId,
    title: `${sg.desc} — ${goal.slice(0, 30)}`,
    assignedTo: assignAgent(sg.verb),
    status: 'pending',
    result: null,
    startedAt: null,
    completedAt: null,
  }));

  // Find execution order (topoSort)
  const order = topoSort(subgoals);

  const plan = {
    planId, goal, context, priority, deadline, template,
    status: 'active', createdAt: Date.now(),
    subgoals, executionOrder: order,
    completedCount: 0, totalCount: subgoals.length,
  };

  fs.writeFileSync(path.join(GOALS_DIR, `${planId}.json`), JSON.stringify(plan, null, 2));
  fs.appendFileSync(GOALS_LOG, JSON.stringify({ ts: Date.now(), action: 'decompose', planId, goal: goal.slice(0, 50), template, subgoalCount: subgoals.length }) + '\n');

  console.log(`[GoalDecomposer] 🎯 Goal "${goal.slice(0, 40)}" → template=${template}, ${subgoals.length} subgoals`);
  subgoals.forEach(sg => console.log(`  [${sg.id}] ${sg.title.slice(0, 40)} → ${sg.assignedTo} (deps: [${sg.deps.join(',')}])`));

  return { ok: true, planId, goal, template, subgoalCount: subgoals.length, subgoals: subgoals.map(sg => ({ id: sg.id, title: sg.desc, assignedTo: sg.assignedTo, deps: sg.deps })), executionOrder: order, nextUp: order.filter(id => subgoals.find(sg => sg.id === id && sg.deps.length === 0)) };
}

// ── Topological sort for execution order ─────────────────────────────────────
function topoSort(subgoals) {
  const result = [], visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    const sg = subgoals.find(s => s.id === id);
    if (sg) for (const dep of sg.deps) visit(dep);
    visited.add(id); result.push(id);
  };
  for (const sg of subgoals) visit(sg.id);
  return result;
}

// ── Mark subgoal complete ─────────────────────────────────────────────────────
export function completeSubgoal({ planId, subgoalId, result = '', success = true }) {
  const plan = loadPlan(planId);
  if (!plan) return { ok: false, reason: 'Plan not found' };

  const sg = plan.subgoals.find(s => s.id === subgoalId);
  if (!sg) return { ok: false, reason: 'Subgoal not found' };

  sg.status = success ? 'completed' : 'failed';
  sg.result = result;
  sg.completedAt = Date.now();
  plan.completedCount = plan.subgoals.filter(s => s.status === 'completed').length;

  // Unlock next subgoals
  const unlocked = plan.subgoals.filter(s => s.status === 'pending' && s.deps.every(d => plan.subgoals.find(x => x.id === d)?.status === 'completed'));
  for (const u of unlocked) console.log(`[GoalDecomposer] 🔓 Unlocked: [${u.id}] → ${u.assignedTo}`);

  if (plan.completedCount === plan.totalCount) plan.status = 'completed';
  savePlan(plan);

  return { ok: true, planId, subgoalId, success, progress: `${plan.completedCount}/${plan.totalCount}`, unlocked: unlocked.map(u => ({ id: u.id, assignedTo: u.assignedTo })) };
}

export function getPlan(planId) { const p = loadPlan(planId); return p ? { ...p, ok: true } : { ok: false, reason: 'Not found' }; }

export function getActivePlans() {
  try {
    return fs.readdirSync(GOALS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'))
      .map(f => JSON.parse(fs.readFileSync(path.join(GOALS_DIR, f), 'utf8')))
      .filter(p => p.status === 'active')
      .map(p => ({ planId: p.planId, goal: p.goal?.slice(0, 50), template: p.template, progress: `${p.completedCount}/${p.totalCount}` }));
  } catch { return []; }
}

function loadPlan(id) { try { return JSON.parse(fs.readFileSync(path.join(GOALS_DIR, `${id}.json`), 'utf8')); } catch { return null; } }
function savePlan(p) { try { fs.writeFileSync(path.join(GOALS_DIR, `${p.planId}.json`), JSON.stringify(p, null, 2)); } catch {} }
