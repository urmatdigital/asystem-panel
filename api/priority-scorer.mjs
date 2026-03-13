/**
 * priority-scorer.mjs — Urgency × Impact Auto-Priority Scoring
 *
 * Pattern: Eisenhower matrix applied to agent task dispatch
 *   Video context: ClickUp AI Agents + "How to Build AI Agents in 2026" (ibFJ--CH3cQ)
 *   Automatically upgrades/downgrades priority based on title/body signals
 *
 * Scoring dimensions:
 *   Urgency  (0-5): time sensitivity signals (ASAP/now/urgent/broken/down/alert)
 *   Impact   (0-5): business impact signals (production/revenue/user/critical/security/block)
 *   Effort   (0-5): inverse effort (trivial tasks get boosted; huge tasks stay medium)
 *
 * Score → Priority:
 *   ≥ 8  → critical
 *   6-7  → high
 *   4-5  → medium
 *   < 4  → low
 *
 * Override: if explicit priority in request body, skip scorer UNLESS tagged 'auto-score'
 */

const URGENCY_SIGNALS = {
  // Score 3 (very urgent)
  urgent: 3, asap: 3, 'right now': 3, immediately: 3, 'right away': 3,
  down: 3, broken: 3, outage: 3, incident: 3, emergency: 3,
  // Score 2 (moderately urgent)
  today: 2, now: 2, soon: 2, quick: 2, fast: 2, deadline: 2,
  failing: 2, error: 2, bug: 2, crash: 2, alert: 2,
  // Score 1 (mildly urgent)
  fix: 1, review: 1, check: 1, verify: 1,
};

const IMPACT_SIGNALS = {
  // Score 3 (critical impact)
  production: 3, revenue: 3, security: 3, breach: 3, 'data loss': 3,
  critical: 3, blocker: 3, blocked: 3, 'users affected': 3,
  // Score 2 (high impact)
  user: 2, customer: 2, deploy: 2, launch: 2, release: 2,
  performance: 2, api: 2, auth: 2, payment: 2,
  // Score 1 (medium impact)
  feature: 1, improve: 1, refactor: 1, update: 1, add: 1,
};

const EFFORT_INVERSE = {
  // Low effort → +2 boost (quick wins deserve fast dispatch)
  trivial: 2, typo: 2, rename: 2, comment: 2, simple: 2, 'one line': 2,
  // Medium effort → +1
  small: 1, minor: 1, tweak: 1, adjust: 1,
  // High effort → 0 (no boost)
  complex: 0, refactor: 0, redesign: 0, migrate: 0, architecture: 0,
};

function scoreText(text, signals) {
  const lc = text.toLowerCase();
  let score = 0;
  for (const [kw, val] of Object.entries(signals)) {
    if (lc.includes(kw)) score = Math.max(score, val);
  }
  return Math.min(score, 5);
}

export function autoScorePriority(title, body = '', currentPriority = 'medium') {
  // Don't override explicit priority unless tagged auto-score
  const text = `${title} ${body}`;

  const urgency = scoreText(text, URGENCY_SIGNALS);
  const impact  = scoreText(text, IMPACT_SIGNALS);
  const effort  = scoreText(text, EFFORT_INVERSE);

  const total = urgency + impact + effort;

  let computed;
  if (total >= 8)      computed = 'critical';
  else if (total >= 6) computed = 'high';
  else if (total >= 4) computed = 'medium';
  else                 computed = 'low';

  // Only upgrade (never downgrade explicit user priority)
  const priorities = ['low', 'medium', 'high', 'critical'];
  const currentIdx  = priorities.indexOf(currentPriority);
  const computedIdx = priorities.indexOf(computed);
  const finalPriority = computedIdx > currentIdx ? computed : currentPriority;

  return {
    priority: finalPriority,
    upgraded: finalPriority !== currentPriority,
    scores: { urgency, impact, effort, total },
    computed,
  };
}

// ── Agent-specific priority boosts ────────────────────────────────────────────
export function agentPriorityBoost(agentId, priority) {
  // iron (security) and nurlan (devops) tasks never below high in production hours
  const now = new Date();
  const hour = now.getUTCHours() + 6; // UTC+6
  const isWorkHours = hour >= 8 && hour <= 22;
  if (!isWorkHours) return priority; // Night: no boost

  if (agentId === 'iron' && priority === 'medium') return 'high';
  if (agentId === 'nurlan' && priority === 'low') return 'medium';
  return priority;
}
