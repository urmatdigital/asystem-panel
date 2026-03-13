#!/usr/bin/env node
/**
 * SESSION STATE — Persistent agent memory (JSON-based, no dependencies)
 * Enables async work, goal continuation, failure recovery
 * 
 * Storage: JSON files (~/.openclaw/state/)
 * Load: On agent startup
 * Save: Every 5 minutes + on critical events
 */

import fs from 'fs';
import path from 'path';

const STATE_DIR = '/Users/urmatmyrzabekov/.openclaw/state';
const LOG_FILE = '/Users/urmatmyrzabekov/.openclaw/logs/session-state.log';

// Ensure dir exists
if (!fs.existsSync(STATE_DIR)) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ════════════════════════════════════════════════════════════════════════════
// AGENT STATE
// ════════════════════════════════════════════════════════════════════════════

export function saveAgentState(agent, state) {
  try {
    const filePath = path.join(STATE_DIR, `${agent}.json`);
    const data = {
      agent_id: agent,
      current_goal: state.current_goal || null,
      goal_progress: state.goal_progress || 0,
      goal_deadline: state.goal_deadline || null,
      blocked_tasks: state.blocked_tasks || [],
      learned_patterns: state.learned_patterns || [],
      context_snapshot: state.context_snapshot || {},
      metrics: state.metrics || {},
      last_updated: new Date().toISOString()
    };
    
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    log(`✓ Saved ${agent} state: goal="${state.current_goal?.slice(0, 30)}", progress=${state.goal_progress}%`);
  } catch (err) {
    log(`✗ Save state error: ${err.message}`);
  }
}

export function loadAgentState(agent) {
  try {
    const filePath = path.join(STATE_DIR, `${agent}.json`);
    
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      log(`↑ Loaded ${agent} state: goal="${data.current_goal?.slice(0, 30)}", progress=${data.goal_progress}%`);
      return data;
    }
    
    log(`ℹ No prior state for ${agent} (new session)`);
    return null;
  } catch (err) {
    log(`✗ Load state error: ${err.message}`);
    return null;
  }
}

export function getAllAgentStates() {
  try {
    const files = fs.readdirSync(STATE_DIR).filter(f => f.endsWith('.json') && f !== 'incidents.json' && f !== 'decisions.json' && f !== 'lessons.json');
    
    const states = {};
    for (const file of files) {
      const agent = file.replace('.json', '');
      const data = JSON.parse(fs.readFileSync(path.join(STATE_DIR, file), 'utf-8'));
      states[agent] = {
        current_goal: data.current_goal,
        goal_progress: data.goal_progress,
        goal_deadline: data.goal_deadline
      };
    }
    
    log(`✓ Loaded ${files.length} agent states`);
    return states;
  } catch (err) {
    log(`✗ Get all states error: ${err.message}`);
    return {};
  }
}

// ════════════════════════════════════════════════════════════════════════════
// INCIDENT TRACKING
// ════════════════════════════════════════════════════════════════════════════

