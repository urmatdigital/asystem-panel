/**
 * trigger-engine.mjs — Event-driven agent trigger rules
 *
 * Video: "Automate AI Coding with Kilo Cloud Agents" (eDJhpdDhgAA)
 * Pattern: Event → Trigger Rule → Agent auto-dispatch
 *   When X happens → automatically dispatch task to appropriate agent
 *
 * Built-in triggers:
 *   github.pr_opened    → marat (code review)
 *   github.push         → bekzat (lint/type check)
 *   health.service_down → nurlan (investigate)
 *   health.disk_full    → forge (cleanup)
 *   dlq.task_dead       → forge (investigate)
 *   kg.new_relation     → mesa (analyze impact)
 *   eval.regression     → forge (fix regression)
 *   swarm.done          → dana (write summary)
 *
 * API:
 *   POST /api/triggers/fire    { event, payload }  — fire an event
 *   GET  /api/triggers         — list all rules
 *   POST /api/triggers         — add custom rule
 *   GET  /api/triggers/log     — recent trigger fires
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME        = os.homedir();
const TRIGGER_LOG = path.join(HOME, '.openclaw/workspace/trigger-log.jsonl');
const RULES_FILE  = path.join(HOME, '.openclaw/workspace/.trigger-rules.json');

// ── Built-in trigger rules ────────────────────────────────────────────────────
const DEFAULT_RULES = [
  {
    id: 'github.pr_review',
    event: 'github.pr_opened',
    agent: 'marat',
    titleTemplate: 'Review PR: {pr_title}',
    bodyTemplate: 'PR #{pr_number} by {author}. Files: {files}. Branch: {branch}. Review for bugs, security, and code quality.',
    priority: 'high',
    tags: ['pr-review', 'automated'],
    enabled: true,
  },
  {
    id: 'github.push_check',
    event: 'github.push',
    agent: 'bekzat',
    titleTemplate: 'Post-push check: {repo} {branch}',
    bodyTemplate: 'Run lint + type check after push to {branch}. Commits: {commit_count}. Files changed: {files}.',
    priority: 'medium',
    tags: ['post-push', 'automated'],
    enabled: true,
  },
  {
    id: 'health.service_down',
    event: 'health.service_down',
    agent: 'nurlan',
    titleTemplate: 'ALERT: {service} is DOWN',
    bodyTemplate: 'Service {service} on {host} has been down since {since}. Investigate and restore.',
    priority: 'critical',
    tags: ['incident', 'automated', 'approved'],
    enabled: true,
  },
  {
    id: 'health.disk_critical',
    event: 'health.disk_full',
    agent: 'forge',
    titleTemplate: 'DISK CRITICAL: {host} at {pct}%',
    bodyTemplate: 'Disk on {host} is at {pct}% ({used}/{total}). Clean up logs, build artifacts, and docker images.',
    priority: 'high',
    tags: ['disk', 'cleanup', 'automated', 'sensitive-ok'],
    enabled: true,
  },
  {
    id: 'dlq.dead_task_triage',
    event: 'dlq.task_dead',
    agent: 'forge',
    titleTemplate: 'DLQ Dead: {task_title}',
    bodyTemplate: 'Task "{task_title}" ({task_id}) died after {attempts} attempts. Agent: {agent}. Error: {error}. Investigate root cause.',
    priority: 'medium',
    tags: ['dlq', 'investigation', 'automated'],
    enabled: true,
  },
  {
    id: 'eval.regression_alert',
    event: 'eval.regression',
    agent: 'forge',
    titleTemplate: 'REGRESSION: eval passRate dropped {delta}%',
    bodyTemplate: 'Eval regression detected. PassRate: {today_rate}% (was {avg_rate}%). Agent: {agent}. Investigate recent changes.',
    priority: 'high',
    tags: ['eval', 'regression', 'automated'],
    enabled: true,
  },
  {
    id: 'swarm.summary',
    event: 'swarm.done',
    agent: 'dana',
    titleTemplate: 'Write Swarm Summary: {swarm_id}',
    bodyTemplate: 'Swarm {swarm_id} completed. Winner: {winner}. Task: "{task_title}". Write a 3-sentence executive summary of the outcome.',
    priority: 'low',
    tags: ['swarm', 'summary', 'automated'],
    enabled: true,
  },
  {
    id: 'security.injection_alert',
    event: 'security.injection_detected',
    agent: 'iron',
    titleTemplate: 'SECURITY: Injection attempt from {source}',
    bodyTemplate: 'Prompt injection detected from source "{source}". Pattern: "{pattern}". Investigate and update security rules.',
    priority: 'critical',
    tags: ['security', 'injection', 'automated', 'sensitive-ok'],
    enabled: true,
  },
];

// ── Load/save rules ───────────────────────────────────────────────────────────
function loadRules() {
  try { return JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')); }
  catch { return DEFAULT_RULES; }
}

function saveRules(rules) {
  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
}

// Initialize rules file if not exists
if (!fs.existsSync(RULES_FILE)) saveRules(DEFAULT_RULES);

// ── Template interpolation ────────────────────────────────────────────────────
function interpolate(template, payload) {
  return template.replace(/\{(\w+)\}/g, (_, key) => payload[key] !== undefined ? payload[key] : `{${key}}`);
}

// ── Fire event — match rules and dispatch ─────────────────────────────────────
export async function fireEvent(event, payload = {}, forgeApiUrl = 'http://localhost:5190') {
  const rules = loadRules().filter(r => r.enabled && r.event === event);
  if (!rules.length) return { fired: 0, event };

  const results = [];
  for (const rule of rules) {
    const title = interpolate(rule.titleTemplate, payload);
    const body = interpolate(rule.bodyTemplate, payload);

    try {
      const res = await fetch(`${forgeApiUrl}/api/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: rule.agent, title, body,
          priority: rule.priority,
          tags: rule.tags || ['automated'],
          source: `trigger:${rule.id}`,
        }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      results.push({ rule: rule.id, agent: rule.agent, taskId: data.taskId, ok: true });
      console.log(`[Trigger] ⚡ ${event} → ${rule.agent}: "${title.slice(0, 50)}"`);
    } catch (e) {
      results.push({ rule: rule.id, agent: rule.agent, ok: false, error: e.message });
    }

    fs.appendFileSync(TRIGGER_LOG, JSON.stringify({ ts: Date.now(), event, ruleId: rule.id, agent: rule.agent, title, payload: JSON.stringify(payload).slice(0, 200) }) + '\n');
  }

  return { fired: results.length, event, results };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────
export function listRules() { return loadRules(); }

export function addRule(rule) {
  const rules = loadRules();
  rule.id = rule.id || `custom.${Date.now()}`;
  rule.enabled = rule.enabled !== false;
  rules.push(rule);
  saveRules(rules);
  return rule;
}

export function toggleRule(ruleId, enabled) {
  const rules = loadRules();
  const rule = rules.find(r => r.id === ruleId);
  if (rule) { rule.enabled = enabled; saveRules(rules); }
  return rule;
}

// ── Trigger log ───────────────────────────────────────────────────────────────
export function getTriggerLog(limit = 20) {
  try {
    const lines = fs.readFileSync(TRIGGER_LOG, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => JSON.parse(l)).reverse();
  } catch { return []; }
}
