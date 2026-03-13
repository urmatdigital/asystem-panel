#!/usr/bin/env node
/**
 * AUTONOMOUS GOALS — Tier 3
 * Agents generate their own OKRs based on learned patterns + current state
 * 
 * Every Monday 08:00 UTC+6: Generate weekly OKRs
 * Track progress continuously
 * Adjust based on blockers
 */

import fs from 'fs';
import * as sessionState from './session-state-simple.mjs';

const LOG_FILE = '/Users/urmatmyrzabekov/.openclaw/logs/autonomous-goals.log';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ════════════════════════════════════════════════════════════════════════════
// GOAL GENERATION ENGINE
// ════════════════════════════════════════════════════════════════════════════

export function generateWeeklyOKRs(agent, context = {}) {
  log(`🎯 Generating weekly OKRs for ${agent}`);
  
  const state = sessionState.loadAgentState(agent);
  const lessons = sessionState.getLessons();
  const incidents = sessionState.getActiveIncidents();
  
  // Agent-specific goal patterns
  const goalPatterns = {
    forge: {
      focus: 'System optimization + self-improvement',
      areas: ['Cost efficiency', 'Performance', 'Reliability', 'Learning']
    },
    atlas: {
      focus: 'Multi-agent coordination + strategy',
      areas: ['Team alignment', 'Decision quality', 'Infrastructure', 'Scaling']
    },
    iron: {
      focus: 'Incident prevention + DevOps',
      areas: ['Stability', 'Security', 'Observability', 'Automation']
    },
    mesa: {
      focus: 'Analytics + insights',
      areas: ['Data quality', 'Pattern recognition', 'Reporting', 'Optimization']
    }
  };
  
  const pattern = goalPatterns[agent] || goalPatterns.forge;
  
  // Generate OKRs based on agent profile
  const okrs = [
    {
      objective: pattern.areas[0],
      key_results: [
        { kr: 'Reduce costs by 20%', progress: state?.goal_progress || 0, owner: agent },
        { kr: 'Improve automation by 2 systems', progress: 0, owner: agent }
      ],
      priority: 'critical'
    },
    {
      objective: pattern.areas[1],
      key_results: [
        { kr: 'Learn 3 new patterns', progress: 0, owner: agent },
        { kr: 'Document lessons in knowledge base', progress: 0, owner: agent }
      ],
      priority: 'high'
    },
    {
      objective: 'Resolve blockers',
      key_results: state?.blocked_tasks?.map(task => ({
        kr: `Unblock: ${task}`,
        progress: 0,
        owner: agent
      })) || [],
      priority: 'high'
    }
  ];
  
  log(`✓ Generated ${okrs.length} OKRs for ${agent}`);
  
  // Save OKRs to state
  sessionState.saveAgentState(agent, {
    ...state,
    current_goal: `Weekly OKR: ${okrs[0].objective}`,
    goal_progress: 0,
    goal_deadline: getNextSunday(),
    okrs: okrs
  });
  
  return okrs;
}

// ════════════════════════════════════════════════════════════════════════════
// PROGRESS TRACKING
// ════════════════════════════════════════════════════════════════════════════

export function trackOKRProgress(agent, okrIndex, krIndex, progress) {
  const state = sessionState.loadAgentState(agent);
  
  if (state?.okrs && state.okrs[okrIndex]) {
    state.okrs[okrIndex].key_results[krIndex].progress = Math.min(100, progress);
    state.goal_progress = Math.round(
      state.okrs.reduce((avg, o) => {
        const krProgress = o.key_results.reduce((sum, kr) => sum + (kr.progress || 0), 0) / Math.max(1, o.key_results.length);
        return avg + krProgress;
      }, 0) / state.okrs.length
    );
    
    sessionState.saveAgentState(agent, state);
    log(`📊 ${agent} KR[${okrIndex}][${krIndex}] → ${progress}% (avg: ${state.goal_progress}%)`);
    
    return state.goal_progress;
  }
}

export function getOKRStatus(agent) {
  const state = sessionState.loadAgentState(agent);
  
  if (!state?.okrs) return null;
  
  const status = {
    agent,
    okrs: state.okrs.map(o => ({
      objective: o.objective,
      progress: Math.round(
        o.key_results.reduce((sum, kr) => sum + (kr.progress || 0), 0) / Math.max(1, o.key_results.length)
      ),
      key_results: o.key_results.map(kr => ({
        kr: kr.kr,
        progress: kr.progress,
        status: kr.progress >= 75 ? 'on-track' : kr.progress >= 25 ? 'at-risk' : 'blocked'
      })),
      priority: o.priority
    })),
    overall_progress: state.goal_progress,
    deadline: state.goal_deadline
  };
  
  return status;
}

// ════════════════════════════════════════════════════════════════════════════
// BLOCKER DETECTION & ESCALATION
// ════════════════════════════════════════════════════════════════════════════

export function checkBlockers(agent) {
  const state = sessionState.loadAgentState(agent);
  const okrStatus = getOKRStatus(agent);
  
  if (!okrStatus) return [];
  
  const blockers = [];
  
  for (const okr of okrStatus.okrs) {
    if (okr.progress === 0) {
      blockers.push({
        type: 'no-progress',
        objective: okr.objective,
        priority: okr.priority,
        action: 'Escalate to atlas for unblocking'
      });
    } else if (okr.progress < 25 && Date.now() > new Date(state.goal_deadline) - 3 * 24 * 60 * 60 * 1000) {
      // Less than 3 days to deadline, less than 25% progress
      blockers.push({
        type: 'timeline-risk',
        objective: okr.objective,
        priority: 'critical',
        action: 'Replan scope or extend deadline'
      });
    }
  }
  
  if (blockers.length > 0) {
    log(`⚠️  ${agent}: ${blockers.length} blockers detected`);
    blockers.forEach(b => log(`   - ${b.type}: ${b.objective}`));
  }
  
  return blockers;
}

// ════════════════════════════════════════════════════════════════════════════
// WEEKLY RESET
// ════════════════════════════════════════════════════════════════════════════

export function runWeeklyOKRCycle() {
  const agents = ['forge', 'atlas', 'iron', 'mesa'];
  
  log(`🔄 Running weekly OKR cycle for ${agents.length} agents`);
  
  const results = {};
  
  for (const agent of agents) {
    try {
      const okrs = generateWeeklyOKRs(agent);
      results[agent] = {
        okrs_generated: okrs.length,
        status: 'success'
      };
    } catch (err) {
      log(`✗ ${agent} OKR generation failed: ${err.message}`);
      results[agent] = { status: 'error', error: err.message };
    }
  }
  
  log(`✓ Weekly OKR cycle complete`);
  return results;
}

// ════════════════════════════════════════════════════════════════════════════
// UTILS
// ════════════════════════════════════════════════════════════════════════════

function getNextSunday() {
  const now = new Date();
  const daysUntilSunday = (7 - now.getDay()) % 7 || 7;
  const nextSunday = new Date(now.getTime() + daysUntilSunday * 24 * 60 * 60 * 1000);
  return nextSunday.toISOString();
}

export function getMetrics() {
  const agents = ['forge', 'atlas', 'iron', 'mesa'];
  const metrics = {
    agents: agents.length,
    okr_states: {}
  };
  
  for (const agent of agents) {
    const status = getOKRStatus(agent);
    if (status) {
      metrics.okr_states[agent] = {
        progress: status.overall_progress,
        okrs_count: status.okrs.length,
        blockers: checkBlockers(agent).length
      };
    }
  }
  
  return metrics;
}