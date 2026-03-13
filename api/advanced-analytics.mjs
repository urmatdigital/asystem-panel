#!/usr/bin/env node
/**
 * ADVANCED ANALYTICS — System insights and trends
 * Анализирует тренды и предлагает улучшения
 */

import fs from 'fs';

const ANALYTICS_DB = '/Users/urmatmyrzabekov/.openclaw/analytics.json';
const LOG_FILE = '/Users/urmatmyrzabekov/.openclaw/logs/analytics.log';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ════════════════════════════════════════════════════════════════════════════
// TREND ANALYSIS
// ════════════════════════════════════════════════════════════════════════════

export function analyzeTrends(metrics) {
  /**
   * Анализирует тренды в метриках (up/down/stable)
   */
  
  const trends = {
    timestamp: new Date().toISOString(),
    metrics: {}
  };
  
  Object.entries(metrics).forEach(([key, current]) => {
    const db = loadAnalyticsDB();
    const history = db.history?.[key] || [];
    
    if (history.length < 2) {
      trends.metrics[key] = { trend: 'stable', direction: '→', confidence: 'low' };
      return;
    }
    
    const recent = history.slice(-5);
    const avg_old = recent.slice(0, -1).reduce((a, b) => a + b, 0) / (recent.length - 1);
    const avg_new = current;
    
    const change = ((avg_new - avg_old) / avg_old * 100).toFixed(1);
    
    let trend = 'stable';
    let direction = '→';
    
    if (Math.abs(change) < 5) {
      trend = 'stable';
      direction = '→';
    } else if (change > 0) {
      trend = 'improving';
      direction = '↑';
    } else {
      trend = 'degrading';
      direction = '↓';
    }
    
    trends.metrics[key] = {
      trend,
      direction,
      change: `${change}%`,
      confidence: 'high'
    };
  });
  
  return trends;
}

// ════════════════════════════════════════════════════════════════════════════
// PERFORMANCE RECOMMENDATIONS
// ════════════════════════════════════════════════════════════════════════════

export function generateRecommendations(systemStats) {
  /**
   * На основе stats генерирует actionable recommendations
   */
  
  const recommendations = [];
  
  // Recommendation 1: Cost optimization
  if (systemStats.avg_cost_per_task > 0.30) {
    recommendations.push({
      category: 'cost',
      priority: 'high',
      title: 'Increase Haiku usage for simple tasks',
      description: `Current avg cost: $${systemStats.avg_cost_per_task}. Use Haiku for 70% of tasks.`,
      expected_savings: '40%',
      effort: 'low'
    });
  }
  
  // Recommendation 2: Quality improvement
  if (systemStats.success_rate < 0.85) {
    recommendations.push({
      category: 'quality',
      priority: 'high',
      title: 'Improve reasoning depth',
      description: `Current success rate: ${(systemStats.success_rate * 100).toFixed(0)}%. Add 2+ reasoning steps.`,
      expected_improvement: '+15%',
      effort: 'medium'
    });
  }
  
  // Recommendation 3: Speed optimization
  if (systemStats.avg_decision_time_ms > 350) {
    recommendations.push({
      category: 'performance',
      priority: 'medium',
      title: 'Optimize decision pipeline',
      description: `Current avg time: ${systemStats.avg_decision_time_ms}ms. Target: 280ms.`,
      expected_improvement: '-20%',
      effort: 'high'
    });
  }
  
  // Recommendation 4: Memory management
  if (systemStats.memory_usage_mb > 60) {
    recommendations.push({
      category: 'resources',
      priority: 'medium',
      title: 'Archive old sessions',
      description: `Memory usage: ${systemStats.memory_usage_mb}MB. Archive sessions > 30 days old.`,
      expected_savings: '-30% memory',
      effort: 'low'
    });
  }
  
  // Recommendation 5: Team coordination
  if (systemStats.team_decision_latency_ms > 100) {
    recommendations.push({
      category: 'coordination',
      priority: 'low',
      title: 'Enable broadcast batching',
      description: `Decision broadcast latency: ${systemStats.team_decision_latency_ms}ms.`,
      expected_improvement: '-50%',
      effort: 'medium'
    });
  }
  
  log(`✓ Generated ${recommendations.length} recommendations`);
  
  return recommendations;
}

