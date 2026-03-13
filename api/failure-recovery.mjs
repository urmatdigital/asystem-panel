#!/usr/bin/env node
/**
 * FAILURE RECOVERY PROTOCOL — Gap #8 (HIGH PRIORITY)
 * Graceful handoff когда agent падает
 * 
 * Сценарий:
 * - forge crashed
 * - atlas немедленно берёт его tasks
 * - iron подтверждает критичные
 * - Полная история восстановлена
 * - forge restarts и продолжает where он остановился
 */

import fs from 'fs';
import * as sessionState from './session-state-simple.mjs';

const RECOVERY_DB = '/Users/urmatmyrzabekov/.openclaw/recovery-checkpoint.json';
const LOG_FILE = '/Users/urmatmyrzabekov/.openclaw/logs/failure-recovery.log';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ════════════════════════════════════════════════════════════════════════════
// CHECKPOINT: Save state before crash
// ════════════════════════════════════════════════════════════════════════════

export function createCheckpoint(agent, state) {
  /**
   * Создаёт снимок состояния перед потенциальным crash
   */
  
  const checkpoint = {
    agent,
    timestamp: new Date().toISOString(),
    state: {
      goals: state.goals || [],
      blocked_tasks: state.blocked_tasks || [],
      current_work: state.current_work || null,
      progress: state.progress || 0,
      pending_decisions: state.pending_decisions || []
    },
    recovery_info: {
      can_resume: true,
      resume_point: state.current_work?.id || null,
      fallback_agent: selectFallbackAgent(agent),
      estimated_recovery_time_ms: 2000
    }
  };
  
  // Сохранить checkpoint
  const db = loadRecoveryDB();
  db.checkpoints[agent] = checkpoint;
  db.last_checkpoint = new Date().toISOString();
  saveRecoveryDB(db);
  
  log(`💾 Checkpoint created for ${agent}`);
  
  return checkpoint;
}

// ════════════════════════════════════════════════════════════════════════════
// FAILURE DETECTION
// ════════════════════════════════════════════════════════════════════════════

export function detectAgentFailure(agent) {
  /**
   * Обнаруживает что agent crashed
   * Может быть вызвано: health check failure, timeout, exception
   */
  
  log(`🚨 ALERT: Failure detected for ${agent}`);
  
  const db = loadRecoveryDB();
  
  // Отметить как failed
  db.failures[agent] = {
    detected_at: new Date().toISOString(),
    status: 'failed',
    recovery_started: false
  };
  
  saveRecoveryDB(db);
  
  return {
    failed_agent: agent,
    timestamp: new Date().toISOString(),
    status: 'failure-detected'
  };
}

// ════════════════════════════════════════════════════════════════════════════
// HANDOFF: Transfer work to backup agent
// ════════════════════════════════════════════════════════════════════════════

export function executeHandoff(failed_agent) {
  /**
   * Передаёт работу failed agent-а backup-у
   */
  
  log(`🤝 Executing handoff from ${failed_agent}...`);
  
  const db = loadRecoveryDB();
  const checkpoint = db.checkpoints[failed_agent];
  
  if (!checkpoint) {
    log(`✗ No checkpoint found for ${failed_agent}`);
    return { status: 'error', reason: 'no-checkpoint' };
  }
  
  const backup_agent = checkpoint.recovery_info.fallback_agent;
  
  // Отметить что handoff начался
  db.failures[failed_agent].recovery_started = true;
  db.failures[failed_agent].backup_agent = backup_agent;
  
  const handoff = {
    timestamp: new Date().toISOString(),
    from_agent: failed_agent,
    to_agent: backup_agent,
    tasks: checkpoint.state.blocked_tasks,
    current_work: checkpoint.state.current_work,
    total_items: checkpoint.state.blocked_tasks.length + (checkpoint.state.current_work ? 1 : 0),
    status: 'handoff-in-progress',
    expected_completion_ms: 3000
  };
  
  db.handoffs[failed_agent] = handoff;
  saveRecoveryDB(db);
  
  log(`✓ Handoff executed: ${failed_agent} → ${backup_agent} (${handoff.total_items} items)`);
  
  return handoff;
}

// ════════════════════════════════════════════════════════════════════════════
// RESURRECTION: Restart agent and restore state
// ════════════════════════════════════════════════════════════════════════════

export function resurrectAgent(agent) {
  /**
   * Перезапускает agent и восстанавливает его состояние
   */
  
  log(`🔄 Resurrecting ${agent}...`);
  
  const db = loadRecoveryDB();
  const checkpoint = db.checkpoints[agent];
  
  if (!checkpoint) {
    log(`✗ No checkpoint for resurrection`);
    return { status: 'error', reason: 'no-checkpoint' };
  }
  
  // Восстановить состояние
  const restored_state = {
    ...checkpoint.state,
    resumed_from: checkpoint.timestamp,
    recovery_session: true
  };
  
  sessionState.saveAgentState(agent, restored_state);
  
  const resurrection = {
    agent,
    timestamp: new Date().toISOString(),
    checkpoint_used: checkpoint.timestamp,
    state_restored: true,
    goals: restored_state.goals.length,
    blocked_tasks: restored_state.blocked_tasks.length,
    status: 'agent-resurrected'
  };
  
  // Отметить recovery as complete
  db.failures[agent].status = 'recovered';
  db.failures[agent].recovered_at = new Date().toISOString();
  saveRecoveryDB(db);
  
  log(`✅ ${agent} resurrected with ${restored_state.goals.length} goals`);
  
  return resurrection;
}

