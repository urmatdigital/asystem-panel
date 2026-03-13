/**
 * Daily AI Standup — Auto-generates morning briefing from agent activity
 * 
 * Collects: tasks completed yesterday, current in-progress, blockers
 * Sends: Telegram summary at 08:00 UTC+6
 */

const CONVEX_CLOUD = 'https://expert-dachshund-299.convex.cloud';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8400727128:AAEDiXtE0P2MfUJirXtN8zDjpU9kN03ork0';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '861276843';

async function convexQuery(fn, args = {}) {
  const r = await fetch(`${CONVEX_CLOUD}/api/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: fn, args }),
    signal: AbortSignal.timeout(5000),
  });
  const d = await r.json();
  return d.value;
}

async function sendTelegram(message) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown' }),
  });
}

export async function generateStandup() {
  const tasks = await convexQuery('tasks:list', {});
  if (!Array.isArray(tasks)) return { error: 'No tasks' };

  const now = Date.now();
  const DAY_MS = 24 * 3600_000;

  // Tasks completed in last 24h
  const completedYesterday = tasks.filter(t =>
    t.status === 'done' && t.updatedAt && (now - t.updatedAt) < DAY_MS
  );

  // Currently in progress
  const inProgress = tasks.filter(t => t.status === 'in-progress');

  // Blocked
  const blocked = tasks.filter(t => t.status === 'blocked');

  // Stale (in-progress > 24h)
  const stale = inProgress.filter(t => t.updatedAt && (now - t.updatedAt) > DAY_MS);

  // Stats
  const totalDone = tasks.filter(t => t.status === 'done').length;
  const totalTasks = tasks.length;

  // Agent activity
  const agentActivity = {};
  completedYesterday.forEach(t => {
    const a = t.agent || 'unknown';
    agentActivity[a] = (agentActivity[a] || 0) + 1;
  });

  // Format message
  const lines = [
    `📊 *Утренний стэндап ASYSTEM*`,
    `_${new Date().toLocaleDateString('ru', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Bishkek' })}_`,
    '',
  ];

  // Completed
  if (completedYesterday.length > 0) {
    lines.push(`✅ *Завершено за 24ч:* ${completedYesterday.length}`);
    completedYesterday.slice(0, 5).forEach(t => {
      lines.push(`  • ${t.title} _(${t.agent || '?'})_`);
    });
    if (completedYesterday.length > 5) {
      lines.push(`  _...и ещё ${completedYesterday.length - 5}_`);
    }
    lines.push('');
  } else {
    lines.push('⚪ За 24ч задач не завершено\n');
  }

  // In progress
  if (inProgress.length > 0) {
    lines.push(`🔄 *В работе:* ${inProgress.length}`);
    inProgress.slice(0, 5).forEach(t => {
      const staleFlag = stale.includes(t) ? ' 🔴 STALE' : '';
      lines.push(`  • ${t.title} _(${t.agent || '?'})_${staleFlag}`);
    });
    lines.push('');
  }

  // Blocked
  if (blocked.length > 0) {
    lines.push(`🚫 *Заблокировано:* ${blocked.length}`);
    blocked.forEach(t => {
      lines.push(`  • ${t.title} _(${t.agent || '?'})_`);
    });
    lines.push('');
  }

  // Agent leaderboard
  if (Object.keys(agentActivity).length > 0) {
    lines.push('🏆 *Активность агентов (24ч):*');
    Object.entries(agentActivity)
      .sort(([, a], [, b]) => b - a)
      .forEach(([agent, count]) => {
        lines.push(`  ${agent}: ${count} задач`);
      });
    lines.push('');
  }

  // Overall
  lines.push(`📈 Всего: ${totalDone}/${totalTasks} done (${Math.round(totalDone/totalTasks*100)}%)`);

  if (stale.length > 0) {
    lines.push(`⚠️ ${stale.length} stale задач (>24ч без обновления)`);
  }

  const message = lines.join('\n');
  return { message, stats: { completed: completedYesterday.length, inProgress: inProgress.length, blocked: blocked.length, stale: stale.length } };
}

export async function sendStandup() {
  const { message, stats } = await generateStandup();
  if (message) await sendTelegram(message);
  return stats;
}
