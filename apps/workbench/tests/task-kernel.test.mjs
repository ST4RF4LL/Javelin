import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpstreamTransport } from '../build/api/server/upstream-transport.js';
import { memoryHttpRequester } from './helpers/memory-http.mjs';
import { createApp } from '../build/api/server/main.js';
import { LiveService } from '../build/api/server/live.service.js';
import { AuditRunner } from '../../../.opencode/web/dynamic-validation-observatory/audit-runner.mjs';
import { createAuditWorkbenchServer } from '../../../.opencode/web/dynamic-validation-observatory/server.mjs';
import { createTaskInput } from '../build/api/server/task-contract.js';
import { probeBackend } from '../scripts/start-platform.mjs';

test('新 API 与原产品目录、Runner 实际契约贯通：登记、创建、幂等、暂停、恢复、取消', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-kernel-')));
  const source = join(root, 'source'); const config = join(root, 'opencode.json');
  await mkdir(source); await writeFile(config, '{}'); await writeFile(join(source, 'fixture.txt'), 'isolated source fixture');
  let spawned = 0; const signals = []; let backend, app, direct;
  const names = ['WORKBENCH_MODE', 'WORKBENCH_ENABLE_TASKS', 'WORKBENCH_UPSTREAM', 'WORKBENCH_DIAGNOSTICS_DIR', 'WORKBENCH_MODEL_SOURCE'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const runner = new AuditRunner({ stateRoot: join(root, 'runs'), platformRoot: root, configPath: config, enabled: true, environment: {}, spawnProcess: () => { spawned++; throw new Error('此测试禁止启动 Agent'); } });
  const queue = { ready: Promise.resolve(), enqueueNewAudit: async () => true, shutdown: async () => {}, snapshot: async () => ({ enabled: true, items: [] }) };
  try {
    backend = createAuditWorkbenchServer({ runtimeRoot: join(root, 'runtime'), stateRoot: join(root, 'runs'), platformConfigPath: config, runner, queueScheduler: queue, modelCatalog: { snapshot: async () => ({ models: ['aliyun/qwen3.8-flash'], sources: [] }) } });
    await backend.productCatalogReady; await backend.productAudits.ready;
    const product = await backend.productStore.createProduct({ name: '隔离契约测试产品' });
    Object.assign(process.env, { WORKBENCH_MODE: 'integrated', WORKBENCH_MODEL_SOURCE: 'upstream', WORKBENCH_ENABLE_TASKS: '1', WORKBENCH_UPSTREAM: 'http://127.0.0.1:4173', WORKBENCH_DIAGNOSTICS_DIR: join(root, 'diagnostics') });
    direct = createUpstreamTransport({ http: memoryHttpRequester(backend) });
    assert.equal((await probeBackend('http://127.0.0.1:4173', direct.fetch)).runtime_build.pid, process.pid);
    const originalPage = await direct.fetch('http://127.0.0.1:4173/');
    assert.equal(originalPage.status, 200); assert.match(originalPage.headers.get('content-type'), /text\/html/); assert.match(await originalPage.text(), /源码审计工作台/);
    app = await createApp(); app.get(LiveService).transport = direct.fetch;
    const request = (path, payload, key = 'actual-kernel-fixture-key') => app.inject({ url: `/api/workbench/${path}`, ...(payload ? { method: 'POST', payload, headers: { 'Idempotency-Key': key } } : {}) });
    for (const route of ['task-products', 'task-models', 'task-runner']) { const response = await request(route); assert.equal(response.statusCode, 200, response.body); }
    const options = await request('task-options'); assert.equal(options.statusCode, 200, options.body); assert.ok(options.json().products.some(p => p.id === product.id));
    const registered = await request(`products/${product.id}/targets`, { name: '临时源码对象', path: source }); assert.equal(registered.statusCode, 201, registered.body);
    const target = registered.json(); assert.equal(target.runnable, true);
    const payload = { productId: product.id, targetId: target.id, auditId: 'audit-real-kernel-fixture', name: '隔离任务', model: 'aliyun/qwen3.8-flash', memoryMode: 'full', bacAnalysis: 'auto', miningStrategy: 'focus_area', testEnvironmentEnabled: false };
    const created = await request('audits', payload); assert.equal(created.statusCode, 201, created.body); assert.equal(created.json().status, 'queued'); assert.equal(created.json().model, 'aliyun/qwen3.8-flash'); assert.equal(created.json().targetId, target.id);
    const duplicate = await request('audits', payload); assert.equal(duplicate.statusCode, 201, duplicate.body); assert.equal(duplicate.json().id, created.json().id); assert.equal(runner.listAudits().length, 1);
    const template = { ...payload, auditId: 'audit-retry-private-fixture', name: '需要重试的任务', miningStrategy: 'api', apiInventory: 'GET /中文接口\nPOST /entries', memoryMode: 'facts_only', bacAnalysis: 'off', additionalInstructionsEnabled: true, additionalInstructions: 'PRIVATE_RETRY_NOTES\n保留末尾空格 ', testEnvironmentEnabled: true, testEnvironmentContext: 'http://isolated-target.invalid/\nPRIVATE_RETRY_ENVIRONMENT', runtimeTesting: { mode: 'INTEGRATED_TESTING', budgetMinutes: 30, identityMode: 'distinct', testInput: true, testMutation: false } };
    assert.equal((await request('audits', template, 'retry-template-key')).statusCode, 201);
    const refill = await request(`audits/${template.auditId}/retry-draft`, {});
    assert.equal(refill.statusCode, 201, refill.body);
    const { auditId: originalId, name: originalName, ...expectedDraft } = template;
    // 重试恢复的是原 Runner 保存的内容；其创建规则会去掉说明两端的空白。
    expectedDraft.additionalInstructions = (await readFile(join(root, 'runs', originalId, 'additional-instructions.txt'), 'utf8')).slice(0, -1);
    assert.deepEqual(refill.json(), { ...expectedDraft, name: `${originalName}（重试）` });
    const originalRefill = await app.inject({ url: `/api/v2/products/${product.id}/audits/${originalId}/retry-draft`, method: 'POST', payload: {} });
    assert.equal(originalRefill.statusCode, 200, originalRefill.body);
    assert.equal(originalRefill.json().test_environment_context, template.testEnvironmentContext);
    assert.equal(originalRefill.json().api_inventory, template.apiInventory);
    assert.equal(runner.listAudits().length, 2); assert.equal(spawned, 0);
    const retried = await request('audits', { ...refill.json(), auditId: 'audit-new-retry-fixture' }, 'new-retry-key');
    assert.equal(retried.statusCode, 201, retried.body); assert.notEqual(retried.json().id, originalId); assert.equal(runner.getAudit(originalId).status, 'queued');
    assert.equal((await app.inject({ url: '/api/v1/runtime/health' })).statusCode, 200);
    await writeFile(join(root, 'runs', originalId, 'test-environment.txt'), 'changed');
    assert.equal((await request(`audits/${originalId}/retry-draft`, {})).statusCode, 409);
    await runner.recordLog(runner.audits.get(payload.auditId), 'stdout', '受控的实际日志契约样例');
    const detail = await request(`audits/${payload.auditId}`); assert.equal(detail.statusCode, 200, detail.body); assert.equal(detail.json().productId, product.id); assert.equal(detail.json().runtimeTestingStatus, 'SKIPPED');
    assert.ok(detail.json().logs.length > 0);
    assert.equal((await request('audits', { ...payload, auditId: 'audit-invalid-model', model: 'missing/model' }, 'missing-model-key')).statusCode, 422);
    // 将隔离任务置为运行态并注入只记录信号的子进程替身，不执行系统命令。
    const stored = runner.audits.get(payload.auditId); stored.status = 'running';
    runner.processes.set(stored.id, { kill: signal => { signals.push(signal); return true; } });
    const pause = await request(`audits/${stored.id}/actions`, { action: 'pause', version: stored.version }, 'fixture-pause-key'); assert.equal(pause.statusCode, 201, pause.body); assert.equal(pause.json().status, 'paused');
    const outdated = await request(`audits/${stored.id}/actions`, { action: 'resume', version: created.json().version }, 'fixture-outdated-key'); assert.equal(outdated.statusCode, 412, outdated.body);
    const resume = await request(`audits/${stored.id}/actions`, { action: 'resume', version: pause.json().version }, 'fixture-resume-key'); assert.equal(resume.statusCode, 201, resume.body); assert.equal(resume.json().status, 'running');
    const cancel = await request(`audits/${stored.id}/actions`, { action: 'cancel', version: resume.json().version }, 'fixture-cancel-key'); assert.equal(cancel.statusCode, 201, cancel.body); assert.equal(cancel.json().status, 'cancelling');
    assert.deepEqual(signals, ['SIGSTOP', 'SIGCONT', 'SIGTERM']); assert.equal(spawned, 0);
  } finally {
    runner.processes.clear(); await app?.close(); direct?.close(); await backend?.shutdownRunners(); if (!backend) await runner.shutdown();
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(root, { recursive: true, force: true });
  }
});

