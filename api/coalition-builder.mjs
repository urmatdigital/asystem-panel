/**
 * coalition-builder.mjs — Dynamic Agent Coalition Formation
 *
 * Video: "The AI Agent Team That Replaced a $10K Agency (Flowise Tutorial)" (ZOXPVAOAtZs)
 * Pattern: Agents SELF-ORGANIZE into task-specific coalitions.
 *   Instead of static team assignments, the system:
 *   1. Analyzes task requirements (skills needed)
 *   2. Queries Capability Registry for skill matches
 *   3. Forms optimal coalition (min agents, max skill coverage)
 *   4. Assigns roles within coalition (LEAD, SUPPORT, REVIEWER)
 *   5. Coalition dissolves after task completion
 *
 * Coalition roles:
 *   LEAD      — owns task, coordinates, delivers final output
 *   SUPPORT   — provides specific expertise (e.g., QA, security)
 *   REVIEWER  — validates output before delivery
 *   OBSERVER  — silent, learns from this coalition's work
 *
 * Example:
 *   Task: "implement and deploy ORGON payment integration with Stripe"
 *   Required skills: [backend, payments, security, testing, deployment]
 *   → Coalition: bekzat(LEAD/backend+payments) + marat(SUPPORT/testing) + iron(SUPPORT/security)
 *   → atlas(REVIEWER) reviews before merge
 *   → ainura(OBSERVER) learns payment patterns
 *
 * Predefined coalition templates (common task patterns):
 *   FEATURE_SHIP: LEAD(implement) + marat(test) + atlas(review)
 *   SECURITY_AUDIT: iron(LEAD) + bekzat(SUPPORT) + marat(SUPPORT)
 *   EMERGENCY_FIX: forge(LEAD) + bekzat(SUPPORT) + iron(SECURITY)
 *   CONTENT_DEPLOY: ainura(LEAD) + nurlan(DEVOPS) + marat(QA)
 *   RESEARCH_BRIEF: mesa(LEAD) + atlas(SYNTHESIZE) + dana(PRESENT)
 *
 * API:
 *   POST /api/coalition/form     { taskTitle, requiredSkills?, priority?, template? }
 *   POST /api/coalition/dissolve { coalitionId }
 *   GET  /api/coalition/active   → active coalitions
 *   GET  /api/coalition/:id      → coalition detail
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME           = os.homedir();
const COALITION_FILE = path.join(HOME, '.openclaw/workspace/.coalitions.json');
const COALITION_LOG  = path.join(HOME, '.openclaw/workspace/coalition-log.jsonl');

// ── Agent skill profiles ───────────────────────────────────────────────────────
const AGENT_PROFILES = {
  forge:   { skills: ['backend', 'devops', 'orchestration', 'security', 'architecture'], role: 'COORDINATOR', tier: 'premium' },
  atlas:   { skills: ['planning', 'review', 'architecture', 'orchestration', 'strategy'], role: 'COORDINATOR', tier: 'premium' },
  bekzat:  { skills: ['backend', 'api', 'auth', 'database', 'payments', 'websocket'], role: 'EXECUTOR', tier: 'standard' },
  ainura:  { skills: ['frontend', 'ui', 'react', 'design', 'ux', 'mobile'], role: 'EXECUTOR', tier: 'standard' },
  marat:   { skills: ['testing', 'qa', 'verification', 'regression', 'coverage'], role: 'VALIDATOR', tier: 'nano' },
  nurlan:  { skills: ['devops', 'deployment', 'ci-cd', 'infrastructure', 'docker'], role: 'EXECUTOR', tier: 'nano' },
  dana:    { skills: ['planning', 'project-management', 'coordination', 'reporting'], role: 'COORDINATOR', tier: 'nano' },
  mesa:    { skills: ['research', 'analysis', 'simulation', 'data', 'analytics'], role: 'EXECUTOR', tier: 'nano' },
  iron:    { skills: ['security', 'monitoring', 'infrastructure', 'networking', 'alerts'], role: 'EXECUTOR', tier: 'standard' },
  pixel:   { skills: ['design', 'visual', 'branding', 'graphics', 'ui', 'prototype'], role: 'EXECUTOR', tier: 'nano' },
};

// ── Predefined coalition templates ─────────────────────────────────────────────
const TEMPLATES = {
  FEATURE_SHIP:    { members: [{ agent: 'bekzat', role: 'LEAD' }, { agent: 'marat', role: 'SUPPORT' }, { agent: 'atlas', role: 'REVIEWER' }], desc: 'Standard feature implementation + testing + review' },
  SECURITY_AUDIT:  { members: [{ agent: 'iron', role: 'LEAD' }, { agent: 'bekzat', role: 'SUPPORT' }, { agent: 'marat', role: 'SUPPORT' }], desc: 'Security audit + code analysis + test coverage' },
  EMERGENCY_FIX:   { members: [{ agent: 'forge', role: 'LEAD' }, { agent: 'bekzat', role: 'SUPPORT' }, { agent: 'iron', role: 'REVIEWER' }], desc: 'Critical production fix with security review' },
  CONTENT_DEPLOY:  { members: [{ agent: 'ainura', role: 'LEAD' }, { agent: 'nurlan', role: 'SUPPORT' }, { agent: 'marat', role: 'REVIEWER' }], desc: 'Frontend feature + devops deploy + QA validation' },
  RESEARCH_BRIEF:  { members: [{ agent: 'mesa', role: 'LEAD' }, { agent: 'atlas', role: 'SUPPORT' }, { agent: 'dana', role: 'REVIEWER' }], desc: 'Research + synthesis + executive presentation' },
  FULL_STACK:      { members: [{ agent: 'bekzat', role: 'LEAD' }, { agent: 'ainura', role: 'SUPPORT' }, { agent: 'nurlan', role: 'SUPPORT' }, { agent: 'marat', role: 'REVIEWER' }], desc: 'Full-stack feature: BE + FE + deploy + QA' },
};

// ── Score agent for task ───────────────────────────────────────────────────────
function scoreAgent(agentId, requiredSkills) {
  const profile = AGENT_PROFILES[agentId];
  if (!profile) return 0;
  const matched = requiredSkills.filter(s => profile.skills.some(as => as.includes(s) || s.includes(as)));
  return matched.length / Math.max(requiredSkills.length, 1);
}

// ── Detect required skills from task title ────────────────────────────────────
function detectRequiredSkills(title = '') {
  const low = title.toLowerCase();
  const skills = [];
  if (/api|endpoint|backend|server|rest/.test(low))   skills.push('backend');
  if (/frontend|ui|react|vue|page|component/.test(low)) skills.push('frontend');
  if (/test|spec|qa|verify/.test(low))                skills.push('testing');
  if (/deploy|ci|cd|docker|k8s|release/.test(low))    skills.push('deployment');
  if (/security|auth|jwt|oauth|encrypt/.test(low))    skills.push('security');
  if (/database|schema|migration|sql/.test(low))      skills.push('database');
  if (/payment|stripe|billing|invoice/.test(low))     skills.push('payments');
  if (/design|figma|prototype|brand/.test(low))       skills.push('design');
  if (/research|analyz|data|metric/.test(low))        skills.push('research');
  if (/plan|project|roadmap|sprint/.test(low))        skills.push('planning');
  if (skills.length === 0) skills.push('backend'); // default
  return skills;
}

// ── Auto-select template based on task ───────────────────────────────────────
function autoSelectTemplate(title = '', priority = 'medium') {
  const low = title.toLowerCase();
  if (priority === 'critical' || /urgent|hotfix|production/.test(low)) return 'EMERGENCY_FIX';
  if (/security|audit|penetration|vulnerab/.test(low))                  return 'SECURITY_AUDIT';
  if (/frontend|ui|page|component|design/.test(low))                    return 'CONTENT_DEPLOY';
  if (/research|analyz|report|brief/.test(low))                         return 'RESEARCH_BRIEF';
  if (/full.?stack|end.to.end|complete feature/.test(low))              return 'FULL_STACK';
  return 'FEATURE_SHIP';
}

// ── Form coalition ─────────────────────────────────────────────────────────────
export function formCoalition({ taskTitle, requiredSkills = null, priority = 'medium', template = null }) {
  const detectedSkills = requiredSkills || detectRequiredSkills(taskTitle);
  const templateKey    = template || autoSelectTemplate(taskTitle, priority);
  const tmpl           = TEMPLATES[templateKey] || TEMPLATES.FEATURE_SHIP;

  const coalitionId = `coa_${Date.now()}`;
  const members     = tmpl.members.map(m => ({
    agent: m.agent,
    role:  m.role,
    skills: AGENT_PROFILES[m.agent]?.skills || [],
    skillMatch: Math.round(scoreAgent(m.agent, detectedSkills) * 100),
    tier: AGENT_PROFILES[m.agent]?.tier || 'nano',
  }));

  const coalition = {
    coalitionId, taskTitle: taskTitle?.slice(0, 80), template: templateKey,
    templateDesc: tmpl.desc, detectedSkills, priority,
    members, formedAt: Date.now(), status: 'active',
    lead: members.find(m => m.role === 'LEAD')?.agent,
    reviewedBy: members.find(m => m.role === 'REVIEWER')?.agent,
  };

  const coalitions = loadCoalitions();
  coalitions[coalitionId] = coalition;
  saveCoalitions(coalitions);
  fs.appendFileSync(COALITION_LOG, JSON.stringify({ ts: Date.now(), action: 'form', coalitionId, template: templateKey, members: members.map(m => `${m.agent}(${m.role})`) }) + '\n');
  console.log(`[Coalition] 🤝 Formed "${templateKey}": ${members.map(m => `${m.agent}(${m.role})`).join(' + ')}`);
  return { ok: true, coalition };
}

// ── Dissolve coalition ────────────────────────────────────────────────────────
export function dissolveCoalition(coalitionId) {
  const coalitions = loadCoalitions();
  if (!coalitions[coalitionId]) return { ok: false, reason: 'Coalition not found' };
  coalitions[coalitionId].status   = 'dissolved';
  coalitions[coalitionId].dissolvedAt = Date.now();
  saveCoalitions(coalitions);
  fs.appendFileSync(COALITION_LOG, JSON.stringify({ ts: Date.now(), action: 'dissolve', coalitionId }) + '\n');
  console.log(`[Coalition] 💨 Dissolved: ${coalitionId}`);
  return { ok: true, coalitionId };
}

export function getActiveCoalitions() { const c = loadCoalitions(); return Object.values(c).filter(co => co.status === 'active'); }
export function getCoalition(id) { return loadCoalitions()[id] || null; }

// ── IO ────────────────────────────────────────────────────────────────────────
function loadCoalitions() { try { return JSON.parse(fs.readFileSync(COALITION_FILE, 'utf8')); } catch { return {}; } }
function saveCoalitions(d) { try { fs.writeFileSync(COALITION_FILE, JSON.stringify(d, null, 2)); } catch {} }
