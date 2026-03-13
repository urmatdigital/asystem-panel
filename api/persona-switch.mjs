/**
 * persona-switch.mjs — Dynamic Multi-Persona Switching
 *
 * Video: "How to Set Up Persona for Your AI Agent" (CZMGO5GOmtw)
 * Pattern: A single agent can wear multiple "personas" — each with its own
 *   tone, communication style, detail level, and behavioral rules.
 *   Context is analyzed → best persona auto-selected → injected into prompt.
 *
 * Personas:
 *   TECHNICAL    — precise, code-focused, uses technical jargon, minimal filler
 *   EXECUTIVE    — high-level, strategic, bullet points, business impact first
 *   SUPPORT      — empathetic, step-by-step, patient, avoids jargon
 *   MENTOR       — educational, explains why, encourages, asks clarifying questions
 *   CRITICAL     — skeptical, finds edge cases, devil's advocate, thorough
 *   CREATIVE     — exploratory, generates options, thinks outside box
 *   EMERGENCY    — terse, action-focused, no preamble, immediate next steps only
 *
 * Auto-detection triggers:
 *   "explain" / "how does" / "teach" → MENTOR
 *   "urgent" / "production down" / "critical" → EMERGENCY
 *   "CEO" / "report" / "summary" / "stakeholder" → EXECUTIVE
 *   "error" / "help" / "stuck" → SUPPORT
 *   "review" / "audit" / "check" → CRITICAL
 *   "brainstorm" / "ideas" / "options" → CREATIVE
 *   default → TECHNICAL
 *
 * Per-agent persona preferences:
 *   forge:  defaults to TECHNICAL, can switch to EMERGENCY
 *   atlas:  defaults to EXECUTIVE, can switch to CRITICAL
 *   marat:  defaults to CRITICAL (QA mindset)
 *   dana:   defaults to EXECUTIVE + SUPPORT
 *   mesa:   defaults to TECHNICAL + MENTOR
 *
 * API:
 *   POST /api/persona/detect   { agentId, taskTitle, requestedBy? } → persona + system prompt block
 *   GET  /api/persona/list     → all available personas
 *   POST /api/persona/override { agentId, persona } → force persona for next task
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME          = os.homedir();
const OVERRIDE_FILE = path.join(HOME, '.openclaw/workspace/.persona-overrides.json');
const PERSONA_LOG   = path.join(HOME, '.openclaw/workspace/persona-log.jsonl');

// ── Persona definitions ───────────────────────────────────────────────────────
const PERSONAS = {
  TECHNICAL: {
    name: 'TECHNICAL', emoji: '⚙️',
    tone: 'precise, concise, code-first',
    rules: ['Use technical terms freely', 'Lead with code/commands when relevant', 'Skip pleasantries', 'Use exact numbers and types', 'Prefer examples over prose'],
    systemBlock: `[PERSONA: TECHNICAL ENGINEER]\nCommunicate with precision. Lead with code, commands, or exact steps. No filler phrases. Use technical terminology correctly. When uncertain, say so explicitly with confidence level.`,
  },
  EXECUTIVE: {
    name: 'EXECUTIVE', emoji: '📊',
    tone: 'strategic, high-level, impact-first',
    rules: ['Lead with business impact', 'Use bullet points', 'State risks and tradeoffs', 'Recommend, don\'t just report', 'Keep it under 5 bullets'],
    systemBlock: `[PERSONA: EXECUTIVE ADVISOR]\nLead with business impact and strategic implications. Use bullet points. State the recommendation first, then rationale. Quantify impact when possible. Skip implementation details unless asked.`,
  },
  SUPPORT: {
    name: 'SUPPORT', emoji: '🤝',
    tone: 'empathetic, step-by-step, clear',
    rules: ['Acknowledge the problem first', 'Break into numbered steps', 'Avoid jargon', 'Check understanding', 'Offer follow-up'],
    systemBlock: `[PERSONA: SUPPORT SPECIALIST]\nBegin by acknowledging the issue. Provide clear, numbered steps. Avoid technical jargon unless the user is technical. Ask clarifying questions if needed. End with a check: "Does that resolve your issue?"`,
  },
  MENTOR: {
    name: 'MENTOR', emoji: '📚',
    tone: 'educational, patient, explains why',
    rules: ['Explain the "why" not just the "how"', 'Use analogies', 'Build on prior knowledge', 'Encourage questions', 'Check comprehension'],
    systemBlock: `[PERSONA: MENTOR]\nExplain concepts from first principles. Use analogies to clarify. Don't just give answers — explain the reasoning. Encourage further exploration. End with a reflection question or next learning step.`,
  },
  CRITICAL: {
    name: 'CRITICAL', emoji: '🔍',
    tone: 'skeptical, thorough, finds gaps',
    rules: ['Challenge assumptions', 'Identify edge cases', 'State what could go wrong', 'Request evidence for claims', 'Be precise about risks'],
    systemBlock: `[PERSONA: CRITICAL REVIEWER]\nApproach with healthy skepticism. Identify edge cases, failure modes, and unstated assumptions. For every proposal, state: What could go wrong? What\'s missing? What are the alternatives? Be thorough, not pessimistic.`,
  },
  CREATIVE: {
    name: 'CREATIVE', emoji: '💡',
    tone: 'exploratory, generative, lateral thinking',
    rules: ['Generate multiple options', 'Think laterally', 'Challenge the brief', 'Propose unconventional approaches', 'Build on half-ideas'],
    systemBlock: `[PERSONA: CREATIVE THINKER]\nGenerate at least 3 diverse options. Challenge the framing of the problem. Think laterally — what would a completely different industry do? Combine unrelated ideas. Explore the unconventional before the conventional.`,
  },
  EMERGENCY: {
    name: 'EMERGENCY', emoji: '🚨',
    tone: 'terse, action-only, immediate',
    rules: ['No preamble', 'Action items only', 'State severity', 'Next step first', 'Escalation path'],
    systemBlock: `[PERSONA: EMERGENCY RESPONDER]\nNO PREAMBLE. State: 1) Severity 2) Immediate action 3) ETA to resolve 4) Escalation if not resolved. Every word must be essential. No pleasantries. Speed is paramount.`,
  },
};

// ── Agent default personas ────────────────────────────────────────────────────
const AGENT_DEFAULTS = {
  forge:  ['TECHNICAL', 'EMERGENCY'],
  atlas:  ['EXECUTIVE', 'CRITICAL'],
  bekzat: ['TECHNICAL'],
  ainura: ['TECHNICAL', 'CREATIVE'],
  marat:  ['CRITICAL'],
  nurlan: ['TECHNICAL'],
  dana:   ['EXECUTIVE', 'SUPPORT'],
  mesa:   ['TECHNICAL', 'MENTOR'],
  iron:   ['TECHNICAL', 'CRITICAL'],
  pixel:  ['CREATIVE'],
};

// ── Auto-detect persona from task context ─────────────────────────────────────
function detectPersona(taskTitle = '', agentId = null, requestedBy = null) {
  const low = taskTitle.toLowerCase();

  // Emergency first
  if (/urgent|critical|production down|hotfix|emergency|down/.test(low)) return 'EMERGENCY';

  // Requestor-based: if CEO/atlas requests → executive
  if (requestedBy === 'dana' || /\b(report|summary|status update|stakeholder|ceo|board)\b/.test(low)) return 'EXECUTIVE';

  // Task type detection
  if (/\b(explain|how does|teach|learn|understand|why does)\b/.test(low)) return 'MENTOR';
  if (/\b(help|stuck|error|issue|problem|fix|broken)\b/.test(low)) return 'SUPPORT';
  if (/\b(review|audit|check|verify|validate|assess)\b/.test(low)) return 'CRITICAL';
  if (/\b(brainstorm|ideas|options|alternative|creative|explore)\b/.test(low)) return 'CREATIVE';

  // Agent default
  const defaults = AGENT_DEFAULTS[agentId] || ['TECHNICAL'];
  return defaults[0];
}

// ── Detect and return persona + system block ──────────────────────────────────
export function detectAndApply({ agentId, taskTitle, requestedBy = null }) {
  // Check for override
  const overrides = loadOverrides();
  const override  = overrides[agentId];
  let personaKey;

  if (override && Date.now() - override.ts < 30 * 60 * 1000) { // 30min override TTL
    personaKey = override.persona;
    // Consume override (one-shot)
    delete overrides[agentId];
    saveOverrides(overrides);
    console.log(`[Persona] 🎭 ${agentId} using OVERRIDE: ${personaKey}`);
  } else {
    personaKey = detectPersona(taskTitle, agentId, requestedBy);
    console.log(`[Persona] 🎭 ${agentId} auto-detected: ${personaKey} for "${taskTitle?.slice(0, 40)}"`);
  }

  const persona = PERSONAS[personaKey] || PERSONAS.TECHNICAL;
  fs.appendFileSync(PERSONA_LOG, JSON.stringify({ ts: Date.now(), agentId, personaKey, taskTitle: taskTitle?.slice(0, 50), requestedBy }) + '\n');

  return { agentId, personaKey, persona: { name: persona.name, emoji: persona.emoji, tone: persona.tone, rules: persona.rules }, systemBlock: persona.systemBlock };
}

// ── Override persona for next task ────────────────────────────────────────────
export function overridePersona({ agentId, persona }) {
  if (!PERSONAS[persona]) return { ok: false, reason: `Unknown persona: ${persona}. Available: ${Object.keys(PERSONAS).join(', ')}` };
  const overrides   = loadOverrides();
  overrides[agentId] = { persona, ts: Date.now() };
  saveOverrides(overrides);
  console.log(`[Persona] ✏️  Override set: ${agentId} → ${persona} (30min TTL)`);
  return { ok: true, agentId, persona, expiresInMinutes: 30 };
}

export function listPersonas() { return Object.entries(PERSONAS).map(([key, p]) => ({ key, name: p.name, emoji: p.emoji, tone: p.tone })); }

function loadOverrides() { try { return JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8')); } catch { return {}; } }
function saveOverrides(d) { try { fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(d, null, 2)); } catch {} }
