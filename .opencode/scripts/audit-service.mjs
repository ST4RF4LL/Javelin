#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson } from '../lib/task-board/contract.mjs';
import { SERVICE_PROTOCOL, DEFAULT_SERVICE_ORIGIN, defaultServiceRoot, readServiceConnection, ensureAuditService } from '../lib/audit-runtime/service-process.mjs';

export async function startAuditService({ port = 4183, stateRoot, serviceRoot = defaultServiceRoot, modernOrigin = 'http://127.0.0.1:4181', backendOptions = {} } = {}) {
  const token = randomBytes(32).toString('hex'), generation = randomUUID();
  let backend, ready = false, stopping = false;
  // Claim the port before constructing any stateful runner or database service.
  const server = createServer((req, res) => {
    if (!ready && req.url === '/api/v1/runtime/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ service: 'opencode-audit-workbench', runtime_service: { protocol: SERVICE_PROTOCOL, generation, pid: process.pid, ready: false } }));
    }
    if (req.url === '/api/internal/service/stop' && req.method === 'POST') {
      const supplied = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (req.headers.origin || supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) { res.writeHead(403); return res.end(); }
      if (backend && (backend.auditRunner.listAudits().some(a => ['queued', 'preparing', 'running', 'recovering', 'pausing', 'paused', 'cancelling'].includes(a.status)) || backend.dynamicAuditRunner.health().active_processes)) {
        res.writeHead(409, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '仍有活动任务，请先通过任务管理结束它们。' }));
      }
      res.writeHead(202); res.end(); void close(); return;
    }
    // This process owns execution and APIs, not either web interface.
    if (!new URL(req.url, origin).pathname.startsWith('/api/')) { res.writeHead(404); return res.end('此端口仅提供审计 API'); }
    if (!backend) { res.writeHead(503, { 'Retry-After': '1' }); return res.end('审计服务正在初始化'); }
    backend.emit('request', req, res);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function close() {
    if (stopping) return; stopping = true; ready = false;
    try { await backend?.shutdownRunners(); }
    finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      try { const saved = await readServiceConnection(serviceRoot); if (saved.generation === generation) await rm(join(serviceRoot, 'connection.json'), { force: true }); } catch {}
    }
  }
  try {
    const { createAuditWorkbenchServer, parseArgs } = await import('../web/dynamic-validation-observatory/server.mjs');
    backend = createAuditWorkbenchServer({ ...parseArgs(['--enable-runner', '--modern-ui-origin', modernOrigin, ...(stateRoot ? ['--state-root', stateRoot] : [])]),
      ...backendOptions, agentAccessToken: token, runtimeService: { protocol: SERVICE_PROTOCOL, generation, pid: process.pid, get ready() { return ready; } } });
    await backend.productCatalogReady; await backend.auditRunner.ready;
    await mkdir(serviceRoot, { recursive: true, mode: 0o700 });
    await atomicJson(join(serviceRoot, 'connection.json'), { protocol: SERVICE_PROTOCOL, origin, token, generation, pid: process.pid });
    ready = true;
    return { server, backend, close, origin, generation };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = 'status', ...args] = process.argv.slice(2); const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--port': 'port', '--state-root': 'stateRoot', '--service-root': 'serviceRoot', '--modern-ui-origin': 'modernOrigin' }[args[i]];
    if (!key || !args[i + 1]) throw new Error('审计服务参数无效。'); options[key] = key === 'port' ? Number(args[i + 1]) : args[i + 1];
  }
  try {
    if (command === 'serve') {
      const service = await startAuditService(options);
      process.stdout.write(`独立审计服务已启动：${service.origin}\n`);
      for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void service.close().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }); });
    } else if (command === 'start') {
      const result = await ensureAuditService({ ...options, origin: options.port === undefined ? DEFAULT_SERVICE_ORIGIN : `http://127.0.0.1:${options.port}` });
      process.stdout.write(`${JSON.stringify({ started: result.started, pid: result.health.runtime_service?.pid })}\n`);
    } else if (['status', 'stop'].includes(command)) {
      const connection = await readServiceConnection(options.serviceRoot);
      const response = await fetch(`${connection.origin}${command === 'stop' ? '/api/internal/service/stop' : '/api/v1/runtime/health'}`, {
        method: command === 'stop' ? 'POST' : 'GET', headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!response.ok) throw new Error(command === 'stop' && response.status === 409 ? '仍有活动任务，服务未停止。' : `服务请求失败：${response.status}`);
      process.stdout.write(command === 'stop' ? '审计服务停止请求已接收。\n' : `${await response.text()}\n`);
    } else throw new Error('用法：audit-service.mjs start|serve|status|stop');
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
