import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLocalTaskModels, localModelPaths } from '../build/api/server/local-models.js';
import { LiveService } from '../build/api/server/live.service.js';
import { createApp } from '../build/api/server/main.js';

let directory;
const names = ['WORKBENCH_MODE', 'WORKBENCH_ENABLE_TASKS', 'WORKBENCH_UPSTREAM', 'WORKBENCH_DIAGNOSTICS_DIR', 'WORKBENCH_MODEL_SOURCE'];
const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
before(async () => { directory = await mkdtemp(join(tmpdir(), 'workbench-local-models-')); });
after(async () => { await rm(directory, { recursive: true, force: true }); for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
async function fixture(name) {
  const config = join(directory, `${name}.jsonc`); const settingsPath = join(directory, `${name}-selection.json`);
  await writeFile(config, '// 使用原平台的 JSONC 解析器\n{"provider":{"aliyun":{"options":{"apiKey":"PRIVATE_MODEL_KEY","baseURL":"https://fixture.invalid/v1"},"models":{"qwen3.8-flash":{},"qwen3.8-max":{},}},},}');
  await writeFile(settingsPath, JSON.stringify({ schema_version: 1, model: 'aliyun/qwen3.8-flash' }));
  return { configPaths: [config, join(directory, 'absent.json')], settingsPath };
}

test('直接读取 JSONC 模型与原平台选择，仅返回模型 ID，修改选择后立即读取新值', async () => {
  const previousStateRoot = process.env.AUDIT_WORKBENCH_STATE_ROOT;
  try {
    process.env.AUDIT_WORKBENCH_STATE_ROOT = join(directory, 'custom', 'audit-runs');
    assert.equal(localModelPaths().settingsPath, join(directory, 'custom', 'opencode-model-settings.json'));
  } finally { if (previousStateRoot === undefined) delete process.env.AUDIT_WORKBENCH_STATE_ROOT; else process.env.AUDIT_WORKBENCH_STATE_ROOT = previousStateRoot; }
  const paths = await fixture('read'); const before = await readFile(paths.configPaths[0]);
  const value = await readLocalTaskModels(paths);
  assert.deepEqual(value.models.map(m => m.value), ['default', 'aliyun/qwen3.8-flash', 'aliyun/qwen3.8-max']);
  assert.equal(value.selectedModel, 'aliyun/qwen3.8-flash'); assert.ok(!JSON.stringify(value).includes('PRIVATE_MODEL_KEY')); assert.ok(!JSON.stringify(value).includes('fixture.invalid'));
  await writeFile(paths.settingsPath, JSON.stringify({ schema_version: 1, model: 'aliyun/qwen3.8-max' }));
  assert.equal((await readLocalTaskModels(paths)).selectedModel, 'aliyun/qwen3.8-max');
  assert.deepEqual(await readFile(paths.configPaths[0]), before);
});

test('新版真实模型 API 在转发完全不可用时仍读取本机配置，不发送上游请求', async () => {
  const paths = await fixture('api');
  Object.assign(process.env, { WORKBENCH_MODE: 'integrated', WORKBENCH_ENABLE_TASKS: '1', WORKBENCH_UPSTREAM: 'http://127.0.0.1:4173', WORKBENCH_MODEL_SOURCE: 'auto', WORKBENCH_DIAGNOSTICS_DIR: directory });
  const app = await createApp(); const live = app.get(LiveService); let networkCalls = 0;
  live.localModels = () => readLocalTaskModels(paths);
  live.transport = async () => { networkCalls++; throw new Error('fixture upstream denied'); };
  try {
    const response = await app.inject({ url: '/api/workbench/task-models' });
    assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().selectedModel, 'aliyun/qwen3.8-flash');
    assert.equal(live.modelSource, 'local'); assert.equal(networkCalls, 0);
    assert.ok(!response.body.includes('PRIVATE_MODEL_KEY'));
  } finally { await app.close(); }
});

test('配置错误明确失败；缺失选择文件不创建文件，已失效的选择不静默替换', async () => {
  const paths = await fixture('invalid');
  await writeFile(paths.settingsPath, JSON.stringify({ model: 'missing/model' }));
  assert.equal((await readLocalTaskModels(paths)).selectedModel, 'missing/model');
  await writeFile(paths.settingsPath, 'PRIVATE_INVALID_SETTINGS');
  await assert.rejects(readLocalTaskModels(paths), e => e.getStatus() === 503 && !e.message.includes('PRIVATE_INVALID_SETTINGS'));
  await rm(paths.settingsPath);
  assert.equal((await readLocalTaskModels(paths)).selectedModel, 'default');
  await assert.rejects(access(paths.settingsPath), { code: 'ENOENT' });
  await writeFile(paths.configPaths[0], 'PRIVATE_INVALID_CONFIG');
  await assert.rejects(readLocalTaskModels(paths), e => e.getStatus() === 503 && !e.message.includes('PRIVATE_INVALID_CONFIG'));
});

test('自定义上游和显式转发继续使用该上游的模型，不混用本机目录', async () => {
  for (const [origin, mode] of [['https://fixture.invalid', 'auto'], ['http://127.0.0.1:4173', 'upstream']]) {
    process.env.WORKBENCH_UPSTREAM = origin; process.env.WORKBENCH_MODEL_SOURCE = mode;
    const live = new LiveService();
    live.localModels = async () => { throw new Error('不应读取本机配置'); };
    live.transport = async url => { assert.equal(url, `${origin}/api/v1/settings/model`); return new Response(JSON.stringify({ model: { selected_model: 'remote/model', options: [{ value: 'remote/model', label: '远端模型' }] } })); };
    try { assert.equal(live.modelSource, 'upstream'); assert.equal((await live.taskModels()).selectedModel, 'remote/model'); }
    finally { live.onModuleDestroy(); }
  }
});
