#!/usr/bin/env node
/**
 * Narrative Memory API - Semantic search + Story Arc builder
 * Integrates with Reme vector store for agent knowledge
 * 
 * Usage:
 * POST /api/narrative/search { query: "JWT ORGON", mode: "SEMANTIC" }
 * POST /api/narrative/arc { topic: "ORGON JWT" }
 * GET /api/narrative/agents/{agent}/events
 */

import fs from 'fs';
import path from 'path';

const NARRATIVE_DB = '/Users/urmatmyrzabekov/.openclaw/workspace/narrative-memory.json';
const LOG_FILE = '/Users/urmatmyrzabekov/.openclaw/logs/narrative-memory.log';

// Event types
const EVENT_TYPES = {
  DECISION: 'decision',      // Strategic choice
  MILESTONE: 'milestone',    // Completion, achievement
  INCIDENT: 'incident',      // Problem, bug, outage
  LEARNING: 'learning',      // Pattern discovered
  DEPLOYMENT: 'deployment',  // Release, rollout
  ROLLBACK: 'rollback',      // Revert, undo
};

function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function loadDB() {
  try {
    if (fs.existsSync(NARRATIVE_DB)) {
      return JSON.parse(fs.readFileSync(NARRATIVE_DB, 'utf-8'));
    }
  } catch (err) {
    log(`⚠️ DB load error: ${err.message}`);
  }
  return { events: [], agents: {} };
}

function saveDB(db) {
  fs.writeFileSync(NARRATIVE_DB, JSON.stringify(db, null, 2));
}

// Semantic similarity (naive - for now)
function cosineSimilarity(query, text) {
  const qWords = query.toLowerCase().split(/\s+/);
  const tWords = text.toLowerCase().split(/\s+/);
  
  let matches = 0;
  for (const qWord of qWords) {
    if (tWords.some(tWord => tWord.includes(qWord) || qWord.includes(tWord))) {
      matches++;
    }
  }
  
  return matches / Math.max(qWords.length, tWords.length);
}

// ==== EVENT RECORDING ====
export async function recordEvent(agent, type, data) {
  const db = loadDB();
  
  const event = {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    agent,
    type,
    timestamp: new Date().toISOString(),
    title: data.title || `${type.toUpperCase()}: ${agent}`,
    description: data.description || '',
    tags: data.tags || [],
    context: data.context || {},
    resolved: data.resolved || false,
    relatedEvents: data.relatedEvents || []
  };
  
  db.events.push(event);
  
  // Track agent
  if (!db.agents[agent]) {
    db.agents[agent] = {
      eventCount: 0,
      lastEvent: null,
      eventTypes: {}
    };
  }
  db.agents[agent].eventCount++;
  db.agents[agent].lastEvent = event.timestamp;
  db.agents[agent].eventTypes[type] = (db.agents[agent].eventTypes[type] || 0) + 1;
  
  saveDB(db);
  log(`✓ Recorded ${type} from ${agent}: ${event.title}`);
  
  return event;
}

// ==== NARRATIVE SEARCH ====
export async function narrativeSearch(query, mode = 'SEMANTIC') {
  const db = loadDB();
  
  if (mode === 'SEMANTIC') {
    // Semantic search using similarity
    const results = db.events
      .map(event => ({
        ...event,
        score: cosineSimilarity(query, `${event.title} ${event.description} ${event.tags.join(' ')}`)
      }))
      .filter(e => e.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    
    log(`🔍 Semantic search: "${query}" → ${results.length} results`);
    return results;
  } 
  
  if (mode === 'TEMPORAL') {
    // Timeline search
    const results = db.events
      .filter(e => e.description.includes(query) || e.tags.includes(query))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 10);
    
    return results;
  }
  
  if (mode === 'BY_TYPE') {
    // Filter by event type
    const results = db.events
      .filter(e => e.type === query.toLowerCase())
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 20);
    
    return results;
  }
  
  return [];
}

// ==== NARRATIVE ARC ====
export async function buildNarrativeArc(topic) {
  const db = loadDB();
  
  // Find all events related to topic
  const relevantEvents = await narrativeSearch(topic, 'SEMANTIC');
  
  if (relevantEvents.length === 0) {
    return { topic, arc: null, error: 'No events found' };
  }
  
  // Sort by timestamp
  const chronological = relevantEvents.sort((a, b) => 
    new Date(a.timestamp) - new Date(b.timestamp)
  );
  
  // Build arc: beginning → middle → climax → resolution
  const arc = {
    topic,
    beginning: chronological[0] || null,
    middle: chronological[Math.floor(chronological.length / 2)] || null,
    climax: chronological.filter(e => e.type === 'incident')[0] || chronological[chronological.length - 2] || null,
    resolution: chronological[chronological.length - 1] || null,
    allEvents: chronological
  };
  
  // Generate narrative summary
  const summary = generateNarrativeSummary(arc);
  
  log(`📖 Arc built for "${topic}": ${chronological.length} events`);
  
  return { topic, arc, summary };
}

