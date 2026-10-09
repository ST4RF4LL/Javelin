import http from 'node:http';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { createTtydRuntime, checkTtyd } from './ttyd-runtime.mjs';
import { terminalPage } from './terminal-page.mjs';

export const TERMINAL_MONITOR_HOST = '127.0.0.1';
export const TERMINAL_MONITOR_ORIGINS = Object.freeze([
  'http://127.0.0.1:4181', 'http://localhost:4181',
  'http://127.0.0.1:4173', 'http://localhost:4173',
]);
const RESERVED_PORTS = new Set([4173, 4181, 4183]);
const defaultStateRoot = () => resolve(process.env.AUDIT_WORKBENCH_STATE_ROOT || fileURLToPath(new URL('../../../reports/platform/audit-runs', import.meta.url)));
export const TERMINAL_PROTOCOL = 'audit-terminal.ttyd.v1';
export const TERMINAL_BUILD = createHash('sha256').update(['start-terminal-monitor.mjs','audit-terminal-runtime.mjs','ttyd-runtime.mjs','terminal-page.mjs']
  .map(file => readFileSync(new URL(file, import.meta.url))).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0))).digest('hex');
function validPort(value, ephemeral = false) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < (ephemeral ? 0 : 1) || port > 65535 || RESERVED_PORTS.has(port)) throw new Error('终端端口必须有效，且不能占用 4173、4181 或 4183。');
  return port;
}
export function terminalMonitorConfiguration(environment = process.env) {
  return { host: TERMINAL_MONITOR_HOST, port: validPort(environment.WORKBENCH_TERMINAL_PORT ?? environment.TERMINAL_PORT ?? 4184),
    backend: 'ttyd', allowInput: true, allowShell: false, allowedOrigins: [...TERMINAL_MONITOR_ORIGINS],
    frameOrigins: [...TERMINAL_MONITOR_ORIGINS], platformUrl: 'http://127.0.0.1:4181/audits' };
}
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
export function createWorkbenchTerminalMonitor({ stateRoot = defaultStateRoot(), ...dependencies } = {}) {
  const runtime = createTtydRuntime({ stateRoot: resolve(stateRoot), ...dependencies });
  const config = { ...terminalMonitorConfiguration(), workbenchProtocol: TERMINAL_PROTOCOL, sourceSha256: TERMINAL_BUILD,
    stateRootId: createHash('sha256').update(resolve(stateRoot)).digest('hex') };
  const sockets = new Set(), upgrades = new Set();
  let closing;
  const server = http.createServer((req, res) => { void handle(req, res).catch(error => {
    if (!res.headersSent) { headers(res); json(res, error.status || 503, { error: error.status ? error.message : '终端服务暂时不可用，请重试或检查 ttyd 安装。' }); }
    else res.destroy();
  }); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, handleProtocols: protocols => protocols.has('tty') ? 'tty' : false });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  function check(req, websocket = false) {
    const port = server.address()?.port;
    if (![`${TERMINAL_MONITOR_HOST}:${port}`, `localhost:${port}`].includes(req.headers.host)) throw failure('终端 Host 不受信任。', 403);
    const origin = req.headers.origin;
    const own = [`http://${TERMINAL_MONITOR_HOST}:${port}`, `http://localhost:${port}`];
    if ((origin && ![...own, ...TERMINAL_MONITOR_ORIGINS].includes(origin)) || (!origin && websocket) ||
      (!origin && req.headers['sec-fetch-site'] === 'cross-site')) throw failure('终端连接来源不受信任。', 403);
    if (closing) throw failure('终端服务正在关闭。', 503);
    if (req.url.length > 2048) throw failure('终端地址过长。');
    return new URL(req.url, own[0]);
  }
  function headers(res, origin) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'self' ${TERMINAL_MONITOR_ORIGINS.join(' ')}`);
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  }
  function json(res, code, value) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
  function publicTarget(target) { return { auditId: target.auditId, name: target.name, kind: target.kind, readOnly: target.readOnly, generation: target.generation }; }
  function targetOptions(url) { return { generation: url.searchParams.get('generation') || undefined, readOnly: url.searchParams.get('readonly') === '1' }; }
  function workerFor(url) {
    const match = /^\/t\/([a-f0-9]{24})\/(?:|token|ws|favicon\.ico)$/.exec(url.pathname);
    if (!match || url.search) throw failure('终端路径无效。', 404);
    return runtime.get(match[1]);
  }
  const backendHeaders = worker => ({ Host: `127.0.0.1:${worker.port}`, Authorization: `Basic ${Buffer.from(worker.credential).toString('base64')}` });
  async function handle(req, res) {
    const url = check(req); headers(res, req.headers.origin);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' }); res.end(); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { ...config, port: server.address().port, pid: process.pid, ...runtime.status() });
    const api = /^\/api\/audits\/([a-z0-9][a-z0-9._-]{2,127})\/terminal$/i.exec(url.pathname);
    if (api && ['GET', 'POST'].includes(req.method)) {
      if (req.method === 'POST' && !req.headers.origin) throw failure('启动终端需要受信任的浏览器来源。', 403);
      const options = targetOptions(url), target = runtime.resolve(api[1], options);
      if (req.method === 'GET') return json(res, 200, publicTarget(target));
      const worker = await runtime.open(api[1], options);
      return json(res, 200, { ...publicTarget(worker.target), url: `${worker.basePath}/` });
    }
    const page = /^\/audits\/([a-z0-9][a-z0-9._-]{2,127})\/$/i.exec(url.pathname);
    if (req.method === 'GET' && (page || url.pathname === '/')) {
      let data = { error: '请在审计任务的“运行监控”中点击“交互终端”打开此页面。' }, code = 200;
      if (page) {
        try { const target = runtime.resolve(page[1], targetOptions(url)); data = { title: target.name, auditId: page[1], generation: target.generation }; }
        catch (error) { code = error.status || 409; data = { title: '终端当前不可用', error: error.message }; }
      }
      res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(terminalPage(data)); return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/t/')) {
      const worker = workerFor(url);
      const upstream = http.request({ hostname: '127.0.0.1', port: worker.port, path: url.pathname, headers: backendHeaders(worker), timeout: 8000 }, response => {
        if (response.statusCode !== 200) { response.resume(); json(res, 502, { error: 'ttyd 页面暂时不可用，请重连。' }); return; }
        res.writeHead(200, { 'Content-Type': response.headers['content-type'] || 'application/octet-stream', ...(response.headers['content-encoding'] ? { 'Content-Encoding': response.headers['content-encoding'] } : {}) });
        response.pipe(res);
      });
      upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
      upstream.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'ttyd 连接失败，请重连。' }); else res.destroy(); });
      res.on('close', () => upstream.destroy()); upstream.end(); return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    throw failure('终端入口不存在，请从审计任务打开。', 404);
  }
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = check(req, true), worker = workerFor(url);
      if (!url.pathname.endsWith('/ws') || req.headers['sec-websocket-protocol'] !== 'tty') throw failure('终端协议无效。');
      wss.handleUpgrade(req, socket, head, client => {
        const upstream = new WebSocket(`ws://127.0.0.1:${worker.port}${worker.basePath}/ws`, 'tty', {
          headers: { ...backendHeaders(worker), Origin: `http://127.0.0.1:${worker.port}` }, maxPayload: 1024 * 1024, handshakeTimeout: 8000 });
        const queue = []; let queued = 0, finished = false;
        function close() {
          if (finished) return; finished = true;
          worker.connections.delete(close); worker.touched = Date.now(); upgrades.delete(close);
          client.terminate(); upstream.terminate();
        }
        worker.connections.add(close); upgrades.add(close);
        client.on('error', close); upstream.on('error', close); client.on('close', close); upstream.on('close', close);
        client.on('message', (data, isBinary) => {
          // Check immediately before every frame, including input, on pause/recovery.
          if (!runtime.valid(worker)) return close();
          // A sole read-only tmux client can still resize its window despite ignore-size.
          // Keep legacy task dimensions fixed; OpenCode attach owns an independent PTY.
          if (worker.initialSize) {
            if (data[0] === 49) data = Buffer.from(`1${JSON.stringify(worker.initialSize)}`);
            else if (data[0] === 123) {
              try { data = Buffer.from(JSON.stringify({ ...JSON.parse(data.toString()), ...worker.initialSize })); }
              catch { return close(); }
            }
          }
          if (upstream.readyState === WebSocket.OPEN) {
            if (upstream.bufferedAmount > 2 * 1024 * 1024) return close();
            upstream.send(data, { binary: isBinary });
          } else if (upstream.readyState === WebSocket.CONNECTING) {
            queued += data.length; if (queued > 1024 * 1024) return close(); queue.push([data, isBinary]);
          }
        });
        upstream.on('open', () => { if (!runtime.valid(worker)) return close(); for (const [data, binary] of queue) upstream.send(data, { binary }); queue.length = 0; });
        upstream.on('message', (data, isBinary) => {
          if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > 4 * 1024 * 1024) return close();
          client.send(data, { binary: isBinary });
        });
      });
    } catch (error) { socket.end(`HTTP/1.1 ${error.status || 400} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
  });
  return { server, runtime,
    close() {
      return closing ??= (async () => {
        for (const close of upgrades) close();
        const listening = server.listening ? new Promise(done => server.close(done)) : Promise.resolve();
        for (const socket of sockets) socket.destroy();
        await runtime.close(); await listening; wss.close();
      })();
    },
  };
}
export async function startTerminalMonitor({ port = terminalMonitorConfiguration().port, ...dependencies } = {}) {
  const targetPort = validPort(port, true);
  const app = createWorkbenchTerminalMonitor(dependencies);
  try {
    await new Promise((done, fail) => { const onError = error => fail(error); app.server.once('error', onError);
      app.server.listen(targetPort, TERMINAL_MONITOR_HOST, () => { app.server.off('error', onError); done(); }); });
    return app;
  } catch (error) { await app.close(); throw error; }
}
export async function ensureWorkbenchTerminalMonitor() {
  const { port } = terminalMonitorConfiguration();
  try {
    const response = await fetch(`http://${TERMINAL_MONITOR_HOST}:${port}/api/config`, { signal: AbortSignal.timeout(2500), redirect: 'error' });
    const config = await response.json();
    if (!response.ok || config.workbenchProtocol !== TERMINAL_PROTOCOL || config.sourceSha256 !== TERMINAL_BUILD ||
      config.stateRootId !== createHash('sha256').update(defaultStateRoot()).digest('hex')) throw new Error('终端端口已被旧版或其他服务占用，请正常停止所属服务后重启平台。');
    return null;
  } catch (error) { if ((error.code || error.cause?.code) !== 'ECONNREFUSED') throw error; }
  await checkTtyd();
  return startTerminalMonitor({ port });
}
export function installTerminalMonitorShutdown(app, processTarget = process) {
  let closing;
  const shutdown = () => closing ??= Promise.resolve().then(() => app.close()).finally(() => {
    processTarget.off('SIGINT', onSignal); processTarget.off('SIGTERM', onSignal);
  });
  const onSignal = () => { void shutdown().catch(error => { processTarget.exitCode = 1; processTarget.stderr.write(`终端服务关闭失败：${error.message}\n`); }); };
  processTarget.on('SIGINT', onSignal); processTarget.on('SIGTERM', onSignal); return shutdown;
}
export async function main() {
  const configuration = terminalMonitorConfiguration(), version = await checkTtyd();
  const app = await startTerminalMonitor({ port: configuration.port });
  const shutdown = installTerminalMonitorShutdown(app);
  app.server.on('error', error => { process.stderr.write(`终端服务错误：${error.message}\n`); process.exitCode = 1; void shutdown(); });
  process.stdout.write(`审计终端监视器：http://${TERMINAL_MONITOR_HOST}:${app.server.address().port}\n终端后端：${version}，按任务启动；关闭终端不停止审计。\n`);
  return app;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { process.stderr.write(`终端服务启动失败：${error.message}\n`); process.exitCode = 1; }
}
