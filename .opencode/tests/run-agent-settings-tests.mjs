import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { AgentSettingsStore, GrowModelCatalog, GrowModelSettingsStore, normalizeAgentCommand } from '../lib/audit-runtime/agent-settings.mjs';
import { createAuditWorkbenchServer } from '../web/dynamic-validation-observatory/server.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'javelin-agent-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], lookups = [];
  const store = new AgentSettingsStore({ path: join(root, 'agents.json'), home: root, environment: {},
    resolveCommand: async command => { lookups.push(command); return command === 'missing' ? null : command; },
    probe: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: args.includes('--help') ? '--server --standalone' : command.includes('opencode2') ? 'opencode v2.0.29\n' : command.includes('grow') ? 'Grow 2.2.2' : '1.16.19' };
    },
  });
  return { root, store, calls, lookups };
}

test('旧设置未配置启用开关时沿用原有三个基座', async t => {
  const { root } = await fixture(t);
  const path = join(root, 'legacy-agents.json');
  await writeFile(path, JSON.stringify({ schema_version: 1, default_engine: 'grow', commands: { opencode: 'opencode', 'opencode-v2': 'opencode2', grow: 'grow' } }));
  const settings = await new AgentSettingsStore({ path }).get();
  assert.equal(settings.default_engine, 'grow');
  assert.deepEqual(settings.enabled, { opencode: true, 'opencode-v2': true, grow: true });
});

test('停用允许空路径并持久化，不解析或检测停用程序，重新启用需要有效路径', async t => {
  const { root, store, calls, lookups } = await fixture(t);
  await store.resolve('grow');
  calls.length = 0; lookups.length = 0;
  await store.update({ enabled: { grow: false, 'opencode-v2': false }, commands: { grow: '   ', 'opencode-v2': '' } });
  const restored = await new AgentSettingsStore({ path: join(root, 'agents.json') }).get();
  assert.equal(restored.enabled.grow, false); assert.equal(restored.commands.grow, '');
  for (const id of ['grow', 'opencode-v2']) {
    const profile = await store.resolve(id, { refresh: true });
    assert.equal(profile.enabled, false); assert.equal(profile.available, false); assert.match(profile.reason, /未启用/);
  }
  assert.equal(calls.length, 0); assert.equal(lookups.length, 0);
  const snapshot = await store.snapshot({ refresh: true });
  assert.deepEqual(calls.map(call => call.command), ['opencode']);
  assert.equal(snapshot.profiles.filter(profile => profile.enabled).length, 1);
  await assert.rejects(store.update({ enabled: { grow: true } }), { statusCode: 422 });
  assert.equal((await store.get()).enabled.grow, false);
  await store.update({ enabled: { grow: true }, commands: { grow: 'grow' } });
  assert.equal((await store.resolve('grow')).available, true);
});

test('默认基座只使用启用项，全部关闭不回退启动，启用配置类型严格校验', async t => {
  const { store, calls, lookups } = await fixture(t);
  assert.equal((await store.update({ enabled: { opencode: false } })).default_engine, 'opencode-v2');
  assert.equal((await store.update({ default_engine: 'opencode', enabled: { 'opencode-v2': false } })).default_engine, 'grow');
  await store.update({ enabled: { grow: false }, commands: { opencode: '', 'opencode-v2': '', grow: '' } });
  assert.equal((await store.snapshot()).default_engine, null);
  assert.equal(calls.length, 0); assert.equal(lookups.length, 0);
  await assert.rejects(store.resolve(), { code: 'agent-engine-disabled' });
  for (const enabled of [null, [], false, { grow: 'false' }, { grow: 0 }, { unknown: false }]) {
    await assert.rejects(store.update({ enabled }), { statusCode: 422 });
  }
  assert.equal((await store.update({ enabled: { grow: true }, commands: { grow: 'grow' } })).default_engine, 'grow');
});

