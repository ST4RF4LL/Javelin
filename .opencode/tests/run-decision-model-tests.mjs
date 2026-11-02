import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionModelSettingsStore, DEFAULT_DECISION_MODEL_CONFIG } from '../lib/decision-model/settings.mjs';
import { testDecisionModel } from '../lib/decision-model/client.mjs';

const execute = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'javelin-decision-model-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'decision.json');
  return { root, path, store: new DecisionModelSettingsStore({ path }) };
}
async function serve(t, handler, options) {
  const server = options ? httpsServer(options, handler) : httpServer(handler);
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { server, port: server.address().port, endpoint: `${options ? 'https' : 'http'}://127.0.0.1:${server.address().port}/v1/chat/completions` };
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
function success(res, extra = {}) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ model: 'test-model', choices: [{ message: { content: '{"ready":true}' } }], ...extra }));
}
function config(endpoint, extra = {}) { return { ...DEFAULT_DECISION_MODEL_CONFIG, endpoint, ...extra }; }
function environment(t, changes) {
  const original = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(changes)) process.env[key] = value;
  t.after(() => {
    for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
}

test('默认设置只读且不写文件；保存使用私有文件权限，公开响应不包含密钥', async t => {
  const { path, store } = await fixture(t);
  const first = await store.snapshot();
  assert.equal(first.configured, false);
  assert.equal(first.enabled, false);
  assert.equal(await store.getEnabledConfig(), null);
  assert.equal(first.api_key_configured, false);
  assert.equal(first.endpoint, DEFAULT_DECISION_MODEL_CONFIG.endpoint);
  await assert.rejects(stat(path), { code: 'ENOENT' });
  const saved = await store.update({ ...DEFAULT_DECISION_MODEL_CONFIG, api_key: 'secret-key', model: 'custom-model' });
  assert.equal(saved.configured, true);
  assert.equal(saved.enabled, false);
  assert.equal(await store.getEnabledConfig(), null);
  assert.equal(saved.api_key_configured, true);
  assert.equal(Object.hasOwn(saved, 'api_key'), false);
  assert.equal(JSON.stringify(saved).includes('secret-key'), false);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  const restored = new DecisionModelSettingsStore({ path });
  assert.equal((await restored.getPrivate()).api_key, 'secret-key');
  assert.equal(await restored.getEnabledConfig(), null);
  assert.equal((await restored.snapshot()).updated_at, saved.updated_at);
  const privateCopy = await restored.getPrivate();
  privateCopy.api_key = 'changed';
  assert.equal((await restored.getPrivate()).api_key, 'secret-key');
});

test('空白密钥显式删除，省略密钥保留；地址变更不能隐式复用旧密钥，测试表单不会保存', async t => {
  const { path, store } = await fixture(t);
  await store.update({ ...DEFAULT_DECISION_MODEL_CONFIG, api_key: 'secret-key' });
  await store.update({ model: 'second-model' });
  assert.equal((await store.getPrivate()).api_key, 'secret-key');
  const before = await readFile(path, 'utf8');
  const changed = { endpoint: 'http://127.0.0.1:1235/v1/chat/completions' };
  await assert.rejects(store.prepare(changed), { code: 'decision-model-key-required' });
  await assert.rejects(store.update(changed), { code: 'decision-model-key-required' });
  const prepared = await store.prepare({ ...changed, api_key: '' });
  assert.equal(prepared.api_key, '');
  assert.equal(await readFile(path, 'utf8'), before);
  await store.update({ ...changed, api_key: 'replacement' });
  assert.equal((await store.getPrivate()).api_key, 'replacement');
  await store.update({ api_key: '' });
  assert.equal((await store.snapshot()).api_key_configured, false);
  await store.update({ endpoint: DEFAULT_DECISION_MODEL_CONFIG.endpoint });
});

test('配置严格验证协议、地址、代理、字段和控制字符，不污染已保存配置', async t => {
  const { store } = await fixture(t);
  for (const value of [null, [], { unknown: true }, { enabled: 'true' }, { enabled: 1 }, { enabled: null }, { endpoint: 'file:///tmp/a' }, { endpoint: 'http://user:password@localhost/' }, { endpoint: 'http://localhost/#' }, { endpoint: 'http:\\localhost/' }, { endpoint: 'http://localhost/\n' }, { api_key: 'key\r\nInjected: yes' }, { api_key: false }, { model: '' }, { model: 'a\n' }, { protocol: 'unknown' }, { proxy: 'socks5://localhost:1080' }, { proxy: 'http://user:secret@localhost:8080' }, { proxy: 'http://localhost:8080/path' }]) {
    const input = value && !Array.isArray(value) ? { ...DEFAULT_DECISION_MODEL_CONFIG, ...value } : value;
    await assert.rejects(store.update(input), { statusCode: 422 }, JSON.stringify(value));
  }
  assert.equal((await store.snapshot()).configured, false);
  await store.update({ ...DEFAULT_DECISION_MODEL_CONFIG, proxy: 'http://localhost:8080' });
  assert.equal((await store.getPrivate()).proxy, 'http://localhost:8080/');
});

test('损坏的持久化设置不会把解析片段和密钥反射到错误消息', async t => {
  const { path } = await fixture(t);
  await writeFile(path, '{"api_key":"very-private-secret",bad');
  await assert.rejects(new DecisionModelSettingsStore({ path }).snapshot(), error => error.code === 'decision-model-settings-read' && !error.message.includes('very-private-secret'));
  assert.equal(await new DecisionModelSettingsStore({ path }).getEnabledConfig(), null);
});

test('并发保存按顺序保留密钥且磁盘始终是完整 JSON', async t => {
  const { store, path } = await fixture(t);
  await Promise.all([store.update({ ...DEFAULT_DECISION_MODEL_CONFIG, api_key: 'first-key', enabled: true }), store.update({ model: 'last-model' })]);
  const document = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(document.api_key, 'first-key');
  assert.equal(document.model, 'last-model');
  assert.equal(document.enabled, true);
});

test('只有有效配置且显式使能才开放私有连接，关闭及重载均保持门禁', async t => {
  const { store, path } = await fixture(t);
  for (const enabled of [false, true]) {
    await assert.rejects(store.update({ enabled }), { statusCode: 422 });
    assert.equal(await store.getEnabledConfig(), null);
  }
  await assert.rejects(stat(path), { code: 'ENOENT' });
  await store.update({ endpoint: DEFAULT_DECISION_MODEL_CONFIG.endpoint, model: 'local-decision' });
  assert.equal(await store.getEnabledConfig(), null);
  await store.update({ enabled: true });
  const active = await store.getEnabledConfig();
  assert.equal(active.model, 'local-decision');
  assert.equal(active.api_key, '');
  assert.equal(Object.hasOwn(active, 'enabled'), false);
  active.model = 'cannot-mutate-store';
  assert.equal((await store.getEnabledConfig()).model, 'local-decision');
  const restored = new DecisionModelSettingsStore({ path });
  assert.equal((await restored.snapshot()).enabled, true);
  assert.equal((await restored.getEnabledConfig()).model, 'local-decision');
  await store.update({ enabled: false });
  assert.equal(await store.getEnabledConfig(), null);
  assert.equal(await new DecisionModelSettingsStore({ path }).getEnabledConfig(), null);
  const prepared = await store.prepare({ enabled: false, model: 'manual-probe' });
  assert.equal(prepared.model, 'manual-probe');
  assert.equal(Object.hasOwn(prepared, 'enabled'), false);
  assert.equal((await store.snapshot()).enabled, false);
  await assert.rejects(store.prepare({ enabled: 'false' }), { statusCode: 422 });
});

test('旧 schema 1 配置默认不使能，缺失或无效连接字段不能借默认值成为可用配置', async t => {
  const { path } = await fixture(t);
  const legacy = { schema_version: 1, ...DEFAULT_DECISION_MODEL_CONFIG, updated_at: '2026-10-21T00:00:00Z' };
  await writeFile(path, JSON.stringify(legacy));
  const restored = new DecisionModelSettingsStore({ path });
  assert.equal((await restored.snapshot()).configured, true);
  assert.equal((await restored.snapshot()).enabled, false);
  assert.equal(await restored.getEnabledConfig(), null);
  for (const changes of [{ endpoint: undefined }, { model: undefined }, { endpoint: '' }, { model: '' }, { enabled: 'true' }]) {
    await writeFile(path, JSON.stringify({ ...legacy, enabled: true, ...changes }));
    const broken = new DecisionModelSettingsStore({ path });
    assert.equal(await broken.getEnabledConfig(), null);
    await assert.rejects(broken.snapshot(), { code: 'decision-model-settings-read' });
  }
});

test('OpenAI 探针只发送固定连接样例，传递密钥，显式直连忽略环境代理', async t => {
  environment(t, { http_proxy: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '' });
  let received;
  const { endpoint } = await serve(t, async (req, res) => {
    received = { body: await body(req), authorization: req.headers.authorization, method: req.method };
    success(res, { usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12, secret: 'private-key' } });
  });
  const result = await testDecisionModel(config(endpoint, { api_key: 'private-key' }));
  assert.equal(received.authorization, 'Bearer private-key');
  assert.equal(received.method, 'POST');
  assert.equal(received.body.model, 'startlux-decision-4b');
  assert.equal(received.body.stream, false);
  assert.equal(received.body.messages.length, 2);
  assert.deepEqual(result.result, { ready: true });
  assert.equal(result.ok, true);
  assert.equal(result.response_model, 'test-model');
  assert.deepEqual(result.usage, { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 });
  assert.equal(JSON.stringify(result).includes('private-key'), false);
});

