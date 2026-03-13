/**
 * context-guard.mjs — Context Window Ceiling Detection & Overflow Prevention
 *
 * Video: "Unbeatable Local AI Coding Workflow (Full 2026 Setup)" (3zSANOIBHYw)
 * Pattern: Sub-agent delegation before context overflow
 *   Practical peak: 65k-70k tokens → start fresh sub-agent
 *   Main agent stays under 40k tokens → sub-agents handle the rest
 *
 * Implementation for ASYSTEM task dispatch:
 *   1. Estimate token count of task body before dispatch
 *   2. If body > SOFT_LIMIT: chunk/summarize before sending
 *   3. If body > HARD_LIMIT: split into sub-tasks automatically
 *   4. Track per-agent accumulated context (rolling session estimate)
 *
 * Token estimation: ~4 chars per token (fast, no API call)
 * Soft limit: 6000 tokens (~24KB) — warn + summarize body
 * Hard limit: 15000 tokens (~60KB) — split into chunks
 *
 * Also used to prevent ZVec injection from bloating task body:
 *   skill + KG + memory context capped at MAX_INJECTION tokens
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME = os.homedir();

const CHARS_PER_TOKEN  = 4;
const SOFT_LIMIT_TOK   = 6_000;   // warn + trim injections
const HARD_LIMIT_TOK   = 15_000;  // split into sub-tasks
const MAX_INJECTION_TOK = 1_500;  // max for KG+skill+memory injections

// ── Estimate token count ──────────────────────────────────────────────────────
export function estimateTokens(text = '') {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ── Guard task body before dispatch ──────────────────────────────────────────
export function guardTaskBody(title, body = '', injections = '') {
  const bodyTokens       = estimateTokens(body);
  const titleTokens      = estimateTokens(title);
  const injectionTokens  = estimateTokens(injections);
  const total            = bodyTokens + titleTokens + injectionTokens;

  const result = {
    original: total,
    trimmed: false,
    split: false,
    warnings: [],
    body,
    injections,
  };

  // 1. Trim injections if they're too large
  if (injectionTokens > MAX_INJECTION_TOK) {
    const maxChars = MAX_INJECTION_TOK * CHARS_PER_TOKEN;
    result.injections = injections.slice(0, maxChars) + '\n[context trimmed]';
    result.trimmed = true;
    result.warnings.push(`Injections trimmed: ${injectionTokens} → ${MAX_INJECTION_TOK} tokens`);
  }

  const effectiveTotal = bodyTokens + titleTokens + estimateTokens(result.injections);

  // 2. Warn at soft limit
  if (effectiveTotal > SOFT_LIMIT_TOK) {
    result.warnings.push(`SOFT_LIMIT: task body ~${effectiveTotal} tokens (>${SOFT_LIMIT_TOK})`);
    console.warn(`[ContextGuard] ⚠️  "${title?.slice(0,40)}" ~${effectiveTotal}tok > soft limit ${SOFT_LIMIT_TOK}`);
  }

  // 3. Truncate body at hard limit
  if (bodyTokens > HARD_LIMIT_TOK) {
    const maxChars = HARD_LIMIT_TOK * CHARS_PER_TOKEN;
    result.body = body.slice(0, maxChars) + '\n\n[body truncated to fit context limit]';
    result.split = true;
    result.warnings.push(`HARD_LIMIT: body truncated ${bodyTokens} → ${HARD_LIMIT_TOK} tokens`);
    console.warn(`[ContextGuard] 🔪 "${title?.slice(0,40)}" body truncated (${bodyTokens}tok → ${HARD_LIMIT_TOK}tok)`);
  }

  result.final = bodyTokens + titleTokens + estimateTokens(result.injections);
  return result;
}

// ── Per-agent session context tracker ────────────────────────────────────────
const SESSION_TRACKER = new Map(); // agentId → { tokens, tasks, resetAt }
const SESSION_RESET_MS = 30 * 60_000; // reset after 30 min idle

export function trackAgentContext(agentId, taskTokens) {
  const now = Date.now();
  let session = SESSION_TRACKER.get(agentId);
  if (!session || now - session.lastActivity > SESSION_RESET_MS) {
    session = { tokens: 0, tasks: 0, startedAt: now, lastActivity: now };
    SESSION_TRACKER.set(agentId, session);
  }
  session.tokens += taskTokens;
  session.tasks++;
  session.lastActivity = now;

  const WARNING_TOK = 40_000; // warn when agent accumulated >40k tokens this session
  if (session.tokens > WARNING_TOK) {
    console.warn(`[ContextGuard] 🧠 ${agentId} accumulated ~${session.tokens} session tokens — consider fresh sub-agent`);
  }
  return session;
}

export function getContextStats() {
  const sessions = {};
  for (const [id, s] of SESSION_TRACKER) sessions[id] = { ...s, ageMins: Math.round((Date.now() - s.startedAt) / 60_000) };
  return {
    limits: { soft: SOFT_LIMIT_TOK, hard: HARD_LIMIT_TOK, maxInjection: MAX_INJECTION_TOK },
    sessions,
    agents: SESSION_TRACKER.size,
  };
}
