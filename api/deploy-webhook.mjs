/**
 * GitHub webhook handler for auto-deploy
 * Integrated into server.mjs as /api/webhook/github endpoint
 * 
 * Flow: push to main → pull → build → deploy → health check → notify
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { createHmac } from 'crypto';

const execAsync = promisify(exec);

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || 'asystem-webhook-2026';
const DEPLOY_DIR = process.env.HOME + '/projects/ASYSTEM';
const PANEL_DIR = DEPLOY_DIR + '/panel';
const REMOTE_HOST = '135.181.112.60';
const REMOTE_DIR = '/var/www/os.asystem.kg/';
const SSH_KEY = process.env.HOME + '/.ssh/id_ed25519_asystemkg';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8400727128:AAEDiXtE0P2MfUJirXtN8zDjpU9kN03ork0';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '861276843';

async function sendTelegram(message) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown' }),
    });
  } catch {}
}

function verifySignature(payload, signature) {
  if (!signature) return false;
  const hmac = createHmac('sha256', WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');
  return digest === signature;
}

export async function handleGitHubWebhook(body, headers) {
  const event = headers['x-github-event'];
  const signature = headers['x-hub-signature-256'];

  // Verify signature
  if (!verifySignature(body, signature)) {
    return { status: 403, body: { error: 'Invalid signature' } };
  }

  const payload = JSON.parse(body);

  // Only deploy on push to main
  if (event !== 'push' || payload.ref !== 'refs/heads/main') {
    return { status: 200, body: { message: `Ignored: ${event} to ${payload.ref}` } };
  }

  const repo = payload.repository?.name || 'unknown';
  const commits = payload.commits?.length || 0;
  const pusher = payload.pusher?.name || 'unknown';
  const commitMsg = payload.head_commit?.message?.split('\n')[0] || '';

  console.log(`[deploy] 🚀 Push to ${repo}/main by ${pusher}: "${commitMsg}" (${commits} commits)`);

  // Start async deploy (don't block webhook response)
  deployPanel(repo, commitMsg, pusher).catch(err => {
    console.error('[deploy] Failed:', err.message);
  });

  return { status: 200, body: { message: 'Deploy started', repo, commits } };
}

async function deployPanel(repo, commitMsg, pusher) {
  const startTime = Date.now();
  const steps = [];

  try {
    // Step 1: Git pull
    steps.push('git pull');
    await execAsync('git pull origin main', { cwd: PANEL_DIR, timeout: 30000 });

    // Step 2: Install deps if package.json changed
    steps.push('npm install');
    await execAsync('npm install --prefer-offline', { cwd: PANEL_DIR, timeout: 60000 });

    // Step 3: TypeScript check
    steps.push('tsc check');
    const { stdout: tsErrors } = await execAsync('npx tsc --noEmit 2>&1 | grep "error TS" | wc -l', { cwd: PANEL_DIR, timeout: 60000 });
    const errorCount = parseInt(tsErrors.trim());
    if (errorCount > 0) {
      throw new Error(`TypeScript: ${errorCount} errors`);
    }

    // Step 4: Build
    steps.push('build');
    await execAsync('npm run build', { cwd: PANEL_DIR, timeout: 120000 });

    // Step 5: Deploy to Hetzner
    steps.push('deploy');
    await execAsync(
      `rsync -avz --delete -e "ssh -i ${SSH_KEY}" dist/ root@${REMOTE_HOST}:${REMOTE_DIR}`,
      { cwd: PANEL_DIR, timeout: 60000 }
    );

    // Step 6: Health check
    steps.push('health check');
    const health = await fetch('https://os.asystem.kg/', { signal: AbortSignal.timeout(10000) });
    if (!health.ok) throw new Error(`Health check: HTTP ${health.status}`);

    // Step 7: Restart API if server.mjs changed
    if (commitMsg.includes('api') || commitMsg.includes('server')) {
      steps.push('restart api');
      await execAsync('pm2 restart asystem-api', { timeout: 10000 });
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    const msg = `✅ *Auto-deploy complete*\n\n` +
      `📦 ${repo}/main\n` +
      `💬 ${commitMsg}\n` +
      `👤 ${pusher}\n` +
      `⏱ ${duration}s\n` +
      `✓ ${steps.join(' → ')}`;

    console.log(`[deploy] ✅ Complete in ${duration}s: ${steps.join(' → ')}`);
    await sendTelegram(msg);

  } catch (error) {
    const duration = Math.round((Date.now() - startTime) / 1000);
    const failStep = steps[steps.length - 1];

    const msg = `❌ *Auto-deploy FAILED*\n\n` +
      `📦 ${repo}/main\n` +
      `💬 ${commitMsg}\n` +
      `❌ Failed at: ${failStep}\n` +
      `🔧 ${error.message.slice(0, 200)}\n` +
      `⏱ ${duration}s`;

    console.error(`[deploy] ❌ Failed at ${failStep}:`, error.message);
    await sendTelegram(msg);
  }
}
