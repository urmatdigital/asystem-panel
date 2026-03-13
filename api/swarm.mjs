/**
 * swarm.mjs — Fan-out / Fan-in parallel agent dispatch + aggregation
 *
 * Video: "Multi-agent swarms for PR fixes" (aidd Framework, _0mqqjgDhvc, 2026-03-03)
 * Pattern:
 *   Fan-out  → dispatch same task to N agents in parallel (each gets a sub-angle)
 *   Fan-in   → poll results, aggregate via LLM judge, pick best or merge
 *
 * Use cases:
 *   - Code review: bekzat + marat + ainura each review different aspects
 *   - Research: forge + mesa + atlas each analyze different angles
 *   - Testing: marat fans out test suites in parallel
 *
 * API:
 *   POST /api/swarm/dispatch  { title, body, agents[], strategy, timeout_min }
 *   GET  /api/swarm/:swarmId  — status + results
 *   GET  /api/swarm           — list active swarms
 */

import { createHash, randomUUID } from 'node:crypto';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME       = os.homedir();
const SWARM_DIR  = path.join(HOME, '.openclaw/workspace/swarms');
const AUDIT_LOG  = path.join(HOME, '.openclaw/workspace/audit-log.jsonl');
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';

fs.mkdirSync(SWARM_DIR, { recursive: true });

// ── Aggregation strategies ────────────────────────────────────────────────────
const STRATEGIES = {
  BEST:   'best',    // LLM picks the single best result
  MERGE:  'merge',   // LLM merges all results into one
  VOTE:   'vote',    // majority vote on boolean/choice answers
  FIRST:  'first',   // first successful result wins (fastest)
};

// ── Sub-task angles per agent role ───────────────────────────────────────────
const AGENT_ANGLES = {
  bekzat: 'Focus on backend correctness, database operations, API contracts, and error handling.',
  ainura: 'Focus on frontend UX, component architecture, TypeScript types, and accessibility.',
  marat:  'Focus on test coverage, edge cases, security vulnerabilities, and performance.',
  nurlan: 'Focus on deployment, infrastructure, Docker, environment variables, and CI/CD.',
  mesa:   'Focus on data analysis, metrics, patterns, and actionable insights.',
  iron:   'Focus on security, network exposure, authentication, and compliance.',
  forge:  'Focus on code quality, architecture patterns, and implementation approach.',
  atlas:  'Focus on strategic alignment, business impact, and long-term maintainability.',
  dana:   'Focus on requirements clarity, acceptance criteria, and stakeholder impact.',
};

// ── Persist swarm state ───────────────────────────────────────────────────────
function saveSwarm(swarm) {
  fs.writeFileSync(path.join(SWARM_DIR, `${swarm.id}.json`), JSON.stringify(swarm, null, 2));
}

function loadSwarm(swarmId) {
  try { return JSON.parse(fs.readFileSync(path.join(SWARM_DIR, `${swarmId}.json`), 'utf8')); }
  catch { return null; }
}

function listSwarms() {
  try {
    return fs.readdirSync(SWARM_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(SWARM_DIR, f), 'utf8')))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 20);
  } catch { return []; }
}

// ── Fan-out: dispatch to multiple agents ──────────────────────────────────────
export async function fanOut({ title, body, agents, strategy = STRATEGIES.BEST, timeoutMin = 10, forgeApiUrl = 'http://localhost:5190' }) {
  const swarmId = randomUUID().slice(0, 8);
  const swarm = {
    id: swarmId,
    title,
    agents,
    strategy,
    status: 'running',
    createdAt: Date.now(),
    timeoutAt: Date.now() + timeoutMin * 60_000,
    dispatched: {},
    results: {},
    aggregated: null,
  };

  // Dispatch to each agent with their angle
  await Promise.all(agents.map(async agentId => {
    const angle = AGENT_ANGLES[agentId] || '';
    const subBody = `${body}\n\n[SWARM ANGLE for ${agentId}]: ${angle}`;
    try {
      const r = await fetch(`${forgeApiUrl}/api/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: agentId, title: `[SWARM:${swarmId}] ${title}`,
          body: subBody, source: 'swarm-fan-out',
          tags: ['swarm', `swarm:${swarmId}`, agentId],
          priority: 'medium',
        }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await r.json();
      swarm.dispatched[agentId] = { taskId: data.taskId || data.id, dispatchedAt: Date.now(), status: 'pending' };
    } catch (e) {
      swarm.dispatched[agentId] = { error: e.message, status: 'failed' };
    }
  }));

  saveSwarm(swarm);
  fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ts: Date.now(), type: 'swarm.fanout', swarmId, agents, title: title?.slice(0,60) }) + '\n');
  console.log(`[Swarm] 🐝 Fan-out ${swarmId}: ${agents.length} agents → "${title?.slice(0,50)}"`);
  return swarm;
}

// ── Fan-in: aggregate results (called when task completes with swarm tag) ─────
export async function fanIn(swarmId, agentId, result) {
  const swarm = loadSwarm(swarmId);
  if (!swarm || swarm.status !== 'running') return null;

  swarm.results[agentId] = { result, receivedAt: Date.now() };
  if (swarm.dispatched[agentId]) swarm.dispatched[agentId].status = 'done';

  const pending = Object.keys(swarm.dispatched).filter(a => swarm.dispatched[a].status !== 'done' && swarm.dispatched[a].status !== 'failed');
  const isComplete = pending.length === 0 || Date.now() > swarm.timeoutAt;

  if (isComplete && Object.keys(swarm.results).length > 0) {
    swarm.status = 'aggregating';
    saveSwarm(swarm);
    swarm.aggregated = await aggregate(swarm);
    swarm.status = 'done';
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ts: Date.now(), type: 'swarm.fanin', swarmId, resultsCount: Object.keys(swarm.results).length }) + '\n');
    console.log(`[Swarm] ✅ Fan-in ${swarmId}: ${Object.keys(swarm.results).length}/${swarm.agents.length} results aggregated`);
  }

  saveSwarm(swarm);
  return swarm;
}

// ── Aggregate results via LLM ─────────────────────────────────────────────────
async function aggregate(swarm) {
  if (!OPENAI_KEY || Object.keys(swarm.results).length === 0) {
    return { method: 'first', result: Object.values(swarm.results)[0]?.result };
  }
  const resultsBlock = Object.entries(swarm.results)
    .map(([agent, r]) => `[${agent}]: ${(r.result || '').slice(0, 300)}`)
    .join('\n\n');

  let prompt;
  if (swarm.strategy === STRATEGIES.MERGE) {
    prompt = `You received results from ${swarm.agents.length} specialized agents on the task: "${swarm.title}"\n\nResults:\n${resultsBlock}\n\nMerge these into a single comprehensive response, preserving the best insights from each agent. Be concise.`;
  } else {
    prompt = `You received results from ${swarm.agents.length} agents on the task: "${swarm.title}"\n\nResults:\n${resultsBlock}\n\nWhich agent provided the best response? Output JSON: {"winner":"<agent_name>","reasoning":"one sentence","summary":"best result in 100 words"}`;
  }

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 400, temperature: 0 }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim() || '';
    if (swarm.strategy === STRATEGIES.MERGE) return { method: 'merge', result: text };
    try { return { method: 'best', ...JSON.parse(text.replace(/```json|```/g, '').trim()) }; }
    catch { return { method: 'best', result: text }; }
  } catch (e) {
    return { method: 'first', result: Object.values(swarm.results)[0]?.result, error: e.message };
  }
}

export { loadSwarm, listSwarms, STRATEGIES };