test('默认及命令持久化，读取设置不启动进程，非法命令不替换有效配置', async t => {
  const { root, store, calls } = await fixture(t);
  assert.equal((await store.get()).default_engine, 'opencode'); assert.equal(calls.length, 0);
  await store.update({ default_engine: 'grow', commands: { grow: '/Applications/Grow App/grow' } });
  const restored = new AgentSettingsStore({ path: join(root, 'agents.json') });
  assert.equal((await restored.get()).default_engine, 'grow');
  assert.equal((await restored.get()).commands.grow, '/Applications/Grow App/grow');
  for (const command of ['grow --help', 'grow;echo nope', 'grow\nother', '$(whoami)', 'cmd /c grow', '../grow', '-help']) assert.throws(() => normalizeAgentCommand(command), { statusCode: 422 });
  assert.equal(normalizeAgentCommand('C:\\Program Files\\Grow\\grow.exe'), 'C:\\Program Files\\Grow\\grow.exe');
  await assert.rejects(store.update({ default_engine: 'other' }), { statusCode: 422 });
  assert.equal((await store.get()).default_engine, 'grow');
  assert.equal(calls.length, 0);
});

test('版本探测仅执行无模型参数并隐藏Windows窗口，v1不能冒充v2，v2核对运行接口', async t => {
  const { store, calls } = await fixture(t);
  const snapshot = await store.snapshot();
  assert.ok(snapshot.profiles.every(profile => profile.available));
  assert.equal(calls.length, 4);
  for (const call of calls) { assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true); assert.ok(['--version', 'run'].includes(call.args[0])); }
  await store.snapshot(); assert.equal(calls.length, 4, '频繁读页复用有时限的探测缓存');
  await store.update({ commands: { 'opencode-v2': 'opencode' } });
  const mismatch = await store.resolve('opencode-v2');
  assert.equal(mismatch.available, false); assert.match(mismatch.reason, /不匹配/);
  await store.update({ commands: { 'opencode-v2': 'opencode2' } });
  store.probe = async (_command, args) => ({ stdout: args.includes('--help') ? '--format' : '2.0.29' });
  assert.match((await store.resolve('opencode-v2')).reason, /--server/);
});

test('v2官方版本输出及带v前缀的版本可识别，仍拒绝v1程序', async t => {
  const { store } = await fixture(t);
  for (const output of [
    { stdout: 'opencode v2.0.29\n' },
    { stdout: 'v2.0.29\n' },
    { stdout: '2.0.29\n' },
    { stderr: 'opencode v2.0.29\n' },
  ]) {
    store.probe = async (_command, args) => args.includes('--help') ? { stdout: '--server --standalone' } : output;
    const result = await store.resolve('opencode-v2', { refresh: true });
    assert.equal(result.available, true, JSON.stringify({ output, result }));
    assert.equal(result.version, '2.0.29');
  }
  store.probe = async () => ({ stdout: 'opencode v1.18.34\n' });
  const result = await store.resolve('opencode-v2', { refresh: true });
  assert.equal(result.available, false);
  assert.equal(result.version, '1.18.34');
  assert.match(result.reason, /不匹配/);
});

test('未安装及失败的版本探测明确不可用，不下载不执行任务；自定义路径不回退其他程序', async t => {
  const { store, calls } = await fixture(t);
  await store.update({ commands: { grow: 'missing' } });
  assert.equal((await store.resolve('grow')).available, false); assert.equal(calls.length, 0);
  await store.update({ commands: { grow: 'grow' } });
  store.probe = async () => { throw Object.assign(new Error('PRIVATE_OUTPUT'), { killed: true }); };
  const failed = await store.resolve('grow');
  assert.match(failed.reason, /超时/); assert.ok(!JSON.stringify(failed).includes('PRIVATE_OUTPUT'));
});

test('Grow读取TOML默认、provider模型及profile别名，复杂模型键可解析且不泄露API配置', async t => {
  const { root } = await fixture(t), config = join(root, 'grow.toml');
  await writeFile(config, '[models]\ndefault = "company/fast"\n[provider.company.options]\napi_key = "PRIVATE_API_KEY"\nbase_url = "https://private.invalid"\n[provider.company.models."model/with-slash"]\ncontext_window = 200000\n[provider.company.models.fast]\n[profiles.quick]\nmodel = "quick-alias"\n');
  const snapshot = await new GrowModelCatalog({ configPaths: [config] }).snapshot();
  assert.deepEqual(snapshot.models, ['company/fast', 'company/model/with-slash', 'quick-alias']);
  assert.equal(snapshot.sources[0].status, 'ready');
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_API_KEY'));
  assert.ok(!JSON.stringify(snapshot).includes('private.invalid'));
  const settings = new GrowModelSettingsStore({ path: join(root, 'grow-model.json') });
  await settings.update('quick-alias', snapshot.models);
  assert.equal((await new GrowModelSettingsStore({ path: settings.path }).get()).model, 'quick-alias');
  await assert.rejects(settings.update('unconfigured', snapshot.models), { statusCode: 422 });
  assert.equal((await settings.get()).model, 'quick-alias');
});

