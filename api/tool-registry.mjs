/**
 * tool-registry.mjs — Dynamic Tool Registry for Agents
 *
 * Pattern: Agents discover and register new tools at runtime
 *   Source: Self-extending AI agents (ToolLLM v2, Voyager 3 patterns)
 *
 * Tools = reusable action templates that agents can invoke
 * Each tool: { name, description, endpoint, method, schema, owner, tags }
 * Agents can register new tools via POST /api/tools/register
 * Agents search tools via GET /api/tools?q=keyword
 *
 * Built-in tools (pre-registered):
 *   http-get         → fetch any URL (GET)
 *   http-post        → POST to any endpoint
 *   shell-cmd        → run a shell command (requires 'approved' tag)
 *   git-commit       → git add+commit+push (owner: bekzat/nurlan)
 *   db-query         → PostgreSQL query (owner: bekzat, infra-only)
 *   send-telegram    → send Telegram message via Forge API
 *   convex-write     → write to Convex DB
 *   forge-dispatch   → dispatch task to another agent
 *   zvec-search      → search ZVec memory
 *   run-eval         → trigger eval runner
 *
 * Tool discovery flow:
 *   1. Agent has a task requiring external action
 *   2. GET /api/tools?q=<intent keyword> → list matching tools
 *   3. If no match → agent can register new tool via POST /api/tools/register
 *   4. Tool stored in registry → other agents can discover it
 *
 * API:
 *   GET  /api/tools          — list all tools (optional ?q=keyword)
 *   GET  /api/tools/:name    — get tool details
 *   POST /api/tools/register — register new tool
 *   POST /api/tools/invoke   — invoke a tool (with params)
 *   GET  /api/tools/stats    — invocation stats
 */

import { createHash } from 'node:crypto';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME        = os.homedir();
const REGISTRY    = path.join(HOME, '.openclaw/workspace/.tool-registry.json');
const INVOKE_LOG  = path.join(HOME, '.openclaw/workspace/tool-invocations.jsonl');

// ── Built-in tools ────────────────────────────────────────────────────────────
const BUILT_IN_TOOLS = {
  'forge-dispatch': {
    name: 'forge-dispatch', description: 'Dispatch task to an ASYSTEM agent',
    endpoint: 'http://localhost:5190/api/dispatch', method: 'POST',
    schema: { to: 'string (agent name)', title: 'string', body: 'string', priority: 'string' },
    owner: 'forge', tags: ['core', 'dispatch'], invocations: 0,
  },
  'convex-write': {
    name: 'convex-write', description: 'Write data to Convex database',
    endpoint: 'https://expert-dachshund-299.convex.cloud/api/mutation', method: 'POST',
    schema: { path: 'string (mutation path)', args: 'object' },
    owner: 'forge', tags: ['core', 'db'], invocations: 0,
  },
  'zvec-search': {
    name: 'zvec-search', description: 'Search ZVec vector memory (semantic)',
    endpoint: 'http://localhost:5190/api/memory/reme', method: 'GET',
    schema: { q: 'string (search query)', top: 'number (results)', memory_type: 'string (optional)' },
    owner: 'forge', tags: ['core', 'memory'], invocations: 0,
  },
  'send-telegram': {
    name: 'send-telegram', description: 'Send Telegram message via Forge API',
    endpoint: 'http://localhost:5190/api/notify', method: 'POST',
    schema: { message: 'string', priority: 'string' },
    owner: 'forge', tags: ['core', 'notify'], invocations: 0,
  },
  'git-commit': {
    name: 'git-commit', description: 'Git add, commit, and push changes',
    endpoint: 'http://localhost:5190/api/git/workflow', method: 'POST',
    schema: { path: 'string (repo path)', message: 'string', branch: 'string' },
    owner: 'bekzat', tags: ['git', 'deploy', 'approved'], invocations: 0,
  },
  'run-playbook': {
    name: 'run-playbook', description: 'Run a workflow playbook (multi-step)',
    endpoint: 'http://localhost:5190/api/playbook/run', method: 'POST',
    schema: { name: 'string (playbook name)', params: 'object' },
    owner: 'dana', tags: ['workflow', 'orchestration'], invocations: 0,
  },
  'run-dag': {
    name: 'run-dag', description: 'Run a DAG workflow pipeline',
    endpoint: 'http://localhost:5190/api/dag/run', method: 'POST',
    schema: { name: 'string (dag name)', params: 'object' },
    owner: 'dana', tags: ['workflow', 'dag'], invocations: 0,
  },
  'debate-start': {
    name: 'debate-start', description: 'Start multi-agent debate for complex decisions',
    endpoint: 'http://localhost:5190/api/debate/start', method: 'POST',
    schema: { question: 'string', context: 'string', maxRounds: 'number' },
    owner: 'forge', tags: ['reasoning', 'consensus'], invocations: 0,
  },
  'http-get': {
    name: 'http-get', description: 'Fetch any URL via GET request',
    endpoint: 'http://localhost:5190/api/tools/invoke', method: 'POST',
    schema: { url: 'string', headers: 'object (optional)' },
    owner: 'forge', tags: ['http', 'external'], invocations: 0,
  },
  'run-eval': {
    name: 'run-eval', description: 'Trigger evaluation runner for quality check',
    endpoint: 'http://localhost:5190/api/eval/', method: 'POST',
    schema: { evalId: 'string (optional, runs all if omitted)' },
    owner: 'marat', tags: ['eval', 'quality'], invocations: 0,
  },
};

