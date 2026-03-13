/**
 * narrative.mjs — Agent Self-Narrative Generator
 *
 * Pattern: Agent explains its own work in readable, human-friendly summary
 *   Each dispatch/completion generates a "story" of what happened and why.
 *   Useful for: daily digests, sprint reviews, stakeholder reports, debugging.
 *
 * Narrative templates (3 levels):
 *   BRIEF (1 sentence): "bekzat implemented JWT auth in ORGON — score 8/10 ✅"
 *   STANDARD (3 sentences): what + how + outcome
 *   DETAILED (paragraph): full pipeline trace + decisions + learnings
 *
 * Sprint narrative: synthesize last N tasks into a sprint story
 *   "This sprint, the team completed 12 tasks. bekzat led with 4 high-quality
 *    implementations. marat caught 2 critical security bugs via review..."
 *
 * API:
 *   POST /api/narrative/task     { taskId, agentId, title, result, score, priority, pipelineMs } → { brief, standard }
 *   POST /api/narrative/sprint   { agentIds?, limit? } → sprint summary narrative
 *   GET  /api/narrative/feed     → last 10 task narratives (timeline feed)
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const NARR_LOG  = path.join(HOME, '.openclaw/workspace/narrative-feed.jsonl');

// ── Score emoji ───────────────────────────────────────────────────────────────
function scoreEmoji(score) {
  if (score === undefined || score === null) return '📋';
  if (score >= 9) return '🌟';
  if (score >= 7) return '✅';
  if (score >= 5) return '⚠️';
  return '❌';
}

// ── Intent verb from title ────────────────────────────────────────────────────
function extractVerb(title = '') {
  const verbs = ['implemented','fixed','reviewed','deployed','documented','researched','tested','configured','built','created','refactored','analyzed','set up'];
  const low = title.toLowerCase();
  const found = verbs.find(v => low.startsWith(v.slice(0,-2)) || low.includes(v));
  return found || 'worked on';
}

// ── Generate task narrative ───────────────────────────────────────────────────
export function generateTaskNarrative({ taskId, agentId = 'agent', title = '', result = '', score, priority = 'medium', pipelineMs }) {
  const verb  = extractVerb(title);
  const emoji = scoreEmoji(score);
  const scoreStr = score !== undefined ? ` (score ${score}/10)` : '';
  const timeStr  = pipelineMs ? ` in ${Math.round(pipelineMs / 1000)}s` : '';
  const prioStr  = priority === 'critical' ? ' [CRITICAL]' : priority === 'high' ? ' [HIGH]' : '';

  // Brief: one sentence
  const brief = `${emoji} **${agentId}** ${verb} "${title}"${scoreStr}${prioStr}${timeStr}`;

  // Standard: 3 sentences
  const resultPreview = result ? ` Result: ${String(result).slice(0, 100).replace(/\n/g, ' ')}` : '';
  const standard = `${brief}.${resultPreview}${score >= 8 ? ' High quality output — added to team knowledge base.' : score < 5 && score !== undefined ? ' Quality below threshold — flagged for review and improvement.' : ''}`;

  const entry = { ts: Date.now(), taskId, agentId, title: title.slice(0, 60), score, priority, brief, standard };
  try { fs.appendFileSync(NARR_LOG, JSON.stringify(entry) + '\n'); } catch {}

  return { brief, standard, emoji, agentId, title, score, priority };
}

// ── Generate sprint narrative ─────────────────────────────────────────────────
export function generateSprintNarrative(agentIds = [], limit = 20) {
  try {
    const lines = fs.readFileSync(NARR_LOG, 'utf8').trim().split('\n').filter(Boolean);
    const entries = lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const filtered = agentIds.length > 0 ? entries.filter(e => agentIds.includes(e.agentId)) : entries;

    if (filtered.length === 0) return { narrative: 'No tasks recorded yet.', stats: {} };

    // Stats
    const total   = filtered.length;
    const done    = filtered.filter(e => e.score !== undefined);
    const avgScore = done.length > 0 ? Math.round(done.reduce((s, e) => s + e.score, 0) / done.length * 10) / 10 : null;
    const byAgent = {};
    for (const e of filtered) {
      if (!byAgent[e.agentId]) byAgent[e.agentId] = { count: 0, totalScore: 0, high: 0 };
      byAgent[e.agentId].count++;
      if (e.score !== undefined) { byAgent[e.agentId].totalScore += e.score; if (e.score >= 8) byAgent[e.agentId].high++; }
    }

    // Top performer
    const topAgent = Object.entries(byAgent).sort((a, b) => b[1].count - a[1].count)[0];
    const highQuality = filtered.filter(e => e.score >= 8).length;
    const needsReview = filtered.filter(e => e.score < 5 && e.score !== undefined).length;

    // Narrative sentences
    const sentences = [
      `📊 **Sprint Summary** — ${total} task${total !== 1 ? 's' : ''} completed${avgScore !== null ? ` with avg quality ${avgScore}/10` : ''}.`,
    ];
    if (topAgent) sentences.push(`🏆 **${topAgent[0]}** led with ${topAgent[1].count} task${topAgent[1].count !== 1 ? 's' : ''}.`);
    if (highQuality > 0) sentences.push(`✅ ${highQuality} high-quality outputs (score ≥8) added to team knowledge.`);
    if (needsReview > 0) sentences.push(`⚠️ ${needsReview} task${needsReview !== 1 ? 's' : ''} flagged for improvement review.`);

    // Agent breakdown
    const agentLines = Object.entries(byAgent).map(([a, d]) => {
      const avg = d.count > 0 ? Math.round(d.totalScore / d.count * 10) / 10 : null;
      return `  • ${a}: ${d.count} tasks${avg !== null ? `, avg ${avg}/10` : ''}${d.high > 0 ? `, ${d.high}★` : ''}`;
    });
    sentences.push('\n**By agent:**\n' + agentLines.join('\n'));

    return { narrative: sentences.join(' '), stats: { total, avgScore, byAgent, highQuality, needsReview } };
  } catch (e) { return { narrative: `Error: ${e.message}`, stats: {} }; }
}

// ── Feed ──────────────────────────────────────────────────────────────────────
export function getNarrativeFeed(limit = 10) {
  try {
    const lines = fs.readFileSync(NARR_LOG, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { return []; }
}
