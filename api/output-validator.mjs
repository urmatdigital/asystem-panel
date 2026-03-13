/**
 * output-validator.mjs — Agent Output Validation Contracts
 *
 * Video: "Factory AI Validation Contracts" (P3c5UnTuISc)
 * Pattern: Every agent result passes through a contract assertion
 *   before being written to Convex or returned to caller
 *
 * Contracts define:
 *   - minLength: result must be at least N chars
 *   - mustContain: result must include certain keywords
 *   - forbidden: result must NOT contain these patterns (hallucination guard)
 *   - schema: result must parse as valid JSON matching schema
 *   - custom: arbitrary JS function returning { pass, reason }
 *
 * Agent-specific contracts (loaded from agent-manifests/ or hardcoded):
 *   bekzat  → code result: must contain function/class/def/async/export
 *   ainura  → UI result: must contain component/return/render/jsx
 *   marat   → test result: must contain test/describe/it/expect/assert
 *   nurlan  → devops result: must contain config/deploy/service/docker/nginx
 *   dana    → plan result: must contain sprint/task/milestone/deadline
 *   mesa    → analytics result: must contain data/metric/result/analysis
 *   iron    → security result: must contain secure/risk/vulnerability/fix
 *   forge   → general: minLength 50, no hallucination markers
 *
 * API:
 *   validateOutput(agentId, result) → { pass, score, violations, contractId }
 *   GET /api/contracts/violations — recent violations (last 24h)
 *   GET /api/contracts/stats      — pass rate per agent
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME      = os.homedir();
const VIOL_LOG  = path.join(HOME, '.openclaw/workspace/contract-violations.jsonl');

// ── Agent contracts ───────────────────────────────────────────────────────────
const AGENT_CONTRACTS = {
  bekzat: {
    id: 'bekzat.code',
    minLength: 30,
    mustContain: { any: ['function', 'class', 'def ', 'async ', 'export ', 'const ', 'import '] },
    forbidden: ['I cannot', 'I\'m unable', 'I don\'t know', 'As an AI', 'hallucin'],
    description: 'Backend code contract: must contain code constructs',
  },
  ainura: {
    id: 'ainura.ui',
    minLength: 30,
    mustContain: { any: ['component', 'return', 'render', 'jsx', 'tsx', 'html', '<div', 'style', 'useState', 'props'] },
    forbidden: ['I cannot', 'I\'m unable', 'As an AI'],
    description: 'Frontend/UI contract: must contain UI constructs',
  },
  marat: {
    id: 'marat.test',
    minLength: 20,
    mustContain: { any: ['test', 'describe', 'it(', 'expect', 'assert', 'mock', 'spec', 'jest', 'pytest'] },
    forbidden: ['I cannot', 'As an AI'],
    description: 'QA contract: must contain test constructs',
  },
  nurlan: {
    id: 'nurlan.devops',
    minLength: 20,
    mustContain: { any: ['config', 'deploy', 'service', 'docker', 'nginx', 'pm2', 'systemd', 'yaml', 'json'] },
    forbidden: ['I cannot', 'As an AI'],
    description: 'DevOps contract: must reference infra concepts',
  },
  dana: {
    id: 'dana.pm',
    minLength: 30,
    mustContain: { any: ['sprint', 'task', 'milestone', 'deadline', 'priority', 'plan', 'goal', 'roadmap'] },
    forbidden: ['I cannot', 'As an AI'],
    description: 'PM contract: must reference planning concepts',
  },
  mesa: {
    id: 'mesa.analytics',
    minLength: 30,
    mustContain: { any: ['data', 'metric', 'result', 'analysis', 'simulation', 'report', 'chart', 'percentage', '%'] },
    forbidden: ['I cannot', 'As an AI'],
    description: 'Analytics contract: must reference data concepts',
  },
  iron: {
    id: 'iron.security',
    minLength: 20,
    mustContain: { any: ['secure', 'risk', 'vulnerability', 'fix', 'network', 'tunnel', 'ssl', 'auth', 'cert'] },
    forbidden: ['I cannot', 'As an AI'],
    description: 'Security contract: must reference security concepts',
  },
  forge: {
    id: 'forge.general',
    minLength: 50,
    forbidden: ['I cannot', 'I\'m unable to', 'As an AI language model', 'I apologize but I'],
    description: 'General contract: substantive result required',
  },
};

// Default contract for unknown agents
const DEFAULT_CONTRACT = {
  id: 'default',
  minLength: 20,
  forbidden: ['I cannot', 'As an AI'],
};

// ── Validate result against contract ─────────────────────────────────────────
export function validateOutput(agentId, result) {
  const contract = AGENT_CONTRACTS[agentId] || DEFAULT_CONTRACT;
  const violations = [];
  let score = 100;

  // 1. Min length check
  if (contract.minLength && result.length < contract.minLength) {
    violations.push(`TOO_SHORT: ${result.length} < ${contract.minLength} chars`);
    score -= 30;
  }

  // 2. Must contain (any)
  if (contract.mustContain?.any) {
    const lc = result.toLowerCase();
    const found = contract.mustContain.any.some(kw => lc.includes(kw.toLowerCase()));
    if (!found) {
      violations.push(`MISSING_KEYWORDS: none of [${contract.mustContain.any.slice(0, 3).join(',')}...] found`);
      score -= 40;
    }
  }

  // 3. Forbidden patterns
  if (contract.forbidden) {
    const lc = result.toLowerCase();
    for (const pattern of contract.forbidden) {
      if (lc.includes(pattern.toLowerCase())) {
        violations.push(`FORBIDDEN: "${pattern}" found`);
        score -= 25;
        break; // one forbidden = enough
      }
    }
  }

  // 4. Hallucination guard (universal)
  const hallucinationMarkers = ['[INST]', '<|im_start|>', '###Human:', '###Assistant:'];
  for (const m of hallucinationMarkers) {
    if (result.includes(m)) {
      violations.push(`HALLUCINATION_MARKER: "${m}" found`);
      score -= 50;
    }
  }

  score = Math.max(0, score);
  const pass = violations.length === 0;

  if (!pass) {
    fs.appendFileSync(VIOL_LOG, JSON.stringify({
      ts: Date.now(), agentId, contractId: contract.id, violations, score,
      resultPreview: result.slice(0, 100),
    }) + '\n');
    console.log(`[OutputValidator] ❌ ${agentId} contract violation: ${violations.join(' | ')}`);
  }

  return { pass, score, violations, contractId: contract.id };
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getContractViolations(limit = 20) {
  try {
    const lines = fs.readFileSync(VIOL_LOG, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => JSON.parse(l)).reverse();
  } catch { return []; }
}

export function getContractStats() {
  try {
    const lines = fs.readFileSync(VIOL_LOG, 'utf8').trim().split('\n').filter(Boolean);
    const byAgent = {};
    for (const l of lines) {
      try {
        const v = JSON.parse(l);
        if (!byAgent[v.agentId]) byAgent[v.agentId] = { violations: 0, types: {} };
        byAgent[v.agentId].violations++;
        for (const viol of v.violations || []) {
          const type = viol.split(':')[0];
          byAgent[v.agentId].types[type] = (byAgent[v.agentId].types[type] || 0) + 1;
        }
      } catch {}
    }
    return { totalViolations: lines.length, byAgent, contracts: Object.keys(AGENT_CONTRACTS).length };
  } catch { return { totalViolations: 0, byAgent: {}, contracts: Object.keys(AGENT_CONTRACTS).length }; }
}
