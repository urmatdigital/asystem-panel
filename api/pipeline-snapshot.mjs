/**
 * pipeline-snapshot.mjs — Pipeline Execution Visualizer
 *
 * Video: "You're Not Behind (Yet): How to Build AI Agents in 2026" (ibFJ--CH3cQ)
 * Pattern: Make agent pipeline execution visible — text-based flowchart showing
 *          which layers ran, how long each took, what was injected/blocked
 *
 * Snapshot captures per-dispatch:
 *   - Layer name + duration + status (PASS/SKIP/BLOCK/HIT)
 *   - Context injections (KG, EMPO2, distilled, federated, social)
 *   - Security decisions (which gates fired)
 *   - Final routing (agent, model, priority)
 *   - Total pipeline time
 *
 * Output formats:
 *   TEXT: ASCII flowchart for logs/Telegram
 *   JSON: structured for dashboard visualization
 *
 * Visual example:
 *   ┌─────────────────────────────────┐
 *   │ DISPATCH: "implement JWT auth"  │
 *   │ → bekzat | high | sonnet-4-6   │
 *   └─────────────────────────────────┘
 *        │ [0ms]  Federated Knowledge: 2 facts injected
 *        │ [1ms]  Prompt Cache: MISS
 *        │ [0ms]  Blast Radius: PASS
 *        │ [0ms]  Throttle: PASS (8/100 hourly)
 *        │ [1ms]  Security Gates: PASS (7/7)
 *        │ [2ms]  H-MEM: 3 traces recalled [orgon/api]
 *        │ [0ms]  Intent: ambiguity=0.2 → PROCEED
 *        │ [1ms]  Distilled Knowledge: 1 forge tip
 *        │ [0ms]  Social Doctrine: none
 *        │ [1ms]  Adaptive Prompt: [high_score_expert]
 *        ▼ [6ms]  → Dispatched to bekzat ✅
 *
 * API:
 *   POST /api/pipeline/start  { dispatchId, title, to, priority } → start snapshot
 *   POST /api/pipeline/layer  { dispatchId, layer, status, durationMs, detail? }
 *   POST /api/pipeline/finish { dispatchId, outcome } → close + render
 *   GET  /api/pipeline/recent → last 10 snapshots
 *   GET  /api/pipeline/:dispatchId → specific snapshot
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const SNAP_DIR  = path.join(HOME, '.openclaw/workspace/pipeline-snaps');
const SNAP_IDX  = path.join(HOME, '.openclaw/workspace/.pipeline-index.json');
if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true });

const STATUS_ICONS = { PASS: '✅', SKIP: '⏭️', BLOCK: '🚫', HIT: '💾', MISS: '💨', INJECT: '💉', WARN: '⚠️', ERROR: '❌' };

// ── Start snapshot ─────────────────────────────────────────────────────────────
export function startSnapshot({ dispatchId, title, to, priority, model }) {
  const snap = {
    dispatchId, title: title?.slice(0, 60), to, priority, model,
    startMs: Date.now(), layers: [], finished: false,
  };
  saveSnap(dispatchId, snap);
  return { ok: true, dispatchId };
}

// ── Add layer ─────────────────────────────────────────────────────────────────
export function addLayer({ dispatchId, layer, status = 'PASS', durationMs = 0, detail = null }) {
  const snap = loadSnap(dispatchId);
  if (!snap) return { ok: false, reason: 'Snapshot not found' };
  snap.layers.push({ layer, status, durationMs, detail, ts: Date.now() });
  saveSnap(dispatchId, snap);
  return { ok: true };
}

// ── Finish + render ────────────────────────────────────────────────────────────
export function finishSnapshot({ dispatchId, outcome = 'dispatched' }) {
  const snap = loadSnap(dispatchId);
  if (!snap) return { ok: false, reason: 'Snapshot not found' };
  snap.finished = true;
  snap.outcome  = outcome;
  snap.totalMs  = Date.now() - snap.startMs;
  snap.text     = renderText(snap);
  saveSnap(dispatchId, snap);

  // Update index
  const idx = loadIndex();
  idx.unshift(dispatchId);
  if (idx.length > 100) idx.splice(100);
  saveIndex(idx);

  return { ok: true, dispatchId, totalMs: snap.totalMs, text: snap.text };
}

// ── Render ASCII flowchart ────────────────────────────────────────────────────
function renderText(snap) {
  const title  = snap.title || 'Unknown task';
  const header = `┌${'─'.repeat(Math.min(title.length + 4, 50))}┐\n│ ${title.slice(0, 46)} │\n│ → ${snap.to || '?'} | ${snap.priority || 'medium'} | ${(snap.model || '?').split('/').pop()}\n└${'─'.repeat(Math.min(title.length + 4, 50))}┘`;

  const layers = snap.layers.map(l => {
    const icon   = STATUS_ICONS[l.status] || '•';
    const ms     = l.durationMs > 0 ? `[${l.durationMs}ms]` : '[0ms]';
    const detail = l.detail ? `: ${String(l.detail).slice(0, 50)}` : '';
    return `     │ ${ms.padEnd(6)} ${l.layer}${detail} ${icon}`;
  }).join('\n');

  const outcome = snap.outcome === 'dispatched' ? '✅ Dispatched' : snap.outcome === 'blocked' ? '🚫 Blocked' : `📋 ${snap.outcome}`;
  const footer  = `     ▼ [${snap.totalMs}ms total] ${outcome}`;
  return [header, layers, footer].join('\n');
}

// ── IO ────────────────────────────────────────────────────────────────────────
function snapPath(id) { return path.join(SNAP_DIR, `${id}.json`); }
function loadSnap(id) { try { return JSON.parse(fs.readFileSync(snapPath(id), 'utf8')); } catch { return null; } }
function saveSnap(id, d) { try { fs.writeFileSync(snapPath(id), JSON.stringify(d, null, 2)); } catch {} }
function loadIndex() { try { return JSON.parse(fs.readFileSync(SNAP_IDX, 'utf8')); } catch { return []; } }
function saveIndex(d) { try { fs.writeFileSync(SNAP_IDX, JSON.stringify(d)); } catch {} }

// ── Get recent ────────────────────────────────────────────────────────────────
export function getRecentSnapshots(limit = 10) {
  const idx = loadIndex().slice(0, limit);
  return idx.map(id => {
    const snap = loadSnap(id);
    if (!snap) return null;
    return { dispatchId: id, title: snap.title, to: snap.to, outcome: snap.outcome, totalMs: snap.totalMs, layers: snap.layers.length, ts: snap.startMs };
  }).filter(Boolean);
}

export function getSnapshot(dispatchId) { return loadSnap(dispatchId); }

// ── Quick helper: snapshot entire standard dispatch pipeline ──────────────────
export function snapshotDispatch(dispatchId, title, to, priority, model, layers = []) {
  startSnapshot({ dispatchId, title, to, priority, model });
  for (const l of layers) addLayer({ dispatchId, ...l });
  return finishSnapshot({ dispatchId, outcome: 'dispatched' });
}
