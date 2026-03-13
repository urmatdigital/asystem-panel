/**
 * stream-output.mjs — Incremental Output Streaming (SSE Pattern)
 *
 * Video: "February 2026: AI Agent Structural Reset" (ceeZuRQOnmQ)
 * Pattern: "One giant long stream of consciousness" — agents stream partial
 *   results via SSE while still working. Don't wait for completion.
 *   Anthropic's agent teams emit 150K-250K token streams incrementally.
 *
 * Use cases in ASYSTEM:
 *   - Long-running coding tasks: stream progress updates every step
 *   - Security audits: stream findings as discovered (not at end)
 *   - Research spikes: stream each sub-finding to Panel in real-time
 *   - Deploy pipelines: stream each stage completion to watchers
 *
 * Stream event types:
 *   STARTED       — task accepted, work beginning
 *   PROGRESS      — partial result or milestone update (percentage)
 *   FINDING       — intermediate finding (useful NOW, not just at end)
 *   THINKING      — agent's reasoning step (transparency)
 *   TOOL_RESULT   — result from a tool call mid-task
 *   WARNING       — issue detected while working
 *   PARTIAL       — partial output chunk (token-by-token or chunk-by-chunk)
 *   COMPLETED     — full result, task done
 *   FAILED        — task failed with reason
 *
 * Stream lifecycle:
 *   1. POST /api/stream/start { taskId, agentId, title } → get streamId
 *   2. POST /api/stream/emit  { streamId, type, data }   → add event to stream
 *   3. GET  /api/stream/:id   → SSE endpoint (reads events in sequence)
 *   4. POST /api/stream/close { streamId, result }       → finalize
 *
 * Storage: ring buffer of last 100 events per stream (lightweight)
 *
 * Panel integration: watchers can GET /api/stream/:id as SSE to watch live
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME        = os.homedir();
const STREAM_DIR  = path.join(HOME, '.openclaw/workspace/.streams');
const STREAM_LOG  = path.join(HOME, '.openclaw/workspace/stream-log.jsonl');

if (!fs.existsSync(STREAM_DIR)) fs.mkdirSync(STREAM_DIR, { recursive: true });

const VALID_TYPES = ['STARTED','PROGRESS','FINDING','THINKING','TOOL_RESULT','WARNING','PARTIAL','COMPLETED','FAILED'];

// ── Start a stream ────────────────────────────────────────────────────────────
export function startStream({ taskId, agentId, title = '' }) {
  const streamId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
  const stream = { streamId, taskId, agentId, title, status: 'active', startedAt: Date.now(), events: [], resultChunks: [], watchers: 0 };
  saveStream(stream);
  emitEvent({ streamId, type: 'STARTED', data: { taskId, agentId, title } });
  fs.appendFileSync(STREAM_LOG, JSON.stringify({ ts: Date.now(), action: 'start', streamId, taskId, agentId }) + '\n');
  console.log(`[StreamOut] 📡 Stream started: ${streamId} | ${agentId}: "${title.slice(0, 40)}"`);
  return { ok: true, streamId, taskId, agentId, sseUrl: `/api/stream/${streamId}` };
}

// ── Emit an event to the stream ───────────────────────────────────────────────
export function emitEvent({ streamId, type, data = {}, chunk = null }) {
  if (!VALID_TYPES.includes(type)) return { ok: false, reason: `Invalid type: ${type}` };

  const stream = loadStream(streamId);
  if (!stream) return { ok: false, reason: `Stream ${streamId} not found` };

  const event = { seq: stream.events.length, type, data, chunk, ts: Date.now() };

  // Ring buffer: keep last 100 events
  stream.events = [...stream.events.slice(-99), event];

  // Accumulate partial chunks for final assembly
  if (type === 'PARTIAL' && chunk) stream.resultChunks.push(chunk);
  if (type === 'PROGRESS')  console.log(`[StreamOut] 📊 ${streamId} ${data.pct || 0}%: ${data.message?.slice(0, 40) || ''}`);
  if (type === 'FINDING')   console.log(`[StreamOut] 💡 ${streamId} finding: ${JSON.stringify(data).slice(0, 60)}`);
  if (type === 'COMPLETED' || type === 'FAILED') {
    stream.status = type.toLowerCase();
    stream.completedAt = Date.now();
    fs.appendFileSync(STREAM_LOG, JSON.stringify({ ts: Date.now(), action: type.toLowerCase(), streamId, events: stream.events.length }) + '\n');
  }

  saveStream(stream);
  return { ok: true, streamId, seq: event.seq, type };
}

// ── Get stream events (for SSE or polling) ────────────────────────────────────
export function getStream(streamId, sinceSeq = 0) {
  const stream = loadStream(streamId);
  if (!stream) return { ok: false, reason: `Stream ${streamId} not found` };
  const newEvents = stream.events.filter(e => e.seq >= sinceSeq);
  const assembled = stream.resultChunks.join('');
  return {
    ok: true, streamId, status: stream.status,
    agentId: stream.agentId, title: stream.title,
    events: newEvents, totalEvents: stream.events.length,
    partialResult: assembled.slice(0, 500) + (assembled.length > 500 ? '...' : ''),
    partialChars: assembled.length,
  };
}

// ── Close/finalize stream ─────────────────────────────────────────────────────
export function closeStream({ streamId, result = '', success = true }) {
  emitEvent({ streamId, type: success ? 'COMPLETED' : 'FAILED', data: { chars: result.length, success } });
  if (result) emitEvent({ streamId, type: 'PARTIAL', chunk: result });
  return { ok: true, streamId, status: success ? 'completed' : 'failed' };
}

// ── Simulate a streamed task (for testing) ────────────────────────────────────
export function simulateStream({ taskId, agentId, title, steps = [] }) {
  const { streamId } = startStream({ taskId, agentId, title });
  let seq = 1;
  for (const step of steps) {
    emitEvent({ streamId, type: step.type || 'PROGRESS', data: step.data, chunk: step.chunk });
    seq++;
  }
  return { streamId, eventsEmitted: seq, sseUrl: `/api/stream/${streamId}` };
}

// ── List active streams ───────────────────────────────────────────────────────
export function getActiveStreams() {
  try {
    return fs.readdirSync(STREAM_DIR).filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(STREAM_DIR, f), 'utf8')); } catch { return null; } }).filter(Boolean)
      .filter(s => s.status === 'active')
      .map(s => ({ streamId: s.streamId, agentId: s.agentId, title: s.title?.slice(0, 40), events: s.events.length, startedAt: s.startedAt }));
  } catch { return []; }
}

function loadStream(id) { try { return JSON.parse(fs.readFileSync(path.join(STREAM_DIR, `${id}.json`), 'utf8')); } catch { return null; } }
function saveStream(s) { try { fs.writeFileSync(path.join(STREAM_DIR, `${s.streamId}.json`), JSON.stringify(s, null, 2)); } catch {} }
