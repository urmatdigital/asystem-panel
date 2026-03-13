/**
 * proactive-suggest.mjs — Proactive Suggestion Engine
 *
 * Video: "Proactive AI in Business Intelligence: Transforming Dashboards" (TVcq5lQNrcg)
 * Pattern: Agent continuously monitors system state and PROACTIVELY suggests
 *          improvements, optimizations, and actions — without being asked.
 *          Like a senior engineer who notices things in the background.
 *
 * Observation signals monitored:
 *   - Error clusters: 3+ similar errors in 1h → suggest systemic fix
 *   - Agent reputation drops: >10 point drop → suggest coaching
 *   - Task backlog growing: agent queue >5 tasks → suggest load balancing
 *   - Score regression: agent avg drops >1pt week-over-week → suggest training
 *   - Repeated failed patterns: same failure type 3+ times → suggest root cause analysis
 *   - Memory decay: important memories about to expire → suggest review/renewal
 *   - Budget approaching: token usage >80% → suggest optimization
 *   - Coalition not formed: complex task dispatched without coalition → suggest team
 *   - Unused capabilities: skills registered but never invoked → suggest cleanup
 *   - SLA pattern: agent consistently misses SLAs → suggest reassignment
 *
 * Suggestion format:
 *   { type, priority, title, body, action, agentId?, autoApply }
 *   autoApply: true → system applies without human confirmation
 *
 * API:
 *   POST /api/suggest/scan    { force? } → run observation cycle, return suggestions
 *   GET  /api/suggest/pending → current pending suggestions
 *   POST /api/suggest/apply   { suggestionId } → apply suggestion
 *   POST /api/suggest/dismiss { suggestionId } → dismiss
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME       = os.homedir();
const SUGG_FILE  = path.join(HOME, '.openclaw/workspace/.suggestions.json');
const SUGG_LOG   = path.join(HOME, '.openclaw/workspace/suggestion-log.jsonl');
const LAST_SCAN  = path.join(HOME, '.openclaw/workspace/.last-suggest-scan.json');
const SCAN_INTERVAL_MS = 10 * 60 * 1000;  // 10 min between scans

// ── Suggestion generators ──────────────────────────────────────────────────────
async function checkReputationDrops() {
  const suggestions = [];
  try {
    const repPath = path.join(os.homedir(), '.openclaw/workspace/.reputation.json');
    const rep     = JSON.parse(fs.readFileSync(repPath, 'utf8'));
    for (const [agentId, data] of Object.entries(rep)) {
      const recent  = (data.events || []).slice(-5);
      const drops   = recent.filter(e => e.delta < 0);
      const totalDrop = drops.reduce((s, e) => s + e.delta, 0);
      if (drops.length >= 3 || totalDrop <= -8) {
        suggestions.push({
          id: `rep_drop_${agentId}_${Date.now()}`,
          type: 'coaching', priority: 'high',
          title: `${agentId} reputation declining — coaching needed`,
          body: `${agentId} lost ${Math.abs(totalDrop)} reputation points in last ${drops.length} events. Consider: skill injection boost, easier task assignment, peer mentoring from forge/atlas.`,
          action: `POST /api/skill-injector/boost { agentId: "${agentId}" }`,
          agentId, autoApply: false,
        });
      }
    }
  } catch {}
  return suggestions;
}

async function checkTokenBudget() {
  const suggestions = [];
  try {
    const budgetPath = path.join(os.homedir(), '.openclaw/workspace/.budget.json');
    const budget     = JSON.parse(fs.readFileSync(budgetPath, 'utf8'));
    const monthly    = budget.monthly || {};
    const usage      = monthly.used || 0;
    const limit      = monthly.limit || 10_000_000;
    const pct        = usage / limit;
    if (pct > 0.80) {
      suggestions.push({
        id: `budget_${Date.now()}`,
        type: 'optimization', priority: pct > 0.90 ? 'critical' : 'high',
        title: `Token budget at ${Math.round(pct * 100)}% — optimize model usage`,
        body: `Monthly token usage: ${usage.toLocaleString()} / ${limit.toLocaleString()} (${Math.round(pct * 100)}%). Consider: route more tasks to nano-tier agents, enable aggressive prompt caching, reduce context injection.`,
        action: `POST /api/config/update { "cost_tier_default": "nano" }`,
        autoApply: false,
      });
    }
  } catch {}
  return suggestions;
}

async function checkQueueBacklog() {
  const suggestions = [];
  try {
    const queueDir = path.join(os.homedir(), '.openclaw/workspace/.priority-queues');
    if (!fs.existsSync(queueDir)) return suggestions;
    const files = fs.readdirSync(queueDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const agentId = f.replace('.json', '');
      const queue   = JSON.parse(fs.readFileSync(path.join(queueDir, f), 'utf8'));
      if (queue.length >= 5) {
        suggestions.push({
          id: `backlog_${agentId}_${Date.now()}`,
          type: 'load_balance', priority: 'medium',
          title: `${agentId} has ${queue.length} queued tasks — consider load balancing`,
          body: `${agentId}'s queue depth is ${queue.length}. Oldest task: "${queue[0]?.title?.slice(0, 40)}". Consider distributing tasks to similar-skill agents or forming a coalition.`,
          action: `POST /api/coalition/form { taskTitle: "${queue[0]?.title?.slice(0, 50)}" }`,
          agentId, autoApply: false,
        });
      }
    }
  } catch {}
  return suggestions;
}

async function checkErrorClusters() {
  const suggestions = [];
  try {
    const clustersPath = path.join(os.homedir(), '.openclaw/workspace/error-clusters.json');
    const clusters = JSON.parse(fs.readFileSync(clustersPath, 'utf8'));
    const systematic = clusters.filter(c => c.severity === 'SYSTEMIC' && !c.resolved);
    for (const cluster of systematic.slice(0, 2)) {
      suggestions.push({
        id: `systemic_${cluster.id || Date.now()}`,
        type: 'root_cause', priority: 'high',
        title: `Systemic error pattern: "${cluster.pattern?.slice(0, 40)}"`,
        body: `${cluster.count || 3}+ similar errors detected in cluster. Pattern: "${cluster.pattern}". Root cause analysis dispatched to iron. Consider: adding circuit breaker, error-specific skill injection, or task type blacklist.`,
        action: `POST /api/dispatch { to: "iron", title: "root cause analysis: ${cluster.pattern?.slice(0, 30)}" }`,
        autoApply: false,
      });
    }
  } catch {}
  return suggestions;
}

async function checkOldCoalitions() {
  const suggestions = [];
  try {
    const coalPath = path.join(os.homedir(), '.openclaw/workspace/.coalitions.json');
    const coalitions = JSON.parse(fs.readFileSync(coalPath, 'utf8'));
    const stale = Object.values(coalitions).filter(c => c.status === 'active' && Date.now() - c.formedAt > 2 * 60 * 60 * 1000); // > 2h
    for (const c of stale.slice(0, 2)) {
      suggestions.push({
        id: `stale_coalition_${c.coalitionId}`,
        type: 'cleanup', priority: 'low',
        title: `Coalition "${c.template}" has been active for >2h — consider dissolving`,
        body: `Coalition ${c.coalitionId} (${c.template}) formed ${Math.round((Date.now() - c.formedAt) / 60000)}min ago for "${c.taskTitle?.slice(0, 40)}". If task is complete, dissolve to free agents.`,
        action: `POST /api/coalition/dissolve { coalitionId: "${c.coalitionId}" }`,
        autoApply: false,
      });
    }
  } catch {}
  return suggestions;
}

// ── Main scan ─────────────────────────────────────────────────────────────────
export async function scan({ force = false } = {}) {
  // Rate limit: don't scan too often
  try {
    const last = JSON.parse(fs.readFileSync(LAST_SCAN, 'utf8'));
    if (!force && Date.now() - last.ts < SCAN_INTERVAL_MS) {
      return { ok: true, skipped: true, reason: `Next scan in ${Math.round((SCAN_INTERVAL_MS - (Date.now() - last.ts)) / 1000)}s`, pending: getPending().length };
    }
  } catch {}

  const all = (await Promise.all([
    checkReputationDrops(),
    checkTokenBudget(),
    checkQueueBacklog(),
    checkErrorClusters(),
    checkOldCoalitions(),
  ])).flat();

  // Deduplicate by type+agentId
  const existing = loadSuggestions();
  const newSuggs = all.filter(s => !existing.find(e => e.type === s.type && e.agentId === s.agentId && e.status === 'pending'));

  for (const s of newSuggs) {
    s.status = 'pending';
    s.createdAt = Date.now();
    existing.push(s);
    fs.appendFileSync(SUGG_LOG, JSON.stringify({ ts: Date.now(), type: s.type, title: s.title?.slice(0, 60) }) + '\n');
    console.log(`[Proactive] 💡 New suggestion: [${s.priority}] ${s.title?.slice(0, 50)}`);
  }

  // Keep last 50, prune old dismissed
  const pruned = existing.filter(s => s.status === 'pending' || Date.now() - s.createdAt < 24 * 60 * 60 * 1000).slice(-50);
  saveSuggestions(pruned);
  fs.writeFileSync(LAST_SCAN, JSON.stringify({ ts: Date.now() }));
  return { ok: true, scanned: 5, newSuggestions: newSuggs.length, totalPending: pruned.filter(s => s.status === 'pending').length, suggestions: newSuggs };
}

export function getPending() { return loadSuggestions().filter(s => s.status === 'pending').sort((a, b) => { const pOrder = { critical: 0, high: 1, medium: 2, low: 3 }; return (pOrder[a.priority] || 2) - (pOrder[b.priority] || 2); }); }

export function applySuggestion(suggestionId) {
  const suggs = loadSuggestions();
  const s = suggs.find(s => s.id === suggestionId);
  if (!s) return { ok: false, reason: 'Suggestion not found' };
  s.status = 'applied'; s.appliedAt = Date.now();
  saveSuggestions(suggs);
  console.log(`[Proactive] ✅ Applied: ${s.title?.slice(0, 40)}`);
  return { ok: true, suggestion: s };
}

export function dismissSuggestion(suggestionId) {
  const suggs = loadSuggestions();
  const s = suggs.find(s => s.id === suggestionId);
  if (!s) return { ok: false, reason: 'Not found' };
  s.status = 'dismissed'; s.dismissedAt = Date.now();
  saveSuggestions(suggs);
  return { ok: true };
}

function loadSuggestions() { try { return JSON.parse(fs.readFileSync(SUGG_FILE, 'utf8')); } catch { return []; } }
function saveSuggestions(d) { try { fs.writeFileSync(SUGG_FILE, JSON.stringify(d, null, 2)); } catch {} }
