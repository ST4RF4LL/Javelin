import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../build/api/server/main.js';
import { LiveService } from '../build/api/server/live.service.js';
import { createUpstreamTransport } from '../build/api/server/upstream-transport.js';
import { inProcessRequester } from './helpers/in-process-http.mjs';
import { createAuditWorkbenchServer } from '../../../.opencode/web/dynamic-validation-observatory/server.mjs';

test('真实设置入口贯通保存、未保存配置测试、密钥隐藏及只读/跨站边界', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-decision-'));
  const names = ['WORKBENCH_MODE', 'WORKBENCH_ENABLE_TASKS', 'WORKBENCH_UPSTREAM', 'WORKBENCH_DIAGNOSTICS_DIR'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const calls = [];
  let startedWaiting, stoppedWaiting;
  const waiting = new Promise(resolve => { startedWaiting = resolve; });
  const stopped = new Promise(resolve => { stoppedWaiting = resolve; });
  const model = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    calls.push({ body: JSON.parse(text), authorization: request.headers.authorization });
    if (JSON.parse(text).model === 'wait-model') {
      response.once('close', stoppedWaiting); startedWaiting(); return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ model: 'fixture-decision', choices: [{ message: { content: '{"ready":true}' }, finish_reason: 'stop' }] }));
  });
  let backend, app, readonlyApp, direct;
  t.after(async () => {
    await readonlyApp?.close(); await app?.close(); direct?.close(); await backend?.shutdownRunners();
    if (backend?.listening) { backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(root, { recursive: true, force: true });
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const endpoint = `http://127.0.0.1:${model.address().port}/v1/chat/completions`;
  const config = join(root, 'opencode.json'), stateRoot = join(root, 'state', 'runs');
  await mkdir(join(root, 'state')); await writeFile(config, '{}');
  backend = createAuditWorkbenchServer({ stateRoot, runtimeRoot: join(root, 'runtime'), platformConfigPath: config, modelConfigPaths: [config] });
  await backend.productCatalogReady; await backend.auditRunner.ready;
  Object.assign(process.env, { WORKBENCH_MODE: 'integrated', WORKBENCH_ENABLE_TASKS: '1', WORKBENCH_UPSTREAM: 'http://127.0.0.1:4183', WORKBENCH_DIAGNOSTICS_DIR: join(root, 'diagnostics') });
  direct = createUpstreamTransport({ http: inProcessRequester(backend.listeners('request')[0]) });
  app = await createApp(); app.get(LiveService).transport = direct.fetch;
  const url = '/api/v1/settings/decision-model';
  const request = (method = 'GET', payload, suffix = '') => app.inject({ method, url: url + suffix, ...(payload === undefined ? {} : { payload, headers: { 'content-type': 'application/json' } }) });
  const initial = await request();
  assert.equal(initial.statusCode, 200, initial.body); assert.equal(initial.json().decision_model.configured, false);
  assert.equal(initial.json().decision_model.enabled, false);
  assert.equal((await request('PUT', { enabled: true })).statusCode, 422);
  assert.equal((await request()).json().decision_model.configured, false);
  const value = { endpoint, model: 'fixture-decision', protocol: 'openai', proxy: '', api_key: 'PRIVATE_FIXTURE_KEY', enabled: false };
  const stored = await request('PUT', value);
  assert.equal(stored.statusCode, 200, stored.body); assert.equal(stored.json().decision_model.api_key_configured, true);
  assert.equal(stored.json().decision_model.api_key, undefined); assert.ok(!stored.body.includes(value.api_key));
  assert.equal(stored.json().decision_model.enabled, false);
  assert.equal(calls.length, 0, '读取和保存不能启动模型推理');
  const disk = join(root, 'state', 'decision-model-settings.json');
  const before = await readFile(disk, 'utf8');
  const probe = await request('POST', { model: 'draft-model', enabled: false }, '/test');
  assert.equal(probe.statusCode, 200, probe.body); assert.equal(probe.json().test.ok, true);
  assert.equal(calls.length, 1); assert.equal(calls[0].body.model, 'draft-model'); assert.equal(calls[0].authorization, 'Bearer PRIVATE_FIXTURE_KEY');
  assert.equal(await readFile(disk, 'utf8'), before, '测试表单不得隐式保存');
  assert.equal((await request('PUT', { enabled: true })).json().decision_model.enabled, true);
  assert.equal((await request('PUT', { enabled: 'false' })).statusCode, 422);
  assert.equal((await request()).json().decision_model.enabled, true);
  assert.equal((await request('PUT', { enabled: false })).json().decision_model.enabled, false);
  assert.equal(calls.length, 1, '使能开关保存和读取不会调用模型');
  const crossSite = await app.inject({ method: 'POST', url: url + '/test', headers: { origin: 'https://unrelated.invalid' }, payload: {} });
  assert.equal(crossSite.statusCode, 403); assert.equal(calls.length, 1);
  const moved = await request('POST', { endpoint: endpoint + '/other' }, '/test');
  assert.equal(moved.statusCode, 422); assert.equal(calls.length, 1, '旧密钥不得发送至新地址');
  assert.equal((await request('PUT', { api_key: '' })).json().decision_model.api_key_configured, false);
  const asset = await app.inject({ url: '/decision-model-settings-ui.js' });
  assert.equal(asset.statusCode, 200); assert.match(asset.headers['content-type'], /javascript/);
  const page = await app.inject({ url: '/api/workbench/feature-document' });
  assert.match(page.body, /decision-model-form/);
  process.env.WORKBENCH_ENABLE_TASKS = '0'; readonlyApp = await createApp(); readonlyApp.get(LiveService).transport = direct.fetch;
  assert.equal((await readonlyApp.inject({ method: 'PUT', url, payload: { model: 'blocked' } })).statusCode, 403);
  assert.equal((await readonlyApp.inject({ method: 'POST', url: url + '/test', payload: {} })).statusCode, 403);
  assert.equal(calls.length, 1);
  assert.equal(backend.auditRunner.listAudits().length, 0, '配置和连通测试不创建审计任务');
  const log = await readFile(join(root, 'diagnostics', 'requests.jsonl'), 'utf8');
  assert.ok(!log.includes(value.api_key)); assert.ok(!log.includes('draft-model'));
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const cancellation = new AbortController();
  const pending = fetch(`http://127.0.0.1:${backend.address().port}${url}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'wait-model' }), signal: cancellation.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await waiting; cancellation.abort(); await rejected;
  let deadline;
  try { await Promise.race([stopped, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('取消后模型请求未关闭')), 2000); })]); }
  finally { clearTimeout(deadline); }
});
