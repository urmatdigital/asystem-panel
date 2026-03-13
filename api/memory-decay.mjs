/**
 * memory-decay.mjs — Ebbinghaus Forgetting Curve for ZVec Memory
 *
 * Video: "AI Memory Management: Forgetting Curve, Decay, and Agent Stability" (TFKGW5hM4PQ)
 * Pattern: Memory strength = initial_strength * e^(-decay_rate * time_days)
 *   Each retrieval event "pulses" the strength back toward 1.0 (reinforcement)
 *   Memories below threshold are marked stale and excluded from injection
 *
 * Decay rates (half-life):
 *   episodic   → 7 days  (what happened yesterday is less relevant next week)
 *   semantic   → 30 days (general facts stay longer)
 *   causal_chain→ 14 days (cause→action→outcome chains decay moderately)
 *   system     → 60 days (skill deltas, agent config — stay longest)
 *   personal   → 90 days (user preferences — near permanent)
 *
 * Storage: ~/.openclaw/workspace/.memory-strength.json
 *   { memoryId → { strength, lastAccess, decayRate, reinforcements } }
 *
 * Integration with ZVec: strengthened memories retrieved first;
 *   stale memories (strength < 0.1) excluded from buildKGContext / retrieveTips
 *
 * API:
 *   GET  /api/memory/decay/stats         — decay stats per type
 *   POST /api/memory/decay/reinforce     { memoryId } — manual reinforce
 *   POST /api/memory/decay/gc            — garbage collect stale memories
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME         = os.homedir();
const STRENGTH_FILE = path.join(HOME, '.openclaw/workspace/.memory-strength.json');

// ── Decay rates (per day, ln(2)/half_life_days) ───────────────────────────────
const DECAY_RATES = {
  episodic:     Math.LN2 / 7,    // half-life: 7 days
  causal_chain: Math.LN2 / 14,   // half-life: 14 days
  semantic:     Math.LN2 / 30,   // half-life: 30 days
  system:       Math.LN2 / 60,   // half-life: 60 days
  personal:     Math.LN2 / 90,   // half-life: 90 days
};

const STALE_THRESHOLD = 0.1;   // memories below this are "forgotten"
const REINFORCE_PULSE  = 0.4;  // retrieval boosts strength by this amount

// ── Load / save strength map ──────────────────────────────────────────────────
function loadStrengths() {
  try { return JSON.parse(fs.readFileSync(STRENGTH_FILE, 'utf8')); } catch { return {}; }
}
function saveStrengths(s) {
  try { fs.writeFileSync(STRENGTH_FILE, JSON.stringify(s, null, 2)); } catch {}
}

// ── Compute current strength for a memory ────────────────────────────────────
export function getStrength(memoryId, memoryType = 'semantic') {
  const strengths = loadStrengths();
  const entry = strengths[memoryId];
  if (!entry) return 1.0; // new memory: full strength

  const ageMs  = Date.now() - entry.lastAccess;
  const ageDays = ageMs / 86_400_000;
  const rate   = DECAY_RATES[memoryType] || DECAY_RATES.semantic;
  const strength = entry.strength * Math.exp(-rate * ageDays);
  return Math.max(0, Math.min(1, strength));
}

// ── Register a new memory (call when writing to ZVec) ────────────────────────
export function registerMemory(memoryId, memoryType = 'semantic') {
  const strengths = loadStrengths();
  strengths[memoryId] = {
    strength: 1.0,
    lastAccess: Date.now(),
    decayRate: DECAY_RATES[memoryType] || DECAY_RATES.semantic,
    memoryType,
    reinforcements: 0,
    createdAt: Date.now(),
  };
  saveStrengths(strengths);
}

// ── Reinforce a memory (call on retrieval) ────────────────────────────────────
export function reinforceMemory(memoryId, memoryType = 'semantic') {
  const strengths = loadStrengths();
  const entry = strengths[memoryId];
  if (!entry) { registerMemory(memoryId, memoryType); return; }

  // Compute current decayed strength first
  const ageMs   = Date.now() - entry.lastAccess;
  const ageDays = ageMs / 86_400_000;
  const decayed = entry.strength * Math.exp(-entry.decayRate * ageDays);

  // Pulse: add reinforce amount, cap at 1.0
  entry.strength = Math.min(1.0, decayed + REINFORCE_PULSE);
  entry.lastAccess = Date.now();
  entry.reinforcements++;
  saveStrengths(strengths);
  return entry.strength;
}

// ── Filter memory list by strength ───────────────────────────────────────────
export function filterByStrength(memories, minStrength = STALE_THRESHOLD) {
  const strengths = loadStrengths();
  const now = Date.now();

  return memories.map(m => {
    const id = m.id || m.memoryId || m._id;
    const type = m.memory_type || m.memoryType || 'semantic';
    const entry = strengths[id];
    let strength = 1.0;
    if (entry) {
      const ageMs = now - entry.lastAccess;
      const ageDays = ageMs / 86_400_000;
      strength = Math.max(0, entry.strength * Math.exp(-entry.decayRate * ageDays));
    }
    return { ...m, _strength: strength };
  })
  .filter(m => m._strength >= minStrength)
  .sort((a, b) => b._strength - a._strength);
}

// ── Garbage collect stale memories ────────────────────────────────────────────
export function gcStaleMemories() {
  const strengths = loadStrengths();
  const now = Date.now();
  const removed = [];

  for (const [id, entry] of Object.entries(strengths)) {
    const ageMs   = now - entry.lastAccess;
    const ageDays = ageMs / 86_400_000;
    const strength = entry.strength * Math.exp(-entry.decayRate * ageDays);
    if (strength < STALE_THRESHOLD) {
      removed.push({ id, strength: strength.toFixed(3), ageDays: Math.round(ageDays), type: entry.memoryType });
      delete strengths[id];
    }
  }

  saveStrengths(strengths);
  if (removed.length) console.log(`[MemoryDecay] 🗑️ GC: removed ${removed.length} stale memories`);
  return removed;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getDecayStats() {
  const strengths = loadStrengths();
  const now = Date.now();
  const byType = {};
  let stale = 0, strong = 0;

  for (const [id, entry] of Object.entries(strengths)) {
    const ageMs   = now - entry.lastAccess;
    const ageDays = ageMs / 86_400_000;
    const strength = entry.strength * Math.exp(-entry.decayRate * ageDays);
    const type = entry.memoryType || 'unknown';
    if (!byType[type]) byType[type] = { total: 0, avgStrength: 0, stale: 0 };
    byType[type].total++;
    byType[type].avgStrength += strength;
    if (strength < STALE_THRESHOLD) { byType[type].stale++; stale++; }
    else strong++;
  }

  for (const t of Object.values(byType)) {
    t.avgStrength = t.total ? Math.round((t.avgStrength / t.total) * 100) / 100 : 0;
  }

  return {
    total: Object.keys(strengths).length,
    strong, stale,
    staleThreshold: STALE_THRESHOLD,
    byType,
    halfLivesDays: { episodic: 7, causal_chain: 14, semantic: 30, system: 60, personal: 90 },
  };
}
