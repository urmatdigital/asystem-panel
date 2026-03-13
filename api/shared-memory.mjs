/**
 * Shared Memory — Inter-agent Knowledge Access
 * 
 * Architecture:
 * - Central Reme storage (Forge @ 100.87.107.50:18790)
 * - Convex broadcast for real-time sync
 * - Vector search across all agents' findings
 * - Distributed vector store (each agent can query)
 * 
 * API Layer:
 * GET /api/memory/shared — query all agents' memory
 * POST /api/memory/shared { content, tags, agent } — add to shared pool
 * GET /api/memory/agents/{agent} — memory from specific agent
 */

const REME_HOST = '100.87.107.50';
const REME_PORT = 18790;
const REME_BASE = `http://${REME_HOST}:${REME_PORT}`;

// Agents on the network
const AGENT_IPS = {
  forge: '100.87.107.50',
  atlas: '100.68.144.79',
  iron: '100.114.136.87',
  mesa: '100.100.40.27',
  pixel: '100.99.197.46',
  dana: '100.114.5.104',
  nurlan: '100.83.188.95',
  bekzat: '100.114.136.87', // LXC on Titan
  ainura: '100.112.184.63',
  marat: '100.107.171.121',
};

/**
 * Query shared memory (Forge's Reme server)
 * All agents read from this central store
 */
export async function querySharedMemory(query, options = {}) {
  const { top = 5, minScore = 0.3, tags = [] } = options;

  try {
    const url = new URL(`${REME_BASE}/api/memory/reme`);
    url.searchParams.set('q', query);
    url.searchParams.set('top', top);
    url.searchParams.set('minScore', minScore);
    if (tags.length > 0) url.searchParams.set('tags', tags.join(','));

    const res = await fetch(url.toString(), {
      timeout: 5000,
    }).then(r => r.json()).catch(() => ({ results: [] }));

    return {
      ok: true,
      query,
      results: (res.results || []).map(r => ({
        content: r.content,
        score: r.score,
        agent: r.metadata?.agent || 'unknown',
        timestamp: r.metadata?.timestamp,
        tags: r.metadata?.tags || [],
      })),
    };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      results: [],
    };
  }
}

/**
 * Add to shared memory
 * Called by any agent to contribute to collective knowledge
 */
export async function addToSharedMemory(content, agent, metadata = {}) {
  const { tags = [], category = 'insight' } = metadata;

  // Forward to Forge Reme server
  try {
    const res = await fetch(`${REME_BASE}/api/memory/reme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        metadata: {
          agent,
          timestamp: new Date().toISOString(),
          tags,
          category,
          ...metadata,
        },
      }),
      timeout: 5000,
    }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));

    // Broadcast to Convex for distributed sync
    if (res.ok) {
      await broadcastMemoryUpdate({
        action: 'add',
        agent,
        content,
        tags,
      }).catch(() => null); // Fire-and-forget
    }

    return {
      ok: res.ok,
      id: res.id,
      agent,
      added_at: new Date().toISOString(),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Get memory from specific agent
 */
export async function getAgentMemory(agent, query = '', limit = 10) {
  // First try direct query from Reme (Forge holds all)
  try {
    const res = await fetch(`${REME_BASE}/api/memory/reme?q=${encodeURIComponent(query || agent)}&top=${limit}&tags=${agent}`, {
      timeout: 5000,
    }).then(r => r.json()).catch(() => ({ results: [] }));

    return {
      ok: true,
      agent,
      count: res.results?.length || 0,
      results: (res.results || []).filter(r => r.metadata?.agent === agent),
    };
  } catch (e) {
    return { ok: false, error: e.message, results: [] };
  }
}

/**
 * Search across all agents at once
 */
export async function searchAllAgents(query, options = {}) {
  const { top = 5, minScore = 0.3, agentFilter = null } = options;

  // Query main Reme store
  const results = await querySharedMemory(query, { top: top * 2, minScore });

  // Filter by agent if specified
  if (agentFilter) {
    results.results = results.results.filter(r => r.agent === agentFilter);
  }

  // Group by agent
  const byAgent = {};
  for (const result of results.results) {
    if (!byAgent[result.agent]) byAgent[result.agent] = [];
    byAgent[result.agent].push(result);
  }

  return {
    ok: true,
    query,
    total: results.results.length,
    by_agent: byAgent,
    agents: Object.keys(byAgent),
  };
}

/**
 * Get memory stats (all agents)
 */
export async function getMemoryStats() {
  try {
    const res = await fetch(`${REME_BASE}/api/memory/reme-stats`, {
      timeout: 5000,
    }).then(r => r.json()).catch(() => ({}));

    return {
      ok: true,
      total_entries: res.total_entries || 0,
      by_agent: res.by_agent || {},
      last_updated: new Date().toISOString(),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Sync a single agent's local memory to shared store
 * Called when agent has new insights to share
 */
export async function syncAgentMemory(agent, localMemoryPath) {
  // This would read agent's local MEMORY.md and push diffs to Reme
  // Implementation depends on agent's file access
  return {
    ok: true,
    agent,
    synced: 0, // Number of new entries
    message: 'Sync initiated',
  };
}

/**
 * Broadcast to Convex for distributed notification
 */
async function broadcastMemoryUpdate(update) {
  try {
    await fetch('https://expert-dachshund-299.convex.cloud/api/mutation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'memory:broadcast',
        args: {
          update,
          timestamp: Date.now(),
        },
      }),
      timeout: 3000,
    });
  } catch (e) {
    // Fail silently — Convex is optional
  }
}

/**
 * Enable inter-agent communication example
 * When agent A finds something, share it to all others
 */
export async function shareInsight(agent, title, content, context = {}) {
  const tags = [
    agent,
    context.project || 'general',
    context.category || 'insight',
    ...( context.tags || []),
  ];

  return await addToSharedMemory(
    `**[${agent}] ${title}**\n\n${content}`,
    agent,
    {
      tags,
      category: context.category || 'insight',
      source: 'inter-agent-share',
      project: context.project,
    }
  );
}

export default {
  querySharedMemory,
  addToSharedMemory,
  getAgentMemory,
  searchAllAgents,
  getMemoryStats,
  syncAgentMemory,
  shareInsight,
  AGENT_IPS,
};
