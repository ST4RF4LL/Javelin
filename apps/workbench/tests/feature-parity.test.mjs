import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../build/api/server/main.js';
import { LiveService } from '../build/api/server/live.service.js';

async function fixture(run, writable = true) {
  const root = await mkdtemp(join(tmpdir(), 'workbench-parity-'));
  const env = { WORKBENCH_MODE: 'integrated', WORKBENCH_ENABLE_TASKS: writable ? '1' : '0', WORKBENCH_DIAGNOSTICS_DIR: root };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env); const app = await createApp();
  try { await run(app, app.get(LiveService)); }
  finally { await app.close(); for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value; await rm(root, { recursive: true, force: true }); }
}

test('返回入口和旧地址兼容链接均到同端口原界面；全部原页面、静态模块真实返回', () => fixture(async (app, live) => {
  live.transport = async () => { throw new Error('静态界面不依赖 4173 可达'); };
  for (const path of ['/legacy?next=https://unlisted.invalid', '/api/workbench/legacy']) {
    const response = await app.inject(path); assert.equal(response.statusCode, 302); assert.equal(response.headers.location, '/legacy/');
  }
  const page = await app.inject('/legacy/');
  assert.equal(page.statusCode, 200); assert.match(page.headers['content-type'], /text\/html/);
  assert.equal(page.body, await readFile(new URL('../../../.opencode/web/dynamic-validation-observatory/public/index.html', import.meta.url), 'utf8'));
  for (const view of ['dashboard', 'projects', 'audits', 'findings', 'reports', 'validation', 'runtime', 'settings']) assert.ok(page.body.includes(`id="view-${view}"`));
  for (const path of ['/app.js', '/product-memory-ui.js', '/styles.css', '/logo_DJ.png']) {
    const response = await app.inject(path); assert.equal(response.statusCode, 200, path); assert.ok(response.rawPayload.length > 0);
  }
  assert.equal((await app.inject('/workbench')).headers.location, '/');
  assert.equal((await app.inject('/legacy/../../opencode.json')).statusCode, 404);
}));

test('原功能转发保持方法、中文正文、版本、幂等、响应类型与二进制，跨站操作被拒绝', () => fixture(async (app, live) => {
  const calls = [], binary = Buffer.from([0x50, 0x4b, 0, 255, 13, 10]);
  live.transport = async (url, options) => {
    calls.push({ url: String(url), ...options });
    return String(url).endsWith('/export/bruno') ? new Response(binary, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="evidence.zip"' } }) : new Response(JSON.stringify({ ok: true }), { status: 202, headers: { 'Content-Type': 'application/json', ETag: '"8"' } });
  };
  const response = await app.inject({ url: '/api/v2/products/product-a/targets/target-a', method: 'PUT', headers: { Origin: 'http://localhost:80', 'If-Match': '"7"', 'Idempotency-Key': 'parity-write-key' }, payload: { name: '中文对象' } });
  assert.equal(response.statusCode, 202); assert.equal(response.headers.etag, '"8"');
  assert.equal(calls[0].method, 'PUT'); assert.equal(calls[0].headers.Origin, live.origin); assert.equal(calls[0].headers['if-match'], '"7"'); assert.equal(calls[0].headers['idempotency-key'], 'parity-write-key'); assert.deepEqual(JSON.parse(calls[0].body), { name: '中文对象' });
  const archive = await app.inject({ url: '/api/v1/http-exchanges/export/bruno', method: 'POST', payload: { exchange_ids: ['http_fixture'] } });
  assert.deepEqual(archive.rawPayload, binary); assert.match(archive.headers['content-disposition'], /evidence.zip/);
  const count = calls.length;
  assert.equal((await app.inject({ url: '/api/v2/products', method: 'POST', headers: { Origin: 'https://unlisted.invalid' }, payload: {} })).statusCode, 403);
  assert.equal(calls.length, count);
}));

test('原功能读取失败不伪造成功；只读模式不通过兼容 API 写入', async () => {
  await fixture(async (app, live) => {
    live.transport = async () => new Response('{"message":"对象不存在"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    const response = await app.inject('/api/v2/products/product-missing'); assert.equal(response.statusCode, 404); assert.equal(response.json().message, '对象不存在');
    live.transport = async () => { throw new Error('offline'); };
    const failed = await app.inject('/api/v1/runtime/health'); assert.equal(failed.statusCode, 503); assert.equal(failed.json().code, 'LEGACY_UNAVAILABLE');
  });
  await fixture(async (app, live) => {
    live.transport = async () => { throw new Error('不得发送写入'); };
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await app.inject({ url: '/api/v2/products/product-a', method, payload: {} })).statusCode, 403);
  }, false);
});

