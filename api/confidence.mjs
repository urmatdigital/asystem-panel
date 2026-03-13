/**
 * confidence.mjs — Confidence Calibration & Uncertainty Estimation
 *
 * Video: "Agentic RAG Debate System (Multi-LLM)—Evidence-First Document
 *         Intelligence with Calibrated Consensus" (2QHjkB-K5dc)
 *
 * Pattern: Every agent output has a calibrated confidence score
 *   Evidence-based scoring (not just agent self-report)
 *   Uncertainty bounds: HIGH/MEDIUM/LOW
 *   Signals that trigger human review:
 *     - confidence < 0.4 → flag for review
 *     - uncertainty = HIGH + critical priority → escalate
 *     - conflicting signals (debate dissent > 0.6) → request clarification
 *
 * Calibration sources:
 *   1. Schema validation pass rate → structural confidence
 *   2. Karpathy score → quality confidence
 *   3. Self-critic score → self-consistency confidence
 *   4. Output length → completeness proxy
 *   5. Error keywords → negative signal
 *
 * Calibrated confidence = weighted average of signals
 *
 * API:
 *   POST /api/confidence/score  { agentId, result, score, schemaValid, outputLen }
 *   GET  /api/confidence/stats  — calibration stats per agent
 *   GET  /api/confidence/flags  — tasks flagged for review (last 24h)
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const CONF_LOG  = path.join(HOME, '.openclaw/workspace/confidence-log.jsonl');
const FLAGS_LOG = path.join(HOME, '.openclaw/workspace/confidence-flags.jsonl');

// ── Error / uncertainty signal keywords ───────────────────────────────────────
const UNCERTAINTY_WORDS = [
  'i think', 'i believe', 'possibly', 'might be', 'not sure', 'unclear',
  'uncertain', 'perhaps', 'probably', 'may be', 'it seems', 'assuming',
  'could be', 'approximately', 'roughly', 'around', "don't know",
];
const ERROR_WORDS = [
  'error', 'failed', 'exception', 'traceback', 'undefined', 'null',
  'cannot', "couldn't", 'unable to', 'timeout', 'refused', 'denied',
];

// ── Score calibration ─────────────────────────────────────────────────────────
export function calibrateConfidence({ agentId, result = '', karpathyScore, schemaValid, outputLen, priority = 'medium' }) {
  const text = String(result).toLowerCase();
  const signals = [];

  // Signal 1: Karpathy quality score (0-10 → 0-1)
  if (karpathyScore !== undefined) {
    const kScore = Math.min(1, karpathyScore / 10);
    signals.push({ name: 'karpathy', weight: 0.35, value: kScore });
  }

  // Signal 2: Schema validation
  if (schemaValid !== undefined) {
    signals.push({ name: 'schema', weight: 0.2, value: schemaValid ? 1 : 0.3 });
  }

  // Signal 3: Output completeness (length)
  const actualLen = outputLen || text.length;
  const lenScore = Math.min(1, actualLen / 500); // 500 chars = full confidence
  signals.push({ name: 'length', weight: 0.15, value: lenScore });

  // Signal 4: Uncertainty word density (negative)
  const wordCount = text.split(/\s+/).length || 1;
  const uncertainCount = UNCERTAINTY_WORDS.filter(w => text.includes(w)).length;
  const uncertainScore = Math.max(0, 1 - (uncertainCount / wordCount) * 20);
  signals.push({ name: 'uncertainty', weight: 0.2, value: uncertainScore });

  // Signal 5: Error word density (negative)
  const errorCount = ERROR_WORDS.filter(w => text.includes(w)).length;
  const errorScore = Math.max(0, 1 - errorCount * 0.25);
  signals.push({ name: 'errors', weight: 0.1, value: errorScore });

  // Weighted average
  const totalWeight = signals.reduce((s, sg) => s + sg.weight, 0);
  const raw = signals.reduce((s, sg) => s + sg.weight * sg.value, 0) / (totalWeight || 1);
  const confidence = Math.round(raw * 100) / 100;

  // Uncertainty level
  const uncertainty = confidence >= 0.75 ? 'LOW' : confidence >= 0.5 ? 'MEDIUM' : 'HIGH';

  // Flag for review
  const shouldFlag = confidence < 0.4 || (uncertainty === 'HIGH' && priority === 'critical');
  const entry = {
    ts: Date.now(), agentId, confidence, uncertainty, signals: signals.map(s => ({ name: s.name, value: Math.round(s.value * 100) / 100 })),
    flagged: shouldFlag, priority,
  };

  fs.appendFileSync(CONF_LOG, JSON.stringify(entry) + '\n');
  if (shouldFlag) {
    fs.appendFileSync(FLAGS_LOG, JSON.stringify({ ...entry, result: text.slice(0, 200) }) + '\n');
    console.warn(`[Confidence] 🚨 LOW CONFIDENCE: ${agentId} = ${confidence} (${uncertainty}) → flagged for review`);
  } else {
    console.log(`[Confidence] ${agentId}: ${confidence} (${uncertainty})`);
  }

  return { confidence, uncertainty, signals: entry.signals, flagged: shouldFlag };
}

// ── Get stats ─────────────────────────────────────────────────────────────────
export function getConfidenceStats() {
  try {
    const lines = fs.readFileSync(CONF_LOG, 'utf8').trim().split('\n').filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const byAgent = {};
    for (const e of entries) {
      if (!byAgent[e.agentId]) byAgent[e.agentId] = { count: 0, totalConf: 0, flags: 0 };
      byAgent[e.agentId].count++;
      byAgent[e.agentId].totalConf += e.confidence;
      if (e.flagged) byAgent[e.agentId].flags++;
    }
    for (const ag of Object.values(byAgent)) ag.avgConf = Math.round((ag.totalConf / ag.count) * 100) / 100;
    return { total: entries.length, flagged: entries.filter(e => e.flagged).length, byAgent };
  } catch { return { total: 0, flagged: 0, byAgent: {} }; }
}

export function getFlags() {
  try {
    const cutoff = Date.now() - 24 * 60 * 60_000;
    const lines = fs.readFileSync(FLAGS_LOG, 'utf8').trim().split('\n').filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(e => e && e.ts > cutoff);
  } catch { return []; }
}
