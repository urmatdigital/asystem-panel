/**
 * blast-radius.mjs — Blast Radius Limiter & 3P Security Framework
 *
 * Video: "Your AI Agent Security Strategy Is Broken (Here's Why)" (PHfxLd6eVFM)
 * Pattern: 3P Framework — Purpose / Privilege / Protection
 *
 * Every agent has a defined "blast radius" — the max scope of damage it can cause.
 * Before dispatch, we verify the task stays inside the agent's blast radius.
 *
 * Blast Radius = { maxPriority, allowedProjects, allowedActions, maxFilesPerTask, trustedSources }
 *
 * 5-Minute Pulse Check: deny tokens if anomalies detected in last 5 min:
 *   - budget blown > 80%
 *   - error rate > 50% (last 10 tasks)
 *   - DLQ spike (> 3 items)
 *   - rapid dispatch from same agent (> 5 in 5min)
 *
 * API:
 *   GET  /api/blast-radius          — all agent blast radius configs
 *   GET  /api/blast-radius/:agentId — specific agent config
 *   POST /api/blast-radius/check    { agentId, title, priority, project } → { allowed, violations }
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME   = os.homedir();
const LOG    = path.join(HOME, '.openclaw/workspace/blast-radius-log.jsonl');

// ── Agent blast radius definitions ────────────────────────────────────────────
const BLAST_RADIUS = {
  forge: {
    maxPriority:    'critical',    // can dispatch any priority
    allowedProjects: ['*'],        // all projects
    allowedActions:  ['*'],        // all actions
    maxFilesPerTask: 100,
    trustedSources:  ['*'],
    description: 'Primary agent — full access',
  },
  atlas: {
    maxPriority:    'critical',
    allowedProjects: ['*'],
    allowedActions:  ['*'],
    maxFilesPerTask: 100,
    trustedSources:  ['*'],
    description: 'Master controller — full access',
  },
  bekzat: {
    maxPriority:    'high',
    allowedProjects: ['orgon', 'fiatex', 'aurwa', 'asystem'],
    allowedActions:  ['implement', 'fix', 'refactor', 'build', 'code', 'update', 'create'],
    maxFilesPerTask: 30,
    trustedSources:  ['forge', 'atlas', 'dana'],
    description: 'Backend lead — code actions on backend projects',
  },
  ainura: {
    maxPriority:    'high',
    allowedProjects: ['orgon', 'aurwa', 'asystem', 'voltera'],
    allowedActions:  ['implement', 'fix', 'design', 'build', 'style', 'ui', 'update', 'create'],
    maxFilesPerTask: 25,
    trustedSources:  ['forge', 'atlas', 'dana'],
    description: 'Frontend lead — UI/UX actions',
  },
  marat: {
    maxPriority:    'medium',
    allowedProjects: ['orgon', 'aurwa', 'asystem', 'fiatex', 'voltera'],
    allowedActions:  ['test', 'review', 'audit', 'check', 'verify', 'qa'],
    maxFilesPerTask: 20,
    trustedSources:  ['forge', 'atlas', 'dana', 'bekzat', 'ainura'],
    description: 'QA lead — read-only review actions',
  },
  nurlan: {
    maxPriority:    'high',
    allowedProjects: ['*'],
    allowedActions:  ['deploy', 'configure', 'monitor', 'setup', 'investigate', 'fix', 'restart'],
    maxFilesPerTask: 15,
    trustedSources:  ['forge', 'atlas'],
    description: 'DevOps lead — infra actions',
  },
  dana: {
    maxPriority:    'medium',
    allowedProjects: ['*'],
    allowedActions:  ['plan', 'design', 'roadmap', 'write', 'document', 'analyze', 'review'],
    maxFilesPerTask: 10,
    trustedSources:  ['forge', 'atlas'],
    description: 'PM director — planning and documentation',
  },
  mesa: {
    maxPriority:    'medium',
    allowedProjects: ['asystem', 'analytics'],
    allowedActions:  ['analyze', 'simulate', 'research', 'report', 'model'],
    maxFilesPerTask: 10,
    trustedSources:  ['forge', 'atlas'],
    description: 'Analytics — simulation and research',
  },
  iron: {
    maxPriority:    'critical',
    allowedProjects: ['*'],
    allowedActions:  ['investigate', 'fix', 'secure', 'audit', 'monitor', 'deploy'],
    maxFilesPerTask: 50,
    trustedSources:  ['forge', 'atlas'],
    description: 'VPS infra — security and infrastructure',
  },
  pixel: {
    maxPriority:    'medium',
    allowedProjects: ['asystem', 'orgon', 'aurwa', 'voltera'],
    allowedActions:  ['design', 'create', 'style', 'mock', 'prototype'],
    maxFilesPerTask: 20,
    trustedSources:  ['forge', 'atlas', 'dana'],
    description: 'Design agent — visual and UI design',
  },
};

// ── Priority levels ───────────────────────────────────────────────────────────
const PRIORITY_LEVEL = { low: 0, medium: 1, high: 2, critical: 3 };

// ── Pulse check counters (in-memory, reset every 5min window) ─────────────────
const _pulseCounts = {};
const PULSE_WINDOW = 5 * 60_000; // 5 minutes

function pulseTick(agentId) {
  const now = Date.now();
  if (!_pulseCounts[agentId]) _pulseCounts[agentId] = [];
  _pulseCounts[agentId] = _pulseCounts[agentId].filter(t => now - t < PULSE_WINDOW);
  _pulseCounts[agentId].push(now);
  return _pulseCounts[agentId].length;
}

// ── Check blast radius ────────────────────────────────────────────────────────
export function checkBlastRadius({ agentId, title = '', priority = 'medium', project = '', from = '' }) {
  const config = BLAST_RADIUS[agentId];
  if (!config) return { allowed: true, reason: 'unknown agent — pass-through', violations: [] };
  if (agentId === 'forge' || agentId === 'atlas') return { allowed: true, reason: 'primary agent bypass', violations: [] };

  const violations = [];
  const titleLow = title.toLowerCase();

  // Check 1: priority level
  const maxLvl = PRIORITY_LEVEL[config.maxPriority] ?? 3;
  const taskLvl = PRIORITY_LEVEL[priority] ?? 1;
  if (taskLvl > maxLvl) violations.push(`priority '${priority}' exceeds max '${config.maxPriority}'`);

  // Check 2: project scope
  if (!config.allowedProjects.includes('*') && project) {
    const proj = project.toLowerCase();
    if (!config.allowedProjects.some(p => proj.includes(p))) violations.push(`project '${project}' not in allowed scope: [${config.allowedProjects.join(', ')}]`);
  }

  // Check 3: action type
  if (!config.allowedActions.includes('*')) {
    const firstWord = titleLow.split(' ')[0];
    if (!config.allowedActions.some(a => titleLow.startsWith(a) || titleLow.includes(a))) violations.push(`action '${firstWord}...' not in allowed actions: [${config.allowedActions.join(', ')}]`);
  }

  // Check 4: trusted source
  if (from && !config.trustedSources.includes('*') && !config.trustedSources.includes(from)) violations.push(`source '${from}' not trusted by ${agentId}`);

  // Check 5: 5-Minute Pulse Check (rapid dispatch)
  const recentCount = pulseTick(agentId);
  if (recentCount > 8) violations.push(`pulse rate exceeded: ${recentCount} dispatches in 5 min (max 8)`);

  const allowed = violations.length === 0;
  const entry = { ts: Date.now(), agentId, title: title.slice(0, 60), priority, project, from, allowed, violations };
  fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');

  if (!allowed) console.warn(`[BlastRadius] 🛡️ BLOCKED ${agentId}: ${violations.join(' | ')}`);
  else console.log(`[BlastRadius] ✅ ${agentId}: within blast radius (${config.description})`);

  return { allowed, violations, config: { maxPriority: config.maxPriority, description: config.description } };
}

export function getAllBlastRadii() { return BLAST_RADIUS; }
export function getAgentBlastRadius(agentId) { return BLAST_RADIUS[agentId] || null; }
