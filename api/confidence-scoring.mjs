#!/usr/bin/env node
/**
 * CONFIDENCE SCORING — Gap #7 (HIGH PRIORITY)
 * Взвешивает доверие к каждой памяти (lesson, decision, trace)
 * 
 * Стратегия:
 * - Каждая память имеет confidence score (0.0-1.0)
 * - Score зависит от: success rate + age + consistency
 * - При retrieval: уважать confidence (high-confidence → используй, low → осторожнее)
 */

import fs from 'fs';
import * as reasoningTraces from './reasoning-traces.mjs';
import * as sessionState from './session-state-simple.mjs';

const SCORING_DB = '/Users/urmatmyrzabekov/.openclaw/confidence-scores.json';
const LOG_FILE = '/Users/urmatmyrzabekov/.openclaw/logs/confidence-scoring.log';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ════════════════════════════════════════════════════════════════════════════
// CONFIDENCE CALCULATOR
// ════════════════════════════════════════════════════════════════════════════

function calculateConfidence(item) {
  /**
   * Confidence formula:
   * base = success_rate (0.0-1.0)
   * age_penalty = -0.001 * days_old (старые уроки менее значимы)
   * consistency_bonus = +0.1 * (repeat_count / 10) (повторённое = надёжнее)
   * confidence = base + age_penalty + consistency_bonus
   */
  
  let confidence = 0.5; // базовое значение
  
  // Factor 1: Success rate (40% вес)
  if (item.success_rate) {
    confidence += item.success_rate * 0.4;
  }
  
  // Factor 2: Age penalty (10% вес)
  if (item.created_at || item.indexed_at) {
    const timestamp = new Date(item.created_at || item.indexed_at);
    const age_days = (Date.now() - timestamp.getTime()) / (24 * 60 * 60 * 1000);
    const age_penalty = Math.max(-0.1, -0.001 * age_days);
    confidence += age_penalty;
  }
  
  // Factor 3: Consistency/repetition (30% вес)
  if (item.repeat_count) {
    const consistency = Math.min(0.3, 0.03 * item.repeat_count);
    confidence += consistency;
  }
  
  // Factor 4: Verified by multiple agents (20% бонус)
  if (item.verified_by && item.verified_by.length > 1) {
    confidence += 0.2;
  }
  
  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, confidence));
}

export function scoreItem(item) {
  const confidence = calculateConfidence(item);
  
  return {
    ...item,
    confidence,
    confidence_grade: confidence > 0.85 ? 'A'
      : confidence > 0.7 ? 'B'
      : confidence > 0.5 ? 'C'
      : confidence > 0.3 ? 'D'
      : 'F',
    confidence_level: confidence > 0.85 ? 'very-high'
      : confidence > 0.7 ? 'high'
      : confidence > 0.5 ? 'medium'
      : confidence > 0.3 ? 'low'
      : 'very-low',
    use_recommendation: confidence > 0.7 ? 'use-as-primary'
      : confidence > 0.5 ? 'use-with-caution'
      : 'verify-before-use'
  };
}

// ════════════════════════════════════════════════════════════════════════════
// CONFIDENCE TRACKING
// ════════════════════════════════════════════════════════════════════════════

function loadScoringDB() {
  if (fs.existsSync(SCORING_DB)) {
    return JSON.parse(fs.readFileSync(SCORING_DB, 'utf8'));
  }
  return { items: {}, update_history: [] };
}

function saveScoringDB(db) {
  fs.writeFileSync(SCORING_DB, JSON.stringify(db, null, 2));
}

export function recordConfidenceUpdate(item_id, old_confidence, new_confidence, reason) {
  const db = loadScoringDB();
  
  db.items[item_id] = {
    old_confidence,
    new_confidence,
    change: new_confidence - old_confidence,
    updated_at: new Date().toISOString(),
    reason
  };
  
  db.update_history.push({
    item_id,
    from: old_confidence,
    to: new_confidence,
    timestamp: new Date().toISOString()
  });
  
  saveScoringDB(db);
  
  log(`📊 Confidence updated: ${item_id} ${old_confidence.toFixed(2)} → ${new_confidence.toFixed(2)} (${reason})`);
}

export function updateConfidenceOnOutcome(item_id, success, quality_score, agent = null) {
  /**
   * Обновляет confidence когда мы видим результат
   */
  
  const db = loadScoringDB();
  const current = db.items[item_id] || {};
  const old_conf = current.new_confidence || 0.5;
  
  // Adjust based on outcome
  let adjustment = 0;
  
  if (success && quality_score > 0.8) {
    adjustment = +0.15; // Very successful → increase confidence
  } else if (success && quality_score > 0.6) {
    adjustment = +0.08; // Successful → modest increase
  } else if (!success) {
    adjustment = -0.2; // Failure → big decrease
  } else {
    adjustment = -0.05; // Poor quality → small decrease
  }
  
  const new_conf = Math.max(0, Math.min(1, old_conf + adjustment));
  
  recordConfidenceUpdate(item_id, old_conf, new_conf, `Outcome: ${success ? 'success' : 'failure'} (quality: ${quality_score})`);
  
  return new_conf;
}

