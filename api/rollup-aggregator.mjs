/**
 * rollup-aggregator.mjs — Multi-Agent Output Synthesis (Rollup)
 *
 * Video: "Building My Own AI News Aggregator with an LLM Agent using Claude Code" (w_sjlbTxp2g)
 * Pattern: Multiple specialized agents each gather/produce a piece.
 *   A SYNTHESIZER agent then merges all pieces into ONE coherent result.
 *   Like a journalism editor who takes reporter fragments → final article.
 *
 * Use cases in ASYSTEM:
 *   - Security audit: iron(vulns) + marat(test gaps) + nurlan(infra) → atlas synthesizes report
 *   - Feature ship: bekzat(backend) + ainura(frontend) + marat(tests) → forge synthesizes changelog
 *   - Daily digest: all agents post findings → atlas synthesizes morning briefing
 *   - Code review: marat(bugs) + bekzat(arch) → forge synthesizes PR review
 *
 * Rollup lifecycle:
 *   1. CREATE rollup: define topic, expected contributors, deadline
 *   2. CONTRIBUTE: each agent submits their piece
 *   3. AUTO-SYNTHESIZE: when all expected contributors submitted (or deadline hit)
 *   4. DELIVER: synthesized result sent to designated recipient
 *
 * Synthesis strategies:
 *   MERGE:    combine all pieces sequentially (simple concatenation with headers)
 *   DISTILL:  use LLM to extract key insights from all pieces (gpt-4o-mini)
 *   VOTE:     pick the piece with highest confidence score
 *   OUTLINE:  structure into sections based on agent roles
 *
 * API:
 *   POST /api/rollup/create      { topic, contributors[], synthesizer, strategy, deadlineMin? }
 *   POST /api/rollup/contribute  { rollupId, agentId, content, confidence? }
 *   GET  /api/rollup/:rollupId   → rollup status + contributions
 *   POST /api/rollup/synthesize  { rollupId } → force synthesis now
 *   GET  /api/rollup/active      → all active rollups
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME       = os.homedir();
const ROLLUP_DIR = path.join(HOME, '.openclaw/workspace/.rollups');
const ROLLUP_LOG = path.join(HOME, '.openclaw/workspace/rollup-log.jsonl');

if (!fs.existsSync(ROLLUP_DIR)) fs.mkdirSync(ROLLUP_DIR, { recursive: true });

// ── Load / save rollup ────────────────────────────────────────────────────────
function loadRollup(id) {
  try { return JSON.parse(fs.readFileSync(path.join(ROLLUP_DIR, `${id}.json`), 'utf8')); }
  catch { return null; }
}
function saveRollup(r) { try { fs.writeFileSync(path.join(ROLLUP_DIR, `${r.id}.json`), JSON.stringify(r, null, 2)); } catch {} }

// ── Create rollup ─────────────────────────────────────────────────────────────
export function createRollup({ topic, contributors = [], synthesizer = 'atlas', strategy = 'OUTLINE', deadlineMin = 60 }) {
  const id = `rollup_${Date.now()}`;
  const rollup = {
    id, topic, contributors, synthesizer, strategy,
    status: 'collecting',
    createdAt: Date.now(),
    deadlineAt: Date.now() + deadlineMin * 60 * 1000,
    contributions: {},
    result: null,
  };
  saveRollup(rollup);
  fs.appendFileSync(ROLLUP_LOG, JSON.stringify({ ts: Date.now(), action: 'create', id, topic, contributors, strategy }) + '\n');
  console.log(`[Rollup] 📋 Created: "${topic}" | contributors: [${contributors.join(', ')}] | deadline: ${deadlineMin}min | strategy: ${strategy}`);
  return { ok: true, rollupId: id, topic, contributors, deadlineMin, strategy };
}

// ── Contribute ────────────────────────────────────────────────────────────────
export async function contribute({ rollupId, agentId, content, confidence = 0.8 }) {
  const rollup = loadRollup(rollupId);
  if (!rollup) return { ok: false, reason: `Rollup ${rollupId} not found` };
  if (rollup.status === 'synthesized') return { ok: false, reason: 'Rollup already synthesized' };

  rollup.contributions[agentId] = { content, confidence, submittedAt: Date.now() };
  fs.appendFileSync(ROLLUP_LOG, JSON.stringify({ ts: Date.now(), action: 'contribute', rollupId, agentId, chars: content.length, confidence }) + '\n');
  console.log(`[Rollup] ✍️  ${agentId} contributed to "${rollup.topic}" (${content.length} chars, conf=${confidence})`);

  // Check if all expected contributors have submitted
  const submitted  = Object.keys(rollup.contributions);
  const missing    = rollup.contributors.filter(c => !submitted.includes(c));
  const allIn      = missing.length === 0;
  const deadlineMet = Date.now() >= rollup.deadlineAt;

  saveRollup(rollup);

  if (allIn || deadlineMet) {
    console.log(`[Rollup] ⚡ Auto-synthesizing: ${allIn ? 'all contributors in' : 'deadline reached'}`);
    return await synthesize({ rollupId });
  }

  return { ok: true, rollupId, agentId, submitted: submitted.length, total: rollup.contributors.length, missing, autoSynthesized: false };
}

// ── Synthesize ────────────────────────────────────────────────────────────────
export async function synthesize({ rollupId }) {
  const rollup = loadRollup(rollupId);
  if (!rollup) return { ok: false, reason: `Rollup ${rollupId} not found` };

  const contributions = rollup.contributions;
  const entries = Object.entries(contributions);
  if (entries.length === 0) return { ok: false, reason: 'No contributions yet' };

  let result;
  const strategy = rollup.strategy;

  if (strategy === 'MERGE') {
    result = `# ${rollup.topic}\n\n` + entries.map(([agent, c]) => `## ${agent}\n${c.content}`).join('\n\n');
  } else if (strategy === 'VOTE') {
    const best = entries.reduce((a, b) => (a[1].confidence >= b[1].confidence ? a : b));
    result = `# ${rollup.topic}\n\n**Winning contribution by ${best[0]} (conf=${best[1].confidence}):**\n${best[1].content}`;
  } else if (strategy === 'OUTLINE') {
    // Structure by role
    const sections = entries.map(([agent, c]) => {
      const roleMap = { bekzat: 'Backend', ainura: 'Frontend', marat: 'QA/Testing', nurlan: 'DevOps', dana: 'PM', forge: 'Summary', atlas: 'Executive', iron: 'Security', mesa: 'Analytics', pixel: 'Design' };
      const role = roleMap[agent] || agent;
      return `### [${role}] ${agent}\n${c.content.slice(0, 500)}${c.content.length > 500 ? '...' : ''}`;
    }).join('\n\n');
    const missing = rollup.contributors.filter(c => !contributions[c]);
    result = `# ${rollup.topic}\n\n${sections}${missing.length > 0 ? `\n\n> ⚠️ Missing: ${missing.join(', ')}` : ''}`;
  } else if (strategy === 'DISTILL') {
    // Simple local distill (no LLM to avoid cost for every rollup)
    const allContent = entries.map(([agent, c]) => `[${agent}]: ${c.content}`).join('\n\n');
    const wordCount  = allContent.split(' ').length;
    result = `# ${rollup.topic} (Distilled)\n\n**Contributors:** ${entries.map(([a]) => a).join(', ')}\n**Total input:** ${wordCount} words\n\n${allContent.slice(0, 1000)}${allContent.length > 1000 ? '\n...(truncated)' : ''}`;
  }

  rollup.status = 'synthesized';
  rollup.result = result;
  rollup.synthesizedAt = Date.now();
  saveRollup(rollup);

  fs.appendFileSync(ROLLUP_LOG, JSON.stringify({ ts: Date.now(), action: 'synthesize', rollupId, strategy, contributors: entries.length, chars: result.length }) + '\n');
  console.log(`[Rollup] ✅ Synthesized "${rollup.topic}" via ${strategy}: ${entries.length} contributors → ${result.length} chars`);
  return { ok: true, rollupId, topic: rollup.topic, strategy, contributors: entries.length, resultLength: result.length, result: result.slice(0, 300) + (result.length > 300 ? '...' : '') };
}

// ── Get rollup status ─────────────────────────────────────────────────────────
export function getRollup(rollupId) {
  const r = loadRollup(rollupId);
  if (!r) return { ok: false, reason: 'Not found' };
  const submitted = Object.keys(r.contributions);
  const missing   = r.contributors.filter(c => !submitted.includes(c));
  return { ...r, submitted, missing, progress: `${submitted.length}/${r.contributors.length}`, timeLeftMin: Math.max(0, Math.round((r.deadlineAt - Date.now()) / 60000)) };
}

// ── List active rollups ───────────────────────────────────────────────────────
export function getActive() {
  try {
    return fs.readdirSync(ROLLUP_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(ROLLUP_DIR, f), 'utf8')))
      .filter(r => r.status === 'collecting')
      .sort((a, b) => a.deadlineAt - b.deadlineAt);
  } catch { return []; }
}
