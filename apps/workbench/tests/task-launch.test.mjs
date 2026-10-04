import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { launchTask, validateSpec } from '../scripts/launch-task.mjs';

const spec = { origin: 'http://127.0.0.1:4181', idempotencyKey: 'fixture-launch-key', input: { auditId: 'audit-launch-fixture', productId: 'product-fixture', targetId: 'target-fixture', name: 'Langflow 隔离契约样例', model: 'aliyun/qwen3.8-flash', testEnvironmentEnabled: true, testEnvironmentContext: '用户授权的自由文本环境说明\nhttps://fixture.invalid\nPRIVATE_CONTEXT_MARKER', runtimeTesting: { mode: 'INTEGRATED_TESTING', budgetMinutes: 60 } } };
const bytes = Buffer.from('# 受控报告\r\n');
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'x-request-id': 'fixture-request' } });
function fixture({ existing = false, revision = 3, models = true, mismatch = false, corruptedReport = false, loseWrite = false, stuck = false } = {}) {
  let audit = existing ? row('running') : null; const calls = [];
  function row(status) { return { id: spec.input.auditId, productId: spec.input.productId, targetId: mismatch ? 'unrelated-target' : spec.input.targetId, model: spec.input.model, status, version: 1, runtimeTestingStatus: '等待调度', allowedActions: stuck ? [] : ['dispatch'] }; }
  const transport = async (url, options) => {
    const path = new URL(url).pathname; calls.push({ path, method: options.method, body: options.body, headers: new Headers(options.headers) });
    if (options.method === 'POST') {
      if (path.endsWith('/actions')) { audit = row('running'); return json(audit); }
      audit = row(loseWrite ? 'running' : 'queued');
      if (loseWrite) throw new Error('fixture write result lost');
      return json(audit, 201);
    }
    if (!path.startsWith('/api/')) return new Response('<!doctype html><html lang="zh-CN"><body></body></html>', { headers: { 'Content-Type': 'text/html' } });
    if (path.endsWith('/health')) return json({ apiVersion: revision, mode: 'integrated', liveReadOnly: false });
    if (path.endsWith('/task-models')) return json({ models: models ? [{ value: spec.input.model }] : [] });
    if (path.endsWith('/task-products')) return json({ items: [{ id: spec.input.productId }] });
    if (path.endsWith('/task-runner')) return json({ runnerEnabled: true });
    if (path.endsWith('/targets')) return json({ items: [{ id: spec.input.targetId, runnable: true }] });
    if (path.endsWith('/snapshot')) return json({ reports: [{ id: 'report-fixture' }] });
    if (path.endsWith('/findings')) return json({ findings: [], count: 0 });
    if (path.endsWith('/audits')) return json({ items: [], count: 0 });
    if (path.endsWith('/download')) return new Response(corruptedReport ? 'not sealed bytes' : bytes);
    if (path.endsWith('/reports/report-fixture')) return json({ body: '# 受控报告\r\n', date: '2026-10-02T00:00:00Z', presentation: { source_sha256: createHash('sha256').update(bytes).digest('hex') } });
    if (path.endsWith(`/audits/${spec.input.auditId}`)) return audit ? json(audit) : json({ message: '不存在' }, 404);
    throw new Error(`unexpected fixture path ${path}`);
  };
  return { transport, calls };
}

test('Qwen 启动验收先检查全部入口，再按固定编号创建和调度，保留完整环境说明', async () => {
  const backend = fixture(); const progress = [];
  const result = await launchTask(spec, { transport: backend.transport, wait: async () => {}, progress: event => progress.push(event) });
  assert.equal(result.status, 'started'); assert.equal(result.taskStatus, 'running'); assert.equal(result.model, 'aliyun/qwen3.8-flash');
  assert.equal(result.modelResponseVerified, false); assert.equal(result.targetContactVerified, false);
  const writes = backend.calls.filter(call => call.method === 'POST'); assert.equal(writes.length, 2);
  assert.deepEqual(JSON.parse(writes[0].body), spec.input); assert.equal(writes[0].headers.get('idempotency-key'), spec.idempotencyKey);
  assert.equal(writes[0].headers.get('origin'), spec.origin); assert.equal(JSON.parse(writes[1].body).action, 'dispatch');
  assert.ok(backend.calls.findIndex(c => c.path.endsWith('/download')) < backend.calls.indexOf(writes[0]));
  assert.ok(!JSON.stringify(progress).includes('PRIVATE_CONTEXT_MARKER'));
});

test('已有同一任务直接观察；归属不符时停止，不自动启动其他任务', async () => {
  const backend = fixture({ existing: true });
  const result = await launchTask(spec, { transport: backend.transport }); assert.equal(result.auditId, spec.input.auditId);
  assert.equal(backend.calls.filter(c => c.method === 'POST').length, 0);
  const wrong = fixture({ existing: true, mismatch: true }); await assert.rejects(launchTask(spec, { transport: wrong.transport }), /归属/);
  assert.equal(wrong.calls.filter(c => c.method === 'POST').length, 0);
});

test('旧后端、缺失模型或报告原文不一致都阻止写入', async () => {
  for (const options of [{ revision: 1 }, { models: false }, { corruptedReport: true }]) {
    const backend = fixture(options); await assert.rejects(launchTask(spec, { transport: backend.transport }));
    assert.equal(backend.calls.filter(c => c.method === 'POST').length, 0);
  }
});

test('写入响应丢失不盲目重发；再次执行查询固定任务，不创建第二条', async () => {
  const backend = fixture({ loseWrite: true });
  await assert.rejects(launchTask(spec, { transport: backend.transport }), /结果尚未确认/);
  assert.equal(backend.calls.filter(c => c.method === 'POST').length, 1);
  const result = await launchTask(spec, { transport: backend.transport }); assert.equal(result.status, 'started');
  assert.equal(backend.calls.filter(c => c.method === 'POST').length, 1);
});

test('排队不冒充运行；参数校验不默默替换模型或扩大平台地址', async () => {
  const backend = fixture({ stuck: true });
  const result = await launchTask(spec, { transport: backend.transport, timeoutMs: 0 });
  assert.equal(result.status, 'waiting'); assert.equal(result.taskStatus, 'queued');
  assert.throws(() => validateSpec({ ...spec, input: { ...spec.input, model: 'default' } }), /完整/);
  assert.throws(() => validateSpec({ ...spec, origin: 'http://user:password@127.0.0.1:4181/' }), /无凭据/);
});
