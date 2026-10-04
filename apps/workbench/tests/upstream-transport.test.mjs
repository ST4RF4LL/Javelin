import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpstreamTransport } from '../build/api/server/upstream-transport.js';
import { LiveService } from '../build/api/server/live.service.js';
import { inProcessRequester } from './helpers/in-process-http.mjs';

const json = (response, value) => { const bytes = Buffer.from(JSON.stringify(value)); response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': bytes.length }); response.end(bytes); };

test('独立 HTTP 连接池不调用全局 fetch，中文 JSON 字节及写入头部完整', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('不得使用全局 fetch'); });
  let sent, config;
  const direct = createUpstreamTransport({ http: inProcessRequester(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    sent = Buffer.concat(parts); json(res, { items: ['默认', '模型甲'], received: JSON.parse(sent) });
  }, (_url, options) => { config = options; }) });
  try {
    const body = JSON.stringify({ name: '中文任务' });
    const result = await direct.fetch('http://127.0.0.1:4173/api/v2/products/p/audits', { method: 'POST', body, headers: { 'Idempotency-Key': 'fixture-key', 'If-Match': '"7"', Origin: 'http://127.0.0.1:4173' } });
    assert.deepEqual((await result.json()).received, { name: '中文任务' });
    assert.equal(sent.toString(), body); assert.equal(Number(config.headers['content-length']), Buffer.byteLength(body));
    assert.equal(config.headers['idempotency-key'], 'fixture-key'); assert.equal(config.headers['if-match'], '"7"');
    assert.equal(config.agent.keepAlive, true); assert.equal(config.agent.maxSockets, 32);
    assert.equal(config.headers['accept-encoding'], undefined);
  } finally { direct.close(); }
});

test('挂起的实时流不阻塞模型读取，取消会销毁流，二进制下载逐字节一致', async () => {
  let streaming; const bytes = Buffer.from('\ufeff# 中文报告\r\n\r\n原文\n');
  const direct = createUpstreamTransport({ http: inProcessRequester((req, res) => {
    if (req.url.endsWith('/events')) { streaming = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('id: 8\ndata: {"type":"updated"}\n\n'); }
    else if (req.url.endsWith('/download')) { res.writeHead(200, { 'Content-Type': 'text/markdown', 'Content-Length': bytes.length }); res.end(bytes); }
    else json(res, { model: { options: [{ value: 'default', label: '默认' }] } });
  }) });
  const abort = new AbortController();
  try {
    const events = await direct.fetch('http://127.0.0.1:4173/events', { signal: abort.signal }); const reader = events.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /id: 8/);
    const [model, download] = await Promise.all([direct.fetch('http://127.0.0.1:4173/model'), direct.fetch('http://127.0.0.1:4173/download')]);
    assert.equal((await model.json()).model.options[0].value, 'default'); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    abort.abort(); await assert.rejects(reader.read()); assert.equal(streaming.destroyed, true);
  } finally { abort.abort(); direct.close(); }
});

test('响应头和正文分别卡住时，生产读取均能取消实际 HTTP 流', async () => {
  for (const headers of [false, true]) {
    let incoming;
    const direct = createUpstreamTransport({ http: inProcessRequester((_req, res) => { incoming = res; if (headers) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); } }) });
    const live = new LiveService(); live.transport = direct.fetch;
    try {
      await assert.rejects(live.read('/api/v1/settings/model', { timeoutMs: 25, label: '模型配置' }), error => error.getStatus() === 503 && error.getResponse().code === 'UPSTREAM_TIMEOUT');
      assert.equal(incoming.destroyed, true);
    } finally { direct.close(); live.onModuleDestroy(); }
  }
});

test('不跟随重定向，取消和断流保留错误而非伪造成功正文', async () => {
  let calls = 0;
  const direct = createUpstreamTransport({ http: inProcessRequester((req, res) => {
    calls++;
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'https://unlisted.invalid' }); res.end(); }
    else { res.writeHead(200); res.write('{'); setImmediate(() => res.destroy(new Error('fixture truncated body'))); }
  }) });
  try {
    await assert.rejects(direct.fetch('http://127.0.0.1:4173/redirect'), /重定向/); assert.equal(calls, 1);
    const response = await direct.fetch('http://127.0.0.1:4173/broken'); await assert.rejects(response.json(), /truncated/);
    const signal = AbortSignal.abort(); await assert.rejects(direct.fetch('http://127.0.0.1:4173/model', { signal }), { name: 'AbortError' }); assert.equal(calls, 2);
  } finally { direct.close(); }
});
