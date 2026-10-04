import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createWorkbenchUiHandler, normalizeModernOrigin } from '../web/dynamic-validation-observatory/workbench-ui.mjs';

async function withServer(origin, run) {
  const handler = createWorkbenchUiHandler(origin);
  const server = createServer((req, res) => {
    if (handler(req, res, new URL(req.url, 'http://fixture'))) return;
    if (req.url === '/') { res.end('原工作台'); return; }
    res.writeHead(404); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('默认不开放新版入口，原首页不受影响', () => withServer(null, async base => {
  assert.deepEqual(await (await fetch(`${base}/api/v1/workbench-ui`)).json(), { modernUrl: null });
  assert.equal((await fetch(`${base}/workbench`)).status, 404);
  assert.equal(await (await fetch(base)).text(), '原工作台');
}));
test('入口由服务端开启；查询参数不能替换跳转目标，写请求不跳转', () => withServer('http://127.0.0.1:4181', async base => {
  assert.deepEqual(await (await fetch(`${base}/api/v1/workbench-ui`)).json(), { modernUrl: '/workbench' });
  const response = await fetch(`${base}/workbench?next=https://unrelated.invalid`, { redirect: 'manual' });
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), 'http://127.0.0.1:4181/');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${base}/workbench`, { method: 'POST', redirect: 'manual' })).status, 404);
  assert.equal(await (await fetch(base)).text(), '原工作台');
}));
test('入口配置拒绝脚本协议、凭据和非 origin 地址', () => {
  for (const value of ['javascript:alert(1)', 'file:///tmp/a', 'https://a.invalid/path', 'http://u:p@a.invalid', 'http://a.invalid?next=1', 'http://a.invalid/#fragment', '/relative']) assert.throws(() => normalizeModernOrigin(value));
  assert.equal(normalizeModernOrigin('https://example.invalid/'), 'https://example.invalid');
});

test('原服务实际路由保持首页与只读模式，显式开关提供新版入口', async () => {
  const { createAuditWorkbenchServer, parseArgs } = await import('../web/dynamic-validation-observatory/server.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'workbench-ui-'));
  const server = createAuditWorkbenchServer({ stateRoot: join(root, 'audits'), runtimeRoot: join(root, 'runtime'), modernWorkbenchOrigin: 'http://127.0.0.1:4181' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.runner.enabled, false); assert.equal(health.dynamic_runner.enabled, false);
    assert.equal(health.workbench_ui.modernUrl, '/workbench');
    assert.match(await (await fetch(base)).text(), /源码审计工作台/);
    const handoff = await fetch(`${base}/workbench`, { redirect: 'manual' });
    assert.equal(handoff.status, 302); assert.equal(handoff.headers.get('location'), 'http://127.0.0.1:4181/');
    assert.equal((await fetch(`${base}/api/v1/findings?live=1`)).status, 200);
    const options = parseArgs(['--modern-ui-origin', 'http://127.0.0.1:4181']);
    assert.equal(options.modernWorkbenchOrigin, 'http://127.0.0.1:4181'); assert.equal(options.runnerEnabled, false);
    assert.throws(() => parseArgs(['--modern-ui-origin']), /需要/);
  } finally { await server.shutdownRunners(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
