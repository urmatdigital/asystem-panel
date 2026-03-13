/**
 * knowledge-graph.mjs — Lightweight Knowledge Graph (no Neo4j)
 *
 * Video: "Agent Swarms and Knowledge Graphs for Autonomous Software Dev" (0AKQm4zow_E)
 * Pattern: Entity → Relationship → Entity triples stored as JSON
 *   Agents extract facts from completed tasks and store them
 *   Future tasks query the graph to avoid re-discovering known facts
 *
 * Storage: ~/.openclaw/workspace/kg/
 *   entities.json — { id, type, name, attributes }
 *   relations.json — { from, relation, to, confidence, source, ts }
 *
 * Entity types: agent, project, service, api, file, person, concept
 * Relation types: knows, uses, depends_on, implements, owns, blocks, fixes
 *
 * API:
 *   POST /api/kg/entity    { type, name, attributes }
 *   POST /api/kg/relation  { from, relation, to, confidence, source }
 *   GET  /api/kg/query?entity=...&depth=1
 *   GET  /api/kg/stats
 */

import { createHash } from 'node:crypto';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME    = os.homedir();
const KG_DIR  = path.join(HOME, '.openclaw/workspace/kg');
const ENT_FILE = path.join(KG_DIR, 'entities.json');
const REL_FILE = path.join(KG_DIR, 'relations.json');
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';

fs.mkdirSync(KG_DIR, { recursive: true });

// ── Load / save helpers ───────────────────────────────────────────────────────
function loadEntities() { try { return JSON.parse(fs.readFileSync(ENT_FILE, 'utf8')); } catch { return {}; } }
function loadRelations() { try { return JSON.parse(fs.readFileSync(REL_FILE, 'utf8')); } catch { return []; } }
function saveEntities(e) { fs.writeFileSync(ENT_FILE, JSON.stringify(e, null, 2)); }
function saveRelations(r) { fs.writeFileSync(REL_FILE, JSON.stringify(r, null, 2)); }

// ── Entity ID (stable hash of type+name) ────────────────────────────────────
function entityId(type, name) {
  return createHash('md5').update(`${type}:${name.toLowerCase()}`).digest('hex').slice(0, 8);
}

// ── CRUD ──────────────────────────────────────────────────────────────────────
export function addEntity({ type, name, attributes = {} }) {
  const entities = loadEntities();
  const id = entityId(type, name);
  const isNew = !entities[id];
  entities[id] = { id, type, name, attributes: { ...entities[id]?.attributes, ...attributes }, updatedAt: Date.now() };
  if (isNew) entities[id].createdAt = Date.now();
  saveEntities(entities);
  return entities[id];
}

export function addRelation({ from, relation, to, confidence = 0.9, source = 'system' }) {
  const relations = loadRelations();
  // Deduplicate
  const exists = relations.find(r => r.from === from && r.relation === relation && r.to === to);
  if (exists) { exists.confidence = Math.max(exists.confidence, confidence); exists.updatedAt = Date.now(); saveRelations(relations); return exists; }
  const rel = { from, relation, to, confidence, source, ts: Date.now() };
  relations.push(rel);
  saveRelations(relations);
  return rel;
}

export function queryGraph(entityName, depth = 1) {
  const entities = loadEntities();
  const relations = loadRelations();

  // Find entity by name (case insensitive)
  const target = Object.values(entities).find(e => e.name.toLowerCase() === entityName.toLowerCase());
  if (!target) return { entity: null, relations: [] };

  // BFS up to depth
  const visited = new Set([target.id]);
  const result = [];
  let frontier = [target.id];

  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const id of frontier) {
      const rels = relations.filter(r => r.from === id || r.to === id);
      for (const rel of rels) {
        const otherId = rel.from === id ? rel.to : rel.from;
        const fromEnt = entities[rel.from];
        const toEnt = entities[rel.to];
        result.push({
          from: fromEnt?.name || rel.from,
          relation: rel.relation,
          to: toEnt?.name || rel.to,
          confidence: rel.confidence,
        });
        if (!visited.has(otherId)) { visited.add(otherId); next.push(otherId); }
      }
    }
    frontier = next;
  }

  return { entity: target, relations: result.slice(0, 20) };
}