test('System One 探针构造 Noul 请求并严格校验结构和数值', async t => {
  let answer = { type: 'noul', noul: 0.99 }, sent;
  const { endpoint } = await serve(t, async (req, res) => {
    sent = await body(req);
    res.end(JSON.stringify({ answers: { ready: answer } }));
  });
  const result = await testDecisionModel(config(endpoint, { protocol: 'systemone' }));
  assert.equal(sent.state, 'The connection marker is READY.');
  assert.equal(sent.questions.ready.type, 'noul');
  assert.deepEqual(result.result, { noul: 0.99 });
  for (const invalid of [{ type: 'noul', noul: true }, { type: 'noul', noul: 2 }, { type: 'score', noul: 0.9 }, null]) {
    answer = invalid;
    await assert.rejects(testDecisionModel(config(endpoint, { protocol: 'systemone' })), { code: 'decision-model-response-invalid' });
  }
});

test('HTTP 200 的错误对象、空响应、错误内容和无效 JSON 都不能作为连接成功', async t => {
  let output = '';
  const { endpoint } = await serve(t, (_req, res) => res.end(output));
  for (const response of ['', '<html>secret-key</html>', '{}', JSON.stringify({ error: { message: 'secret-key' } }), JSON.stringify({ choices: [{ message: { content: '{"ready":false}' } }] }), JSON.stringify({ choices: [{ message: { content: '' } }] })]) {
    output = response;
    await assert.rejects(testDecisionModel(config(endpoint, { api_key: 'secret-key' })), error => error.code === 'decision-model-response-invalid' && !error.message.includes('secret-key'));
  }
});

