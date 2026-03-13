/**
 * time-aware.mjs — Time-Aware Agent Behavior Scheduler
 *
 * Video: "AI Agents That Actually Work: Real Tools Saving 40+ Minutes Per Task" (AY2dL2S6d_M)
 * Pattern: Motion AI / Reclaim AI approach — agent is not time-blind.
 *   Knows current time, day of week, workload patterns → adjusts:
 *   - Which tasks to run NOW vs defer
 *   - Priority boosts for time-sensitive tasks
 *   - Quiet hours: no critical pings during 23:00-08:00 UTC+6
 *   - Peak hours: batch non-urgent tasks to off-peak
 *   - Day-of-week patterns: Monday = planning, Friday = review/cleanup
 *
 * Time zones: Asia/Bishkek (UTC+6) — Урмат's timezone
 *
 * Time windows (UTC+6):
 *   QUIET      (23:00-08:00) — only CRITICAL tasks, no notifications
 *   MORNING    (08:00-10:00) — planning, reviews, briefings
 *   PRIME      (10:00-17:00) — implementation, high-priority work
 *   AFTERNOON  (17:00-20:00) — testing, documentation, reviews
 *   EVENING    (20:00-23:00) — cleanup, low-priority, async work
 *
 * Day patterns:
 *   MON: planning-heavy → boost planning tasks
 *   TUE-THU: implementation → boost implement/build
 *   FRI: review-heavy → boost review/test/document
 *   SAT-SUN: maintenance only → only critical + housekeeping
 *
 * API:
 *   GET  /api/time/context          → current time context + recommendations
 *   POST /api/time/should-run       { priority, type, agentId } → yes/no/defer
 *   POST /api/time/optimal-slot     { taskType, urgency } → when to schedule
 *   GET  /api/time/window           → current window name + allowed actions
 */

import os from 'node:os';

const TZ = 'Asia/Bishkek';

// ── Get current time in Bishkek ───────────────────────────────────────────────
function getBishkekTime() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: 'numeric', minute: 'numeric', hour12: false,
    weekday: 'short', day: 'numeric', month: 'numeric',
  }).formatToParts(now);
  const get = (type) => parts.find(p => p.type === type)?.value;
  const hour   = parseInt(get('hour')  || '12');
  const minute = parseInt(get('minute') || '0');
  const weekday = get('weekday'); // Mon, Tue, ...
  return { hour, minute, weekday, totalMinutes: hour * 60 + minute };
}

// ── Determine time window ──────────────────────────────────────────────────────
function getWindow(hour) {
  if (hour >= 23 || hour < 8)  return { name: 'QUIET',     emoji: '🌙', allowedPriorities: ['critical'],                          desc: 'Quiet hours — only critical tasks' };
  if (hour >= 8  && hour < 10) return { name: 'MORNING',   emoji: '🌅', allowedPriorities: ['critical', 'high', 'medium'],         desc: 'Morning — planning & reviews' };
  if (hour >= 10 && hour < 17) return { name: 'PRIME',     emoji: '⚡', allowedPriorities: ['critical', 'high', 'medium', 'low'],  desc: 'Prime time — full capacity' };
  if (hour >= 17 && hour < 20) return { name: 'AFTERNOON', emoji: '🌆', allowedPriorities: ['critical', 'high', 'medium'],         desc: 'Afternoon — testing & docs' };
  return                               { name: 'EVENING',   emoji: '🌃', allowedPriorities: ['critical', 'high', 'medium', 'low'],  desc: 'Evening — async & cleanup' };
}

// ── Day-of-week task type boosts ──────────────────────────────────────────────
const DAY_BOOSTS = {
  'Mon': { boosted: ['planning', 'review', 'architecture'], penalized: ['deploy', 'refactor'],  energy: 'focused' },
  'Tue': { boosted: ['implement', 'build', 'create'],       penalized: ['meeting', 'planning'], energy: 'high' },
  'Wed': { boosted: ['implement', 'build', 'fix'],          penalized: [],                      energy: 'peak' },
  'Thu': { boosted: ['test', 'review', 'implement'],        penalized: [],                      energy: 'high' },
  'Fri': { boosted: ['review', 'test', 'document', 'cleanup'], penalized: ['implement'],        energy: 'wind_down' },
  'Sat': { boosted: ['cleanup', 'document'],                penalized: ['implement', 'deploy'], energy: 'maintenance' },
  'Sun': { boosted: ['planning', 'research'],               penalized: ['deploy', 'implement'], energy: 'rest' },
};

