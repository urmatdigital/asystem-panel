#!/usr/bin/env node
/**
 * REASONING TRACES — Priority #2 Gap Fix
 * Store intermediate reasoning steps for every decision
 * Learn WHY decisions were made, not just WHAT
 * 
 * Enables: "When should we use Opus?" → retrieves reasoning traces with similar context
 */

import fs from 'fs';

const TRACES_DB = '/Users/urmatmyrzabekov/.openclaw/reasoning-traces.json';
const LOG_FILE = '/Users/urmatmyrzabekov/.openclaw/logs/reasoning-traces.log';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ════════════════════════════════════════════════════════════════════════════
// REASONING TRACE STRUCTURE
// ════════════════════════════════════════════════════════════════════════════

export function recordReasoningTrace(agent, context) {
  const {
    decision_title,
    reasoning_steps = [],
    chosen_option,
    alternatives = [],
    confidence,
    result_quality = null,
    time_ms = 0
  } = context;
  
  const trace = {
    id: `trace_${Date.now()}`,
    agent,
    decision_title,
    reasoning_steps: reasoning_steps.map((step, idx) => ({
      step_number: idx + 1,
      description: step,
      timestamp: new Date().toISOString()
    })),
    decision: {
      chosen_option,
      alternatives,
      reasoning: reasoning_steps.join(' → '),
      confidence
    },
    outcome: {
      result_quality, // null if not yet evaluated
      success: result_quality ? result_quality > 0.7 : null
    },
    metadata: {
      processing_time_ms: time_ms,
      recorded_at: new Date().toISOString()
    }
  };
  
  // Save to disk
  let db = loadTracesDB();
  db.traces.push(trace);
  saveTracesDB(db);
  
  log(`📝 Reasoning trace recorded: ${decision_title} (${reasoning_steps.length} steps, confidence: ${confidence})`);
  
  return trace;
}

// ════════════════════════════════════════════════════════════════════════════
// TRACE RETRIEVAL & ANALYSIS
// ════════════════════════════════════════════════════════════════════════════

export function findSimilarTraces(query, topK = 5) {
  const db = loadTracesDB();
  
  const results = db.traces
    .map(trace => {
      // Simple similarity: count matching keywords
      const reasoning = trace.decision.reasoning.toLowerCase();
      const queryLower = query.toLowerCase();
      
      let score = 0;
      queryLower.split(/\s+/).forEach(word => {
        if (word.length > 2 && reasoning.includes(word)) {
          score++;
        }
      });
      
      return {
        ...trace,
        similarity_score: score / queryLower.split(/\s+/).length
      };
    })
    .filter(t => t.similarity_score > 0)
    .sort((a, b) => b.similarity_score - a.similarity_score)
    .slice(0, topK);
  
  log(`🔍 Found ${results.length} similar traces for: "${query}"`);
  
  return results;
}

export function getTracesForAgent(agent) {
  const db = loadTracesDB();
  
  return db.traces
    .filter(t => t.agent === agent)
    .sort((a, b) => new Date(b.metadata.recorded_at) - new Date(a.metadata.recorded_at));
}

export function getSuccessfulTraces(agent = null) {
  const db = loadTracesDB();
  
  let traces = db.traces.filter(t => t.outcome.success === true);
  if (agent) traces = traces.filter(t => t.agent === agent);
  
  return traces.sort((a, b) => b.decision.confidence - a.decision.confidence);
}

export function getFailedTraces(agent = null) {
  const db = loadTracesDB();
  
  let traces = db.traces.filter(t => t.outcome.success === false);
  if (agent) traces = traces.filter(t => t.agent === agent);
  
  return traces;
}

// ════════════════════════════════════════════════════════════════════════════
// PATTERN EXTRACTION FROM TRACES
// ════════════════════════════════════════════════════════════════════════════