// ── Load/save ─────────────────────────────────────────────────────────────────
function load() {
  try { return { ...BUILT_IN_TOOLS, ...JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) }; }
  catch { return { ...BUILT_IN_TOOLS }; }
}
function save(r) { try { fs.writeFileSync(REGISTRY, JSON.stringify(r, null, 2)); } catch {} }

// ── Search tools ──────────────────────────────────────────────────────────────
export function searchTools(query = '') {
  const tools = load();
  if (!query) return Object.values(tools);
  const q = query.toLowerCase();
  return Object.values(tools).filter(t =>
    t.name.includes(q) || t.description.toLowerCase().includes(q) ||
    (t.tags || []).some(tag => tag.includes(q))
  );
}

// ── Register a new tool ───────────────────────────────────────────────────────
export function registerTool({ name, description, endpoint, method = 'POST', schema = {}, owner, tags = [] }) {
  if (!name || !endpoint) throw new Error('name and endpoint required');
  const tools = load();
  const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  tools[id] = { name: id, description, endpoint, method, schema, owner, tags, registeredAt: Date.now(), invocations: 0 };
  save(tools);
  console.log(`[ToolRegistry] ✅ Registered: ${id} (${method} ${endpoint})`);
  return tools[id];
}

// ── Invoke a tool ─────────────────────────────────────────────────────────────
export async function invokeTool(toolName, params = {}, invokerAgent = 'unknown') {
  const tools = load();
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool not found: ${toolName}`);

  console.log(`[ToolRegistry] 🔧 ${invokerAgent} invoking ${toolName}`);
  const start = Date.now();

  try {
    let result;
    if (toolName === 'http-get' && params.url) {
      // Special: actual HTTP GET
      const res = await fetch(params.url, { headers: params.headers || {}, signal: AbortSignal.timeout(8000) });
      result = { status: res.status, body: (await res.text()).slice(0, 2000) };
    } else {
      // POST to tool endpoint
      const res = await fetch(tool.endpoint, {
        method: tool.method || 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(8000),
      });
      result = await res.json();
    }

    tool.invocations = (tool.invocations || 0) + 1;
    save(tools);
    const entry = { ts: Date.now(), tool: toolName, invoker: invokerAgent, params: JSON.stringify(params).slice(0, 100), ok: true, ms: Date.now() - start };
    fs.appendFileSync(INVOKE_LOG, JSON.stringify(entry) + '\n');
    return { ok: true, result, ms: Date.now() - start };
  } catch (e) {
    const entry = { ts: Date.now(), tool: toolName, invoker: invokerAgent, ok: false, error: e.message, ms: Date.now() - start };
    fs.appendFileSync(INVOKE_LOG, JSON.stringify(entry) + '\n');
    return { ok: false, error: e.message, ms: Date.now() - start };
  }
}

export function getTool(name) { return load()[name] || null; }

export function getToolStats() {
  const tools = load();
  try {
    const lines = fs.readFileSync(INVOKE_LOG, 'utf8').trim().split('\n').filter(Boolean);
    const total = lines.length;
    const ok = lines.filter(l => { try { return JSON.parse(l).ok; } catch { return false; } }).length;
    return { totalTools: Object.keys(tools).length, totalInvocations: total, successRate: total ? Math.round((ok / total) * 100) + '%' : 'n/a', topTools: Object.values(tools).sort((a, b) => (b.invocations || 0) - (a.invocations || 0)).slice(0, 5).map(t => ({ name: t.name, invocations: t.invocations || 0 })) };
  } catch { return { totalTools: Object.keys(tools).length, totalInvocations: 0 }; }
}
