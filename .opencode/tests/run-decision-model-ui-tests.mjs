import test from 'node:test';
import assert from 'node:assert/strict';
import { initDecisionModelSettingsUI } from '../web/dynamic-validation-observatory/public/decision-model-settings-ui.js';

class Element {
  constructor(value = '') { this.value = value; this.checked = false; this.disabled = false; this.hidden = false; this.textContent = ''; this.listeners = new Map(); }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  removeEventListener(type, callback) { if (this.listeners.get(type) === callback) this.listeners.delete(type); }
  emit(type, details = {}) { return this.listeners.get(type)?.({ preventDefault() {}, ...details }); }
  reportValidity() { return true; }
}
const saved = overrides => ({ endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'startlux-decision-4b', protocol: 'openai', proxy: '', enabled: false, api_key_configured: true, configured: true, updated_at: '2026-10-21T00:00:00Z', ...overrides });
const succeeded = overrides => ({ test: { ok: true, protocol: 'openai', model: 'startlux-decision-4b', response_model: 'startlux-decision-4b', latency_ms: 1100, result: { ready: true }, ...overrides } });

function fixture(t) {
  const form = new Element();
  form.elements = Object.fromEntries(['endpoint', 'model', 'protocol', 'proxy', 'enabled', 'api_key', 'clear_api_key'].map(name => [name, new Element()]));
  const nodes = new Map(['decision-model-status', 'decision-model-error', 'decision-model-feedback', 'decision-model-test-result', 'decision-model-test-summary', 'decision-model-test-output', 'save-decision-model', 'test-decision-model', 'reload-decision-model'].map(id => [id, new Element()]));
  nodes.set('decision-model-form', form);
  const window = Object.assign(new Element(), { setTimeout, clearTimeout });
  const calls = [], toasts = [];
  const api = (path, options = {}) => new Promise((resolve, reject) => calls.push({ path, options, resolve, reject }));
  const ui = initDecisionModelSettingsUI({ api, toast: message => toasts.push(message), document: { getElementById: id => nodes.get(id) }, window });
  t.after(() => ui.destroy());
  const change = (name, value) => { form.elements[name][['enabled', 'clear_api_key'].includes(name) ? 'checked' : 'value'] = value; form.emit('input'); };
  const load = async overrides => { const pending = ui.refresh(); calls.at(-1).resolve({ decision_model: saved(overrides) }); await pending; };
  return { form, nodes, calls, toasts, ui, change, load, window };
}

test('旧页面尚无配置表单时不阻塞工作台其他功能', async () => {
  const ui = initDecisionModelSettingsUI({ document: { getElementById: () => null }, api: () => { throw new Error('不应调用接口'); } });
  await ui.refresh(); ui.destroy();
});

test('读取不调用模型；空密钥保留，明确勾选才能清空，保存后清除输入密钥', async t => {
  const f = fixture(t);
  await f.load();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.method, undefined);
  assert.equal(f.form.elements.api_key.value, '');
  assert.match(f.form.elements.api_key.placeholder, /已保存/);
  let pending = f.form.emit('submit');
  let call = f.calls.at(-1);
  assert.equal(call.options.method, 'PUT');
  assert.equal(Object.hasOwn(JSON.parse(call.options.body), 'api_key'), false);
  call.resolve({ decision_model: saved() }); await pending;
  f.change('api_key', 'replacement-secret');
  pending = f.form.emit('submit'); call = f.calls.at(-1);
  assert.equal(JSON.parse(call.options.body).api_key, 'replacement-secret');
  assert.equal(f.form.elements.endpoint.disabled, true);
  call.resolve({ decision_model: saved() }); await pending;
  assert.equal(f.form.elements.api_key.value, '');
  assert.equal(f.form.elements.endpoint.disabled, false);
  f.change('clear_api_key', true);
  assert.equal(f.form.elements.api_key.disabled, true);
  pending = f.form.emit('submit'); call = f.calls.at(-1);
  assert.equal(JSON.parse(call.options.body).api_key, '');
  call.resolve({ decision_model: saved({ api_key_configured: false }) }); await pending;
  assert.equal(f.form.elements.clear_api_key.checked, false);
  assert.match(f.form.elements.api_key.placeholder, /未设置/);
});

