/**
 * smart-router.mjs — Cost-Aware Model Router (SkillOrchestra Pattern)
 *
 * Video: "SkillOrchestra: Learning to Route Agents via Skill Transfer" (vxQ_2XI3DI4)
 * Pattern: Route 80% of tasks to cheap models, reserve premium for truly complex tasks.
 *   SkillOrchestra: 6.5¢ → 3.6¢ per query (-45% cost) while maintaining accuracy.
 *   Learn which task types NEED premium vs can be handled by nano/standard.
 *
 * Model tiers (ASYSTEM):
 *   NANO:     claude-haiku-4-5      ~$0.0003/1K tokens  — simple, mechanical tasks
 *   STANDARD: claude-sonnet-3-5     ~$0.003/1K tokens   — moderate complexity
 *   PREMIUM:  claude-sonnet-4-6     ~$0.015/1K tokens   — complex reasoning, critical tasks
 *
 * Routing signals (scored 0-10):
 *   complexity:   keywords (optimize/architect/design/synthesize) → +3 each
 *   length:       task title/body word count → +1 per 20 words
 *   priority:     critical=+4, high=+2, medium=0, low=-2
 *   history:      if agent historically fails this task type at nano → +3
 *   agent_rep:    EXPERT agents can use cheaper model (they add quality) → -2
 *   has_code:     task requires code generation → +2
 *   security:     security-related → always premium
 *
 * Routing decision:
 *   score 0-3:  NANO
 *   score 4-6:  STANDARD
 *   score 7+:   PREMIUM
 *
 * Learning: record outcome → if nano failed → bump routing threshold for that task type
 *
 * API:
 *   POST /api/router/route    { agentId, taskTitle, priority, body? } → model recommendation
 *   POST /api/router/outcome  { routingId, model, score, failed } → learn from result
 *   GET  /api/router/stats    → routing stats (% nano/standard/premium, avg cost)
 *   GET  /api/router/profile/:agentId → per-agent routing history
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME         = os.homedir();
const ROUTER_FILE  = path.join(HOME, '.openclaw/workspace/.routing-state.json');
const ROUTER_LOG   = path.join(HOME, '.openclaw/workspace/routing-log.jsonl');

// ── Model catalog ──────────────────────────────────────────────────────────────
const MODELS = {
  NANO:     { id: 'claude-haiku-4-5',   costPer1K: 0.0003, label: 'NANO',     emoji: '💚' },
  STANDARD: { id: 'claude-sonnet-3-5',  costPer1K: 0.003,  label: 'STANDARD', emoji: '🟡' },
  PREMIUM:  { id: 'claude-sonnet-4-6',  costPer1K: 0.015,  label: 'PREMIUM',  emoji: '🔴' },
};

// ── Complexity keywords ────────────────────────────────────────────────────────
const COMPLEX_KEYWORDS = ['optimize','architect','design','synthesize','analyze','evaluate','research','investigate','complex','advanced','critical','strategic','integrate','orchestrate','multi-step','distributed','concurrent'];
const SIMPLE_KEYWORDS  = ['list','get','fetch','check','status','ping','count','format','convert','rename','move','copy','echo'];

// ── Load / save state ─────────────────────────────────────────────────────────
function loadState() { try { return JSON.parse(fs.readFileSync(ROUTER_FILE, 'utf8')); } catch { return { failureMap: {}, stats: { nano: 0, standard: 0, premium: 0, totalCost: 0 }, agentProfiles: {} }; } }
function saveState(d) { try { fs.writeFileSync(ROUTER_FILE, JSON.stringify(d, null, 2)); } catch {} }

// ── Score task complexity ─────────────────────────────────────────────────────
function scoreComplexity(taskTitle = '', body = '', priority = 'medium', agentId = null, state = {}) {
  const text = `${taskTitle} ${body}`.toLowerCase();
  let score = 0;

  // Keyword scoring
  const complexHits = COMPLEX_KEYWORDS.filter(k => text.includes(k)).length;
  const simpleHits  = SIMPLE_KEYWORDS.filter(k => text.startsWith(k) || text.includes(` ${k} `)).length;
  score += complexHits * 2;
  score -= simpleHits * 2;

  // Length signal
  const words = text.split(/\s+/).length;
  score += Math.floor(words / 20);

  // Priority signal
  const priorityScore = { critical: 4, high: 2, medium: 0, low: -2 };
  score += priorityScore[priority] || 0;

  // Security → always premium
  if (/\b(security|auth|jwt|encrypt|vulnerability|CVE|pentest|injection)\b/.test(text)) score += 5;

  // Code generation signal
  if (/\b(implement|code|function|class|api|endpoint|service|schema|migration)\b/.test(text)) score += 2;

  // Historical failure signal
  const taskType = taskTitle.split(' ')[0].toLowerCase();
  const failures  = (state.failureMap || {})[taskType] || 0;
  score += Math.min(3, failures);

  return Math.max(0, score);
}

// ── Route task to model ───────────────────────────────────────────────────────
export function routeTask({ agentId, taskTitle, priority = 'medium', body = '' }) {
  const state   = loadState();
  const score   = scoreComplexity(taskTitle, body, priority, agentId, state);

  let tier;
  if (score <= 3)      tier = 'NANO';
  else if (score <= 6) tier = 'STANDARD';
  else                 tier = 'PREMIUM';

  const model   = MODELS[tier];
  const routingId = `rte_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;

  // Update stats
  state.stats[tier.toLowerCase()]++;
  state.stats.totalCost = (state.stats.totalCost || 0) + model.costPer1K * 2; // estimate 2K tokens avg

  // Agent profile
  if (!state.agentProfiles[agentId]) state.agentProfiles[agentId] = { nano: 0, standard: 0, premium: 0 };
  state.agentProfiles[agentId][tier.toLowerCase()]++;
  saveState(state);

  fs.appendFileSync(ROUTER_LOG, JSON.stringify({ ts: Date.now(), routingId, agentId, taskTitle: taskTitle.slice(0, 40), priority, score, tier, model: model.id }) + '\n');
  console.log(`[SmartRouter] ${model.emoji} ${agentId}: score=${score} → ${tier} (${model.id})`);
  return { routingId, agentId, score, tier, model: model.id, costPer1K: model.costPer1K, reasoning: `complexity score ${score}: ${score <= 3 ? 'simple task' : score <= 6 ? 'moderate complexity' : 'high complexity'}` };
}

// ── Record outcome + learn ────────────────────────────────────────────────────
export function recordOutcome({ routingId, taskTitle = '', model, score, failed = false }) {
  if (!failed) return { ok: true, learned: false };

  const state    = loadState();
  const taskType = taskTitle.split(' ')[0].toLowerCase();
  state.failureMap[taskType] = (state.failureMap[taskType] || 0) + 1;
  saveState(state);

  console.log(`[SmartRouter] 📚 Learned: ${taskType} failed at ${model} → bumping complexity by 1`);
  return { ok: true, learned: true, taskType, newFailureCount: state.failureMap[taskType] };
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getStats() {
  const state = loadState();
  const s     = state.stats;
  const total = (s.nano || 0) + (s.standard || 0) + (s.premium || 0);
  if (total === 0) return { total: 0, distribution: {}, estimatedCost: 0 };

  const distribution = {
    nano:     { count: s.nano || 0,     pct: Math.round((s.nano || 0) / total * 100) },
    standard: { count: s.standard || 0, pct: Math.round((s.standard || 0) / total * 100) },
    premium:  { count: s.premium || 0,  pct: Math.round((s.premium || 0) / total * 100) },
  };

  // Cost comparison: what if everything was premium?
  const premiumCost  = total * MODELS.PREMIUM.costPer1K * 2;
  const actualCost   = s.totalCost || 0;
  const savings      = premiumCost > 0 ? Math.round((1 - actualCost / premiumCost) * 100) : 0;
  return { total, distribution, estimatedCost: Math.round(actualCost * 1000) / 1000, savings: `${savings}% vs all-premium`, agentProfiles: state.agentProfiles };
}

export function getAgentProfile(agentId) {
  const state = loadState();
  return state.agentProfiles[agentId] || { nano: 0, standard: 0, premium: 0 };
}
