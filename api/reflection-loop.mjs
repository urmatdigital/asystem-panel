#!/usr/bin/env node
/**
 * REFLECTION LOOP — Priority #3 Gap Fix
 * Automatic error correction and pattern learning
 * Runs post-action: evaluate outcome, analyze failure, store lesson
 * 
 * Feedback cycle: Decision → Execute → Evaluate → Reflect → Learn → Improve
 */

import fs from 'fs';
import * as reasoningTraces from './reasoning-traces.mjs';
import * as sessionState from './session-state-simple.mjs';

const LOG_FILE = '/Users/urmatmyrzabekov/.openclaw/logs/reflection-loop.log';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ════════════════════════════════════════════════════════════════════════════
// REFLECTION CYCLE
// ════════════════════════════════════════════════════════════════════════════

export async function runReflectionCycle(agent, decision_id, outcome) {
  const {
    success,
    quality_score = 0.5,
    feedback = null,
    duration_ms = 0
  } = outcome;
  
  log(`🔄 Reflection cycle started: ${agent} decision ${decision_id}`);
  
  // Step 1: Evaluate outcome
  const evaluation = evaluateOutcome(success, quality_score);
  log(`   1️⃣  Evaluation: ${evaluation.status} (quality: ${quality_score})`);
  
  // Step 2: Analyze reasoning (if available)
  let traces = reasoningTraces.getTracesForAgent(agent);
  let failureAnalysis = null;
  
  if (traces.length > 0) {
    const lastTrace = traces[0];
    if (!success) {
      failureAnalysis = reasoningTraces.analyzeFailure(lastTrace);
      log(`   2️⃣  Failure analysis: ${failureAnalysis.root_causes.join(', ')}`);
    }
  }
  
  // Step 3: Extract lessons
  const lesson = extractLesson(agent, decision_id, evaluation, failureAnalysis);
  log(`   3️⃣  Lesson extracted: ${lesson.category}`);
  
  // Step 4: Update confidence
  const patterns = reasoningTraces.extractDecisionPatterns(agent);
  const confidenceAdjustment = calculateConfidenceAdjustment(patterns);
  log(`   4️⃣  Confidence adjustment: ${confidenceAdjustment > 0 ? '+' : ''}${confidenceAdjustment}`);
  
  // Step 5: Store lesson + update state
  const result = await storeLesson(agent, lesson);
  log(`   5️⃣  Lesson stored: ${result.id}`);
  
  // Step 6: Trigger improvement if needed
  if (!success && failureAnalysis) {
    const improvement = await recommendImprovement(agent, failureAnalysis);
    log(`   6️⃣  Improvement recommended: ${improvement.action}`);
    
    return {
      status: 'learned_from_failure',
      lesson,
      improvement,
      analysis: failureAnalysis
    };
  }
  
  return {
    status: 'learned_from_success',
    lesson,
    evaluation
  };
}

// ════════════════════════════════════════════════════════════════════════════
// EVALUATION
// ════════════════════════════════════════════════════════════════════════════

function evaluateOutcome(success, quality_score) {
  const status = quality_score > 0.8 ? 'excellent'
    : quality_score > 0.6 ? 'good'
    : quality_score > 0.4 ? 'acceptable'
    : quality_score > 0.2 ? 'poor'
    : 'failed';
  
  return {
    success,
    quality_score,
    status,
    grade: quality_score > 0.7 ? 'A' : quality_score > 0.6 ? 'B' : quality_score > 0.4 ? 'C' : 'F'
  };
}

// ════════════════════════════════════════════════════════════════════════════
// LESSON EXTRACTION
// ════════════════════════════════════════════════════════════════════════════

function extractLesson(agent, decision_id, evaluation, failureAnalysis) {
  let lesson = {};
  
  if (evaluation.success && evaluation.quality_score > 0.7) {
    // Successful decision - extract positive pattern
    lesson = {
      type: 'success_pattern',
      category: 'positive_reinforcement',
      pattern: `Decision succeeded with quality ${(evaluation.quality_score * 100).toFixed(0)}%`,
      success_rate: 0.9, // Assume 90% success
      confidence: 0.8,
      action: 'Replicate this reasoning'
    };
  } else if (!evaluation.success && failureAnalysis) {
    // Failed decision - extract negative pattern
    lesson = {
      type: 'failure_pattern',
      category: failureAnalysis.root_causes[0] || 'unknown',
      pattern: `Avoid: ${failureAnalysis.root_causes.join(', ')}`,
      success_rate: 0.1, // Assume 10% success
      confidence: 0.6,
      action: failureAnalysis.recommendations[0] || 'Review reasoning process'
    };
  } else {
    // Acceptable outcome
    lesson = {
      type: 'neutral_pattern',
      category: 'acceptable',
      pattern: `Outcome acceptable but not optimal (quality: ${(evaluation.quality_score * 100).toFixed(0)}%)`,
      success_rate: 0.5,
      confidence: 0.5,
      action: 'Can improve - consider alternatives'
    };
  }
  
  lesson.decision_id = decision_id;
  lesson.agent = agent;
  lesson.learned_at = new Date().toISOString();
  
  return lesson;
}

