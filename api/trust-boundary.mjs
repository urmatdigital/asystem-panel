/**
 * trust-boundary.mjs — Zero-Trust Agent Identity & Trust Boundary Enforcement
 *
 * Video: "Agentic AI Expands the Attack Surface: Securing AI with Zero Trust" (BcRGgnjcxww)
 * Pattern: NCC Group + OWASP Agentic AI Top 10 — every agent request treated as untrusted.
 *   Never trust the caller; always verify. Separate identities per agent.
 *   Prevents: goal hijacking, prompt injection, tool misuse, memory poisoning.
 *
 * Trust levels:
 *   SOVEREIGN   (0) — forge/atlas internal calls — full trust
 *   PEER        (1) — known agents in ASYSTEM network — standard trust
 *   EXTERNAL    (2) — webhooks, API calls with token — limited trust
 *   ANONYMOUS   (3) — unknown source — minimal, read-only
 *   UNTRUSTED   (4) — flagged source — reject, log, alert iron
 *
 * Checks performed for every agent-to-agent call:
 *   1. IDENTITY  — is the caller a known agent with a registered identity?
 *   2. TOKEN     — does the provided token match the registered identity?
 *   3. PRIVILEGE — does caller have privilege to invoke this action?
 *   4. INJECTION — does the task body contain prompt injection patterns?
 *   5. BOUNDARY  — is cross-boundary data flow allowed? (low→high privilege OK, high→low NOT)
 *   6. RATE      — has this caller exceeded its per-minute call limit?
 *
 * Registered identities (ASYSTEM network):
 *   forge:  SOVEREIGN  | atlas: SOVEREIGN
 *   bekzat: PEER       | ainura: PEER | marat: PEER | nurlan: PEER
 *   dana:   PEER       | mesa:  PEER  | iron:  PEER | pixel: PEER
 *
 * API:
 *   POST /api/trust/verify   { callerId, callerToken, targetAgent, action, body? }
 *   POST /api/trust/register { agentId, token, level } → register/update identity
 *   GET  /api/trust/report   → trust violations report
 *   GET  /api/trust/identities → registered identities (tokens redacted)
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import crypto from 'node:crypto';

const HOME        = os.homedir();
const TRUST_FILE  = path.join(HOME, '.openclaw/workspace/.trust-registry.json');
const TRUST_LOG   = path.join(HOME, '.openclaw/workspace/trust-violations.jsonl');
const RATE_FILE   = path.join(HOME, '.openclaw/workspace/.trust-rate.json');

// ── Trust levels ──────────────────────────────────────────────────────────────
const TRUST_LEVEL = { SOVEREIGN: 0, PEER: 1, EXTERNAL: 2, ANONYMOUS: 3, UNTRUSTED: 4 };

// ── Default identities ────────────────────────────────────────────────────────
const DEFAULT_IDENTITIES = {
  forge:  { level: 'SOVEREIGN', token: hash('forge-sovereign-2026'),  rateLimit: 1000, allowedActions: ['*'] },
  atlas:  { level: 'SOVEREIGN', token: hash('atlas-sovereign-2026'),  rateLimit: 1000, allowedActions: ['*'] },
  bekzat: { level: 'PEER',      token: hash('bekzat-peer-2026'),      rateLimit: 60,   allowedActions: ['dispatch', 'read', 'write', 'complete'] },
  ainura: { level: 'PEER',      token: hash('ainura-peer-2026'),      rateLimit: 60,   allowedActions: ['dispatch', 'read', 'write', 'complete'] },
  marat:  { level: 'PEER',      token: hash('marat-peer-2026'),       rateLimit: 60,   allowedActions: ['dispatch', 'read', 'write', 'complete'] },
  nurlan: { level: 'PEER',      token: hash('nurlan-peer-2026'),      rateLimit: 60,   allowedActions: ['dispatch', 'read', 'write', 'complete', 'deploy'] },
  dana:   { level: 'PEER',      token: hash('dana-peer-2026'),        rateLimit: 30,   allowedActions: ['dispatch', 'read', 'write'] },
  mesa:   { level: 'PEER',      token: hash('mesa-peer-2026'),        rateLimit: 60,   allowedActions: ['dispatch', 'read', 'write', 'analyze'] },
  iron:   { level: 'PEER',      token: hash('iron-peer-2026'),        rateLimit: 120,  allowedActions: ['dispatch', 'read', 'write', 'complete', 'security', 'alert'] },
  pixel:  { level: 'PEER',      token: hash('pixel-peer-2026'),       rateLimit: 30,   allowedActions: ['dispatch', 'read', 'write'] },
};

function hash(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 32); }

// ── Prompt injection patterns ──────────────────────────────────────────────────
const INJECTION_PATTERNS = [
  /ignore (previous|all|prior) (instructions|rules|constraints)/i,
  /you are now (a|an|the)/i,
  /disregard your (instructions|training|system|prompt)/i,
  /forget (everything|all|your)/i,
  /new (instructions|directive|task|role):/i,
  /\[SYSTEM\]/i,
  /act as if you (are|were|have no)/i,
  /bypass (safety|security|restrictions|guardrails)/i,
];

// ── Load registry ─────────────────────────────────────────────────────────────
function loadRegistry() { try { return JSON.parse(fs.readFileSync(TRUST_FILE, 'utf8')); } catch { return DEFAULT_IDENTITIES; } }
function saveRegistry(d) { try { fs.writeFileSync(TRUST_FILE, JSON.stringify(d, null, 2)); } catch {} }

// ── Rate limiting ─────────────────────────────────────────────────────────────
function checkRate(callerId, limit) {
  const now = Date.now();
  let rates;
  try { rates = JSON.parse(fs.readFileSync(RATE_FILE, 'utf8')); } catch { rates = {}; }
  if (!rates[callerId]) rates[callerId] = { count: 0, windowStart: now };
  // Reset window every minute
  if (now - rates[callerId].windowStart > 60000) { rates[callerId] = { count: 0, windowStart: now }; }
  rates[callerId].count++;
  try { fs.writeFileSync(RATE_FILE, JSON.stringify(rates)); } catch {}
  return rates[callerId].count <= limit;
}

// ── Verify trust ──────────────────────────────────────────────────────────────
export function verify({ callerId, callerToken, targetAgent, action = 'dispatch', body = '' }) {
  const registry = loadRegistry();
  const violations = [];

  // 1. IDENTITY check
  const identity = registry[callerId];
  if (!identity) {
    const v = { check: 'IDENTITY', passed: false, reason: `Unknown caller: ${callerId}` };
    violations.push(v);
    return buildResult(false, callerId, targetAgent, violations, 'ANONYMOUS');
  }

  // 2. TOKEN check (skip for sovereign if no token provided)
  if (identity.level !== 'SOVEREIGN' || callerToken) {
    const expectedToken = identity.token;
    const providedToken = callerToken || '';
    if (providedToken !== expectedToken) {
      const v = { check: 'TOKEN', passed: false, reason: `Token mismatch for ${callerId}` };
      violations.push(v);
      return buildResult(false, callerId, targetAgent, violations, identity.level);
    }
  }

  // 3. PRIVILEGE check
  const allowedActions = identity.allowedActions || [];
  if (!allowedActions.includes('*') && !allowedActions.includes(action)) {
    violations.push({ check: 'PRIVILEGE', passed: false, reason: `${callerId} not allowed to perform '${action}'` });
    return buildResult(false, callerId, targetAgent, violations, identity.level);
  }

  // 4. INJECTION check
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(bodyText)) {
      violations.push({ check: 'INJECTION', passed: false, reason: `Prompt injection detected: ${pattern}` });
      fs.appendFileSync(TRUST_LOG, JSON.stringify({ ts: Date.now(), type: 'INJECTION', callerId, targetAgent, pattern: pattern.toString() }) + '\n');
      return buildResult(false, callerId, targetAgent, violations, identity.level);
    }
  }

  // 5. BOUNDARY check (high-privilege agents cannot be instructed by low-privilege to do sensitive ops)
  const callerLevelNum = TRUST_LEVEL[identity.level] || 3;
  const targetIdentity = registry[targetAgent];
  const targetLevelNum = targetIdentity ? TRUST_LEVEL[targetIdentity.level] || 1 : 3;
  const SENSITIVE_ACTIONS = ['delete', 'drop', 'rm', 'truncate', 'security', 'deploy'];
  if (callerLevelNum > targetLevelNum && SENSITIVE_ACTIONS.includes(action)) {
    violations.push({ check: 'BOUNDARY', passed: false, reason: `${callerId}(${identity.level}) cannot instruct ${targetAgent}(${targetIdentity?.level}) to perform '${action}'` });
    return buildResult(false, callerId, targetAgent, violations, identity.level);
  }

  // 6. RATE check
  if (!checkRate(callerId, identity.rateLimit || 60)) {
    violations.push({ check: 'RATE', passed: false, reason: `Rate limit exceeded for ${callerId} (limit: ${identity.rateLimit}/min)` });
    return buildResult(false, callerId, targetAgent, violations, identity.level);
  }

  console.log(`[TrustBoundary] ✅ ${callerId}(${identity.level}) → ${targetAgent} [${action}] VERIFIED`);
  return { ok: true, callerId, targetAgent, action, trustLevel: identity.level, checks: ['IDENTITY', 'TOKEN', 'PRIVILEGE', 'INJECTION', 'BOUNDARY', 'RATE'].map(c => ({ check: c, passed: true })) };
}

function buildResult(ok, callerId, targetAgent, violations, level) {
  if (!ok) {
    const v = violations[violations.length - 1];
    console.log(`[TrustBoundary] ❌ ${callerId}(${level}) → ${targetAgent}: ${v.check} FAILED — ${v.reason}`);
    fs.appendFileSync(TRUST_LOG, JSON.stringify({ ts: Date.now(), callerId, targetAgent, violation: v.check, reason: v.reason }) + '\n');
  }
  return { ok, callerId, targetAgent, trustLevel: level, violations, blocked: !ok };
}

export function getViolations(limit = 20) {
  try { return fs.readFileSync(TRUST_LOG, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map(l => JSON.parse(l)).reverse(); }
  catch { return []; }
}

export function getIdentities() {
  const reg = loadRegistry();
  return Object.entries(reg).map(([id, d]) => ({ agentId: id, level: d.level, rateLimit: d.rateLimit, allowedActions: d.allowedActions, tokenHash: d.token?.slice(0, 8) + '...' }));
}

export function registerIdentity({ agentId, token, level = 'EXTERNAL', rateLimit = 10, allowedActions = ['read'] }) {
  const reg = loadRegistry();
  reg[agentId] = { level, token: hash(token), rateLimit, allowedActions };
  saveRegistry(reg);
  return { ok: true, agentId, level, rateLimit };
}
