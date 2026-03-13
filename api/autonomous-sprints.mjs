/**
 * Autonomous Sprints — Self-Improving Agent Cycles
 * 
 * Weekly sprints where each agent:
 * 1. Reviews its own code (last 7 days commits)
 * 2. Identifies untested functions
 * 3. Updates documentation (MEMORY.md)
 * 4. Creates health check report
 * 5. Generates self-improvement tasks
 * 
 * Schedule:
 * - Every Monday 08:00 UTC+6 via cron
 * - Tasks auto-dispatch to priority queue
 * - Results saved to Reme memory
 * 
 * Agents: all 9 (forge, atlas, iron, mesa, pixel, dana, nurlan, bekzat, ainura, marat)
 */

// Sprint templates per agent
const SPRINT_TEMPLATES = {
  forge: {
    focus: ['api', 'infrastructure', 'monitoring'],
    repos: ['ASYSTEM/api', 'ASYSTEM/panel'],
    health_checks: ['disk', 'memory', 'pm2_processes', 'tailscale'],
  },
  atlas: {
    focus: ['orchestration', 'architecture', 'decision_logs'],
    repos: ['ASYSTEM'],
    health_checks: ['vm_status', 'ssh_connectivity', 'task_dispatch'],
  },
  iron: {
    focus: ['security', 'firewall', 'monitoring'],
    repos: ['ASYSTEM/infra'],
    health_checks: ['vps_health', 'intrusion_detection', 'certificates'],
  },
  mesa: {
    focus: ['analytics', 'metrics', 'reporting'],
    repos: ['ASYSTEM/analytics'],
    health_checks: ['data_pipeline', 'memory', 'simulation_status'],
  },
  pixel: {
    focus: ['design', 'ui', 'ux'],
    repos: ['ASYSTEM/panel'],
    health_checks: ['design_assets', 'figma_sync'],
  },
  dana: {
    focus: ['project_management', 'roadmap', 'sprints'],
    repos: [],
    health_checks: ['kanban_board', 'milestone_tracking'],
  },
  nurlan: {
    focus: ['devops', 'ci_cd', 'infrastructure'],
    repos: ['ASYSTEM/infra'],
    health_checks: ['proxmox', 'lxc_containers', 'pipelines'],
  },
  bekzat: {
    focus: ['backend', 'database', 'api'],
    repos: ['ORGONASYSTEM'],
    health_checks: ['postgres', 'connection_pool', 'api_latency'],
  },
  ainura: {
    focus: ['frontend', 'react', 'ux'],
    repos: ['ORGONASYSTEM/frontend', 'ASYSTEM/panel'],
    health_checks: ['bundle_size', 'lighthouse_score'],
  },
  marat: {
    focus: ['qa', 'testing', 'quality'],
    repos: ['ORGONASYSTEM'],
    health_checks: ['test_coverage', 'ci_failures'],
  },
};

/**
 * Generate sprint tasks for an agent
 */
export async function generateSprintTasks(agent) {
  const template = SPRINT_TEMPLATES[agent];
  if (!template) return { error: `Unknown agent: ${agent}` };

  const tasks = [];
  const now = new Date();
  const weekNum = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000 / 7);

  // Task 1: Code Review
  if (template.repos.length > 0) {
    tasks.push({
      title: `📝 Code Review ${agent} — Week ${weekNum}`,
      body: `Review git commits from last 7 days for:
${template.repos.map(r => `- ${r}`).join('\n')}

Check:
- Code style consistency
- Type safety
- Test coverage
- Documentation completeness`,
      priority: 'high',
      sla_minutes: 240,        // 4 hours
      category: 'code-review',
      agent_created: true,
    });
  }

  // Task 2: Test Coverage
  tasks.push({
    title: `🧪 Coverage Report ${agent} — Week ${weekNum}`,
    body: `Review test coverage:
1. Identify functions added last week without tests
2. Write unit tests for untested code
3. Target: >80% coverage increase`,
    priority: 'medium',
    sla_minutes: 480,          // 8 hours
    category: 'testing',
    agent_created: true,
  });

  // Task 3: Memory Update
  tasks.push({
    title: `🧠 Update MEMORY.md — ${agent}`,
    body: `Review and consolidate learnings:
1. Review this week's decisions
2. Document new patterns discovered
3. Update MEMORY.md with key insights
4. Archive old deprecated entries`,
    priority: 'medium',
    sla_minutes: 120,          // 2 hours
    category: 'documentation',
    agent_created: true,
  });

  // Task 4: Health Check
  tasks.push({
    title: `🏥 Health Check ${agent}`,
    body: `Run diagnostics on:
${template.health_checks.map(h => `- ${h}`).join('\n')}

Report any anomalies or degradation.
Alert if any threshold exceeded.`,
    priority: 'low',
    sla_minutes: 60,           // 1 hour
    category: 'monitoring',
    agent_created: true,
  });

  // Task 5: Self-Improvement Proposal
  tasks.push({
    title: `🎯 Self-Improvement Proposal — ${agent}`,
    body: `Analyze last week:
1. What went smoothly?
2. What was blocking?
3. Propose 1 optimization for next sprint
4. Estimate effort

Example: "Reduce API latency by 20% using connection pooling"`,
    priority: 'low',
    sla_minutes: 180,          // 3 hours
    category: 'meta',
    agent_created: true,
  });

  return {
    ok: true,
    agent,
    week: weekNum,
    sprint_start: new Date(now.setDate(now.getDate() - now.getDay() + 1)),
    tasks: tasks.map((t, idx) => ({
      ...t,
      id: `sprint-${agent}-w${weekNum}-${idx}`,
      created_at: new Date().toISOString(),
      assigned_to: agent,
    })),
  };
}