test('完整页面控制器可被导入，非原页面不自动执行或创建后台任务', async () => {
  const { mountWorkbench } = await import('../../../.opencode/web/dynamic-validation-observatory/public/app.js');
  assert.equal(typeof mountWorkbench, 'function');
});

test('动态验证动作与Bruno JSON导出在新工作台保持原始内容和文件名', () => fixture(async (app, live) => {
  const activity = { items: [{ id: 'case-one', audit_id: 'audit-one', finding_id: 'finding-one', actions: [{ id: 'action-one', tool: 'get_network_request', exchange_ids: ['http_one'] }], exchange_ids: ['http_one'] }], count: 1, exchanges: [], has_more: false };
  const collection = { version: '1', name: '中文验证记录', items: [], root: { docs: '正文缺失，仅保留历史证据。' } };
  const calls = [];
  live.transport = async (url, options) => {
    calls.push({ url: String(url), ...options });
    const exporting = String(url).includes('/export/bruno');
    return new Response(JSON.stringify(exporting ? collection : activity), { headers: { 'Content-Type': 'application/json', ...(exporting ? { 'Content-Disposition': 'attachment; filename="evidence.bruno.json"' } : {}) } });
  };
  const response = await app.inject('/api/v1/validation-activity?audit_id=audit-one');
  assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), activity);
  assert.match(calls[0].url, /validation-activity\?audit_id=audit-one$/);
  const download = await app.inject({ url: '/api/v1/http-exchanges/export/bruno', method: 'POST', payload: { exchange_ids: ['http_one'], format: 'bruno-json' } });
  assert.equal(download.statusCode, 200); assert.deepEqual(download.json(), collection);
  assert.match(download.headers['content-disposition'], /evidence\.bruno\.json/);
  assert.deepEqual(JSON.parse(calls[1].body), { exchange_ids: ['http_one'], format: 'bruno-json' });
}));

test('对象迁移后，新建重试和执行操作仍按任务原归属读取，不误写当前对象所属产品', () => fixture(async (app, live) => {
  const calls = [];
  live.transport = async (url, options) => {
    calls.push({ url: String(url), method: options.method });
    const data = options.method === 'POST' ? {} : { id: 'audit-transferred', repository_id: 'target-fixture', status: 'interrupted', version: 3, provenance: { product_id: 'product-new', audit_product_id: 'product-original' } };
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  };
  const retry = await app.inject({ url: '/api/workbench/audits/audit-transferred/retry-draft', method: 'POST', payload: {} });
  assert.equal(retry.statusCode, 201, retry.body); assert.equal(retry.json().productId, 'product-original');
  const action = await app.inject({ url: '/api/workbench/audits/audit-transferred/actions', method: 'POST', headers: { 'Idempotency-Key': 'transferred-recover-key' }, payload: { action: 'recover', version: 3 } });
  assert.equal(action.statusCode, 201, action.body);
  assert.ok(calls.filter(call => call.method === 'POST').every(call => call.url.includes('/products/product-original/audits/audit-transferred/')));
}));

test('原生事件流原样转发续读编号和事件帧，结束后释放上游连接', () => fixture(async (app, live) => {
  let signal, received;
  const frame = 'id: event-8\r\ndata: {"type":"audit.updated"}\r\n\r\n';
  live.transport = async (_url, options) => { signal = options.signal; received = options.headers; return new Response(frame, { headers: { 'Content-Type': 'text/event-stream' } }); };
  const response = await app.inject({ url: '/api/v1/audits/audit-fixture/events?after=7', headers: { 'Last-Event-ID': 'event-7' } });
  assert.equal(response.statusCode, 200); assert.equal(response.body, frame); assert.match(response.headers['content-type'], /text\/event-stream/);
  assert.equal(received['last-event-id'], 'event-7');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(signal.aborted, true);
}));
