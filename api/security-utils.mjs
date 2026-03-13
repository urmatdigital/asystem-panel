/**
 * ASYSTEM Security Utils — inspired by OpenFang security model
 *
 * 1. PromptInjectionScanner — detect override/exfiltration attempts in task inputs
 * 2. GCRARateLimiter        — cost-aware token bucket (per agent/IP)
 * 3. LoopGuard              — SHA256-based circular dispatch detection (circuit breaker)
 *
 * Usage:
 *   import { scanInjection, rateLimiter, loopGuard } from './security-utils.mjs';
 *
 *   // In dispatch handler:
 *   const inj = scanInjection(title + ' ' + body);
 *   if (inj.blocked) return res.end(JSON.stringify({ error: inj.reason }));
 *
 *   if (!rateLimiter.allow(agentId)) return res.end(JSON.stringify({ error: 'rate limited' }));
 *
 *   if (loopGuard.isDuplicate(title + body)) return res.end(JSON.stringify({ error: 'loop detected' }));
 *   loopGuard.record(title + body);
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Prompt Injection Scanner
// ─────────────────────────────────────────────────────────────────────────────

const INJECTION_PATTERNS = [
  // Override attempts
  { re: /ignore (all |previous |above |prior )?instructions/i,   label: 'override-instructions' },
  { re: /disregard (all |previous |above |prior )?instructions/i, label: 'override-instructions' },
  { re: /forget (everything|your instructions|your guidelines)/i, label: 'override-instructions' },
  { re: /you are now (an? )?[a-z]+\s*(ai|assistant|model|bot)/i,  label: 'persona-override' },
  { re: /act as (an? |a |the )?[a-z\s]{3,30}(without|no longer|free)/i, label: 'persona-override' },
  // Data exfiltration
  { re: /print (all |your )?(system |api |secret |hidden )?keys/i,  label: 'exfil-secrets' },
  { re: /reveal (your |all |the )?(secrets|credentials|tokens|passwords|api keys)/i, label: 'exfil-secrets' },
  { re: /send (your |all |the )?(data|secrets|keys|credentials) to/i, label: 'exfil-data' },
  { re: /exfiltrate/i,  label: 'exfil-data' },
  // Shell injection in text
  { re: /`[^`]{1,200}`/,                   label: 'shell-backticks' },
  { re: /\$\([^)]{1,100}\)/,               label: 'shell-subshell' },
  { re: /;\s*(rm|wget|curl|nc|bash|sh|python|node)\s/i, label: 'shell-chain' },
  // Recursive self-dispatch (infinite loop trigger)
  { re: /dispatch.*dispatch/i,             label: 'recursive-dispatch' },
  { re: /create task.*create task/i,       label: 'recursive-task-create' },
];

const INJECTION_SCORE_THRESHOLD = 1; // 1+ pattern = blocked

/**
 * @param {string} text - task title + body
 * @returns {{ blocked: boolean, score: number, patterns: string[], reason: string }}
 */
export function scanInjection(text) {
  if (!text || typeof text !== 'string') return { blocked: false, score: 0, patterns: [] };

  const found = [];
  for (const { re, label } of INJECTION_PATTERNS) {
    if (re.test(text)) found.push(label);
  }

  const blocked = found.length >= INJECTION_SCORE_THRESHOLD;
  const reason = blocked ? `Prompt injection detected: ${found.join(', ')}` : '';

  if (blocked) {
    console.warn(`[SecurityUtils] 🚨 Injection blocked: ${found.join(', ')} in: "${text.slice(0, 80)}"`);
  }

  return { blocked, score: found.length, patterns: found, reason };
}


// ─────────────────────────────────────────────────────────────────────────────
// 2. GCRA Rate Limiter (Generic Cell Rate Algorithm)
//    Cost-aware: each dispatch "costs" tokens proportional to body length
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_RL_CONFIG = {
  windowMs:    60_000,  // 1-minute window
  maxRequests: 20,      // max 20 dispatches per agent per minute
  maxCostTokens: 5000,  // max 5000 body-chars per agent per minute
  burstFactor: 1.5,     // burst headroom
};