test('HTTP 错误消息不包含上游内容，重定向不会携带密钥继续请求', async t => {
  let redirected = 0, status = 302;
  const target = await serve(t, (_req, res) => { redirected += 1; success(res); });
  const { endpoint } = await serve(t, (_req, res) => {
    res.writeHead(status, { location: target.endpoint });
    res.end('secret-key upstream private diagnostic');
  });
  for (const next of [302, 401, 403, 404, 429, 500]) {
    status = next;
    await assert.rejects(testDecisionModel(config(endpoint, { api_key: 'secret-key' })), error => error.code === 'decision-model-http-error' && error.message.includes(String(status)) && !error.message.includes('secret-key'));
  }
  assert.equal(redirected, 0);
});

test('显式 HTTP 代理生效，环境 NO_PROXY 不能绕过用户选择的代理', async t => {
  environment(t, { NO_PROXY: '*', no_proxy: '*' });
  let url, auth;
  const proxy = await serve(t, async (req, res) => {
    url = req.url;
    auth = req.headers.authorization;
    await body(req);
    success(res);
  });
  const endpoint = 'http://model.invalid/v1/chat/completions';
  const result = await testDecisionModel(config(endpoint, { proxy: `http://127.0.0.1:${proxy.port}`, api_key: 'proxy-request-key' }));
  assert.equal(result.ok, true);
  assert.equal(url, endpoint);
  assert.equal(auth, 'Bearer proxy-request-key');
});

