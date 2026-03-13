/**
 * stochastic-consensus.mjs — Anti-hallucination via dual sampling
 *
 * Video: "AI Agents Full Course 2026: Master Agentic AI" (EsTrWCV0Ph4)
 * Pattern: Stochastic Consensus — run twice with different sampling,
 *   compare via judge, accept if consensus, escalate if divergent.
 *
 * Used only for: Karpathy score < 5 (failed tasks) + critical priority
 * Cost: ~$0.002 per consensus (2x gpt-4o-mini calls)
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME       = os.homedir();
const AUDIT_LOG  = path.join(HOME, '.openclaw/workspace/audit-log.jsonl');
const CONS_LOG   = path.join(HOME, '.openclaw/workspace/consensus-log.jsonl');

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const MODEL      = 'gpt-4o-mini';

// ── Single LLM call with given temperature ────────────────────────────────────
async function callLLM(prompt, temperature = 0.7) {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not set');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ── Judge: compare two responses ──────────────────────────────────────────────
async function judgeConsensus(task, responseA, responseB) {
  const prompt = `You are evaluating two AI responses to the same task.

Task: "${task}"

Response A: "${responseA.slice(0, 400)}"
Response B: "${responseB.slice(0, 400)}"

Do these responses reach the SAME conclusion/solution? Answer with JSON:
{"consensus": true|false, "score_a": 0-10, "score_b": 0-10, "better": "A"|"B"|"equal", "reasoning": "one sentence"}`;

  const result = await callLLM(prompt, 0);
  try {
    const cleaned = result.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { consensus: false, score_a: 5, score_b: 5, better: 'equal', reasoning: 'parse error' };
  }
}

// ── Main: run stochastic consensus ───────────────────────────────────────────
export async function runConsensus({ taskId, title, body, originalResult, agentId }) {
  if (!OPENAI_KEY) return { skipped: true, reason: 'no_openai_key' };

  const taskPrompt = `Task: "${title}"\nContext: "${(body || '').slice(0, 500)}"\n\nComplete this task concisely.`;

  let responseA, responseB, judgment;

  try {
    // Two independent runs with different temperatures (stochastic diversity)
    [responseA, responseB] = await Promise.all([
      callLLM(taskPrompt, 0.3),  // conservative
      callLLM(taskPrompt, 0.9),  // creative/diverse
    ]);

    judgment = await judgeConsensus(title, responseA, responseB);
  } catch (e) {
    console.warn('[Consensus] non-fatal error:', e.message.slice(0, 60));
    return { skipped: true, reason: e.message };
  }

  const record = {
    ts: Date.now(), taskId, agentId,
    title: title?.slice(0, 60),
    consensus: judgment.consensus,
    better: judgment.better,
    score_a: judgment.score_a,
    score_b: judgment.score_b,
    reasoning: judgment.reasoning,
  };
  fs.appendFileSync(CONS_LOG, JSON.stringify(record) + '\n');
  fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ...record, type: 'consensus.result' }) + '\n');
  console.log(`[Consensus] ${taskId} → consensus=${judgment.consensus} better=${judgment.better} (${judgment.reasoning})`);

  const bestResult = judgment.better === 'A' ? responseA : judgment.better === 'B' ? responseB : responseA;

  return {
    consensus: judgment.consensus,
    better: judgment.better,
    bestResult,
    scoreA: judgment.score_a,
    scoreB: judgment.score_b,
    reasoning: judgment.reasoning,
    // If no consensus → escalate
    needsHumanReview: !judgment.consensus && Math.abs(judgment.score_a - judgment.score_b) > 3,
  };
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getConsensusStats() {
  try {
    const lines = fs.readFileSync(CONS_LOG, 'utf8').trim().split('\n').filter(Boolean);
    const records = lines.map(l => JSON.parse(l));
    const total = records.length;
    const agreed = records.filter(r => r.consensus).length;
    return {
      total, agreed,
      consensusRate: total ? Math.round((agreed / total) * 100) : 0,
      last5: records.slice(-5).map(r => ({ taskId: r.taskId, consensus: r.consensus, better: r.better })),
    };
  } catch { return { total: 0, agreed: 0, consensusRate: 0, last5: [] }; }
}
