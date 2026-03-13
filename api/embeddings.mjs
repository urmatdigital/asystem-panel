/**
 * OpenAI Embeddings → Qdrant — semantic memory for agents
 * Endpoint: POST /api/memory/embed  { text, agent, type, tags }
 * Endpoint: GET  /api/memory/recall?q=...&agent=...&limit=5
 */

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const QDRANT_URL = 'http://100.79.127.66:6333';
const QDRANT_KEY = 'asystem-qdrant-2026-secret';
const COLLECTION = 'asystem_memory';

async function embed(text) {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not set');
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8000) }),
    signal: AbortSignal.timeout(15000),
  });
  const d = await r.json();
  if (!d.data?.[0]?.embedding) throw new Error(d.error?.message || 'embedding failed');
  return d.data[0].embedding; // 1536-dim
}

const qFetch = (path, method = 'GET', body) => fetch(`${QDRANT_URL}${path}`, {
  method, headers: { 'api-key': QDRANT_KEY, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
  signal: AbortSignal.timeout(10000),
}).then(r => r.json()).catch(e => ({ error: e.message }));

export async function storeEmbedding({ text, agent = 'forge', type = 'task', tags = [], id }) {
  const vector = await embed(text);
  const pointId = id || Date.now();
  const res = await qFetch(`/collections/${COLLECTION}/points`, 'PUT', {
    points: [{ id: pointId, vector, payload: { text: text.slice(0, 2000), agent, type, tags, ts: Date.now() } }]
  });
  return { ok: !res.error, pointId, error: res.error };
}

export async function recallMemory({ query, agent, limit = 5 }) {
  const vector = await embed(query);
  const filter = agent ? { must: [{ key: 'agent', match: { value: agent } }] } : undefined;
  const res = await qFetch(`/collections/${COLLECTION}/points/search`, 'POST', {
    vector, limit, with_payload: true, filter,
  });
  return (res.result || []).map(r => ({ score: +r.score.toFixed(4), ...r.payload }));
}

export async function getCollectionInfo() {
  const res = await qFetch(`/collections/${COLLECTION}`);
  return { count: res.result?.points_count ?? 0, status: res.result?.status ?? 'unknown' };
}
