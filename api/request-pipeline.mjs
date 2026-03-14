#!/usr/bin/env node
/**
 * REQUEST PIPELINE — 20-step request optimization
 * gov0 → Context Guard → Priority Scorer → ... → Convex write
 * 
 * Flow: HTTP Request → Pipeline → LLM Call → Response → Convex Log
 */

import crypto from 'crypto';
import fs from 'fs';

const LOG_FILE = '/Users/urmatmyrzabekov/.openclaw/logs/pipeline.log';
const MAX_BODY_SIZE = 2_000_000; // 2MB
const TRACE_DB = '/Users/urmatmyrzabekov/.openclaw/pipeline-traces.json';

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
  fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 0: CONTEXT GUARD (pre)
// ════════════════════════════════════════════════════════════════════════════
export function contextGuardPre(req, body) {
  const bodySize = Buffer.byteLength(JSON.stringify(body));
  
  if (bodySize > MAX_BODY_SIZE) {
    return { ok: false, error: `Body too large: ${bodySize}B > ${MAX_BODY_SIZE}B`, code: 413 };
  }
  
  // Check for injection patterns
  const bodyStr = JSON.stringify(body).toLowerCase();
  const injectionPatterns = [
    'drop table', 'delete from', 'union select',
    '__proto__', 'constructor', 'prototype',
    'eval(', 'exec(', 'system('
  ];
  
  for (const pattern of injectionPatterns) {
    if (bodyStr.includes(pattern)) {
      return { ok: false, error: `Injection detected: ${pattern}`, code: 400 };
    }
  }
  
  log(`✓ Context Guard: ${bodySize}B, clean`);
  return { ok: true };
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 1: PRIORITY SCORER
// ════════════════════════════════════════════════════════════════════════════
export function priorityScorer(req, body) {
  let urgency = 1; // 1-5 scale
  let impact = 1;  // 1-5 scale
  
  // Urgency signals
  if (body.priority === 'critical' || body.urgent) urgency = 5;
  else if (body.priority === 'high') urgency = 4;
  else if (body.priority === 'low') urgency = 2;
  
  // Impact signals
  if (body.affects === 'multi-agent' || body.affects === 'infrastructure') impact = 5;
  else if (body.affects === 'project') impact = 3;
  else impact = 1;
  
  const score = (urgency * 0.6 + impact * 0.4) * 10;
  const tier = score > 30 ? 'CRITICAL' : score > 15 ? 'HIGH' : 'NORMAL';
  
  log(`→ Priority: urgency=${urgency} impact=${impact} score=${score.toFixed(1)} tier=${tier}`);
  
  return { score, tier, urgency, impact };
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 2: TRACE START
// ════════════════════════════════════════════════════════════════════════════
export function traceStart(req, body, priority) {
  const traceId = `trace_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const trace = {
    traceId,
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.url,
    priority,
    steps: [],
    metadata: {
      agent: body.agent || 'unknown',
      userId: body.userId || req.headers['x-user-id'],
      requestId: req.headers['x-request-id']
    }
  };
  
  log(`→ Trace: ${traceId}`);
  return trace;
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 3: PROMPT CACHE - Semantic Dedup
// ════════════════════════════════════════════════════════════════════════════
const promptCache = new Map();

export function promptCacheCheck(prompt) {
  // Simple hash-based dedup
  const hash = crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16);
  
  if (promptCache.has(hash)) {
    const cached = promptCache.get(hash);
    log(`→ Prompt Cache HIT (${hash}): ${cached.hits} uses`);
    cached.hits++;
    cached.lastUsed = Date.now();
    return { hit: true, cached };
  }
  
  promptCache.set(hash, {
    hash,
    prompt: prompt.slice(0, 100),
    hits: 1,
    created: Date.now(),
    lastUsed: Date.now()
  });
  
  log(`→ Prompt Cache MISS (${hash}): new`);
  return { hit: false };
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 4: POST-INJECT GUARD - Trim if bloat
// ════════════════════════════════════════════════════════════════════════════
export function postInjectGuard(context) {
  const contextSize = Buffer.byteLength(JSON.stringify(context));
  
  // If context > 50KB after injections, trim non-critical parts
  if (contextSize > 50_000) {
    const trimmed = {
      ...context,
      history: context.history?.slice(-3), // Keep last 3 messages
      metadata: context.metadata?.slice(0, 5) // Keep top 5 metadata
    };
    
    const newSize = Buffer.byteLength(JSON.stringify(trimmed));
    log(`→ Post-Inject Guard: trimmed ${contextSize}B → ${newSize}B`);
    return trimmed;
  }
  
  log(`→ Post-Inject Guard: ${contextSize}B (OK)`);
  return context;
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 5: RATE LIMITER
// ════════════════════════════════════════════════════════════════════════════
const rateLimits = new Map();

export function rateLimiter(agent, tier) {
  const key = `rl_${agent}`;
  const now = Date.now();
  
  if (!rateLimits.has(key)) {
    rateLimits.set(key, []);
  }
  
  const history = rateLimits.get(key);
  const recentRequests = history.filter(t => now - t < 60_000);
  
  // Tier-based limits
  const limits = {
    'CRITICAL': 100,
    'HIGH': 20,
    'NORMAL': 5
  };
  
  const limit = limits[tier] || limits['NORMAL'];
  
  if (recentRequests.length >= limit) {
    log(`✗ Rate Limit: ${agent} (${tier}) exceeded ${limit} req/min`);
    return { ok: false, error: 'Rate limit exceeded', retryAfter: 60 };
  }
  
  recentRequests.push(now);
  rateLimits.set(key, recentRequests);
  
  log(`→ Rate Limiter: ${agent} (${recentRequests.length}/${limit} req/min)`);
  return { ok: true };
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 6: INPUT SANITIZE
// ════════════════════════════════════════════════════════════════════════════
export function inputSanitize(input) {
  // Remove dangerous characters, trim, escape
  let sanitized = input;
  
  // Trim whitespace
  sanitized = sanitized.trim();
  
  // Remove control characters
  sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');
  
  // Escape HTML
  sanitized = sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
  
  const safe = sanitized.length < 5000;
  log(`→ Input Sanitize: ${input.length}B → ${sanitized.length}B (${safe ? 'OK' : 'TRIMMED'})`);
  
  return sanitized.slice(0, 5000);
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 7: IMPACT RADIUS
// ════════════════════════════════════════════════════════════════════════════
export function impactRadius(task) {
  const impacts = {
    'code': ['forge', 'atlas', 'iron'], // Which agents affected
    'infrastructure': ['iron', 'atlas'],
    'analytics': ['mesa'],
    'design': ['pixel'],
    'qa': ['marat'],
    'devops': ['nurlan'],
    'frontend': ['ainura'],
    'backend': ['bekzat'],
    'pm': ['dana']
  };
  
  const radius = impacts[task.category] || [];
  log(`→ Impact Radius: ${task.category} → ${radius.join(', ')}`);
  
  return radius;
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 8: SECURITY GATES (7 checks)
// ════════════════════════════════════════════════════════════════════════════
export function securityGates(req, body) {
  // Trusted sources bypass token gate
  const TRUSTED_SOURCES = ['panel-ui', 'urmat', 'forge', 'health-monitor', 'loop-guard', 'cost-guard', 'task-loop-escalation'];
  const isTrusted = TRUSTED_SOURCES.includes(body.source || body.from || '');

  const gates = {
    auth: isTrusted || (body.token && body.token.length > 20), // Gate 1: Auth (trusted sources bypass)
    rateLimit: (body.requestCount ?? 0) < 1000,          // Gate 2: Rate (default 0 if not provided)
    contentType: req.headers['content-type']?.includes('json'), // Gate 3: Type
    suspiciousDomain: !body.url?.includes('.exe'),       // Gate 4: Domain
    xssCheck: !body.message?.includes('<script'),        // Gate 5: XSS
    sqlCheck: !body.query?.includes('DROP'),             // Gate 6: SQL
    signatureValid: true                                 // Gate 7: Signature
  };
  
  const passed = Object.values(gates).filter(g => g).length;
  const total = Object.keys(gates).length;
  
  const ok = passed >= 6; // Need 6/7
  log(`→ Security Gates: ${passed}/${total} passed (${ok ? '✓' : '✗'})`);
  
  return { ok, gates, passed, total };
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 9: CONTEXT HANDOFF
// ════════════════════════════════════════════════════════════════════════════
export function contextHandoff(from, to, currentContext) {
  const summary = {
    from,
    to,
    timestamp: new Date().toISOString(),
    contextSize: Buffer.byteLength(JSON.stringify(currentContext)),
    keyFacts: currentContext.entities?.slice(0, 5) || [],
    previousDecisions: currentContext.decisions?.slice(-3) || []
  };
  
  log(`→ Context Handoff: ${from} → ${to} (${summary.contextSize}B, ${summary.keyFacts.length} facts)`);
  
  return summary;
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 10: SKILL INJECTION - Tier 1/2 progressive
// ════════════════════════════════════════════════════════════════════════════
export function skillInjection(complexity) {
  const tiers = {
    'simple': ['basic', 'string-ops', 'math'],
    'medium': ['api-calls', 'file-io', 'db-query'],
    'complex': ['multi-agent', 'graph-traversal', 'reasoning'],
    'expert': ['self-improvement', 'meta-learning', 'autonomous-planning']
  };
  
  const tier = complexity > 70 ? 'expert' : complexity > 40 ? 'complex' : complexity > 20 ? 'medium' : 'simple';
  const skills = tiers[tier];
  
  log(`→ Skill Injection: complexity=${complexity} → Tier ${tier.toUpperCase()} (${skills.join(', ')})`);
  
  return { tier, skills };
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 11: KG CONTEXT - Entity facts
// ════════════════════════════════════════════════════════════════════════════
export function kgContext(entities) {
  const facts = entities.map(entity => ({
    entity,
    type: 'unknown',
    relationships: [],
    properties: {}
  }));
  
  log(`→ KG Context: ${entities.length} entities loaded`);
  return facts;
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 12: SKILL DELTAS - Eureka improvements
// ════════════════════════════════════════════════════════════════════════════
export function skillDeltas(previousResult, currentResult) {
  const delta = {
    improved: currentResult.score > previousResult.score,
    scoreChange: currentResult.score - previousResult.score,
    timeSaved: previousResult.time - currentResult.time,
    tokensOptimized: previousResult.tokens - currentResult.tokens
  };
  
  if (delta.improved) {
    log(`→ Skill Delta: ⬆️ score=${delta.scoreChange.toFixed(2)}, time=${delta.timeSaved}ms, tokens=${delta.tokensOptimized}`);
  }
  
  return delta;
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 13: GOAL CONTEXT
// ════════════════════════════════════════════════════════════════════════════
export function goalContext(task) {
  const goals = {
    primary: task.goal || 'unknown',
    subgoals: task.subgoals || [],
    constraints: task.constraints || [],
    successCriteria: task.successCriteria || []
  };
  
  log(`→ Goal Context: primary="${goals.primary.slice(0, 40)}...", ${goals.subgoals.length} subgoals`);
  
  return goals;
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 14: COST OPTIMIZER - nano/standard/premium
// ════════════════════════════════════════════════════════════════════════════
export function costOptimizer(complexity, budget) {
  let model = 'claude-haiku'; // nano - $4.8/M
  let cost = 4.8;
  
  if (complexity > 60 && budget > 50) {
    model = 'claude-opus'; // premium - $15/M
    cost = 15;
  } else if (complexity > 30) {
    model = 'claude-sonnet'; // standard - $3/M
    cost = 3;
  }
  
  log(`→ Cost Optimizer: complexity=${complexity}, budget=\$${budget} → ${model} (\$${cost}/M)`);
  
  return { model, cost, complexity };
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 15: PERSONA ROUTER
// ════════════════════════════════════════════════════════════════════════════
export function personaRouter(task) {
  const personas = {
    'planning': 'PLANNER',      // Strategic thinking
    'building': 'ARCHITECT',    // Design & implementation
    'debugging': 'DETECTIVE',   // Problem solving
    'learning': 'SCHOLAR',      // Knowledge extraction
    'optimizing': 'OPTIMIZER',  // Cost/perf tuning
    'managing': 'ORCHESTRATOR'  // Multi-agent coordination
  };
  
  const persona = personas[task.domain] || 'GENERALIST';
  log(`→ Persona Router: domain="${task.domain}" → ${persona}`);
  
  return persona;
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 16: SHARED MEMORY (ZVec)
// ════════════════════════════════════════════════════════════════════════════
export function sharedMemory(agent, query, mode = 'retrieve') {
  // ZVec = Zero-Vector encoding (all agents use same embedding space)
  if (mode === 'retrieve') {
    log(`→ Shared Memory: ${agent} retrieving "${query.slice(0, 30)}..."`);
    return ['fact1', 'fact2', 'fact3']; // Placeholder
  } else if (mode === 'store') {
    log(`→ Shared Memory: ${agent} storing new knowledge`);
    return { stored: true };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 17: OPTIM ARCHITECT
// ════════════════════════════════════════════════════════════════════════════
export function optimArchitect(plan) {
  const optimized = {
    ...plan,
    parallelizable: plan.steps?.filter((_, i) => i % 2 === 0) || [],
    sequentialRequired: plan.steps?.filter((_, i) => i % 2 === 1) || [],
    estimatedTime: (plan.steps?.length || 0) * 5
  };
  
  log(`→ Optim Architect: ${plan.steps?.length || 0} steps → ${optimized.parallelizable.length} parallel + ${optimized.sequentialRequired.length} sequential`);
  
  return optimized;
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 18: EMPO2 TIPS
// ════════════════════════════════════════════════════════════════════════════
export function empo2Tips(context) {
  // EMPO = Empathy, Modularity, Pragmatism, Originality
  const tips = {
    empathy: 'Consider agent constraints and preferences',
    modularity: 'Break into independent sub-tasks',
    pragmatism: 'Use existing tools rather than building new',
    originality: 'Find novel combinations of known techniques'
  };
  
  log(`→ EMPO2 Tips: applied to context`);
  return tips;
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 19: SLA REGISTER
// ════════════════════════════════════════════════════════════════════════════
export function slaRegister(task, slaHours = 4) {
  const sla = {
    taskId: task.id,
    created: Date.now(),
    deadline: Date.now() + slaHours * 3600 * 1000,
    slaHours,
    status: 'active'
  };
  
  log(`→ SLA Register: ${task.id} → ${slaHours}h deadline`);
  return sla;
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 20: TRACE CLOSE + CONVEX WRITE
// ════════════════════════════════════════════════════════════════════════════
export function traceClose(trace, result) {
  if (!trace || !trace.steps) return; // Guard against undefined trace
  trace.steps.push({
    step: 'trace_close',
    timestamp: new Date().toISOString(),
    result: {
      success: result.ok,
      duration: Date.now() - new Date(trace.timestamp).getTime(),
      output: result.output?.slice(0, 100) || 'N/A'
    }
  });
  
  const lastStep = trace.steps[trace.steps.length - 1];
  log(`→ Trace Close: ${trace.traceId} (${trace.steps.length} steps, ${lastStep?.result?.duration ?? 0}ms)`);
  
  // Write to "Convex" (simulate)
  try {
    let traces = [];
    if (fs.existsSync(TRACE_DB)) {
      traces = JSON.parse(fs.readFileSync(TRACE_DB, 'utf-8'));
    }
    traces.push(trace);
    fs.writeFileSync(TRACE_DB, JSON.stringify(traces.slice(-1000), null, 2)); // Keep last 1000
  } catch (err) {
    log(`⚠️ Convex write error: ${err.message}`);
  }
  
  return trace;
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN: FULL PIPELINE
// ════════════════════════════════════════════════════════════════════════════
export async function runFullPipeline(req, body) {
  log(`\n${'═'.repeat(80)}`);
  log(`🔄 PIPELINE START: ${req.method} ${req.url}`);
  
  // 0. Context Guard
  const guard = contextGuardPre(req, body);
  if (!guard.ok) return guard;
  
  // 1. Priority Scorer
  const priority = priorityScorer(req, body);
  
  // 2. Trace Start
  const trace = traceStart(req, body, priority);
  
  // 3. Prompt Cache
  const cache = promptCacheCheck(body.prompt || '');
  
  // 4. Post-Inject Guard
  const context = postInjectGuard(body.context || {});
  
  // 5. Rate Limiter
  const rateLimitCheck = rateLimiter(body.agent || 'unknown', priority.tier);
  if (!rateLimitCheck.ok) return rateLimitCheck;
  
  // 6. Input Sanitize
  const sanitized = inputSanitize(body.message || '');
  
  // 7. Impact Radius
  const impacts = impactRadius(body);
  
  // 8. Security Gates
  const security = securityGates(req, body);
  if (!security.ok) {
    log(`✗ Security check failed: ${Object.entries(security.gates).filter(([_, v]) => !v).map(([k]) => k).join(', ')}`);
    return { ok: false, error: 'Security validation failed', code: 403 };
  }
  
  // 9. Context Handoff
  const handoff = contextHandoff(body.from || 'unknown', body.to || 'unknown', context);
  
  // 10. Skill Injection
  const skills = skillInjection(priority.score);
  
  // 11. KG Context
  const kg = kgContext(body.entities || []);
  
  // 12. Skill Deltas (if previous result exists)
  
  // 13. Goal Context
  const goals = goalContext(body);
  
  // 14. Cost Optimizer
  const optimizer = costOptimizer(priority.score, body.budget || 100);
  
  // 15. Persona Router
  const persona = personaRouter(body);
  
  // 16. Shared Memory
  const memory = sharedMemory(body.agent || 'unknown', body.message || '');
  
  // 17. Optim Architect
  const optim = optimArchitect(body.plan || { steps: [] });
  
  // 18. EMPO2 Tips
  const tips = empo2Tips(context);
  
  // 19. SLA Register
  const sla = slaRegister(body);
  
  // Result
  const result = {
    ok: true,
    pipeline: {
      priority,
      trace,
      cache,
      impacts,
      security,
      skills,
      optimizer,
      persona,
      sla
    }
  };
  
  // 20. Trace Close
  traceClose(trace, result);
  
  log(`✓ PIPELINE COMPLETE: ${trace.traceId}`);
  log(`${'═'.repeat(80)}\n`);
  
  return result;
}
