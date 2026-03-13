/**
 * predictive-scheduler.mjs — Predictive Task Scheduling & Workload Forecasting
 *
 * Video 1: "The State of AI in 2026: The Year Intelligence Became Infrastructure" (tb4dI558zHc)
 * Video 2: "The AI Scheduling Agent" (3ul05-tAD2s)
 *
 * Pattern: Proactive agent — don't wait for tasks, anticipate them
 *
 * Components:
 *   1. TaskHistogram — records dispatch times per agent per hour-of-day/day-of-week
 *   2. Forecaster — projects next 4h demand per agent (exponential smoothing α=0.3)
 *   3. HeatMap — visual load: busy hours vs idle hours per agent
 *   4. WhatIf — simulate: "if sprint starts Monday, which agents are bottlenecks?"
 *   5. PreWarm — suggest pre-warm actions (like pre-loading ZVec context for busy agents)
 *
 * Forecast formula: EMA(α=0.3) over same-hour last 7 days
 *   forecast[agent][h] = α × actual[h] + (1-α) × forecast[h-1]
 *
 * API:
 *   POST /api/scheduler/record    { agentId, ts? }  — record a dispatch event
 *   GET  /api/scheduler/forecast  — next 4h demand forecast per agent
 *   GET  /api/scheduler/heatmap   — 24h × 7d heatmap per agent
 *   GET  /api/scheduler/busy      — currently busiest agent (top by forecast)
 *   POST /api/scheduler/whatif    { agents, tasksPerHour, startHour } → bottleneck analysis
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const HIST_FILE = path.join(HOME, '.openclaw/workspace/.task-histogram.json');
const SCHED_LOG = path.join(HOME, '.openclaw/workspace/scheduler-log.jsonl');

const AGENTS = ['forge','atlas','bekzat','ainura','marat','nurlan','dana','mesa','iron','pixel'];
const ALPHA  = 0.3; // EMA smoothing factor

// ── Load/save histogram ───────────────────────────────────────────────────────
function loadHist() {
  try { return JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); }
  catch { return { agents: {}, totalRecords: 0 }; }
}
function saveHist(h) { try { fs.writeFileSync(HIST_FILE, JSON.stringify(h)); } catch {} }

// ── Record a dispatch event ───────────────────────────────────────────────────
export function recordDispatch(agentId, ts = Date.now()) {
  if (!AGENTS.includes(agentId)) return;
  const hist = loadHist();
  if (!hist.agents[agentId]) hist.agents[agentId] = { hourly: {}, daily: {}, recent: [] };

  const d = new Date(ts);
  const hour  = d.getHours();
  const dow   = d.getDay(); // 0=Sun, 6=Sat
  const hKey  = `${dow}:${hour}`;

  hist.agents[agentId].hourly[hKey] = (hist.agents[agentId].hourly[hKey] || 0) + 1;
  hist.agents[agentId].daily[dow]   = (hist.agents[agentId].daily[dow]   || 0) + 1;

  // Keep last 200 raw events for recency weighting
  hist.agents[agentId].recent.push(ts);
  if (hist.agents[agentId].recent.length > 200) hist.agents[agentId].recent.shift();

  hist.totalRecords = (hist.totalRecords || 0) + 1;
  saveHist(hist);
}

// ── Forecast next N hours for each agent (EMA) ───────────────────────────────
export function forecast(horizonHours = 4) {
  const hist = loadHist();
  const now  = new Date();
  const results = {};

  for (const agentId of AGENTS) {
    const data = hist.agents[agentId];
    if (!data) { results[agentId] = { hours: [], peakHour: null, load: 'idle' }; continue; }

    const hours = [];
    for (let i = 0; i < horizonHours; i++) {
      const d = new Date(now.getTime() + i * 3_600_000);
      const hour = d.getHours();
      const dow  = d.getDay();
      const hKey = `${dow}:${hour}`;

      // EMA over same slot across days
      const raw = data.hourly[hKey] || 0;
      const prev = hours.length > 0 ? hours[hours.length - 1].predicted : raw;
      const predicted = Math.round((ALPHA * raw + (1 - ALPHA) * prev) * 10) / 10;

      hours.push({ hour: `${String(hour).padStart(2,'0')}:00`, dow, predicted, raw });
    }

    const peakHour = hours.reduce((max, h) => h.predicted > max.predicted ? h : max, hours[0]);
    const avgLoad  = hours.reduce((s, h) => s + h.predicted, 0) / hours.length;
    const load     = avgLoad > 5 ? 'high' : avgLoad > 2 ? 'medium' : avgLoad > 0.5 ? 'low' : 'idle';

    results[agentId] = { hours, peakHour: peakHour?.hour, avgLoad: Math.round(avgLoad * 10) / 10, load };
  }

  return { forecastedAt: now.toISOString(), horizonHours, agents: results };
}

// ── 24h heatmap per agent ─────────────────────────────────────────────────────
export function getHeatmap() {
  const hist = loadHist();
  const heatmap = {};

  for (const agentId of AGENTS) {
    const data = hist.agents[agentId];
    heatmap[agentId] = Array.from({ length: 24 }, (_, h) => {
      const total = [0,1,2,3,4,5,6].reduce((s, dow) => s + (data?.hourly[`${dow}:${h}`] || 0), 0);
      return { hour: `${String(h).padStart(2,'0')}:00`, count: total };
    });
  }

  return heatmap;
}

// ── Currently busiest agents (by next-hour forecast) ─────────────────────────
export function getBusiest() {
  const fc = forecast(1);
  return Object.entries(fc.agents)
    .map(([agentId, d]) => ({ agentId, predicted: d.hours[0]?.predicted || 0, load: d.load }))
    .sort((a, b) => b.predicted - a.predicted)
    .slice(0, 5);
}

// ── What-if simulation ────────────────────────────────────────────────────────
export function whatIf({ agents = AGENTS, tasksPerHour = 10, startHour = 0 }) {
  const capacities = { forge: 20, atlas: 20, bekzat: 10, ainura: 10, marat: 5, nurlan: 5, dana: 3, mesa: 3, iron: 10, pixel: 3 };
  const load    = tasksPerHour / agents.length;
  const results = agents.map(agentId => {
    const cap      = capacities[agentId] || 5;
    const utilPct  = Math.round((load / cap) * 100);
    const bottleneck = utilPct > 80;
    return { agentId, tasksPerHour: Math.round(load), capacity: cap, utilizationPct: utilPct, bottleneck };
  });
  const bottlenecks = results.filter(r => r.bottleneck).map(r => r.agentId);
  return { scenario: { tasksPerHour, agentCount: agents.length, startHour }, results, bottlenecks, recommendation: bottlenecks.length > 0 ? `Bottleneck agents: ${bottlenecks.join(', ')} — consider swarm fan-out or DAG rebalance` : 'All agents within capacity ✅' };
}
