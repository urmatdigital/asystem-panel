/**
 * A2A (Agent-to-Agent) Protocol for ASYSTEM
 * 
 * Enables agents to:
 * 1. Send requests to each other (request/response pattern)
 * 2. Chain workflows (agent A → agent B → agent C → result)
 * 3. Broadcast events (agent offline, task complete, etc.)
 * 
 * All messages go through Convex for persistence + real-time sync
 */

const CONVEX_SITE = 'https://expert-dachshund-299.convex.site';
const CONVEX_CLOUD = 'https://expert-dachshund-299.convex.cloud';

// Agent capabilities registry
export const AGENT_CAPABILITIES = {
  forge:  { skills: ['coding', 'build', 'deploy', 'media', 'panel'], runtime: 'mac-mini', maxConcurrent: 2 },
  atlas:  { skills: ['architecture', 'review', 'strategy', 'planning'], runtime: 'vm', maxConcurrent: 1 },
  iron:   { skills: ['security', 'audit', 'monitoring', 'hardening'], runtime: 'vps', maxConcurrent: 1 },
  mesa:   { skills: ['analytics', 'data', 'simulation', 'forecasting'], runtime: 'vm', maxConcurrent: 1 },
  titan:  { skills: ['infrastructure', 'vm', 'proxmox', 'networking'], runtime: 'proxmox', maxConcurrent: 1 },
  pixel:  { skills: ['design', 'figma', 'brand', 'visual'], runtime: 'vm', maxConcurrent: 1 },
  bekzat: { skills: ['backend', 'api', 'database', 'fastapi', 'nestjs'], runtime: 'lxc', maxConcurrent: 1 },
  ainura: { skills: ['frontend', 'react', 'vue', 'css', 'pwa'], runtime: 'lxc', maxConcurrent: 1 },
  marat:  { skills: ['testing', 'qa', 'e2e', 'cypress', 'jest'], runtime: 'lxc', maxConcurrent: 1 },
  nurlan: { skills: ['devops', 'docker', 'ci-cd', 'nginx', 'deploy'], runtime: 'lxc', maxConcurrent: 1 },
  dana:   { skills: ['pm', 'sprint', 'planning', 'roadmap', 'meeting'], runtime: 'lxc', maxConcurrent: 1 },
};

/**
 * Find best agent for a task based on required skills
 */
export function findBestAgent(requiredSkills, excludeAgents = []) {
  let bestAgent = null;
  let bestScore = 0;

  for (const [agent, caps] of Object.entries(AGENT_CAPABILITIES)) {
    if (excludeAgents.includes(agent)) continue;
    const matchCount = requiredSkills.filter(s => caps.skills.includes(s)).length;
    const score = matchCount / requiredSkills.length;
    if (score > bestScore) {
      bestScore = score;
      bestAgent = agent;
    }
  }
  return { agent: bestAgent, score: bestScore };
}

/**
 * Decompose a high-level goal into sub-tasks for multiple agents
 */
