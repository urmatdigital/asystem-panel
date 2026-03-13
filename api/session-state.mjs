#!/usr/bin/env node
/**
 * SESSION STATE — Persistent agent memory across sessions
 * Enables async work, goal continuation, failure recovery
 * 
 * Storage: SQLite (~/.openclaw/agent-state.db)
 * Load: On agent startup
 * Save: Every 5 minutes + on critical events
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const STATE_DB = '/Users/urmatmyrzabekov/.openclaw/agent-state.db';
const LOG_FILE = '/Users/urmatmyrzabekov/.openclaw/logs/session-state.log';

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
  fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
}

// ════════════════════════════════════════════════════════════════════════════
// SCHEMA
// ════════════════════════════════════════════════════════════════════════════

function initDB() {
  try {
    const db = new Database(STATE_DB);
    
    // Agent state table
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_state (
        agent_id TEXT PRIMARY KEY,
        current_goal TEXT,
        goal_progress INTEGER DEFAULT 0,
        goal_deadline TEXT,
        blocked_tasks TEXT,
        learned_patterns TEXT,
        last_session_end TEXT,
        context_snapshot TEXT,
        metrics TEXT,
        created_at TEXT,
        updated_at TEXT
      )
    `);
    
    // Shared incidents
    db.exec(`
      CREATE TABLE IF NOT EXISTS shared_incidents (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        type TEXT,
        severity TEXT,
        title TEXT,
        description TEXT,
        resolution TEXT,
        created_at TEXT,
        resolved_at TEXT
      )
    `);
    
    // Shared decisions
    db.exec(`
      CREATE TABLE IF NOT EXISTS shared_decisions (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        title TEXT,
        reasoning TEXT,
        alternatives TEXT,
        chosen_option TEXT,
        impact_radius TEXT,
        created_at TEXT,
        broadcast_to TEXT
      )
    `);
    
    // Lessons learned
    db.exec(`
      CREATE TABLE IF NOT EXISTS lessons_learned (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        category TEXT,
        pattern TEXT,
        success_rate REAL,
        failure_cases TEXT,
        recommended_action TEXT,
        created_at TEXT
      )
    `);
    
    log('✓ Database initialized');
    return db;
  } catch (err) {
    log(`✗ DB init error: ${err.message}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// AGENT STATE MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════

export function saveAgentState(db, agent, state) {
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO agent_state 
      (agent_id, current_goal, goal_progress, goal_deadline, blocked_tasks, 
       learned_patterns, last_session_end, context_snapshot, metrics, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      agent,
      state.current_goal || null,
      state.goal_progress || 0,
      state.goal_deadline || null,
      JSON.stringify(state.blocked_tasks || []),
      JSON.stringify(state.learned_patterns || []),
      new Date().toISOString(),
      JSON.stringify(state.context_snapshot || {}),
      JSON.stringify(state.metrics || {}),
      new Date().toISOString()
    );
    
    log(`✓ Saved ${agent} state: goal="${state.current_goal?.slice(0, 30)}", progress=${state.goal_progress}%`);
  } catch (err) {
    log(`✗ Save state error: ${err.message}`);
  }
}

export function loadAgentState(db, agent) {
  try {
    const stmt = db.prepare('SELECT * FROM agent_state WHERE agent_id = ?');
    const row = stmt.get(agent);
    
    if (row) {
      const state = {
        agent_id: row.agent_id,
        current_goal: row.current_goal,
        goal_progress: row.goal_progress,
        goal_deadline: row.goal_deadline,
        blocked_tasks: JSON.parse(row.blocked_tasks),
        learned_patterns: JSON.parse(row.learned_patterns),
        context_snapshot: JSON.parse(row.context_snapshot),
        metrics: JSON.parse(row.metrics)
      };
      
      log(`↑ Loaded ${agent} state: goal="${state.current_goal?.slice(0, 30)}", progress=${state.goal_progress}%`);
      return state;
    }
    
    log(`ℹ No prior state for ${agent} (new session)`);
    return null;
  } catch (err) {
    log(`✗ Load state error: ${err.message}`);
    return null;
  }
}

export function getAllAgentStates(db) {
  try {
    const stmt = db.prepare('SELECT * FROM agent_state');
    const rows = stmt.all();
    
    const states = {};
    for (const row of rows) {
      states[row.agent_id] = {
        current_goal: row.current_goal,
        goal_progress: row.goal_progress,
        goal_deadline: row.goal_deadline
      };
    }
    
    log(`✓ Loaded ${rows.length} agent states`);
    return states;
  } catch (err) {
    log(`✗ Get all states error: ${err.message}`);
    return {};
  }
}

// ════════════════════════════════════════════════════════════════════════════
// INCIDENT TRACKING
// ════════════════════════════════════════════════════════════════════════════

export function recordIncident(db, agent, incident) {
  try {
    const id = `inc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    
    const stmt = db.prepare(`
      INSERT INTO shared_incidents 
      (id, agent_id, type, severity, title, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      id,
      agent,
      incident.type,
      incident.severity,
      incident.title,
      incident.description,
      new Date().toISOString()
    );
    
    log(`🚨 Incident recorded: ${incident.severity.toUpperCase()} - ${incident.title} (${agent})`);
    
    // Broadcast to other agents
    broadcastIncident(db, { id, agent, ...incident });
    
    return id;
  } catch (err) {
    log(`✗ Record incident error: ${err.message}`);
  }
}

export function resolveIncident(db, id, resolution) {
  try {
    const stmt = db.prepare(`
      UPDATE shared_incidents 
      SET resolution = ?, resolved_at = ?
      WHERE id = ?
    `);
    
    stmt.run(resolution, new Date().toISOString(), id);
    log(`✓ Incident resolved: ${id}`);
  } catch (err) {
    log(`✗ Resolve incident error: ${err.message}`);
  }
}

export function getActiveIncidents(db) {
  try {
    const stmt = db.prepare(`
      SELECT * FROM shared_incidents 
      WHERE resolved_at IS NULL 
      ORDER BY created_at DESC
    `);
    
    return stmt.all();
  } catch (err) {
    log(`✗ Get incidents error: ${err.message}`);
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// DECISION TRACKING
// ════════════════════════════════════════════════════════════════════════════

export function recordDecision(db, agent, decision) {
  try {
    const id = `dec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    
    const stmt = db.prepare(`
      INSERT INTO shared_decisions 
      (id, agent_id, title, reasoning, alternatives, chosen_option, impact_radius, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      id,
      agent,
      decision.title,
      decision.reasoning,
      JSON.stringify(decision.alternatives || []),
      decision.chosen_option,
      JSON.stringify(decision.impact_radius || []),
      new Date().toISOString()
    );
    
    log(`✓ Decision recorded: "${decision.title}" (${agent})`);
    
    // Broadcast to affected agents
    broadcastDecision(db, { id, agent, ...decision });
    
    return id;
  } catch (err) {
    log(`✗ Record decision error: ${err.message}`);
  }
}

export function getDecisions(db, agent = null) {
  try {
    let stmt;
    if (agent) {
      stmt = db.prepare('SELECT * FROM shared_decisions WHERE agent_id = ? ORDER BY created_at DESC');
      return stmt.all(agent);
    } else {
      stmt = db.prepare('SELECT * FROM shared_decisions ORDER BY created_at DESC LIMIT 50');
      return stmt.all();
    }
  } catch (err) {
    log(`✗ Get decisions error: ${err.message}`);
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// LESSONS LEARNED
// ════════════════════════════════════════════════════════════════════════════

export function recordLesson(db, agent, lesson) {
  try {
    const id = `les_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    
    const stmt = db.prepare(`
      INSERT INTO lessons_learned 
      (id, agent_id, category, pattern, success_rate, failure_cases, recommended_action, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      id,
      agent,
      lesson.category,
      lesson.pattern,
      lesson.success_rate || 0,
      JSON.stringify(lesson.failure_cases || []),
      lesson.recommended_action,
      new Date().toISOString()
    );
    
    log(`✏️ Lesson recorded: ${lesson.category} - ${lesson.pattern.slice(0, 30)}... (success=${(lesson.success_rate * 100).toFixed(0)}%)`);
    
    return id;
  } catch (err) {
    log(`✗ Record lesson error: ${err.message}`);
  }
}

export function getLessons(db, category = null) {
  try {
    let stmt;
    if (category) {
      stmt = db.prepare('SELECT * FROM lessons_learned WHERE category = ? ORDER BY success_rate DESC');
      return stmt.all(category);
    } else {
      stmt = db.prepare('SELECT * FROM lessons_learned ORDER BY created_at DESC LIMIT 100');
      return stmt.all();
    }
  } catch (err) {
    log(`✗ Get lessons error: ${err.message}`);
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BROADCASTING
// ════════════════════════════════════════════════════════════════════════════

function broadcastIncident(db, incident) {
  // In future: send via WebSocket to all agents
  log(`  📢 Broadcasting incident to agents...`);
}

function broadcastDecision(db, decision) {
  // In future: send via WebSocket to impacted agents
  const affected = decision.impact_radius || [];
  log(`  📢 Broadcasting decision to ${affected.length} affected agents`);
}

// ════════════════════════════════════════════════════════════════════════════
// METRICS & STATS
// ════════════════════════════════════════════════════════════════════════════

export function getMetrics(db) {
  try {
    const agents = db.prepare('SELECT COUNT(*) as count FROM agent_state').get().count;
    const incidents = db.prepare('SELECT COUNT(*) as count FROM shared_incidents WHERE resolved_at IS NULL').get().count;
    const decisions = db.prepare('SELECT COUNT(*) as count FROM shared_decisions').get().count;
    const lessons = db.prepare('SELECT COUNT(*) as count FROM lessons_learned').get().count;
    
    return {
      agents_tracked: agents,
      active_incidents: incidents,
      decisions_recorded: decisions,
      lessons_learned: lessons,
      db_path: STATE_DB
    };
  } catch (err) {
    log(`✗ Get metrics error: ${err.message}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ════════════════════════════════════════════════════════════════════════════

export function initSessionState() {
  log('🚀 Initializing Session State system');
  
  // Create DB
  const db = initDB();
  if (!db) {
    log('✗ Failed to initialize database');
    return null;
  }
  
  // Load all agent states
  const states = getAllAgentStates(db);
  
  // Log metrics
  const metrics = getMetrics(db);
  if (metrics) {
    log(`📊 State metrics: ${metrics.agents_tracked} agents, ${metrics.active_incidents} incidents, ${metrics.decisions_recorded} decisions, ${metrics.lessons_learned} lessons`);
  }
  
  // Setup auto-save (every 5 minutes)
  setInterval(() => {
    const metrics = getMetrics(db);
    log(`💾 Auto-save tick: ${metrics.agents_tracked} agents`);
  }, 5 * 60 * 1000);
  
  return db;
}

// ════════════════════════════════════════════════════════════════════════════
// EXPORT SINGLETON
// ════════════════════════════════════════════════════════════════════════════

export let SESSION_STATE_DB = null;

export function getSessionDB() {
  if (!SESSION_STATE_DB) {
    SESSION_STATE_DB = initSessionState();
  }
  return SESSION_STATE_DB;
}