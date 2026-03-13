/**
 * hot-config.mjs — Live Configuration Without Restart
 *
 * Pattern: Dynamic agent behavior tuning at runtime
 *   Source: OpenClaw hot-reload pattern + "AI-Assisted TMDL Workflow" (r2Zebd1--cY)
 *
 * Config file: ~/.openclaw/workspace/.agent-config.json
 * Watch interval: every 5 seconds (fs.watchFile)
 * Changes apply immediately to next dispatch/task
 *
 * Tunable params (all without restart):
 *   karpathy_threshold:   min score to pass (default: 6)
 *   max_retry_count:      max dispatch retries (default: 2)
 *   budget_gate_enabled:  enable/disable budget check (default: true)
 *   persona_enabled:      enable/disable persona injection (default: true)
 *   debate_auto_threshold: confidence below which debate auto-triggers (default: 0.3)
 *   empo2_enabled:        enable/disable EMPO2 tips (default: true)
 *   cot_enabled:          enable/disable CoT logging (default: true)
 *   slow_mode:            add 2s delay between pipeline layers (debug)
 *   agent_overrides:      per-agent model/priority overrides
 *     { "bekzat": { "model": "claude-sonnet-4-6", "priority_boost": false } }
 *   feature_flags:        arbitrary bool flags for A/B testing
 *
 * API:
 *   GET  /api/config          — current active config
 *   POST /api/config/update   { key, value }  — update one key live
 *   POST /api/config/reset    — reset to defaults
 *   GET  /api/config/history  — recent config changes
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const HOME        = os.homedir();
const CONFIG_FILE = path.join(HOME, '.openclaw/workspace/.agent-config.json');
const HISTORY_LOG = path.join(HOME, '.openclaw/workspace/config-history.jsonl');

// ── Default config ────────────────────────────────────────────────────────────
const DEFAULTS = {
  karpathy_threshold:    6,
  max_retry_count:       2,
  budget_gate_enabled:   true,
  persona_enabled:       true,
  debate_auto_threshold: 0.3,
  empo2_enabled:         true,
  cot_enabled:           true,
  slow_mode:             false,
  reflection_enabled:    true,
  schema_enforce:        true,
  sla_enabled:           true,
  anomaly_enabled:       true,
  agent_overrides:       {},
  feature_flags:         {},
  updatedAt:             new Date().toISOString(),
};

// ── In-memory cache ───────────────────────────────────────────────────────────
let _cache = null;
let _lastMtime = 0;

// ── Load config (hot-reload aware) ───────────────────────────────────────────
export function getConfig() {
  try {
    const stat = fs.statSync(CONFIG_FILE);
    if (stat.mtimeMs !== _lastMtime) {
      _cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
      _lastMtime = stat.mtimeMs;
    }
  } catch {
    if (!_cache) _cache = { ...DEFAULTS };
  }
  return _cache;
}

// ── Get a single config value ─────────────────────────────────────────────────
export function cfg(key, fallback) {
  const c = getConfig();
  return c[key] !== undefined ? c[key] : (fallback !== undefined ? fallback : DEFAULTS[key]);
}

// ── Update one config key (live) ──────────────────────────────────────────────
export function updateConfig(key, value, updatedBy = 'api') {
  const config = getConfig();
  const prev = config[key];
  config[key] = value;
  config.updatedAt = new Date().toISOString();
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }
  catch (e) { throw new Error(`Config write failed: ${e.message}`); }
  _cache = config;
  _lastMtime = Date.now();

  const entry = { ts: Date.now(), key, prev, value, updatedBy };
  fs.appendFileSync(HISTORY_LOG, JSON.stringify(entry) + '\n');
  console.log(`[HotConfig] 🔥 ${key}: ${JSON.stringify(prev)} → ${JSON.stringify(value)} (by ${updatedBy})`);
  return { key, prev, value, updatedAt: config.updatedAt };
}

// ── Reset to defaults ─────────────────────────────────────────────────────────
export function resetConfig() {
  const config = { ...DEFAULTS, updatedAt: new Date().toISOString() };
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch {}
  _cache = config;
  const entry = { ts: Date.now(), key: 'RESET', prev: null, value: 'defaults', updatedBy: 'api' };
  fs.appendFileSync(HISTORY_LOG, JSON.stringify(entry) + '\n');
  console.log('[HotConfig] 🔄 Reset to defaults');
  return config;
}

// ── Get history ───────────────────────────────────────────────────────────────
export function getConfigHistory() {
  try {
    return fs.readFileSync(HISTORY_LOG, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean).slice(-30);
  } catch { return []; }
}

// ── Initialize config file if missing ────────────────────────────────────────
try {
  if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2));
} catch {}
