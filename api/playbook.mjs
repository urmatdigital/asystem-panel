/**
 * playbook.mjs — Workflow Playbooks (Pre-defined multi-step recipes)
 *
 * Pattern: Repeatable workflows triggered by a single command
 *   Instead of dispatching tasks one-by-one, a playbook triggers N steps
 *   automatically in sequence or parallel
 *
 * Built-in playbooks:
 *   deploy-orgon         → [bekzat: build] → [nurlan: deploy] → [marat: smoke-test]
 *   review-sprint        → [dana: sprint review] → [forge: update CONTEXT.md]
 *   security-audit       → [iron: scan] → [bekzat: fix] → [marat: verify]
 *   new-feature          → [dana: spec] → [bekzat: implement] → [ainura: UI] → [marat: test]
 *   incident-response    → [nurlan: investigate] → [iron: contain] → [forge: postmortem]
 *   onboard-agent        → [dana: assign project] → [forge: AGENTS.md update]
 *   weekly-digest        → [mesa: analytics] → [dana: summary] → [forge: publish]
 *
 * Each step: { to, title, body, priority, dependsOn?, parallel? }
 * dependsOn: step index that must complete first (sequential)
 * parallel: true = fire with previous step simultaneously
 *
 * API:
 *   POST /api/playbook/run  { name, params }       — run a playbook
 *   GET  /api/playbook      — list all playbooks
 *   GET  /api/playbook/:run — get run status
 *   POST /api/playbook/define { name, steps[] }    — define custom playbook
 */

import { createHash } from 'node:crypto';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME         = os.homedir();
const RUNS_FILE    = path.join(HOME, '.openclaw/workspace/.playbook-runs.json');
const CUSTOM_FILE  = path.join(HOME, '.openclaw/workspace/.playbook-custom.json');

// ── Built-in playbooks ────────────────────────────────────────────────────────
const BUILT_IN = {
  'deploy-orgon': {
    description: 'Full ORGON deployment: build → deploy → test',
    steps: [
      { to: 'bekzat', title: 'Build ORGON backend for deployment', body: 'Run tests, build FastAPI app, prepare Docker image for production deploy. Project: {project}', priority: 'high', tags: ['deploy', 'automated'] },
      { to: 'nurlan', title: 'Deploy ORGON to production', body: 'Deploy latest build of {project} to production server. Run migrations, restart services, health check.', priority: 'high', tags: ['deploy', 'automated', 'sensitive-ok'], dependsOn: 0 },
      { to: 'marat',  title: 'Smoke test ORGON post-deploy', body: 'Run smoke tests on {project} production: auth endpoints, API health, basic flows.', priority: 'high', tags: ['test', 'automated'], dependsOn: 1 },
    ],
  },
  'review-sprint': {
    description: 'Sprint review: summarize progress + update context',
    steps: [
      { to: 'dana', title: 'Generate sprint review report', body: 'Review completed tasks for sprint. List done/blocked/carry-over. Calculate velocity. Sprint: {sprint}', priority: 'medium', tags: ['sprint', 'automated'] },
      { to: 'forge', title: 'Update ORGON CONTEXT.md after sprint review', body: 'Update CONTEXT.md with sprint {sprint} outcomes, new decisions, architecture changes.', priority: 'medium', tags: ['context', 'automated'], dependsOn: 0 },
    ],
  },
  'security-audit': {
    description: 'Security scan → fix → verify cycle',
    steps: [
      { to: 'iron',   title: 'Security audit: scan {project}', body: 'Run security scan on {project}. Check dependencies, API endpoints, auth flows, SSL certs, exposed secrets.', priority: 'high', tags: ['security', 'automated'] },
      { to: 'bekzat', title: 'Fix security issues in {project}', body: 'Address security findings from audit. Update dependencies, fix vulnerabilities, patch auth weaknesses.', priority: 'high', tags: ['security', 'fix', 'automated'], dependsOn: 0 },
      { to: 'marat',  title: 'Verify security fixes in {project}', body: 'Verify all security issues from audit are fixed. Run security regression tests.', priority: 'high', tags: ['security', 'test', 'automated'], dependsOn: 1 },
    ],
  },
  'new-feature': {
    description: 'Full feature development: spec → implement → UI → test',
    steps: [
      { to: 'dana',   title: 'Write spec for {feature}', body: 'Write technical spec for feature: {feature}. Define API contracts, data models, acceptance criteria.', priority: 'medium', tags: ['spec', 'automated'] },
      { to: 'bekzat', title: 'Implement backend for {feature}', body: 'Implement {feature} backend. Follow spec from dana. FastAPI endpoints, DB schema, business logic.', priority: 'medium', tags: ['backend', 'automated'], dependsOn: 0 },
      { to: 'ainura', title: 'Build UI for {feature}', body: 'Build frontend UI for {feature}. Connect to {feature} API endpoints. Follow design system.', priority: 'medium', tags: ['frontend', 'automated'], dependsOn: 1 },
      { to: 'marat',  title: 'Test {feature} end-to-end', body: 'Write and run tests for {feature}: unit tests, integration tests, E2E user flow.', priority: 'medium', tags: ['test', 'automated'], dependsOn: 2 },
    ],
  },
  'incident-response': {
    description: 'Incident: investigate → contain → postmortem',
    steps: [
      { to: 'nurlan', title: 'INCIDENT: Investigate {incident}', body: 'Investigate incident: {incident}. Check logs, metrics, services. Determine root cause and blast radius.', priority: 'critical', tags: ['incident', 'automated', 'approved'] },
      { to: 'iron',   title: 'INCIDENT: Contain {incident}', body: 'Contain incident: {incident}. Block attack vector, isolate affected services, restore from backup if needed.', priority: 'critical', tags: ['incident', 'security', 'automated', 'approved'], parallel: true },
      { to: 'forge',  title: 'INCIDENT: Postmortem for {incident}', body: 'Write postmortem for incident: {incident}. Timeline, root cause, impact, action items, prevention.', priority: 'high', tags: ['incident', 'postmortem', 'automated'], dependsOn: 0 },
    ],
  },
  'weekly-digest': {
    description: 'Weekly summary: analytics → summary → publish',
    steps: [
      { to: 'mesa',  title: 'Generate weekly analytics digest', body: 'Analyze last 7 days: tasks completed, agent performance, errors, costs, KG growth. Output structured report.', priority: 'low', tags: ['analytics', 'automated'] },
      { to: 'dana',  title: 'Write weekly digest summary', body: 'Write executive summary from analytics data. 5 bullets: achievements, issues, metrics, next week focus.', priority: 'low', tags: ['summary', 'automated'], dependsOn: 0 },
      { to: 'forge', title: 'Post weekly digest to Squad Chat', body: 'Post weekly digest to Convex Squad Chat. Include metrics, achievements, issues from {week} review.', priority: 'low', tags: ['digest', 'automated'], dependsOn: 1 },
    ],
  },
};

