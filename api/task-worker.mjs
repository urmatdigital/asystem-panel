/**
 * task-worker.mjs v2 — ASYSTEM Task Worker
 * Polls Convex for tasks assigned to Forge → executes → marks done
 */

import { execSync, exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const CONVEX_URL = 'https://expert-dachshund-299.convex.cloud';
const AGENT_NAME = 'forge';
const POLL_INTERVAL = 20_000;

let isRunning = false;

async function convexQuery(fn, args = {}) {
  const r = await fetch(`${CONVEX_URL}/api/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: fn, args }),
  });
  const d = await r.json();
  if (d.errorMessage) throw new Error(d.errorMessage);
  return d.value;
}

async function convexMutation(fn, args = {}) {
  const r = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: fn, args }),
  });
  const d = await r.json();
  if (d.errorMessage) throw new Error(d.errorMessage);
  return d.value;
}

// ── Determine if task is executable ───────────────────────────────────────
function isExecutable(task) {
  const taskType = (task.type || '').toLowerCase();
  // Skip non-executable types
  const skipTypes = ['feature', 'content', 'meta', 'doc', 'prd', 'task'];
  if (skipTypes.includes(taskType)) return false;
  // Skip auto-generated tasks
  if (task.description?.startsWith('Auto-generated')) return false;
  if ((task.tags ?? []).some(t => ['meta-observer', 'auto', 'no-exec'].includes(t))) return false;
  // Only execute explicitly executable types or exec-tagged
  const execTypes = ['shell', 'bash', 'code', 'coding', 'git', 'digest', 'chat', 'dispatch', 'deploy', 'mac-agent', 'job'];
  if (execTypes.includes(taskType)) return true;
  if ((task.tags ?? []).includes('exec')) return true;
  return false;
}

// ── Executors ──────────────────────────────────────────────────────────────
async function executeShell(task) {
  // Extract code block or use first line only
  const cmd = task.description?.match(/```(?:bash|sh)?\n([\s\S]*?)```/)?.[1]?.trim()
    || task.description?.split('\n')[0]?.trim()
    || task.title;
  
  console.log(`[worker] SHELL: ${cmd.slice(0, 100)}`);
  const { stdout, stderr } = await execAsync(cmd, {
    timeout: 60_000, cwd: process.env.HOME + '/projects/ASYSTEM',
    shell: '/bin/bash',
  });
  return (stdout || stderr || 'OK').trim().slice(0, 500);
}

async function executeCode(task) {
  const prompt = (task.description || task.title).slice(0, 2000);
  console.log(`[worker] CODE → mac-agent: ${prompt.slice(0, 80)}`);
  
  // Route to mac-mini-agent API instead of direct claude CLI
  const r = await fetch('http://localhost:7600/job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'forge-mac-agent-2026-secret' },
    body: JSON.stringify({ prompt, runtime: 'gemini' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`mac-agent API error: ${r.status}`);
  const job = await r.json();
  
  // Wait for completion (poll every 5s, max 5min)
  const jobId = job.job_id;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const status = await fetch(`http://localhost:7600/job/${jobId}`, {
      headers: { 'X-API-Key': 'forge-mac-agent-2026-secret' },
    });
    const text = await status.text();
    if (text.includes('status: completed')) return `Job ${jobId} completed`;
    if (text.includes('status: failed')) throw new Error(`Job ${jobId} failed`);
    if (text.includes('status: timeout')) throw new Error(`Job ${jobId} timeout`);
  }
  return `Job ${jobId} submitted (async)`;
}

async function executeGit(task) {
  const cmd = task.description?.match(/(git [^\n]+)/)?.[1] || 'git status --short';
  const { stdout } = await execAsync(cmd, {
    cwd: process.env.HOME + '/Projects/ASYSTEM/panel', timeout: 30_000,
  });
  return stdout.trim().slice(0, 500) || 'OK';
}

async function executeDigest(task) {
  const r = await fetch('http://localhost:5190/api/digest');
  const d = await r.json();
  return (d.md || 'Digest OK').slice(0, 300);
}

function extractProjectDir(task) {
  const map = {
    orgon: process.env.HOME + '/projects/ORGON',
    aurwa: process.env.HOME + '/projects/AURWA',
    voltera: process.env.HOME + '/projects/Voltera-mobile',
    fiatex: process.env.HOME + '/projects/fiatexkg',
    panel: process.env.HOME + '/Projects/ASYSTEM/panel',
  };
  const text = `${task.title} ${task.description || ''} ${(task.tags||[]).join(' ')}`.toLowerCase();
  return Object.entries(map).find(([k]) => text.includes(k))?.[1];
}

