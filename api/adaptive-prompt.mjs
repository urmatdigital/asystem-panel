/**
 * adaptive-prompt.mjs — Adaptive Prompt Evolution with Branching Logic
 *
 * Video: "Stop Writing Linear Prompts! Build Smart AI Agents with Branching Logic" (SJTHdCK3DcE)
 * Pattern: Prompts are NOT static strings — they evolve based on:
 *   1. Agent's Karpathy score history (what worked, what didn't)
 *   2. Task type → branch into specialized prompt trees
 *   3. Agent skill level (NOVICE vs EXPERT get different instruction depth)
 *   4. Context signals (H-MEM results, reputation, prior failures)
 *
 * Branching logic:
 *   IF score_avg < 6 AND type=implement → append "IMPORTANT: break task into 3 steps first"
 *   IF score_avg >= 8 AND type=implement → append "Expert mode: propose architecture first"
 *   IF agent is PROBATION (reputation) → prepend explicit quality checklist
 *   IF task is CRITICAL → append "Do NOT proceed until you confirm understanding"
 *   IF prior failures on similar tasks → append failure context
 *
 * Prompt genome:
 *   Base prompt = agent manifest
 *   Mutations = appended/prepended blocks based on signals
 *   Each mutation tagged with source signal → traceable
 *
 * Self-modification:
 *   After each task: if score improved vs avg → lock mutation (keep it)
 *   If score dropped → revert mutation (discard)
 *   → Prompt "genome" evolves toward higher quality over time
 *
 * API:
 *   POST /api/prompt/adapt  { agentId, taskTitle, priority, contextSignals? } → evolved prompt block
 *   GET  /api/prompt/genome/:agentId → current prompt mutations + scores
 *   POST /api/prompt/feedback { agentId, mutationId, score } → keep/revert mutation
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME         = os.homedir();
const GENOME_FILE  = path.join(HOME, '.openclaw/workspace/.prompt-genomes.json');
const ADAPT_LOG    = path.join(HOME, '.openclaw/workspace/prompt-adapt-log.jsonl');

// ── Mutation library — branching prompt blocks ─────────────────────────────────
const MUTATIONS = {
  // Quality-based
  low_score_implementer:  { trigger: 'score_avg < 6 AND type=implement',   text: '\n⚠️ QUALITY NOTE: Your recent implementations scored below threshold. Break this task into 3 explicit steps before coding. Verify each step.' },
  high_score_expert:      { trigger: 'score_avg >= 8 AND type=implement',  text: '\n🎯 EXPERT MODE: Propose architecture/design before implementation. Think about edge cases and testability.' },
  low_score_reviewer:     { trigger: 'score_avg < 6 AND type=review',      text: '\n📋 REVIEW CHECKLIST: Security → Performance → Error handling → Test coverage → Documentation. Check each explicitly.' },
  // Reputation-based
  probation_quality:      { trigger: 'reputation < 50',                    text: '\n🔶 PROBATION MODE: Your current reputation requires extra care. Before submitting: (1) re-read task, (2) check for forbidden patterns, (3) confirm output format.' },
  expert_trusted:         { trigger: 'reputation >= 85',                   text: '\n🏆 TRUSTED EXPERT: You have high reputation. Take initiative on design decisions. Your judgment is trusted.' },
  // Priority-based
  critical_confirm:       { trigger: 'priority=critical',                  text: '\n🚨 CRITICAL TASK: Do NOT proceed until you fully understand requirements. State your interpretation first, then execute.' },
  // Failure-based
  prior_failure:          { trigger: 'has_prior_failure',                  text: '\n⚡ PRIOR FAILURE CONTEXT: A similar task previously failed. Carefully avoid: rushing, skipping validation, ambiguous outputs.' },
  // Context-based
  memory_context_rich:    { trigger: 'memory_results >= 3',                text: '\n📚 RICH CONTEXT: Team memory has relevant precedents. Align your approach with established patterns.' },
  memory_context_empty:   { trigger: 'memory_results == 0',                text: '\n🆕 NEW TERRITORY: No prior team context exists. Document your approach carefully for future reference.' },
  // Complexity
  complex_task:           { trigger: 'word_count > 50',                    text: '\n🧩 COMPLEX TASK: This requires multiple steps. Use numbered steps. Confirm completion of each before proceeding.' },
};

// ── Load/save genomes ──────────────────────────────────────────────────────────
function loadGenomes() { try { return JSON.parse(fs.readFileSync(GENOME_FILE, 'utf8')); } catch { return {}; } }
function saveGenomes(d) { try { fs.writeFileSync(GENOME_FILE, JSON.stringify(d, null, 2)); } catch {} }

// ── Evaluate which mutations apply ────────────────────────────────────────────
function evaluateMutations(signals = {}) {
  const { score_avg = 7, taskType = 'general', reputation = 70, priority = 'medium', has_prior_failure = false, memory_results = 0, word_count = 20 } = signals;
  const applied = [];

  if (score_avg < 6 && taskType === 'implement') applied.push('low_score_implementer');
  if (score_avg >= 8 && taskType === 'implement') applied.push('high_score_expert');
  if (score_avg < 6 && taskType === 'review')     applied.push('low_score_reviewer');
  if (reputation < 50)                            applied.push('probation_quality');
  if (reputation >= 85)                           applied.push('expert_trusted');
  if (priority === 'critical')                    applied.push('critical_confirm');
  if (has_prior_failure)                          applied.push('prior_failure');
  if (memory_results >= 3)                        applied.push('memory_context_rich');
  if (memory_results === 0)                       applied.push('memory_context_empty');
  if (word_count > 50)                            applied.push('complex_task');

  return applied;
}

// ── Adapt prompt ──────────────────────────────────────────────────────────────
export function adaptPrompt({ agentId, taskTitle = '', priority = 'medium', contextSignals = {} }) {
  const genomes = loadGenomes();
  if (!genomes[agentId]) genomes[agentId] = { mutations: {}, scoreHistory: [], lockedMutations: [] };

  const genome = genomes[agentId];
  const score_avg = genome.scoreHistory.length > 0 ? genome.scoreHistory.reduce((s, v) => s + v, 0) / genome.scoreHistory.length : 7;
  const word_count = taskTitle.split(' ').length;

  // Detect task type
  const low = taskTitle.toLowerCase();
  let taskType = 'general';
  if (/implement|build|create|add/.test(low))   taskType = 'implement';
  else if (/review|audit|check/.test(low))      taskType = 'review';
  else if (/test|qa|verify/.test(low))          taskType = 'test';
  else if (/deploy|release/.test(low))          taskType = 'deploy';

  const signals = { score_avg, taskType, priority, word_count, ...contextSignals };
  const applicableMutations = evaluateMutations(signals);

  // Build prompt mutations block
  const blocks = [];
  const mutationIds = [];
  for (const mutId of applicableMutations) {
    // Include locked mutations always; unlocked mutations are experimental
    const mutation = MUTATIONS[mutId];
    if (mutation) {
      blocks.push(mutation.text);
      mutationIds.push(mutId);
      // Track in genome
      if (!genome.mutations[mutId]) genome.mutations[mutId] = { applied: 0, kept: 0, avgScoreDelta: 0 };
      genome.mutations[mutId].applied++;
    }
  }

  saveGenomes(genomes);
  const adaptedBlock = blocks.join('');
  const entry = { ts: Date.now(), agentId, taskTitle: taskTitle.slice(0, 50), mutations: mutationIds, score_avg: Math.round(score_avg * 10) / 10 };
  fs.appendFileSync(ADAPT_LOG, JSON.stringify(entry) + '\n');

  if (mutationIds.length > 0) console.log(`[AdaptPrompt] 🧬 ${agentId}: applied mutations [${mutationIds.join(', ')}]`);
  return { agentId, mutations: mutationIds, block: adaptedBlock, score_avg: Math.round(score_avg * 10) / 10, taskType, signals };
}

// ── Feedback: keep or revert mutation ────────────────────────────────────────
export function recordFeedback({ agentId, mutationIds = [], score }) {
  const genomes = loadGenomes();
  if (!genomes[agentId]) return { ok: false, reason: 'No genome found' };

  const genome = genomes[agentId];
  genome.scoreHistory.push(score);
  if (genome.scoreHistory.length > 20) genome.scoreHistory.shift();

  for (const mutId of mutationIds) {
    if (!genome.mutations[mutId]) continue;
    const prevAvg = genome.mutations[mutId].avgScoreDelta || 0;
    const delta = score - (genome.scoreHistory.slice(-5, -1).reduce((s, v) => s + v, 0) / 4 || 7);
    genome.mutations[mutId].avgScoreDelta = Math.round((prevAvg + delta) / 2 * 10) / 10;
    if (genome.mutations[mutId].avgScoreDelta > 0.5) {
      genome.mutations[mutId].kept++;
      if (!genome.lockedMutations.includes(mutId)) genome.lockedMutations.push(mutId);
    } else if (genome.mutations[mutId].avgScoreDelta < -0.5) {
      genome.lockedMutations = genome.lockedMutations.filter(m => m !== mutId);
    }
  }

  saveGenomes(genomes);
  return { ok: true, agentId, score, mutationsUpdated: mutationIds.length, lockedCount: genome.lockedMutations.length };
}

export function getGenome(agentId) { const g = loadGenomes(); return g[agentId] || null; }