export function extractDecisionPatterns(agent = null) {
  const db = loadTracesDB();
  
  let traces = db.traces;
  if (agent) traces = traces.filter(t => t.agent === agent);
  
  const patterns = {
    successful_patterns: [],
    failed_patterns: [],
    high_confidence: [],
    low_confidence: []
  };
  
  // Successful patterns
  traces
    .filter(t => t.outcome.success === true)
    .slice(0, 10)
    .forEach(trace => {
      patterns.successful_patterns.push({
        decision: trace.decision_title,
        steps: trace.reasoning_steps.length,
        reasoning: trace.decision.reasoning.slice(0, 100),
        confidence: trace.decision.confidence
      });
    });
  
  // Failed patterns (learn from mistakes!)
  traces
    .filter(t => t.outcome.success === false)
    .slice(0, 10)
    .forEach(trace => {
      patterns.failed_patterns.push({
        decision: trace.decision_title,
        reasoning: trace.decision.reasoning.slice(0, 100),
        confidence: trace.decision.confidence,
        lesson: `Avoid this reasoning pattern`
      });
    });
  
  // High confidence traces
  traces
    .filter(t => t.decision.confidence > 0.8)
    .slice(0, 5)
    .forEach(trace => {
      patterns.high_confidence.push({
        decision: trace.decision_title,
        confidence: trace.decision.confidence,
        success: trace.outcome.success
      });
    });
  
  // Low confidence traces (risky)
  traces
    .filter(t => t.decision.confidence < 0.5)
    .slice(0, 5)
    .forEach(trace => {
      patterns.low_confidence.push({
        decision: trace.decision_title,
        confidence: trace.decision.confidence,
        success: trace.outcome.success,
        risk: 'high'
      });
    });
  
  log(`📊 Extracted patterns: ${patterns.successful_patterns.length} successful, ${patterns.failed_patterns.length} failed`);
  
  return patterns;
}

// ════════════════════════════════════════════════════════════════════════════
// REFLECTION ON FAILURES
// ════════════════════════════════════════════════════════════════════════════

export function analyzeFailure(trace) {
  const analysis = {
    trace_id: trace.id,
    decision: trace.decision_title,
    root_causes: [],
    recommendations: [],
    confidence: 0.5
  };
  
  // Analyze reasoning steps
  if (trace.reasoning_steps.length < 3) {
    analysis.root_causes.push('Insufficient reasoning depth');
    analysis.recommendations.push('Add more reasoning steps before deciding');
  }
  
  if (trace.decision.confidence < 0.5) {
    analysis.root_causes.push('Low confidence decision');
    analysis.recommendations.push('Request more information or defer decision');
  }
  
  if (trace.decision.alternatives.length === 0) {
    analysis.root_causes.push('No alternatives considered');
    analysis.recommendations.push('Always evaluate 2-3 alternatives');
  }
  
  // Check for missing context
  if (trace.decision.reasoning.length < 50) {
    analysis.root_causes.push('Insufficient context in reasoning');
    analysis.recommendations.push('Include more contextual factors');
  }
  
  log(`🔍 Failure analysis: ${trace.decision_title} → ${analysis.root_causes.length} root causes identified`);
  
  return analysis;
}

// ════════════════════════════════════════════════════════════════════════════
// DATABASE OPERATIONS
// ════════════════════════════════════════════════════════════════════════════

function loadTracesDB() {
  if (fs.existsSync(TRACES_DB)) {
    try {
      return JSON.parse(fs.readFileSync(TRACES_DB, 'utf8'));
    } catch (err) {
      log(`✗ Error loading traces DB: ${err.message}`);
      return { traces: [] };
    }
  }
  return { traces: [] };
}

function saveTracesDB(db) {
  try {
    fs.writeFileSync(TRACES_DB, JSON.stringify(db, null, 2));
  } catch (err) {
    log(`✗ Error saving traces DB: ${err.message}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// STATS & MONITORING
// ════════════════════════════════════════════════════════════════════════════

export function getTracesStats(agent = null) {
  const db = loadTracesDB();
  
  let traces = db.traces;
  if (agent) traces = traces.filter(t => t.agent === agent);
  
  const stats = {
    total_traces: traces.length,
    successful: traces.filter(t => t.outcome.success === true).length,
    failed: traces.filter(t => t.outcome.success === false).length,
    pending_evaluation: traces.filter(t => t.outcome.success === null).length,
    average_confidence: traces.length > 0
      ? (traces.reduce((sum, t) => sum + t.decision.confidence, 0) / traces.length).toFixed(2)
      : 0,
    average_reasoning_steps: traces.length > 0
      ? (traces.reduce((sum, t) => sum + t.reasoning_steps.length, 0) / traces.length).toFixed(1)
      : 0,
    db_size_kb: Math.round(JSON.stringify(db).length / 1024)
  };
  
  // Calculate success rate
  const evaluated = traces.filter(t => t.outcome.success !== null).length;
  stats.success_rate = evaluated > 0
    ? ((stats.successful / evaluated) * 100).toFixed(1) + '%'
    : 'N/A';
  
  return stats;
}