export function decomposeGoal(title, description = '') {
  const text = (title + ' ' + description).toLowerCase();
  const subtasks = [];

  // Pattern matching for common goal types
  const patterns = [
    {
      match: ['new feature', 'implement', 'add', 'create', 'build'],
      tasks: [
        { phase: 'plan', skills: ['planning', 'architecture'], title: `Архитектура: ${title}`, type: 'plan' },
        { phase: 'backend', skills: ['backend', 'api', 'database'], title: `Backend: ${title}`, type: 'code' },
        { phase: 'frontend', skills: ['frontend', 'react', 'css'], title: `Frontend: ${title}`, type: 'code' },
        { phase: 'test', skills: ['testing', 'qa', 'e2e'], title: `Tests: ${title}`, type: 'test' },
        { phase: 'deploy', skills: ['devops', 'deploy', 'docker'], title: `Deploy: ${title}`, type: 'deploy' },
      ]
    },
    {
      match: ['fix', 'bug', 'error', 'broken', 'не работает', 'ошибка'],
      tasks: [
        { phase: 'diagnose', skills: ['coding', 'review'], title: `Диагностика: ${title}`, type: 'debug' },
        { phase: 'fix', skills: ['coding', 'backend', 'frontend'], title: `Исправление: ${title}`, type: 'code' },
        { phase: 'verify', skills: ['testing', 'qa'], title: `Проверка: ${title}`, type: 'test' },
      ]
    },
    {
      match: ['security', 'audit', 'vulnerability', 'безопасность'],
      tasks: [
        { phase: 'scan', skills: ['security', 'audit'], title: `Security scan: ${title}`, type: 'audit' },
        { phase: 'fix', skills: ['devops', 'backend'], title: `Fix vulnerabilities: ${title}`, type: 'code' },
        { phase: 'verify', skills: ['security', 'testing'], title: `Verify fixes: ${title}`, type: 'test' },
      ]
    },
    {
      match: ['report', 'analytics', 'analysis', 'отчёт', 'аналитика'],
      tasks: [
        { phase: 'collect', skills: ['data', 'analytics'], title: `Сбор данных: ${title}`, type: 'data' },
        { phase: 'analyze', skills: ['analytics', 'simulation'], title: `Анализ: ${title}`, type: 'analysis' },
        { phase: 'visualize', skills: ['frontend', 'design'], title: `Визуализация: ${title}`, type: 'design' },
      ]
    },
    {
      match: ['deploy', 'release', 'деплой'],
      tasks: [
        { phase: 'test', skills: ['testing', 'qa'], title: `Pre-deploy tests: ${title}`, type: 'test' },
        { phase: 'deploy', skills: ['devops', 'deploy'], title: `Deploy: ${title}`, type: 'deploy' },
        { phase: 'verify', skills: ['monitoring', 'security'], title: `Post-deploy verify: ${title}`, type: 'verify' },
      ]
    },
  ];

  // Find matching pattern
  for (const pattern of patterns) {
    if (pattern.match.some(m => text.includes(m))) {
      for (const task of pattern.tasks) {
        const { agent } = findBestAgent(task.skills);
        subtasks.push({
          ...task,
          agent: agent || 'forge',
          priority: 'medium',
          dependsOn: task.phase === pattern.tasks[0].phase ? [] : [pattern.tasks[pattern.tasks.indexOf(task) - 1]?.phase],
        });
      }
      break;
    }
  }

  // Fallback: single task to forge
  if (subtasks.length === 0) {
    subtasks.push({
      phase: 'execute',
      skills: ['coding'],
      title,
      type: 'task',
      agent: 'forge',
      priority: 'medium',
      dependsOn: [],
    });
  }

  return subtasks;
}

/**
 * Send A2A message (persisted to Convex)
 */
export async function sendA2AMessage(from, to, type, payload) {
  const message = {
    from,
    to,
    type, // request, response, event, broadcast
    payload, // { title, description, taskId, result, ... }
    timestamp: new Date().toISOString(),
    status: 'pending',
  };

  // Store in Convex as a task with special type
  try {
    await fetch(`${CONVEX_SITE}/agent/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `[A2A ${from}→${to}] ${payload.title || type}`,
        description: JSON.stringify(payload),
        status: 'todo',
        priority: payload.priority || 'medium',
        type: `a2a-${type}`,
        agent: to,
        externalId: `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        tags: ['a2a', from, to, type],
      }),
      signal: AbortSignal.timeout(4000),
    });
    return { ok: true, message };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Execute a decomposed goal — create all subtasks in Convex, respecting dependencies
 */
export async function executeGoal(title, description = '', requestedBy = 'urmat') {
  const subtasks = decomposeGoal(title, description);
  const results = [];

  for (const subtask of subtasks) {
    try {
      const res = await fetch(`${CONVEX_SITE}/agent/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: subtask.title,
          description: `Goal: ${title}\nPhase: ${subtask.phase}\nDependencies: ${subtask.dependsOn?.join(', ') || 'none'}`,
          status: 'todo',
          priority: subtask.priority,
          type: subtask.type,
          agent: subtask.agent,
          externalId: `goal-${Date.now()}-${subtask.phase}`,
          tags: ['goal-decomposed', subtask.phase, requestedBy],
        }),
        signal: AbortSignal.timeout(4000),
      });
      results.push({ ...subtask, created: res.ok });
    } catch {
      results.push({ ...subtask, created: false });
    }
  }

  return { goal: title, subtasks: results, count: results.length, success: results.filter(r => r.created).length };
}