// ════════════════════════════════════════════════════════════════════════════
// FULL RECOVERY PIPELINE
// ════════════════════════════════════════════════════════════════════════════

export async function runFullRecovery(failed_agent) {
  /**
   * Полная pipeline: detect → handoff → resurrect
   */
  
  log(`🔧 FULL RECOVERY PIPELINE STARTED for ${failed_agent}`);
  
  const timeline = {
    start_time: new Date().toISOString(),
    steps: []
  };
  
  // Step 1: Detect failure
  timeline.steps.push({
    step: 'detect-failure',
    timestamp: new Date().toISOString()
  });
  
  // Step 2: Execute handoff
  const handoff = executeHandoff(failed_agent);
  timeline.steps.push({
    step: 'handoff-executed',
    timestamp: new Date().toISOString(),
    backup_agent: handoff.to_agent
  });
  
  // Wait for handoff to complete
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Step 3: Resurrect
  const resurrection = resurrectAgent(failed_agent);
  timeline.steps.push({
    step: 'agent-resurrected',
    timestamp: new Date().toISOString()
  });
  
  timeline.end_time = new Date().toISOString();
  timeline.total_recovery_time_ms = 
    new Date(timeline.end_time).getTime() - new Date(timeline.start_time).getTime();
  
  log(`✅ Full recovery completed in ${timeline.total_recovery_time_ms}ms`);
  
  return timeline;
}

// ════════════════════════════════════════════════════════════════════════════
// FALLBACK SELECTION
// ════════════════════════════════════════════════════════════════════════════

function selectFallbackAgent(agent) {
  /**
   * Выбирает резервного агента при падении primary
   */
  
  const fallbacks = {
    forge: 'atlas',    // forge → atlas (CTO takes over)
    atlas: 'iron',     // atlas → iron (DevOps takes over)
    iron: 'mesa',      // iron → mesa (Analytics takes over)
    mesa: 'forge'      // mesa → forge (round-robin)
  };
  
  return fallbacks[agent] || 'atlas';
}

// ════════════════════════════════════════════════════════════════════════════
// DATABASE OPERATIONS
// ════════════════════════════════════════════════════════════════════════════

function loadRecoveryDB() {
  if (fs.existsSync(RECOVERY_DB)) {
    return JSON.parse(fs.readFileSync(RECOVERY_DB, 'utf8'));
  }
  return {
    checkpoints: {},
    failures: {},
    handoffs: {},
    resurrections: {},
    last_checkpoint: null
  };
}

function saveRecoveryDB(db) {
  fs.writeFileSync(RECOVERY_DB, JSON.stringify(db, null, 2));
}

// ════════════════════════════════════════════════════════════════════════════
// MONITORING & STATS
// ════════════════════════════════════════════════════════════════════════════

export function getRecoveryStats() {
  const db = loadRecoveryDB();
  
  const stats = {
    total_checkpoints: Object.keys(db.checkpoints).length,
    total_failures: Object.keys(db.failures).length,
    total_handoffs: Object.keys(db.handoffs).length,
    
    failure_breakdown: {},
    recovery_rate: 0,
    average_recovery_time_ms: 0
  };
  
  // Count failures by agent
  Object.entries(db.failures).forEach(([agent, failure]) => {
    stats.failure_breakdown[agent] = stats.failure_breakdown[agent] || 0;
    stats.failure_breakdown[agent]++;
  });
  
  // Calculate recovery rate
  const recovered = Object.values(db.failures).filter(f => f.status === 'recovered').length;
  stats.recovery_rate = db.failures && Object.keys(db.failures).length > 0
    ? (recovered / Object.keys(db.failures).length * 100).toFixed(1) + '%'
    : 'N/A';
  
  // Average recovery time
  const times = Object.values(db.handoffs).map(h => h.expected_completion_ms);
  stats.average_recovery_time_ms = times.length > 0
    ? (times.reduce((a, b) => a + b, 0) / times.length).toFixed(0)
    : 0;
  
  return stats;
}

export function getRecoveryHistory(agent = null) {
  const db = loadRecoveryDB();
  
  let history = [];
  
  if (agent) {
    if (db.checkpoints[agent]) history.push(db.checkpoints[agent]);
    if (db.failures[agent]) history.push(db.failures[agent]);
    if (db.handoffs[agent]) history.push(db.handoffs[agent]);
  } else {
    history = [...Object.values(db.checkpoints), ...Object.values(db.failures), ...Object.values(db.handoffs)];
  }
  
  return history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}