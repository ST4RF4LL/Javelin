const SETTINGS_PATH = '/api/v1/settings/decision-model';
const FIELDS = ['endpoint', 'model', 'protocol', 'proxy'];

export function readDecisionModelForm(form) {
  const input = Object.fromEntries(FIELDS.map(name => [name, form.elements[name].value.trim()]));
  input.enabled = form.elements.enabled.checked;
  if (form.elements.clear_api_key.checked) input.api_key = '';
  else if (form.elements.api_key.value) input.api_key = form.elements.api_key.value;
  return input;
}

export function initDecisionModelSettingsUI({ api, toast = () => {}, document = globalThis.document, window = globalThis.window }) {
  const $ = id => document.getElementById(id);
  const form = $('decision-model-form');
  if (!form) return { refresh: async () => {}, destroy() {} };
  const controls = [...FIELDS, 'enabled', 'api_key', 'clear_api_key'].map(name => form.elements[name]);
  let disposed = false, settings = null, dirty = false, editVersion = 0;
  let loading = null, saving = null, testing = null;
  let error = '', feedback = '', testResult = null;
  const listeners = [];
  const listen = (target, type, callback) => { target.addEventListener(type, callback); listeners.push([target, type, callback]); };
  const request = milliseconds => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), milliseconds);
    return { controller, close: () => window.clearTimeout(timer) };
  };
  const cancel = operation => { operation?.controller.abort(); operation?.close(); };
  const errorText = (cause, action) => cause.name === 'TimeoutError'
    ? `${action}超时，请检查模型服务后重试。`
    : `${action}失败：${cause.message || '请求未完成，请重试。'}`;

  function render() {
    if (disposed) return;
    for (const control of controls) control.disabled = !settings || Boolean(saving);
    form.elements.api_key.disabled = !settings || Boolean(saving) || form.elements.clear_api_key.checked;
    form.elements.api_key.placeholder = settings?.api_key_configured ? '已保存，留空保留；填写可替换' : '未设置，可留空';
    $('save-decision-model').disabled = !settings || Boolean(saving || testing);
    $('test-decision-model').disabled = !settings || Boolean(saving || testing);
    $('reload-decision-model').disabled = Boolean(saving || loading || testing);
    $('save-decision-model').textContent = saving ? '保存中…' : '保存 Decision Model';
    $('test-decision-model').textContent = testing ? '测试中…' : '测试连接';
    $('decision-model-status').textContent = saving ? '保存中' : testing ? '测试中' : loading ? '读取中' : dirty ? '有未保存修改' : error ? '操作失败' : settings?.configured ? `已配置 · ${settings.enabled ? '开关已开启' : '未使能'}` : settings ? '未配置 · 未使能' : '待读取';
    $('decision-model-error').textContent = error;
    $('decision-model-error').hidden = !error;
    $('decision-model-feedback').textContent = feedback;
    $('decision-model-feedback').hidden = !feedback;
    $('decision-model-test-result').hidden = !testResult;
    $('decision-model-test-summary').textContent = testResult
      ? `接口测试通过 · ${testResult.latency_ms} ms · 请求模型：${testResult.model} · 返回模型：${testResult.response_model || '未提供'} · 协议：${testResult.protocol}` : '';
    $('decision-model-test-output').textContent = testResult ? JSON.stringify(testResult.result, null, 2) : '';
  }

  function applySettings(value) {
    for (const name of FIELDS) form.elements[name].value = value[name] ?? '';
    form.elements.enabled.checked = value.enabled === true;
    form.elements.api_key.value = '';
    form.elements.clear_api_key.checked = false;
    dirty = false;
  }

  function changed() {
    if (disposed) return;
    dirty = true;
    editVersion++;
    error = '';
    const hadTest = Boolean(testing || testResult);
    cancel(testing);
    testing = null;
    testResult = null;
    feedback = hadTest ? '配置已修改，请重新测试当前表单。' : '';
    render();
  }

  async function refresh() {
    if (disposed || saving) return;
    cancel(loading);
    const operation = request(20000), version = editVersion;
    loading = operation;
    error = '';
    render();
    try {
      const response = await api(SETTINGS_PATH, { signal: operation.controller.signal });
      if (disposed || loading !== operation) return;
      if (!response.decision_model) throw new Error('未返回 Decision Model 配置。');
      const previous = settings;
      settings = response.decision_model;
      if (previous && JSON.stringify(previous) !== JSON.stringify(settings)) {
        cancel(testing); testing = null; testResult = null; feedback = '';
      }
      if (!dirty && version === editVersion) applySettings(settings);
      else feedback = '已读取保存的配置；保留当前未保存的修改。';
    } catch (cause) {
      if (!disposed && loading === operation) error = errorText(cause, '读取配置');
    } finally {
      operation.close();
      if (!disposed && loading === operation) { loading = null; render(); }
    }
  }

  async function save(event) {
    event?.preventDefault();
    if (disposed || !settings || saving || testing || !form.reportValidity()) return;
    cancel(loading); loading = null;
    const operation = request(20000), version = editVersion;
    const input = readDecisionModelForm(form);
    saving = operation;
    error = ''; feedback = '';
    render();
    try {
      const response = await api(SETTINGS_PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: operation.controller.signal });
      if (disposed || saving !== operation) return;
      if (!response.decision_model) throw new Error('未返回保存后的配置，请重新读取核对。');
      settings = response.decision_model;
      if (version === editVersion) applySettings(settings);
      else if (form.elements.api_key.value === input.api_key) form.elements.api_key.value = '';
      feedback = dirty ? '提交的配置已保存；当前表单另有未保存的修改。' : settings.enabled
        ? '配置已保存，Decision Model 开关已开启；优化功能尚未接入，当前仍使用原流程。'
        : '配置已保存，Decision Model 未使能，任务保持原流程。';
      toast(feedback);
    } catch (cause) {
      if (!disposed && saving === operation) error = errorText(cause, '保存配置');
    } finally {
      operation.close();
      if (!disposed && saving === operation) { saving = null; render(); }
    }
  }

  async function testConnection() {
    if (disposed || !settings || saving || testing || !form.reportValidity()) return;
    const operation = request(40000), version = editVersion;
    testing = operation;
    error = ''; feedback = ''; testResult = null;
    render();
    try {
      const response = await api(`${SETTINGS_PATH}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(readDecisionModelForm(form)), signal: operation.controller.signal });
      if (disposed || testing !== operation || version !== editVersion) return;
      if (response.test?.ok !== true) throw new Error('未返回有效的测试结果。');
      testResult = response.test;
      feedback = dirty || !settings.configured ? '当前表单测试通过，配置尚未保存。测试结果不代表判断准确率。' : '当前表单测试通过。测试结果不代表判断准确率。';
    } catch (cause) {
      if (!disposed && testing === operation && version === editVersion) error = errorText(cause, '测试连接');
    } finally {
      operation.close();
      if (!disposed && testing === operation) { testing = null; render(); }
    }
  }

  function destroy() {
    if (disposed) return;
    disposed = true;
    for (const operation of [loading, saving, testing]) cancel(operation);
    loading = saving = testing = null;
    form.elements.api_key.value = '';
    for (const [target, type, callback] of listeners) target.removeEventListener(type, callback);
  }

  listen(form, 'input', changed);
  listen(form, 'change', changed);
  listen(form, 'submit', save);
  listen($('reload-decision-model'), 'click', refresh);
  listen($('test-decision-model'), 'click', testConnection);
  listen(window, 'pagehide', event => {
    if (!event.persisted) destroy();
    else if (form.elements.api_key.value) { form.elements.api_key.value = ''; changed(); }
  });
  render();
  return { refresh, destroy };
}