test('测试发送未保存表单，不自动保存，展示耗时、返回模型和输出', async t => {
  const f = fixture(t); await f.load();
  f.change('model', 'local-new-model');
  f.change('proxy', 'http://127.0.0.1:7890');
  const pending = f.nodes.get('test-decision-model').emit('click');
  const call = f.calls.at(-1);
  assert.equal(call.path, '/api/v1/settings/decision-model/test');
  assert.equal(call.options.method, 'POST');
  assert.equal(JSON.parse(call.options.body).model, 'local-new-model');
  assert.equal(JSON.parse(call.options.body).proxy, 'http://127.0.0.1:7890');
  call.resolve(succeeded({ model: 'local-new-model', response_model: 'loaded-model' })); await pending;
  assert.equal(f.calls.length, 2);
  assert.equal(f.nodes.get('decision-model-test-result').hidden, false);
  assert.match(f.nodes.get('decision-model-test-summary').textContent, /1100 ms.*local-new-model.*loaded-model/);
  assert.deepEqual(JSON.parse(f.nodes.get('decision-model-test-output').textContent), { ready: true });
  assert.match(f.nodes.get('decision-model-feedback').textContent, /尚未保存.*不代表判断准确率/);
});

test('修改表单使在途测试失效，迟到结果不能覆盖新配置的测试', async t => {
  const f = fixture(t); await f.load();
  const old = f.nodes.get('test-decision-model').emit('click'), oldCall = f.calls.at(-1);
  f.change('model', 'next-model');
  assert.equal(oldCall.options.signal.aborted, true);
  assert.equal(f.nodes.get('decision-model-test-result').hidden, true);
  const latest = f.nodes.get('test-decision-model').emit('click'), latestCall = f.calls.at(-1);
  latestCall.resolve(succeeded({ model: 'next-model', response_model: 'next-model' })); await latest;
  oldCall.resolve(succeeded({ model: 'stale-model', response_model: 'stale-model' })); await old;
  assert.match(f.nodes.get('decision-model-test-summary').textContent, /next-model/);
  assert.doesNotMatch(f.nodes.get('decision-model-test-summary').textContent, /stale-model/);
  f.change('proxy', 'http://127.0.0.1:7890');
  assert.equal(f.nodes.get('decision-model-test-result').hidden, true);
  assert.equal(f.nodes.get('decision-model-test-output').textContent, '');
});

test('刷新保留用户编辑且丢弃旧读取；保存不被在途读取覆盖', async t => {
  const f = fixture(t); await f.load();
  const old = f.ui.refresh(), oldCall = f.calls.at(-1);
  const latest = f.ui.refresh(), latestCall = f.calls.at(-1);
  f.change('model', 'edited-model');
  latestCall.resolve({ decision_model: saved({ model: 'server-model' }) }); await latest;
  oldCall.resolve({ decision_model: saved({ model: 'stale-model' }) }); await old;
  assert.equal(f.form.elements.model.value, 'edited-model');
  assert.match(f.nodes.get('decision-model-feedback').textContent, /保留当前未保存/);
  const reading = f.ui.refresh(), readCall = f.calls.at(-1);
  const saving = f.form.emit('submit'), saveCall = f.calls.at(-1);
  assert.equal(readCall.options.signal.aborted, true);
  saveCall.resolve({ decision_model: saved({ model: 'edited-model' }) }); await saving;
  readCall.resolve({ decision_model: saved({ model: 'stale-model' }) }); await reading;
  assert.equal(f.form.elements.model.value, 'edited-model');
  assert.equal(f.nodes.get('decision-model-status').textContent, '已配置 · 未使能');
});