// ════════════════════════════════════════════════════════════════════════════
// ROI CALCULATION
// ════════════════════════════════════════════════════════════════════════════

export function calculateROI(recommendations) {
  /**
   * Рассчитывает ROI для каждого recommendation
   */
  
  const roi_results = recommendations.map(rec => {
    let roi_score = 0;
    let implementation_time = 0;
    
    // Effort-to-value mapping
    switch (rec.effort) {
      case 'low': implementation_time = 1; break;
      case 'medium': implementation_time = 4; break;
      case 'high': implementation_time = 8; break;
    }
    
    // Extract numeric improvement
    let improvement = 0;
    if (rec.expected_savings) {
      improvement = parseInt(rec.expected_savings);
    } else if (rec.expected_improvement) {
      improvement = parseInt(rec.expected_improvement);
    }
    
    // Priority multiplier
    const priority_multiplier = 
      rec.priority === 'high' ? 3 :
      rec.priority === 'medium' ? 2 : 1;
    
    // ROI = improvement / effort * priority
    roi_score = (improvement / Math.max(implementation_time, 1)) * priority_multiplier;
    
    return {
      ...rec,
      implementation_hours: implementation_time,
      roi_score: roi_score.toFixed(2),
      ranking: 0 // Will be set in sort
    };
  });
  
  // Rank by ROI
  roi_results.sort((a, b) => b.roi_score - a.roi_score);
  roi_results.forEach((r, idx) => r.ranking = idx + 1);
  
  return roi_results;
}

// ════════════════════════════════════════════════════════════════════════════
// DATABASE OPERATIONS
// ════════════════════════════════════════════════════════════════════════════

function loadAnalyticsDB() {
  if (fs.existsSync(ANALYTICS_DB)) {
    return JSON.parse(fs.readFileSync(ANALYTICS_DB, 'utf8'));
  }
  return { 
    history: {},
    recommendations: [],
    trends: []
  };
}

function saveAnalyticsDB(db) {
  fs.writeFileSync(ANALYTICS_DB, JSON.stringify(db, null, 2));
}

export function recordMetric(metricName, value) {
  const db = loadAnalyticsDB();
  
  if (!db.history[metricName]) {
    db.history[metricName] = [];
  }
  
  db.history[metricName].push({
    value,
    timestamp: new Date().toISOString()
  });
  
  // Keep only last 100 data points
  if (db.history[metricName].length > 100) {
    db.history[metricName] = db.history[metricName].slice(-100);
  }
  
  saveAnalyticsDB(db);
}

// ════════════════════════════════════════════════════════════════════════════
// COMPREHENSIVE ANALYTICS REPORT
// ════════════════════════════════════════════════════════════════════════════

export function generateAnalyticsReport(systemStats) {
  /**
   * Полный analytics report для dashboard
   */
  
  const trends = analyzeTrends(systemStats);
  const recommendations = generateRecommendations(systemStats);
  const roi_ranked = calculateROI(recommendations);
  
  const report = {
    generated_at: new Date().toISOString(),
    system_health: {
      overall_score: calculateHealthScore(systemStats),
      status: systemStats.success_rate > 0.9 ? 'excellent' : 
              systemStats.success_rate > 0.8 ? 'good' : 'needs-improvement'
    },
    trends,
    top_recommendations: roi_ranked.slice(0, 5),
    metrics_summary: {
      success_rate: systemStats.success_rate,
      avg_cost: systemStats.avg_cost_per_task,
      avg_time: systemStats.avg_decision_time_ms,
      memory: systemStats.memory_usage_mb
    },
    next_focus_areas: roi_ranked.slice(0, 3).map(r => r.title)
  };
  
  log(`✓ Analytics report generated`);
  
  return report;
}

function calculateHealthScore(stats) {
  let score = 100;
  
  // Deduct for poor success rate
  if (stats.success_rate < 0.9) {
    score -= (0.9 - stats.success_rate) * 50;
  }
  
  // Deduct for high cost
  if (stats.avg_cost_per_task > 0.30) {
    score -= 10;
  }
  
  // Deduct for slow decisions
  if (stats.avg_decision_time_ms > 350) {
    score -= 10;
  }
  
  // Deduct for high memory
  if (stats.memory_usage_mb > 60) {
    score -= 10;
  }
  
  return Math.max(0, Math.round(score));
}