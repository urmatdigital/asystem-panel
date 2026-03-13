/**
 * error-cluster.mjs — Error Pattern Clustering (vector-based)
 *
 * Video: "AI Catching Its Own Mistakes?! How Is This Possible?" (83ZbIf9WvB0)
 * Pattern: Every agent failure → error embedding → cluster → systemic patterns
 *   Agents don't fail like traditional software: they "confidently do the wrong thing"
 *   Clustering reveals that 3 of 8 uncertain responses stem from ONE root cause
 *
 * Implementation:
 *   - Error stored as text fingerprint (no API call: TF-IDF-like word hash)
 *   - Word-overlap clustering: errors with >60% word overlap → same cluster
 *   - Cluster size ≥ 3 → SYSTEMIC (alert + trigger root cause investigation)
 *   - Each cluster gets an auto-label from its most common keywords
 *
 * Storage:
 *   - ~/.openclaw/workspace/error-clusters.json — all errors + clusters
 *   - ~/.openclaw/workspace/error-cluster-log.jsonl — raw error feed
 *
 * API:
 *   POST /api/errors/report  { agentId, error, context, taskId }
 *   GET  /api/errors/clusters             — current clusters
 *   GET  /api/errors/stats                — systemic issues summary
 */

import { createHash } from 'node:crypto';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME         = os.homedir();
const CLUSTER_FILE = path.join(HOME, '.openclaw/workspace/error-clusters.json');
const ERROR_LOG    = path.join(HOME, '.openclaw/workspace/error-cluster-log.jsonl');

const CLUSTER_THRESHOLD = 0.6;   // 60% word overlap → same cluster
const SYSTEMIC_MIN      = 3;     // cluster size for systemic alert
const MAX_ERRORS        = 2000;  // rolling window

// ── Tokenize for word-overlap similarity ─────────────────────────────────────
function tokenize(text) {
  return new Set(
    text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOPWORDS.has(w))
  );
}

const STOPWORDS = new Set(['this', 'that', 'with', 'from', 'have', 'been', 'were', 'they', 'will', 'would', 'could', 'should', 'when', 'then', 'than', 'what', 'which', 'your', 'there', 'their', 'here', 'more', 'also', 'into', 'over', 'after', 'some', 'very', 'just', 'even', 'such', 'each', 'only', 'most', 'other', 'about', 'between']);

function similarity(a, b) {
  const tokA = tokenize(a), tokB = tokenize(b);
  const intersection = [...tokA].filter(w => tokB.has(w)).length;
  const union = new Set([...tokA, ...tokB]).size;
  return union === 0 ? 0 : intersection / union;
}

function fingerprint(text) {
  return createHash('md5').update(text.toLowerCase().trim()).digest('hex').slice(0, 12);
}

function topKeywords(texts, n = 5) {
  const freq = {};
  for (const t of texts) for (const w of tokenize(t)) freq[w] = (freq[w] || 0) + 1;
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0]);
}

// ── Load / save clusters ──────────────────────────────────────────────────────
function loadClusters() {
  try { return JSON.parse(fs.readFileSync(CLUSTER_FILE, 'utf8')); }
  catch { return { clusters: [], errors: [] }; }
}
function saveClusters(data) { fs.writeFileSync(CLUSTER_FILE, JSON.stringify(data, null, 2)); }

// ── Report an error ───────────────────────────────────────────────────────────
export async function reportError({ agentId, error, context = '', taskId = '', ts = Date.now() }) {
  if (!error) return;
  const fp = fingerprint(`${agentId}:${error}`);
  const data = loadClusters();

  // Deduplicate identical errors (same fingerprint within 5 min)
  const recent = data.errors.find(e => e.fp === fp && ts - e.ts < 300_000);
  if (recent) { recent.count = (recent.count || 1) + 1; saveClusters(data); return { clusterId: recent.clusterId, duplicate: true }; }

  // Add new error
  const errorEntry = { id: fp, fp, agentId, error, context: context.slice(0, 200), taskId, ts, count: 1, clusterId: null };
  data.errors.push(errorEntry);
  if (data.errors.length > MAX_ERRORS) data.errors = data.errors.slice(-MAX_ERRORS);

  // Cluster assignment
  const errorText = `${agentId} ${error} ${context}`;
  let assignedCluster = null;

  for (const cluster of data.clusters) {
    // Compare against cluster centroid (representative error text)
    const sim = similarity(errorText, cluster.centroid);
    if (sim >= CLUSTER_THRESHOLD) {
      cluster.members.push(fp);
      cluster.count = cluster.members.length;
      cluster.lastSeen = ts;
      cluster.agents = [...new Set([...cluster.agents, agentId])];
      cluster.keywords = topKeywords(cluster.members.slice(-10).map(id => {
        const e = data.errors.find(x => x.fp === id);
        return e ? `${e.agentId} ${e.error}` : '';
      }));
      // Systemic detection
      if (cluster.count >= SYSTEMIC_MIN && !cluster.systemicAlerted) {
        cluster.systemicAlerted = true;
        cluster.severity = 'systemic';
        console.log(`[ErrorCluster] 🚨 SYSTEMIC pattern detected! Cluster: "${cluster.label}" (${cluster.count} errors, agents: ${cluster.agents.join(',')})`);
        // Fire trigger
        setImmediate(async () => {
          try {
            const { fireEvent } = await import('./trigger-engine.mjs');
            await fireEvent('health.service_down', { service: `ErrorPattern:${cluster.label}`, host: agentId, since: new Date(cluster.firstSeen).toISOString() });
          } catch {}
        });
      }
      assignedCluster = cluster.id;
      errorEntry.clusterId = cluster.id;
      break;
    }
  }

  // Create new cluster if no match
  if (!assignedCluster) {
    const clusterId = `cluster-${Date.now().toString(36)}`;
    const keywords = topKeywords([errorText]);
    const label = keywords.slice(0, 3).join('/') || 'unknown';
    const newCluster = {
      id: clusterId, label, centroid: errorText.slice(0, 300),
      members: [fp], count: 1, severity: 'isolated',
      agents: [agentId], keywords,
      firstSeen: ts, lastSeen: ts, systemicAlerted: false,
    };
    data.clusters.push(newCluster);
    errorEntry.clusterId = clusterId;
    assignedCluster = clusterId;
  }

  saveClusters(data);

  // Append to log
  fs.appendFileSync(ERROR_LOG, JSON.stringify({ ts, agentId, error: error.slice(0, 200), taskId, clusterId: assignedCluster }) + '\n');

  return { clusterId: assignedCluster, duplicate: false };
}

// ── Get clusters (sorted by severity/count) ───────────────────────────────────
export function getClusters({ minCount = 1 } = {}) {
  const data = loadClusters();
  return data.clusters
    .filter(c => c.count >= minCount)
    .sort((a, b) => b.count - a.count);
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getErrorStats() {
  const data = loadClusters();
  const systemic = data.clusters.filter(c => c.severity === 'systemic');
  const byAgent = {};
  for (const e of data.errors) {
    byAgent[e.agentId] = (byAgent[e.agentId] || 0) + (e.count || 1);
  }
  return {
    totalErrors: data.errors.reduce((s, e) => s + (e.count || 1), 0),
    uniqueErrors: data.errors.length,
    clusters: data.clusters.length,
    systemicPatterns: systemic.length,
    topSystemic: systemic.slice(0, 3).map(c => ({ label: c.label, count: c.count, agents: c.agents })),
    byAgent,
  };
}