// ── Get current time context ──────────────────────────────────────────────────
export function getTimeContext() {
  const { hour, minute, weekday } = getBishkekTime();
  const window   = getWindow(hour);
  const dayBoost = DAY_BOOSTS[weekday] || DAY_BOOSTS['Wed'];

  const recommendations = [];
  if (window.name === 'MORNING')   recommendations.push('Run daily briefing', 'Queue planning tasks', 'Review overnight failures');
  if (window.name === 'PRIME')     recommendations.push('Dispatch high-priority implementation', 'Run coalition formations', 'Enable full task processing');
  if (window.name === 'AFTERNOON') recommendations.push('Run test suites', 'Generate documentation', 'Code reviews');
  if (window.name === 'EVENING')   recommendations.push('Async cleanup tasks', 'Memory consolidation', 'Non-urgent backlog');
  if (window.name === 'QUIET')     recommendations.push('Critical alerts only', 'No bulk dispatching', 'Quiet monitoring');

  if (weekday === 'Fri') recommendations.push('Friday: prioritize review + test + merge');
  if (weekday === 'Mon') recommendations.push('Monday: start with planning and architecture review');
  if (['Sat', 'Sun'].includes(weekday)) recommendations.push('Weekend: maintenance mode only');

  return {
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    weekday, window: window.name, windowEmoji: window.emoji, windowDesc: window.desc,
    allowedPriorities: window.allowedPriorities,
    dayEnergy: dayBoost.energy, boostedTypes: dayBoost.boosted, penalizedTypes: dayBoost.penalized,
    recommendations,
    isQuietHours: window.name === 'QUIET',
    isPrimeTime: window.name === 'PRIME',
  };
}

// ── Should a task run now? ────────────────────────────────────────────────────
export function shouldRun({ priority = 'medium', type = 'general', agentId = null }) {
  const ctx = getTimeContext();

  // Priority gate
  if (!ctx.allowedPriorities.includes(priority)) {
    const nextWindow = getNextAllowedWindow(priority);
    return { run: false, reason: `${ctx.window} window doesn't allow ${priority} tasks`, defer: true, deferUntil: nextWindow, ctx };
  }

  // Weekend gate for non-critical
  if (['Sat', 'Sun'].includes(ctx.weekday) && priority !== 'critical' && !['cleanup', 'document', 'monitor'].includes(type)) {
    return { run: false, reason: 'Weekend maintenance mode — only critical/cleanup tasks', defer: true, deferUntil: 'Monday 08:00', ctx };
  }

  // Penalized task type on this day
  if (ctx.penalizedTypes.includes(type) && priority !== 'critical') {
    return { run: true, warn: true, reason: `${type} is de-prioritized on ${ctx.weekday}`, ctx };
  }

  // Boosted task type bonus
  const boosted = ctx.boostedTypes.includes(type);
  return { run: true, boosted, reason: boosted ? `${type} is prioritized on ${ctx.weekday} ${ctx.window}` : 'Task cleared for current time window', ctx };
}

// ── Find optimal scheduling slot ──────────────────────────────────────────────
export function optimalSlot({ taskType = 'implement', urgency = 'medium' }) {
  if (urgency === 'critical') return { slot: 'now', reason: 'Critical — run immediately' };

  const { weekday, hour } = getBishkekTime();
  const slotMap = {
    'implement': { best: 'PRIME (10-17)', days: ['Tue', 'Wed', 'Thu'] },
    'review':    { best: 'MORNING (08-10) or AFTERNOON (17-20)', days: ['Mon', 'Thu', 'Fri'] },
    'test':      { best: 'AFTERNOON (17-20)', days: ['Thu', 'Fri'] },
    'document':  { best: 'AFTERNOON (17-20)', days: ['Fri'] },
    'deploy':    { best: 'PRIME mid-week (10-15)', days: ['Tue', 'Wed'] },
    'cleanup':   { best: 'EVENING (20-23)', days: ['Fri', 'Sat'] },
    'planning':  { best: 'MORNING (08-10)', days: ['Mon', 'Tue'] },
  };

  const rec = slotMap[taskType] || { best: 'PRIME (10-17)', days: ['Tue', 'Wed', 'Thu'] };
  const ctx = getTimeContext();
  const ideal = rec.days.includes(weekday) && ctx.isPrimeTime;
  return { slot: ideal ? 'now (ideal conditions)' : rec.best, bestDays: rec.days, currentConditions: `${weekday} ${ctx.window}`, ideal };
}

function getNextAllowedWindow(priority) {
  if (priority === 'critical') return 'now (critical always allowed)';
  const { hour } = getBishkekTime();
  if (hour < 8)  return 'Today 08:00';
  if (hour >= 23) return 'Tomorrow 08:00';
  return '10:00 (PRIME)';
}
