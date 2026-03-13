/**
 * BlueMap Proxy — forwards HTTP requests to BlueMap on MC server
 * MC server: 100.79.117.102:8124 (via Tailscale)
 * Listens on: localhost:8126
 */
import http from 'node:http';
import net from 'node:net';

const PORT = 8126;
const MC_HOST = '100.79.117.102';
const MC_PORT = 8124;

const proxy = http.createServer((req, res) => {
  const options = {
    hostname: MC_HOST, port: MC_PORT,
    path: req.url, method: req.method,
    headers: { ...req.headers, host: `${MC_HOST}:${MC_PORT}` },
    timeout: 30000,
  };
  const upstream = http.request(options, (upRes) => {
    res.writeHead(upRes.statusCode, {
      ...upRes.headers,
      'access-control-allow-origin': '*',
    });
    upRes.pipe(res);
  });
  upstream.on('error', (e) => {
    if (!res.headersSent) { res.writeHead(502); }
    res.end(`BlueMap unavailable: ${e.message}`);
  });
  req.pipe(upstream);
});

proxy.listen(PORT, '127.0.0.1', () => {
  console.log(`[BlueMap Proxy] Listening :${PORT} → ${MC_HOST}:${MC_PORT}`);
});

proxy.on('error', (e) => console.error('[BlueMap Proxy] Error:', e.message));
