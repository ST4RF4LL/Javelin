import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';

// The public UI proxies only task-terminal routes to the fixed loopback gateway.
export function registerTerminalProxy(server: FastifyInstance, writable: boolean) {
  const port = Number(process.env.WORKBENCH_TERMINAL_PORT ?? process.env.TERMINAL_PORT ?? 4184);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || [4173, 4181, 4183].includes(port)) throw new Error('终端端口无效。');
  const origin = `http://127.0.0.1:${port}`;
  const connections = new Set<() => void>();
  function allowed(req: IncomingMessage, websocket = false) {
    const sameOrigin = req.headers.origin === `http://${req.headers.host}`;
    return writable && (req.headers.origin ? sameOrigin : !websocket && req.method === 'GET' && req.headers['sec-fetch-site'] !== 'cross-site');
  }
  function targetPath(raw: string, websocket = false) {
    if (raw.length > 2048 || !raw.startsWith('/terminal/')) return null;
    const path = raw.slice('/terminal'.length), pathname = path.split('?')[0];
    const valid = websocket ? /^\/t\/[a-f0-9]{24}\/ws$/.test(path) :
      /^\/audits\/[a-z0-9][a-z0-9._-]{2,127}\/$/i.test(pathname) ||
      /^\/api\/audits\/[a-z0-9][a-z0-9._-]{2,127}\/terminal$/i.test(pathname) ||
      /^\/t\/[a-f0-9]{24}\/(?:|token|favicon\.ico)$/.test(path);
    return valid ? path : null;
  }
  server.route({ url: '/terminal/*', method: ['GET', 'POST'], handler: async (request, reply) => {
    reply.header('X-Frame-Options', 'SAMEORIGIN').header('Cache-Control', 'no-store');
    if (!allowed(request.raw)) return reply.code(403).send({ error: '终端连接需要可写工作台及同源访问。' });
    const path = targetPath(request.raw.url || request.url);
    if (!path || (request.method === 'POST' && !path.startsWith('/api/audits/'))) return reply.code(404).send({ error: '终端入口不存在。' });
    try {
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const upstream = httpRequest({ hostname: '127.0.0.1', port, path, method: request.method,
          headers: { Origin: origin }, timeout: 15000 }, resolve);
        const close = () => upstream.destroy();
        request.raw.once('aborted', close); reply.raw.once('close', close);
        upstream.on('close', () => { request.raw.off('aborted', close); reply.raw.off('close', close); });
        upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
        upstream.on('error', reject);
        upstream.end();
      });
      reply.code(response.statusCode || 502);
      for (const name of ['content-type', 'content-encoding', 'content-security-policy', 'cache-control']) {
        const value = response.headers[name]; if (value) reply.header(name, value);
      }
      return reply.send(response);
    } catch {
      return reply.code(503).send({ error: '交互终端服务未就绪，请检查 ttyd 和平台启动日志。' });
    }
  } });
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reject = (status: number) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (!allowed(req, true)) { reject(403); return; }
    const path = targetPath(req.url || '', true);
    if (!path || req.headers['sec-websocket-protocol'] !== 'tty' || !req.headers['sec-websocket-key'] || req.headers['sec-websocket-version'] !== '13') { reject(400); return; }
    let backend: Duplex | undefined;
    const upstream = httpRequest({ hostname: '127.0.0.1', port, path, headers: {
      Origin: origin, Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Key': req.headers['sec-websocket-key'], 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Protocol': 'tty',
    }, timeout: 8000 });
    const close = () => { connections.delete(close); upstream.destroy(); backend?.destroy(); socket.destroy(); };
    connections.add(close); socket.on('error', close); socket.on('close', close);
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => { reject(503); });
    upstream.on('response', response => { response.resume(); reject(response.statusCode || 502); });
    upstream.on('upgrade', (response, peer, first) => {
      backend = peer;
      if (socket.destroyed) { close(); return; }
      upstream.setTimeout(0); peer.setTimeout(0);
      peer.on('error', close); peer.on('close', close);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${response.headers['sec-websocket-accept']}\r\nSec-WebSocket-Protocol: tty\r\n\r\n`);
      if (first.length) socket.write(first);
      if (head.length) peer.write(head);
      peer.pipe(socket); socket.pipe(peer);
    });
    upstream.end();
  };
  server.server.on('upgrade', upgrade);
  server.addHook('preClose', async () => { for (const close of connections) close(); });
  server.addHook('onClose', async () => { server.server.off('upgrade', upgrade); });
}
