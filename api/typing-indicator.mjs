/**
 * Forge Typing Indicator
 * Посылает "typing" в Telegram пока есть флаг /tmp/forge-working
 * Использование: установить флаг → работа → убрать флаг
 */

import http from 'http';
import fs from 'fs';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8400727128:AAEDiXtE0P2MfUJirXtN8zDjpU9kN03ork0';
const CHAT_ID  = process.env.TELEGRAM_CHAT_ID   || '861276843';
const FLAG_FILE = '/tmp/forge-working';
const INTERVAL  = 4000; // Telegram показывает "typing" ~5 сек

async function sendTyping() {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, action: 'typing' }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (_) { /* ignore network errors */ }
}

// HTTP сервер для управления флагом
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'POST' && req.url === '/start') {
    fs.writeFileSync(FLAG_FILE, Date.now().toString());
    res.end(JSON.stringify({ ok: true, status: 'working' }));
  } else if (req.method === 'POST' && req.url === '/stop') {
    try { fs.unlinkSync(FLAG_FILE); } catch (_) {}
    res.end(JSON.stringify({ ok: true, status: 'idle' }));
  } else if (req.url === '/status') {
    const working = fs.existsSync(FLAG_FILE);
    res.end(JSON.stringify({ working }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

server.listen(5195, '127.0.0.1', () => {
  console.log('[typing-indicator] listening on http://127.0.0.1:5195');
});

// Typing loop — посылаем каждые 4 сек если флаг есть
setInterval(async () => {
  if (fs.existsSync(FLAG_FILE)) {
    await sendTyping();
  }
}, INTERVAL);

console.log('[typing-indicator] started. Flag file:', FLAG_FILE);
