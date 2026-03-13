// Convex → MC World Poller
// Polls Convex for task changes, syncs to Minecraft world instantly
// Runs as separate PM2 process

import net from 'net';

const CONVEX_URL = 'https://expert-dachshund-299.convex.cloud';
const MC_HOST = '100.79.117.102';
const MC_PORT = 25575;
const MC_PASS = 'asystem-rcon-2026';
const POLL_MS = 15000; // 15 seconds

const STATUS_BLOCKS = {
  todo:         'minecraft:white_concrete',
  'in-progress':'minecraft:lime_concrete',
  'in_progress':'minecraft:lime_concrete',
  working:      'minecraft:lime_concrete',
  done:         'minecraft:diamond_block',
  blocked:      'minecraft:red_concrete',
  review:       'minecraft:gold_block',
  idle:         'minecraft:gray_concrete',
};

const AGENT_PLOTS = {
  forge:  [100,-62,-10], atlas: [140,-62,-10], iron: [180,-62,-10],
  mesa:   [100,-62,30],  pixel: [140,-62,30],  dana: [180,-62,30],
  nurlan: [100,-62,70],  ainura:[140,-62,70],  marat:[180,-62,70],
  bekzat: [100,-62,110]
};

const AGENT_WORK_POS = {
  forge:  [105,-59,-5], atlas: [145,-59,-5], iron: [185,-59,-5],
  mesa:   [105,-59,35], pixel: [145,-59,35], dana: [185,-59,35],
  nurlan: [105,-59,75], ainura:[145,-59,75], marat:[185,-59,75],
  bekzat: [105,-59,115]
};

const rcon = (cmd) => new Promise((resolve) => {
  const s = net.createConnection({ host: MC_HOST, port: MC_PORT });
  s.setTimeout(4000);
  let buf = Buffer.alloc(0);
  const pkt = (id, type, payload) => {
    const p = Buffer.from(payload, 'utf8');
    const b = Buffer.alloc(14 + p.length);
    b.writeInt32LE(10 + p.length, 0); b.writeInt32LE(id, 4); b.writeInt32LE(type, 8);
    p.copy(b, 12); b.writeUInt16LE(0, 12 + p.length); s.write(b);
  };
  s.on('connect', () => pkt(1, 3, MC_PASS));
  s.on('data', (data) => {
    buf = Buffer.concat([buf, data]);
    if (buf.length < 4) return;
    const len = buf.readInt32LE(0);
    if (buf.length < 4 + len) return;
    const reqId = buf.readInt32LE(4);
    if (reqId === 1) { pkt(2, 2, cmd); return; }
    if (reqId === 2) { s.destroy(); resolve(buf.slice(12, 4+len-2).toString('utf8')); }
  });
  s.on('timeout', () => { s.destroy(); resolve(''); });
  s.on('error', () => resolve(''));
});

let prevTaskState = {}; // taskId → status

async function fetchConvexTasks() {
  try {
    const r = await fetch(`${CONVEX_URL}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'tasks:list', args: {} }),
      signal: AbortSignal.timeout(20000),
    });
    const d = await r.json();
    return d.value || d.result || [];
  } catch (e) {
    console.error('[POLLER] Convex fetch error:', e.message);
    return [];
  }
}

async function applyTaskToWorld(task) {
  const agent = (task.agent || task.assignee || '').toLowerCase().trim();
  const status = task.status || 'idle';
  const plot = AGENT_PLOTS[agent];
  if (!plot) return;

  const block = STATUS_BLOCKS[status] || 'minecraft:gray_concrete';
  const cap = agent.charAt(0).toUpperCase() + agent.slice(1);
  const [px, py, pz] = plot;

  await rcon(`setblock ${px} ${py} ${pz} ${block}`);

  // Visual effects on status change
  if (status === 'done') {
    await rcon(`particle minecraft:firework ${px} ${py+5} ${pz} 1.5 1.5 1.5 0 25 force`);
    await rcon(`scoreboard players add ${cap} tasks_done 1`);
    await rcon(`say §a[✓] §f${cap} завершил: §7${(task.title||'').substring(0,40)}`);
  } else if (status === 'blocked' || status === 'in-progress' && prevTaskState[task._id] === 'done') {
    await rcon(`particle minecraft:smoke ${px} ${py+4} ${pz} 0.5 1 0.5 0.05 15 force`);
  } else if (status === 'in-progress' || status === 'in_progress') {
    const wp = AGENT_WORK_POS[agent];
    if (wp) {
      await rcon(`tp ${cap} ${wp[0]} ${wp[1]} ${wp[2]}`);
    }
    await rcon(`particle minecraft:flame ${px} ${py+4} ${pz} 0.3 0.5 0.3 0 6 force`);
  }

  // Update scoreboard load
  await rcon(`scoreboard players set ${cap} load 1`);
}

async function poll() {
  const tasks = await fetchConvexTasks();
  if (!tasks.length) return;

  const changed = [];
  for (const task of tasks) {
    const id = task._id || task.id;
    if (!id) continue;
    const prev = prevTaskState[id];
    const curr = task.status;
    if (prev !== curr) {
      changed.push(task);
      prevTaskState[id] = curr;
    }
  }

  if (changed.length > 0) {
    console.log(`[POLLER] ${new Date().toISOString()} ${changed.length} задач изменились`);
    for (const task of changed) {
      try {
        await applyTaskToWorld(task);
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        console.error(`[POLLER] Error for ${task.assignee}:`, e.message);
      }
    }
  }

  // Full scoreboard refresh every 10 polls
  if (!poll._count) poll._count = 0;
  poll._count++;
  if (poll._count % 10 === 0) {
    // Aggregate load counts
    const loads = {};
    for (const task of tasks) {
      const a = (task.agent || task.assignee || '').toLowerCase();
      if (AGENT_PLOTS[a] && task.status !== 'done') {
        loads[a] = (loads[a] || 0) + 1;
      }
    }
    for (const [agent, count] of Object.entries(loads)) {
      const cap = agent.charAt(0).toUpperCase() + agent.slice(1);
      await rcon(`scoreboard players set ${cap} load ${count}`);
      await new Promise(r => setTimeout(r, 150));
    }
  }
}

// Initialize state on start
console.log('[POLLER] Starting Convex→MC poller (15s interval)...');
fetchConvexTasks().then(tasks => {
  for (const t of tasks) {
    const id = t._id || t.id;
    if (id) prevTaskState[id] = t.status;
  }
  console.log(`[POLLER] Loaded ${tasks.length} tasks as baseline`);
}).catch(console.error);

// Start polling
setInterval(() => poll().catch(console.error), POLL_MS);
