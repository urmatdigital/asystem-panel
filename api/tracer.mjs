/**
 * tracer.mjs — Lightweight Distributed Tracing (OpenTelemetry-inspired)
 *
 * Video: "Braintrust TRACE 2026: Agent Observability at Scale with Replit" (lVnF6eu_3dc)
 * Pattern: Every agent action = Span. Spans form a Trace tree.
 *   Root span: dispatch call (traceId)
 *   Child spans: each pipeline layer (cache, security, cost, persona, llm, complete)
 *
 * Each span has: traceId, spanId, parentSpanId, name, agentId, status, durationMs, attrs
 *
 * Storage: ~/.openclaw/workspace/traces/YYYY-MM-DD.jsonl (one per day)
 * GET /api/traces?agent=...&limit=20 — recent traces
 * GET /api/traces/:traceId          — full trace with all spans
 * GET /api/traces/stats             — success rate, p50/p95 latency per agent
 */

import { createHash, randomBytes } from 'node:crypto';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME       = os.homedir();
const TRACES_DIR = path.join(HOME, '.openclaw/workspace/traces');
fs.mkdirSync(TRACES_DIR, { recursive: true });

// ── ID helpers ────────────────────────────────────────────────────────────────
function genTraceId() { return randomBytes(8).toString('hex'); }
function genSpanId()  { return randomBytes(4).toString('hex'); }

// ── In-memory active traces (root span + children) ────────────────────────────
const activeTraces = new Map(); // traceId → { root, spans[], startMs }

// ── Trace file path ───────────────────────────────────────────────────────────
function traceFile() {
  const d = new Date().toISOString().slice(0, 10);
  return path.join(TRACES_DIR, `${d}.jsonl`);
}

// ── Start a new root span (dispatch call) ─────────────────────────────────────
export function startTrace({ traceId, name, agentId, taskId, attrs = {} }) {
  const id = traceId || genTraceId();
  const spanId = genSpanId();
  const span = {
    traceId: id, spanId, parentSpanId: null,
    name, agentId, taskId,
    startMs: Date.now(), endMs: null, durationMs: null,
    status: 'running', error: null, attrs,
  };
  activeTraces.set(id, { root: span, spans: [span], startMs: Date.now() });
  return { traceId: id, spanId };
}

// ── Start a child span ────────────────────────────────────────────────────────
export function startSpan({ traceId, name, parentSpanId, attrs = {} }) {
  const trace = activeTraces.get(traceId);
  if (!trace) return { spanId: null };
  const spanId = genSpanId();
  const span = {
    traceId, spanId, parentSpanId: parentSpanId || trace.root.spanId,
    name, agentId: trace.root.agentId, taskId: trace.root.taskId,
    startMs: Date.now(), endMs: null, durationMs: null,
    status: 'running', error: null, attrs,
  };
  trace.spans.push(span);
  return { spanId };
}

// ── End a span ────────────────────────────────────────────────────────────────
export function endSpan({ traceId, spanId, status = 'ok', error = null, attrs = {} }) {
  const trace = activeTraces.get(traceId);
  if (!trace) return;
  const span = trace.spans.find(s => s.spanId === spanId);
  if (!span) return;
  span.endMs = Date.now();
  span.durationMs = span.endMs - span.startMs;
  span.status = status;
  span.error = error;
  Object.assign(span.attrs, attrs);
}

// ── Finish trace (all spans done) ─────────────────────────────────────────────
export function finishTrace({ traceId, status = 'ok', error = null }) {
  const trace = activeTraces.get(traceId);
  if (!trace) return;

  // Close root span
  const root = trace.root;
  root.endMs = Date.now();
  root.durationMs = root.endMs - root.startMs;
  root.status = status;
  root.error = error;

  // Close any unclosed child spans
  for (const span of trace.spans) {
    if (!span.endMs) { span.endMs = root.endMs; span.durationMs = span.endMs - span.startMs; span.status = status; }
  }

  // Persist
  const record = {
    traceId, agentId: root.agentId, taskId: root.taskId,
    name: root.name, status, durationMs: root.durationMs,
    ts: root.startMs, spans: trace.spans,
  };
  try { fs.appendFileSync(traceFile(), JSON.stringify(record) + '\n'); } catch {}
  activeTraces.delete(traceId);

  return record;
}

// ── Convenience: single-span trace for simple operations ─────────────────────
export async function withTrace(name, agentId, taskId, fn) {
  const { traceId, spanId } = startTrace({ name, agentId, taskId });
  try {
    const result = await fn(traceId);
    finishTrace({ traceId, status: 'ok' });
    return result;
  } catch (e) {
    finishTrace({ traceId, status: 'error', error: e.message });
    throw e;
  }
}

// ── Query traces from file ────────────────────────────────────────────────────
function readTraces(daysBack = 1, limit = 100) {
  const traces = [];
  for (let d = 0; d < daysBack; d++) {
    const date = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    const file = path.join(TRACES_DIR, `${date}.jsonl`);
    try {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      for (const l of lines) { try { traces.push(JSON.parse(l)); } catch {} }
    } catch {}
  }
  return traces.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

export function getTraces({ agent, limit = 20, traceId } = {}) {
  if (traceId) {
    const traces = readTraces(2, 1000);
    return traces.find(t => t.traceId === traceId) || null;
  }
  const traces = readTraces(2, 500);
  return agent ? traces.filter(t => t.agentId === agent).slice(0, limit) : traces.slice(0, limit);
}

export function getTraceStats() {
  const traces = readTraces(1, 1000);
  const byAgent = {};
  for (const t of traces) {
    if (!byAgent[t.agentId]) byAgent[t.agentId] = { total: 0, ok: 0, error: 0, durations: [] };
    const ag = byAgent[t.agentId];
    ag.total++;
    ag[t.status === 'ok' ? 'ok' : 'error']++;
    if (t.durationMs) ag.durations.push(t.durationMs);
  }
  const stats = {};
  for (const [agent, ag] of Object.entries(byAgent)) {
    const sorted = ag.durations.sort((a, b) => a - b);
    stats[agent] = {
      total: ag.total, ok: ag.ok, error: ag.error,
      successRate: ag.total ? Math.round((ag.ok / ag.total) * 100) : 0,
      p50: sorted[Math.floor(sorted.length * 0.5)] || 0,
      p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
      avgMs: sorted.length ? Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length) : 0,
    };
  }
  return { totalTraces: traces.length, byAgent: stats, today: new Date().toISOString().slice(0, 10) };
}