class GCRARateLimiter {
  constructor(config = {}) {
    this.config = { ...DEFAULT_RL_CONFIG, ...config };
    // Map: key → { requests: number, costTokens: number, windowStart: number }
    this._buckets = new Map();
    // Cleanup stale buckets every 5 min
    setInterval(() => this._cleanup(), 5 * 60_000);
  }

  /**
   * @param {string} key        - agent id or IP
   * @param {number} costTokens - body length / chars to count as "cost"
   * @returns {{ allowed: boolean, remaining: number, resetIn: number }}
   */
  allow(key, costTokens = 0) {
    const now = Date.now();
    const { windowMs, maxRequests, maxCostTokens } = this.config;

    let bucket = this._buckets.get(key);
    if (!bucket || now - bucket.windowStart > windowMs) {
      bucket = { requests: 0, costTokens: 0, windowStart: now };
    }

    const nextRequests   = bucket.requests + 1;
    const nextCostTokens = bucket.costTokens + costTokens;
    const allowed = nextRequests <= maxRequests && nextCostTokens <= maxCostTokens;

    if (allowed) {
      bucket.requests   = nextRequests;
      bucket.costTokens = nextCostTokens;
      this._buckets.set(key, bucket);
    } else {
      console.warn(`[RateLimit] ⛔ ${key}: ${nextRequests}/${maxRequests} reqs, ${nextCostTokens}/${maxCostTokens} tokens`);
    }

    return {
      allowed,
      remaining: Math.max(0, maxRequests - bucket.requests),
      resetIn:   Math.max(0, (bucket.windowStart + windowMs) - now),
    };
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, bucket] of this._buckets) {
      if (now - bucket.windowStart > this.config.windowMs * 2) {
        this._buckets.delete(key);
      }
    }
  }
}

export const rateLimiter = new GCRARateLimiter();


// ─────────────────────────────────────────────────────────────────────────────
// 3. Loop Guard — SHA256-based circular dispatch detector
//    Tracks a rolling window of recent task hashes.
//    If the same content is dispatched twice within TTL → circuit break.
// ─────────────────────────────────────────────────────────────────────────────

const LOOP_TTL_MS      = 5 * 60_000; // 5 minutes
const LOOP_MAX_ENTRIES = 256;

class LoopGuard {
  constructor() {
    // Map: hash → { count: number, firstSeen: number, lastSeen: number }
    this._seen = new Map();
    setInterval(() => this._cleanup(), 2 * 60_000);
  }

  _hash(text) {
    return createHash('sha256').update(text.slice(0, 2000)).digest('hex').slice(0, 16);
  }

  /**
   * Check if content was seen recently (potential loop)
   * @param {string} content - title + body of the task
   * @param {number} maxRepeat - how many repeats before blocking (default: 2)
   */
  isDuplicate(content, maxRepeat = 2) {
    const h = this._hash(content);
    const entry = this._seen.get(h);
    if (!entry) return false;
    const stale = Date.now() - entry.firstSeen > LOOP_TTL_MS;
    if (stale) { this._seen.delete(h); return false; }
    return entry.count >= maxRepeat;
  }

  /**
   * Record dispatch of content
   */
  record(content) {
    const h = this._hash(content);
    const now = Date.now();
    const existing = this._seen.get(h);
    if (existing && now - existing.firstSeen <= LOOP_TTL_MS) {
      existing.count++;
      existing.lastSeen = now;
    } else {
      this._seen.set(h, { count: 1, firstSeen: now, lastSeen: now });
    }
    // Evict if too large
    if (this._seen.size > LOOP_MAX_ENTRIES) {
      const oldest = [...this._seen.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      if (oldest) this._seen.delete(oldest[0]);
    }
  }

  _cleanup() {
    const now = Date.now();
    for (const [h, entry] of this._seen) {
      if (now - entry.firstSeen > LOOP_TTL_MS) this._seen.delete(h);
    }
  }

