/**
 * dag.mjs — Task Dependency Graph (DAG) for Workflow Orchestration
 *
 * Pattern: Directed Acyclic Graph scheduling (Apache Airflow / Prefect inspired)
 *   Source: DAG patterns in production AI orchestration (Temporal, Prefect 2026)
 *   Tasks declare dependencies → system resolves order → parallel where possible
 *
 * Usage:
 *   Define a DAG with nodes (tasks) and edges (dependencies)
 *   Run the DAG → system topologically sorts, dispatches ready tasks
 *   When a task completes → check if downstream tasks are now unblocked
 *
 * Built-in DAGs:
 *   orgon-release:  spec → backend → frontend → test → staging-deploy → smoke → prod-deploy
 *   security-check: scan → analyze → fix → verify → report
 *   weekly-report:  gather-metrics → aggregate → write-summary → post
 *
 * API:
 *   POST /api/dag/run    { name, params }   — start a DAG run
 *   POST /api/dag/done   { runId, nodeId }  — mark node complete, unblock next
 *   GET  /api/dag/:runId — get run status + current nodes
 *   GET  /api/dag        — list DAG definitions
 */

import { createHash } from 'node:crypto';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const RUNS_FILE = path.join(HOME, '.openclaw/workspace/.dag-runs.json');

// ── Built-in DAG definitions ──────────────────────────────────────────────────
const DAGS = {
  'orgon-release': {
    description: 'Full ORGON release pipeline (7 stages)',
    nodes: {
      spec:           { to: 'dana',   title: 'Write release spec for {version}', body: 'Document all changes, breaking changes, migration steps for {version}', priority: 'high', deps: [] },
      backend:        { to: 'bekzat', title: 'Implement backend changes for {version}', body: 'Implement all backend features per spec. Run tests.', priority: 'high', deps: ['spec'] },
      frontend:       { to: 'ainura', title: 'Implement frontend for {version}', body: 'Implement frontend features for {version}. Connect to new API endpoints.', priority: 'high', deps: ['spec'] },
      test:           { to: 'marat',  title: 'Full test suite for {version}', body: 'Run unit + integration + E2E tests for {version} backend and frontend.', priority: 'high', deps: ['backend', 'frontend'] },
      staging_deploy: { to: 'nurlan', title: 'Deploy {version} to staging', body: 'Deploy {version} to staging environment. Run migrations.', priority: 'high', deps: ['test'], tags: ['sensitive-ok'] },
      smoke:          { to: 'marat',  title: 'Smoke test staging for {version}', body: 'Smoke test {version} on staging: auth, core flows, API health.', priority: 'high', deps: ['staging_deploy'] },
      prod_deploy:    { to: 'nurlan', title: 'Deploy {version} to production', body: 'Deploy {version} to production. Monitor for 30min post-deploy.', priority: 'critical', deps: ['smoke'], tags: ['approved'] },
    },
  },
  'security-check': {
    description: 'Security audit pipeline (4 stages)',
    nodes: {
      scan:     { to: 'iron',   title: 'Security scan: {target}', body: 'Full security scan of {target}: deps, endpoints, auth, secrets.', priority: 'high', deps: [] },
      analyze:  { to: 'mesa',   title: 'Analyze security findings: {target}', body: 'Analyze scan results for {target}. Prioritize by CVSS score.', priority: 'high', deps: ['scan'] },
      fix:      { to: 'bekzat', title: 'Fix security issues in {target}', body: 'Implement fixes for prioritized vulnerabilities in {target}.', priority: 'high', deps: ['analyze'] },
      verify:   { to: 'marat',  title: 'Verify security fixes: {target}', body: 'Verify all fixes in {target}. Re-run scan. Confirm no regressions.', priority: 'high', deps: ['fix'] },
    },
  },
  'weekly-report': {
    description: 'Weekly status report pipeline (3 stages)',
    nodes: {
      gather:  { to: 'mesa', title: 'Gather weekly metrics for {week}', body: 'Collect: tasks done/failed, agent performance, costs, errors for week {week}.', priority: 'low', deps: [] },
      write:   { to: 'dana', title: 'Write weekly summary for {week}', body: 'Write executive weekly summary from metrics. 5 bullets max.', priority: 'low', deps: ['gather'] },
      publish: { to: 'forge', title: 'Publish weekly report for {week}', body: 'Post weekly report for {week} to Squad Chat. Update CONTEXT.md.', priority: 'low', deps: ['write'] },
    },
  },
};

// ── Load/save runs ────────────────────────────────────────────────────────────
function loadRuns() { try { return JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8')); } catch { return {}; } }
function saveRuns(r) { try { fs.writeFileSync(RUNS_FILE, JSON.stringify(r, null, 2)); } catch {} }

// ── Topological sort ──────────────────────────────────────────────────────────
function topoSort(nodes) {
  const visited = new Set();
  const order = [];
  const visit = (id) => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const dep of nodes[id]?.deps || []) visit(dep);
    order.push(id);
  };
  for (const id of Object.keys(nodes)) visit(id);
  return order;
}

