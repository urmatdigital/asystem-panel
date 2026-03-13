#!/usr/bin/env node
/**
 * ANOMALY DETECTION — Final system polish
 * Детектирует аномальное поведение и алертирует
 * 
 * Аномалии:
 * - Agent success rate drops >20%
 * - Decision time increases >2x baseline
 * - Confidence scores diverge from actual success
 * - Memory usage spike
 * - High failure rate on specific task type
 */

import fs from 'fs';

const ANOMALY_DB = '/Users/urmatmyrzabekov/.openclaw/anomalies.json';
const BASELINE_DB = '/Users/urmatmyrzabekov/.openclaw/anomaly-baseline.json';
const LOG_FILE = '/Users/urmatmyrzabekov/.openclaw/logs/anomalies.log';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ════════════════════════════════════════════════════════════════════════════
// BASELINE ESTABLISHMENT
// ════════════════════════════════════════════════════════════════════════════

export function establishBaseline(metrics) {
  /**
   * Устанавливает baseline для сравнения
   */
  
  const baseline = {
    established_at: new Date().toISOString(),
    metrics: {
      success_rate: metrics.success_rate || 0.85,
      avg_decision_time_ms: metrics.avg_decision_time_ms || 300,
      avg_confidence: metrics.avg_confidence || 0.8,
      memory_usage_mb: metrics.memory_usage_mb || 50,
      error_rate: metrics.error_rate || 0.05
    },
    thresholds: {
      success_rate_drop: 0.2,        // 20% drop triggers alert
      decision_time_increase: 2.0,   // 2x increase triggers alert
      confidence_divergence: 0.2,    // >20% divergence triggers alert
      memory_spike: 1.5,             // 1.5x increase triggers alert
      error_rate_increase: 2.0       // 2x increase triggers alert
    }
  };
  
  fs.writeFileSync(BASELINE_DB, JSON.stringify(baseline, null, 2));
  log(`✓ Baseline established`);
  
  return baseline;
}