  stats() {
    return { tracked: this._seen.size, ttl_ms: LOOP_TTL_MS };
  }
}

export const loopGuard = new LoopGuard();


// ─────────────────────────────────────────────────────────────────────────────
// Convenience: run all checks in one call
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 4. Agent Trust Matrix — deterministic cross-agent dispatch validation
//    Defines which agents can task which agents (and what task types are allowed)
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_TRUST = {
  // source agent → allowed targets (null = any)
  atlas:   { targets: null,         maxPriority: 'critical' },
  forge:   { targets: null,         maxPriority: 'critical' },
  iron:    { targets: ['forge', 'atlas', 'mesa', 'nurlan', 'bekzat'], maxPriority: 'high' },
  mesa:    { targets: ['forge', 'atlas'],                              maxPriority: 'high' },
  pixel:   { targets: ['forge'],                                       maxPriority: 'medium' },
  dana:    { targets: ['forge', 'atlas', 'nurlan', 'bekzat', 'ainura', 'marat'], maxPriority: 'high' },
  nurlan:  { targets: ['forge', 'bekzat'],                             maxPriority: 'high' },
  bekzat:  { targets: ['forge'],                                       maxPriority: 'medium' },
  ainura:  { targets: ['forge'],                                       maxPriority: 'medium' },
  marat:   { targets: ['forge'],                                       maxPriority: 'medium' },
};

const PRIORITY_LEVELS = ['low', 'medium', 'high', 'critical'];

/**
 * Validate cross-agent dispatch trust
 * @param {{ from: string, to: string, priority?: string }} opts
 * @returns {{ ok: boolean, error?: string }}
 */
export function checkAgentTrust({ from, to, priority = 'medium' }) {
  if (!from || !to) return { ok: true }; // unknown source = allow (internal/system)

  const trust = AGENT_TRUST[from.toLowerCase()];
  if (!trust) return { ok: true }; // unknown agent = allow (not in matrix)

  // Check target
  if (trust.targets !== null && !trust.targets.includes(to.toLowerCase())) {
    console.warn(`[AgentTrust] ⛔ ${from} → ${to} not allowed`);
    return { ok: false, error: `Agent ${from} is not authorized to dispatch to ${to}` };
  }

  // Check priority level
  const maxIdx = PRIORITY_LEVELS.indexOf(trust.maxPriority);
  const reqIdx = PRIORITY_LEVELS.indexOf(priority.toLowerCase());
  if (reqIdx > maxIdx) {
    console.warn(`[AgentTrust] ⛔ ${from} cannot dispatch ${priority} priority (max: ${trust.maxPriority})`);
    return { ok: false, error: `Agent ${from} cannot dispatch ${priority}-priority tasks (max: ${trust.maxPriority})` };
  }

  return { ok: true };
}


// ─────────────────────────────────────────────────────────────────────────────
// 5. Protocol Gate — sensitive (non-destructive) operation detector
//    Requires explicit 'sensitive-ok' tag to proceed
// ─────────────────────────────────────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  { re: /deploy.*prod(uction)?/i,          label: 'prod-deploy' },
  { re: /push.*main|merge.*main/i,         label: 'main-branch-push' },
  { re: /send.*telegram|notify.*all/i,     label: 'broadcast-notify' },
  { re: /env|\.env|api.key|secret/i,       label: 'secrets-access' },
  { re: /sudo|root|chmod\s*7|chown/i,      label: 'elevated-exec' },
  { re: /cron|schedule|every.*minute/i,    label: 'schedule-create' },
  { re: /external.*api|webhook.*post/i,    label: 'external-api' },
  { re: /ssh.*100\.\d+\.\d+\.\d+/i,       label: 'remote-ssh' },
];

/**
 * Check if task requires 'sensitive-ok' tag
 * @param {{ title: string, body: string, tags?: string[] }} opts
 * @returns {{ ok: boolean, needsTag?: string, label?: string }}
 */
export function checkSensitive({ title = '', body = '', tags = [] }) {
  const content = `${title} ${body}`;
  if (tags.includes('sensitive-ok') || tags.includes('approved')) return { ok: true };

  for (const { re, label } of SENSITIVE_PATTERNS) {
    if (re.test(content)) {
      console.warn(`[ProtocolGate] 🔒 Sensitive op detected [${label}]: "${title.slice(0, 60)}"`);
      return { ok: false, needsTag: 'sensitive-ok', label };
    }
  }
  return { ok: true };
}


