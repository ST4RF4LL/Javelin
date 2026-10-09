import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../build/api/server/main.js';
import { LiveService, normalizeAudit } from '../build/api/server/live.service.js';
import { createTaskInput } from '../build/api/server/task-contract.js';
import { prepareBatchAudits, submitBatchAudits } from '../app/lib/batch-audit.ts';
import { selection as runtimeSelection } from '../../../.opencode/lib/runtime-testing/contract.mjs';
import { bacSelection } from '../../../.opencode/lib/bac/contract.mjs';
import { probeBackend } from '../scripts/start-platform.mjs';
import { runtimeBuild } from '../../../.opencode/web/dynamic-validation-observatory/runtime-build.mjs';

let app, live, directory, calls;
const envNames = ['WORKBENCH_MODE', 'WORKBENCH_ENABLE_TASKS', 'WORKBENCH_UPSTREAM', 'WORKBENCH_DIAGNOSTICS_DIR', 'WORKBENCH_MODEL_SOURCE'];
const saved = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const input = { productId: 'product-fixture', targetId: 'target-fixture', auditId: 'audit-fixture', name: '任务链路契约样例', model: 'default', miningStrategy: 'focus_area', memoryMode: 'full', bacAnalysis: 'auto' };
const audit = { id: input.auditId, name: input.name, repository_id: input.targetId, version: 7, status: 'running', provenance: { product_id: input.productId, product_name: '测试产品' }, task_protocol: 'task-board.v1' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const post = (payload, key = 'fixture-request-key') => ({ method: 'POST', payload, headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json', origin: 'http://localhost:80' } });
const request = (path, options = {}) => app.inject({ url: `/api/workbench/${path}`, ...options });
function mockTransport(handler) {
  live.transport = async (url, options = {}) => {
    const call = { url: new URL(url), method: options.method || 'GET', headers: new Headers(options.headers), body: options.body ? JSON.parse(options.body) : undefined, signal: options.signal };
    calls.push(call);
    const result = handler?.(call); if (result !== undefined) return result;
    const path = call.url.pathname;
    if (call.method === 'POST' && path.endsWith('/audits')) return json({ ...audit, status: 'queued', version: 1 }, 202);
    if (call.method === 'POST' && path.endsWith('/actions')) return json({ ...audit, status: 'paused', version: 8 }, 202);
    if (path.endsWith('/logs')) return json({ items: [{ occurred_at: '2026-10-02T10:00:00Z', body: '受控日志', kind: 'text' }] });
    if (path.endsWith(`/${audit.id}`)) return json(audit);
    if (path.endsWith('/health')) return json({ service: 'opencode-audit-workbench', runner: { enabled: true } });
    if (path.endsWith('/model')) return json({ model: { selected_model: 'default', options: [{ value: 'default', label: '默认' }] } });
    return json({ items: [], total_pages: 1 });
  };
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workbench-task-control-'));
  process.env.WORKBENCH_MODE = 'integrated'; process.env.WORKBENCH_MODEL_SOURCE = 'upstream'; process.env.WORKBENCH_ENABLE_TASKS = '1'; process.env.WORKBENCH_UPSTREAM = 'http://127.0.0.1:4173'; process.env.WORKBENCH_DIAGNOSTICS_DIR = directory;
  app = await createApp(); live = app.get(LiveService);
});
beforeEach(() => { calls = []; mockTransport(); });
after(async () => {
  await app?.close(); await rm(directory, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

test('任务入口只加载真实数据，演示和原只读入口继续隔离', async () => {
  const config = (await request('config')).json();
  assert.equal(config.liveReadOnly, false); assert.equal(config.defaultSource, 'live'); assert.equal(config.demoEnabled, false);
  assert.equal((await request('audits?source=demo', post(input))).statusCode, 403);
  process.env.WORKBENCH_ENABLE_TASKS = '0'; const readOnly = await createApp(); process.env.WORKBENCH_ENABLE_TASKS = '1';
  try {
    assert.equal((await readOnly.inject({ url: '/api/workbench/audits', ...post(input) })).statusCode, 403);
    for (const route of ['task-options', 'task-products', 'task-models', 'task-runner']) assert.equal((await readOnly.inject({ url: `/api/workbench/${route}` })).statusCode, 403);
    assert.equal((await readOnly.inject({ url: '/api/workbench/products/product-fixture/targets', ...post({ name: '源码', path: '/fixture' }) })).statusCode, 403);
  } finally { await readOnly.close(); }
  process.env.WORKBENCH_MODE = 'preview'; const preview = await createApp(); process.env.WORKBENCH_MODE = 'integrated';
  try {
    assert.equal((await preview.inject({ url: '/api/workbench/config' })).json().liveReadOnly, true);
    assert.equal((await preview.inject({ url: '/api/workbench/audits?source=live', ...post(input) })).statusCode, 403);
    assert.equal((await preview.inject({ url: '/api/workbench/audits', ...post({ name: '保留演示', repository: 'payment-service' }) })).statusCode, 201);
  } finally { await preview.close(); }
  assert.equal(calls.length, 0);
});

test('真实提交使用产品级 API、固定任务协议和幂等键，默认不授权动态测试', async () => {
  const response = await request('audits', post({ ...input, testEnvironmentEnabled: false, testEnvironmentContext: 'PRIVATE_SHOULD_NOT_FORWARD', product_id: 'forged', execution_spec: { source_scopes: [] } }));
  assert.equal(response.statusCode, 201); assert.equal(response.json().source, 'live'); assert.equal(response.json().id, input.auditId);
  const call = calls[0]; assert.equal(call.url.pathname, `/api/v2/products/${input.productId}/audits`);
  assert.equal(call.headers.get('origin'), live.origin); assert.equal(call.headers.get('idempotency-key'), 'fixture-request-key');
  assert.equal(call.body.task_protocol, 'task-board.v1'); assert.equal(call.body.target_id, input.targetId); assert.equal(call.body.audit_id, input.auditId);
  assert.equal(call.body.test_environment_enabled, false); assert.equal(call.body.test_environment_context, ''); assert.equal(runtimeSelection(call.body), null);
  assert.equal(call.body.execution_spec, undefined); assert.equal(call.body.product_id, undefined); assert.equal(calls.length, 1);
  bacSelection(call.body.bac_analysis);
});

test('空环境继续静态流程；自由文本授权完整转交，不要求固定账号格式', async () => {
  const empty = createTaskInput({ ...input, testEnvironmentEnabled: true, testEnvironmentContext: '   ', runtimeTesting: { mode: 'invalid' } }).body;
  assert.equal(empty.test_environment_enabled, false); assert.equal(empty.runtime_testing, null);
  const context = '用户授权的测试环境见说明：https://fixture.invalid\n登录方式由测试负责人提供，仅允许此产品。PRIVATE_TEST_MARKER';
  const response = await request('audits', post({ ...input, testEnvironmentEnabled: true, testEnvironmentContext: context, runtimeTesting: { mode: 'CONTACT_ONLY', budgetMinutes: 30, identityMode: 'auto', testInput: false, testMutation: false } }));
  assert.equal(response.statusCode, 201);
  assert.equal(calls[0].body.test_environment_context, context);
  const selection = runtimeSelection(calls[0].body); assert.equal(selection.protocol, 'runtime-testing.v1'); assert.equal(selection.explicit_authorization, true); assert.deepEqual(selection.allowed_actions, ['navigate', 'normal_interaction']);
  assert.ok(!response.body.includes('PRIVATE_TEST_MARKER'));
});

test('批量创建沿用产品级队列入口与配置契约，每个仓库有独立任务和幂等键', async () => {
  mockTransport(call => {
    if (call.method === 'POST' && call.url.pathname.endsWith('/audits')) return json({ ...audit, id: call.body.audit_id, name: call.body.name, repository_id: call.body.target_id, status: 'queued', version: 1 }, 202);
  });
  const config = { ...input, apiInventory: '', memoryMode: 'facts_only', additionalInstructionsEnabled: true, additionalInstructions: '共用静态审计说明', testEnvironmentEnabled: false, testEnvironmentContext: 'PRIVATE_BATCH_MUST_NOT_FORWARD', runtimeTesting: { mode: 'CONTACT_ONLY', budgetMinutes: 60, identityMode: 'auto', testInput: false, testMutation: false } };
  const items = prepareBatchAudits(config, [{ id: 'target-alpha', path: '/repos/alpha', runnable: true }, { id: 'target-beta', path: 'D:\\repos\\beta', runnable: true }]);
  const results = await submitBatchAudits(items, async (task, key) => {
    const response = await request('audits', post(task, key));
    assert.equal(response.statusCode, 201); return response.json();
  }, () => {});
  assert.ok(results.every(item => item.status === 'created' && item.audit.status === 'queued'));
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.url.pathname, `/api/v2/products/${input.productId}/audits`);
    assert.equal(call.body.audit_id, items[index].input.auditId);
    assert.equal(call.body.target_id, items[index].input.targetId);
    assert.equal(call.headers.get('idempotency-key'), items[index].key);
    assert.equal(call.body.memory_mode, 'facts_only'); assert.equal(call.body.additional_instructions, '共用静态审计说明');
    assert.equal(call.body.test_environment_enabled, false); assert.equal(call.body.test_environment_context, ''); assert.equal(runtimeSelection(call.body), null);
  }
  assert.notEqual(calls[0].body.audit_id, calls[1].body.audit_id);
});

test('API 审计支持超过旧 64 KiB 限制的清单，非法选项在请求上游之前拦截', async () => {
  const inventory = 'GET /fixture 受控测试接口\n'.repeat(3000);
  const response = await request('audits', post({ ...input, miningStrategy: 'api', apiInventory: inventory }));
  assert.equal(response.statusCode, 201); assert.equal(calls[0].body.api_inventory, inventory);
  const invalid = [ { ...input, miningStrategy: 'api', apiInventory: '' }, { ...input, productId: '../escape' }, { ...input, bacAnalysis: 'on' }, { ...input, testEnvironmentEnabled: true, testEnvironmentContext: 'test', runtimeTesting: { budgetMinutes: 2 } } ];
  calls.length = 0;
  for (const payload of invalid) assert.equal((await request('audits', post(payload))).statusCode, 400);
  assert.equal((await request('audits', post(input, ''))).statusCode, 400); assert.equal(calls.length, 0);
});

test('动作按服务端当前归属路由，带版本和幂等键；412 保持可辨识', async () => {
  mockTransport(call => call.method === 'POST' ? json({ message: '审计版本已变化，请刷新后重试。', error: 'version-mismatch' }, 412) : undefined);
  const response = await request(`audits/${audit.id}/actions`, post({ action: 'pause', version: 6, productId: 'attacker-product' }));
  assert.equal(response.statusCode, 412); assert.match(response.json().message, /版本已变化/);
  assert.equal(calls[0].url.searchParams.get('live'), '1');
  assert.equal(calls[1].url.pathname, `/api/v2/products/${input.productId}/audits/${audit.id}/actions`);
  assert.equal(calls[1].headers.get('if-match'), '"6"'); assert.equal(calls[1].headers.get('idempotency-key'), 'fixture-request-key');
  assert.deepEqual(calls[1].body, { action: 'pause' }); assert.ok(response.headers['x-request-id']);
});

test('原始未归属任务使用受原平台保护的兼容接口；非法动作不发写请求', async () => {
  mockTransport(call => call.method === 'GET' && call.url.pathname.endsWith(`/${audit.id}`) ? json({ ...audit, provenance: undefined }) : undefined);
  assert.equal((await request(`audits/${audit.id}/actions`, post({ action: 'resume', version: 7 }))).statusCode, 201);
  assert.equal(calls[1].url.pathname, `/api/v1/audits/${audit.id}/actions`);
  calls.length = 0;
  for (const body of [{ action: 'delete', version: 7 }, { action: 'pause', version: -1 }, { action: 'pause', version: '7' }]) assert.equal((await request(`audits/${audit.id}/actions`, post(body))).statusCode, 400);
  assert.equal(calls.length, 0);
});

test('超时不自动重发 POST，保留原请求键以便用户确认结果', async () => {
  mockTransport(call => { if (call.method === 'POST') throw new Error('fixture transport failure'); });
  const response = await request('audits', post(input)); assert.equal(response.statusCode, 503); assert.match(response.json().message, /未能确认/); assert.equal(calls.length, 1);
  mockTransport(); await request('audits', post(input)); assert.equal(calls[1].body.audit_id, calls[0].body.audit_id); assert.equal(calls[1].headers.get('idempotency-key'), calls[0].headers.get('idempotency-key'));
});

test('产品目录跨页读取；多源码范围、过滤规则和不可用目录不可选', async () => {
  mockTransport(call => {
    if (call.url.pathname.endsWith('/products')) return json({ items: [{ id: `product-${call.url.searchParams.get('page')}`, name: '产品', status: 'active' }], total_pages: 2 });
    if (call.url.pathname.endsWith('/targets')) return json({ items: [
      { id: 'a', name: '单目录', source_scopes: [{ path: '/fixture' }] },
      { id: 'b', name: '多目录', source_scopes: [{ path: '/a' }, { path: '/b' }] },
      { id: 'c', name: '过滤', source_scopes: [{ path: '/a', include_patterns: ['*.js'] }] },
      { id: 'd', name: '缺失', availability: 'unavailable', source_scopes: [{ path: '/a' }] },
    ] });
  });
  const options = (await request('task-options')).json(); assert.equal(options.products.length, 2); assert.equal(options.runnerEnabled, true); assert.equal(options.selectedModel, 'default');
  const targets = (await request('products/product-fixture/targets')).json(); assert.deepEqual(targets.items.map(t => t.runnable), [true, false, false, false]);
});

test('登记源码走产品范围接口，由原平台验证本机路径', async () => {
  mockTransport(call => call.method === 'POST' ? json({ id: 'target-new', name: call.body.name, source_scopes: call.body.source_scopes }, 201) : undefined);
  const result = await request('products/product-fixture/targets', post({ name: '本机源码', path: '/fixture/source', productId: 'forged' }));
  assert.equal(result.statusCode, 201); assert.equal(result.json().path, '/fixture/source'); assert.deepEqual(calls[0].body, { name: '本机源码', source_scopes: [{ name: 'source', path: '/fixture/source' }] });
});

test('跨站写入拒绝且不接触上游；失败日志读取不会伪装成无日志', async () => {
  const options = post(input); options.headers.origin = 'https://unrelated.invalid';
  assert.equal((await request('audits', options)).statusCode, 403); assert.equal(calls.length, 0);
  mockTransport(call => call.url.pathname.endsWith('/logs') ? json({ message: '日志不可用' }, 503) : undefined);
  const result = await request(`audits/${audit.id}`); assert.equal(result.statusCode, 200); assert.equal(result.json().status, 'running'); assert.match(result.json().logsError, /读取失败/);
});

test('运行与终态显示真实允许动作；动态静态状态明确', () => {
  assert.deepEqual(normalizeAudit(audit).allowedActions, ['pause', 'cancel']);
  assert.deepEqual(normalizeAudit({ ...audit, status: 'queued' }).allowedActions, ['dispatch']);
  assert.deepEqual(normalizeAudit({ ...audit, status: 'failed' }).allowedActions, ['recover']);
  assert.deepEqual(normalizeAudit({ ...audit, managed: false }).allowedActions, []);
  assert.equal(normalizeAudit(audit).runtimeTestingStatus, 'SKIPPED');
});

test('SSE 传递续读事件编号，消费者退出时释放上游连接', async () => {
  let signal;
  mockTransport(call => { signal = call.signal; return new Response('id: fixture-event-8\r\ndata: {"type":"audit.updated"}\r\n\r\n', { headers: { 'Content-Type': 'text/event-stream' } }); });
  const events = [];
  await new Promise((resolve, reject) => live.stream(audit.id, 'fixture-event-7').subscribe({ next: event => events.push(event), complete: resolve, error: reject }));
  assert.equal(calls[0].headers.get('last-event-id'), 'fixture-event-7'); assert.equal(events[0].id, 'fixture-event-8'); assert.equal(events[0].data.auditId, audit.id); assert.equal(signal.aborted, true);
});

test('诊断仅记录路由、状态、耗时和任务编号，不写入私有表单', async () => {
  await request('audits', post({ ...input, additionalInstructionsEnabled: true, additionalInstructions: 'PRIVATE_DIAGNOSTICS_MARKER' }));
  const log = await readFile(join(directory, 'requests.jsonl'), 'utf8');
  assert.ok(!log.includes('PRIVATE_DIAGNOSTICS_MARKER')); assert.ok(!log.includes('PRIVATE_TEST_MARKER')); assert.ok(!log.includes('PRIVATE_SHOULD_NOT_FORWARD'));
  const rows = log.trim().split('\n').map(line => JSON.parse(line)); assert.ok(rows.some(r => r.status === 412 && r.auditId === audit.id));
  assert.ok(rows.every(r => r.requestId && typeof r.durationMs === 'number' && !('body' in r)));
});

test('启动预检复用可运行的原平台；只读、未知服务、权限错误不会触发第二个 Runner', async () => {
  const ready = await probeBackend(live.origin, async () => json({ service: 'opencode-audit-workbench', runtime_build: runtimeBuild, runner: { enabled: true } })); assert.equal(ready.runner.enabled, true);
  for (const build of [undefined, { ...runtimeBuild, source_sha256: '0'.repeat(64) }]) {
    await assert.rejects(probeBackend(live.origin, async () => json({ service: 'opencode-audit-workbench', runtime_build: build, runner: { enabled: true } })), error => error.code === 'UPSTREAM_RESTART_REQUIRED');
  }
  await assert.rejects(probeBackend(live.origin, async () => json({ service: 'opencode-audit-workbench', runner: { enabled: false } })), /只读模式/);
  await assert.rejects(probeBackend(live.origin, async () => json({ ok: true })), /健康信息/);
  await assert.rejects(probeBackend(live.origin, async () => { throw new Error('not allowed', { cause: { code: 'EPERM' } }); }), /未启动第二个/);
  assert.equal(await probeBackend(live.origin, async () => { throw new Error('refused', { cause: { code: 'ECONNREFUSED' } }); }), null);
});

test('初始化任一依赖挂起时，其他选项仍可独立读取；超时明确指出失败项', async () => {
  const originalRead = live.read;
  // 仅缩短测试时限；路由、取消和错误转换仍使用生产代码。
  live.read = function(path, policy) { return originalRead.call(this, path, { ...policy, timeoutMs: 25 }); };
  try {
    for (const [suffix, route, label] of [['/model', 'task-models', '模型配置'], ['/products', 'task-products', '产品目录'], ['/health', 'task-runner', '执行器状态']]) {
      mockTransport(call => call.url.pathname.endsWith(suffix) ? new Promise(() => {}) : undefined);
      const pending = request(route);
      const other = await request(route === 'task-models' ? 'task-runner' : 'task-models');
      assert.equal(other.statusCode, 200, other.body);
      const failed = await pending;
      assert.equal(failed.statusCode, 503); assert.equal(failed.json().code, 'UPSTREAM_TIMEOUT'); assert.equal(failed.json().dependency, label); assert.equal(failed.json().upstreamPhase, 'headers');
      assert.match(failed.json().message, /读取超时/); assert.ok(failed.headers['x-request-id']);
    }
    mockTransport();
    assert.equal((await request('task-models')).statusCode, 200);
    assert.equal((await request('task-runner')).json().runnerEnabled, true);
  } finally { live.read = originalRead; }
});

test('收到响应头后正文一直不结束，也必须释放请求并返回有边界的错误', async () => {
  let signal;
  live.transport = async (_url, options) => { signal = options.signal; return { ok: true, json: () => new Promise(() => {}) }; };
  const start = Date.now();
  await assert.rejects(live.read('/api/v1/settings/model', { timeoutMs: 25, label: '模型配置' }), error => error.getStatus() === 503 && error.getResponse().code === 'UPSTREAM_TIMEOUT' && error.getResponse().upstreamPhase === 'body');
  assert.ok(Date.now() - start < 1000); assert.equal(signal.aborted, true);
});


test('诊断关联上游等待阶段，不记录私有正文或底层异常文本', async () => {
  live.transport = async () => { throw Object.assign(new Error('PRIVATE_ERROR_MARKER'), { code: 'ECONNRESET' }); };
  const response = await request('task-models'); assert.equal(response.statusCode, 503);
  let rows = [], entry;
  // onResponse 的异步落盘发生在 inject 返回之后，等待目标记录而非固定延时。
  const deadline = Date.now() + 1000;
  while (!entry && Date.now() < deadline) {
    rows = (await readFile(join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    entry = rows.find(row => row.requestId === response.headers['x-request-id']);
    if (!entry) await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(entry, '诊断记录应落盘');
  assert.equal(entry.upstreamPhase, 'headers'); assert.equal(entry.upstreamCode, 'ECONNRESET');
  assert.ok(!JSON.stringify(rows).includes('PRIVATE_ERROR_MARKER')); assert.ok(!response.body.includes('PRIVATE_ERROR_MARKER'));
});
