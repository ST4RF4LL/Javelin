import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskInput } from '../build/api/server/task-contract.js';
import { LiveService, normalizeAudit } from '../build/api/server/live.service.js';
import { draftMiningStrategies } from '../shared/mining-strategies.ts';
import { prepareBatchAudits } from '../app/lib/batch-audit.ts';

const base = { productId: 'product-fixture', targetId: 'target-fixture', auditId: 'audit-fixture', name: '多方式审计', auditMode: 'static', model: 'default' };
const ids = ['focus_area', 'api', 'file_sweep', 'creed'];

test('15 种非空组合通过创建适配器，API 清单与动态授权各自独立', () => {
  for (let mask = 1; mask < 16; mask++) {
    const miningStrategies = ids.filter((_, i) => mask & (1 << i));
    const body = createTaskInput({ ...base, miningStrategies, apiInventory: 'GET /orders' }).body;
    assert.deepEqual(body.mining_strategies, miningStrategies);
    assert.equal(body.mining_contract, 'mining-strategies.v1');
    assert.equal(body.mining_strategy, undefined);
    assert.equal(body.api_inventory, miningStrategies.includes('api') ? 'GET /orders' : '');
    assert.equal(body.runtime_testing, null);
    if (miningStrategies.includes('api')) assert.throws(() => createTaskInput({ ...base, miningStrategies, apiInventory: '' }), /API 清单/);
  }
  for (const miningStrategies of [[], ['creed', 'creed'], ['unknown'], 'creed', [null]]) assert.throws(() => createTaskInput({ ...base, miningStrategies }), /挖掘方式/);
  assert.throws(() => createTaskInput({ ...base, miningStrategy: 'focus_area', miningStrategies: ['api', 'creed'], apiInventory: 'GET /orders' }), /不一致/);
});

test('旧单选草稿和创建请求兼容；显式空选择不恢复默认', () => {
  assert.deepEqual(draftMiningStrategies({ miningStrategy: 'api' }), ['api']);
  assert.deepEqual(draftMiningStrategies({ apiInventory: 'GET /orders' }), ['api']);
  assert.deepEqual(draftMiningStrategies({ miningStrategies: [] }), []);
  assert.deepEqual(createTaskInput({ ...base, miningStrategy: 'file_sweep' }).body.mining_strategies, ['file_sweep']);
  assert.match(normalizeAudit({ mining_strategies: ['focus_area', 'creed'] }).strategy, /Focus Area.*CREED/);
});

test('独立动态验证不夹带静态策略或 CREED 范围', () => {
  const body = createTaskInput({ ...base, auditMode: 'dynamic', targetId: '', miningStrategies: ids, apiInventory: 'PRIVATE_UNUSED', creedOptions: { paths: ['src'] }, testEnvironmentEnabled: true, testEnvironmentContext: '用户授权的 SSH 测试环境' }).body;
  assert.equal(body.mining_contract, undefined); assert.equal(body.mining_strategies, undefined); assert.equal(body.mining_strategy, undefined);
  assert.equal(body.creed_options, undefined); assert.equal(body.api_inventory, ''); assert.equal(body.target_id, null);
});

test('CREED 范围按目录与精确函数名保存，拒绝路径逃逸，取消勾选后不转交', () => {
  const creedOptions = { paths: ['src/services', 'src/auth.ts'], symbols: ['cancel', 'PaymentService.cancel'] };
  assert.deepEqual(createTaskInput({ ...base, miningStrategies: ['creed'], creedOptions }).body.creed_options, creedOptions);
  assert.equal(createTaskInput({ ...base, miningStrategies: ['focus_area'], creedOptions }).body.creed_options, undefined);
  for (const paths of [['../outside'], ['/absolute'], ['C:\\source'], ['src/**'], ['src/../outside']]) assert.throws(() => createTaskInput({ ...base, miningStrategies: ['creed'], creedOptions: { paths } }), /路径/);
});

test('重新审计与批量草稿保留完整多选和 CREED 配置，工作项重试不创建草稿', async () => {
  const live = new LiveService();
  try {
    live.transport = async (url, options = {}) => Response.json(options.method === 'POST' ? { mining_strategies: ['api', 'creed'], api_inventory: 'GET /orders', creed_options: { paths: ['src'], symbols: ['cancel'] } }
      : { id: 'audit-original', status: 'completed', name: '原审计', repository_id: 'target-fixture', provenance: { product_id: 'product-fixture' }, mining_strategies: ['api', 'creed'] });
    const draft = await live.retryDraft('audit-original');
    assert.deepEqual(draft.miningStrategies, ['api', 'creed']); assert.equal(draft.miningStrategy, undefined);
    assert.deepEqual(draft.creedOptions, { paths: ['src'], symbols: ['cancel'] }); assert.match(draft.name, /重新审计/);
    const items = prepareBatchAudits({ ...draft, auditId: 'unused' }, [{ id: 'first', path: '/repos/a', runnable: true }, { id: 'second', path: '/repos/b', runnable: true }]);
    assert.deepEqual(items[0].input.miningStrategies, ['api', 'creed']);
    items[0].input.miningStrategies.push('file_sweep'); items[0].input.creedOptions.paths.push('changed');
    assert.deepEqual(items[1].input.miningStrategies, ['api', 'creed']); assert.deepEqual(items[1].input.creedOptions.paths, ['src']);
  } finally { live.onModuleDestroy(); }
});
