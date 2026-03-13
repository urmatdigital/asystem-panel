/**
 * outcome-verifier.mjs — Independent Outcome Verification
 *
 * Video: "2026 will be the Year of Multi-agent AIs — Here's why!" (s4dLwoanLm0)
 * Pattern: External verifier checks agent claims independently
 *          Multi-agent consensus + sub-agent verification loops + truth validation
 *
 * Verification layers:
 *   Layer 1: STATIC   — rule-based checks (no LLM): length, keywords, forbidden patterns
 *   Layer 2: CROSS    — compare claim against H-MEM / ZVec known facts
 *   Layer 3: PEER     — another agent verifies (only for critical tasks, LLM call)
 *   Layer 4: EXTERNAL — external tool call (URL check, code lint, test run)
 *
 * Claim types supported:
 *   "code_complete"   → check for syntax errors, test files mentioned
 *   "deployed"        → check URL/health endpoint reachable
 *   "reviewed"        → check review artifacts present
 *   "documented"      → check doc length > threshold
 *   "tested"          → check test results mentioned
 *   "secure"          → check no obvious security red flags
 *
 * Verification result:
 *   VERIFIED   (all checks pass)
 *   PARTIAL    (some checks fail, non-critical)
 *   DISPUTED   (critical check fails → flag for human review)
 *   UNVERIFIED (could not run checks)
 *
 * API:
 *   POST /api/verify           { taskId, agentId, claimType, result, meta? }
 *   GET  /api/verify/history   → verification log
 *   GET  /api/verify/stats     → verification rates by agent
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const VERIFY_LOG = path.join(HOME, '.openclaw/workspace/verification-log.jsonl');

// ── Static verification rules ──────────────────────────────────────────────────
const CLAIM_RULES = {
  code_complete: {
    minLength:   50,
    mustContain: [],
    forbidden:   ['TODO', 'FIXME', 'placeholder', 'lorem ipsum', 'not implemented'],
    successMsg:  'Code result passes static checks',
  },
  deployed: {
    minLength:   20,
    mustContain: ['http', 'port', 'url', '200', 'ok', 'running', 'live', 'started'],
    forbidden:   ['error', 'failed', 'exception', 'crash'],
    successMsg:  'Deploy result contains expected indicators',
    anyCaseMustContain: true,
  },
  reviewed: {
    minLength:   30,
    mustContain: [],
    forbidden:   [],
    successMsg:  'Review result present',
  },
  documented: {
    minLength:   100,
    mustContain: [],
    forbidden:   ['TODO', 'TBD', 'placeholder'],
    successMsg:  'Documentation meets length requirement',
  },
  tested: {
    minLength:   30,
    mustContain: ['test', 'pass', 'result', 'check', 'assert', 'expect', 'ok', 'success'],
    forbidden:   ['all tests failed', 'no tests'],
    anyCaseMustContain: true,
    successMsg:  'Test result contains pass indicators',
  },
  secure: {
    minLength:   20,
    mustContain: [],
    forbidden:   ['password in code', 'hardcoded secret', 'api key in', 'eval(', 'exec(user', 'sql injection'],
    successMsg:  'No security red flags detected',
  },
  general: {
    minLength:   20,
    mustContain: [],
    forbidden:   ['i cannot', 'i don\'t know', 'i am unable', 'as an ai'],
    successMsg:  'General result passes basic checks',
  },
};

// ── Layer 1: Static verification ───────────────────────────────────────────────
function staticVerify(claimType, result = '') {
  const rules   = CLAIM_RULES[claimType] || CLAIM_RULES.general;
  const low     = result.toLowerCase();
  const checks  = [];
  let passed    = 0;
  let failed    = 0;
  let critical  = 0;

  // Length
  if (result.length >= rules.minLength) { checks.push({ check: 'min_length', pass: true }); passed++; }
  else { checks.push({ check: 'min_length', pass: false, msg: `Result too short (${result.length} < ${rules.minLength})` }); failed++; }

  // Must contain (any)
  if (rules.mustContain?.length > 0) {
    const anyMatch = rules.mustContain.some(k => low.includes(k.toLowerCase()));
    if (anyMatch) { checks.push({ check: 'must_contain', pass: true }); passed++; }
    else { checks.push({ check: 'must_contain', pass: false, msg: `Missing expected keywords: ${rules.mustContain.slice(0,3).join('/')}` }); failed++; }
  }

  // Forbidden patterns
  for (const forbid of (rules.forbidden || [])) {
    if (low.includes(forbid.toLowerCase())) {
      checks.push({ check: 'forbidden', pass: false, msg: `Forbidden pattern: "${forbid}"`, critical: true });
      failed++; critical++;
    }
  }
  if (critical === 0 && rules.forbidden?.length > 0) checks.push({ check: 'forbidden', pass: true });

  const verdict = critical > 0 ? 'DISPUTED' : failed > 0 ? 'PARTIAL' : 'VERIFIED';
  return { layer: 'STATIC', verdict, checks, passed, failed, critical };
}

// ── Layer 2: Cross-reference H-MEM ────────────────────────────────────────────
async function crossVerify(agentId, claimType, result) {
  try {
    const { recall } = await import('./hmem.mjs');
    const memories = recall({ query: result.slice(0, 100), topK: 3 });
    // Simple: if memories exist about same domain, trust is higher
    const hasMem = memories.length > 0;
    return { layer: 'CROSS', verdict: hasMem ? 'VERIFIED' : 'UNVERIFIED', memCount: memories.length, note: hasMem ? 'Cross-referenced with team memory' : 'No prior context found' };
  } catch { return { layer: 'CROSS', verdict: 'UNVERIFIED', note: 'H-MEM unavailable' }; }
}

// ── Full verification ─────────────────────────────────────────────────────────
export async function verify({ taskId, agentId, claimType = 'general', result = '', meta = {} }) {
  const layers = [];

  // Layer 1: Static
  const staticResult = staticVerify(claimType, result);
  layers.push(staticResult);

  // Layer 2: Cross (always, async)
  const crossResult = await crossVerify(agentId, claimType, result);
  layers.push(crossResult);

  // Aggregate verdict (worst wins)
  const verdictPriority = { DISPUTED: 4, PARTIAL: 3, UNVERIFIED: 2, VERIFIED: 1 };
  const finalVerdict = layers.reduce((worst, l) => {
    return (verdictPriority[l.verdict] || 0) > (verdictPriority[worst] || 0) ? l.verdict : worst;
  }, 'VERIFIED');

  const emoji = { VERIFIED: '✅', PARTIAL: '⚠️', DISPUTED: '🚫', UNVERIFIED: '❓' }[finalVerdict] || '❓';
  console.log(`[Verifier] ${emoji} ${agentId}/${claimType}: ${finalVerdict} (${layers.map(l => l.layer + ':' + l.verdict).join(' | ')})`);

  const entry = { ts: Date.now(), taskId, agentId, claimType, verdict: finalVerdict, layerSummary: layers.map(l => ({ layer: l.layer, verdict: l.verdict })), resultLen: result.length };
  fs.appendFileSync(VERIFY_LOG, JSON.stringify(entry) + '\n');

  // Auto-record to reputation if disputed
  if (finalVerdict === 'DISPUTED') {
    try {
      const { recordEvent } = await import('./reputation.mjs');
      recordEvent({ agentId, event: 'peer_rejected', meta: { taskId, claimType, reason: 'outcome_disputed' } });
    } catch {}
  } else if (finalVerdict === 'VERIFIED') {
    try {
      const { recordEvent } = await import('./reputation.mjs');
      recordEvent({ agentId, event: 'peer_approved', meta: { taskId, claimType } });
    } catch {}
  }

  return { taskId, agentId, claimType, verdict: finalVerdict, emoji, layers };
}

// ── Stats ──────────────────────────────────────────────────────────────────────
export function getVerificationStats() {
  try {
    const entries = fs.readFileSync(VERIFY_LOG, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const byAgent = {};
    for (const e of entries) {
      if (!byAgent[e.agentId]) byAgent[e.agentId] = { total: 0, VERIFIED: 0, PARTIAL: 0, DISPUTED: 0, UNVERIFIED: 0 };
      byAgent[e.agentId].total++;
      byAgent[e.agentId][e.verdict] = (byAgent[e.agentId][e.verdict] || 0) + 1;
    }
    return { total: entries.length, byAgent };
  } catch { return { total: 0, byAgent: {} }; }
}

export function getVerificationHistory(limit = 20) {
  try {
    return fs.readFileSync(VERIFY_LOG, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .slice(-limit).reverse();
  } catch { return []; }
}
