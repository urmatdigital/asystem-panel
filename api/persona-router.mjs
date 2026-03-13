/**
 * persona-router.mjs — 4 Persona System for agent task routing
 *
 * Video: "How I code with AI in 2026 — The 4 Persona System" (MOEgv91p9vQ)
 * Pattern: Every coding task flows through 4 specialized roles:
 *   Planner → Architect → Implementer → Reviewer
 *
 * Applied to ASYSTEM: instead of sending a vague task to one agent,
 * the router adds a PERSONA header to the task body, giving the agent
 * a focused role and expected output format.
 *
 * Personas:
 *   PLANNER    — breaks ambiguous request into clear steps, no code
 *   ARCHITECT  — designs solution, data models, APIs (no impl yet)
 *   IMPLEMENTER— writes the actual code/config/infra
 *   REVIEWER   — checks output, suggests improvements, runs tests
 *   ANALYST    — data analysis, metrics, reporting (Mesa/Dana)
 *   GUARDIAN   — security review, compliance, network (Iron)
 */

// ── Persona definitions ───────────────────────────────────────────────────────
export const PERSONAS = {
  PLANNER: {
    id: 'PLANNER',
    emoji: '🗺️',
    instruction: 'You are the PLANNER. Your ONLY job is to create a clear, numbered execution plan (no code). List exact steps, dependencies, and success criteria. Output: numbered list only.',
    triggerKeywords: ['plan', 'design', 'what should', 'how to approach', 'strategy', 'roadmap', 'steps to'],
    agents: ['dana'],
  },
  ARCHITECT: {
    id: 'ARCHITECT',
    emoji: '📐',
    instruction: 'You are the ARCHITECT. Design the solution: data models, API contracts, file structure, technology choices. Produce diagrams (text-based), schema definitions, and interface contracts. No implementation code.',
    triggerKeywords: ['architecture', 'schema', 'design', 'structure', 'model', 'contract', 'interface', 'api design'],
    agents: ['bekzat', 'forge'],
  },
  IMPLEMENTER: {
    id: 'IMPLEMENTER',
    emoji: '⚙️',
    instruction: 'You are the IMPLEMENTER. Write complete, production-ready code. Follow the plan/architecture provided. Include error handling, type hints, and comments. Output: working code files only.',
    triggerKeywords: ['implement', 'build', 'create', 'write', 'code', 'develop', 'make', 'add', 'fix', 'refactor'],
    agents: ['bekzat', 'ainura', 'nurlan', 'forge'],
  },
  REVIEWER: {
    id: 'REVIEWER',
    emoji: '🔍',
    instruction: 'You are the REVIEWER. Critically examine the code/output. Check: correctness, edge cases, security, performance, code style. Output: numbered list of issues + severity (HIGH/MED/LOW) + suggested fixes.',
    triggerKeywords: ['review', 'check', 'test', 'qa', 'quality', 'verify', 'audit', 'inspect', 'validate'],
    agents: ['marat'],
  },
  ANALYST: {
    id: 'ANALYST',
    emoji: '📊',
    instruction: 'You are the ANALYST. Extract insights from data. Provide metrics, trends, anomalies, and actionable recommendations. Output: executive summary + key metrics table + top 3 recommendations.',
    triggerKeywords: ['analyze', 'metrics', 'data', 'report', 'stats', 'dashboard', 'insight', 'trend'],
    agents: ['mesa', 'dana'],
  },
  GUARDIAN: {
    id: 'GUARDIAN',
    emoji: '🛡️',
    instruction: 'You are the GUARDIAN. Security-first perspective. Identify attack vectors, misconfigurations, and compliance gaps. Output: threat model + risk matrix (likelihood × impact) + mitigations.',
    triggerKeywords: ['security', 'ssl', 'auth', 'network', 'firewall', 'access', 'permission', 'vulnerability', 'tunnel'],
    agents: ['iron'],
  },
};

// Default persona by agent
const AGENT_DEFAULT_PERSONA = {
  dana:   'PLANNER',
  bekzat: 'IMPLEMENTER',
  ainura: 'IMPLEMENTER',
  nurlan: 'IMPLEMENTER',
  marat:  'REVIEWER',
  mesa:   'ANALYST',
  iron:   'GUARDIAN',
  forge:  'IMPLEMENTER',
  atlas:  'ARCHITECT',
  pixel:  'IMPLEMENTER',
};

// ── Select persona for a task ─────────────────────────────────────────────────
export function selectPersona(agentId, title = '', body = '') {
  const text = `${title} ${body}`.toLowerCase();

  // Check keyword matches across all personas
  let bestPersona = null;
  let bestScore = 0;
  for (const [id, persona] of Object.entries(PERSONAS)) {
    const score = persona.triggerKeywords.filter(k => text.includes(k)).length;
    if (score > bestScore) { bestScore = score; bestPersona = id; }
  }

  // Fall back to agent default
  if (!bestPersona || bestScore === 0) {
    bestPersona = AGENT_DEFAULT_PERSONA[agentId] || 'IMPLEMENTER';
  }

  return PERSONAS[bestPersona];
}

// ── Inject persona header into task body ──────────────────────────────────────
export function injectPersona(agentId, title, body) {
  const persona = selectPersona(agentId, title, body);
  const header = `[${persona.emoji} ${persona.id} ROLE]\n${persona.instruction}\n\n---\n`;
  return {
    enhancedBody: header + (body || ''),
    persona: persona.id,
    emoji: persona.emoji,
  };
}

// ── Get persona stats from audit log ─────────────────────────────────────────
export function getPersonaStats(auditLogPath) {
  try {
    const lines = require('fs').readFileSync(auditLogPath, 'utf8').trim().split('\n').filter(Boolean);
    const records = lines.map(l => JSON.parse(l)).filter(r => r.persona);
    const byPersona = {};
    for (const r of records) byPersona[r.persona] = (byPersona[r.persona] || 0) + 1;
    return { total: records.length, byPersona };
  } catch { return { total: 0, byPersona: {} }; }
}
