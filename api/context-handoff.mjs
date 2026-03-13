/**
 * context-handoff.mjs — Agent Context Handoff with Compressed Summary
 *
 * Video: "Anthropic's Agent Harness: 200+ Features Built Autonomously" (Tlqe0A8ED8o)
 * Pattern: When routing task A → agent X, compress prior context into a handoff packet
 *   Avoids "context amnesia" when agent B picks up where agent A left off
 *   Persistent artifact (handoff.json per task) survives process restarts
 *
 * Handoff packet:
 *   { fromAgent, toAgent, taskId, summary, keyFacts[], lastResult, ts }
 *
 * Summary generation:
 *   - Under 300 chars: use raw lastResult (no LLM needed)
 *   - Over 300 chars: gpt-4o-mini compresses to 3-sentence summary
 *
 * Storage: ~/.openclaw/workspace/handoffs/<taskId>.json
 *
 * API:
 *   POST /api/handoff/create  { fromAgent, toAgent, taskId, lastResult, keyFacts }
 *   GET  /api/handoff/:taskId — retrieve handoff packet
 *   GET  /api/handoff/stats   — handoff count by agent pair
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME          = os.homedir();
const HANDOFF_DIR   = path.join(HOME, '.openclaw/workspace/handoffs');
const OPENAI_KEY    = process.env.OPENAI_API_KEY || '';
fs.mkdirSync(HANDOFF_DIR, { recursive: true });

// ── Compress context with LLM (only if needed) ────────────────────────────────
async function compressSummary(text, fromAgent, toAgent) {
  if (text.length <= 300) return text;
  if (!OPENAI_KEY) return text.slice(0, 300) + '…';

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Agent ${fromAgent} completed a task and is handing off to ${toAgent}. Compress this result into exactly 3 sentences that capture: (1) what was done, (2) key outcome/state, (3) what ${toAgent} should do next.\n\nResult:\n${text.slice(0, 1000)}`,
        }],
        max_tokens: 120, temperature: 0,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || text.slice(0, 300);
  } catch {
    return text.slice(0, 300) + '…';
  }
}

// ── Create handoff packet ─────────────────────────────────────────────────────
export async function createHandoff({ fromAgent, toAgent, taskId, lastResult = '', keyFacts = [], title = '' }) {
  const summary = await compressSummary(lastResult, fromAgent, toAgent);
  const packet = {
    fromAgent, toAgent, taskId, title,
    summary,
    keyFacts: keyFacts.slice(0, 5), // max 5 bullet facts
    lastResult: lastResult.slice(0, 500),
    ts: Date.now(),
  };
  const file = path.join(HANDOFF_DIR, `${taskId}.json`);
  fs.writeFileSync(file, JSON.stringify(packet, null, 2));
  console.log(`[Handoff] 📦 ${fromAgent} → ${toAgent}: "${summary.slice(0, 60)}"`);
  return packet;
}

// ── Retrieve handoff (called in dispatch if routing a task) ───────────────────
export function getHandoff(taskId) {
  try {
    const file = path.join(HANDOFF_DIR, `${taskId}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

// ── Build handoff context string for injection into task body ────────────────
export function buildHandoffContext(taskId) {
  const packet = getHandoff(taskId);
  if (!packet) return null;
  const facts = packet.keyFacts?.length ? `\nKey facts:\n${packet.keyFacts.map(f => `• ${f}`).join('\n')}` : '';
  return `[Handoff from ${packet.fromAgent}]\n${packet.summary}${facts}`;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getHandoffStats() {
  try {
    const files = fs.readdirSync(HANDOFF_DIR).filter(f => f.endsWith('.json'));
    const pairs = {};
    for (const f of files) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(HANDOFF_DIR, f), 'utf8'));
        const key = `${p.fromAgent}→${p.toAgent}`;
        pairs[key] = (pairs[key] || 0) + 1;
      } catch {}
    }
    return { total: files.length, pairs };
  } catch { return { total: 0, pairs: {} }; }
}