// ════════════════════════════════════════════════════════════════════════════
// RETRIEVE WITH CONFIDENCE WEIGHTING
// ════════════════════════════════════════════════════════════════════════════

export function retrieveWithConfidence(items, minConfidence = 0.5) {
  /**
   * Фильтрует и ранжирует items по confidence
   */
  
  const scored = items.map(item => scoreItem(item));
  
  // Фильтр: минимум confidence
  const filtered = scored.filter(item => item.confidence >= minConfidence);
  
  // Сортировка: highest confidence first
  const ranked = filtered.sort((a, b) => b.confidence - a.confidence);
  
  return {
    total_items: items.length,
    after_filtering: filtered.length,
    retrieval_set: ranked,
    confidence_distribution: {
      very_high: ranked.filter(i => i.confidence > 0.85).length,
      high: ranked.filter(i => i.confidence > 0.7).length,
      medium: ranked.filter(i => i.confidence > 0.5).length,
      low: ranked.filter(i => i.confidence <= 0.5).length
    }
  };
}

// ════════════════════════════════════════════════════════════════════════════
// CONFIDENCE-BASED DECISION MAKING
// ════════════════════════════════════════════════════════════════════════════

export function recommendAction(items, minConfidenceForPrimary = 0.8) {
  /**
   * Рекомендует действие на основе confidence
   */
  
  const retrieved = retrieveWithConfidence(items);
  
  if (retrieved.retrieval_set.length === 0) {
    return { action: 'insufficient-data', reason: 'No items above confidence threshold' };
  }
  
  const primary = retrieved.retrieval_set[0];
  
  if (primary.confidence >= minConfidenceForPrimary) {
    return {
      action: 'use-primary',
      item: primary,
      confidence: primary.confidence,
      reasoning: `Primary item has high confidence (${primary.confidence.toFixed(2)})`
    };
  }
  
  // Multiple sources for confirmation
  if (retrieved.retrieval_set.length >= 2 && 
      retrieved.retrieval_set[0].confidence > 0.6 &&
      retrieved.retrieval_set[1].confidence > 0.6) {
    
    const consensus = retrieved.retrieval_set.slice(0, 3);
    const avgConfidence = consensus.reduce((sum, i) => sum + i.confidence, 0) / consensus.length;
    
    return {
      action: 'use-with-confirmation',
      primary: primary,
      confirmation_sources: consensus,
      consensus_confidence: avgConfidence,
      reasoning: `Consensus from ${consensus.length} sources (avg: ${avgConfidence.toFixed(2)})`
    };
  }
  
  return {
    action: 'escalate',
    reason: 'No high-confidence items found, escalate to human/atlas'
  };
}

// ════════════════════════════════════════════════════════════════════════════
// CONFIDENCE MONITORING
// ════════════════════════════════════════════════════════════════════════════

export function getConfidenceMetrics(agent = null) {
  const db = loadScoringDB();
  
  const items = Object.values(db.items);
  
  // Calculate statistics
  const confidences = items.map(i => i.new_confidence);
  const avg = confidences.length > 0
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : 0;
  const max = Math.max(...confidences, 0);
  const min = Math.min(...confidences, 1);
  
  return {
    total_scored: items.length,
    average_confidence: avg.toFixed(2),
    highest_confidence: max.toFixed(2),
    lowest_confidence: min.toFixed(2),
    grade_distribution: {
      A: items.filter(i => i.new_confidence > 0.85).length,
      B: items.filter(i => i.new_confidence > 0.7).length,
      C: items.filter(i => i.new_confidence > 0.5).length,
      D: items.filter(i => i.new_confidence > 0.3).length,
      F: items.filter(i => i.new_confidence <= 0.3).length
    },
    recent_updates: db.update_history.slice(-10)
  };
}

// ════════════════════════════════════════════════════════════════════════════
// AUTO-CALIBRATION
// ════════════════════════════════════════════════════════════════════════════

export function autoCalibrateConfidence() {
  /**
   * Периодически пересчитывает confidence на основе recent outcomes
   */
  
  log(`🔄 Auto-calibrating confidence scores...`);
  
  const traces = reasoningTraces.getTracesStats();
  const lessons = sessionState.getLessons() || [];
  
  let calibrated = 0;
  
  lessons.forEach(lesson => {
    // Если lesson успешно (success_rate > 0.7) → boost confidence
    if (lesson.success_rate > 0.7) {
      updateConfidenceOnOutcome(lesson.id, true, lesson.success_rate, 'Auto-calibration: high success');
      calibrated++;
    } else if (lesson.success_rate < 0.3) {
      updateConfidenceOnOutcome(lesson.id, false, lesson.success_rate, 'Auto-calibration: low success');
      calibrated++;
    }
  });
  
  log(`✓ Calibrated ${calibrated} items`);
  
  return calibrated;
}