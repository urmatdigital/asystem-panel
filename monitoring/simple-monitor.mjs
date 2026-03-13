#!/usr/bin/env node
/**
 * Simple Monitoring Script for Hetzner Server
 * Checks SSH, Proxmox, and key services
 */

import { exec } from 'child_process';
import https from 'https';
import net from 'net';
import { promisify } from 'util';

const execAsync = promisify(exec);

const TARGETS = {
  hetzner: {
    host: '135.181.112.60',
    checks: [
      { name: 'SSH', type: 'port', port: 22 },
      { name: 'Proxmox Web', type: 'port', port: 8006 },
      { name: 'HTTPS', type: 'port', port: 443 },
      { name: 'Ping', type: 'ping' }
    ]
  }
};

const ALERT_WEBHOOK = 'http://localhost:5190/api/monitoring/alert'; // Optional webhook

async function checkPort(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    
    socket.setTimeout(timeout);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    
    socket.connect(port, host);
  });
}

async function checkPing(host) {
  try {
    const { stdout } = await execAsync(`/sbin/ping -c 1 -W 2 ${host}`);
    return stdout.includes('1 packets received');
  } catch {
    return false;
  }
}

async function checkSSH(host) {
  try {
    const { stdout } = await execAsync(
      `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no root@${host} "echo ok" 2>&1`
    );
    return stdout.trim() === 'ok';
  } catch {
    return false;
  }
}

async function sendAlert(message, level = 'warning') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${level.toUpperCase()}: ${message}`);
  
  // Send to Telegram via OpenClaw if critical
  if (level === 'critical') {
    try {
      await execAsync(
        `curl -X POST http://localhost:5190/api/message/send -H "Content-Type: application/json" -d '{"to": "861276843", "message": "🚨 ALERT: ${message}"}' 2>/dev/null`
      );
    } catch {}
  }
}

async function monitorTarget(name, config) {
  const results = [];
  
  for (const check of config.checks) {
    let status = false;
    
    switch (check.type) {
      case 'port':
        status = await checkPort(config.host, check.port);
        break;
      case 'ping':
        status = await checkPing(config.host);
        break;
      case 'ssh':
        status = await checkSSH(config.host);
        break;
    }
    
    results.push({
      service: `${name}:${check.name}`,
      status,
      timestamp: new Date().toISOString()
    });
    
    if (!status) {
      await sendAlert(`${name} ${check.name} is DOWN`, 'warning');
    }
  }
  
  return results;
}

async function runMonitoring() {
  console.log('🔍 Starting monitoring cycle...');
  
  for (const [name, config] of Object.entries(TARGETS)) {
    const results = await monitorTarget(name, config);
    
    // Check if all services are down
    const allDown = results.every(r => !r.status);
    if (allDown) {
      await sendAlert(`${name} server is COMPLETELY DOWN!`, 'critical');
    }
    
    // Log status
    results.forEach(r => {
      const icon = r.status ? '✅' : '❌';
      console.log(`${icon} ${r.service}: ${r.status ? 'UP' : 'DOWN'}`);
    });
  }
}

// Run once if called directly
if (process.argv[1] === import.meta.url.slice(7)) {
  const interval = parseInt(process.argv[2]) || 0;
  
  if (interval > 0) {
    console.log(`📡 Monitoring every ${interval} seconds`);
    runMonitoring();
    setInterval(runMonitoring, interval * 1000);
  } else {
    runMonitoring().then(() => process.exit(0));
  }
}

export default { runMonitoring, checkPort, checkPing, checkSSH };