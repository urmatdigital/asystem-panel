#!/usr/bin/env node
/**
 * REAL-TIME SYNC — WebSocket broadcast for decisions/incidents
 * Enables instant decision propagation to all agents
 * 
 * Events:
 * - decision.made → atlas decides something
 * - incident.reported → iron finds a bug
 * - incident.resolved → iron fixes it
 * - lesson.learned → forge discovers pattern
 * - goal.updated → atlas sets new OKR
 */

import WebSocket from 'ws';

const clients = new Map(); // agent -> ws connection
const eventLog = []; // Broadcast history
const LOG_FILE = '/Users/urmatmyrzabekov/.openclaw/logs/realtime-sync.log';

import fs from 'fs';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ════════════════════════════════════════════════════════════════════════════
// WEBSOCKET SERVER SETUP
// ════════════════════════════════════════════════════════════════════════════

let wss = null;

export function initRealtimeSync(httpServer) {
  wss = new WebSocket.Server({ server: httpServer });
  
  wss.on('connection', (ws, req) => {
    const agent = req.url?.split('?agent=')[1] || 'unknown';
    
    clients.set(agent, ws);
    log(`✓ ${agent} connected (${clients.size} agents online)`);
    
    // Send recent broadcasts on connect
    eventLog.slice(-5).forEach(event => {
      ws.send(JSON.stringify(event));
    });
    
    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data);
        handleEvent(agent, event);
      } catch (err) {
        log(`✗ Message parse error: ${err.message}`);
      }
    });
    
    ws.on('close', () => {
      clients.delete(agent);
      log(`✗ ${agent} disconnected (${clients.size} agents online)`);
    });
  });
  
  log('🎙️ WebSocket server initialized');
  
  // Auto-broadcast heartbeat
  setInterval(() => {
    broadcast({
      type: 'heartbeat',
      timestamp: new Date().toISOString(),
      agents_online: clients.size
    });
  }, 30_000); // Every 30 seconds
}

// ════════════════════════════════════════════════════════════════════════════
// EVENT HANDLING
// ════════════════════════════════════════════════════════════════════════════

function handleEvent(fromAgent, event) {
  log(`📨 ${fromAgent}: ${event.type}`);
  
  // Log event
  eventLog.push({
    ...event,
    from_agent: fromAgent,
    timestamp: new Date().toISOString(),
    broadcast_id: `bc_${Date.now()}`
  });
  
  // Keep last 1000 events
  if (eventLog.length > 1000) {
    eventLog.shift();
  }
  
  // Broadcast to affected agents
  if (event.type === 'decision.made') {
    broadcastToRadius(event, event.impact_radius || []);
  } else if (event.type === 'incident.reported') {
    broadcastToRadius(event, ['atlas', 'iron', 'mesa']); // Alert critical agents
  } else if (event.type === 'lesson.learned') {
    broadcastToAll(event); // Share knowledge
  } else {
    broadcastToAll(event);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BROADCAST METHODS
// ════════════════════════════════════════════════════════════════════════════

export function broadcastToAll(event) {
  const msg = JSON.stringify({
    ...event,
    broadcast_at: new Date().toISOString()
  });
  
  let count = 0;
  clients.forEach((ws, agent) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
      count++;
    }
  });
  
  log(`📢 Broadcast to ${count}/${clients.size} agents: ${event.type}`);
}

export function broadcastToRadius(event, agents) {
  const msg = JSON.stringify({
    ...event,
    broadcast_at: new Date().toISOString()
  });
  
  let count = 0;
  agents.forEach(agent => {
    const ws = clients.get(agent);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
      count++;
    }
  });
  
  log(`📢 Broadcast to ${agents.join(', ')}: ${event.type} (${count} delivered)`);
}

export function broadcast(event) {
  broadcastToAll(event);
}

// ════════════════════════════════════════════════════════════════════════════
// EVENT SHORTCUTS
// ════════════════════════════════════════════════════════════════════════════

export function broadcastDecision(agent, decision) {
  handleEvent(agent, {
    type: 'decision.made',
    title: decision.title,
    reasoning: decision.reasoning,
    chosen_option: decision.chosen_option,
    impact_radius: decision.impact_radius || [],
    urgency: decision.urgency || 'normal'
  });
}

export function broadcastIncident(agent, incident) {
  handleEvent(agent, {
    type: 'incident.reported',
    severity: incident.severity,
    title: incident.title,
    description: incident.description,
    affected_systems: incident.affected_systems || []
  });
}

export function broadcastResolution(agent, incident) {
  handleEvent(agent, {
    type: 'incident.resolved',
    incident_title: incident.title,
    resolution: incident.resolution,
    time_to_fix: incident.time_to_fix
  });
}

export function broadcastLesson(agent, lesson) {
  handleEvent(agent, {
    type: 'lesson.learned',
    category: lesson.category,
    pattern: lesson.pattern,
    success_rate: lesson.success_rate,
    recommended_action: lesson.recommended_action
  });
}

export function broadcastGoal(agent, goal) {
  handleEvent(agent, {
    type: 'goal.updated',
    goal_title: goal.title,
    deadline: goal.deadline,
    priority: goal.priority
  });
}

// ════════════════════════════════════════════════════════════════════════════
// STATS & MONITORING
// ════════════════════════════════════════════════════════════════════════════

export function getStats() {
  const stats = {
    agents_online: clients.size,
    agents_list: Array.from(clients.keys()),
    events_logged: eventLog.length,
    last_events: eventLog.slice(-10),
    event_types: {}
  };
  
  // Count by type
  eventLog.forEach(event => {
    stats.event_types[event.type] = (stats.event_types[event.type] || 0) + 1;
  });
  
  return stats;
}

export function getEventHistory(limit = 50) {
  return eventLog.slice(-limit);
}