#!/usr/bin/env node
/**
 * ENTITY GRAPH — Gap #6 (MEDIUM PRIORITY)
 * Знаниевый граф для сложных запросов
 * 
 * Пример:
 * Project X → Bug Y → Fix Z → Lesson L → Related Decision D
 * Query: "Все решения которые повлияли на Project X?"
 * Ответ: Traverse graph → найти все nodes
 */

import fs from 'fs';

const GRAPH_DB = '/Users/urmatmyrzabekov/.openclaw/entity-graph.json';
const LOG_FILE = '/Users/urmatmyrzabekov/.openclaw/logs/entity-graph.log';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ════════════════════════════════════════════════════════════════════════════
// GRAPH STRUCTURE
// ════════════════════════════════════════════════════════════════════════════

export function createNode(id, type, data) {
  /**
   * Создаёт node в графе
   * type: project, bug, fix, lesson, decision, agent, date
   */
  
  return {
    id,
    type,
    data,
    created_at: new Date().toISOString(),
    edges: []
  };
}

export function createEdge(from_id, to_id, relation_type, weight = 1.0) {
  /**
   * Создаёт edge между nodes
   * relation_type: caused, solved, learned, informed, blocked, etc
   */
  
  return {
    from: from_id,
    to: to_id,
    type: relation_type,
    weight, // 0.0-1.0 (importance)
    created_at: new Date().toISOString()
  };
}

// ════════════════════════════════════════════════════════════════════════════
// GRAPH OPERATIONS
// ════════════════════════════════════════════════════════════════════════════

function loadGraphDB() {
  if (fs.existsSync(GRAPH_DB)) {
    return JSON.parse(fs.readFileSync(GRAPH_DB, 'utf8'));
  }
  return { nodes: {}, edges: [], statistics: {} };
}

function saveGraphDB(db) {
  fs.writeFileSync(GRAPH_DB, JSON.stringify(db, null, 2));
}

export function addNode(id, type, data) {
  const db = loadGraphDB();
  
  db.nodes[id] = createNode(id, type, data);
  
  saveGraphDB(db);
  log(`✓ Node added: ${type}/${id}`);
  
  return db.nodes[id];
}

export function addEdge(from_id, to_id, relation_type, weight = 1.0) {
  const db = loadGraphDB();
  
  if (!db.nodes[from_id] || !db.nodes[to_id]) {
    log(`✗ Cannot add edge: nodes not found`);
    return null;
  }
  
  const edge = createEdge(from_id, to_id, relation_type, weight);
  db.edges.push(edge);
  
  // Add to node's edges list
  db.nodes[from_id].edges.push(edge);
  
  saveGraphDB(db);
  log(`→ Edge added: ${from_id} --[${relation_type}]--> ${to_id}`);
  
  return edge;
}

// ════════════════════════════════════════════════════════════════════════════
// GRAPH QUERIES
// ════════════════════════════════════════════════════════════════════════════

export function getNodeAndRelations(node_id, depth = 2) {
  /**
   * Найти node и всё connected через depth шагов
   */
  
  const db = loadGraphDB();
  const node = db.nodes[node_id];
  
  if (!node) return null;
  
  const result = {
    center: node,
    relations: {
      outgoing: [],    // edges from this node
      incoming: [],    // edges to this node
      connected: []    // all connected nodes
    }
  };
  
  // Outgoing edges
  db.edges
    .filter(e => e.from === node_id)
    .forEach(e => {
      result.relations.outgoing.push({
        edge: e,
        target_node: db.nodes[e.to]
      });
    });
  
  // Incoming edges
  db.edges
    .filter(e => e.to === node_id)
    .forEach(e => {
      result.relations.incoming.push({
        edge: e,
        source_node: db.nodes[e.from]
      });
    });
  
  // All connected
  const connected_ids = new Set();
  result.relations.outgoing.forEach(r => connected_ids.add(r.edge.to));
  result.relations.incoming.forEach(r => connected_ids.add(r.edge.from));
  
  connected_ids.forEach(id => {
    if (id !== node_id) {
      result.relations.connected.push(db.nodes[id]);
    }
  });
  
  log(`📊 Node query: ${node_id} (${result.relations.outgoing.length} outgoing, ${result.relations.incoming.length} incoming)`);
  
  return result;
}

