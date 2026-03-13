/**
 * skill-injector.mjs — Progressive Disclosure RAG for Agent Skills
 *
 * Video: "Inside Agent Skills: How One File Turns AI Into a Specialist" (hl76xUaWNSc)
 * Pattern: 2-tier skill injection
 *   Tier 1: Skill discovery — agent sees only skill name + 1-sentence description (cheap)
 *   Tier 2: Full skill sheet injected into task body (2-5K tokens) when intent matches
 *
 * Agent skills are markdown files in ~/projects/ASYSTEM/api/agent-skills/<agentId>/
 *   skill-name.md — full skill specification
 *   skill-name.yaml — { name, description, triggers: [keywords] }
 *
 * How it works:
 *   1. Dispatch body analyzed for intent keywords
 *   2. Matching skill (if any) loaded from disk
 *   3. Skill content prepended to task body as [SKILL: name]
 *   4. Non-matching skills only mentioned by name (Tier 1, <50 tokens)
 *
 * Built-in skills (if no file found, uses hardcoded):
 *   bekzat: fastapi-patterns, postgres-neon, auth-jwt, websocket
 *   ainura: next16-patterns, tailwind-v4, react-query, capacitor
 *   marat:  pytest-patterns, e2e-playwright, load-testing
 *   nurlan: pm2-patterns, nginx-ssl, docker-compose, tailscale
 *   dana:   sprint-planning, okr-writing, risk-matrix
 *   forge:  claude-code-patterns, git-workflow, code-review
 *
 * API:
 *   GET /api/skills/:agentId        — list skills for agent
 *   GET /api/skills/:agentId/:skill — get full skill content
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME        = os.homedir();
const SKILLS_DIR  = path.join(HOME, 'projects/ASYSTEM/api/agent-skills');
fs.mkdirSync(SKILLS_DIR, { recursive: true });

// ── Built-in skill index (Tier 1 discovery — no files needed) ───────────────
const BUILTIN_SKILLS = {
  bekzat: [
    { name: 'fastapi-patterns', description: 'FastAPI router structure, dependency injection, Pydantic models, async patterns', triggers: ['fastapi', 'api', 'router', 'endpoint', 'pydantic', 'backend'] },
    { name: 'postgres-neon',    description: 'PostgreSQL + Neon serverless: connection pooling, migrations, asyncpg',            triggers: ['postgres', 'database', 'neon', 'sql', 'migration', 'db'] },
    { name: 'auth-jwt',         description: 'JWT tokens: access/refresh cycle, bcrypt, OAuth2, middleware guards',             triggers: ['jwt', 'auth', 'login', 'token', 'session', 'refresh', 'oauth'] },
    { name: 'websocket',        description: 'WebSocket: FastAPI ws handler, client reconnect, rooms, broadcast',               triggers: ['websocket', 'ws', 'real-time', 'realtime', 'socket'] },
  ],
  ainura: [
    { name: 'next16-patterns',  description: 'Next.js 16 App Router, Server Components, server actions, streaming',             triggers: ['next', 'nextjs', 'app router', 'server component', 'rsc'] },
    { name: 'tailwind-v4',      description: 'Tailwind CSS v4: new config, @theme, container queries, dark mode',               triggers: ['tailwind', 'css', 'style', 'design', 'ui', 'component'] },
    { name: 'react-query',      description: 'TanStack Query v5: useQuery, useMutation, optimistic updates, cache invalidation', triggers: ['react query', 'tanstack', 'usequery', 'mutation', 'cache'] },
  ],
  marat: [
    { name: 'pytest-patterns',  description: 'pytest: fixtures, parametrize, mocking (unittest.mock), async tests',             triggers: ['pytest', 'test', 'fixture', 'mock', 'unit test', 'coverage'] },
    { name: 'e2e-playwright',   description: 'Playwright: page objects, selectors, network intercept, CI integration',          triggers: ['playwright', 'e2e', 'browser test', 'selenium', 'integration'] },
  ],
  nurlan: [
    { name: 'pm2-patterns',     description: 'PM2: ecosystem.config.js, cluster mode, log rotation, health checks',             triggers: ['pm2', 'process', 'daemon', 'startup', 'ecosystem'] },
    { name: 'nginx-ssl',        description: 'nginx: reverse proxy, SSL termination, upstream, rate limiting, gzip',            triggers: ['nginx', 'ssl', 'proxy', 'https', 'certbot', 'letsencrypt'] },
    { name: 'docker-compose',   description: 'Docker Compose v3: networks, volumes, health checks, multi-stage builds',         triggers: ['docker', 'container', 'compose', 'dockerfile', 'image'] },
  ],
  dana: [
    { name: 'sprint-planning',  description: 'Sprint planning: story points, velocity, backlog grooming, retro format',         triggers: ['sprint', 'backlog', 'story', 'points', 'velocity', 'planning'] },
    { name: 'okr-writing',      description: 'OKR format: Objective + 3 Key Results, measurable, time-bound, quarterly',       triggers: ['okr', 'objective', 'key result', 'goal', 'kpi', 'metric'] },
  ],
  forge: [
    { name: 'claude-code-patterns', description: 'Claude Code: --print flag, permission-mode, AGENTS.md conventions, agentic patterns', triggers: ['claude code', 'claude', 'agentic', 'coding agent', 'codex'] },
    { name: 'git-workflow',     description: 'Git: conventional commits, PR description, branch strategy, squash/rebase',       triggers: ['git', 'commit', 'pr', 'pull request', 'branch', 'merge', 'push'] },
  ],
  iron: [
    { name: 'cloudflare-tunnels', description: 'Cloudflare Tunnels: cloudflared, ingress rules, DNS setup, zero-trust routing', triggers: ['cloudflare', 'tunnel', 'cdn', 'dns', 'zero-trust', 'warp'] },
  ],
  mesa: [
    { name: 'mesa-simulation', description: 'Mesa 3.3: Agent, Model, DataCollector, batch_run, visualization', triggers: ['mesa', 'simulation', 'abm', 'agent-based', 'model', 'analytics'] },
  ],
};

// ── Tier 1: discover matching skill from task text ────────────────────────────
export function discoverSkill(agentId, taskText) {
  const skills = BUILTIN_SKILLS[agentId] || [];
  if (!skills.length) return null;
  const lc = taskText.toLowerCase();
  // Score each skill by trigger matches
  const scored = skills.map(s => ({
    ...s,
    score: s.triggers.filter(t => lc.includes(t)).length,
  })).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

// ── Tier 2: load full skill content (from file or generate inline) ────────────
function loadSkillContent(agentId, skillName) {
  // Try file first
  const file = path.join(SKILLS_DIR, agentId, `${skillName}.md`);
  try { return fs.readFileSync(file, 'utf8').slice(0, 3000); } catch {}

  // Generate inline content from builtin
  const skills = BUILTIN_SKILLS[agentId] || [];
  const skill = skills.find(s => s.name === skillName);
  if (!skill) return null;

  return `# Skill: ${skill.name}\n${skill.description}\n\nKey points:\n- Apply ${skill.name} best practices\n- Follow ${agentId} team conventions\n- Ensure error handling and logging\n- Write production-ready code`;
}

// ── Main: build skill context for dispatch ────────────────────────────────────
export function buildSkillContext(agentId, taskText) {
  // Tier 1: find matching skill
  const matched = discoverSkill(agentId, taskText);
  const allSkills = BUILTIN_SKILLS[agentId] || [];

  if (!matched) {
    // Only Tier 1: mention available skills
    if (!allSkills.length) return null;
    return `[Available skills: ${allSkills.map(s => s.name).join(', ')}]`;
  }

  // Tier 2: inject full skill
  const content = loadSkillContent(agentId, matched.name);
  const otherSkills = allSkills.filter(s => s.name !== matched.name).map(s => s.name);

  const lines = [
    `[SKILL: ${matched.name}]`,
    content || matched.description,
  ];
  if (otherSkills.length) lines.push(`[Other skills available: ${otherSkills.join(', ')}]`);
  return lines.join('\n');
}

// ── List skills for agent ─────────────────────────────────────────────────────
export function listSkills(agentId) {
  return (BUILTIN_SKILLS[agentId] || []).map(s => ({ name: s.name, description: s.description, triggers: s.triggers }));
}
