/**
 * contract-validator.mjs — Contract-First Development (Factory AI / Droid Pattern)
 *
 * Video: "Build & Deploy AI Apps for FREE with Vercel (2026 Guide)" (BN5vhVHECuY)
 * Inspired by: Factory AI "Droid" Missions pattern (P3c5UnTuISc — already analyzed)
 *
 * Pattern: Before implementing anything, generate a VALIDATION CONTRACT:
 *   A set of assertions about what the implementation MUST satisfy.
 *   Like TDD but for AI agent outputs.
 *
 * Contract types:
 *   API_CONTRACT:    endpoint, method, request/response shape, status codes
 *   FUNCTION_CONTRACT: name, inputs, outputs, side effects, error cases
 *   SCHEMA_CONTRACT:  table/model name, required fields, types, constraints
 *   SERVICE_CONTRACT: service name, dependencies, SLA, retry behavior
 *   UI_CONTRACT:     component name, props, events, accessibility, responsive
 *
 * Lifecycle:
 *   1. DEFINE: human/planner gives spec → agent generates contract JSON
 *   2. VALIDATE: implementation result checked against contract assertions
 *   3. REPORT: pass/fail per assertion, blocking vs non-blocking
 *   4. ENFORCE: task cannot be marked done if blocking assertions fail
 *
 * API:
 *   POST /api/contract/generate { taskTitle, spec, agentId } → contract
 *   POST /api/contract/validate { contractId, result } → validation report
 *   GET  /api/contract/:contractId → get contract
 *   GET  /api/contract/list/:agentId → all contracts for agent
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME          = os.homedir();
const CONTRACT_DIR  = path.join(HOME, '.openclaw/workspace/.contracts');
const CONTRACT_LOG  = path.join(HOME, '.openclaw/workspace/contract-log.jsonl');
if (!fs.existsSync(CONTRACT_DIR)) fs.mkdirSync(CONTRACT_DIR, { recursive: true });

// ── Contract assertion generators by task type ─────────────────────────────────
const CONTRACT_GENERATORS = {
  api: (spec) => ({
    type: 'API_CONTRACT',
    assertions: [
      { id: 'a1', desc: 'Endpoint defined (route path present)', blocking: true,  check: (r) => /\/[a-z\/:-]+/.test(r) },
      { id: 'a2', desc: 'HTTP method specified',                 blocking: true,  check: (r) => /GET|POST|PUT|PATCH|DELETE/i.test(r) },
      { id: 'a3', desc: 'Response shape defined',               blocking: true,  check: (r) => /response|return|json|body|\{/.test(r.toLowerCase()) },
      { id: 'a4', desc: 'Error handling present',               blocking: true,  check: (r) => /error|catch|exception|400|404|500/i.test(r) },
      { id: 'a5', desc: 'Auth/authorization mentioned',         blocking: false, check: (r) => /auth|token|jwt|bearer|apikey/i.test(r) },
      { id: 'a6', desc: 'Input validation present',             blocking: false, check: (r) => /valid|sanitiz|schema|zod|joi|required/i.test(r) },
    ],
  }),

  function: (spec) => ({
    type: 'FUNCTION_CONTRACT',
    assertions: [
      { id: 'f1', desc: 'Function name defined',       blocking: true,  check: (r) => /function |const \w+ = |async \w+|def \w+/.test(r) },
      { id: 'f2', desc: 'Parameters specified',        blocking: true,  check: (r) => /\(.*\)|params|args/.test(r) },
      { id: 'f3', desc: 'Return value defined',        blocking: true,  check: (r) => /return |→|->/.test(r) },
      { id: 'f4', desc: 'Error case handled',          blocking: true,  check: (r) => /throw|catch|error|null|undefined/i.test(r) },
      { id: 'f5', desc: 'Edge case considered',        blocking: false, check: (r) => /empty|null|undefined|edge|bound|limit/i.test(r) },
      { id: 'f6', desc: 'TypeScript types present',   blocking: false, check: (r) => /: string|: number|: boolean|: void|interface |type \w+/.test(r) },
    ],
  }),

  schema: (spec) => ({
    type: 'SCHEMA_CONTRACT',
    assertions: [
      { id: 's1', desc: 'Table/model name defined',    blocking: true,  check: (r) => /table|model|schema|collection|CREATE TABLE/i.test(r) },
      { id: 's2', desc: 'Primary key defined',         blocking: true,  check: (r) => /id|primary key|_id|uuid/i.test(r) },
      { id: 's3', desc: 'Required fields specified',   blocking: true,  check: (r) => /required|NOT NULL|!\.optional/i.test(r) },
      { id: 's4', desc: 'Field types defined',         blocking: true,  check: (r) => /string|integer|text|varchar|boolean|timestamp|number/i.test(r) },
      { id: 's5', desc: 'Indexes/performance noted',  blocking: false, check: (r) => /index|unique|constraint/i.test(r) },
      { id: 's6', desc: 'Created/updated timestamps', blocking: false, check: (r) => /created_at|updated_at|timestamp|createdAt/i.test(r) },
    ],
  }),

  service: (spec) => ({
    type: 'SERVICE_CONTRACT',
    assertions: [
      { id: 'sv1', desc: 'Service name defined',       blocking: true,  check: (r) => r.trim().length > 20 },
      { id: 'sv2', desc: 'Dependencies listed',        blocking: false, check: (r) => /depend|require|import|use/i.test(r) },
      { id: 'sv3', desc: 'Error handling strategy',   blocking: true,  check: (r) => /error|retry|fallback|circuit/i.test(r) },
      { id: 'sv4', desc: 'Logging/observability',     blocking: false, check: (r) => /log|trace|metric|monitor|console/i.test(r) },
      { id: 'sv5', desc: 'Configuration documented',  blocking: false, check: (r) => /config|env|variable|setting/i.test(r) },
    ],
  }),

  generic: (spec) => ({
    type: 'GENERIC_CONTRACT',
    assertions: [
      { id: 'g1', desc: 'Non-empty result',             blocking: true,  check: (r) => r.trim().length > 50 },
      { id: 'g2', desc: 'No placeholder content',       blocking: true,  check: (r) => !/(TODO|FIXME|placeholder)/i.test(r) },
      { id: 'g3', desc: 'Addresses task keywords',      blocking: true,  check: (r, kw) => kw.some(k => r.toLowerCase().includes(k)) },
      { id: 'g4', desc: 'Structured (multi-line)',      blocking: false, check: (r) => r.split('\n').length >= 3 },
      { id: 'g5', desc: 'No apology/refusal patterns', blocking: false, check: (r) => !/(I cannot|I am unable|I apologize)/i.test(r) },
    ],
  }),
};

// ── Detect contract type from task title ──────────────────────────────────────
function detectContractType(title = '') {
  const low = title.toLowerCase();
  if (/api|endpoint|route|rest|graphql/.test(low))              return 'api';
  if (/function|method|helper|util|hook/.test(low))             return 'function';
  if (/schema|model|table|database|migration/.test(low))        return 'schema';
  if (/service|worker|handler|processor/.test(low))             return 'service';
  return 'generic';
}

// ── Generate contract ──────────────────────────────────────────────────────────
export function generateContract({ taskTitle, spec = '', agentId }) {
  const contractType = detectContractType(taskTitle);
  const generator    = CONTRACT_GENERATORS[contractType] || CONTRACT_GENERATORS.generic;
  const template     = generator(spec);
  const contractId   = `ctr_${Date.now()}`;
  const keywords     = taskTitle.toLowerCase().split(/\W+/).filter(w => w.length > 4);

  const contract = {
    contractId, agentId, taskTitle: taskTitle?.slice(0, 80), spec: spec?.slice(0, 200),
    contractType: template.type, assertions: template.assertions.map(a => ({ ...a, check: undefined, keywords })),
    _checkFns: template.assertions.map(a => a.check),
    createdAt: Date.now(), validated: false,
  };

  saveContract(contractId, contract);
  fs.appendFileSync(CONTRACT_LOG, JSON.stringify({ ts: Date.now(), action: 'generate', contractId, agentId, contractType: template.type, taskTitle: taskTitle?.slice(0, 50) }) + '\n');
  console.log(`[Contract] 📋 Generated ${template.type} for "${taskTitle?.slice(0, 40)}" (${template.assertions.length} assertions)`);

  // Return without internal _checkFns
  const { _checkFns: _, ...returnContract } = contract;
  return { ok: true, contractId, contract: returnContract };
}

// ── Validate result against contract ──────────────────────────────────────────
export function validateContract({ contractId, result }) {
  const contract = loadContract(contractId);
  if (!contract) return { ok: false, reason: 'Contract not found', contractId };

  const checkFns = contract._checkFns || [];
  const keywords  = contract.assertions[0]?.keywords || [];
  const results   = contract.assertions.map((assertion, i) => {
    const checkFn = checkFns[i];
    const passed  = checkFn ? checkFn(result, keywords) : true;
    return { ...assertion, passed, check: undefined };
  });

  const blockingFailed   = results.filter(r => r.blocking && !r.passed);
  const nonBlockingFailed = results.filter(r => !r.blocking && !r.passed);
  const passed           = results.filter(r => r.passed).length;
  const isBlocked        = blockingFailed.length > 0;

  contract.validated = true;
  contract.validatedAt = Date.now();
  contract.lastResult = { passed, total: results.length, blockingFailed: blockingFailed.length, isBlocked };
  saveContract(contractId, contract);

  fs.appendFileSync(CONTRACT_LOG, JSON.stringify({ ts: Date.now(), action: 'validate', contractId, passed, total: results.length, isBlocked }) + '\n');
  console.log(`[Contract] ${isBlocked ? '🚫 BLOCKED' : '✅ PASSED'}: ${passed}/${results.length} assertions | blocking-failed: ${blockingFailed.length}`);

  return {
    ok: true, contractId, passed, total: results.length,
    isBlocked, blockingFailed: blockingFailed.map(r => ({ id: r.id, desc: r.desc })),
    nonBlockingFailed: nonBlockingFailed.map(r => ({ id: r.id, desc: r.desc })),
    canProceed: !isBlocked,
    report: results.map(r => ({ id: r.id, desc: r.desc, passed: r.passed, blocking: r.blocking })),
  };
}

export function getContract(contractId) { const c = loadContract(contractId); if (!c) return null; const { _checkFns: _, ...clean } = c; return clean; }
export function listContracts(agentId, limit = 10) {
  try {
    return fs.readdirSync(CONTRACT_DIR).filter(f => f.endsWith('.json')).map(f => { try { const c = JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, f), 'utf8')); return { contractId: c.contractId, agentId: c.agentId, taskTitle: c.taskTitle, validated: c.validated, isBlocked: c.lastResult?.isBlocked }; } catch { return null; } }).filter(c => c && (!agentId || c.agentId === agentId)).slice(-limit).reverse();
  } catch { return []; }
}

// ── IO ─────────────────────────────────────────────────────────────────────────
function contractPath(id) { return path.join(CONTRACT_DIR, `${id}.json`); }
function loadContract(id) { try { return JSON.parse(fs.readFileSync(contractPath(id), 'utf8')); } catch { return null; } }
function saveContract(id, d) { try { fs.writeFileSync(contractPath(id), JSON.stringify(d, null, 2)); } catch {} }
