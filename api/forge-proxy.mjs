// Forge HTTP CONNECT Proxy — для туннелирования AI API через Atlas/удалённые VM
import http from 'http';
import net from 'net';

const PORT = process.env.PROXY_PORT || 8899;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Forge CONNECT Proxy OK');
});

server.on('connect', (req, socket, head) => {
  const [host, portStr] = req.url.split(':');
  const port = parseInt(portStr) || 443;
  console.log(`[proxy] CONNECT ${host}:${port}`);
  const remote = net.connect(port, host, () => {
    socket.write('HTTP/1.1 200 Connection Established\r\nProxy-agent: ForgeProxy/1.0\r\n\r\n');
    if (head?.length) remote.write(head);
    remote.pipe(socket);
    socket.pipe(remote);
  });
  remote.on('error', (e) => {
    console.error(`[proxy] error ${host}:${port} — ${e.message}`);
    if (!socket.destroyed) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.destroy();
    }
  });
  socket.on('error', () => { if (!remote.destroyed) remote.destroy(); });
});

server.on('error', e => console.error('[proxy] server error:', e.message));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ForgeProxy] Listening on 0.0.0.0:${PORT}`);
});
