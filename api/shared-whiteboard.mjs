/**
 * shared-whiteboard.mjs — Agent Coordination via Shared Scratchpad
 *
 * Video: "The Real Frontier of AI (2026): Agents, Multimodal Models, Next Architecture" (_WYiaeLwfeQ)
 * Pattern: Instead of agents sending direct messages to each other (tight coupling),
 *   they all write to and read from a SHARED WHITEBOARD — a structured scratchpad
 *   that acts as the coordination layer.
 *
 * Inspired by:
 *   - NASA mission control: all team members write/read shared status board
 *   - Blackboard architecture (classic AI): agents post observations, others react
 *   - Modern: shared context window as coordination primitive
 *
 * Whiteboard sections:
 *   STATUS      — agent declares what it's doing: { agentId, task, since, eta }
 *   BLOCKERS    — agent posts what it's blocked on: { agentId, blocker, waitingFor }
 *   FINDINGS    — agent posts discoveries others should know: { agentId, key, value }
 *   HANDOFFS    — agent marks a subtask ready for pickup: { from, to?, title, context }
 *   DECISIONS   — agent records a decision made: { agentId, decision, rationale }
 *   ALERTS      — agent posts something urgent all should see: { agentId, alert, severity }
 *
 * Agents poll the whiteboard (via getSection / getBoard) to:
 *   - See what others are working on (avoid duplication)
 *   - Pick up HANDOFFS addressed to them (or any)
 *   - React to BLOCKERS they can resolve
 *   - See ALERTS without being directly pinged
 *
 * TTL: each entry expires after its section TTL (auto-cleaned on read)
 *   STATUS: 30min | BLOCKERS: 2h | FINDINGS: 24h | HANDOFFS: 4h | DECISIONS: 7d | ALERTS: 1h
 *
 * API:
 *   POST /api/wb/write   { agentId, section, content } → write to whiteboard
 *   GET  /api/wb/read    → full whiteboard (all sections)
 *   GET  /api/wb/:section → specific section
 *   POST /api/wb/pickup  { agentId, handoffId } → claim a handoff
 *   DELETE /api/wb/clear { agentId, section? } → clear own entries
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME    = os.homedir();
const WB_FILE = path.join(HOME, '.openclaw/workspace/.whiteboard.json');
const WB_LOG  = path.join(HOME, '.openclaw/workspace/whiteboard-log.jsonl');

// ── Section TTLs ──────────────────────────────────────────────────────────────
const SECTION_TTL = {
  STATUS:    30 * 60 * 1000,       // 30 min
  BLOCKERS:  2 * 60 * 60 * 1000,  // 2h
  FINDINGS:  24 * 60 * 60 * 1000, // 24h
  HANDOFFS:  4 * 60 * 60 * 1000,  // 4h
  DECISIONS: 7 * 24 * 60 * 60 * 1000, // 7d
  ALERTS:    60 * 60 * 1000,       // 1h
};

const VALID_SECTIONS = Object.keys(SECTION_TTL);

// ── Load / save whiteboard ────────────────────────────────────────────────────
function loadWB() {
  try {
    const raw = JSON.parse(fs.readFileSync(WB_FILE, 'utf8'));
    return raw;
  } catch {
    const init = {};
    for (const s of VALID_SECTIONS) init[s] = [];
    return init;
  }
}

function saveWB(wb) { try { fs.writeFileSync(WB_FILE, JSON.stringify(wb, null, 2)); } catch {} }

// ── Clean expired entries ─────────────────────────────────────────────────────
function cleanExpired(wb) {
  const now = Date.now();
  for (const section of VALID_SECTIONS) {
    const ttl = SECTION_TTL[section];
    if (wb[section]) {
      wb[section] = wb[section].filter(entry => {
        // Keep claimed handoffs for 10 more min (so claimer knows)
        if (entry.claimed && section === 'HANDOFFS') return now - entry.claimedAt < 10 * 60 * 1000;
        return now - entry.ts < ttl;
      });
    } else {
      wb[section] = [];
    }
  }
  return wb;
}

// ── Write to whiteboard ───────────────────────────────────────────────────────
export function write({ agentId, section, content }) {
  section = section.toUpperCase();
  if (!VALID_SECTIONS.includes(section)) {
    return { ok: false, reason: `Invalid section: ${section}. Valid: ${VALID_SECTIONS.join(', ')}` };
  }

  let wb = loadWB();
  wb     = cleanExpired(wb);

  const entryId = `wb_${section.toLowerCase()}_${agentId}_${Date.now()}`;
  const entry   = { id: entryId, agentId, ts: Date.now(), ...content };

  // STATUS: one per agent (overwrite)
  if (section === 'STATUS') {
    wb.STATUS = wb.STATUS.filter(e => e.agentId !== agentId);
  }

  wb[section].push(entry);
  saveWB(wb);

  fs.appendFileSync(WB_LOG, JSON.stringify({ ts: Date.now(), agentId, section, id: entryId }) + '\n');
  console.log(`[Whiteboard] ✍️  ${agentId} → [${section}]: ${JSON.stringify(content).slice(0, 60)}`);
  return { ok: true, entryId, section, agentId };
}

// ── Read whiteboard ───────────────────────────────────────────────────────────
export function read(section = null) {
  let wb = loadWB();
  wb = cleanExpired(wb);
  saveWB(wb);  // persist cleanup

  if (section) {
    const s = section.toUpperCase();
    if (!VALID_SECTIONS.includes(s)) return { ok: false, reason: `Invalid section: ${s}` };
    return { ok: true, section: s, entries: wb[s] || [], count: (wb[s] || []).length };
  }

  // Full board with summary
  const summary = {};
  for (const s of VALID_SECTIONS) summary[s] = (wb[s] || []).length;
  return { ok: true, board: wb, summary, totalEntries: Object.values(summary).reduce((a, b) => a + b, 0) };
}

// ── Claim a HANDOFF ───────────────────────────────────────────────────────────
export function pickup({ agentId, handoffId }) {
  let wb = loadWB();
  wb = cleanExpired(wb);

  const handoff = wb.HANDOFFS.find(h => h.id === handoffId && !h.claimed);
  if (!handoff) return { ok: false, reason: `Handoff ${handoffId} not found or already claimed` };

  handoff.claimed   = true;
  handoff.claimedBy = agentId;
  handoff.claimedAt = Date.now();
  saveWB(wb);

  console.log(`[Whiteboard] 🤝 ${agentId} picked up handoff from ${handoff.agentId}: "${handoff.title?.slice(0, 40)}"`);
  return { ok: true, handoff };
}

// ── Clear own entries ─────────────────────────────────────────────────────────
export function clear({ agentId, section = null }) {
  let wb = loadWB();
  const sections = section ? [section.toUpperCase()] : VALID_SECTIONS;
  for (const s of sections) {
    if (wb[s]) wb[s] = wb[s].filter(e => e.agentId !== agentId);
  }
  saveWB(wb);
  return { ok: true, agentId, cleared: sections };
}

// ── Find handoffs available for a specific agent ──────────────────────────────
export function getMyHandoffs(agentId) {
  let wb = loadWB();
  wb = cleanExpired(wb);
  return (wb.HANDOFFS || []).filter(h => !h.claimed && (!h.to || h.to === agentId));
}
