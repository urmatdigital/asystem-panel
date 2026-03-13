/**
 * immutable-ledger.mjs — Tamper-Evident Append-Only Audit Ledger
 *
 * Pattern: Blockchain-inspired SHA256-chained ledger for agent actions
 *   Each entry includes hash of previous entry → any tampering breaks chain
 *   Used for: critical agent actions, security events, financial operations
 *
 * Format: JSONL where each line = { index, ts, agentId, action, data, prevHash, hash }
 *   hash = SHA256(index + ts + agentId + action + JSON(data) + prevHash)
 *
 * Verification: verify() checks every hash in chain — any corruption detected
 * Read-only after write: append only, never delete or update
 *
 * What gets ledgered (auto, from server.mjs):
 *   - Security gate violations (checkDispatch failure)
 *   - Blast radius blocks (403 responses)
 *   - Budget exceeded events (429 budget)
 *   - Throttle violations (429 throttle)
 *   - Task completions with result + score
 *   - DLQ escalations
 *   - Auto-rollbacks (canary)
 *   - Config changes (hot-config)
 *
 * API:
 *   POST /api/ledger/append   { agentId, action, data } → { index, hash }
 *   GET  /api/ledger          → last 20 entries
 *   GET  /api/ledger/verify   → { valid, entries, firstBad? }
 *   GET  /api/ledger/search?agentId=X&action=Y → filtered entries
 */

import fs            from 'node:fs';
import path          from 'node:path';
import os            from 'node:os';
import { createHash } from 'node:crypto';

const HOME        = os.homedir();
const LEDGER_FILE = path.join(HOME, '.openclaw/workspace/immutable-ledger.jsonl');

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

// ── Compute hash for an entry ─────────────────────────────────────────────────
function computeHash(index, ts, agentId, action, data, prevHash) {
  const payload = `${index}|${ts}|${agentId}|${action}|${JSON.stringify(data)}|${prevHash}`;
  return createHash('sha256').update(payload).digest('hex');
}

// ── Read last N lines ─────────────────────────────────────────────────────────
function readLines(limit = null) {
  try {
    const lines = fs.readFileSync(LEDGER_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const parsed = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return limit ? parsed.slice(-limit) : parsed;
  } catch { return []; }
}

// ── Get last entry ────────────────────────────────────────────────────────────
function getLastEntry() {
  const lines = readLines(1);
  return lines[lines.length - 1] || null;
}

// ── Append to ledger ──────────────────────────────────────────────────────────
export function ledgerAppend({ agentId = 'system', action, data = {} }) {
  const last     = getLastEntry();
  const prevHash = last?.hash || GENESIS_HASH;
  const index    = (last?.index ?? -1) + 1;
  const ts       = Date.now();

  const hash = computeHash(index, ts, agentId, action, data, prevHash);
  const entry = { index, ts, agentId, action, data, prevHash, hash };

  try { fs.appendFileSync(LEDGER_FILE, JSON.stringify(entry) + '\n'); }
  catch (e) { return { ok: false, error: e.message }; }

  return { ok: true, index, hash: hash.slice(0, 16) + '...' };
}

// ── Verify chain integrity ────────────────────────────────────────────────────
export function verifyLedger() {
  const entries = readLines();
  if (entries.length === 0) return { valid: true, entries: 0, message: 'empty ledger' };

  let prevHash = GENESIS_HASH;
  for (const entry of entries) {
    const expected = computeHash(entry.index, entry.ts, entry.agentId, entry.action, entry.data, prevHash);
    if (expected !== entry.hash) {
      return {
        valid: false, entries: entries.length,
        firstBad: { index: entry.index, ts: entry.ts, agentId: entry.agentId, action: entry.action },
        message: `Chain broken at index ${entry.index} — hash mismatch`,
      };
    }
    prevHash = entry.hash;
  }

  return { valid: true, entries: entries.length, lastHash: prevHash.slice(0, 16) + '...', message: '✅ Chain intact' };
}

// ── Get recent entries ────────────────────────────────────────────────────────
export function getLedger(limit = 20) {
  return readLines(limit).map(e => ({
    index:   e.index,
    ts:      new Date(e.ts).toISOString(),
    agentId: e.agentId,
    action:  e.action,
    data:    e.data,
    hash:    e.hash.slice(0, 12) + '...',
  }));
}

// ── Search entries ────────────────────────────────────────────────────────────
export function searchLedger({ agentId, action, limit = 50 }) {
  return readLines().filter(e =>
    (!agentId || e.agentId === agentId) &&
    (!action  || e.action  === action)
  ).slice(-limit).map(e => ({
    index: e.index, ts: new Date(e.ts).toISOString(),
    agentId: e.agentId, action: e.action, data: e.data,
    hash: e.hash.slice(0, 12) + '...',
  }));
}

// ── Auto-ledger important events ──────────────────────────────────────────────
export function ledgerEvent(action, agentId, data = {}) {
  // Non-blocking fire-and-forget
  try { ledgerAppend({ agentId, action, data }); } catch {}
}
