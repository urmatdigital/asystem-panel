#!/usr/bin/env node
/**
 * VECTOR EMBEDDINGS — Priority #1 Gap Fix
 * Semantic search for lessons, decisions, incidents
 * Local embeddings (no API deps)
 * 
 * Enables: "How to optimize queries?" → finds routing, caching, selection patterns
 */

import fs from 'fs';
import crypto from 'crypto';

const EMBEDDINGS_DB = '/Users/urmatmyrzabekov/.openclaw/embeddings.json';
const LOG_FILE = '/Users/urmatmyrzabekov/.openclaw/logs/embeddings.log';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ════════════════════════════════════════════════════════════════════════════
// SIMPLE EMBEDDING (TF-IDF inspired)
// ════════════════════════════════════════════════════════════════════════════
// For MVP, use simple statistical embeddings instead of neural models
// Upgrade to sentence-transformers when needed

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

function getEmbedding(text) {
  const tokens = tokenize(text);
  const vector = {};
  
  // TF-IDF inspired: weight by token frequency
  const total = tokens.length;
  tokens.forEach(token => {
    vector[token] = (vector[token] || 0) + 1 / total;
  });
  
  // Create stable hash-based embedding (deterministic)
  const sorted = Object.entries(vector)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50); // Top 50 tokens
  
  return {
    tokens: sorted.map(([t, w]) => ({ term: t, weight: w })),
    hash: crypto
      .createHash('sha256')
      .update(JSON.stringify(sorted))
      .digest('hex')
      .slice(0, 16)
  };
}

function cosineSimilarity(emb1, emb2) {
  // Simple similarity based on token overlap
  const set1 = new Set(emb1.tokens.map(t => t.term));
  const set2 = new Set(emb2.tokens.map(t => t.term));
  
  const intersection = Array.from(set1).filter(t => set2.has(t)).length;
  const union = new Set([...set1, ...set2]).size;
  
  // Jaccard similarity
  return union > 0 ? intersection / union : 0;
}

// ════════════════════════════════════════════════════════════════════════════
// EMBEDDINGS STORE
// ════════════════════════════════════════════════════════════════════════════

function loadEmbeddingsDB() {
  if (fs.existsSync(EMBEDDINGS_DB)) {
    return JSON.parse(fs.readFileSync(EMBEDDINGS_DB, 'utf8'));
  }
  return { lessons: [], decisions: [], incidents: [] };
}

function saveEmbeddingsDB(db) {
  fs.writeFileSync(EMBEDDINGS_DB, JSON.stringify(db, null, 2));
}

export function indexLesson(lesson) {
  const db = loadEmbeddingsDB();
  const embedding = getEmbedding(lesson.pattern + ' ' + lesson.category);
  
  const indexed = {
    id: `lesson_${Date.now()}`,
    type: 'lesson',
    content: lesson.pattern,
    category: lesson.category,
    success_rate: lesson.success_rate,
    embedding: embedding.hash,
    tokens: embedding.tokens,
    indexed_at: new Date().toISOString()
  };
  
  db.lessons.push(indexed);
  saveEmbeddingsDB(db);
  
  log(`✓ Indexed lesson: ${lesson.pattern.slice(0, 40)}`);
  return indexed;
}

export function indexDecision(decision) {
  const db = loadEmbeddingsDB();
  const embedding = getEmbedding(decision.title + ' ' + decision.reasoning);
  
  const indexed = {
    id: `decision_${Date.now()}`,
    type: 'decision',
    content: decision.title,
    reasoning: decision.reasoning,
    chosen_option: decision.chosen_option,
    embedding: embedding.hash,
    tokens: embedding.tokens,
    indexed_at: new Date().toISOString()
  };
  
  db.decisions.push(indexed);
  saveEmbeddingsDB(db);
  
  log(`✓ Indexed decision: ${decision.title.slice(0, 40)}`);
  return indexed;
}

export function indexIncident(incident) {
  const db = loadEmbeddingsDB();
  const embedding = getEmbedding(incident.title + ' ' + incident.description);
  
  const indexed = {
    id: `incident_${Date.now()}`,
    type: 'incident',
    content: incident.title,
    description: incident.description,
    severity: incident.severity,
    embedding: embedding.hash,
    tokens: embedding.tokens,
    indexed_at: new Date().toISOString()
  };
  
  db.incidents.push(indexed);
  saveEmbeddingsDB(db);
  
  log(`✓ Indexed incident: ${incident.title.slice(0, 40)}`);
  return indexed;
}