test('HTTPS 经 HTTP 代理使用 CONNECT，代理握手不携带模型密钥', async t => {
  const { root } = await fixture(t);
  const keyPath = join(root, 'key.pem'), certPath = join(root, 'cert.pem');
  try {
    await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { timeout: 10000 });
  } catch (error) {
    if (error.code === 'ENOENT') { t.skip('HTTPS 本地证书测试需要 openssl'); return; }
    throw error;
  }
  environment(t, { CURL_CA_BUNDLE: certPath, NO_PROXY: '*', no_proxy: '*' });
  let authorization, connectHeaders, connectAddress;
  const target = await serve(t, async (req, res) => {
    authorization = req.headers.authorization;
    await body(req);
    success(res);
  }, { key: await readFile(keyPath), cert: await readFile(certPath) });
  const proxy = await serve(t, (_req, res) => { res.writeHead(500); res.end(); });
  proxy.server.on('connect', (req, socket, head) => {
    connectHeaders = req.headers;
    connectAddress = req.url;
    const upstream = connect(target.port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    socket.on('close', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  const result = await testDecisionModel(config(target.endpoint, { proxy: `http://127.0.0.1:${proxy.port}`, api_key: 'tunneled-private-key' }));
  assert.equal(result.ok, true);
  assert.equal(connectAddress, `127.0.0.1:${target.port}`);
  assert.equal(connectHeaders.authorization, undefined);
  assert.equal(authorization, 'Bearer tunneled-private-key');
});

test('整请求有截止时间，超时终止自己的请求；响应体有 1 MiB 上限', async t => {
  const hanging = await serve(t, () => {});
  const started = Date.now();
  await assert.rejects(testDecisionModel(config(hanging.endpoint), { timeoutMs: 80 }), { code: 'decision-model-timeout', statusCode: 504 });
  assert.ok(Date.now() - started < 3000);
  const oversized = await serve(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('x'.repeat(1024 * 1024 + 100)); });
  await assert.rejects(testDecisionModel(config(oversized.endpoint)), { code: 'decision-model-response-too-large' });
});

test('密钥中的引号和反斜线不会注入 curl 配置，响应模型字段也隐藏已知密钥', async t => {
  const api_key = 'private"key\\value';
  let authorization;
  const { endpoint } = await serve(t, async (req, res) => {
    authorization = req.headers.authorization;
    await body(req);
    success(res, { model: `echo-${api_key}` });
  });
  const result = await testDecisionModel(config(endpoint, { api_key }));
  assert.equal(authorization, `Bearer ${api_key}`);
  assert.equal(result.response_model, 'echo-[已隐藏]');
});

test('缺少 curl 时返回可操作中文错误，不暴露连接参数', async t => {
  const { root } = await fixture(t);
  environment(t, { PATH: root });
  await assert.rejects(testDecisionModel(config('http://127.0.0.1:1/v1/chat/completions', { api_key: 'secret-key' })), error => {
    assert.equal(error.code, 'decision-model-curl-missing');
    assert.match(error.message, /安装 curl.*PATH/);
    assert.equal(error.message.includes('secret-key'), false);
    return true;
  });
});

test('API 地址中的花括号和方括号不会展开为多个请求', async t => {
  const urls = [];
  const target = await serve(t, async (req, res) => {
    urls.push(req.url);
    await body(req);
    success(res);
  });
  const endpoint = `http://127.0.0.1:${target.port}/v1/[1-3]/chat/completions?route={a,b}`;
  const result = await testDecisionModel(config(endpoint));
  assert.equal(result.ok, true);
  assert.deepEqual(urls, ['/v1/[1-3]/chat/completions?route={a,b}']);
});

test('取消只停止本次 curl 并关闭上游连接，后续测试仍可正常请求', async t => {
  let requests = 0, received;
  const incoming = new Promise(resolve => { received = resolve; });
  const target = await serve(t, async (req, res) => {
    requests += 1;
    await body(req);
    if (requests === 1) received(req.socket);
    else success(res);
  });
  const controller = new AbortController();
  const rejected = assert.rejects(testDecisionModel(config(target.endpoint), { signal: controller.signal }), {
    code: 'decision-model-test-cancelled', statusCode: 499, message: '连接测试已取消。',
  });
  const socket = await incoming;
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('取消后上游连接未关闭')), 2000);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
  });
  controller.abort('private cancellation reason must not escape');
  await Promise.all([rejected, closed]);
  assert.equal(requests, 1);
  assert.equal(socket.destroyed, true);
  assert.equal((await testDecisionModel(config(target.endpoint))).ok, true);
  assert.equal(requests, 2);
});

test('预先取消的测试不会发送请求，也不暴露取消原因', async t => {
  let requests = 0;
  const target = await serve(t, (_req, res) => { requests += 1; success(res); });
  const controller = new AbortController();
  controller.abort('private cancellation reason');
  await assert.rejects(testDecisionModel(config(target.endpoint), { signal: controller.signal }), {
    code: 'decision-model-test-cancelled', statusCode: 499, message: '连接测试已取消。',
  });
  assert.equal(requests, 0);
});
