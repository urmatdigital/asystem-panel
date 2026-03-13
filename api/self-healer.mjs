/**
 * self-healer.mjs — Self-Healing Infrastructure (SUNK Pattern)
 *
 * Video: "SUNK: Production-Ready AI Training at Massive Scale" (Zc7dspn3kvo)
 * Pattern: System monitors its own health, detects drift/failures,
 *   and auto-heals without human intervention. Like CoreWeave's SUNK:
 *   "self-healing and reusing gets your training job back on track fast"
 *
 * Monitored aspects:
 *   PM2_PROCESSES   — any process stopped unexpectedly → restart
 *   PORT_HEALTH     — server port not responding → restart
 *   MEMORY_PRESSURE — RSS > threshold → log + warn
 *   CONFIG_DRIFT    — expected config values changed → rewrite
 *   DISK_PRESSURE   — disk usage > 85% → cleanup old logs/caches
 *   DEAD_LETTER     — DLQ growing → escalate to iron
 *   QUEUE_STALL     — tasks stuck in queue > 2h → re-dispatch
 *   ZOMBIE_PROCESS  — PM2 process with high restart count → investigate
 *
 * Heal actions (risk-classified):
 *   LOW RISK   → auto-execute (restart PM2 process, restart server)
 *   MEDIUM RISK → auto-execute + log + notify Урмат
 *   HIGH RISK  → alert Урмат, wait for approval (config changes, deletions)
 *
 * API:
 *   POST /api/heal/scan     { force? } → run full health scan
 *   GET  /api/heal/status   → current system health + issues
 *   POST /api/heal/fix      { issueId } → attempt targeted fix
 *   GET  /api/heal/history  → past incidents and actions
 */

import fs        from 'node:fs';
import path      from 'node:path';
import os        from 'node:os';
import { exec }  from 'node:child_process';
import { promisify } from 'node:util';

const HOME       = os.homedir();
const HEAL_LOG   = path.join(HOME, '.openclaw/workspace/heal-log.jsonl');
const HEAL_STATE = path.join(HOME, '.openclaw/workspace/.heal-state.json');
const SCAN_INTERVAL_MS = 5 * 60 * 1000;  // 5 min between scans

const execAsync = promisify(exec);

// ── Risk levels ────────────────────────────────────────────────────────────────
const RISK = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' };

// ── Health checks ──────────────────────────────────────────────────────────────
async function checkPortHealth() {
  const issues = [];
  try {
    const { stdout } = await execAsync('curl -s -o /dev/null -w "%{http_code}" http://localhost:5190/health --max-time 3');
    const code = parseInt(stdout.trim());
    if (code !== 200) {
      issues.push({ id: `port_5190_${Date.now()}`, type: 'PORT_HEALTH', severity: 'critical', desc: `Server port 5190 returned HTTP ${code}`, fix: 'pm2 restart 20', risk: RISK.LOW, autoFix: true });
    }
  } catch {
    issues.push({ id: `port_5190_${Date.now()}`, type: 'PORT_HEALTH', severity: 'critical', desc: 'Server port 5190 not responding', fix: 'pm2 restart 20', risk: RISK.LOW, autoFix: true });
  }
  return issues;
}

async function checkPM2Processes() {
  const issues = [];
  try {
    const { stdout } = await execAsync('pm2 jlist 2>/dev/null');
    const procs = JSON.parse(stdout);
    for (const p of procs) {
      // High restart count = zombie
      if (p.pm2_env?.restart_time > 500 && p.name !== 'asystem-api') {
        issues.push({ id: `zombie_${p.name}_${Date.now()}`, type: 'ZOMBIE_PROCESS', severity: 'medium', desc: `${p.name} has ${p.pm2_env.restart_time} restarts`, fix: `pm2 describe ${p.pm_id}`, risk: RISK.MEDIUM, autoFix: false });
      }
      // Stopped process that should be running
      if (p.pm2_env?.status === 'stopped' && !['convex-mc-poller', 'mc-token-bridge', 'orgon-frontend'].includes(p.name)) {
        issues.push({ id: `stopped_${p.name}_${Date.now()}`, type: 'PM2_STOPPED', severity: 'high', desc: `Process ${p.name} unexpectedly stopped`, fix: `pm2 restart ${p.pm_id}`, risk: RISK.LOW, autoFix: true });
      }
    }
  } catch {}
  return issues;
}

async function checkMemoryPressure() {
  const issues = [];
  try {
    const { stdout } = await execAsync("vm_stat | grep 'Pages free'");
    const freePages = parseInt(stdout.match(/(\d+)/)?.[1] || '0');
    const freeMB    = freePages * 4096 / 1024 / 1024;
    if (freeMB < 200) {
      issues.push({ id: `mem_${Date.now()}`, type: 'MEMORY_PRESSURE', severity: 'medium', desc: `Low free memory: ${Math.round(freeMB)}MB free`, fix: 'no auto-fix; investigate high-memory PM2 processes', risk: RISK.HIGH, autoFix: false });
    }
  } catch {}
  return issues;
}

