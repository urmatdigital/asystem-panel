/**
 * plan-validator.mjs — Pre-Execution Plan Validation (Clean Data / Prevent Drift)
 *
 * Video: "Trustworthy AI Agents Start With Clean Data: How to Prevent Drift
 *         in Agentic Automation" (hJ0GkI9iT44)
 * Pattern: Before ANY multi-step plan executes → run an internal audit loop:
 *   "Does this plan make sense? Will it cause harm? Does it match the goal?"
 *   Catch mistakes in the planning phase, not after expensive execution.
 *
 * Validation checks (7 gates):
 *   1. GOAL_ALIGNMENT    — do all steps actually serve the stated goal?
 *   2. STEP_COMPLETENESS — are required phases present? (plan/impl/test/review)
 *   3. AGENT_COVERAGE    — is every step assigned to a capable agent?
 *   4. DEPENDENCY_ORDER  — are step dependencies topologically valid?
 *   5. BLAST_RADIUS      — does any step touch forbidden/dangerous resources?
 *   6. RESOURCE_ESTIMATE — is token/time estimate within budget?
 *   7. ROLLBACK_PATH     — does the plan have a rollback for risky steps?
 *
 * Decision:
 *   ALL pass:      PROCEED — execute immediately
 *   1-2 warnings:  PROCEED_WITH_CAUTION — execute with monitoring
 *   ≥3 warnings:   REVIEW_FIRST — surface issues to Урмат before running
 *   ANY critical:  HALT — do not execute, require human approval
 *
 * API:
 *   POST /api/planval/validate  { goal, steps: [{id, title, agent, deps?, risky?}] }
 *   POST /api/planval/fix       { goal, steps, issues } → suggest fixes for failures
 *   GET  /api/planval/history   → last 20 validation results
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME     = os.homedir();
const VAL_LOG  = path.join(HOME, '.openclaw/workspace/planval-log.jsonl');

// ── Agent capabilities (for AGENT_COVERAGE check) ────────────────────────────
const AGENT_CAPS = {
  forge:  ['plan', 'implement', 'review', 'deploy', 'security', 'any'],
  atlas:  ['plan', 'architect', 'review', 'strategy', 'any'],
  bekzat: ['implement', 'backend', 'api', 'database', 'test'],
  ainura: ['implement', 'frontend', 'ui', 'css', 'test'],
  marat:  ['test', 'qa', 'review', 'validate'],
  nurlan: ['deploy', 'devops', 'infrastructure', 'ci'],
  dana:   ['plan', 'manage', 'coordinate', 'review'],
  mesa:   ['analyze', 'research', 'report', 'review'],
  iron:   ['security', 'audit', 'review', 'monitor'],
  pixel:  ['design', 'ui', 'ux', 'review'],
};

// ── Required phases for a complete plan ───────────────────────────────────────
const REQUIRED_PHASES = ['plan', 'implement', 'test'];
const RISKY_KEYWORDS  = ['delete', 'drop', 'truncate', 'rm ', 'purge', 'wipe', 'production', 'prod', 'migrate'];

// ── Validate a plan ───────────────────────────────────────────────────────────
export function validatePlan({ goal = '', steps = [] }) {
  const issues   = [];
  const warnings = [];
  const passes   = [];

  // ── 1. GOAL_ALIGNMENT ─────────────────────────────────────────────────────
  const goalWords = new Set(goal.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const stepText  = steps.map(s => s.title.toLowerCase()).join(' ');
  const overlap   = [...goalWords].filter(w => stepText.includes(w)).length;
  const alignPct  = goalWords.size > 0 ? overlap / goalWords.size : 0;
  if (alignPct < 0.2 && goalWords.size > 2) {
    issues.push({ check: 'GOAL_ALIGNMENT', severity: 'warning', msg: `Plan steps share only ${Math.round(alignPct * 100)}% vocabulary with goal. Steps may not serve the stated goal.` });
  } else {
    passes.push({ check: 'GOAL_ALIGNMENT', msg: `${Math.round(alignPct * 100)}% alignment with goal` });
  }

  // ── 2. STEP_COMPLETENESS ──────────────────────────────────────────────────
  const stepTitles = steps.map(s => s.title.toLowerCase()).join(' ');
  const missingPhases = REQUIRED_PHASES.filter(p => !stepTitles.includes(p));
  if (missingPhases.length > 0) {
    warnings.push({ check: 'STEP_COMPLETENESS', severity: 'warning', msg: `Missing phases: ${missingPhases.join(', ')}. A complete plan should include: plan → implement → test` });
  } else {
    passes.push({ check: 'STEP_COMPLETENESS', msg: 'All required phases present' });
  }

  // ── 3. AGENT_COVERAGE ────────────────────────────────────────────────────
  const uncovered = steps.filter(s => {
    if (!s.agent) return true;
    const caps = AGENT_CAPS[s.agent] || [];
    if (caps.includes('any')) return false;
    const stepWords = s.title.toLowerCase().split(/\W+/);
    return !caps.some(c => stepWords.some(w => w.includes(c) || c.includes(w)));
  });
  if (uncovered.length > 0) {
    warnings.push({ check: 'AGENT_COVERAGE', severity: 'warning', msg: `${uncovered.length} step(s) may be misassigned: ${uncovered.map(s => `"${s.title}" → ${s.agent || 'unassigned'}`).join('; ')}` });
  } else {
    passes.push({ check: 'AGENT_COVERAGE', msg: `All ${steps.length} steps have capable agents` });
  }

  // ── 4. DEPENDENCY_ORDER ───────────────────────────────────────────────────
  const stepIds = new Set(steps.map(s => s.id));
  const badDeps = [];
  for (const step of steps) {
    const unknownDeps = (step.deps || []).filter(d => !stepIds.has(d));
    if (unknownDeps.length > 0) badDeps.push({ step: step.id, unknownDeps });
  }
  if (badDeps.length > 0) {
    issues.push({ check: 'DEPENDENCY_ORDER', severity: 'critical', msg: `Unknown dependencies: ${JSON.stringify(badDeps)}` });
  } else {
    // Simple cycle check: topoSort
    try {
      topoSort(steps);
      passes.push({ check: 'DEPENDENCY_ORDER', msg: 'No cycles, topological order valid' });
    } catch (e) {
      issues.push({ check: 'DEPENDENCY_ORDER', severity: 'critical', msg: e.message });
    }
  }

  // ── 5. BLAST_RADIUS ───────────────────────────────────────────────────────
  const riskySteps = steps.filter(s => RISKY_KEYWORDS.some(k => s.title.toLowerCase().includes(k)));
  const riskyWithoutRollback = riskySteps.filter(s => !s.rollback && !s.risky);
  if (riskyWithoutRollback.length > 0) {
    issues.push({ check: 'BLAST_RADIUS', severity: 'critical', msg: `${riskyWithoutRollback.length} risky step(s) lack rollback plans: ${riskyWithoutRollback.map(s => `"${s.title}"`).join(', ')}` });
  } else if (riskySteps.length > 0) {
    warnings.push({ check: 'BLAST_RADIUS', severity: 'warning', msg: `${riskySteps.length} risky step(s) present but marked with rollback ✅` });
  } else {
    passes.push({ check: 'BLAST_RADIUS', msg: 'No destructive operations detected' });
  }

  // ── 6. RESOURCE_ESTIMATE ─────────────────────────────────────────────────
  const estimatedTokens = steps.length * 3000; // avg 3K tokens per step
  if (estimatedTokens > 50000) {
    warnings.push({ check: 'RESOURCE_ESTIMATE', severity: 'warning', msg: `Estimated ${estimatedTokens.toLocaleString()} tokens for ${steps.length} steps. Consider batching or decomposing.` });
  } else {
    passes.push({ check: 'RESOURCE_ESTIMATE', msg: `~${estimatedTokens.toLocaleString()} tokens estimated — within budget` });
  }

  // ── 7. ROLLBACK_PATH ─────────────────────────────────────────────────────
  const hasRiskyOps = riskySteps.length > 0;
  const hasAnyRollback = steps.some(s => s.rollback);
  if (hasRiskyOps && !hasAnyRollback) {
    warnings.push({ check: 'ROLLBACK_PATH', severity: 'warning', msg: 'Plan contains risky operations but no rollback steps defined' });
  } else {
    passes.push({ check: 'ROLLBACK_PATH', msg: hasAnyRollback ? 'Rollback steps present' : 'No risky ops — rollback not needed' });
  }

  // ── Decision ─────────────────────────────────────────────────────────────
  const criticals = issues.filter(i => i.severity === 'critical');
  const totalWarnings = warnings.length + issues.filter(i => i.severity === 'warning').length;
  let decision, emoji;
  if (criticals.length > 0)    { decision = 'HALT';                  emoji = '🛑'; }
  else if (totalWarnings >= 3) { decision = 'REVIEW_FIRST';          emoji = '⚠️'; }
  else if (totalWarnings > 0)  { decision = 'PROCEED_WITH_CAUTION';  emoji = '🟡'; }
  else                         { decision = 'PROCEED';               emoji = '✅'; }

  const result = { ok: true, decision, emoji, goal: goal.slice(0, 60), steps: steps.length, passes: passes.length, warnings: warnings.length, criticals: criticals.length, issues: [...issues, ...warnings], passes };
  fs.appendFileSync(VAL_LOG, JSON.stringify({ ts: Date.now(), decision, steps: steps.length, criticals: criticals.length, warnings: warnings.length }) + '\n');
  console.log(`[PlanVal] ${emoji} ${decision}: ${steps.length} steps, ${passes.length} pass, ${warnings.length} warn, ${criticals.length} crit`);
  return result;
}

// ── Suggest fixes for issues ──────────────────────────────────────────────────
export function fixPlan({ goal, steps, issues = [] }) {
  const fixes = [];
  for (const issue of issues) {
    if (issue.check === 'STEP_COMPLETENESS')  fixes.push({ for: issue.check, suggestion: 'Add a "test and verify" step after implementation' });
    if (issue.check === 'AGENT_COVERAGE')     fixes.push({ for: issue.check, suggestion: 'Reassign mismatched steps: plan→atlas/dana, backend→bekzat, test→marat, deploy→nurlan' });
    if (issue.check === 'BLAST_RADIUS')       fixes.push({ for: issue.check, suggestion: 'Add rollback field to risky steps: { id, title, rollback: "restore from backup" }' });
    if (issue.check === 'DEPENDENCY_ORDER')   fixes.push({ for: issue.check, suggestion: 'Remove circular dependencies or unknown step IDs from deps arrays' });
    if (issue.check === 'RESOURCE_ESTIMATE')  fixes.push({ for: issue.check, suggestion: 'Use task-batcher.mjs to merge similar steps or decompose into smaller sub-plans' });
  }
  return { ok: true, fixCount: fixes.length, fixes };
}

export function getHistory(limit = 20) {
  try { return fs.readFileSync(VAL_LOG, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map(l => JSON.parse(l)).reverse(); }
  catch { return []; }
}

function topoSort(steps) {
  const graph = new Map(steps.map(s => [s.id, new Set(s.deps || [])]));
  const sorted = [], visited = new Set(), temp = new Set();
  function visit(id) {
    if (temp.has(id)) throw new Error(`Cycle detected at step: ${id}`);
    if (!visited.has(id)) { temp.add(id); for (const dep of graph.get(id) || []) visit(dep); temp.delete(id); visited.add(id); sorted.push(id); }
  }
  for (const id of graph.keys()) visit(id);
  return sorted;
}