// ── LLM entity extraction from task text ─────────────────────────────────────
export async function extractFromTask({ title, result, agentId }) {
  if (!OPENAI_KEY || !result) return [];
  try {
    const prompt = `Extract knowledge graph triples from this completed task.

Task: "${title}"
Agent: ${agentId}
Result: "${result.slice(0, 500)}"

Extract up to 5 factual triples. Each triple: entity1 → relation → entity2
Use entity types: agent|project|service|api|file|endpoint|concept
Use relations: uses|implements|depends_on|creates|fixes|owns|calls|stores_in

Output JSON array only: [{"from_type":"T","from":"N","relation":"R","to_type":"T","to":"N","confidence":0-1}]
Only include high-confidence facts (≥0.7). Empty array if nothing clear.`;

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 300, temperature: 0 }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim() || '[]';
    const triples = JSON.parse(text.replace(/```json|```/g, '').trim());

    const stored = [];
    for (const t of triples) {
      if (t.confidence < 0.7) continue;
      const fromEnt = addEntity({ type: t.from_type, name: t.from });
      const toEnt = addEntity({ type: t.to_type, name: t.to });
      const rel = addRelation({ from: fromEnt.id, relation: t.relation, to: toEnt.id, confidence: t.confidence, source: agentId });
      stored.push({ from: t.from, relation: t.relation, to: t.to });
    }
    if (stored.length) console.log(`[KG] 🕸️ Extracted ${stored.length} triples from ${agentId} task`);
    return stored;
  } catch { return []; }
}

// ── Build KG context for dispatch (what does this agent know?) ────────────────
export function buildKGContext(agentId, projectName) {
  const entities = loadEntities();
  const relations = loadRelations();

  // Find relations where source = agentId
  const agentRels = relations
    .filter(r => r.source === agentId)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 5);

  if (!agentRels.length) return null;

  const lines = agentRels.map(r => {
    const from = entities[r.from]?.name || r.from;
    const to = entities[r.to]?.name || r.to;
    return `${from} → ${r.relation} → ${to}`;
  });

  return `[Knowledge Graph — ${agentId} known facts]\n${lines.join('\n')}`;
}

export function getKGStats() {
  const entities = loadEntities();
  const relations = loadRelations();
  const byType = {};
  for (const e of Object.values(entities)) byType[e.type] = (byType[e.type] || 0) + 1;
  return {
    entities: Object.keys(entities).length,
    relations: relations.length,
    byType,
    last5relations: relations.slice(-5).map(r => ({ from: r.from, relation: r.relation, to: r.to })),
  };
}

// ── Seed initial ASYSTEM knowledge ────────────────────────────────────────────
export function seedInitialKG() {
  const entities = loadEntities();
  if (Object.keys(entities).length > 0) return; // Already seeded

  // Agents
  ['forge', 'atlas', 'iron', 'mesa', 'bekzat', 'ainura', 'marat', 'nurlan', 'dana', 'pixel'].forEach(name =>
    addEntity({ type: 'agent', name, attributes: { ip: name === 'forge' ? '100.87.107.50' : null } }));

  // Projects
  ['ORGON', 'AURWA', 'ASYSTEM', 'fiatexkg', 'Voltera'].forEach(name => addEntity({ type: 'project', name }));

  // Key relations
  const relations = [
    { from: 'forge', ft: 'agent', rel: 'owns', to: 'ASYSTEM', tt: 'project' },
    { from: 'bekzat', ft: 'agent', rel: 'owns', to: 'ORGON', tt: 'project' },
    { from: 'ainura', ft: 'agent', rel: 'owns', to: 'ORGON', tt: 'project' },
    { from: 'forge', ft: 'agent', rel: 'uses', to: 'ZVec', tt: 'service' },
    { from: 'forge', ft: 'agent', rel: 'uses', to: 'Convex', tt: 'service' },
    { from: 'bekzat', ft: 'agent', rel: 'implements', to: 'FastAPI', tt: 'service' },
    { from: 'ainura', ft: 'agent', rel: 'implements', to: 'Next.js', tt: 'service' },
    { from: 'marat', ft: 'agent', rel: 'uses', to: 'pytest', tt: 'service' },
    { from: 'iron', ft: 'agent', rel: 'owns', to: 'Cloudflare', tt: 'service' },
  ];

  for (const r of relations) {
    addEntity({ type: r.ft, name: r.from });
    addEntity({ type: r.tt, name: r.to });
    const fromId = entityId(r.ft, r.from);
    const toId = entityId(r.tt, r.to);
    addRelation({ from: fromId, relation: r.rel, to: toId, confidence: 1.0, source: 'seed' });
  }

  console.log('[KG] 🕸️ Initial knowledge graph seeded');
}