test('设置API隔离三个基座的模型，并在新建任务时冻结默认基座及模型', async t => {
  const { root, store } = await fixture(t), config = join(root, 'opencode.json'), grow = join(root, 'grow.toml');
  await writeFile(config, JSON.stringify({ provider: { fixture: { models: { v1: {}, v2: {} } } } }));
  await writeFile(grow, '[models]\ndefault="grow-fast"\n');
  const server = createAuditWorkbenchServer({ stateRoot: join(root, 'state', 'runs'), runtimeRoot: join(root, 'runtime'), platformConfigPath: config, modelConfigPaths: [config], growModelConfigPaths: [grow], agentSettingsStore: store });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await server.shutdownRunners(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, body, method = 'PUT') {
    const response = await fetch(`${base}${path}`, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json', Origin: base, 'Idempotency-Key': body.audit_id || 'engine-settings-create' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await request('/api/v1/settings/model', { model: 'fixture/v1' })).status, 200);
  assert.equal((await request('/api/v1/settings/model', { engine: 'opencode-v2', model: 'fixture/v2' })).status, 200);
  assert.equal((await request('/api/v1/settings/model', { engine: 'grow', model: 'grow-fast' })).status, 200);
  assert.equal((await request('/api/v1/settings/model')).body.model.selected_model, 'fixture/v1');
  assert.equal((await request('/api/v1/settings/model?engine=opencode-v2')).body.model.selected_model, 'fixture/v2');
  assert.equal((await request('/api/v1/settings/model?engine=grow')).body.model.selected_model, 'grow-fast');
  assert.equal((await request('/api/v1/settings/model?engine=unknown')).status, 422);
  assert.equal((await request('/api/v1/settings/agents', { default_engine: 'grow' })).body.agents.default_engine, 'grow');
  const source = join(root, 'source'); await mkdir(source); await writeFile(join(source, 'app.py'), 'pass\n');
  await server.productCatalogReady;
  const target = await server.productStore.createTarget('product-undefined', { name: 'fixture', source_scopes: [{ name: 'source', path: source }] });
  let captured, creations = 0;
  server.auditRunner.createAuditFromTarget = async input => { captured = input; creations++; return { id: 'audit-engine-default', version: 1, status: 'queued' }; };
  const created = await request('/api/v2/products/product-undefined/audits', { target_id: target.id, audit_id: 'audit-engine-default', name: 'fixture' }, 'POST');
  assert.equal(created.status, 202, JSON.stringify(created.body));
  assert.equal(captured.engine, 'grow'); assert.equal(captured.model, 'grow-fast');
  await request('/api/v1/settings/agents', { default_engine: 'opencode-v2' });
  assert.equal(captured.engine, 'grow'); assert.equal(captured.model, 'grow-fast');
  assert.equal((await store.get()).default_engine, 'opencode-v2');
  const disabled = await request('/api/v1/settings/agents', { enabled: { grow: false }, commands: { grow: '' } });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.agents.profiles.find(profile => profile.id === 'grow').enabled, false);
  const rejected = await request('/api/v2/products/product-undefined/audits', { target_id: target.id, audit_id: 'audit-disabled-grow', name: 'disabled', engine: 'grow' }, 'POST');
  assert.equal(rejected.status, 422); assert.match(JSON.stringify(rejected.body), /未启用/);
  const allOff = await request('/api/v1/settings/agents', { enabled: { opencode: false, 'opencode-v2': false }, commands: { opencode: '', 'opencode-v2': '' } });
  assert.equal(allOff.status, 200); assert.equal(allOff.body.agents.default_engine, null);
  assert.ok(allOff.body.agents.profiles.every(profile => !profile.enabled && !profile.available));
  const noEngine = await request('/api/v2/products/product-undefined/audits', { target_id: target.id, audit_id: 'audit-no-enabled-engine', name: 'disabled' }, 'POST');
  assert.equal(noEngine.status, 422); assert.match(JSON.stringify(noEngine.body), /未启用/);
  assert.equal(creations, 1, '停用及全部关闭必须在创建任务前拦截');
});
