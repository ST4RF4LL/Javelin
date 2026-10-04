import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, ApiError } from '../app/lib/api.ts';

test('浏览器请求无响应或正文卡住时均结束等待，保留请求编号', async t => {
  for (const bodyStalls of [false, true]) {
    let signal;
    const mock = t.mock.method(globalThis, 'fetch', async (_url, options) => {
      signal = options.signal;
      return bodyStalls ? { ok: true, headers: new Headers({ 'x-request-id': 'stalled-body-request' }), json: () => new Promise(() => {}) } : new Promise(() => {});
    });
    try {
      await assert.rejects(request('task-models', 'live', {}, { timeoutMs: 25, label: '模型配置' }), error => error instanceof ApiError && error.status === 0 && /模型配置响应超时/.test(error.message) && error.requestId === (bodyStalls ? 'stalled-body-request' : null));
      assert.equal(signal.aborted, true); assert.equal(mock.mock.callCount(), 1);
    } finally { mock.mock.restore(); }
  }
});

test('关闭表单会取消原请求，主动取消不转换为超时错误', async t => {
  let signal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => { signal = options.signal; return new Promise(() => {}); });
  const controller = new AbortController();
  const pending = request('task-products', 'live', { signal: controller.signal }, { timeoutMs: 1000 });
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError' && !(error instanceof ApiError));
  assert.equal(signal.aborted, true);
});

test('写入超时不自动重发，明确操作结果未知并保留原请求键', async t => {
  const observed = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => { observed.push(options); return new Promise(() => {}); });
  await assert.rejects(request('audits', 'live', { method: 'POST', headers: { 'Idempotency-Key': 'stable-fixture-key' }, body: '{"auditId":"fixture"}' }, { timeoutMs: 25 }), error => error instanceof ApiError && error.status === 0 && /未能确认操作结果/.test(error.message));
  assert.equal(observed.length, 1); assert.equal(observed[0].headers['Idempotency-Key'], 'stable-fixture-key');
});

test('接口失败和手动重试保持原错误、请求编号及读取路径', async t => {
  let tries = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, '/api/workbench/task-models?source=live');
    return tries++ === 0 ? new Response(JSON.stringify({ message: '模型配置读取超时' }), { status: 503, headers: { 'x-request-id': 'fixture-503' } }) : new Response(JSON.stringify({ models: [{ value: 'default', label: '默认' }] }));
  });
  await assert.rejects(request('task-models', 'live'), error => error.status === 503 && error.message === '模型配置读取超时' && error.requestId === 'fixture-503');
  assert.equal(tries, 1);
  const result = await request('task-models', 'live'); assert.equal(result.models[0].value, 'default'); assert.equal(tries, 2);
});

test('报告下载保留原始字节，接口错误不能作为 Markdown 文件下载', async t => {
  const bytes = Buffer.from('\ufeff# 中文封存原文\r\n');
  let failed = false;
  t.mock.method(globalThis, 'fetch', async () => failed ? new Response(JSON.stringify({ message: '报告不存在' }), { status: 404, headers: { 'x-request-id': 'report-missing' } }) : new Response(bytes));
  const blob = await request('reports/fixture/download', 'live', {}, { format: 'blob' });
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
  failed = true;
  await assert.rejects(request('reports/fixture/download', 'live', {}, { format: 'blob' }), error => error instanceof ApiError && error.status === 404 && error.requestId === 'report-missing');
});

test('报告下载正文卡住时结束等待并保留请求编号', async t => {
  let signal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => { signal = options.signal; return { ok: true, headers: new Headers({ 'x-request-id': 'stalled-download' }), blob: () => new Promise(() => {}) }; });
  await assert.rejects(request('reports/fixture/download', 'live', {}, { format: 'blob', timeoutMs: 25, label: '报告下载' }), error => error instanceof ApiError && error.requestId === 'stalled-download' && /报告下载响应超时/.test(error.message));
  assert.equal(signal.aborted, true);
});
