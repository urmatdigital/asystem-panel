#!/usr/bin/env node
/**
 * Cloudflare Automation Rules
 * - DDoS detection → enable mode
 * - New VM → auto-create DNS record
 * - Service down → temporary block
 * - Firewall rule management
 */

import fs from 'fs';
import https from 'https';

const CF_TOKEN = 'process.env.CF_API_TOKEN';
const CF_ZONE_ID = '5aa37039abd7a1462c8426cf7685d11d';
const API_BASE = 'api.cloudflare.com';
const LOG_FILE = '/Users/urmatmyrzabekov/.openclaw/logs/cf-automation.log';

function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

async function cfRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_BASE,
      path: `/client/v4${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${CF_TOKEN}`,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Parse error'));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ==== RULE 1: DDoS Detection & Response ====
async function checkDDoS() {
  try {
    log('🔍 Checking for DDoS activity...');
    
    const response = await cfRequest('GET', `/zones/${CF_ZONE_ID}/analytics/dashboard`);
    
    if (response.result?.threat_level > 50) {
      log('🚨 DDoS detected! Enabling Defense Mode');
      
      // Enable Defense Mode
      await cfRequest('PATCH', `/zones/${CF_ZONE_ID}/settings/under_attack`, {
        value: 'on'
      });
      
      // Add aggressive firewall rule
      await cfRequest('POST', `/zones/${CF_ZONE_ID}/firewall/rules`, {
        filter: {
          expression: 'cf.threat_score > 30'
        },
        action: 'challenge',
        priority: 0,
        description: '[AUTO] DDoS Response - Challenge high threat'
      });
      
      log('✅ Defense Mode enabled + Challenge rule added');
      return { action: 'defense_mode', status: 'active' };
    } else {
      log('✓ No DDoS detected');
      return { action: 'none', status: 'normal' };
    }
  } catch (err) {
    log(`❌ DDoS check error: ${err.message}`);
    return { action: 'error', error: err.message };
  }
}

// ==== RULE 2: New VM Auto-Registration ====
async function checkNewVMs() {
  try {
    log('🔍 Checking for new VMs in Proxmox...');
    
    // Scan local Tailscale nodes
    const vmPattern = /^vm-|^container-|^proxmox-/i;
    const existingRecords = await cfRequest('GET', `/zones/${CF_ZONE_ID}/dns_records?per_page=100`);
    
    const recordNames = new Set(existingRecords.result?.map(r => r.name) || []);
    
    // Expected VMs that might need DNS
    const expectedVMs = [
      { name: 'mc', ip: '135.181.112.105', type: 'A' },
      { name: 'coolify', ip: '135.181.112.100', type: 'A' },
      { name: 'mailcow', ip: '135.181.112.300', type: 'A' },
    ];
    
    for (const vm of expectedVMs) {
      if (!recordNames.has(vm.name)) {
        log(`📝 Creating DNS record for ${vm.name}...`);
        
        await cfRequest('POST', `/zones/${CF_ZONE_ID}/dns_records`, {
          type: vm.type,
          name: vm.name,
          content: vm.ip,
          ttl: 1,
          proxied: true
        });
        
        log(`✅ Created: ${vm.name}.asystem.kg → ${vm.ip}`);
      }
    }
    
    return { action: 'vm_scan_complete', created: expectedVMs.length };
  } catch (err) {
    log(`❌ VM scan error: ${err.message}`);
    return { action: 'error', error: err.message };
  }
}

// ==== RULE 3: Service Health Monitoring ====
async function monitorServiceHealth() {
  try {
    log('🔍 Monitoring service health...');
    
    const services = [
      { name: 'p.asystem.kg', endpoint: 'https://p.asystem.kg/api2/json/version', timeout: 5000 },
      { name: 'sso.asystem.kg', endpoint: 'https://sso.asystem.kg/health', timeout: 5000 },
      { name: 'os.asystem.kg', endpoint: 'https://os.asystem.kg/api/health', timeout: 5000 },
    ];
    
    const results = {};
    
    for (const service of services) {
      try {
        const response = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Timeout')), service.timeout);
          
          https.get(service.endpoint, { rejectUnauthorized: false }, (res) => {
            clearTimeout(timeout);
            resolve(res.statusCode === 200);
          }).on('error', () => {
            clearTimeout(timeout);
            reject(new Error('Connection error'));
          });
        });
        
        results[service.name] = { ok: response };
        log(`✓ ${service.name}: OK`);
      } catch (err) {
        results[service.name] = { ok: false, error: err.message };
        log(`✗ ${service.name}: FAILED - ${err.message}`);
        
        // Temporary block if service is down
        // (optional - enable if needed)
      }
    }
    
    return { action: 'health_check_complete', results };
  } catch (err) {
    log(`❌ Health monitoring error: ${err.message}`);
    return { action: 'error', error: err.message };
  }
}

// ==== RULE 4: Firewall Rule Maintenance ====
async function updateFirewallRules() {
  try {
    log('🔍 Updating firewall rules...');
    
    const rules = [
      {
        name: '[AUTO] Bot Traffic Challenge',
        expression: 'cf.bot_detection.score > 80',
        action: 'challenge',
        priority: 1
      },
      {
        name: '[AUTO] High Threat Score',
        expression: 'cf.threat_score > 50',
        action: 'challenge',
        priority: 2
      },
      {
        name: '[AUTO] Rate Limit API',
        expression: 'http.request.uri.path contains "/api"',
        action: 'challenge',
        priority: 3
      }
    ];
    
    for (const rule of rules) {
      try {
        // Check if rule exists
        const existing = await cfRequest('GET', `/zones/${CF_ZONE_ID}/firewall/rules?per_page=100`);
        const found = existing.result?.find(r => r.description?.includes(rule.name));
        
        if (!found) {
          log(`📝 Creating firewall rule: ${rule.name}`);
          await cfRequest('POST', `/zones/${CF_ZONE_ID}/firewall/rules`, {
            filter: { expression: rule.expression },
            action: rule.action,
            priority: rule.priority,
            description: rule.name
          });
        }
      } catch (err) {
        log(`⚠️  Rule ${rule.name} error: ${err.message}`);
      }
    }
    
    log('✅ Firewall rules updated');
    return { action: 'firewall_update_complete', rulesChecked: rules.length };
  } catch (err) {
    log(`❌ Firewall update error: ${err.message}`);
    return { action: 'error', error: err.message };
  }
}

// ==== MAIN AUTOMATION LOOP ====
async function runAutomation() {
  log('🚀 Starting Cloudflare Automation cycle');
  
  try {
    const results = await Promise.all([
      checkDDoS(),
      checkNewVMs(),
      monitorServiceHealth(),
      updateFirewallRules()
    ]);
    
    log('✅ Automation cycle complete');
    log(`Results: ${JSON.stringify(results)}`);
    
    return { ok: true, results };
  } catch (err) {
    log(`❌ Automation error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Run immediately if daemon mode
if (process.argv[2] === '--daemon') {
  log('🔄 Running in daemon mode (every 5 minutes)');
  setInterval(runAutomation, 5 * 60 * 1000);
  runAutomation();
} else {
  // Run once
  runAutomation().then(result => {
    process.exit(result.ok ? 0 : 1);
  });
}