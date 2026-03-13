/**
 * triage-agent.mjs — Autonomous DLQ Triage
 *
 * Video: "AI Agents Will Run Themselves in 2026" (Pi11CtrVzWA, Mirantis)
 * Pattern: Autonomous triage agent — handles failed tasks without human
 *
 * Actions:
 *   retry    — transient error (timeout, rate_limit, network)
 *   reroute  — wrong agent (keyword mismatch) → find better agent
 *   decompose→ task too complex → send to Fractals decomposer
 *   escalate → needs_human_review (unknown failure, repeated failures)
 */

import { createHash } from 'node:crypto';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const AUDIT_LOG = path.join(HOME, '.openclaw/workspace/audit-log.jsonl');
const TRIAGE_LOG = path.join(HOME, '.openclaw/workspace/triage-log.jsonl');

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';

// ── Agent routing keywords ────────────────────────────────────────────────────
const AGENT_SKILLS = {
  bekzat:  ['backend', 'api', 'fastapi', 'database', 'postgres', 'python', 'server', 'auth', 'jwt', 'neon', 'endpoint'],
  ainura:  ['frontend', 'react', 'ui', 'component', 'css', 'typescript', 'vite', 'next.js', 'design', 'tailwind', 'button', 'page'],
  marat:   ['test', 'qa', 'quality', 'coverage', 'bug', 'regression', 'e2e', 'pytest', 'jest'],
  nurlan:  ['devops', 'docker', 'deploy', 'ci', 'nginx', 'pm2', 'server', 'infrastructure', 'linux'],
  dana:    ['plan', 'sprint', 'task', 'requirements', 'doc', 'product', 'roadmap'],
  mesa:    ['analytics', 'simulation', 'data', 'metrics', 'report', 'chart'],
  iron:    ['security', 'network', 'cloudflare', 'tunnel', 'proxy', 'ssl'],
  forge:   ['code', 'build', 'implement', 'create', 'refactor', 'fix'],
};

// ── Detect transient errors ───────────────────────────────────────────────────
const TRANSIENT_PATTERNS = [
  /timeout/i, /rate.?limit/i, /429/i, /503/i, /econnreset/i,
  /network/i, /temporarily/i, /retry/i, /eaddrinuse/i, /overloaded/i,
];

function isTransientError(errorMsg = '') {
  return TRANSIENT_PATTERNS.some(p => p.test(errorMsg));
}

// ── Find best agent by keyword match ─────────────────────────────────────────
function findBestAgent(title = '', body = '', excludeAgent = '') {
  const text = `${title} ${body}`.toLowerCase();
  let best = null, bestScore = 0;
  for (const [agent, keywords] of Object.entries(AGENT_SKILLS)) {
    if (agent === excludeAgent) continue;
    const score = keywords.filter(k => text.includes(k)).length;
    if (score > bestScore) { bestScore = score; best = agent; }
  }
  return bestScore >= 2 ? best : null;
}

