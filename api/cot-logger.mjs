/**
 * cot-logger.mjs — Chain-of-Thought Visibility & Decision Audit
 *
 * Video: "Agentic AI Full Course 2026 | Tutorial For Beginners" (2R-niMsB0QY)
 * Pattern: Visible CoT = explainable AI + compliance audit trail
 *
 * Every dispatch records WHY a decision was made (which layers fired, what scores,
 * what was injected) so any action is fully auditable.
 *
 * CoT entry = {
 *   traceId, taskId, ts, to, title, priority,
 *   reasoning: [{layer, decision, value}],
 *   pipeline_ms, total_layers_fired
 * }
 *
 * API:
 *   GET  /api/cot/:traceId — full reasoning chain for a trace
 *   GET  /api/cot          — recent CoT entries (last 20)
 *   POST /api/cot/append   { traceId, layer, decision, value } — append step
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME    = os.homedir();
const COT_DIR = path.join(HOME, '.openclaw/workspace/cot/');

// Ensure dir exists
try { fs.mkdirSync(COT_DIR, { recursive: true }); } catch {}

function cotPath(traceId) { return path.join(COT_DIR, `${traceId}.json`); }

// ── Start a CoT entry ─────────────────────────────────────────────────────────
export function cotStart({ traceId, taskId, to, title, priority }) {
  const entry = { traceId, taskId, to, title: (title || '').slice(0, 80), priority, startedAt: Date.now(), reasoning: [], pipeline_ms: 0 };
  try { fs.writeFileSync(cotPath(traceId), JSON.stringify(entry, null, 2)); } catch {}
  return entry;
}

// ── Append a reasoning step ───────────────────────────────────────────────────
export function cotAppend(traceId, layer, decision, value = '') {
  try {
    const p = cotPath(traceId);
    const entry = JSON.parse(fs.readFileSync(p, 'utf8'));
    entry.reasoning.push({ layer, decision, value: String(value).slice(0, 100), ts: Date.now() });
    entry.pipeline_ms = Date.now() - entry.startedAt;
    entry.total_layers_fired = entry.reasoning.length;
    fs.writeFileSync(p, JSON.stringify(entry, null, 2));
  } catch {}
}

// ── Finalize (mark complete) ──────────────────────────────────────────────────
export function cotFinish(traceId, outcome = 'dispatched') {
  try {
    const p = cotPath(traceId);
    const entry = JSON.parse(fs.readFileSync(p, 'utf8'));
    entry.outcome = outcome;
    entry.pipeline_ms = Date.now() - entry.startedAt;
    entry.completedAt = Date.now();
    fs.writeFileSync(p, JSON.stringify(entry, null, 2));
  } catch {}
}

// ── Get CoT for trace ─────────────────────────────────────────────────────────
export function getCot(traceId) {
  try { return JSON.parse(fs.readFileSync(cotPath(traceId), 'utf8')); }
  catch { return null; }
}

// ── List recent CoT entries ───────────────────────────────────────────────────
export function listCot(limit = 20) {
  try {
    const files = fs.readdirSync(COT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort((a, b) => {
        try { return fs.statSync(cotPath(b.slice(0, -5))).mtimeMs - fs.statSync(cotPath(a.slice(0, -5))).mtimeMs; }
        catch { return 0; }
      })
      .slice(0, limit);
    return files.map(f => {
      try { const e = JSON.parse(fs.readFileSync(path.join(COT_DIR, f), 'utf8')); return { traceId: e.traceId, to: e.to, title: e.title, layers: e.total_layers_fired, ms: e.pipeline_ms, outcome: e.outcome }; }
      catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}
