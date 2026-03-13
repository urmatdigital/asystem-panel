/**
 * social-learner.mjs — Social Learning & Collective Intelligence
 *
 * Video: "AI Trends I'd Bet My Money On in 2026" (9_zLaLuLj-4)
 * Pattern: Agents observe each other's HIGH-QUALITY outputs → extract best practices
 *          → collective intelligence emerges from shared observation (no central teacher)
 *
 * Unlike knowledge-distiller (teacher→student, hierarchical):
 *   Social learning is PEER-TO-PEER: any agent can learn from any other agent's
 *   successful patterns, including agents at the same level
 *
 * Observation mechanism:
 *   On every task_done with score ≥8: extract "observable behavior" — what worked
 *   Stored in shared observation pool (observable to all peers)
 *   Periodic "observation session": each agent reviews top-5 peer observations
 *   → synthesizes into personal adaptation (stored back as HMEM trace)
 *
 * Collective intelligence signals:
 *   If 3+ agents independently arrive at same pattern → CONSENSUS → elevate to DOCTRINE
 *   DOCTRINE = injected into ALL agent dispatches (system-wide best practice)
 *
 * API:
 *   POST /api/social/observe   { agentId, taskTitle, result, score } → log observation
 *   POST /api/social/learn     { agentId } → agent reviews peer observations → adapts
 *   GET  /api/social/pool      → shared observation pool
 *   GET  /api/social/doctrines → elevated doctrines (consensus patterns)
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME         = os.homedir();
const POOL_FILE    = path.join(HOME, '.openclaw/workspace/.social-pool.json');
const DOCTRINE_FILE = path.join(HOME, '.openclaw/workspace/.doctrines.json');
const SOCIAL_LOG   = path.join(HOME, '.openclaw/workspace/social-log.jsonl');

const CONSENSUS_THRESHOLD = 3; // 3+ agents converge → DOCTRINE
const POOL_MAX            = 200;

// ── Load/save ──────────────────────────────────────────────────────────────────
function loadPool() { try { return JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')); } catch { return []; } }
function savePool(d) { try { fs.writeFileSync(POOL_FILE, JSON.stringify(d, null, 2)); } catch {} }
function loadDoctrines() { try { return JSON.parse(fs.readFileSync(DOCTRINE_FILE, 'utf8')); } catch { return []; } }
function saveDoctrines(d) { try { fs.writeFileSync(DOCTRINE_FILE, JSON.stringify(d, null, 2)); } catch {} }

// ── Extract observable pattern from result ─────────────────────────────────────
function extractPattern(title = '', result = '') {
  const words  = (title + ' ' + result).toLowerCase().split(/\W+/).filter(w => w.length > 4);
  const freq   = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  const top    = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);
  const verb   = ['implement', 'fix', 'refactor', 'deploy', 'configure', 'test', 'review', 'build', 'create'].find(v => title.toLowerCase().includes(v)) || 'handle';
  return { keywords: top, verb, summary: `${verb}:${top.slice(0, 3).join('+')}` };
}

// ── Log observation ────────────────────────────────────────────────────────────
export function logObservation({ agentId, taskTitle, result, score }) {
  if (score < 8) return { ok: false, reason: `Score ${score} < 8 — only high-quality observations shared` };

  const pool    = loadPool();
  const pattern = extractPattern(taskTitle, result);
  const obs     = { id: `obs_${Date.now()}`, ts: Date.now(), agentId, taskTitle: taskTitle.slice(0, 60), score, pattern, result: result.slice(0, 200) };
  pool.push(obs);
  if (pool.length > POOL_MAX) pool.splice(0, pool.length - POOL_MAX);
  savePool(pool);

  // Check for consensus → doctrine
  const samePattern = pool.filter(o => o.pattern.summary === pattern.summary && o.agentId !== agentId);
  const agentsInvolved = [...new Set(samePattern.map(o => o.agentId))];
  let doctrine = null;
  if (agentsInvolved.length >= CONSENSUS_THRESHOLD - 1) { // + this agent = threshold
    doctrine = elevateToDoctrine(pattern, [...agentsInvolved, agentId]);
  }

  const entry = { ts: Date.now(), agentId, score, pattern: pattern.summary, doctrine: !!doctrine };
  fs.appendFileSync(SOCIAL_LOG, JSON.stringify(entry) + '\n');
  console.log(`[Social] 👁️ ${agentId} observed: "${pattern.summary}" (score ${score})${doctrine ? ' → DOCTRINE!' : ''}`);
  return { ok: true, pattern, poolSize: pool.length, doctrineElevated: !!doctrine };
}

// ── Elevate consensus pattern to doctrine ──────────────────────────────────────
function elevateToDoctrine(pattern, agents) {
  const doctrines  = loadDoctrines();
  const existing   = doctrines.find(d => d.pattern.summary === pattern.summary);
  if (existing) { existing.agents = [...new Set([...existing.agents, ...agents])]; existing.reinforced = (existing.reinforced || 0) + 1; saveDoctrines(doctrines); return existing; }

  const doctrine = { id: `doc_${Date.now()}`, ts: Date.now(), pattern, agents, reinforced: 1, injectedCount: 0 };
  doctrines.push(doctrine);
  if (doctrines.length > 50) doctrines.splice(0, doctrines.length - 50);
  saveDoctrines(doctrines);
  console.log(`[Social] 📜 NEW DOCTRINE: "${pattern.summary}" from ${agents.join(', ')}`);
  return doctrine;
}

// ── Agent learns from peer pool ────────────────────────────────────────────────
export function learnFromPeers(agentId) {
  const pool = loadPool();
  const peerObs = pool.filter(o => o.agentId !== agentId && o.score >= 9).slice(-20);
  if (peerObs.length === 0) return { ok: true, learned: 0, message: 'No peer observations yet' };

  // Cluster by pattern summary
  const clusters = {};
  for (const obs of peerObs) {
    const k = obs.pattern.summary;
    if (!clusters[k]) clusters[k] = { count: 0, agents: [], keywords: obs.pattern.keywords };
    clusters[k].count++;
    clusters[k].agents.push(obs.agentId);
  }

  const topInsights = Object.entries(clusters).sort((a, b) => b[1].count - a[1].count).slice(0, 3).map(([pattern, data]) => ({
    pattern, count: data.count, agents: [...new Set(data.agents)], keywords: data.keywords,
    insight: `Peers ${[...new Set(data.agents)].join('/')} successfully used: ${data.keywords.slice(0, 4).join(', ')}`,
  }));

  const entry = { ts: Date.now(), agentId, type: 'learn', learned: topInsights.length, insights: topInsights.map(i => i.pattern) };
  fs.appendFileSync(SOCIAL_LOG, JSON.stringify(entry) + '\n');
  console.log(`[Social] 🧠 ${agentId} learned ${topInsights.length} patterns from peers`);
  return { ok: true, agentId, learned: topInsights.length, insights: topInsights };
}

// ── Get doctrines for injection ────────────────────────────────────────────────
export function getDoctrines() { return loadDoctrines(); }

export function getDoctrinBlock() {
  const doctrines = loadDoctrines().slice(0, 3);
  if (doctrines.length === 0) return null;
  return `[COLLECTIVE DOCTRINES — agreed by multiple agents]\n` +
    doctrines.map((d, i) => `${i + 1}. [${d.agents.join('+')}] "${d.pattern.keywords.join(', ')}"`).join('\n');
}

export function getPool(limit = 20) { return loadPool().slice(-limit).reverse(); }
