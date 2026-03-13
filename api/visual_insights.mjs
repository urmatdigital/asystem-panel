/**
 * Visual Insights Engine — Symphony Vision Pattern
 *
 * Feature 1: Grafana/Netdata Metrics → qwen2.5:14b text analysis → Squad Chat
 * Feature 2: UI Screenshot → llava:7b vision → regression alert
 *
 * Endpoints exposed via server.mjs:
 *   POST /api/visual-insights/analyze    { type: 'metrics'|'screenshot', data? }
 *   POST /api/visual-insights/ui-check   { url, project }
 *   GET  /api/visual-insights/last       last N results
 */

import http from 'node:http';
import https from 'node:https';
import { execSync, exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execAsync = promisify(exec);
const HOME = process.env.HOME || '/Users/urmatmyrzabekov';
const LOG_FILE = path.join(HOME, 'projects/ASYSTEM/api/visual-insights.jsonl');
const SQUAD_URL = 'http://localhost:5190/api/veritas/api/v1/chat/squad';

// OpenRouter key (Phi-4 for vision/reasoning)
const OPENROUTER_KEY = 'process.env.OPENROUTER_API_KEY';
const PHI4_MODEL = 'microsoft/phi-4';

// ── Helpers ─────────────────────────────────────────────────────────────────

// Local Ollama (qwen2.5:14b for text/metrics)
function ollamaRequest(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: 11434,
      path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 120_000,
    }, res => {
      let full = '';
      res.on('data', chunk => {
        chunk.toString().split('\n').filter(Boolean).forEach(line => {
          try { full += JSON.parse(line)?.message?.content || ''; } catch {}
        });
      });
      res.on('end', () => resolve(full.trim()));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(payload);
    req.end();
  });
}

// OpenRouter Phi-4 (for vision + reasoning tasks)
function phi4Request(messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: PHI4_MODEL,
      messages,
      max_tokens: 1024,
    });
    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://os.asystem.kg',
        'X-Title': 'ASYSTEM Visual Insights',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 60_000,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(data);
          const text = d?.choices?.[0]?.message?.content || '';
          if (!text && d?.error) reject(new Error(d.error.message || JSON.stringify(d.error)));
          else resolve(text.trim());
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenRouter timeout')); });
    req.write(payload);
    req.end();
  });
}

function squadPost(message, tags = ['forge', 'insights']) {
  const body = JSON.stringify({ agent: 'Forge', message, tags, model: 'claude-sonnet-4-6' });
  const req = http.request({
    hostname: '127.0.0.1', port: 5190,
    path: '/api/veritas/api/v1/chat/squad', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 10_000,
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

function logResult(entry) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ...entry, ts: Date.now() }) + '\n');
  } catch {}
}

// ── Feature 1: Metrics Analysis ──────────────────────────────────────────────
export async function analyzeMetrics() {
  console.log('[VisualInsights] 📊 Collecting metrics...');

  // Collect from Netdata
  const metrics = {};
  const charts = ['system.cpu', 'system.ram', 'disk.sda', 'system.load'];

  for (const chart of charts) {
    try {
      const res = await fetch(`http://localhost:19999/api/v1/data?chart=${chart}&points=10&after=-300`);
      if (!res.ok) continue;
      const d = await res.json();
      const vals = (d.data || []).map(row => row.slice(1)).flat().filter(n => typeof n === 'number');
      if (vals.length) {
        metrics[chart] = {
          avg: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10,
          max: Math.round(Math.max(...vals) * 10) / 10,
          min: Math.round(Math.min(...vals) * 10) / 10,
        };
      }
    } catch {}
  }

  // Collect from ASYSTEM API
  let agentStatus = '';
  try {
    const res = await fetch('http://localhost:5190/api/agents');
    if (res.ok) {
      const d = await res.json();
      const agents = d.agents || d || [];
      agentStatus = agents.map(a => `${a.id}: ${a.status || 'unknown'}`).join(', ');
    }
  } catch {}

  // Collect PM2 status
  let pm2Status = '';
  try {
    const { stdout } = await execAsync('pm2 jlist 2>/dev/null');
    const procs = JSON.parse(stdout);
    const down = procs.filter(p => p.pm2_env?.status !== 'online').map(p => p.name);
    const up = procs.filter(p => p.pm2_env?.status === 'online').length;
    pm2Status = `${up} online${down.length ? `, DOWN: ${down.join(', ')}` : ''}`;
  } catch {}

  const metricsText = Object.entries(metrics)
    .map(([k, v]) => `${k}: avg=${v.avg}, max=${v.max}, min=${v.min}`)
    .join('\n');

  const prompt = `You are ASYSTEM infrastructure analyst. Analyze these system metrics and give a SHORT (3-5 sentences) health report in Russian. Flag any anomalies or concerns.

METRICS (last 5 min):
${metricsText || 'Netdata unavailable'}

PM2 Services: ${pm2Status || 'unknown'}
Agent Status: ${agentStatus || 'unknown'}

Respond with: overall status (🟢/🟡/🔴), key observations, any action needed.`;

  console.log('[VisualInsights] 🤖 Sending to qwen2.5:14b...');
  const analysis = await ollamaRequest({
    model: 'qwen2.5:14b',
    messages: [{ role: 'user', content: prompt }],
    stream: true,
  });

  const result = { type: 'metrics', analysis, metrics, pm2: pm2Status };
  logResult(result);

  // Post to Squad Chat
  squadPost(`📊 **Visual Insights — System Analysis**\n\n${analysis}`, ['forge', 'insights', 'metrics']);
  console.log('[VisualInsights] ✅ Metrics analysis complete');
  return result;
}

