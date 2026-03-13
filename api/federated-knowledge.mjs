/**
 * federated-knowledge.mjs — Cross-Agent Federated Knowledge Sharing
 *
 * Video: "Solving the AI Privacy Problem with Federated Learning & Encrypted Agents" (s-s_jlTwCVE)
 * Pattern: "Train Locally, Learn Globally"
 *
 * Each agent contributes local learnings (tips, lessons, errors) to a shared
 * federated knowledge pool. Aggregation = weighted average of contribution vectors
 * (BoW similarity clusters → merge similar insights, discard noise).
 *
 * Architecture:
 *   Local:  agent-specific ZVec entries (memory_target = agentId)
 *   Global: federated pool in .federated-pool.json (aggregated summaries)
 *
 * Contribution = { agentId, topic, insight, confidence, timestamp }
 * Aggregation:
 *   1. Group contributions by topic (keyword overlap ≥ 0.4)
 *   2. Weight by confidence × recency
 *   3. Select top-3 insights per topic cluster
 *   4. Write to global pool as "collective wisdom"
 *
 * Broadcast: when pool updates, inject top global insights into next dispatch
 *   as [FEDERATED KNOWLEDGE] block (max 3 items, max 200 chars each)
 *
 * API:
 *   POST /api/federated/contribute  { agentId, topic, insight, confidence }
 *   GET  /api/federated/pool        → global knowledge pool (top 20)
 *   GET  /api/federated/insights?topic=X → topic-specific insights
 *   POST /api/federated/aggregate   → force re-aggregation (admin)
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const POOL_FILE = path.join(HOME, '.openclaw/workspace/.federated-pool.json');
const CONTRIB_LOG = path.join(HOME, '.openclaw/workspace/federated-contrib.jsonl');

// ── BoW similarity (shared with other modules) ────────────────────────────────
function bowSim(a, b) {
  const setA = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const setB = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

// ── Load pool ─────────────────────────────────────────────────────────────────
function loadPool() {
  try { return JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')); }
  catch { return { clusters: [], lastAggregated: null, totalContributions: 0 }; }
}
function savePool(p) { try { fs.writeFileSync(POOL_FILE, JSON.stringify(p, null, 2)); } catch {} }

// ── Contribute local knowledge ────────────────────────────────────────────────
export function contribute({ agentId, topic, insight, confidence = 0.5 }) {
  if (!insight || insight.length < 10) return { ok: false, reason: 'insight too short' };

  const entry = { agentId, topic: (topic || '').slice(0, 50), insight: insight.slice(0, 300), confidence, ts: Date.now() };
  fs.appendFileSync(CONTRIB_LOG, JSON.stringify(entry) + '\n');

  // Check if we should aggregate (every 10 contributions)
  const pool = loadPool();
  pool.totalContributions = (pool.totalContributions || 0) + 1;
  if (pool.totalContributions % 10 === 0) aggregate();
  else savePool(pool);

  console.log(`[Federated] 📡 ${agentId} contributed: "${insight.slice(0, 60)}..."`);
  return { ok: true, total: pool.totalContributions };
}

// ── Aggregate contributions into global pool ──────────────────────────────────
export function aggregate() {
  const pool = loadPool();

  // Read all contributions (last 200)
  let contributions = [];
  try {
    contributions = fs.readFileSync(CONTRIB_LOG, 'utf8').trim().split('\n')
      .filter(Boolean).slice(-200)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {}

  if (contributions.length === 0) return pool;

  // Cluster by topic similarity (BoW ≥ 0.4)
  const clusters = [];
  for (const contrib of contributions) {
    const text = (contrib.topic + ' ' + contrib.insight);
    let matched = false;
    for (const cluster of clusters) {
      if (bowSim(text, cluster.centroid) >= 0.4) {
        cluster.items.push(contrib);
        matched = true;
        break;
      }
    }
    if (!matched) clusters.push({ centroid: text, items: [contrib] });
  }

  // Aggregate: weight by confidence × recency, take top-3 per cluster
  const now = Date.now();
  const aggregated = clusters.map(cluster => {
    const scored = cluster.items.map(item => {
      const ageSec = (now - item.ts) / 1000;
      const recency = Math.exp(-ageSec / (7 * 86400)); // 7-day half-life
      const score = (item.confidence || 0.5) * recency;
      return { ...item, score };
    }).sort((a, b) => b.score - a.score).slice(0, 3);

    return {
      topic: scored[0]?.topic || 'general',
      insights: scored.map(s => ({ agentId: s.agentId, insight: s.insight, confidence: s.confidence, score: Math.round(s.score * 100) / 100 })),
      contributors: [...new Set(scored.map(s => s.agentId))],
      updatedAt: new Date().toISOString(),
    };
  }).sort((a, b) => b.insights[0]?.score - a.insights[0]?.score).slice(0, 20);

  pool.clusters = aggregated;
  pool.lastAggregated = new Date().toISOString();
  savePool(pool);
  console.log(`[Federated] 🧠 Aggregated ${contributions.length} contributions → ${aggregated.length} clusters`);
  return pool;
}

// ── Get global insights for dispatch injection ────────────────────────────────
export function getGlobalInsights(query = '', limit = 3) {
  const pool = loadPool();
  if (!pool.clusters || pool.clusters.length === 0) return [];

  const clusters = query
    ? pool.clusters.filter(c => bowSim(query, c.topic + ' ' + (c.insights[0]?.insight || '')) > 0.15)
    : pool.clusters;

  return clusters.slice(0, limit).map(c => ({
    topic: c.topic,
    insight: c.insights[0]?.insight || '',
    contributors: c.contributors,
    confidence: c.insights[0]?.confidence || 0.5,
  }));
}

export function getPool() { return loadPool(); }