export function findPath(from_id, to_id) {
  /**
   * Найти кратчайший path между двумя nodes (BFS)
   */
  
  const db = loadGraphDB();
  
  const queue = [[from_id]];
  const visited = new Set([from_id]);
  const paths = new Map();
  paths.set(from_id, []);
  
  while (queue.length > 0) {
    const path = queue.shift();
    const current = path[path.length - 1];
    
    // Найди соседей
    const neighbors = db.edges
      .filter(e => e.from === current)
      .map(e => ({ id: e.to, edge: e }));
    
    for (const { id, edge } of neighbors) {
      if (id === to_id) {
        return {
          path: [...path, id],
          edges: [...paths.get(current) || [], edge],
          length: path.length + 1
        };
      }
      
      if (!visited.has(id)) {
        visited.add(id);
        const newPath = [...path, id];
        paths.set(id, [...(paths.get(current) || []), edge]);
        queue.push(newPath);
      }
    }
  }
  
  log(`✗ No path found: ${from_id} → ${to_id}`);
  return null;
}

export function queryByRelation(relation_type) {
  /**
   * Найти все edges определённого типа
   * Пример: queryByRelation('caused') → все edges "Bug caused Fix"
   */
  
  const db = loadGraphDB();
  
  const results = db.edges
    .filter(e => e.type === relation_type)
    .map(e => ({
      edge: e,
      from_node: db.nodes[e.from],
      to_node: db.nodes[e.to]
    }));
  
  log(`🔍 Query by relation: ${relation_type} → ${results.length} results`);
  
  return results;
}

// ════════════════════════════════════════════════════════════════════════════
// ADVANCED QUERIES
// ════════════════════════════════════════════════════════════════════════════

export function findNodesByType(type) {
  /**
   * Найти все nodes определённого типа
   */
  
  const db = loadGraphDB();
  
  const nodes = Object.entries(db.nodes)
    .filter(([id, node]) => node.type === type)
    .map(([id, node]) => node);
  
  log(`🎯 Found ${nodes.length} nodes of type: ${type}`);
  
  return nodes;
}

export function getInfluenceChain(node_id) {
  /**
   * Все decisions which influenced this node
   * Работает по incoming edges с type = 'informed' или 'caused'
   */
  
  const db = loadGraphDB();
  
  const chain = [];
  const visited = new Set();
  
  function traverse(id) {
    if (visited.has(id)) return;
    visited.add(id);
    
    const incoming = db.edges.filter(e => e.to === id);
    
    incoming.forEach(edge => {
      if (edge.type === 'informed' || edge.type === 'caused') {
        chain.push({
          node: db.nodes[edge.from],
          relation: edge.type,
          weight: edge.weight
        });
        traverse(edge.from);
      }
    });
  }
  
  traverse(node_id);
  
  log(`🔗 Influence chain for ${node_id}: ${chain.length} nodes`);
  
  return chain;
}

export function getImpactChain(node_id) {
  /**
   * Все decisions which were impacted by this node
   * Работает по outgoing edges с type = 'informed' или 'caused'
   */
  
  const db = loadGraphDB();
  
  const chain = [];
  const visited = new Set();
  
  function traverse(id) {
    if (visited.has(id)) return;
    visited.add(id);
    
    const outgoing = db.edges.filter(e => e.from === id);
    
    outgoing.forEach(edge => {
      if (edge.type === 'informed' || edge.type === 'caused') {
        chain.push({
          node: db.nodes[edge.to],
          relation: edge.type,
          weight: edge.weight
        });
        traverse(edge.to);
      }
    });
  }
  
  traverse(node_id);
  
  log(`📈 Impact chain for ${node_id}: ${chain.length} nodes`);
  
  return chain;
}

// ════════════════════════════════════════════════════════════════════════════
// STATS & VISUALIZATION
// ════════════════════════════════════════════════════════════════════════════

export function getGraphStats() {
  const db = loadGraphDB();
  
  const stats = {
    total_nodes: Object.keys(db.nodes).length,
    total_edges: db.edges.length,
    node_types: {},
    edge_types: {},
    avg_degree: 0
  };
  
  // Count by type
  Object.values(db.nodes).forEach(node => {
    stats.node_types[node.type] = (stats.node_types[node.type] || 0) + 1;
  });
  
  db.edges.forEach(edge => {
    stats.edge_types[edge.type] = (stats.edge_types[edge.type] || 0) + 1;
  });
  
  // Average degree
  const degrees = Object.values(db.nodes).map(n => n.edges.length);
  stats.avg_degree = degrees.length > 0
    ? (degrees.reduce((a, b) => a + b, 0) / degrees.length).toFixed(1)
    : 0;
  
  return stats;
}

export function exportGraphAsJSON() {
  const db = loadGraphDB();
  
  return {
    nodes: Object.entries(db.nodes).map(([id, node]) => ({
      id,
      type: node.type,
      label: node.data?.title || id,
      data: node.data
    })),
    edges: db.edges.map(edge => ({
      source: edge.from,
      target: edge.to,
      type: edge.type,
      weight: edge.weight
    }))
  };
}