test('使能开关读取保存、未保存编辑保留，关闭时仍可手动测试且不自动启用', async t => {
  const f = fixture(t); await f.load();
  assert.equal(f.form.elements.enabled.checked, false);
  assert.match(f.nodes.get('decision-model-status').textContent, /未使能/);
  f.change('enabled', true);
  await f.load({ enabled: false });
  assert.equal(f.form.elements.enabled.checked, true);
  assert.match(f.nodes.get('decision-model-feedback').textContent, /保留当前未保存/);
  let pending = f.form.emit('submit'), call = f.calls.at(-1);
  assert.equal(JSON.parse(call.options.body).enabled, true);
  assert.equal(f.form.elements.enabled.disabled, true);
  call.resolve({ decision_model: saved({ enabled: true }) }); await pending;
  assert.equal(f.form.elements.enabled.disabled, false);
  assert.match(f.nodes.get('decision-model-status').textContent, /开关已开启/);
  assert.match(f.nodes.get('decision-model-feedback').textContent, /尚未接入.*原流程/);
  f.change('enabled', false);
  pending = f.form.emit('submit'); call = f.calls.at(-1);
  assert.equal(JSON.parse(call.options.body).enabled, false);
  call.resolve({ decision_model: saved() }); await pending;
  assert.match(f.nodes.get('decision-model-feedback').textContent, /未使能.*原流程/);
  pending = f.nodes.get('test-decision-model').emit('click'); call = f.calls.at(-1);
  assert.equal(JSON.parse(call.options.body).enabled, false);
  call.resolve(succeeded()); await pending;
  assert.equal(f.form.elements.enabled.checked, false);
  assert.match(f.nodes.get('decision-model-status').textContent, /未使能/);
});

test('测试错误保留可编辑配置；销毁取消请求、释放监听并清除密钥', async t => {
  const f = fixture(t); await f.load();
  f.change('endpoint', 'http://127.0.0.1:1234/new-api');
  let pending = f.nodes.get('test-decision-model').emit('click');
  f.calls.at(-1).reject(new Error('API 地址已改变，请重新填写或清除 API-key。')); await pending;
  assert.equal(f.nodes.get('decision-model-error').hidden, false);
  assert.match(f.nodes.get('decision-model-error').textContent, /请重新填写或清除/);
  assert.equal(f.form.elements.endpoint.value, 'http://127.0.0.1:1234/new-api');
  f.change('api_key', 'temporary-secret');
  pending = f.nodes.get('test-decision-model').emit('click'); const call = f.calls.at(-1);
  f.ui.destroy();
  assert.equal(call.options.signal.aborted, true);
  assert.equal(f.form.elements.api_key.value, '');
  assert.equal(f.form.listeners.size, 0);
  assert.equal(f.window.listeners.size, 0);
  call.resolve(succeeded()); await pending;
  assert.equal(f.nodes.get('decision-model-test-result').hidden, true);
});

test('未保存的默认配置测试后仍提示保存；往返缓存恢复不丢失表单监听', async t => {
  const f = fixture(t); await f.load({ configured: false, api_key_configured: false });
  let pending = f.nodes.get('test-decision-model').emit('click');
  f.calls.at(-1).resolve(succeeded()); await pending;
  assert.match(f.nodes.get('decision-model-feedback').textContent, /配置尚未保存/);
  f.change('api_key', 'do-not-cache');
  f.window.emit('pagehide', { persisted: true });
  assert.equal(f.form.elements.api_key.value, '');
  assert.equal(f.form.listeners.has('submit'), true);
  pending = f.nodes.get('test-decision-model').emit('click');
  f.calls.at(-1).resolve(succeeded()); await pending;
  assert.equal(f.nodes.get('decision-model-test-result').hidden, false);
});
