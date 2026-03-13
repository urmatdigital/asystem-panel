/**
 * versioned-memory.mjs — Versioned Memory with Git-like Rollback
 *
 * Video: "Letta Office Hours: MemFS, Letta Chat, and the future of AI agent memory" (p7So3IM75WY)
 * Pattern: MemFS — every memory write creates a versioned commit.
 *          Can rollback to ANY prior state. Like git but for agent memory.
 *
 * Structure:
 *   ~/.openclaw/workspace/.vmem/<agentId>/
 *     HEAD           → current commit hash
 *     commits/       → <hash>.json  (content + metadata + parent)
 *     index.json     → chronological list of commits per key
 *
 * Operations:
 *   write(agentId, key, value)   → new commit (like git commit)
 *   read(agentId, key)           → current HEAD value
 *   log(agentId, key)            → commit history for key
 *   rollback(agentId, key, hash) → restore prior commit
 *   diff(agentId, key, hashA, hashB) → show what changed
 *   snapshot(agentId)            → full memory state at HEAD
 *
 * Use cases:
 *   - Agent learns wrong fact → rollback 3 commits
 *   - Canary test corrupts memory → rollback to pre-canary state
 *   - A/B test memory approaches → branch, compare, merge winner
 *
 * API:
 *   POST /api/vmem/write      { agentId, key, value, message? }
 *   GET  /api/vmem/read/:agentId/:key
 *   GET  /api/vmem/log/:agentId/:key
 *   POST /api/vmem/rollback   { agentId, key, hash }
 *   GET  /api/vmem/snapshot/:agentId
 *   GET  /api/vmem/diff/:agentId/:key/:hashA/:hashB
 */

import fs     from 'node:fs';
import path   from 'node:path';
import os     from 'node:os';
import crypto from 'node:crypto';

const HOME     = os.homedir();
const VMEM_DIR = path.join(HOME, '.openclaw/workspace/.vmem');
if (!fs.existsSync(VMEM_DIR)) fs.mkdirSync(VMEM_DIR, { recursive: true });

// ── Paths ─────────────────────────────────────────────────────────────────────
function agentDir(agentId) {
  const d = path.join(VMEM_DIR, agentId);
  if (!fs.existsSync(d))              fs.mkdirSync(d, { recursive: true });
  if (!fs.existsSync(path.join(d, 'commits'))) fs.mkdirSync(path.join(d, 'commits'));
  return d;
}
function commitPath(agentId, hash)  { return path.join(agentDir(agentId), 'commits', `${hash}.json`); }
function indexPath(agentId)          { return path.join(agentDir(agentId), 'index.json'); }

function loadIndex(agentId) { try { return JSON.parse(fs.readFileSync(indexPath(agentId), 'utf8')); } catch { return {}; } }
function saveIndex(agentId, idx) { fs.writeFileSync(indexPath(agentId), JSON.stringify(idx, null, 2)); }

// ── Generate commit hash ───────────────────────────────────────────────────────
function makeHash(agentId, key, value, ts) {
  return crypto.createHash('sha1').update(`${agentId}:${key}:${JSON.stringify(value)}:${ts}`).digest('hex').slice(0, 12);
}

// ── Write (commit) ─────────────────────────────────────────────────────────────
export function write({ agentId, key, value, message = '' }) {
  const ts      = Date.now();
  const hash    = makeHash(agentId, key, value, ts);
  const idx     = loadIndex(agentId);

  // Parent = previous HEAD for this key
  const parent  = idx[key]?.length > 0 ? idx[key][idx[key].length - 1].hash : null;

  const commit  = { hash, agentId, key, value, message: message || `write ${key}`, parent, ts, authorTs: new Date().toISOString() };
  fs.writeFileSync(commitPath(agentId, hash), JSON.stringify(commit, null, 2));

  if (!idx[key]) idx[key] = [];
  idx[key].push({ hash, ts, message: commit.message });
  saveIndex(agentId, idx);

  console.log(`[VMem] 📝 ${agentId}/${key} → commit ${hash} (parent: ${parent || 'root'})`);
  return { ok: true, hash, key, parent, agentId };
}

// ── Read HEAD ─────────────────────────────────────────────────────────────────
export function read(agentId, key) {
  const idx = loadIndex(agentId);
  if (!idx[key] || idx[key].length === 0) return { ok: false, reason: 'Key not found' };
  const head = idx[key][idx[key].length - 1];
  try {
    const commit = JSON.parse(fs.readFileSync(commitPath(agentId, head.hash), 'utf8'));
    return { ok: true, key, value: commit.value, hash: head.hash, ts: head.ts, message: head.message };
  } catch { return { ok: false, reason: 'Commit file missing' }; }
}

// ── Log (commit history) ──────────────────────────────────────────────────────
export function log(agentId, key, limit = 10) {
  const idx = loadIndex(agentId);
  if (!idx[key]) return { ok: true, key, commits: [] };
  const commits = idx[key].slice(-limit).reverse().map(c => ({ hash: c.hash, ts: c.ts, message: c.message, date: new Date(c.ts).toISOString() }));
  return { ok: true, key, commits, total: idx[key].length };
}

// ── Rollback ──────────────────────────────────────────────────────────────────
export function rollback({ agentId, key, hash }) {
  try {
    const target = JSON.parse(fs.readFileSync(commitPath(agentId, hash), 'utf8'));
    // Write a NEW commit pointing to the rolled-back value (non-destructive)
    const result = write({ agentId, key, value: target.value, message: `rollback to ${hash}` });
    console.log(`[VMem] ⏪ ${agentId}/${key} rolled back to ${hash} → new commit ${result.hash}`);
    return { ok: true, rolledBackTo: hash, newCommit: result.hash, value: target.value };
  } catch (e) { return { ok: false, reason: `Commit ${hash} not found: ${e.message}` }; }
}

// ── Diff ──────────────────────────────────────────────────────────────────────
export function diff(agentId, key, hashA, hashB) {
  try {
    const a = JSON.parse(fs.readFileSync(commitPath(agentId, hashA), 'utf8'));
    const b = JSON.parse(fs.readFileSync(commitPath(agentId, hashB), 'utf8'));
    const valA = JSON.stringify(a.value, null, 2);
    const valB = JSON.stringify(b.value, null, 2);
    return { ok: true, key, hashA, hashB, changed: valA !== valB, fromMessage: a.message, toMessage: b.message, fromValue: a.value, toValue: b.value };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ── Snapshot (full memory at HEAD) ────────────────────────────────────────────
export function snapshot(agentId) {
  const idx = loadIndex(agentId);
  const state = {};
  for (const [key, commits] of Object.entries(idx)) {
    if (commits.length === 0) continue;
    const head = commits[commits.length - 1];
    try {
      const commit = JSON.parse(fs.readFileSync(commitPath(agentId, head.hash), 'utf8'));
      state[key] = { value: commit.value, hash: head.hash, lastUpdated: head.ts };
    } catch {}
  }
  return { ok: true, agentId, keys: Object.keys(state).length, snapshot: state, ts: Date.now() };
}
