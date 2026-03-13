/**
 * anomaly-detector.mjs — Behavioral Baseline & Anomaly Detection
 *
 * Video: "NetXMS Talks Feb 2026: Anomaly Detection with AI, Dashboard Templates,
 *         Alarm Correlation" (MwUDK01sFHc)
 *
 * Pattern: Multivariate behavioral baseline → z-score anomaly → correlated alarms
 *   Track per-agent metrics (response time, error rate, task score)
 *   Build rolling baseline (last 7 days)
 *   Detect drift: z-score > 2.5 → warning; z-score > 4 → critical
 *   Alarm correlation: multiple related anomalies → single root-cause alert
 *
 * Metrics tracked per agent:
 *   - avgResponseMs  (task dispatch → result time estimate)
 *   - errorRate      (failed / total tasks)
 *   - avgScore       (Karpathy scores)
 *   - tasksPerHour   (throughput)
 *   - slaBreachRate  (late tasks / total)
 *
 * Anomaly types:
 *   PERF_DEGRADATION  → score dropped significantly
 *   ERROR_SPIKE       → error rate jumped
 *   THROUGHPUT_DROP   → tasks/hr fell
 *   SLA_BREACH_SURGE  → SLA violations spiked
 *   SILENT_AGENT      → no activity > 4 hours (during business hours)
 *
 * API:
 *   POST /api/anomaly/record  { agentId, metric, value }
 *   GET  /api/anomaly/status  — current baseline + anomalies per agent
 *   GET  /api/anomaly/alerts  — active anomaly alerts
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME        = os.homedir();
const METRICS_FILE = path.join(HOME, '.openclaw/workspace/.agent-metrics.json');
const ALERTS_FILE  = path.join(HOME, '.openclaw/workspace/anomaly-alerts.jsonl');

const Z_WARN     = 2.5;
const Z_CRITICAL = 4.0;
const WINDOW_DAYS = 7;
const MIN_SAMPLES = 5; // need at least 5 data points for baseline

// ── Load/save ─────────────────────────────────────────────────────────────────
function loadMetrics() { try { return JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8')); } catch { return {}; } }
function saveMetrics(m) { try { fs.writeFileSync(METRICS_FILE, JSON.stringify(m, null, 2)); } catch {} }

// ── Rolling window (7 days) ───────────────────────────────────────────────────
function getWindow() { return Date.now() - WINDOW_DAYS * 24 * 60 * 60_000; }

// ── Stats helpers ─────────────────────────────────────────────────────────────
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}
function zScore(value, arr) {
  const m = mean(arr);
  const s = std(arr);
  if (s === 0) return 0;
  return Math.abs((value - m) / s);
}

// ── Record a metric ───────────────────────────────────────────────────────────
export function recordMetric(agentId, metric, value) {
  const data = loadMetrics();
  if (!data[agentId]) data[agentId] = {};
  if (!data[agentId][metric]) data[agentId][metric] = [];

  const entry = { ts: Date.now(), v: value };
  data[agentId][metric].push(entry);

  // Trim to window
  const cutoff = getWindow();
  data[agentId][metric] = data[agentId][metric].filter(e => e.ts > cutoff).slice(-200);

  saveMetrics(data);

  // Check for anomaly
  const values = data[agentId][metric].slice(0, -1).map(e => e.v); // exclude current
  if (values.length < MIN_SAMPLES) return;

  const z = zScore(value, values);
  if (z >= Z_WARN) {
    const severity = z >= Z_CRITICAL ? 'critical' : 'warning';
    const alert = {
      ts: Date.now(), agentId, metric, value, z: z.toFixed(2),
      baseline: mean(values).toFixed(2), severity,
      type: metricToType(metric, value, mean(values)),
    };
    fs.appendFileSync(ALERTS_FILE, JSON.stringify(alert) + '\n');
    console.warn(`[AnomalyDetector] ${severity === 'critical' ? '🚨' : '⚠️'} ${agentId}/${metric}: z=${z.toFixed(1)} (val=${value.toFixed(2)} vs baseline=${alert.baseline})`);

    // Auto-fire trigger for critical
    if (severity === 'critical') {
      import('./trigger-engine.mjs').then(({ fireEvent }) => {
        fireEvent('health.service_down', { service: `anomaly:${agentId}:${metric}`, host: agentId, since: new Date().toISOString() }).catch(() => {});
      }).catch(() => {});
    }
  }
}

function metricToType(metric, current, baseline) {
  if (metric === 'avgScore' && current < baseline) return 'PERF_DEGRADATION';
  if (metric === 'errorRate' && current > baseline) return 'ERROR_SPIKE';
  if (metric === 'tasksPerHour' && current < baseline) return 'THROUGHPUT_DROP';
  if (metric === 'slaBreachRate' && current > baseline) return 'SLA_BREACH_SURGE';
  return 'METRIC_ANOMALY';
}

// ── Record from task complete ─────────────────────────────────────────────────
export function recordTaskCompletion(agentId, { score, status, late = false }) {
  const now = Date.now();
  // Record score
  if (score !== undefined) recordMetric(agentId, 'avgScore', score);
  // Record error (1 = error, 0 = ok)
  recordMetric(agentId, 'errorRate', status === 'failed' ? 1 : 0);
  // Record SLA breach (1 = late, 0 = ok)
  recordMetric(agentId, 'slaBreachRate', late ? 1 : 0);
  // Update last activity
  const data = loadMetrics();
  if (!data[agentId]) data[agentId] = {};
  data[agentId]._lastActivity = now;
  saveMetrics(data);
}

// ── Check for silent agents (no activity > 4h during 08:00-22:00 UTC+6) ──────
export function checkSilentAgents() {
  const data = loadMetrics();
  const now = Date.now();
  const utc6Hour = (new Date().getUTCHours() + 6) % 24;
  if (utc6Hour < 8 || utc6Hour > 22) return []; // night mode, skip

  const silent = [];
  const SILENT_MS = 4 * 60 * 60_000;
  for (const [agentId, agData] of Object.entries(data)) {
    if (agentId.startsWith('_')) continue;
    const last = agData._lastActivity || 0;
    if (last && now - last > SILENT_MS) {
      silent.push({ agentId, silentMs: now - last, lastSeen: new Date(last).toISOString() });
      console.warn(`[AnomalyDetector] 🔇 SILENT_AGENT: ${agentId} (${Math.round((now - last) / 3600_000)}h idle)`);
    }
  }
  return silent;
}

// ── Get status ────────────────────────────────────────────────────────────────
export function getAnomalyStatus() {
  const data = loadMetrics();
  const status = {};
  for (const [agentId, agData] of Object.entries(data)) {
    if (agentId.startsWith('_')) continue;
    status[agentId] = {};
    for (const [metric, entries] of Object.entries(agData)) {
      if (metric.startsWith('_') || !Array.isArray(entries)) continue;
      const values = entries.map(e => e.v);
      if (values.length < 2) continue;
      status[agentId][metric] = { samples: values.length, mean: mean(values).toFixed(2), std: std(values).toFixed(2), latest: values[values.length - 1] };
    }
  }
  return status;
}

export function getActiveAlerts() {
  try {
    const cutoff = Date.now() - 24 * 60 * 60_000; // last 24h
    const lines = fs.readFileSync(ALERTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(a => a && a.ts > cutoff)
      .slice(-20);
  } catch { return []; }
}