// ─────────────────────────────────────────────────────────────────────────────
// 6. Budget Gate — block dispatch if daily cost limit is approaching/exceeded
// ─────────────────────────────────────────────────────────────────────────────

const BUDGET_FILE_PATH = join(process.env.HOME || '/root', '.openclaw/workspace/.budget.json');
const BUDGET_BLOCK_THRESHOLD = 0.95; // block at 95% of daily limit

/**
 * Check current cost vs daily budget limit
 * @param {{ agentId?: string, skipForAgents?: string[] }} opts
 * @returns {{ ok: boolean, error?: string, usage?: number, limit?: number }}
 */
export function checkBudget({ agentId = '', skipForAgents = ['forge', 'atlas'] } = {}) {
  try {
    if (skipForAgents.includes(agentId.toLowerCase())) return { ok: true }; // primary agents bypass
    if (!existsSync(BUDGET_FILE_PATH)) return { ok: true }; // no budget file = no limit

    const budget = JSON.parse(readFileSync(BUDGET_FILE_PATH, 'utf8'));
    const dailyLimit = parseFloat(budget.daily_limit ?? '10');
    const dailyUsage = parseFloat(budget.daily_usage ?? budget.today_usage ?? '0');

    if (!dailyLimit || dailyLimit <= 0) return { ok: true };

    const ratio = dailyUsage / dailyLimit;
    if (ratio >= BUDGET_BLOCK_THRESHOLD) {
      console.warn(`[BudgetGate] 💸 Daily limit ${ratio >= 1 ? 'EXCEEDED' : 'NEARLY EXCEEDED'}: $${dailyUsage.toFixed(2)} / $${dailyLimit}`);
      return {
        ok: false,
        error: `Daily cost limit ${ratio >= 1 ? 'exceeded' : 'almost exceeded'} ($${dailyUsage.toFixed(2)} / $${dailyLimit})`,
        usage: dailyUsage,
        limit: dailyLimit,
      };
    }
    return { ok: true, usage: dailyUsage, limit: dailyLimit };
  } catch {
    return { ok: true }; // fail open — don't block on budget read error
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Convenience: run all checks in one call
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ agentId: string, title: string, body: string, from?: string, to?: string, priority?: string, tags?: string[] }} opts
 * @returns {{ ok: boolean, error?: string, details?: object }}
 */
