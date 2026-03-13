/**
 * Agent Performance Metrics — tracks quality, speed, cost per agent
 * Writes to Convex for dashboard display
 */

const CONVEX_URL = 'https://expert-dachshund-299.convex.cloud';
const CONVEX_SITE = 'https://expert-dachshund-299.convex.site';

async function convexQuery(fn, args = {}) {
  const r = await fetch(`${CONVEX_URL}/api/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: fn, args }),
  });
  const d = await r.json();
  return d.value;
}

export async function calculateAgentMetrics() {
  try {
    const tasks = await convexQuery('tasks:list', {});
    if (!Array.isArray(tasks)) return {};

    const agents = {};
    const now = Date.now();
    const WEEK_MS = 7 * 24 * 3600_000;

    for (const t of tasks) {
      const agent = t.agent || 'unknown';
      if (!agents[agent]) {
        agents[agent] = {
          total: 0, done: 0, failed: 0, blocked: 0,
          totalDuration: 0, durationCount: 0,
          recentTasks: 0, recentDone: 0,
        };
      }

      const a = agents[agent];
      a.total++;

      if (t.status === 'done') a.done++;
      else if (t.status === 'blocked') { a.blocked++; a.failed++; }

      // Recent (last 7 days)
      if ((t.createdAt || 0) > now - WEEK_MS) {
        a.recentTasks++;
        if (t.status === 'done') a.recentDone++;
      }

      // Duration (if updatedAt and createdAt exist)
      if (t.status === 'done' && t.updatedAt && t.createdAt) {
        const dur = t.updatedAt - t.createdAt;
        if (dur > 0 && dur < 86400_000) { // under 24h
          a.totalDuration += dur;
          a.durationCount++;
        }
      }
    }

    // Calculate scores
    const metrics = {};
    for (const [agent, a] of Object.entries(agents)) {
      const successRate = a.total > 0 ? Math.round(a.done / a.total * 100) : 0;
      const avgDuration = a.durationCount > 0 ? Math.round(a.totalDuration / a.durationCount / 1000) : 0;
      const velocity = a.recentDone; // tasks done in last 7 days
      const score = Math.min(100, Math.round(
        successRate * 0.5 +
        Math.min(velocity * 5, 30) +
        (avgDuration > 0 && avgDuration < 300 ? 20 : avgDuration < 3600 ? 10 : 0)
      ));

      metrics[agent] = {
        total: a.total,
        done: a.done,
        failed: a.failed,
        successRate,
        avgDurationSeconds: avgDuration,
        weeklyVelocity: velocity,
        score,
      };
    }

    return metrics;
  } catch (e) {
    console.error('[metrics]', e.message);
    return {};
  }
}
