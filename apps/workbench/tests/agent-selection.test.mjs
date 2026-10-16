import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../build/api/server/main.js';
import { LiveService, normalizeAudit } from '../build/api/server/live.service.js';
import { createTaskInput } from '../build/api/server/task-contract.js';
import { prepareBatchAudits, submitBatchAudits } from '../app/lib/batch-audit.ts';
import { api } from '../app/lib/api.ts';

const input = { productId: 'product-fixture', targetId: 'target-fixture', auditId: 'audit-fixture', name: '基座契约样例', model: 'default', miningStrategy: 'focus_area' };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const settings = { default_engine: 'grow', commands: { opencode: 'opencode', 'opencode-v2': 'opencode-next', grow: 'grow' }, profiles: [
  { id: 'opencode', label: 'OpenCode v1', command: 'opencode', available: true, version: '1.0.0' },
  { id: 'opencode-v2', label: 'OpenCode v2', command: 'opencode-next', available: false, reason: '未安装' },
  { id: 'grow', label: 'Grow', command: 'grow', available: true, version: '0.1.0' },
] };

test('创建只允许已知基座，未选择时交给后台默认配置，明确选择随任务传递', () => {
  assert.equal(createTaskInput(input).body.engine, undefined);
  for (const engine of ['opencode', 'opencode-v2', 'grow']) {
    const body = createTaskInput({ ...input, engine }).body;
    assert.equal(body.engine, engine);
    assert.equal(body.task_protocol, 'task-board.v1');
    assert.equal(body.test_environment_enabled, false);
  }
  for (const engine of ['unknown', '', 'grow --exec', {}, ['grow']]) assert.throws(() => createTaskInput({ ...input, engine }), /任务选项无效/);
});

test('批量创建及结果待确认重试保留共同基座，不能被后续默认设置替换', async () => {
  const config = { ...input, engine: 'grow', runtimeTesting: { mode: 'CONTACT_ONLY' } };
  const items = prepareBatchAudits(config, [
    { id: 'repo-one', name: 'one', path: '/fixture/one', runnable: true },
    { id: 'repo-two', name: 'two', path: '/fixture/two', runnable: true },
  ]);
  config.engine = 'opencode-v2';
  const sent = [];
  const first = await submitBatchAudits(items, async (value, key) => { sent.push({ value, key }); throw new Error('network'); }, () => {});
  await submitBatchAudits(first, async (value, key) => { sent.push({ value, key }); return { id: value.auditId }; }, () => {});
  assert.equal(sent.length, 4);
  assert.ok(sent.every(call => call.value.engine === 'grow'));
  assert.deepEqual(sent[0], sent[2]);
  assert.deepEqual(sent[1], sent[3]);
});

test('非 v1 基座从后台读取对应模型，不读取本机 OpenCode v1 的配置', async () => {
  const live = new LiveService();
  live.localModels = async () => { throw new Error('不得混用 v1 模型配置'); };
  const calls = [];
  live.transport = async url => {
    const parsed = new URL(url); calls.push(parsed);
    const engine = parsed.searchParams.get('engine');
    return json({ model: { selected_model: `${engine}/default`, options: [{ value: `${engine}/default`, label: engine }] } });
  };
  try {
    for (const engine of ['opencode-v2', 'grow']) {
      const models = await live.taskModels(engine);
      assert.equal(models.engine, engine); assert.equal(models.selectedModel, `${engine}/default`);
    }
    assert.deepEqual(calls.map(url => url.searchParams.get('engine')), ['opencode-v2', 'grow']);
    await assert.rejects(live.taskModels('unknown'), /Agent 基座无效/);
    assert.equal(calls.length, 2);
  } finally { live.onModuleDestroy(); }
});

test('新建重试继承原任务基座，历史未标记任务回填 OpenCode v1', async () => {
  const live = new LiveService(); let auditEngine;
  live.transport = async (_url, options = {}) => json(options.method === 'POST' ? {} : {
    id: 'audit-fixture', status: 'completed', product_id: 'product-fixture', repository_id: 'target-fixture', execution: auditEngine ? { engine: auditEngine } : undefined,
  });
  try {
    for (const engine of [undefined, 'grow', 'opencode-v2']) {
      auditEngine = engine;
      assert.equal((await live.retryDraft('audit-fixture')).engine, engine || 'opencode');
    }
    assert.equal(normalizeAudit({ id: 'audit-old' }).engine, 'opencode');
    assert.equal(normalizeAudit({ id: 'audit-v2', engine: 'opencode-v2' }).engine, 'opencode-v2');
  } finally { live.onModuleDestroy(); }
});

test('浏览器模型请求绑定所选基座并传递取消信号', async t => {
  const controller = new AbortController(); let seen;
  t.mock.method(globalThis, 'fetch', async (url, options) => { seen = { url, signal: options.signal }; return json({ models: [], selectedModel: 'default' }); });
  await api.taskModels(controller.signal, 'opencode-v2');
  assert.equal(seen.url, '/api/workbench/task-models?engine=opencode-v2&source=live');
  assert.equal(seen.signal.aborted, false);
});

test('Agent 选项及设置通过同一后台契约提供，保留不可用原因并遵守只读模式', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-agent-selection-'));
  const env = { WORKBENCH_MODE: 'integrated', WORKBENCH_ENABLE_TASKS: '1', WORKBENCH_DIAGNOSTICS_DIR: directory };
  const previous = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
  Object.assign(process.env, env);
  let app, readOnly;
  try {
    app = await createApp(); const live = app.get(LiveService); const calls = [];
    live.transport = async (url, options) => { calls.push({ url: new URL(url), ...options }); return json({ agents: settings }); };
    const response = await app.inject('/api/workbench/task-agents');
    assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), settings);
    assert.equal(calls[0].url.pathname, '/api/v1/settings/agents');
    const changed = { default_engine: null, enabled: { opencode: false, 'opencode-v2': false, grow: false }, commands: { opencode: '', 'opencode-v2': '', grow: '' } };
    const saved = await app.inject({ url: '/api/v1/settings/agents', method: 'PUT', payload: changed });
    assert.equal(saved.statusCode, 200); assert.deepEqual(JSON.parse(calls[1].body), changed);
    process.env.WORKBENCH_ENABLE_TASKS = '0'; readOnly = await createApp();
    assert.equal((await readOnly.inject('/api/workbench/task-agents')).statusCode, 403);
    assert.equal((await readOnly.inject({ url: '/api/v1/settings/agents', method: 'PUT', payload: changed })).statusCode, 403);
  } finally {
    await app?.close(); await readOnly?.close();
    for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value;
    await rm(directory, { recursive: true, force: true });
  }
});