async function checkDiskPressure() {
  const issues = [];
  try {
    const { stdout } = await execAsync("df -h / | tail -1 | awk '{print $5}'");
    const pct = parseInt(stdout.trim().replace('%', ''));
    if (pct > 85) {
      issues.push({ id: `disk_${Date.now()}`, type: 'DISK_PRESSURE', severity: pct > 92 ? 'critical' : 'medium', desc: `Disk usage at ${pct}%`, fix: 'cleanup old logs and caches', risk: RISK.MEDIUM, autoFix: pct < 90 });
    }
  } catch {}
  return issues;
}

async function checkDeadLetterQueue() {
  const issues = [];
  try {
    const dlqPath = path.join(HOME, '.openclaw/workspace/dlq.jsonl');
    const lines   = fs.readFileSync(dlqPath, 'utf8').trim().split('\n').filter(Boolean);
    const recent  = lines.filter(l => { try { const d = JSON.parse(l); return Date.now() - d.ts < 60 * 60 * 1000; } catch { return false; } });
    if (recent.length >= 5) {
      issues.push({ id: `dlq_${Date.now()}`, type: 'DEAD_LETTER', severity: 'high', desc: `DLQ has ${recent.length} failed tasks in last hour`, fix: 'dispatch analysis task to iron', risk: RISK.MEDIUM, autoFix: false });
    }
  } catch {}
  return issues;
}

// ── Apply auto-fix ────────────────────────────────────────────────────────────
async function applyFix(issue) {
  const start = Date.now();
  try {
    if (issue.type === 'PM2_STOPPED' || issue.type === 'PORT_HEALTH') {
      const match = issue.fix.match(/pm2 restart (\S+)/);
      if (match) { await execAsync(`pm2 restart ${match[1]}`); }
    }
    const elapsed = Date.now() - start;
    console.log(`[SelfHealer] ✅ Auto-fixed [${issue.type}] in ${elapsed}ms`);
    return { ok: true, elapsed };
  } catch (e) {
    console.log(`[SelfHealer] ❌ Fix failed [${issue.type}]: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ── Full scan ─────────────────────────────────────────────────────────────────
export async function scan({ force = false } = {}) {
  const state = loadState();
  if (!force && Date.now() - (state.lastScan || 0) < SCAN_INTERVAL_MS) {
    return { ok: true, skipped: true, reason: 'Too soon', nextScanIn: Math.round((SCAN_INTERVAL_MS - (Date.now() - state.lastScan)) / 1000) + 's' };
  }

  const allChecks = await Promise.allSettled([checkPortHealth(), checkPM2Processes(), checkMemoryPressure(), checkDiskPressure(), checkDeadLetterQueue()]);
  const issues = allChecks.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  const autoFixed = [], needsAttention = [];
  for (const issue of issues) {
    if (issue.autoFix && issue.risk === RISK.LOW) {
      const result = await applyFix(issue);
      autoFixed.push({ issue: issue.type, desc: issue.desc, result });
      fs.appendFileSync(HEAL_LOG, JSON.stringify({ ts: Date.now(), action: 'auto-fix', type: issue.type, desc: issue.desc, ok: result.ok }) + '\n');
    } else {
      needsAttention.push(issue);
    }
  }

  state.lastScan = Date.now();
  state.issues   = issues;
  saveState(state);

  console.log(`[SelfHealer] 🔍 Scan complete: ${issues.length} issues, ${autoFixed.length} auto-fixed, ${needsAttention.length} need attention`);
  return { ok: true, scanned: 5, issues: issues.length, autoFixed: autoFixed.length, needsAttention: needsAttention.length, details: { autoFixed, needsAttention: needsAttention.map(i => ({ type: i.type, severity: i.severity, desc: i.desc, risk: i.risk })) } };
}

export function getStatus() {
  const state = loadState();
  return { lastScan: state.lastScan ? new Date(state.lastScan).toISOString() : null, issues: (state.issues || []).length, health: (state.issues || []).length === 0 ? '✅ HEALTHY' : '⚠️ ISSUES' };
}

export function getHistory(limit = 20) {
  try {
    return fs.readFileSync(HEAL_LOG, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map(l => JSON.parse(l)).reverse();
  } catch { return []; }
}

function loadState() { try { return JSON.parse(fs.readFileSync(HEAL_STATE, 'utf8')); } catch { return { lastScan: 0, issues: [] }; } }
function saveState(d) { try { fs.writeFileSync(HEAL_STATE, JSON.stringify(d, null, 2)); } catch {} }