// ── Load/save ─────────────────────────────────────────────────────────────────
function loadRuns() { try { return JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8')); } catch { return {}; } }
function saveRuns(r) { try { fs.writeFileSync(RUNS_FILE, JSON.stringify(r, null, 2)); } catch {} }
function loadCustom() { try { return JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8')); } catch { return {}; } }
function saveCustom(c) { try { fs.writeFileSync(CUSTOM_FILE, JSON.stringify(c, null, 2)); } catch {} }

// ── Interpolate params into step text ────────────────────────────────────────
function interp(text, params = {}) {
  return text.replace(/\{(\w+)\}/g, (_, k) => params[k] !== undefined ? params[k] : `{${k}}`);
}

// ── Run a playbook ────────────────────────────────────────────────────────────
export async function runPlaybook(name, params = {}, forgeUrl = 'http://localhost:5190') {
  const all = { ...BUILT_IN, ...loadCustom() };
  const pb = all[name];
  if (!pb) throw new Error(`Playbook not found: ${name}`);

  const runId = `${name}-${createHash('md5').update(`${name}${Date.now()}`).digest('hex').slice(0, 6)}`;
  const runs = loadRuns();
  runs[runId] = { name, params, steps: pb.steps.map((s, i) => ({ ...s, index: i, status: 'pending', taskId: null })), startedAt: Date.now(), status: 'running' };
  saveRuns(runs);

  console.log(`[Playbook] ▶️  Running "${name}" (${runId}) with params: ${JSON.stringify(params)}`);
  const results = [];

  // Process steps in order (sequential by default, parallel flag = fire together)
  let i = 0;
  while (i < pb.steps.length) {
    const step = pb.steps[i];
    const run  = runs[runId].steps[i];

    // Check dependsOn
    if (step.dependsOn !== undefined) {
      const dep = runs[runId].steps[step.dependsOn];
      if (dep.status !== 'dispatched') { await new Promise(r => setTimeout(r, 500)); continue; }
    }

    try {
      const res = await fetch(`${forgeUrl}/api/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: step.to,
          title: interp(step.title, params),
          body: interp(step.body, params),
          priority: step.priority || 'medium',
          tags: [...(step.tags || []), `playbook:${name}`, `run:${runId}`],
          source: `playbook:${name}`,
        }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      run.status = 'dispatched';
      run.taskId = data.dispatched?.taskId;
      results.push({ step: i, to: step.to, taskId: run.taskId, ok: true });
      console.log(`[Playbook] ✅ Step ${i+1}/${pb.steps.length}: ${step.to} ← "${interp(step.title, params).slice(0, 40)}"`);
    } catch (e) {
      run.status = 'failed';
      results.push({ step: i, to: step.to, ok: false, error: e.message });
    }

    // Parallel: advance to next regardless; sequential: only if no dependsOn on next
    i++;
  }

  runs[runId].status = 'dispatched';
  runs[runId].completedAt = Date.now();
  saveRuns(runs);
  return { runId, name, steps: results.length, results };
}

// ── List playbooks ────────────────────────────────────────────────────────────
export function listPlaybooks() {
  const custom = loadCustom();
  return Object.entries({ ...BUILT_IN, ...custom }).map(([name, pb]) => ({
    name,
    description: pb.description,
    steps: pb.steps.length,
    agents: [...new Set(pb.steps.map(s => s.to))],
    custom: !!custom[name],
  }));
}

// ── Define custom playbook ────────────────────────────────────────────────────
export function definePlaybook(name, pb) {
  const custom = loadCustom();
  custom[name] = pb;
  saveCustom(custom);
  return { name, steps: pb.steps.length };
}

export function getRunStatus(runId) {
  return loadRuns()[runId] || null;
}
