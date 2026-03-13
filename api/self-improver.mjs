/**
 * self-improver.mjs — Eureka Self-Reward: agents update their own reward signals
 *
 * Video: "AI Agentic System Design: Fundamentals for 2026" (8ZXyxY0UtDQ)
 * Pattern: Eureka (NVIDIA) — agent programmatically updates its own reward function
 *   Applied: after Karpathy eval, agent generates an improved system prompt hint
 *   stored as a "skill delta" — injected into future tasks for the same agent.
 *
 * Flow:
 *   task done → Karpathy score → if score changed significantly:
 *     → generateSkillDelta(agent, task, score, feedback)
 *     → store to ZVec as `system` memory type
 *     → retrieveSkillDeltas(agent) → inject into next task
 *
 * Unlike EMPO2 (tips per task), self-improver modifies the AGENT'S APPROACH,
 * not just gives tips. It's self-modifying system prompt engineering.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const ef        = promisify(execFile);
const HOME      = os.homedir();
const ZVEC_VENV = path.join(HOME, '.zvec-env/bin/python3');
const ZVEC_SCRIPT = path.join(HOME, 'projects/ASYSTEM/api/reme_search_zvec.py');
const DELTA_LOG = path.join(HOME, '.openclaw/workspace/skill-delta-log.jsonl');
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';

// ── Track score history per agent (in-memory, session) ───────────────────────
const scoreHistory = new Map(); // agentId → [{ score, ts }]

function recordScore(agentId, score) {
  if (!scoreHistory.has(agentId)) scoreHistory.set(agentId, []);
  const hist = scoreHistory.get(agentId);
  hist.push({ score, ts: Date.now() });
  if (hist.length > 20) hist.shift();
}

function getAvgScore(agentId) {
  const hist = scoreHistory.get(agentId) || [];
  if (!hist.length) return null;
  return hist.reduce((s, h) => s + h.score, 0) / hist.length;
}

function isSignificantChange(agentId, newScore) {
  const avg = getAvgScore(agentId);
  if (avg === null) return false;
  return Math.abs(newScore - avg) >= 2; // ≥2 point deviation is significant
}

// ── Generate skill delta via LLM ──────────────────────────────────────────────
async function generateSkillDelta({ agentId, taskTitle, taskResult, score, feedback, avgScore }) {
  if (!OPENAI_KEY) return null;
  const trend = score > (avgScore || 5) ? 'improved' : 'degraded';

  const prompt = `You are analyzing an AI agent's performance to generate a skill improvement delta.

Agent: ${agentId}
Task: "${taskTitle}"
Result excerpt: "${(taskResult || '').slice(0, 300)}"
Quality score: ${score}/10 (avg: ${avgScore?.toFixed(1) || 'N/A'}, trend: ${trend})
Judge feedback: "${feedback || 'none'}"

Generate a CONCISE skill delta — one specific behavioral instruction this agent should adopt going forward.
Format: "SKILL DELTA: [what to do differently] | BECAUSE: [why this improves outcomes]"
Max 2 sentences. Be specific to the agent's role and this task type.`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 100, temperature: 0.3 }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}

// ── Store skill delta to ZVec ─────────────────────────────────────────────────
async function storeSkillDelta(agentId, delta) {
  try {
    const content = `[${agentId.toUpperCase()} SKILL DELTA] ${delta}`;
    await ef(ZVEC_VENV, [ZVEC_SCRIPT, '--add', '--content', content, '--mtype', 'system', '--author', agentId], { timeout: 10000 });
    fs.appendFileSync(DELTA_LOG, JSON.stringify({ ts: Date.now(), agentId, delta }) + '\n');
    console.log(`[SelfImprover] 🔄 Skill delta stored for ${agentId}`);
  } catch (e) { console.warn('[SelfImprover] store failed:', e.message.slice(0, 60)); }
}

// ── Retrieve skill deltas for agent — injected into task body ─────────────────
export async function retrieveSkillDeltas(agentId) {
  try {
    const { stdout } = await ef(ZVEC_VENV, [ZVEC_SCRIPT, '--query', `${agentId} SKILL DELTA`, '--top', '3', '--mtype', 'system'], { timeout: 8000 });
    const results = JSON.parse(stdout || '[]');
    const deltas = results.filter(r => r.content?.includes(`[${agentId.toUpperCase()} SKILL DELTA]`));
    if (!deltas.length) return null;
    return `[Agent Self-Improvement Deltas for ${agentId}]\n${deltas.map(d => d.content).join('\n')}`;
  } catch { return null; }
}

// ── Main: process after Karpathy eval ────────────────────────────────────────
export async function processEurekaLoop({ agentId, taskId, taskTitle, taskResult, score, feedback }) {
  recordScore(agentId, score);
  const avg = getAvgScore(agentId);

  // Only generate delta when score is significantly different from agent's average
  if (!isSignificantChange(agentId, score)) return { skipped: true, reason: 'no_significant_change' };

  const delta = await generateSkillDelta({ agentId, taskTitle, taskResult, score, feedback, avgScore: avg });
  if (!delta) return { skipped: true, reason: 'generation_failed' };

  await storeSkillDelta(agentId, delta);
  return { ok: true, delta, score, avgScore: avg };
}

export function getSelfImproverStats() {
  try {
    const lines = fs.readFileSync(DELTA_LOG, 'utf8').trim().split('\n').filter(Boolean);
    const records = lines.map(l => JSON.parse(l));
    const byAgent = {};
    for (const r of records) byAgent[r.agentId] = (byAgent[r.agentId] || 0) + 1;
    return { total: records.length, byAgent, last3: records.slice(-3).map(r => ({ agentId: r.agentId, delta: r.delta?.slice(0, 80) })) };
  } catch { return { total: 0, byAgent: {}, last3: [] }; }
}
