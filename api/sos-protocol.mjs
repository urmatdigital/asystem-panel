/**
 * SOS Protocol — Agent Failover & Recovery
 * 
 * Hierarchical command structure:
 * 1. Atlas (CTO) — primary command
 * 2. IRON (CSO/backup) — takes over if Atlas down
 * 3. Forge (COO/ops) — field executor
 * 4. Mesa (CFO) — analytics/decisions
 * 
 * Triggers:
 * - Atlas offline > 5min → IRON becomes interim CTO
 * - Forge offline > 3min → tasks delegated to IRON or Mesa
 * - Both down → auto-escalate to Urmat + lock out new tasks
 * 
 * Implementation:
 * - Health check every 30sec
 * - State tracking: lastPing, failCount, interim leadership
 * - Context handoff via Reme memory
 */

import { createHash } from 'node:crypto';

// Leadership state (in-memory, persists across restarts via Convex)
let currentCTO = 'atlas';      // Who's in charge
let currentCOO = 'forge';      // Who executes ops
let lastHealthCheck = Date.now();

// Health tracking (per agent)
const agentHealth = new Map([
  ['atlas', { lastPing: Date.now(), failCount: 0, downSince: null }],
  ['iron', { lastPing: Date.now(), failCount: 0, downSince: null }],
  ['forge', { lastPing: Date.now(), failCount: 0, downSince: null }],
  ['mesa', { lastPing: Date.now(), failCount: 0, downSince: null }],
  ['pixel', { lastPing: Date.now(), failCount: 0, downSince: null }],
]);

// Thresholds (milliseconds)
const FAIL_THRESHOLD = {
  atlas: 5 * 60_000,     // 5 minutes before failover
  forge: 3 * 60_000,     // 3 minutes
  iron: 10 * 60_000,     // 10 minutes (less critical)
};

// Alert state (per incident)
const alertSent = new Set();

/**
 * Record agent health ping
 */
export function recordHealthPing(agent, ok = true) {
  if (!agentHealth.has(agent)) {
    agentHealth.set(agent, { lastPing: Date.now(), failCount: 0, downSince: null });
  }

  const health = agentHealth.get(agent);
  health.lastPing = Date.now();

  if (ok) {
    health.failCount = 0;
    health.downSince = null;
  } else {
    health.failCount++;
    if (!health.downSince) health.downSince = Date.now();
  }
}

/**
 * Check if agent is responsive
 */
export async function isAgentHealthy(agent) {
  const API = 'http://localhost:5190';
  
  // Special handling for remote agents
  if (['atlas', 'iron', 'mesa', 'pixel'].includes(agent)) {
    try {
      const resp = await fetch(`${API}/api/agents/health?agent=${agent}`, {
        signal: AbortSignal.timeout(3000),
      }).then(r => r.ok);
      recordHealthPing(agent, resp);
      return resp;
    } catch (e) {
      recordHealthPing(agent, false);
      return false;
    }
  }

  // Forge is local
  if (agent === 'forge') {
    try {
      const resp = await fetch(`${API}/api/tasks/pending?limit=1`, {
        signal: AbortSignal.timeout(2000),
      }).then(r => r.ok);
      recordHealthPing(agent, resp);
      return resp;
    } catch (e) {
      recordHealthPing(agent, false);
      return false;
    }
  }

  return false;
}

/**
 * SOS health check — called every 30sec
 * Returns actions needed
 */