// ════════════════════════════════════════════════════════════════════════════
// SEMANTIC SEARCH
// ════════════════════════════════════════════════════════════════════════════

export function semanticSearch(query, type = 'all', topK = 5) {
  const db = loadEmbeddingsDB();
  const queryEmbedding = getEmbedding(query);
  
  let corpus = [];
  if (type === 'all' || type === 'lessons') corpus.push(...db.lessons);
  if (type === 'all' || type === 'decisions') corpus.push(...db.decisions);
  if (type === 'all' || type === 'incidents') corpus.push(...db.incidents);
  
  const results = corpus
    .map(item => {
      // Reconstruct embeddings for comparison
      const itemEmbedding = {
        tokens: item.tokens,
        hash: item.embedding
      };
      
      const similarity = cosineSimilarity(queryEmbedding, itemEmbedding);
      
      return {
        ...item,
        similarity_score: similarity
      };
    })
    .filter(r => r.similarity_score > 0) // Only matches
    .sort((a, b) => b.similarity_score - a.similarity_score)
    .slice(0, topK);
  
  log(`🔍 Search "${query}" → ${results.length} results (top score: ${results[0]?.similarity_score.toFixed(2) || 'N/A'})`);
  
  return results;
}

export function findSimilarLessons(query, topK = 5) {
  return semanticSearch(query, 'lessons', topK);
}

export function findSimilarDecisions(query, topK = 5) {
  return semanticSearch(query, 'decisions', topK);
}

export function findSimilarIncidents(query, topK = 5) {
  return semanticSearch(query, 'incidents', topK);
}

// ════════════════════════════════════════════════════════════════════════════
// KNOWLEDGE GRAPH (simple relations)
// ════════════════════════════════════════════════════════════════════════════

export function buildKnowledgeGraph() {
  const db = loadEmbeddingsDB();
  
  const graph = {
    lessons: db.lessons.map(l => ({
      id: l.id,
      type: 'lesson',
      label: l.content.slice(0, 50),
      success_rate: l.success_rate
    })),
    decisions: db.decisions.map(d => ({
      id: d.id,
      type: 'decision',
      label: d.content.slice(0, 50)
    })),
    incidents: db.incidents.map(i => ({
      id: i.id,
      type: 'incident',
      label: i.content.slice(0, 50),
      severity: i.severity
    })),
    edges: []
  };
  
  // Connect by similarity
  for (const lesson of db.lessons) {
    const similar = db.decisions.filter(d => {
      const sim = cosineSimilarity(
        { tokens: lesson.tokens },
        { tokens: d.tokens }
      );
      return sim > 0.3; // Threshold
    });
    
    similar.forEach(d => {
      graph.edges.push({
        source: lesson.id,
        target: d.id,
        type: 'informs',
        weight: 0.7
      });
    });
  }
  
  log(`📊 Knowledge graph: ${graph.lessons.length} lessons, ${graph.decisions.length} decisions, ${graph.edges.length} relations`);
  
  return graph;
}

// ════════════════════════════════════════════════════════════════════════════
// STATS
// ════════════════════════════════════════════════════════════════════════════

export function getIndexStats() {
  const db = loadEmbeddingsDB();
  
  return {
    lessons_indexed: db.lessons.length,
    decisions_indexed: db.decisions.length,
    incidents_indexed: db.incidents.length,
    total_indexed: db.lessons.length + db.decisions.length + db.incidents.length,
    db_size_kb: Math.round(JSON.stringify(db).length / 1024),
    last_update: new Date().toISOString()
  };
}

// ════════════════════════════════════════════════════════════════════════════
// INTEGRATION LAYER (for API endpoints)
// ════════════════════════════════════════════════════════════════════════════

export function autoIndexFromState(sessionState) {
  // Auto-index new lessons, decisions, incidents from session state
  
  if (sessionState.lessons) {
    sessionState.lessons.forEach(lesson => {
      try {
        indexLesson(lesson);
      } catch (err) {
        log(`✗ Error indexing lesson: ${err.message}`);
      }
    });
  }
  
  if (sessionState.decisions) {
    sessionState.decisions.forEach(decision => {
      try {
        indexDecision(decision);
      } catch (err) {
        log(`✗ Error indexing decision: ${err.message}`);
      }
    });
  }
  
  if (sessionState.incidents) {
    sessionState.incidents.forEach(incident => {
      try {
        indexIncident(incident);
      } catch (err) {
        log(`✗ Error indexing incident: ${err.message}`);
      }
    });
  }
  
  log(`✓ Auto-indexed from session state`);
}