export function checkDispatch({ agentId, title = '', body = '', from, to, priority = 'medium', tags = [] }) {
  const content = `${title} ${body}`.trim();

  // 1. Injection scan
  const inj = scanInjection(content);
  if (inj.blocked) {
    return { ok: false, error: inj.reason, details: { type: 'injection', patterns: inj.patterns } };
  }

  // 2. Loop guard
  if (loopGuard.isDuplicate(content)) {
    console.warn(`[LoopGuard] 🔄 Circuit breaker: "${title.slice(0, 60)}" seen multiple times`);
    return { ok: false, error: 'Loop detected: identical task dispatched repeatedly', details: { type: 'loop', hash: content.slice(0, 20) } };
  }

  // 3. Rate limit
  const cost = content.length;
  const rl = rateLimiter.allow(agentId || 'anonymous', cost);
  if (!rl.allowed) {
    return { ok: false, error: `Rate limit exceeded for agent ${agentId}`, details: { type: 'rate_limit', remaining: rl.remaining, resetIn: rl.resetIn } };
  }

  // 4. Agent trust matrix
  if (from && to) {
    const trust = checkAgentTrust({ from, to, priority });
    if (!trust.ok) {
      return { ok: false, error: trust.error, details: { type: 'trust_violation', from, to } };
    }
  }

  // 5a. Loophole protection — audit-log / MEMORY.md / SOUL.md preservation
  const loophole = checkLoophole({ title, body });
  if (!loophole.ok) {
    return { ok: false, error: loophole.error, details: { type: 'loophole_violation', protectedFiles: loophole.protectedFiles } };
  }

  // 5b. Sensitive protocol gate
  const sensitive = checkSensitive({ title, body, tags });
  if (!sensitive.ok) {
    return {
      ok: false,
      error: `Sensitive operation requires 'sensitive-ok' tag [${sensitive.label}]`,
      details: { type: 'sensitive_gate', label: sensitive.label, needsTag: sensitive.needsTag },
    };
  }

  // 6. Budget gate
  const budget = checkBudget({ agentId: agentId || from || '' });
  if (!budget.ok) {
    return { ok: false, error: budget.error, details: { type: 'budget_exceeded', usage: budget.usage, limit: budget.limit } };
  }

  // Record after all checks pass
  loopGuard.record(content);

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Loophole Protection — audit-log & critical file preservation
//    "Безопасность нового ИИ" pattern: task-level scope enforcement
//    A "clear logs" task CANNOT touch audit-log.jsonl or MEMORY.md
// ─────────────────────────────────────────────────────────────────────────────

const PROTECTED_FILES = [
  'audit-log.jsonl',
  'MEMORY.md',
  'SOUL.md',
  'AGENTS.md',
  '.env',
  '.budget.json',
  'openclaw.json',
];

const LOOPHOLE_PATTERNS = [
  { trigger: /clear.*log|delete.*log|remove.*log|clean.*log/i, protects: ['audit-log.jsonl'] },
  { trigger: /wipe.*memory|reset.*memory|clear.*memory/i, protects: ['MEMORY.md'] },
  { trigger: /reset.*config|wipe.*config/i, protects: ['.env', 'openclaw.json', '.budget.json'] },
  { trigger: /clean.*workspace|wipe.*workspace/i, protects: ['MEMORY.md', 'audit-log.jsonl', 'SOUL.md', 'AGENTS.md'] },
];

export function checkLoophole({ title = '', body = '' }) {
  const content = `${title} ${body}`.toLowerCase();
  for (const pattern of LOOPHOLE_PATTERNS) {
    if (pattern.trigger.test(content)) {
      return {
        ok: false,
        error: `Task scope violation: "${title.slice(0,60)}" matches loophole pattern. Protected files: ${pattern.protects.join(', ')}. Add explicit exclusions or use 'approved' tag.`,
        protectedFiles: pattern.protects,
      };
    }
  }
  // Check if any protected file is explicitly mentioned in body
  for (const f of PROTECTED_FILES) {
    if (body.includes(f) && (
      /delete|remove|wipe|truncate|overwrite|rm |reset/.test(body.toLowerCase())
    )) {
      return {
        ok: false,
        error: `Protected file "${f}" referenced in destructive context. Requires 'approved' tag.`,
        protectedFiles: [f],
      };
    }
  }
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIDEO: "AI Privilege Escalation: Agentic Identity & Prompt Injection Risks"
// Pattern: Input Sanitization + Least-Privilege + Decision Trace
// ═══════════════════════════════════════════════════════════════════════════════

// Jailbreak / privilege escalation patterns in incoming text
const INJECTION_ESCALATION_PATTERNS = [
  // Prompt injection attempts
  /ignore (previous|all|above|prior) instructions?/i,
  /you are now|pretend you are|act as if you are/i,
  /system:\s*you|<system>|###system/i,
  /\[INST\]|\[\/INST\]|<\|im_start\|>/i,
  // Privilege escalation
  /grant (yourself|me|us) (admin|root|full|elevated) (access|permission|privilege)/i,
  /bypass (security|auth|gate|check|approval)/i,
  /override (safety|security|restriction|limit)/i,
  /disable (logging|audit|monitoring|security)/i,
  // Data exfiltration attempts
  /send (all|my|the) (data|keys|tokens|credentials|secrets) to/i,
  /exfiltrate|exfil\b/i,
  /base64 (encode|decode).{0,50}(send|post|http)/i,
];

/**
 * Sanitize incoming text: strip control chars, truncate, detect injections.
 * Returns { ok, sanitized, warnings[] }
 */
export function sanitizeInput(text, { maxLen = 8000, source = 'unknown' } = {}) {
  if (!text || typeof text !== 'string') return { ok: true, sanitized: '', warnings: [] };

  const warnings = [];

  // 1. Strip null bytes and dangerous control characters (keep \n \t)
  let sanitized = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

  // 2. Truncate
  if (sanitized.length > maxLen) {
    warnings.push(`input truncated from ${sanitized.length} to ${maxLen} chars`);
    sanitized = sanitized.slice(0, maxLen);
  }

  // 3. Check for injection/escalation patterns
  const injectionHits = INJECTION_ESCALATION_PATTERNS
    .filter(p => p.test(sanitized))
    .map(p => p.source.slice(0, 60));

  if (injectionHits.length > 0) {
    warnings.push(`prompt injection patterns detected from ${source}: ${injectionHits.slice(0,3).join(' | ')}`);
    console.warn(`[Security] ⚠️ Injection detected from ${source}:`, injectionHits);
    return { ok: false, sanitized, warnings, injectionPatterns: injectionHits };
  }

  return { ok: true, sanitized, warnings };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pattern: Impact Radius — estimate blast radius before dispatching critical tasks
// ═══════════════════════════════════════════════════════════════════════════════

const IMPACT_SIGNALS = [
  { pattern: /database|migration|schema|drop table|alter table/i,  systems: ['database'], severity: 'high' },
  { pattern: /deploy|release|production|prod\b/i,                  systems: ['production'], severity: 'critical' },
  { pattern: /delete.*files?|rm -rf|wipe/i,                        systems: ['filesystem'], severity: 'critical' },
  { pattern: /secret|token|api.?key|credential|password/i,         systems: ['secrets'], severity: 'high' },
  { pattern: /push.*origin|merge.*main|force.?push/i,              systems: ['git'], severity: 'high' },
  { pattern: /restart|reboot|shutdown|kill.*process/i,             systems: ['services'], severity: 'medium' },
  { pattern: /email|send.*message|notify.*all/i,                   systems: ['communications'], severity: 'medium' },
  { pattern: /payment|stripe|invoice|charge/i,                     systems: ['payments'], severity: 'critical' },
];

/**
 * Estimate impact radius for a task.
 * Returns { severity, affectedSystems[], estimatedUsers, reversible, requiresApproval }
 */
export function estimateImpact({ title = '', body = '', priority = 'medium' }) {
  const content = `${title} ${body}`;
  const hits = IMPACT_SIGNALS.filter(s => s.pattern.test(content));

  const affectedSystems = [...new Set(hits.flatMap(h => h.systems))];
  const maxSeverity = hits.length === 0 ? 'low'
    : hits.some(h => h.severity === 'critical') ? 'critical'
    : hits.some(h => h.severity === 'high') ? 'high'
    : 'medium';

  const requiresApproval = maxSeverity === 'critical' || priority === 'critical';
  const reversible = !affectedSystems.some(s => ['database', 'filesystem', 'payments'].includes(s));

  return {
    severity: maxSeverity,
    affectedSystems,
    signalCount: hits.length,
    reversible,
    requiresApproval,
    summary: affectedSystems.length
      ? `Affects: ${affectedSystems.join(', ')} | severity: ${maxSeverity}`
      : 'No critical systems affected',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pattern: Decision Trace — log WHY (reasoning) not just WHAT (event)
// ═══════════════════════════════════════════════════════════════════════════════
import os  from 'node:os';
import fss from 'node:fs';

const DECISION_LOG = `${os.homedir()}/.openclaw/workspace/decision-trace.jsonl`;

/**
 * Append a decision trace entry: what happened + why.
 */
export function traceDecision({ type, actor, taskId, decision, reasoning, gates = [], impact = null }) {
  try {
    const entry = {
      ts: Date.now(), iso: new Date().toISOString(),
      type, actor, taskId,
      decision,   // 'allowed' | 'blocked' | 'escalated' | 'dispatched'
      reasoning,  // human-readable WHY
      gates,      // which security gates ran + results
      impact,     // estimateImpact() result if available
    };
    fss.appendFileSync(DECISION_LOG, JSON.stringify(entry) + '\n');
  } catch {}
}
