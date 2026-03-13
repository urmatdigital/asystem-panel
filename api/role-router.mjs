/**
 * role-router.mjs — Role-Based Agent Specialization Router
 *
 * Video: "If I Had to Start Over in 2026, I'd Learn Only This (5-Level AI Roadmap)" (btLZQzynfoA)
 * Pattern: Separate COORDINATOR / EXECUTOR / VALIDATOR concerns across agents
 *          to reduce hallucinations and overlap (single agent multi-role → 40% error rate)
 *
 * Role definitions:
 *   COORDINATOR  — Plans, delegates, synthesizes. Never executes directly.
 *                  Agents: forge, atlas, dana
 *   EXECUTOR     — Performs work: code, infra, analysis, design.
 *                  Agents: bekzat, ainura, nurlan, iron, mesa, pixel
 *   VALIDATOR    — Verifies, tests, reviews, audits.
 *                  Agents: marat + any EXECUTOR on other agents' output
 *
 * Role routing rules:
 *   Task type "plan|coordinate|delegate|breakdown|strategy|design" → COORDINATOR
 *   Task type "implement|build|code|deploy|fix|configure|create"   → EXECUTOR
 *   Task type "test|review|verify|audit|check|validate|qa"         → VALIDATOR
 *
 * Anti-overlap enforcement:
 *   COORDINATOR agents blocked from "implement/deploy" tasks (blast-radius style)
 *   VALIDATOR  agents get second-pass on all CRITICAL executor outputs
 *
 * API:
 *   POST /api/roles/route    { title, priority, preferredAgent? } → { role, suggestedAgent, reason }
 *   GET  /api/roles          → role manifest (who does what)
 *   POST /api/roles/validate { agentId, taskTitle } → { allowed, reason }
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME     = os.homedir();
const ROLE_LOG = path.join(HOME, '.openclaw/workspace/role-router-log.jsonl');

// ── Role manifest ─────────────────────────────────────────────────────────────
export const ROLE_MANIFEST = {
  COORDINATOR: {
    description: 'Plans, delegates, synthesizes. Never executes directly.',
    agents: ['forge', 'atlas', 'dana'],
    keywords: ['plan', 'coordinate', 'delegate', 'breakdown', 'strategy', 'architecture', 'roadmap', 'organize', 'design system', 'prioritize', 'schedule'],
    blockedKeywords: ['implement', 'deploy', 'execute', 'rm ', 'delete', 'drop'],
  },
  EXECUTOR: {
    description: 'Performs concrete work: coding, infra, analysis, design.',
    agents: ['bekzat', 'ainura', 'nurlan', 'iron', 'mesa', 'pixel'],
    keywords: ['implement', 'build', 'code', 'create', 'configure', 'fix', 'refactor', 'deploy', 'migrate', 'set up', 'integrate'],
    blockedKeywords: [],
  },
  VALIDATOR: {
    description: 'Verifies, tests, reviews, audits. Always last in pipeline.',
    agents: ['marat'],
    keywords: ['test', 'review', 'verify', 'audit', 'check', 'validate', 'qa', 'security review', 'approve', 'inspect'],
    blockedKeywords: ['implement', 'create', 'build', 'deploy'],
  },
};

// Agent → primary role lookup
const AGENT_ROLE = {};
for (const [role, cfg] of Object.entries(ROLE_MANIFEST)) {
  for (const agent of cfg.agents) AGENT_ROLE[agent] = role;
}

// ── Detect role from task title ───────────────────────────────────────────────
function detectRole(title = '') {
  const low = title.toLowerCase();
  for (const [role, cfg] of Object.entries(ROLE_MANIFEST)) {
    if (cfg.keywords.some(k => low.includes(k))) return role;
  }
  return 'EXECUTOR'; // default
}

// ── Route task to best agent by role ─────────────────────────────────────────
export function routeByRole({ title = '', priority = 'medium', preferredAgent = null }) {
  const role = detectRole(title);
  const cfg  = ROLE_MANIFEST[role];

  // If preferred agent has matching role, use it
  if (preferredAgent && AGENT_ROLE[preferredAgent] === role) {
    return { role, suggestedAgent: preferredAgent, reason: `${preferredAgent} is a ${role} — matches task type` };
  }

  // If preferred agent has wrong role, warn
  if (preferredAgent && AGENT_ROLE[preferredAgent] && AGENT_ROLE[preferredAgent] !== role) {
    const correctRole = AGENT_ROLE[preferredAgent];
    const suggestion  = cfg.agents[0];
    const entry = { ts: Date.now(), title: title.slice(0,60), role, preferredAgent, correctRole, suggestion };
    fs.appendFileSync(ROLE_LOG, JSON.stringify(entry) + '\n');
    console.warn(`[RoleRouter] ⚠️  ${preferredAgent} is ${correctRole}, task needs ${role} → suggest ${suggestion}`);
    return { role, suggestedAgent: suggestion, reason: `${preferredAgent} is ${correctRole}, not ${role}. Suggest ${suggestion}`, warning: true };
  }

  // Pick first available agent for role (simple selection; integrates with reputation/scheduler)
  const suggestedAgent = preferredAgent || cfg.agents[0];
  return { role, suggestedAgent, reason: `Task "${title.slice(0, 40)}" → ${role} role → ${suggestedAgent}` };
}

// ── Validate agent-task role compatibility ────────────────────────────────────
export function validateRoleAssignment(agentId, taskTitle = '') {
  const agentRole = AGENT_ROLE[agentId];
  if (!agentRole) return { allowed: true, reason: 'Agent not in role manifest — no restriction' };

  const cfg = ROLE_MANIFEST[agentRole];
  const low = taskTitle.toLowerCase();
  const blocked = cfg.blockedKeywords.find(k => low.includes(k));
  if (blocked) {
    return { allowed: false, reason: `${agentId} is ${agentRole} — blocked keyword "${blocked}" in task title` };
  }
  return { allowed: true, reason: `${agentId} (${agentRole}) — task allowed` };
}

export function getRoleManifest() { return ROLE_MANIFEST; }
export function getAgentRole(agentId) { return AGENT_ROLE[agentId] || 'EXECUTOR'; }
