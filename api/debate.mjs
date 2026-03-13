/**
 * debate.mjs — Multi-Agent Debate (Peer Review Consensus)
 *
 * Video: "Multi-Agent Consensus: Eliminating Hallucinations via Peer Review"
 *        (2j6tErHEbCU)
 *
 * Pattern: Structured debate → sub-1% error rate
 *   Roles: Researcher (facts) + Contrarian (challenge) + Judge (final)
 *   3 rounds max: propose → critique → revise → judge
 *
 * When to debate (conservative to avoid cost):
 *   - Only when Karpathy score < 4 AND stochastic consensus didn't resolve
 *   - Only for priority=critical tasks with `debate` tag
 *   - Manual trigger via POST /api/debate/start
 *
 * Cost: ~3 LLM calls (cheap models) per debate
 * Models: gpt-4o-mini for all roles (fast + cheap)
 *
 * Output: final answer + confidence + dissent_score (0=unanimous)
 *
 * API:
 *   POST /api/debate/start  { question, context, maxRounds }
 *   GET  /api/debate/:id    — debate result
 *   GET  /api/debate/stats  — debate stats
 */

import { createHash } from 'node:crypto';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const DEBATE_LOG = path.join(HOME, '.openclaw/workspace/debate-log.jsonl');

const OPENAI_KEY = process.env.OPENAI_API_KEY;

// ── LLM call (cheap + fast) ───────────────────────────────────────────────────
async function llm(system, user, temp = 0.7) {
  if (!OPENAI_KEY) return { text: '[No OPENAI_API_KEY]', ok: false };
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 600, temperature: temp }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    return { text: data.choices?.[0]?.message?.content?.trim() || '', ok: true };
  } catch (e) { return { text: e.message, ok: false }; }
}

// ── Role prompts ──────────────────────────────────────────────────────────────
const RESEARCHER = `You are the Researcher agent. Your role: present facts, find evidence, propose an initial answer. Be concise (max 200 words). Format: ANSWER: ... CONFIDENCE: 0.0-1.0 SOURCES: ...`;
const CONTRARIAN = `You are the Contrarian agent. Your role: challenge assumptions, find weaknesses, identify what could be wrong. Be specific (max 150 words). Format: CHALLENGE: ... RISK_LEVEL: low|medium|high`;
const JUDGE      = `You are the Judge agent. Given a debate between Researcher and Contrarian, synthesize the best answer. Be decisive (max 200 words). Format: FINAL_ANSWER: ... CONFIDENCE: 0.0-1.0 DISSENT: 0.0-1.0 (0=unanimous, 1=full disagreement)`;

// ── Run a debate ──────────────────────────────────────────────────────────────
export async function runDebate({ question, context = '', maxRounds = 2, debateId }) {
  const id = debateId || `debate-${createHash('md5').update(question + Date.now()).digest('hex').slice(0, 8)}`;
  console.log(`[Debate] 🎙️  Starting debate ${id}: "${question.slice(0, 60)}"`);

  const rounds = [];
  let researcherAnswer = '';
  let contrarian = '';

  for (let r = 0; r < maxRounds; r++) {
    // Round 1: Researcher proposes
    const resCtx = r === 0 ? question : `Original: ${question}\nPrevious answer: ${researcherAnswer}\nContrarianChallenge: ${contrarian}\nRevise your answer addressing the challenge.`;
    const res = await llm(RESEARCHER, `${resCtx}\n\nContext: ${context.slice(0, 500)}`);

    // Round 2: Contrarian challenges
    const conRes = await llm(CONTRARIAN, `Question: ${question}\nResearcher says: ${res.text}`);

    researcherAnswer = res.text;
    contrarian = conRes.text;
    rounds.push({ round: r + 1, researcher: res.text.slice(0, 300), contrarian: conRes.text.slice(0, 200) });
    console.log(`[Debate] Round ${r + 1}: Researcher(${res.text.length}c) ↔ Contrarian(${conRes.text.length}c)`);
  }

  // Judge synthesizes
  const judgeInput = `Question: ${question}\n\nRound history:\n${rounds.map(r => `R${r.round} Researcher: ${r.researcher}\nR${r.round} Contrarian: ${r.contrarian}`).join('\n\n')}`;
  const judgeRes = await llm(JUDGE, judgeInput, 0.2); // low temp for decisive judgment

  // Parse judge output
  const finalMatch = judgeRes.text.match(/FINAL_ANSWER:\s*([\s\S]*?)(?:CONFIDENCE:|$)/i);
  const confMatch  = judgeRes.text.match(/CONFIDENCE:\s*([\d.]+)/i);
  const dissentMatch = judgeRes.text.match(/DISSENT:\s*([\d.]+)/i);

  const result = {
    id, question: question.slice(0, 100),
    finalAnswer: finalMatch?.[1]?.trim() || judgeRes.text,
    confidence: parseFloat(confMatch?.[1] || '0.7'),
    dissent: parseFloat(dissentMatch?.[1] || '0.3'),
    rounds: rounds.length,
    roundDetails: rounds,
    judgeRaw: judgeRes.text.slice(0, 500),
    ts: Date.now(),
  };

  fs.appendFileSync(DEBATE_LOG, JSON.stringify({ ...result, roundDetails: undefined }) + '\n');
  console.log(`[Debate] ✅ ${id}: confidence=${result.confidence} dissent=${result.dissent}`);
  return result;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getDebateStats() {
  try {
    const lines = fs.readFileSync(DEBATE_LOG, 'utf8').trim().split('\n').filter(Boolean);
    const debates = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const avgConf = debates.reduce((s, d) => s + (d.confidence || 0), 0) / (debates.length || 1);
    const avgDissent = debates.reduce((s, d) => s + (d.dissent || 0), 0) / (debates.length || 1);
    return { total: debates.length, avgConfidence: avgConf.toFixed(2), avgDissent: avgDissent.toFixed(2) };
  } catch { return { total: 0, avgConfidence: 0, avgDissent: 0 }; }
}