// ── LLM triage (when heuristics are insufficient) ────────────────────────────
async function llmTriage({ title, body, errorMsg, attemptCount, currentAgent }) {
  if (!OPENAI_KEY) return null;
  try {
    const prompt = `You are a task triage agent for a multi-agent AI system.

Task: "${title}"
Body: "${(body || '').slice(0, 300)}"
Failed agent: ${currentAgent}
Error: "${errorMsg || 'unknown'}"
Attempt count: ${attemptCount}

Available agents: forge (coding), bekzat (backend/python), ainura (frontend/react), marat (qa/testing), nurlan (devops), dana (pm/planning), mesa (analytics), iron (security/network)

Decide ONE action:
- "retry" — transient error, same agent can retry
- "reroute:<agent>" — wrong agent, specify better one (e.g. "reroute:ainura")
- "decompose" — task is too complex, needs splitting
- "escalate" — unknown failure, needs human review

Respond with ONLY the action string, nothing else.`;

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 20,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}

// ── Main triage function ──────────────────────────────────────────────────────
export async function triageFailedTask({ taskId, title, body, errorMsg, attemptCount, currentAgent, forgeApiUrl = 'http://localhost:5190' }) {
  const decisionId = createHash('md5').update(`${taskId}-${attemptCount}`).digest('hex').slice(0,8);
  let action = 'escalate';
  let targetAgent = currentAgent;
  let reasoning = 'default escalation';

  // 1. Transient error → retry
  if (isTransientError(errorMsg)) {
    action = 'retry';
    reasoning = `transient error detected: "${errorMsg}"`;
  }

  // 2. Keyword mismatch → reroute
  if (action === 'escalate') {
    const better = findBestAgent(title, body, currentAgent);
    if (better) {
      action = 'reroute';
      targetAgent = better;
      reasoning = `keyword routing: "${better}" fits task better than "${currentAgent}"`;
    }
  }

  // 3. Too many attempts → decompose
  if (attemptCount >= 2 && action !== 'retry' && action !== 'reroute') {
    action = 'decompose';
    reasoning = `${attemptCount} attempts failed → decompose into subtasks`;
  }

  // 4. LLM fallback for ambiguous cases
  if (action === 'escalate' && OPENAI_KEY) {
    const llmDecision = await llmTriage({ title, body, errorMsg, attemptCount, currentAgent });
    if (llmDecision) {
      if (llmDecision.startsWith('reroute:')) {
        action = 'reroute';
        targetAgent = llmDecision.split(':')[1]?.trim() || currentAgent;
        reasoning = `LLM triage: reroute to ${targetAgent}`;
      } else if (['retry','decompose','escalate'].includes(llmDecision)) {
        action = llmDecision;
        reasoning = `LLM triage: ${llmDecision}`;
      }
    }
  }

  // Log triage decision
  const record = { ts: Date.now(), decisionId, taskId, title: title?.slice(0,60), action, targetAgent, reasoning, attemptCount, currentAgent };
  fs.appendFileSync(TRIAGE_LOG, JSON.stringify(record) + '\n');
  fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ...record, type: 'triage.decision' }) + '\n');
  console.log(`[Triage] 🔍 ${taskId} → ${action}${action==='reroute' ? ` (${targetAgent})` : ''} | ${reasoning}`);

  // Execute action
  try {
    if (action === 'retry') {
      await fetch(`${forgeApiUrl}/api/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: currentAgent, title, body, source: 'triage-retry', tags: ['triage', 'retry'], priority: 'medium' }),
        signal: AbortSignal.timeout(5000),
      });
    } else if (action === 'reroute') {
      await fetch(`${forgeApiUrl}/api/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: targetAgent, title, body, source: 'triage-reroute', tags: ['triage', 'rerouted', `from:${currentAgent}`], priority: 'medium' }),
        signal: AbortSignal.timeout(5000),
      });
    } else if (action === 'decompose') {
      await fetch(`${forgeApiUrl}/api/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: currentAgent, title: `[DECOMPOSE] ${title}`, body, source: 'triage-decompose', tags: ['decompose-needed'], priority: 'medium' }),
        signal: AbortSignal.timeout(5000),
      });
    }
    // escalate → DLQ already marked, needs_human_review flag set by caller
  } catch (e) {
    console.warn('[Triage] action dispatch failed:', e.message);
  }

  return { action, targetAgent, reasoning, decisionId };
}

// ── Get triage stats ──────────────────────────────────────────────────────────
export function getTriageStats() {
  try {
    const lines = fs.readFileSync(TRIAGE_LOG, 'utf8').trim().split('\n').filter(Boolean);
    const records = lines.map(l => JSON.parse(l));
    const byAction = {};
    for (const r of records) byAction[r.action] = (byAction[r.action] || 0) + 1;
    return { total: records.length, byAction, last: records.slice(-5).map(r => ({ taskId: r.taskId, action: r.action, ts: r.ts })) };
  } catch { return { total: 0, byAction: {}, last: [] }; }
}
