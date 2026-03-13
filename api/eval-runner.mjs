#!/usr/bin/env node
/**
 * eval-runner.mjs — ASYSTEM EvalSet runner (Google ADK pattern)
 *
 * Runs predefined test cases from eval-suite.json against live ASYSTEM API.
 * Outputs pass/fail per case + overall regression score.
 *
 * Usage:
 *   node eval-runner.mjs [--suite path/to/eval-suite.json] [--json] [--ci]
 *   --json  : output JSON (for CI pipelines)
 *   --ci    : exit 1 if pass_rate < threshold
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HOME = os.homedir();

const args      = process.argv.slice(2);
const JSON_MODE = args.includes('--json');
const CI_MODE   = args.includes('--ci');
const suiteArg  = args.find(a => a.startsWith('--suite='))?.split('=')[1];
const SUITE_PATH = suiteArg || path.join(HOME, '.openclaw/workspace/eval-suite.json');

// Load panel token
const PANEL_TOKEN = (() => {
  try { return fs.readFileSync(path.join(HOME, '.openclaw/workspace/.panel-token'), 'utf8').trim(); } catch { return ''; }
})();

const suite = JSON.parse(fs.readFileSync(SUITE_PATH, 'utf8'));
const { thresholds } = suite;

// ── Memory search via reme_search_zvec.py ────────────────────────────────────
async function runMemorySearch({ q }) {
  const zvecPy = path.join(HOME, '.zvec-env/bin/python3');
  const script = path.join(HOME, 'projects/ASYSTEM/api/reme_search_zvec.py');
  const { stdout } = await execFileAsync(zvecPy, [script, '--query', q, '--top', '5'], {
    env: process.env, timeout: 15000,
  });
  return stdout;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function httpGet(url, headers = {}) {
  const authHeaders = { 'x-panel-token': PANEL_TOKEN, ...headers };
  // resolve __PANEL_TOKEN__ placeholders
  const resolvedHeaders = Object.fromEntries(
    Object.entries(authHeaders).map(([k, v]) => [k, v === '__PANEL_TOKEN__' ? PANEL_TOKEN : v])
  );
  const res = await fetch(url, { headers: resolvedHeaders });
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

async function httpPost(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-panel-token': PANEL_TOKEN, ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

// ── Check expected conditions ─────────────────────────────────────────────────
function checkExpected(actual, expected, caseType) {
  const failures = [];
  const text = typeof actual === 'string' ? actual : JSON.stringify(actual);

  if (expected.status && actual.status !== expected.status) {
    failures.push(`status ${actual.status} ≠ expected ${expected.status}`);
  }
  if (expected.contains) {
    for (const s of expected.contains) {
      if (!text.includes(s)) failures.push(`missing: "${s}"`);
    }
  }
  if (expected.contains_any) {
    const found = expected.contains_any.some(s => text.toLowerCase().includes(s.toLowerCase()));
    if (!found) failures.push(`none of [${expected.contains_any.join(', ')}] found`);
  }
  if (expected.min_results) {
    const lines = text.trim().split('\n').filter(l => l.trim().length > 10);
    if (lines.length < expected.min_results) failures.push(`got ${lines.length} results, expected ≥ ${expected.min_results}`);
  }
  if (expected.is_json && actual.json === null) {
    failures.push('response is not valid JSON');
  }
  if (expected.has_keys && actual.json) {
    for (const k of expected.has_keys) {
      if (!(k in actual.json)) failures.push(`missing key: "${k}"`);
    }
  }
  if (expected.blocked) {
    const isBlocked = actual.status !== 200 ||
      (expected.contains_any || []).some(s => text.toLowerCase().includes(s.toLowerCase()));
    if (!isBlocked) failures.push('expected request to be blocked, but it was accepted');
  }
  return failures;
}

// ── Run single case ───────────────────────────────────────────────────────────
async function runCase(c) {
  const start = Date.now();
  let actual = null;
  let error = null;

  try {
    if (c.type === 'memory_search') {
      actual = await runMemorySearch(c.input);
    } else if (c.type === 'http_get') {
      actual = await httpGet(c.input.url, c.input.headers || {});
    } else if (c.type === 'http_post') {
      actual = await httpPost(c.input.url, c.input.body, c.input.headers || {});
    } else {
      error = `Unknown case type: ${c.type}`;
    }
  } catch (e) {
    error = e.message;
  }

  const ms = Date.now() - start;
  if (error) return { id: c.id, name: c.name, pass: false, error, ms };

  const failures = checkExpected(actual, c.expected, c.type);
  return { id: c.id, name: c.name, pass: failures.length === 0, failures, ms };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!JSON_MODE) console.log(`\n🧪 ASYSTEM EvalSet — ${suite.cases.length} test cases\n${'─'.repeat(60)}`);

  const results = [];
  for (const c of suite.cases) {
    const result = await runCase(c);
    results.push(result);
    if (!JSON_MODE) {
      const icon = result.pass ? '✅' : '❌';
      const detail = result.pass ? '' : ` → ${(result.failures || [result.error]).join('; ')}`;
      console.log(`${icon} [${result.ms}ms] ${result.name}${detail}`);
    }
  }

  const passed = results.filter(r => r.pass).length;
  const total  = results.length;
  const passRate = passed / total;

  // Update eval-metrics.json with baseline
  const metricsPath = path.join(HOME, '.openclaw/workspace/eval-metrics.json');
  try {
    const m = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
    const day = new Date().toISOString().slice(0, 10);
    if (!m.evalSuite) m.evalSuite = {};
    m.evalSuite[day] = { passed, total, passRate: +(passRate * 100).toFixed(1), ts: Date.now() };
    // prune old (keep 30)
    const keys = Object.keys(m.evalSuite).sort();
    if (keys.length > 30) keys.slice(0, keys.length - 30).forEach(k => delete m.evalSuite[k]);
    fs.writeFileSync(metricsPath, JSON.stringify(m, null, 2));
  } catch {}

  const summary = { passed, total, passRate: +(passRate * 100).toFixed(1), results, ts: Date.now() };

  if (JSON_MODE) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const rateIcon = passRate >= thresholds.min_pass_rate ? '✅' : '⚠️';
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`${rateIcon} Result: ${passed}/${total} passed (${summary.passRate}%)`);
    if (passRate < thresholds.min_pass_rate) {
      console.log(`⚠️  REGRESSION: pass rate ${summary.passRate}% < threshold ${thresholds.min_pass_rate * 100}%`);
    }
  }

  if (CI_MODE && passRate < thresholds.min_pass_rate) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