/**
 * Create sprint for specific agent and push to Convex
 */
export async function createAgentSprint(agent) {
  const sprint = await generateSprintTasks(agent);
  if (sprint.error) return sprint;

  // Push tasks to Convex
  const results = [];
  for (const task of sprint.tasks) {
    try {
      const res = await fetch('https://expert-dachshund-299.convex.cloud/api/mutation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: 'tasks:create',
          args: {
            title: task.title,
            body: task.body,
            priority: task.priority,
            sla_minutes: task.sla_minutes,
            assigned_to: task.assigned_to,
            tags: ['autonomous-sprint', `agent:${agent}`, task.category],
          },
        }),
      }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));

      results.push({
        task: task.title,
        ok: !!res.ok,
        id: res.id,
      });
    } catch (e) {
      results.push({
        task: task.title,
        ok: false,
        error: e.message,
      });
    }
  }

  return {
    ok: true,
    agent,
    tasks_created: results.filter(r => r.ok).length,
    tasks_failed: results.filter(r => !r.ok).length,
    details: results,
  };
}

/**
 * Weekly sprint kickoff (all agents)
 * Called every Monday 08:00
 */
export async function weeklySprintKickoff() {
  const agents = Object.keys(SPRINT_TEMPLATES);
  const results = [];

  for (const agent of agents) {
    const result = await createAgentSprint(agent);
    results.push({
      agent,
      ok: result.ok,
      tasks: result.tasks_created || 0,
    });
  }

  const summary = {
    timestamp: new Date().toISOString(),
    agents_processed: agents.length,
    total_tasks: results.reduce((sum, r) => sum + (r.tasks || 0), 0),
    success_count: results.filter(r => r.ok).length,
    details: results,
  };

  // Log to Reme
  await fetch('http://100.87.107.50:18790/api/memory/reme', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: `📋 Weekly Sprint Kickoff: ${summary.total_tasks} tasks created for ${summary.agents_processed} agents`,
      metadata: {
        category: 'sprint',
        agent: 'system',
        tags: ['autonomous', 'sprint-kickoff'],
      },
    }),
  }).catch(() => null);

  return summary;
}

/**
 * Get sprint status & upcoming sprints
 */
export async function getSprintStatus() {
  const now = new Date();
  const dayOfWeek = now.getDay();  // 0=Sunday, 1=Monday...
  
  // Next sprint: next Monday 08:00
  let nextSprint = new Date(now);
  if (dayOfWeek === 1) {
    // Today is Monday
    nextSprint.setDate(nextSprint.getDate() + 7);
  } else {
    nextSprint.setDate(nextSprint.getDate() + (8 - dayOfWeek));
  }
  nextSprint.setHours(8, 0, 0, 0);

  return {
    current_time: now.toISOString(),
    next_sprint: nextSprint.toISOString(),
    hours_until_sprint: Math.round((nextSprint - now) / 3600000),
    agents: Object.keys(SPRINT_TEMPLATES),
    tasks_per_agent: 5, // code review, tests, memory, health, meta
  };
}

/**
 * Manual sprint trigger (for testing)
 */
export async function triggerSprintNow() {
  return await weeklySprintKickoff();
}

export default {
  generateSprintTasks,
  createAgentSprint,
  weeklySprintKickoff,
  getSprintStatus,
  triggerSprintNow,
  SPRINT_TEMPLATES,
};
