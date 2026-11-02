import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/dynamic-validation-observatory/public/app.js', import.meta.url), 'utf8');
const names = ['miningStrategyLabel', 'selectedMiningStrategies', 'formMiningStrategies', 'syncAuditContextControls', 'submitAudit', 'renderTaskBoard', 'findingCreedSection'];
const functions = names.map(name => {
  const result = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(result, name); return result[0];
}).join('\n');
class Element {
  constructor(tag = 'div', _className = '', text = '') { this.tag = tag; this.textContent = text; this.children = []; this.listeners = {}; this.value = ''; this.checked = false; this.dataset = {}; this.attributes = {}; this.classList = { toggle() {} }; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute(name, value) { this.attributes[name] = value; }
  setCustomValidity(value) { this.validityMessage = value; }
  closest() { return this; }
  querySelector() { return this; }
  close() { this.open = false; }
}
const all = node => [node, ...node.children.flatMap(all)];
function fixture(strategies = ['focus_area']) {
  const nodes = new Map(), calls = [];
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const form = $('audit-form'); form.dataset.modelsReady = 'true'; form.reset = () => {};
  form.elements = new Proxy({}, { get: (target, name) => target[name] ??= new Element('input') });
  for (const [name, value] of Object.entries({ audit_mode: 'static', engine: 'opencode', model: 'default', audit_id: 'audit-fixture', name: '多方式审计', target_id: 'target-fixture', api_inventory: 'GET /orders', runtime_mode: 'INTEGRATED_TESTING', runtime_budget: '60', runtime_identity: 'auto', creed_paths: 'src/services\nsrc/auth.ts', creed_symbols: 'cancel' })) form.elements[name].value = value;
  const options = ['focus_area', 'api', 'file_sweep', 'creed'].map(id => { const option = new Element('input'); option.value = id; option.checked = strategies.includes(id); return option; });
  form.querySelectorAll = selector => selector.endsWith(':checked') ? options.filter(option => option.checked) : options;
  form.querySelector = selector => selector.includes('input') ? options[0] : $('strategy-fieldset');
  const state = { selectedProductId: 'product-fixture', taskBoardViews: new Map(), agentSettings: { profiles: [{ id: 'opencode', available: true }] } };
  const context = vm.createContext({ $, state, element: (...args) => new Element(...args), URLSearchParams, crypto,
    FormData: class { constructor(form) { this.form = form; } get(name) { return this.form.elements[name].value; } },
    auditProductId: () => 'product-fixture', requestAuditAction: async () => {}, toast() {}, load: async () => {}, setView() {}, selectAudit: async () => {},
    api: async (url, options = {}) => { calls.push({ url, options }); return context.response ?? { id: 'audit-fixture' }; },
  });
  vm.runInContext(functions, context);
  return { $, state, form, options, calls, context };
}

test('旧版真实表单支持同时勾选，API 必填状态独立，切换动态不要求静态方式', () => {
  const f = fixture(['focus_area', 'api', 'creed']);
  f.context.syncAuditContextControls(f.form);
  assert.equal(f.form.elements.api_inventory.required, true); assert.equal(f.form.elements.api_inventory.disabled, false);
  assert.equal(f.$('creed-options-panel').hidden, false);
  assert.match(f.$('mining-strategy-description').textContent, /Focus Area.*逐 API.*CREED/);
  for (const option of f.options) option.checked = false;
  f.context.syncAuditContextControls(f.form); assert.match(f.options[0].validityMessage, /至少选择/);
  f.form.elements.audit_mode.value = 'dynamic'; f.context.syncAuditContextControls(f.form);
  assert.equal(f.options[0].validityMessage, ''); assert.equal(f.form.elements.api_inventory.required, false);
  assert.equal(f.form.elements.api_inventory.disabled, true); assert.equal(f.$('creed-options-panel').hidden, true);
});

test('旧版提交保留多方式和范围，取消 API 勾选不发送残留清单，空选择不创建', async () => {
  const f = fixture(['api', 'creed']);
  await f.context.submitAudit({ preventDefault() {}, currentTarget: f.form });
  const body = JSON.parse(f.calls[0].options.body);
  assert.deepEqual(body.mining_strategies, ['api', 'creed']); assert.equal(body.mining_strategy, undefined);
  assert.equal(body.mining_contract, 'mining-strategies.v1'); assert.equal(body.api_inventory, 'GET /orders');
  assert.deepEqual(body.creed_options, { paths: ['src/services', 'src/auth.ts'], symbols: ['cancel'] });
  f.options.find(option => option.value === 'api').checked = false;
  await f.context.submitAudit({ preventDefault() {}, currentTarget: f.form });
  assert.equal(JSON.parse(f.calls[1].options.body).api_inventory, '');
  f.options.forEach(option => { option.checked = false; });
  await f.context.submitAudit({ preventDefault() {}, currentTarget: f.form });
  assert.equal(f.calls.length, 2); assert.match(f.$('audit-form-error').textContent, /至少选择/);
  f.form.elements.audit_mode.value = 'dynamic'; f.form.elements.test_environment_enabled.checked = true; f.form.elements.test_environment_context.value = '授权 SSH 测试环境';
  await f.context.submitAudit({ preventDefault() {}, currentTarget: f.form });
  const dynamic = JSON.parse(f.calls[2].options.body); assert.equal(dynamic.mining_strategies, undefined); assert.equal(dynamic.creed_options, undefined); assert.equal(dynamic.target_id, null);
});

test('看板按方式筛选且展示各自覆盖，没有失败项时增量保持禁用', async () => {
  const f = fixture(), summary = { total: 3, reported: 2, pending: 0, running: 0, failed: 0, gap: 1, publication: 'SEALED',
    strategy_runs: [{ strategy_id: 'focus_area', state: 'SEALED' }, { strategy_id: 'creed', state: 'SEALED' }],
    strategy_coverage: { focus_area: { total: 1, reported: 1, failed: 0, gap: 0 }, creed: { total: 2, reported: 1, failed: 0, gap: 1, eligible_functions: 2, omitted_functions: 7, inventory_gaps: 1, inventory_complete: false } } };
  f.context.response = { total: 1, next_offset: null, items: [{ task_id: 'creed-one', strategy_id: 'creed', kind: 'function', domain: 'web', title: 'cancel 假设分析', status: 'GAP', prompt: '函数分析', attempt_count: 1 }], incremental: { available: false, task_count: 0, reason: '没有执行失败的工作项，无需增量审计。' } };
  const panel = f.context.renderTaskBoard({ id: 'audit-fixture', mining_strategies: ['focus_area', 'creed'], task_board: summary }); await panel.taskBoardReady;
  const nodes = all(panel); assert.ok(nodes.some(node => node.textContent === '工作项看板'));
  assert.ok(nodes.some(node => /CREED.*已交付 1\/2/.test(node.textContent)));
  assert.ok(nodes.some(node => /当前函数清单交付 1\/2.*未纳入函数 7.*不代表全部函数覆盖/.test(node.textContent)));
  assert.equal(nodes.find(node => node.tag === 'button' && node.textContent.startsWith('增量审计')).disabled, true);
  assert.ok(nodes.some(node => /没有执行失败/.test(node.textContent)));
  const filter = nodes.find(node => node.attributes['aria-label'] === '挖掘方式'); filter.value = 'creed'; filter.listeners.change();
  await Promise.resolve();
  assert.equal(new URL(f.calls.at(-1).url, 'http://fixture').searchParams.get('strategy_id'), 'creed');
  f.context.response.items[0].execution_failure = { attempt_id: 'failed-attempt', retryable: true };
  f.context.response.incremental = { available: true, task_count: 1 };
  const failed = f.context.renderTaskBoard({ id: 'audit-fixture', mining_strategies: ['focus_area', 'creed'], task_board: summary }); await failed.taskBoardReady;
  assert.ok(all(failed).some(node => /执行失败（已封存缺口）/.test(node.textContent)));
  assert.equal(all(failed).find(node => node.tag === 'button' && node.textContent.startsWith('增量审计')).disabled, false);
});

test('CREED 详情展示原文件行和假设条件，无结构时不生成空区块', () => {
  const f = fixture(); assert.equal(f.context.findingCreedSection({}), null);
  const section = f.context.findingCreedSection({ creed_analysis: {
    function: { path: 'src/payment.ts', start_line: 45, end_line: 60, symbol: 'cancel' },
    actions: [{ id: 'a1', description: '<script>仅作为源码文本</script>', source_lines: [47] }],
    beliefs: [{ id: 'b1', statement: '调用方已经验证对象权限', action_ids: ['a1'], source_lines: [47], sanity: { reasonable: true, explanation: '需要调用方证据' }, violation: { conditions: ['调用方未限制当前用户'], explanation: '尚需核查入口' } }],
    external_conditions: ['核查所有调用方'],
  } });
  const texts = all(section).map(node => node.textContent).join('\n');
  assert.match(texts, /src\/payment.ts:45-60/); assert.match(texts, /源码证据行：47/); assert.match(texts, /失效条件：调用方未限制当前用户/);
  assert.match(texts, /<script>仅作为源码文本<\/script>/); assert.ok(all(section).every(node => !Object.hasOwn(node, 'innerHTML')));
});

test('合并漏洞保留多条 CREED 分析链，兼容字段重复时不重复展示', () => {
  const f = fixture(), first = { function: { path: 'src/a.ts', symbol: 'first', start_line: 3 }, beliefs: [{ id: 'b1', statement: '第一条假设' }] }, second = { function: { path: 'src/b.ts', symbol: 'second', start_line: 9 }, beliefs: [{ id: 'b2', statement: '第二条假设' }] };
  const section = f.context.findingCreedSection({ creed_analysis: first, creed_analyses: [{ finding_id: 'first', analysis: first }, { finding_id: 'second', analysis: second }], source_occurrences: [{ creed_analysis: first }] });
  const headings = all(section).filter(node => node.tag === 'summary').map(node => node.textContent);
  assert.deepEqual(headings, ['b1 · 第一条假设', 'b2 · 第二条假设']);
});
