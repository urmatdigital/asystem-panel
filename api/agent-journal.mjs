/**
 * agent-journal.mjs — Agent Work Journal (Daily Activity Diary)
 *
 * Video: "The State of AI Agents in 2026" (HB-SDtaTy34)
 * Pattern: Each agent maintains its own daily work journal — logs decisions,
 *          reasoning, completed work, blockers, and learnings automatically
 *
 * Journal structure:
 *   Per-agent, per-day: ~/.openclaw/workspace/journals/<agentId>/<YYYY-MM-DD>.md
 *   Each journal entry includes: timestamp, task, action, outcome, reasoning
 *
 * Auto-entries triggered by:
 *   - Task dispatched       → "Started: {title}"
 *   - Task completed        → "Completed: {title} | Score: {score} | Duration: {ms}ms"
 *   - Security block        → "Blocked: {reason}"
 *   - Level up (curriculum) → "Leveled up to {level}!"
 *   - Migration             → "Handed off: {title} → {toAgent}"
 *   - Daily summary (18:00) → Auto-generated digest of the day
 *
 * Journal format (Markdown):
 *   # Agent bekzat — Work Journal 2026-03-13
 *   ## 09:14 Completed: implement JWT refresh token rotation
 *   **Score:** 9/10 | **Duration:** 4.5s | **Priority:** high
 *   **Outcome:** Added /auth/refresh endpoint with 7-day sliding window.
 *   **Learning:** Sliding window approach more robust than absolute expiry.
 *
 * API:
 *   POST /api/journal/entry  { agentId, type, title, content, score?, meta? }
 *   GET  /api/journal/:agentId          → today's journal
 *   GET  /api/journal/:agentId/:date    → specific date (YYYY-MM-DD)
 *   GET  /api/journal/summary           → all agents' today activity count
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME         = os.homedir();
const JOURNALS_DIR = path.join(HOME, '.openclaw/workspace/journals');
if (!fs.existsSync(JOURNALS_DIR)) fs.mkdirSync(JOURNALS_DIR, { recursive: true });

// ── Entry types ────────────────────────────────────────────────────────────────
const ENTRY_TEMPLATES = {
  dispatched:      (e) => `## ${ts()} 🚀 Started: ${e.title}\n**Priority:** ${e.meta?.priority || 'medium'} | **Assigned by:** ${e.meta?.from || 'system'}\n${e.content ? `**Context:** ${e.content.slice(0, 200)}\n` : ''}`,
  completed:       (e) => `## ${ts()} ✅ Completed: ${e.title}\n**Score:** ${e.score !== undefined ? `${e.score}/10` : 'N/A'} | **Duration:** ${e.meta?.durationMs ? `${Math.round(e.meta.durationMs/1000)}s` : 'N/A'} | **Priority:** ${e.meta?.priority || 'medium'}\n${e.content ? `**Outcome:** ${e.content.slice(0, 300)}\n` : ''}${e.meta?.learning ? `**Learning:** ${e.meta.learning}\n` : ''}`,
  failed:          (e) => `## ${ts()} ❌ Failed: ${e.title}\n**Reason:** ${e.content || 'Unknown'}\n${e.meta?.willRetry ? '**Action:** Will retry via DLQ.\n' : ''}`,
  blocked:         (e) => `## ${ts()} 🚫 Blocked: ${e.title}\n**Reason:** ${e.content}\n`,
  migrated:        (e) => `## ${ts()} 🔄 Handed off: ${e.title}\n**To:** ${e.meta?.toAgent} | **Reason:** ${e.meta?.reason}\n${e.content ? `**Progress:** ${e.content.slice(0, 200)}\n` : ''}`,
  level_up:        (e) => `## ${ts()} 🎓 Level Up!\n**New level:** ${e.content} | **Achievement:** ${e.title}\n`,
  note:            (e) => `## ${ts()} 📝 Note: ${e.title}\n${e.content || ''}\n`,
  daily_summary:   (e) => `## ${ts()} 📊 Daily Summary\n${e.content}\n`,
};

function ts() {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bishkek' });
}

function today() { return new Date().toISOString().slice(0, 10); }

function journalPath(agentId, date = null) {
  const dir = path.join(JOURNALS_DIR, agentId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${date || today()}.md`);
}

function ensureHeader(agentId, date = null) {
  const p = journalPath(agentId, date);
  if (!fs.existsSync(p)) {
    const d = date || today();
    fs.writeFileSync(p, `# Agent ${agentId} — Work Journal ${d}\n\n`);
  }
  return p;
}

// ── Write entry ────────────────────────────────────────────────────────────────
export function writeEntry({ agentId, type = 'note', title = '', content = '', score, meta = {} }) {
  const templateFn = ENTRY_TEMPLATES[type] || ENTRY_TEMPLATES.note;
  const entry = templateFn({ title, content, score, meta });
  const p = ensureHeader(agentId);
  fs.appendFileSync(p, entry + '\n');
  return { ok: true, agentId, type, title: title.slice(0, 50), date: today() };
}

// ── Get journal ────────────────────────────────────────────────────────────────
export function getJournal(agentId, date = null) {
  try { return fs.readFileSync(journalPath(agentId, date), 'utf8'); }
  catch { return `# Agent ${agentId} — Work Journal ${date || today()}\n\n*(No entries yet)*`; }
}

// ── Summary across agents ──────────────────────────────────────────────────────
export function getJournalSummary() {
  const AGENTS = ['forge','atlas','bekzat','ainura','marat','nurlan','dana','mesa','iron','pixel'];
  const d = today();
  return Object.fromEntries(AGENTS.map(a => {
    try {
      const content = fs.readFileSync(journalPath(a, d), 'utf8');
      const entries = (content.match(/^## /gm) || []).length;
      const completed = (content.match(/✅/g) || []).length;
      const failed = (content.match(/❌/g) || []).length;
      return [a, { entries, completed, failed, hasJournal: true }];
    } catch { return [a, { entries: 0, completed: 0, failed: 0, hasJournal: false }]; }
  }));
}

// ── Generate daily summary text ────────────────────────────────────────────────
export function generateDailySummary(agentId) {
  try {
    const content = getJournal(agentId);
    const completed = (content.match(/✅ Completed:/g) || []).length;
    const failed    = (content.match(/❌ Failed:/g) || []).length;
    const blocked   = (content.match(/🚫 Blocked:/g) || []).length;
    const migrated  = (content.match(/🔄 Handed off:/g) || []).length;
    const scoreMatches = [...content.matchAll(/Score: (\d+)\/10/g)].map(m => parseInt(m[1]));
    const avgScore  = scoreMatches.length > 0 ? Math.round(scoreMatches.reduce((s, v) => s + v, 0) / scoreMatches.length * 10) / 10 : null;

    const summary = [
      `Tasks completed: ${completed} | Failed: ${failed} | Blocked: ${blocked} | Handed off: ${migrated}`,
      avgScore !== null ? `Average quality score: ${avgScore}/10` : null,
      completed > 3 ? `Productive day! 🌟` : completed === 0 ? `No completions recorded today.` : null,
    ].filter(Boolean).join('\n');

    writeEntry({ agentId, type: 'daily_summary', title: 'End of Day', content: summary });
    return { agentId, summary, completed, failed, avgScore };
  } catch (e) { return { agentId, error: e.message }; }
}