// ── Get ready nodes (all deps completed) ─────────────────────────────────────
function getReadyNodes(run) {
  const ready = [];
  for (const [id, node] of Object.entries(run.nodes)) {
    if (node.status !== 'pending') continue;
    const depsOk = (run.dag.nodes[id]?.deps || []).every(dep => run.nodes[dep]?.status === 'done');
    if (depsOk) ready.push(id);
  }
  return ready;
}

// ── Interpolate params ────────────────────────────────────────────────────────
function interp(text, params = {}) {
  return text.replace(/\{(\w+)\}/g, (_, k) => params[k] !== undefined ? params[k] : `{${k}}`);
}

// ── Start a DAG run ───────────────────────────────────────────────────────────
export async function runDAG(name, params = {}, forgeUrl = 'http://localhost:5190') {
  const dag = DAGS[name];
  if (!dag) throw new Error(`DAG not found: ${name}`);

  const runId = `dag-${name}-${createHash('md5').update(name + Date.now()).digest('hex').slice(0, 6)}`;
  const runs = loadRuns();
  runs[runId] = {
    runId, name, params, dag,
    nodes: Object.fromEntries(Object.keys(dag.nodes).map(id => [id, { status: 'pending', taskId: null, completedAt: null }])),
    startedAt: Date.now(), status: 'running',
  };
  saveRuns(runs);

  console.log(`[DAG] ▶️  Starting "${name}" run ${runId}`);
  const order = topoSort(dag.nodes);
  console.log(`[DAG] Execution order: ${order.join(' → ')}`);

  // Dispatch all initially ready nodes (no deps)
  const dispatched = await dispatchReady(runId, forgeUrl);
  return { runId, name, order, initiallyDispatched: dispatched };
}

// ── Dispatch all ready nodes ──────────────────────────────────────────────────
async function dispatchReady(runId, forgeUrl = 'http://localhost:5190') {
  const runs = loadRuns();
  const run = runs[runId];
  if (!run) return [];

  const ready = getReadyNodes(run);
  const dispatched = [];

  for (const nodeId of ready) {
    const nodeDef = run.dag.nodes[nodeId];
    try {
      const res = await fetch(`${forgeUrl}/api/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: nodeDef.to,
          title: interp(nodeDef.title, run.params),
          body: interp(nodeDef.body || '', run.params),
          priority: nodeDef.priority || 'medium',
          tags: [...(nodeDef.tags || []), `dag:${run.name}`, `run:${runId}`, `node:${nodeId}`],
          source: `dag:${run.name}`,
        }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      run.nodes[nodeId].status = 'dispatched';
      run.nodes[nodeId].taskId = data.dispatched?.taskId;
      dispatched.push({ nodeId, to: nodeDef.to, taskId: run.nodes[nodeId].taskId });
      console.log(`[DAG] ✅ ${runId}/${nodeId} → ${nodeDef.to}: "${interp(nodeDef.title, run.params).slice(0, 40)}"`);
    } catch (e) {
      run.nodes[nodeId].status = 'failed';
      console.error(`[DAG] ❌ ${runId}/${nodeId} dispatch failed: ${e.message}`);
    }
  }

  saveRuns(runs);
  return dispatched;
}

// ── Mark node as done, trigger downstream ────────────────────────────────────
export async function markNodeDone(runId, nodeId, forgeUrl = 'http://localhost:5190') {
  const runs = loadRuns();
  const run = runs[runId];
  if (!run) throw new Error(`Run ${runId} not found`);

  run.nodes[nodeId].status = 'done';
  run.nodes[nodeId].completedAt = Date.now();
  saveRuns(runs);

  console.log(`[DAG] ✅ Node ${nodeId} done. Checking downstream...`);
  const newlyReady = await dispatchReady(runId, forgeUrl);

  // Check if all done
  const allDone = Object.values(run.nodes).every(n => n.status === 'done');
  if (allDone) {
    const finalRuns = loadRuns();
    if (finalRuns[runId]) { finalRuns[runId].status = 'complete'; finalRuns[runId].completedAt = Date.now(); saveRuns(finalRuns); }
    console.log(`[DAG] 🎉 Run ${runId} complete!`);
  }

  return { runId, nodeId, newlyDispatched: newlyReady, dagComplete: allDone };
}

// ── Get run status ────────────────────────────────────────────────────────────
export function getDAGRun(runId) { return loadRuns()[runId] || null; }

export function listDAGs() {
  return Object.entries(DAGS).map(([name, d]) => ({
    name, description: d.description, nodes: Object.keys(d.nodes).length,
    stages: topoSort(d.nodes),
  }));
}