// Generate 3-sentence summary
function generateNarrativeSummary(arc) {
  const parts = [];
  
  if (arc.beginning) {
    parts.push(`Beginning: ${arc.beginning.type.toUpperCase()} - ${arc.beginning.title}`);
  }
  
  if (arc.climax) {
    parts.push(`Climax: ${arc.climax.type.toUpperCase()} - ${arc.climax.title}`);
  }
  
  if (arc.resolution) {
    parts.push(`Resolution: ${arc.resolution.type.toUpperCase()} - ${arc.resolution.title}`);
  }
  
  return parts.join(' → ');
}

// ==== AGENT TIMELINE ====
export async function getAgentTimeline(agent) {
  const db = loadDB();
  
  const events = db.events
    .filter(e => e.agent === agent)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  const stats = {
    agent,
    totalEvents: events.length,
    eventTypes: db.agents[agent]?.eventTypes || {},
    lastActivity: db.agents[agent]?.lastEvent,
    events: events.slice(0, 20)
  };
  
  return stats;
}

// ==== METRICS ====
export async function getNarrativeMetrics() {
  const db = loadDB();
  
  const metrics = {
    totalEvents: db.events.length,
    agents: Object.keys(db.agents).length,
    agentList: db.agents,
    eventTypeBreakdown: {},
    recentEvents: db.events.slice(-5),
    decisionToIncidentRatio: 0
  };
  
  // Count by type
  for (const event of db.events) {
    metrics.eventTypeBreakdown[event.type] = (metrics.eventTypeBreakdown[event.type] || 0) + 1;
  }
  
  const decisions = metrics.eventTypeBreakdown[EVENT_TYPES.DECISION] || 0;
  const incidents = metrics.eventTypeBreakdown[EVENT_TYPES.INCIDENT] || 0;
  metrics.decisionToIncidentRatio = decisions > 0 ? (incidents / decisions).toFixed(2) : 0;
  
  return metrics;
}

// ==== TEST DATA ====
export function initializeTestData() {
  const db = loadDB();
  
  const testEvents = [
    {
      agent: 'atlas',
      type: EVENT_TYPES.DECISION,
      data: {
        title: 'Decided RS256 over HS256 for ORGON JWT',
        description: 'Multi-tenant security requires asymmetric keys',
        tags: ['JWT', 'ORGON', 'security'],
        context: { project: 'ORGON', component: 'auth' }
      }
    },
    {
      agent: 'bekzat',
      type: EVENT_TYPES.MILESTONE,
      data: {
        title: 'JWT auth complete for ORGON',
        description: 'All tests pass, security cleared by iron',
        tags: ['JWT', 'ORGON', 'milestone'],
        context: { project: 'ORGON', component: 'auth' }
      }
    },
    {
      agent: 'iron',
      type: EVENT_TYPES.INCIDENT,
      data: {
        title: 'SQL injection patched in ORGON',
        description: 'Found in user search endpoint, fixed within 2 hours',
        tags: ['SQL', 'ORGON', 'security'],
        context: { project: 'ORGON', severity: 'critical' }
      }
    }
  ];
  
  for (const testEvent of testEvents) {
    recordEvent(testEvent.agent, testEvent.type, testEvent.data);
  }
  
  log('✅ Test data initialized');
}

// Main
if (process.argv[2] === '--test') {
  initializeTestData();
  
  narrativeSearch('ORGON JWT', 'SEMANTIC').then(results => {
    console.log('\n🔍 Search results:');
    console.table(results.map(r => ({ agent: r.agent, type: r.type, title: r.title, score: r.score.toFixed(2) })));
  });
  
  buildNarrativeArc('JWT ORGON').then(arc => {
    console.log('\n📖 Narrative Arc:');
    console.log(arc.summary);
  });
  
  getNarrativeMetrics().then(metrics => {
    console.log('\n📊 Metrics:');
    console.log(JSON.stringify(metrics, null, 2));
  });
}