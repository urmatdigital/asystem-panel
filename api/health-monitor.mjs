#!/usr/bin/env node
/**
 * health-monitor.mjs — Self-healing watchdog for ASYSTEM
 * 
 * Checks all services every 2 minutes:
 * - Level 1: PM2 auto-restart (already built-in)
 * - Level 2: HTTP health check → restart if failing
 * - Level 3: Disk/Memory checks → cleanup if critical
 * - Level 4: Agent diagnosis (future)
 * - Level 5: Telegram escalation to Urmat
 */

import { execSync, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const CHECK_INTERVAL = 120_000; // 2 minutes
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8400727128:AAEDiXtE0P2MfUJirXtN8zDjpU9kN03ork0';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '861276843';
const CONVEX_SITE = 'https://expert-dachshund-299.convex.site';

// Track consecutive failures for escalation
const failCounts = {};
const ESCALATION_THRESHOLD = 3; // alert after 3 consecutive failures

// ─── Services to monitor ─────────────────────────────────────────

const SERVICES = [
  {
    name: 'asystem-api',
    pm2Name: 'asystem-api',
    healthUrl: 'http://localhost:5190/api/health',
    critical: true,
  },
  {
    name: 'mac-agent-listen',
    pm2Name: 'mac-agent-listen',
    healthUrl: 'http://localhost:7600/health',
    critical: true,
  },
  {
    name: 'task-worker',
    pm2Name: 'task-worker',
    healthUrl: null, // no HTTP endpoint
    critical: false,
  },
  {
    name: 'forge-proxy',
    pm2Name: 'forge-proxy',
    healthUrl: null,
    critical: false,
  },
  {
    name: 'cf-panel-mac',
    pm2Name: 'cf-panel-mac',
    healthUrl: null,
    critical: true,
  },
];

// ─── Telegram notification ────────────────────────────────────────

async function sendTelegram(message) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown',
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error('[telegram]', e.message);
  }
}

// ─── Convex event logging ─────────────────────────────────────────