// ════════════════════════════════════════════════════════════════════════════
// CONFIDENCE ADJUSTMENT
// ════════════════════════════════════════════════════════════════════════════

function calculateConfidenceAdjustment(patterns) {
  // Adjust confidence based on pattern success rate
  let adjustment = 0;
  
  // If most recent decisions succeeded → increase confidence
  if (patterns.successful_patterns.length > patterns.failed_patterns.length) {
    adjustment = +0.05;
  }
  
  // If recent failures → decrease confidence
  if (patterns.failed_patterns.length > patterns.successful_patterns.length) {
    adjustment = -0.1;
  }
  
  // If low-confidence decisions succeeded → increase confidence in low-confidence
  if (patterns.low_confidence.filter(p => p.success).length > 0) {
    adjustment += 0.02;
  }
  
  return adjustment;
}

// ════════════════════════════════════════════════════════════════════════════
// STORE LESSON
// ════════════════════════════════════════════════════════════════════════════

async function storeLesson(agent, lesson) {
  try {
    const state = sessionState.loadAgentState(agent);
    const lessons = sessionState.getLessons();
    
    const storedLesson = {
      id: `lesson_${Date.now()}`,
      ...lesson,
      stored_at: new Date().toISOString()
    };
    
    // Record to session state
    sessionState.recordLesson(agent, storedLesson);
    
    log(`✓ Lesson stored for ${agent}: ${storedLesson.pattern.slice(0, 50)}`);
    
    return storedLesson;
  } catch (err) {
    log(`✗ Error storing lesson: ${err.message}`);
    throw err;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// RECOMMEND IMPROVEMENT
// ════════════════════════════════════════════════════════════════════════════

async function recommendImprovement(agent, failureAnalysis) {
  const recommendations = failureAnalysis.recommendations || [];
  
  const improvement = {
    agent,
    action: recommendations[0] || 'Review decision process',
    priority: 'high',
    steps: [
      ...recommendations,
      'Run reflection cycle on next decision',
      'Compare with historical successful patterns'
    ],
    scheduled_for: new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString() // 1 hour
  };
  
  log(`✓ Improvement scheduled for ${agent}`);
  
  return improvement;
}

// ════════════════════════════════════════════════════════════════════════════
// REFLECTION METRICS
// ════════════════════════════════════════════════════════════════════════════

export function getReflectionMetrics(agent = null) {
  const traceStats = reasoningTraces.getTracesStats(agent);
  const lessons = sessionState.getLessons();
  
  const metrics = {
    traces: traceStats,
    lessons_learned: lessons.length,
    categories: {
      success_patterns: lessons.filter(l => l.type === 'success_pattern').length,
      failure_patterns: lessons.filter(l => l.type === 'failure_pattern').length,
      neutral_patterns: lessons.filter(l => l.type === 'neutral_pattern').length
    },
    effectiveness: {
      learning_rate: lessons.length > 0 ? 'active' : 'idle',
      improvement_velocity: calculateImprovementVelocity(lessons),
      next_reflection_cycle: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 min
    }
  };
  
  return metrics;
}

function calculateImprovementVelocity(lessons) {
  if (lessons.length < 2) return 'insufficient_data';
  
  const recent = lessons.slice(-10);
  const successful = recent.filter(l => l.success_rate > 0.7).length;
  const failed = recent.filter(l => l.success_rate < 0.3).length;
  
  if (successful > failed) return 'improving';
  if (failed > successful) return 'degrading';
  return 'stable';
}

// ════════════════════════════════════════════════════════════════════════════
// AUTO-TRIGGER ON DECISION OUTCOME
// ════════════════════════════════════════════════════════════════════════════

export function autoReflectOnOutcome(agent, decision, outcome) {
  // Wrapper to automatically trigger reflection on any decision outcome
  
  log(`🤔 Auto-reflection triggered for ${agent}`);
  
  return runReflectionCycle(agent, decision.id || `dec_${Date.now()}`, outcome)
    .then(result => {
      log(`✓ Reflection complete: ${result.status}`);
      return result;
    })
    .catch(err => {
      log(`✗ Reflection failed: ${err.message}`);
      return null;
    });
}