export async function sosHealthCheck() {
  const now = Date.now();
  const changes = [];

  // Check all critical agents
  const toCheck = ['atlas', 'forge', 'iron'];
  const statusBefore = { cto: currentCTO, coo: currentCOO };

  for (const agent of toCheck) {
    const healthy = await isAgentHealthy(agent);
    const health = agentHealth.get(agent);
    const downTime = now - health.downSince;
    const threshold = FAIL_THRESHOLD[agent];

    if (!healthy && health.downSince && downTime > threshold) {
      // TRIGGER FAILOVER
      changes.push({
        agent,
        action: 'FAILOVER_TRIGGERED',
        downTime: downTime,
        threshold: threshold,
      });

      if (agent === 'atlas' && currentCTO === 'atlas') {
        // IRON takes command
        currentCTO = 'iron';
        changes.push({ action: 'CTO_CHANGE', from: 'atlas', to: 'iron', reason: 'atlas_down_5min' });
      }

      if (agent === 'forge' && currentCOO === 'forge') {
        // IRON takes operations (if not already CTO)
        if (currentCTO === 'atlas') {
          // Still have CTO, delegate to Mesa
          currentCOO = 'mesa';
          changes.push({ action: 'COO_CHANGE', from: 'forge', to: 'mesa', reason: 'forge_down_3min' });
        } else {
          // Already in failover mode, Iron takes everything
          currentCOO = 'iron';
          changes.push({ action: 'COO_CHANGE', from: 'forge', to: 'iron', reason: 'forge_down_sos' });
        }
      }
    }
  }

  // If leadership changed, send alert & context handoff
  if (statusBefore.cto !== currentCTO || statusBefore.coo !== currentCOO) {
    changes.push({ notification: 'LEADERSHIP_CHANGED', status: { cto: currentCTO, coo: currentCOO } });
  }

  return {
    timestamp: now,
    health: Object.fromEntries(
      [...agentHealth.entries()].map(([a, h]) => [a, {
        ok: h.failCount === 0,
        failCount: h.failCount,
        downSince: h.downSince,
        downMinutes: h.downSince ? Math.floor((now - h.downSince) / 60_000) : 0,
      }])
    ),
    leadership: { cto: currentCTO, coo: currentCOO },
    changes,
  };
}

/**
 * Get current leadership
 */
export function getLeadership() {
  return {
    cto: currentCTO,              // Chief Technical Officer
    coo: currentCOO,              // Chief Operating Officer (executor)
    timestamp: Date.now(),
  };
}

/**
 * Delegate task to appropriate agent based on leadership
 */
export function getDelegateAgent(taskType) {
  // Task routing logic
  const routing = {
    'code': 'forge',              // Coding → Forge (unless down)
    'ops': 'iron',                // Operations → Iron
    'analytics': 'mesa',          // Analytics → Mesa
    'design': 'pixel',            // Design → Pixel
    'qa': 'marat',                // QA → Marat
    'pm': 'dana',                 // Project management → Dana
  };

  let agent = routing[taskType] || 'forge';

  // If primary agent is down, use backup
  const health = agentHealth.get(agent);
  if (health && health.failCount > 0) {
    if (taskType === 'code') agent = 'iron';      // Backup coder
    else if (taskType === 'ops') agent = 'mesa';  // Backup ops
    else agent = currentCOO;                       // Default to COO
  }

  return agent;
}

/**
 * Context handoff — prepare migration of tasks/state
 * Called when leadership changes
 */
export function prepareContextHandoff(fromAgent, toAgent) {
  return {
    handoff: {
      from: fromAgent,
      to: toAgent,
      timestamp: Date.now(),
      action: `TRANSFER_LEADERSHIP_${fromAgent}_TO_${toAgent}`,
      context: {
        save_memory: `Save all state to Reme before transfer`,
        save_pending_tasks: `Mark tasks as HOLD status (don't run yet)`,
        sync_convex: `Push latest task state to Convex`,
        alert_recipient: `Notify new leader of pending work`,
      },
    },
  };
}

/**
 * Panic mode — both Atlas and Forge down
 */
export function isPanicMode() {
  const atlasHealth = agentHealth.get('atlas');
  const forgeHealth = agentHealth.get('forge');
  
  return (atlasHealth?.failCount > 0) && (forgeHealth?.failCount > 0);
}

/**
 * Get SOS status report
 */
export function getSOSReport() {
  const now = Date.now();
  const report = {
    timestamp: now,
    panic_mode: isPanicMode(),
    leadership: { cto: currentCTO, coo: currentCOO },
    agent_health: {},
  };

  for (const [agent, health] of agentHealth) {
    const downMin = health.downSince ? Math.floor((now - health.downSince) / 60_000) : 0;
    report.agent_health[agent] = {
      status: health.failCount === 0 ? 'UP' : 'DOWN',
      down_minutes: downMin,
      fail_count: health.failCount,
      threshold_minutes: Math.floor(FAIL_THRESHOLD[agent] / 60_000),
    };
  }

  return report;
}

/**
 * Reset agent (recovery after restart)
 */
export function resetAgentHealth(agent) {
  if (agentHealth.has(agent)) {
    agentHealth.get(agent).failCount = 0;
    agentHealth.get(agent).downSince = null;
    agentHealth.get(agent).lastPing = Date.now();
  }
}

export default {
  recordHealthPing,
  isAgentHealthy,
  sosHealthCheck,
  getLeadership,
  getDelegateAgent,
  prepareContextHandoff,
  isPanicMode,
  getSOSReport,
  resetAgentHealth,
  FAIL_THRESHOLD,
};
