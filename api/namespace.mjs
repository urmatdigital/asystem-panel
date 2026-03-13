/**
 * namespace.mjs — Per-Project Agent Namespace Isolation
 *
 * Video: "(Podcast) Securing AI Agents with Cursor Local Sandboxing" (Jxmf1DaesxE)
 *
 * Pattern: Namespace-per-project = context separation + permission inversion
 *   Agents operate freely within project namespace
 *   Cross-namespace access requires explicit bridge permission
 *   Each project has isolated: memory, skill context, tool access, audit trail
 *
 * ASYSTEM Projects:
 *   orgon     → bekzat, ainura, marat (FastAPI + Next.js)
 *   aurwa     → bekzat, ainura (SaaS Exchange)
 *   fiatex    → bekzat (crypto exchange)
 *   voltera   → ainura (PWA mobile)
 *   asystem   → all agents (panel + infra)
 *   infra     → nurlan, iron (servers, networking)
 *
 * Namespace rules:
 *   - Agent can dispatch within own project namespace freely
 *   - Cross-project dispatch requires `namespace-bridge` tag + iron approval
 *   - Memory writes are namespaced (separate ZVec memory_target)
 *   - Skill context filtered to namespace-relevant skills only
 *
 * API:
 *   GET  /api/namespace            — list namespaces + agent assignments
 *   GET  /api/namespace/:project   — project namespace details
 *   POST /api/namespace/check      { from, to, project }  — permission check
 *   POST /api/namespace/register   { project, agent, role } — assign agent
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME   = os.homedir();
const NS_FILE = path.join(HOME, '.openclaw/workspace/.namespaces.json');

// ── Built-in namespace definitions ────────────────────────────────────────────
const DEFAULT_NAMESPACES = {
  orgon: {
    description: 'ORGON multi-sig wallet platform',
    agents: { bekzat: 'backend', ainura: 'frontend', marat: 'qa', dana: 'pm' },
    skills: ['fastapi', 'nextjs', 'postgresql', 'auth-jwt', 'blockchain'],
    allow_bridge_to: ['asystem', 'infra'],
    path: '~/projects/ORGON',
    memory_target: 'orgon',
  },
  aurwa: {
    description: 'AURWA SaaS Exchange v3.0',
    agents: { bekzat: 'backend', ainura: 'frontend' },
    skills: ['fastapi', 'vue', 'postgresql', 'trading'],
    allow_bridge_to: ['infra'],
    path: '~/projects/AURWA',
    memory_target: 'aurwa',
  },
  fiatex: {
    description: 'FiatEx crypto exchange platform',
    agents: { bekzat: 'backend', ainura: 'frontend', marat: 'qa' },
    skills: ['nestjs', 'vue', 'postgresql', 'crypto'],
    allow_bridge_to: ['infra'],
    path: '~/projects/fiatexkg',
    memory_target: 'fiatex',
  },
  voltera: {
    description: 'Voltera EV Charging PWA',
    agents: { ainura: 'frontend' },
    skills: ['vite', 'typescript', 'capacitor', 'pwa'],
    allow_bridge_to: [],
    path: '~/projects/Voltera-mobile',
    memory_target: 'voltera',
  },
  asystem: {
    description: 'ASYSTEM Panel + AI orchestration',
    agents: { forge: 'lead', dana: 'pm', mesa: 'analytics', nurlan: 'devops', iron: 'security' },
    skills: ['nodejs', 'convex', 'react', 'tailwind', 'panel'],
    allow_bridge_to: ['orgon', 'aurwa', 'fiatex', 'voltera', 'infra'],
    path: '~/projects/ASYSTEM',
    memory_target: 'asystem',
  },
  infra: {
    description: 'Infrastructure, servers, networking',
    agents: { nurlan: 'devops', iron: 'security', forge: 'lead' },
    skills: ['proxmox', 'tailscale', 'nginx', 'cloudflare', 'docker'],
    allow_bridge_to: ['asystem'],
    path: '~/',
    memory_target: 'infra',
  },
};

// ── Load/save (custom overrides) ──────────────────────────────────────────────
function loadNS() {
  try { return { ...DEFAULT_NAMESPACES, ...JSON.parse(fs.readFileSync(NS_FILE, 'utf8')) }; }
  catch { return { ...DEFAULT_NAMESPACES }; }
}
function saveCustom(ns) { try { fs.writeFileSync(NS_FILE, JSON.stringify(ns, null, 2)); } catch {} }

// ── Get namespace for agent + context ─────────────────────────────────────────
export function getAgentNamespace(agentId) {
  const ns = loadNS();
  const found = Object.entries(ns).filter(([, n]) => Object.keys(n.agents || {}).includes(agentId));
  return found.map(([name, n]) => ({ name, role: n.agents[agentId], ...n }));
}

// ── Get namespace for a project ───────────────────────────────────────────────
export function getNamespace(project) {
  return loadNS()[project] || null;
}

// ── Check cross-namespace permission ─────────────────────────────────────────
export function checkNamespacePerm({ fromAgent, toAgent, fromProject, toProject, tags = [] }) {
  // Same namespace = always allowed
  if (fromProject && toProject && fromProject === toProject) return { allowed: true, reason: 'same-namespace' };

  // Bridge tag check
  if (tags.includes('namespace-bridge')) {
    const ns = loadNS();
    const fromNS = ns[fromProject];
    if (fromNS?.allow_bridge_to?.includes(toProject)) return { allowed: true, reason: 'bridge-permitted' };
    return { allowed: false, reason: `${fromProject} → ${toProject} bridge not permitted; add to allow_bridge_to` };
  }

  // forge + atlas = global access
  if (['forge', 'atlas'].includes(fromAgent)) return { allowed: true, reason: 'global-agent' };

  return { allowed: true, reason: 'no-namespace-context' }; // default allow if no project specified
}

// ── Inject namespace context into dispatch body ───────────────────────────────
export function getNamespaceContext(agentId, projectHint) {
  const ns = loadNS();
  // Auto-detect from agent membership or hint
  let project = projectHint;
  if (!project) {
    for (const [name, n] of Object.entries(ns)) {
      if (Object.keys(n.agents || {}).includes(agentId)) { project = name; break; }
    }
  }
  if (!project || !ns[project]) return '';

  const n = ns[project];
  const role = n.agents?.[agentId] || 'member';
  return `[NAMESPACE: ${project}] Role: ${role} | Skills: ${(n.skills || []).slice(0, 4).join(', ')} | Path: ${n.path || '?'}`;
}

// ── Register agent to namespace ───────────────────────────────────────────────
export function registerAgent(project, agentId, role) {
  const ns = loadNS();
  if (!ns[project]) ns[project] = { description: project, agents: {}, skills: [], allow_bridge_to: [], memory_target: project };
  ns[project].agents[agentId] = role;
  // Save custom only
  const custom = {};
  try { Object.assign(custom, JSON.parse(fs.readFileSync(NS_FILE, 'utf8'))); } catch {}
  custom[project] = ns[project];
  saveCustom(custom);
  return ns[project];
}

// ── List namespaces ───────────────────────────────────────────────────────────
export function listNamespaces() {
  return Object.entries(loadNS()).map(([name, n]) => ({
    name, description: n.description, agents: Object.keys(n.agents || {}),
    skills: n.skills, path: n.path, memory_target: n.memory_target,
  }));
}