function loadBaseline() {
  if (fs.existsSync(BASELINE_DB)) {
    return JSON.parse(fs.readFileSync(BASELINE_DB, 'utf8'));
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// ANOMALY DETECTION
// ════════════════════════════════════════════════════════════════════════════

export function detectAnomalies(currentMetrics) {
  /**
   * Сравнивает текущие метрики с baseline
   */
  
  const baseline = loadBaseline();
  if (!baseline) {
    log(`⚠️ No baseline, establishing...`);
    return { anomalies: [] };
  }
  
  const anomalies = [];
  const { metrics: baselineMetrics, thresholds } = baseline;
  const now = new Date().toISOString();
  
  // Check 1: Success rate drop
  if (currentMetrics.success_rate) {
    const drop = baselineMetrics.success_rate - currentMetrics.success_rate;
    if (drop > thresholds.success_rate_drop) {
      anomalies.push({
        type: 'success-rate-drop',
        severity: 'high',
        baseline: baselineMetrics.success_rate,
        current: currentMetrics.success_rate,
        drop: drop,
        threshold: thresholds.success_rate_drop,
        detected_at: now
      });
    }
  }
  
  // Check 2: Decision time increase
  if (currentMetrics.avg_decision_time_ms) {
    const increase = currentMetrics.avg_decision_time_ms / baselineMetrics.avg_decision_time_ms;
    if (increase > thresholds.decision_time_increase) {
      anomalies.push({
        type: 'decision-time-spike',
        severity: 'medium',
        baseline: baselineMetrics.avg_decision_time_ms,
        current: currentMetrics.avg_decision_time_ms,
        increase_ratio: increase,
        threshold: thresholds.decision_time_increase,
        detected_at: now
      });
    }
  }
  
  // Check 3: Confidence divergence
  if (currentMetrics.avg_confidence && currentMetrics.actual_success_rate) {
    const divergence = Math.abs(currentMetrics.avg_confidence - currentMetrics.actual_success_rate);
    if (divergence > thresholds.confidence_divergence) {
      anomalies.push({
        type: 'confidence-divergence',
        severity: 'high',
        predicted_confidence: currentMetrics.avg_confidence,
        actual_success: currentMetrics.actual_success_rate,
        divergence: divergence,
        threshold: thresholds.confidence_divergence,
        detected_at: now,
        action: 'Recalibrate confidence scoring'
      });
    }
  }
  
  // Check 4: Memory spike
  if (currentMetrics.memory_usage_mb) {
    const memRatio = currentMetrics.memory_usage_mb / baselineMetrics.memory_usage_mb;
    if (memRatio > thresholds.memory_spike) {
      anomalies.push({
        type: 'memory-spike',
        severity: 'medium',
        baseline: baselineMetrics.memory_usage_mb,
        current: currentMetrics.memory_usage_mb,
        ratio: memRatio,
        threshold: thresholds.memory_spike,
        detected_at: now,
        action: 'Check for memory leaks'
      });
    }
  }
  
  // Check 5: Error rate increase
  if (currentMetrics.error_rate) {
    const increase = currentMetrics.error_rate / baselineMetrics.error_rate;
    if (increase > thresholds.error_rate_increase) {
      anomalies.push({
        type: 'error-rate-spike',
        severity: 'high',
        baseline: baselineMetrics.error_rate,
        current: currentMetrics.error_rate,
        increase_ratio: increase,
        threshold: thresholds.error_rate_increase,
        detected_at: now,
        action: 'Review recent changes'
      });
    }
  }
  
  if (anomalies.length > 0) {
    log(`🚨 ${anomalies.length} anomalies detected`);
    saveAnomalies(anomalies);
  }
  
  return { anomalies, baseline };
}

// ════════════════════════════════════════════════════════════════════════════
// ANOMALY STORAGE & HISTORY
// ════════════════════════════════════════════════════════════════════════════

function loadAnomaliesDB() {
  if (fs.existsSync(ANOMALY_DB)) {
    return JSON.parse(fs.readFileSync(ANOMALY_DB, 'utf8'));
  }
  return { anomalies: [], history: [], stats: {} };
}

function saveAnomalies(anomalies) {
  const db = loadAnomaliesDB();
  
  anomalies.forEach(anomaly => {
    db.anomalies.push(anomaly);
    db.history.push({
      type: anomaly.type,
      severity: anomaly.severity,
      timestamp: anomaly.detected_at
    });
  });
  
  // Keep only last 1000
  if (db.anomalies.length > 1000) {
    db.anomalies = db.anomalies.slice(-1000);
  }
  if (db.history.length > 1000) {
    db.history = db.history.slice(-1000);
  }
  
  fs.writeFileSync(ANOMALY_DB, JSON.stringify(db, null, 2));
}

export function getAnomalies(limit = 50) {
  const db = loadAnomaliesDB();
  return db.anomalies.slice(-limit);
}

export function getAnomalyHistory() {
  const db = loadAnomaliesDB();
  
  return {
    total_detected: db.anomalies.length,
    by_type: countByType(db.history),
    by_severity: countBySeverity(db.history),
    timeline: db.history.slice(-50)
  };
}

function countByType(history) {
  return history.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, {});
}

function countBySeverity(history) {
  return history.reduce((acc, item) => {
    acc[item.severity] = (acc[item.severity] || 0) + 1;
    return acc;
  }, {});
}

// ════════════════════════════════════════════════════════════════════════════
// SMART ALERTING
// ════════════════════════════════════════════════════════════════════════════

export function generateAlert(anomalies) {
  /**
   * Создаёт alert на основе anomalies
   */
  
  if (anomalies.length === 0) {
    return null;
  }
  
  const highSeverity = anomalies.filter(a => a.severity === 'high');
  const mediumSeverity = anomalies.filter(a => a.severity === 'medium');
  
  let alertLevel = 'info';
  let message = '';
  
  if (highSeverity.length > 0) {
    alertLevel = 'critical';
    message = `🚨 CRITICAL: ${highSeverity.length} high-severity anomalies detected`;
  } else if (mediumSeverity.length > 0) {
    alertLevel = 'warning';
    message = `⚠️ WARNING: ${mediumSeverity.length} medium-severity anomalies detected`;
  }
  
  return {
    alert_level: alertLevel,
    message,
    anomalies: anomalies.slice(0, 3), // Top 3
    recommended_actions: anomalies.flatMap(a => a.action || []).filter(Boolean),
    timestamp: new Date().toISOString()
  };
}

// ════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════════════════════════════════════

export function getSystemHealth() {
  /**
   * Полный health report
   */
  
  const db = loadAnomaliesDB();
  const recent = db.anomalies.filter(a => {
    const age = Date.now() - new Date(a.detected_at).getTime();
    return age < 1 * 60 * 60 * 1000; // Last hour
  });
  
  let healthStatus = 'healthy';
  if (recent.some(a => a.severity === 'high')) {
    healthStatus = 'critical';
  } else if (recent.some(a => a.severity === 'medium')) {
    healthStatus = 'warning';
  }
  
  return {
    status: healthStatus,
    recent_anomalies_1h: recent.length,
    total_anomalies: db.anomalies.length,
    anomalies_by_type: countByType(db.history),
    last_anomaly: db.anomalies[db.anomalies.length - 1]?.detected_at || 'never',
    system_health_score: 100 - (recent.length * 5) // Penalty for recent anomalies
  };
}