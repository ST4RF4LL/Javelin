import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localServiceFetch } from '../lib/audit-runtime/local-service-transport.mjs';
import { serviceHealth, ensureAuditService, SERVICE_PROTOCOL } from '../lib/audit-runtime/service-process.mjs';
import { createNativeClient } from '../lib/audit-runtime/native-client.mjs';

const ready = { service: 'opencode-audit-workbench', runtime_service: { protocol: SERVICE_PROTOCOL, ready: true } };
const reset = () => new TypeError('fetch failed PRIVATE_ERROR_MARKER', { cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }) });
async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(async () => { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); });
  return { instance, origin: `http://127.0.0.1:${instance.address().port}` };
}
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'audit-service-transport-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}

test('本机健康检查与会话调用不使用全局 fetch，保留 JSON 和服务令牌', async t => {
  let received;
  const local = await server(t, (req, res) => {
    if (req.url.endsWith('/health')) { res.end(JSON.stringify(ready)); return; }
    const chunks = [];
    req.on('data', bytes => chunks.push(bytes));
    req.on('end', () => { received = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) }; res.end('{"ok":true}'); });
  });
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('不得调用全局 fetch'); };
  try {
    assert.equal((await serviceHealth(local.origin)).service, ready.service);
    const client = createNativeClient({ connection: { origin: local.origin, token: 'private-fixture-token' } });
    assert.deepEqual(await client.call('register', { name: '本机会话' }), { ok: true });
    assert.deepEqual(received.body, { name: '本机会话' });
    assert.equal(received.headers.authorization, 'Bearer private-fixture-token');
  } finally { globalThis.fetch = original; }
});

test('环境代理断开连接时，本机后台准备仍直接连接，不重复启动 Runner', async t => {
  const local = await server(t, (_req, res) => res.end(JSON.stringify(ready)));
  let hits = 0;
  const proxy = await server(t, req => { hits++; req.socket.destroy(); });
  proxy.instance.on('connect', (_req, socket) => { hits++; socket.destroy(); });
  const serviceRoot = await directory(t);
  const code = `import {ensureAuditService} from './.opencode/lib/audit-runtime/service-process.mjs';
    let globalFailure=false; try {await fetch(${JSON.stringify(local.origin)});} catch {globalFailure=true;}
    const result=await ensureAuditService({origin:${JSON.stringify(local.origin)},serviceRoot:${JSON.stringify(serviceRoot)},spawnProcess(){throw new Error('不应创建第二个 Runner');}});
    console.log(JSON.stringify({globalFailure,ready:result.health.runtime_service.ready,started:result.started}));`;
  const supportsProxy = process.allowedNodeEnvironmentFlags.has('--use-env-proxy');
  const { stdout } = await promisify(execFile)(process.execPath, [...(supportsProxy ? ['--use-env-proxy'] : []), '--input-type=module', '-e', code], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 10000,
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxy.origin, HTTPS_PROXY: proxy.origin, http_proxy: proxy.origin, https_proxy: proxy.origin, NO_PROXY: '', no_proxy: '' },
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ready, true); assert.equal(result.started, false);
  if (supportsProxy) { assert.equal(result.globalFailure, true); assert.ok(hits > 0); }
});

test('错误说明包含地址与底层错误码，不泄漏底层消息；不把网络异常误判为空闲端口', async t => {
  const origin = 'http://127.0.0.1:49199', serviceRoot = await directory(t);
  await assert.rejects(ensureAuditService({ origin, serviceRoot, fetcher: async () => { throw reset(); }, spawnProcess() { assert.fail('不明网络错误不得启动 Runner'); } }), error => {
    assert.equal(error.reason_code, 'ECONNRESET'); assert.match(error.message, /127\.0\.0\.1:49199/);
    assert.doesNotMatch(error.message, /PRIVATE_ERROR_MARKER/); return true;
  });
  assert.equal(await serviceHealth(origin, async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error(), { code: 'ECONNREFUSED' }) }); }), null);
  await assert.rejects(serviceHealth(origin, async () => { throw new DOMException('timeout', 'TimeoutError'); }), /ETIMEDOUT/);
});

test('已知初始化阶段连接重置会在预算内继续等待，失败保留日志定位，不重启进程', async t => {
  const serviceRoot = await directory(t); let reads = 0;
  const result = await ensureAuditService({ serviceRoot, fetcher: async () => {
    reads++;
    if (reads === 2) throw reset();
    return new Response(JSON.stringify({ ...ready, runtime_service: { ...ready.runtime_service, ready: reads > 2 } }));
  }, spawnProcess() { assert.fail('不能重复启动'); } });
  assert.equal(reads, 3); assert.equal(result.started, false);
  reads = 0;
  await assert.rejects(ensureAuditService({ serviceRoot, timeoutMs: 50, fetcher: async () => {
    if (++reads > 1) throw reset();
    return new Response(JSON.stringify({ ...ready, runtime_service: { ...ready.runtime_service, ready: false } }));
  }, spawnProcess() { assert.fail('不能重复启动'); } }), /ECONNRESET.*service\.log/);
});

test('直连接口拒绝跳转、非本机地址、超限响应，并覆盖响应体超时', async t => {
  const local = await server(t, (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/unexpected' }); res.end(); return; }
    if (req.url === '/large') { res.end(Buffer.alloc(4 * 1024 * 1024 + 1)); return; }
    if (req.url === '/wait') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders(); return; }
    assert.fail('不得跟随跳转');
  });
  await assert.rejects(localServiceFetch(local.origin + '/redirect'), { code: 'AUDIT_SERVICE_REDIRECT' });
  await assert.rejects(localServiceFetch(local.origin + '/large'), { code: 'AUDIT_SERVICE_RESPONSE_LIMIT' });
  await assert.rejects(localServiceFetch(local.origin + '/wait', { signal: AbortSignal.timeout(50) }), { code: 'ABORT_ERR' });
  await assert.rejects(localServiceFetch('http://192.0.2.1:4183/'), /127\.0\.0\.1/);
  await assert.rejects(localServiceFetch('http://user:secret@127.0.0.1:4183/'), /无凭据/);
});