// ── Feature 2: UI Screenshot Regression ────────────────────────────────────
export async function checkUIRegression({ url, project = 'unknown', threshold = 'any broken UI' }) {
  console.log(`[VisualInsights] 🔍 UI check: ${project} at ${url}`);

  // Fetch HTML content → extract DOM structure → send to Phi-4 for analysis
  let htmlSummary = '';
  let httpStatus = 0;
  try {
    const fetchMod = url.startsWith('https') ? https : http;
    htmlSummary = await new Promise((resolve, reject) => {
      const req = fetchMod.get(url, { timeout: 15000, headers: { 'User-Agent': 'ASYSTEM-VisualInsights/1.0' } }, res => {
        httpStatus = res.statusCode;
        let data = '';
        res.on('data', c => { data += c; if (data.length > 80000) res.destroy(); });
        res.on('end', () => {
          // Extract key structural elements from HTML
          const title     = (data.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
          const h1s       = [...data.matchAll(/<h1[^>]*>([^<]+)<\/h1>/gi)].map(m => m[1]).slice(0, 5);
          const navItems  = [...data.matchAll(/nav[^>]*>[\s\S]{0,500}?<\/nav>/gi)].map(m =>
            m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
          ).slice(0, 3);
          const errors    = [...data.matchAll(/error|404|500|не найден|недоступен|crash/gi)].length;
          const buttons   = [...data.matchAll(/<button[^>]*>([^<]+)<\/button>/gi)].map(m => m[1]).slice(0, 10);
          const bodyText  = data.replace(/<script[\s\S]*?<\/script>/gi, '')
                               .replace(/<style[\s\S]*?<\/style>/gi, '')
                               .replace(/<[^>]+>/g, ' ')
                               .replace(/\s+/g, ' ')
                               .trim().slice(0, 2000);
          resolve(JSON.stringify({ title, h1s, navItems, buttons, errors, bodyText, httpStatus }));
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('fetch timeout')); });
    });
    console.log(`[VisualInsights] 🌐 Fetched ${url} (HTTP ${httpStatus}, ${htmlSummary.length} chars)`);
  } catch (e) {
    htmlSummary = JSON.stringify({ error: e.message, httpStatus });
    console.warn('[VisualInsights] fetch error:', e.message);
  }

  const prompt = `You are a UI/UX quality analyst for "${project}" (${url}).
Analyze the page structure below and check for:
1. HTTP errors (4xx/5xx)
2. Missing critical navigation or buttons
3. Error messages in content
4. Empty/blank page (no meaningful content)
5. Missing expected sections

Page data:
${htmlSummary.slice(0, 3000)}

Respond in Russian. Start with: ✅ OK или ⚠️ ПРОБЛЕМА. List specific issues found. Keep it brief (4-6 lines).`;

  console.log('[VisualInsights] 🤖 Sending to Phi-4 via OpenRouter...');
  let analysis = '';
  try {
    analysis = await phi4Request([{ role: 'user', content: prompt }]);
  } catch (e) {
    console.warn('[VisualInsights] Phi-4 error:', e.message);
    analysis = `HTTP ${httpStatus} — Phi-4 ошибка: ${e.message.slice(0, 80)}`;
  }

  const hasIssue = analysis.includes('ПРОБЛЕМА') || analysis.includes('⚠️') || analysis.includes('сломан');
  const result = { type: 'ui-regression', project, url, analysis, hasIssue };
  logResult(result);

  if (hasIssue) {
    squadPost(`🖥️ **UI Regression Alert — ${project}**\n\n${analysis}\n\nURL: ${url}`, ['forge', 'ui', 'alert']);
  } else {
    console.log(`[VisualInsights] ✅ UI OK: ${project}`);
  }

  return result;
}

// ── Scheduled runs ──────────────────────────────────────────────────────────
// Called externally via /api/visual-insights/* or on schedule

// Run metrics analysis every hour if called as main script
if (process.argv[1]?.includes('visual_insights')) {
  const mode = process.argv[2] || 'metrics';

  if (mode === 'metrics') {
    analyzeMetrics().then(r => {
      console.log('Analysis:', r.analysis?.slice(0, 200));
      process.exit(0);
    }).catch(e => { console.error(e); process.exit(1); });
  }

  if (mode === 'ui') {
    const url = process.argv[3] || 'https://os.te.kg';
    const project = process.argv[4] || 'ASYSTEM Panel';
    checkUIRegression({ url, project }).then(r => {
      console.log('UI Result:', r.analysis?.slice(0, 200));
      process.exit(0);
    }).catch(e => { console.error(e); process.exit(1); });
  }
}