async function logEvent(type, message, severity = 'info') {
  try {
    await fetch(`${CONVEX_SITE}/agent/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `[health] ${message.slice(0, 80)}`,
        description: message,
        status: severity === 'error' ? 'blocked' : 'done',
        priority: severity === 'error' ? 'high' : 'low',
        type: 'health',
        agent: 'forge',
        externalId: `health-${Date.now()}`,
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
}

// ─── Check functions ──────────────────────────────────────────────

async function checkPM2Service(service) {
  try {
    const { stdout } = await execAsync(`pm2 jlist`, { timeout: 5000 });
    const procs = JSON.parse(stdout);
    const proc = procs.find(p => p.name === service.pm2Name);
    if (!proc) return { ok: false, reason: 'not found in PM2' };
    if (proc.pm2_env.status !== 'online') return { ok: false, reason: `status: ${proc.pm2_env.status}` };
    return { ok: true, pid: proc.pid, uptime: proc.pm2_env.pm_uptime };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function checkHTTPHealth(url) {
  if (!url) return { ok: true, reason: 'no health endpoint' };
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function checkDisk() {
  try {
    const { stdout } = await execAsync("df -h / | tail -1 | awk '{print $5}'", { timeout: 3000 });
    const pct = parseInt(stdout.trim().replace('%', ''));
    return { ok: pct < 90, pct, reason: pct >= 90 ? `Disk usage: ${pct}%` : null };
  } catch (e) {
    return { ok: true, reason: e.message };
  }
}

async function checkMemory() {
  try {
    // macOS: use vm_stat
    const { stdout } = await execAsync("vm_stat | head -5", { timeout: 3000 });
    // Simple check: if we can run vm_stat, system is responsive
    return { ok: true };
  } catch {
    return { ok: false, reason: 'System unresponsive' };
  }
}

// ─── Remediation ──────────────────────────────────────────────────

async function restartService(service) {
  console.log(`[heal] Restarting ${service.pm2Name}...`);
  try {
    await execAsync(`pm2 restart ${service.pm2Name}`, { timeout: 10000 });
    // Wait 3s and verify
    await new Promise(r => setTimeout(r, 3000));
    const check = await checkPM2Service(service);
    if (check.ok) {
      console.log(`[heal] ✅ ${service.pm2Name} restarted successfully`);
      await logEvent('heal', `Auto-restarted ${service.pm2Name}`, 'info');
      return true;
    }
    return false;
  } catch (e) {
    console.error(`[heal] Failed to restart ${service.pm2Name}:`, e.message);
    return false;
  }
}

async function cleanupDisk() {
  console.log('[heal] Cleaning up disk...');
  try {
    // Clean /tmp files older than 7 days
    await execAsync('find /tmp -maxdepth 1 -name "mac-agent-*" -mtime +7 -delete 2>/dev/null || true');
    await execAsync('find /tmp -maxdepth 1 -name "steer-*" -mtime +7 -delete 2>/dev/null || true');
    await execAsync('find /tmp -maxdepth 1 -name "gemini-*" -mtime +7 -delete 2>/dev/null || true');
    // Truncate large PM2 logs
    await execAsync('pm2 flush 2>/dev/null || true');
    console.log('[heal] ✅ Disk cleanup done');
    return true;
  } catch (e) {
    console.error('[heal] Cleanup failed:', e.message);
    return false;
  }
}

// ─── Main health check loop ──────────────────────────────────────

async function runChecks() {
  const issues = [];
  const healed = [];
  const ts = new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });

  // Check each service
  for (const service of SERVICES) {
    const pm2Check = await checkPM2Service(service);
    const httpCheck = await checkHTTPHealth(service.healthUrl);
    const key = service.name;

    if (!pm2Check.ok || !httpCheck.ok) {
      failCounts[key] = (failCounts[key] || 0) + 1;
      const reason = !pm2Check.ok ? pm2Check.reason : httpCheck.reason;

      console.log(`[${ts}] ❌ ${service.name}: ${reason} (fail #${failCounts[key]})`);

      // Level 2: Auto-restart
      if (failCounts[key] >= 2) {
        const fixed = await restartService(service);
        if (fixed) {
          healed.push(service.name);
          failCounts[key] = 0;
        } else {
          issues.push({ service: service.name, reason, critical: service.critical });
        }
      } else {
        issues.push({ service: service.name, reason, critical: service.critical });
      }
    } else {
      if (failCounts[key] > 0) {
        console.log(`[${ts}] ✅ ${service.name}: recovered`);
      }
      failCounts[key] = 0;
    }
  }

  // Check disk
  const disk = await checkDisk();
  if (!disk.ok) {
    console.log(`[${ts}] ⚠️ Disk: ${disk.reason}`);
    const cleaned = await cleanupDisk();
    if (cleaned) healed.push('disk-cleanup');
    else issues.push({ service: 'disk', reason: disk.reason, critical: true });
  }

  // Check memory/responsiveness
  const mem = await checkMemory();
  if (!mem.ok) {
    issues.push({ service: 'system', reason: mem.reason, critical: true });
  }

  // Broadcast health status via WS
  if (issues.length > 0 || healed.length > 0) {
    broadcastHealthStatus(issues, healed);
  }

  // Level 5: Escalate critical issues to Telegram
  const criticalIssues = issues.filter(i => i.critical && (failCounts[i.service] || 0) >= ESCALATION_THRESHOLD);
  if (criticalIssues.length > 0) {
    const msg = `🚨 *ASYSTEM Health Alert*\n\n` +
      criticalIssues.map(i => `❌ *${i.service}*: ${i.reason}`).join('\n') +
      (healed.length ? `\n\n✅ Auto-healed: ${healed.join(', ')}` : '') +
      `\n\n_${new Date().toLocaleString('ru', { timeZone: 'Asia/Bishkek' })}_`;
    await sendTelegram(msg);
    await logEvent('alert', `Health alert: ${criticalIssues.map(i => i.service).join(', ')}`, 'error');
  }

  // Log healed events
  if (healed.length > 0 && criticalIssues.length === 0) {
    console.log(`[${ts}] 🔧 Auto-healed: ${healed.join(', ')}`);
  }

  // Quiet success
  if (issues.length === 0 && healed.length === 0) {
    // Log every 30 min (15 checks)
    if (!runChecks._counter) runChecks._counter = 0;
    runChecks._counter++;
    if (runChecks._counter % 15 === 1) {
      console.log(`[${ts}] ✅ All systems healthy`);
    }
  }
}

// ─── Anomaly detection ────────────────────────────────────────────

let anomalyModule = null;

async function runAnomalyCheck() {
  try {
    if (!anomalyModule) {
      anomalyModule = await import('./anomaly-detector.mjs');
    }

    // Gather current metrics
    const [tasksRes, statsRes] = await Promise.allSettled([
      fetch('http://localhost:5190/api/agents/metrics', { signal: AbortSignal.timeout(3000) }).then(r => r.json()),
      fetch('http://localhost:7600/stats', { headers: { 'X-API-Key': 'forge-mac-agent-2026-secret' }, signal: AbortSignal.timeout(3000) }).then(r => r.json()),
    ]);

    const agentMetrics = tasksRes.status === 'fulfilled' ? tasksRes.value : {};
    const macStats = statsRes.status === 'fulfilled' ? statsRes.value : {};

    const forgeMetrics = agentMetrics.forge || {};
    const metrics = {
      completionRate: forgeMetrics.successRate || 0,
      activeAgents: Object.keys(agentMetrics).length,
      failedTasks: macStats.failed || 0,
    };

    const result = anomalyModule.checkAnomalies(metrics);

    if (result.anomalies > 0) {
      console.log(`[anomaly] ⚠️ ${result.anomalies} anomalies: ${result.alerts.join(', ')}`);
      await sendTelegram(`🔍 *Anomaly Detected*\n\n${result.alerts.join('\n')}`);
    }
  } catch (e) {
    // Silently skip — anomaly detection is optional
  }
}

// ─── Cost monitoring ──────────────────────────────────────────────

let lastCostAlert = 0;
const COST_ALERT_COOLDOWN = 3600_000; // 1 hour between alerts
const DAILY_BUDGET = 50; // $50/day

async function checkCosts() {
  try {
    const r = await fetch('http://localhost:5190/api/cfo/stats', { signal: AbortSignal.timeout(5000) });
    const data = await r.json();
    const todayCost = data?.costToday ?? 0;

    if (todayCost > DAILY_BUDGET && Date.now() - lastCostAlert > COST_ALERT_COOLDOWN) {
      lastCostAlert = Date.now();
      await sendTelegram(
        `💰 *Cost Alert*\n\n` +
        `Сегодня: *$${todayCost.toFixed(2)}* (бюджет: $${DAILY_BUDGET})\n` +
        `Превышение: +$${(todayCost - DAILY_BUDGET).toFixed(2)}\n\n` +
        `_Рекомендация: проверить запущенные jobs, переключить на haiku_`
      );
      console.log(`[cost] ⚠️ Daily cost $${todayCost.toFixed(2)} exceeds budget $${DAILY_BUDGET}`);
    }
  } catch {}
}

// ─── Start ────────────────────────────────────────────────────────

// Broadcast health status via API (for WS relay)
async function broadcastHealthStatus(issues, healed) {
  try {
    await fetch('http://localhost:5190/api/health/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issues, healed, ts: Date.now() }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
}

console.log('[health-monitor] Started — checking every 2 minutes');
console.log(`[health-monitor] Services: ${SERVICES.map(s => s.name).join(', ')}`);
console.log(`[health-monitor] Escalation after ${ESCALATION_THRESHOLD} consecutive failures → Telegram`);

runChecks();
checkCosts();
setInterval(runChecks, CHECK_INTERVAL);
setInterval(checkCosts, 600_000); // check costs every 10 min
setInterval(runAnomalyCheck, 3600_000); // anomaly check every hour
setTimeout(runAnomalyCheck, 30_000); // first check after 30s warmup
