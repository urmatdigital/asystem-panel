/**
 * self-critic.mjs — Pre-Submission Self-Critique + Self-Correcting Loop
 *
 * Video: "Advanced RAG: Self-Correcting AI Agents Reduce Hallucinations" (WnA3hFSTPtI)
 * + "Self-Improving AI Agent: Live Demo of Recursive Skill Learning" (FQsklvKKDfg)
 *
 * Pattern: Draft → Critic → Verify → Final
 *   Before a result is stored in Convex, agent critiques its own output
 *   Critique identifies: completeness, accuracy, actionability, missing edge cases
 *   If critique score < 7: auto-revise with critique as feedback (one pass only)
 *   If critique score >= 7: accept as-is (avoid infinite loop)
 *
 * Recursive Skill Learning (FQsklvKKDfg):
 *   After critique, if a skill gap is detected → propose new skill definition
 *   Store as skill delta in ZVec (skill-injector compatible format)
 *
 * Triggers: only for critical/high priority OR result > 200 chars (substantial work)
 * Cost: ~$0.001/critique (gpt-4o-mini, 150 tokens)
 * Non-fatal: errors are caught, original result passes through
 *
 * API:
 *   POST /api/self-critic/review { agentId, result, title, priority }
 *   GET  /api/self-critic/stats
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME        = os.homedir();
const CRITIC_LOG  = path.join(HOME, '.openclaw/workspace/self-critic-log.jsonl');
const OPENAI_KEY  = process.env.OPENAI_API_KEY || '';

let statsCache = { total: 0, revised: 0, passed: 0, skillsProposed: 0 };

// ── Critique a result ─────────────────────────────────────────────────────────
async function critiqueResult(agentId, result, title) {
  if (!OPENAI_KEY) return null;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `You are a senior engineer reviewing agent ${agentId}'s output.
Task: "${title}"
Result: "${result.slice(0, 600)}"

Critique this output. Score 1-10. Identify issues.
Output JSON only: {"score": N, "issues": ["issue1","issue2"], "missing": "what's missing", "verdict": "pass|revise", "skill_gap": "skill name or null"}
verdict=pass if score>=7, revise if score<7.`,
      }],
      max_tokens: 200, temperature: 0,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim() || '{}';
  return JSON.parse(text);
}

// ── Revise result based on critique ──────────────────────────────────────────
async function reviseResult(agentId, result, title, critique) {
  if (!OPENAI_KEY) return result;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `You are agent ${agentId}. Revise your output based on critic feedback.
Task: "${title}"
Your output: "${result.slice(0, 500)}"
Critic issues: ${critique.issues?.join('; ')}
Missing: ${critique.missing}

Write improved version only (no meta-commentary):`,
      }],
      max_tokens: 500, temperature: 0.3,
    }),
    signal: AbortSignal.timeout(12000),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || result;
}

// ── Propose new skill from skill gap ─────────────────────────────────────────
async function proposeSkill(agentId, skillGap, title) {
  if (!OPENAI_KEY || !skillGap) return;
  try {
    // Write to skill-delta-log.jsonl (compatible with self-improver.mjs format)
    const delta = `[${agentId.toUpperCase()} SKILL PROPOSAL] ${skillGap}: identified gap in task "${title.slice(0, 60)}"`;
    fs.appendFileSync(
      path.join(HOME, '.openclaw/workspace/skill-delta-log.jsonl'),
      JSON.stringify({ ts: Date.now(), agentId, delta, source: 'self-critic', skillGap }) + '\n'
    );
    statsCache.skillsProposed++;
    console.log(`[SelfCritic] 💡 ${agentId} proposed skill: "${skillGap}"`);
  } catch {}
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function reviewBeforeSubmit({ agentId, result, title, priority = 'medium', taskId }) {
  // Skip: too short, not worth critiquing
  if (!result || result.length < 100) return { result, revised: false, score: null };
  // Skip: low priority + short result (save cost)
  if (!['critical', 'high'].includes(priority) && result.length < 300) return { result, revised: false, score: null };
  // Skip: no API key
  if (!OPENAI_KEY) return { result, revised: false, score: null };

  statsCache.total++;

  try {
    const critique = await critiqueResult(agentId, result, title);
    if (!critique || typeof critique.score !== 'number') return { result, revised: false, score: null };

    const logEntry = { ts: Date.now(), agentId, taskId, title: title?.slice(0, 60), score: critique.score, verdict: critique.verdict, issues: critique.issues };

    if (critique.verdict === 'pass' || critique.score >= 7) {
      statsCache.passed++;
      logEntry.action = 'passed';
      fs.appendFileSync(CRITIC_LOG, JSON.stringify(logEntry) + '\n');
      console.log(`[SelfCritic] ✅ ${agentId} score=${critique.score} → passed`);
      // Still propose skill if gap detected
      if (critique.skill_gap) await proposeSkill(agentId, critique.skill_gap, title);
      return { result, revised: false, score: critique.score, verdict: 'pass' };
    }

    // Score < 7 → revise
    statsCache.revised++;
    logEntry.action = 'revised';
    const revised = await reviseResult(agentId, result, title, critique);
    logEntry.revisionLength = revised.length;
    fs.appendFileSync(CRITIC_LOG, JSON.stringify(logEntry) + '\n');
    console.log(`[SelfCritic] ✏️  ${agentId} score=${critique.score} → revised (${result.length}→${revised.length} chars)`);
    if (critique.skill_gap) await proposeSkill(agentId, critique.skill_gap, title);
    return { result: revised, revised: true, score: critique.score, verdict: 'revised', issues: critique.issues };
  } catch (e) {
    console.warn(`[SelfCritic] non-fatal error: ${e.message}`);
    return { result, revised: false, score: null };
  }
}

export function getSelfCriticStats() {
  try {
    const lines = fs.readFileSync(CRITIC_LOG, 'utf8').trim().split('\n').filter(Boolean);
    const byAgent = {};
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        if (!byAgent[e.agentId]) byAgent[e.agentId] = { reviews: 0, revised: 0, avgScore: 0, scores: [] };
        byAgent[e.agentId].reviews++;
        if (e.action === 'revised') byAgent[e.agentId].revised++;
        if (e.score) byAgent[e.agentId].scores.push(e.score);
      } catch {}
    }
    for (const ag of Object.values(byAgent)) {
      ag.avgScore = ag.scores.length ? Math.round(ag.scores.reduce((s, v) => s + v, 0) / ag.scores.length * 10) / 10 : 0;
      delete ag.scores;
    }
    return { totalReviews: lines.length, ...statsCache, byAgent };
  } catch { return { totalReviews: 0, ...statsCache }; }
}