test('真实 HTTP 编解码与实际模型目录、队列：动态任务创建返回后释放对象锁并调度一次', { timeout: 5000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-dispatch-')));
  const source = join(root, 'source'), config = join(root, 'opencode.json');
  await mkdir(source); await writeFile(config, JSON.stringify({ provider: { aliyun: { models: { 'qwen3.8-flash': {} } } } }));
  let backend, direct, dispatched = 0, finish;
  const started = new Promise(resolve => { finish = resolve; });
  const runner = new AuditRunner({ stateRoot: join(root, 'runs'), platformRoot: root, configPath: config, enabled: true, environment: {}, spawnProcess: () => { throw new Error('禁止启动真实 Agent'); } });
  // 保留真实创建、队列和对象锁，只替换最后的 Agent 启动动作。
  runner.start = async audit => { dispatched++; audit.status = 'running'; await runner.record(audit, 'audit.running', { fixture: true }); finish(); };
  try {
    backend = createAuditWorkbenchServer({ runtimeRoot: join(root, 'runtime'), stateRoot: join(root, 'runs'), platformConfigPath: config, modelConfigPaths: [config], runner });
    await backend.productCatalogReady; await backend.productAudits.ready;
    direct = createUpstreamTransport({ http: memoryHttpRequester(backend) });
    const origin = 'http://isolated-fixture.invalid';
    const call = async (path, body, key) => {
      const response = await direct.fetch(`${origin}${path}`, { signal: AbortSignal.timeout(2000), ...(body ? { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    };
    const product = await backend.productStore.createProduct({ name: '隔离调度产品' });
    const target = await backend.productStore.createTarget(product.id, { name: '隔离源码', source_scopes: [{ name: 'source', path: source }] });
    const environment = '这是用户提供的完整测试说明：\nhttp://isolated-target.invalid/\n不允许扩展到其他目标。';
    const { body } = createTaskInput({ productId: product.id, targetId: target.id, auditId: 'audit-dispatch-fixture', name: '含完整环境文本的任务', model: 'aliyun/qwen3.8-flash', testEnvironmentEnabled: true, testEnvironmentContext: environment, runtimeTesting: { mode: 'INTEGRATED_TESTING' } });
    const [created, model] = await Promise.all([
      call(`/api/v2/products/${product.id}/audits`, body, 'dispatch-fixture-key'),
      call('/api/v1/settings/model'),
    ]);
    assert.equal(created.status, 202); assert.equal(model.status, 200);
    await started;
    assert.equal(dispatched, 1); assert.equal(runner.getAudit(body.audit_id).status, 'running');
    assert.equal(runner.getAudit(body.audit_id).model, body.model);
    assert.equal(await readFile(join(root, 'runs', body.audit_id, 'test-environment.txt'), 'utf8'), `${environment}\n`);
    const duplicate = await call(`/api/v2/products/${product.id}/audits`, body, 'dispatch-fixture-key');
    assert.equal(duplicate.status, 202); assert.equal(duplicate.data.id, body.audit_id); assert.equal(dispatched, 1);
    assert.equal(backend.productStore.auditLink(body.audit_id).target_id, target.id);
    assert.equal(backend.productStore.db.prepare('SELECT COUNT(*) AS count FROM target_operation_locks').get().count, 0);
  } finally {
    direct?.close(); backend?.closeAllConnections(); await backend?.shutdownRunners(); if (!backend) await runner.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
