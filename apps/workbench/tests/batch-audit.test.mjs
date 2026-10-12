import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../app/lib/api.ts';
import { batchAuditName, prepareBatchAudits, resolveBatchTargets, submitBatchAudits } from '../app/lib/batch-audit.ts';

const config = {
  productId: 'product-batch', targetId: '', auditId: 'unused', name: '', model: 'fixture-model',
  miningStrategy: 'api', apiInventory: 'GET /health\nPOST /orders', memoryMode: 'facts_only', bacAnalysis: 'off',
  additionalInstructionsEnabled: true, additionalInstructions: '只检查授权源码',
  testEnvironmentEnabled: false, testEnvironmentContext: '',
  runtimeTesting: { mode: 'CONTACT_ONLY', budgetMinutes: 60, identityMode: 'auto', testInput: false, testMutation: false },
};
const target = (id, path, extras = {}) => ({ id, name: `显示名-${id}`, path, runnable: true, reason: '', ...extras });
const targets = [target('repo-a', '/repos/order-service'), target('repo-b', 'D:\\团队 repos\\payment-service')];

test('只带入列表勾选项目，按所选顺序创建，不扩大到其他项目', () => {
  const selected = resolveBatchTargets(['repo-b', 'repo-a', 'repo-b'], [...targets, target('unselected', '/repos/private')]);
  assert.deepEqual(selected.map(item => item.id), ['repo-b', 'repo-a']);
  const items = prepareBatchAudits(config, selected);
  assert.deepEqual(items.map(item => item.input.targetId), ['repo-b', 'repo-a']);
  assert.ok(items.every(item => item.input.productId === 'product-batch'));
  assert.deepEqual(resolveBatchTargets([], targets), []);
});

test('所选项目消失或不可运行时保留具体原因，不能静默丢弃后提交其他项目', () => {
  const selected = resolveBatchTargets(['repo-a', 'moved', 'disabled'], [...targets, target('disabled', '/unavailable', { runnable: false, reason: '目录不可用' })]);
  assert.equal(selected.length, 3);
  assert.equal(selected[1].runnable, false);
  assert.match(selected[1].reason, /移出当前产品|归档/);
  assert.equal(selected[2].reason, '目录不可用');
  assert.throws(() => prepareBatchAudits(config, selected), /移出当前产品|归档/);
  assert.throws(() => prepareBatchAudits(config, [selected[0], selected[2]]), /目录不可用/);
});

test('不同项目即使指向同一个目录也各建一个任务，同一项目重复 ID 只提交一次', () => {
  const selected = [targets[0], target('same-path-project', targets[0].path), targets[0]];
  const items = prepareBatchAudits(config, selected);
  assert.deepEqual(items.map(item => item.input.targetId), ['repo-a', 'same-path-project']);
  assert.notEqual(items[0].input.auditId, items[1].input.auditId);
});

test('任务按目录名和本地日期命名，每项独立 ID，共享配置保持原值且互不污染', () => {
  const date = new Date(2026, 9, 9, 0, 30);
  const items = prepareBatchAudits(config, targets, date);
  assert.deepEqual(items.map(item => item.input.name), ['order-service · 2026-10-09', 'payment-service · 2026-10-09']);
  assert.equal(new Set(items.map(item => item.input.auditId)).size, 2);
  assert.equal(new Set(items.map(item => item.key)).size, 2);
  assert.ok(batchAuditName('/repos/' + 'a'.repeat(200), date).length <= 160);
  for (const [index, item] of items.entries()) {
    const { name, auditId, targetId, ...shared } = item.input;
    const { name: _name, auditId: _auditId, targetId: _targetId, ...expected } = config;
    assert.deepEqual(shared, expected); assert.equal(targetId, targets[index].id);
  }
  items[0].input.runtimeTesting.testInput = true;
  assert.equal(items[1].input.runtimeTesting.testInput, false);
  assert.equal(config.runtimeTesting.testInput, false);
});

test('逐项提交使用现有 API；部分失败仍继续，重试保留 ID 和请求键并跳过成功项', async t => {
  const items = prepareBatchAudits(config, [...targets, target('repo-c', '/repos/c')]);
  const calls = []; let retrying = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/workbench/audits?source=live');
    const input = JSON.parse(options.body); const key = options.headers['Idempotency-Key'];
    calls.push({ input, key });
    if (!retrying && input.targetId === 'repo-a') return new Response(JSON.stringify({ message: '暂时不可用' }), { status: 503, headers: { 'x-request-id': 'batch-unknown' } });
    if (!retrying && input.targetId === 'repo-b') return new Response(JSON.stringify({ message: '源码目录暂不可用' }), { status: 422 });
    return new Response(JSON.stringify({ id: input.auditId, name: input.name, status: 'queued' }));
  });
  const updates = [];
  const result = await submitBatchAudits(items, api.createReal, rows => updates.push(rows));
  assert.deepEqual(result.map(item => item.status), ['uncertain', 'failed', 'created']);
  assert.equal(result[0].requestId, 'batch-unknown');
  assert.equal(calls.length, 3); assert.equal(updates[0][0].status, 'submitting');
  retrying = true;
  const retried = await submitBatchAudits(result, api.createReal, () => {});
  assert.ok(retried.every(item => item.status === 'created'));
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[3], calls[0]); assert.deepEqual(calls[4], calls[1]);
  assert.equal(result[0].status, 'uncertain');
  await submitBatchAudits(retried, api.createReal, () => {});
  assert.equal(calls.length, 5);
});

test('网络错误保留结果待确认且不自动重发，后续手动重试复用原任务', async () => {
  const items = prepareBatchAudits(config, [targets[0]]); let count = 0;
  const result = await submitBatchAudits(items, async () => { count++; throw new ApiError('未能确认操作结果', 0, null); }, () => {});
  assert.equal(count, 1); assert.equal(result[0].status, 'uncertain');
  assert.equal(result[0].input.auditId, items[0].input.auditId); assert.equal(result[0].key, items[0].key);
});