export function recordIncident(agent, incident) {
  try {
    const id = `inc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const filePath = path.join(STATE_DIR, 'incidents.json');
    
    let incidents = [];
    if (fs.existsSync(filePath)) {
      incidents = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
    
    incidents.push({
      id,
      agent_id: agent,
      type: incident.type,
      severity: incident.severity,
      title: incident.title,
      description: incident.description,
      resolution: null,
      created_at: new Date().toISOString(),
      resolved_at: null
    });
    
    fs.writeFileSync(filePath, JSON.stringify(incidents, null, 2));
    log(`🚨 Incident recorded: ${incident.severity.toUpperCase()} - ${incident.title} (${agent})`);
    
    return id;
  } catch (err) {
    log(`✗ Record incident error: ${err.message}`);
  }
}

export function resolveIncident(id, resolution) {
  try {
    const filePath = path.join(STATE_DIR, 'incidents.json');
    
    if (!fs.existsSync(filePath)) return;
    
    let incidents = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const incident = incidents.find(i => i.id === id);
    
    if (incident) {
      incident.resolution = resolution;
      incident.resolved_at = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify(incidents, null, 2));
      log(`✓ Incident resolved: ${id}`);
    }
  } catch (err) {
    log(`✗ Resolve incident error: ${err.message}`);
  }
}

export function getActiveIncidents() {
  try {
    const filePath = path.join(STATE_DIR, 'incidents.json');
    
    if (!fs.existsSync(filePath)) return [];
    
    const incidents = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return incidents.filter(i => !i.resolved_at).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  } catch (err) {
    log(`✗ Get incidents error: ${err.message}`);
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// DECISION TRACKING
// ════════════════════════════════════════════════════════════════════════════

export function recordDecision(agent, decision) {
  try {
    const id = `dec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const filePath = path.join(STATE_DIR, 'decisions.json');
    
    let decisions = [];
    if (fs.existsSync(filePath)) {
      decisions = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
    
    decisions.push({
      id,
      agent_id: agent,
      title: decision.title,
      reasoning: decision.reasoning,
      alternatives: decision.alternatives || [],
      chosen_option: decision.chosen_option,
      impact_radius: decision.impact_radius || [],
      created_at: new Date().toISOString()
    });
    
    fs.writeFileSync(filePath, JSON.stringify(decisions, null, 2));
    log(`✓ Decision recorded: "${decision.title}" (${agent})`);
    
    return id;
  } catch (err) {
    log(`✗ Record decision error: ${err.message}`);
  }
}

export function getDecisions(agent = null) {
  try {
    const filePath = path.join(STATE_DIR, 'decisions.json');
    
    if (!fs.existsSync(filePath)) return [];
    
    let decisions = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    
    if (agent) {
      decisions = decisions.filter(d => d.agent_id === agent);
    }
    
    return decisions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 50);
  } catch (err) {
    log(`✗ Get decisions error: ${err.message}`);
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// LESSONS LEARNED
// ════════════════════════════════════════════════════════════════════════════

export function recordLesson(agent, lesson) {
  try {
    const id = `les_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const filePath = path.join(STATE_DIR, 'lessons.json');
    
    let lessons = [];
    if (fs.existsSync(filePath)) {
      lessons = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
    
    lessons.push({
      id,
      agent_id: agent,
      category: lesson.category,
      pattern: lesson.pattern,
      success_rate: lesson.success_rate || 0,
      failure_cases: lesson.failure_cases || [],
      recommended_action: lesson.recommended_action,
      created_at: new Date().toISOString()
    });
    
    fs.writeFileSync(filePath, JSON.stringify(lessons, null, 2));
    log(`✏️ Lesson recorded: ${lesson.category} - ${lesson.pattern.slice(0, 30)}... (success=${(lesson.success_rate * 100).toFixed(0)}%)`);
    
    return id;
  } catch (err) {
    log(`✗ Record lesson error: ${err.message}`);
  }
}

export function getLessons(category = null) {
  try {
    const filePath = path.join(STATE_DIR, 'lessons.json');
    
    if (!fs.existsSync(filePath)) return [];
    
    let lessons = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    
    if (category) {
      lessons = lessons.filter(l => l.category === category);
    }
    
    return lessons.sort((a, b) => b.success_rate - a.success_rate).slice(0, 100);
  } catch (err) {
    log(`✗ Get lessons error: ${err.message}`);
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// METRICS & STATS
// ════════════════════════════════════════════════════════════════════════════

export function getMetrics() {
  try {
    const agents = fs.readdirSync(STATE_DIR).filter(f => f.endsWith('.json') && !['incidents.json', 'decisions.json', 'lessons.json'].includes(f)).length;
    
    const incidents = getActiveIncidents().length;
    const decisions = getDecisions().length;
    const lessons = getLessons().length;
    
    return {
      agents_tracked: agents,
      active_incidents: incidents,
      decisions_recorded: decisions,
      lessons_learned: lessons,
      state_dir: STATE_DIR,
      timestamp: new Date().toISOString()
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
  log('🚀 Initializing Session State system (JSON-based)');
  
  // Load all agent states
  const states = getAllAgentStates();
  
  // Log metrics
  const metrics = getMetrics();
  if (metrics) {
    log(`📊 State metrics: ${metrics.agents_tracked} agents, ${metrics.active_incidents} incidents, ${metrics.decisions_recorded} decisions, ${metrics.lessons_learned} lessons`);
  }
  
  // Setup auto-save (every 5 minutes)
  setInterval(() => {
    const metrics = getMetrics();
    log(`💾 Auto-save tick: ${metrics.agents_tracked} agents tracked`);
  }, 5 * 60 * 1000);
  
  return { initialized: true, state_dir: STATE_DIR };
}