async function postSquadChat(message) {
  try {
    await fetch('http://localhost:5190/api/veritas/api/v1/chat/squad', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'Forge', message, tags: ['forge', 'worker'], model: 'claude-sonnet-4-6' }),
    });
  } catch {}
}

// ── Main ───────────────────────────────────────────────────────────────────
async function processTask(task) {
  const taskId = task._id;
  const taskTypeLower = (task.type || 'shell').toLowerCase();
  console.log(`[worker] ▶ "${task.title}" [${taskTypeLower}]`);

  await convexMutation('tasks:updateStatus', { id: taskId, status: 'in-progress' });
  // MC World sync: task started
  fetch('http://127.0.0.1:5190/api/mc/task-event', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: (task.agent || task.assignee || 'forge').toLowerCase(), status: 'in_progress', title: task.title || '' })
  }).catch(() => {});

  try {
    let result;
    if (taskTypeLower === 'code' || taskTypeLower === 'coding' || taskTypeLower === 'mac-agent') result = await executeCode(task);
    else if (taskTypeLower === 'git') result = await executeGit(task);
    else if (taskTypeLower === 'digest') result = await executeDigest(task);
    else result = await executeShell(task);

    await convexMutation('tasks:updateStatus', { id: taskId, status: 'done' });
    // MC World sync: task done → diamond block + firework
    fetch('http://127.0.0.1:5190/api/mc/task-event', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: (task.agent || task.assignee || 'forge').toLowerCase(), status: 'done', title: task.title || '' })
    }).catch(() => {});
    await postSquadChat(`✅ [Forge Worker] "${task.title}"\n\`\`\`\n${result}\n\`\`\``);
    console.log(`[worker] ✅ Done: "${task.title}"`);
  } catch (err) {
    console.error(`[worker] ❌ "${task.title}":`, err.message.slice(0, 100));
    await convexMutation('tasks:updateStatus', { id: taskId, status: 'blocked' });
    // MC World sync: task blocked → red block + smoke
    fetch('http://127.0.0.1:5190/api/mc/task-event', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: (task.agent || task.assignee || 'forge').toLowerCase(), status: 'blocked', title: task.title || '' })
    }).catch(() => {});
    await postSquadChat(`❌ [Forge Worker] "${task.title}" failed: ${err.message.slice(0,80)}`);
  }
}

async function poll() {
  if (isRunning) return;
  isRunning = true;
  try {
    const tasks = await convexQuery('tasks:listByAgent', { agent: AGENT_NAME, status: 'todo' });
    if (!tasks?.length) return;

    // Filter to only executable tasks, sort by priority
    const pri = { critical: 0, high: 1, medium: 2, low: 3 };
    const executable = tasks
      .filter(isExecutable)
      .sort((a, b) => (pri[a.priority] ?? 2) - (pri[b.priority] ?? 2));

    if (executable.length === 0) {
      console.log(`[worker] ${tasks.length} tasks found, 0 executable (all auto/meta)`);
      return;
    }
    await processTask(executable[0]);
  } catch (err) {
    if (!err.message?.includes('No tasks')) console.error('[worker] Poll error:', err.message);
  } finally {
    isRunning = false;
  }
}

// ── Event-driven: also check for dispatches targeting forge ──────────────
async function checkDispatches() {
  try {
    const dispatches = await convexQuery('dispatches:pending', { agent: AGENT_NAME });
    if (!dispatches?.length) return;

    for (const d of dispatches) {
      console.log(`[worker] 📬 Dispatch: "${d.title}" → processing`);
      // Convert dispatch to task execution
      const task = {
        _id: d._id,
        title: d.title,
        description: d.description || d.body || '',
        type: d.type || 'code',
        priority: d.priority || 'medium',
        tags: d.tags || [],
      };

      if (isExecutable(task)) {
        await processTask(task);
      } else {
        console.log(`[worker] Skip non-executable dispatch: "${d.title}"`);
      }

      // Mark dispatch as processed
      try {
        await convexMutation('dispatches:markProcessed', { id: d._id });
      } catch {}
    }
  } catch (err) {
    // dispatches table might not exist yet — silently skip
    if (!err.message?.includes('Could not find') && !err.message?.includes('Server Error')) {
      console.error('[worker] Dispatch check error:', err.message?.slice(0, 80));
    }
  }
}

console.log(`[task-worker v2] agent=${AGENT_NAME}, interval=${POLL_INTERVAL/1000}s`);
console.log(`[task-worker v2] Event-driven: checking dispatches + tasks`);
poll();
checkDispatches();
setInterval(poll, POLL_INTERVAL);
setInterval(checkDispatches, 15_000); // dispatches check every 15s
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
