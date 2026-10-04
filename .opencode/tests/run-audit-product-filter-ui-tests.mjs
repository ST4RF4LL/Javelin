import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { auditListPath, auditScope, resolveAuditScope } from '../web/dynamic-validation-observatory/public/app.js';
import { paginateAudits } from '../web/dynamic-validation-observatory/audit-list.mjs';

const source = await readFile(new URL('../web/dynamic-validation-observatory/public/app.js', import.meta.url), 'utf8');
// Execute the real controller functions with fixture I/O; no browser, port,
// Agent, or production task is started by these regression checks.
const functionNames = ['renderAudits', 'loadAuditsPage', 'findAudit', 'auditProductId', 'selectAudit', 'requestAuditAction', 'retryAudit', 'selectAuditProductFilter', 'loadProductTargets', 'openAuditDialog'];
const functions = functionNames.map(name => {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, name); return match[0];
}).join('\n');
const navigate = source.slice(source.indexOf('async navigate(view, filters = {}, auditId) {'), source.indexOf('}, destroy() {'));

class Element {
  constructor(tag = 'div', className = '', text = '') { this.tagName = tag; this.className = className; this.textContent = text; this.children = []; this.value = ''; this.listeners = {}; this.dataset = {}; this.style = {}; this.classList = { toggle() {} }; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute() {}
  showModal() { this.open = true; }
  get options() { return this.children; }
}
const audit = (id, productId, status = 'queued') => ({ id, name: id, repository_id: `${productId}-target`, repository_name: productId, status, version: 4, progress: 0, stage: '等待调度', stages: [], provenance: { audit_product_id: productId, product_id: productId, audit_managed: true } });

function fixture() {
  const nodes = new Map(), calls = [], errors = [], targetsLoaded = [];
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const state = { view: 'audits', selectedProductId: 'p1', auditProductFilter: 'p1', selectedTargetIds: new Set(['selected-target']), products: [{ id: 'p1', name: '产品一', status: 'active' }, { id: 'p2', name: '产品二', status: 'active' }], targets: [], workspace: { audits: [], queue: {} }, audits: [], auditTab: 'all', auditPage: 1, auditPageSize: 20, auditTotal: 0, auditTotalPages: 1, runtime: { runner: { enabled: true } }, auditDialogRequest: 0, modelSettings: { selected_model: 'default', options: [{ value: 'default', label: '默认' }] } };
  const context = vm.createContext({ state, $, document: { querySelectorAll: () => [] }, URLSearchParams, AbortController, crypto, auditListPath, auditScope, resolveAuditScope,
    element: (...args) => new Element(...args), table: () => [new Element('table'), new Element('tbody')], cell() {}, short: String, auditStatus: () => new Element(), auditProgressText: () => '',
    renderActiveView() {}, renderAuditDetail() {}, connectEventStream() {}, closeAuditDrawer() { $('audit-drawer').open = false; },
    showError: error => errors.push(error), toast() {}, load: async () => {}, setView: view => { state.view = view; }, syncAuditContextControls() {},
    auditViews: async items => items, disposed: false, navigationSequence: 0, invalidateFindings() {}, openAudit: async id => { context.openedId = id; },
    api: async (url, options = {}) => { calls.push({ url, options }); return context.respond(url, options); },
    respond: async url => {
      if (url.includes('/targets?')) { targetsLoaded.push(url); return { items: [{ id: 'p2-target', name: '对象', status: 'active', source_scopes: [{ path: '/fixture/source' }] }] }; }
      if (url.includes('/audits?')) return { items: [], count: 0, page: 1, total_pages: 1 };
      throw new Error(`unexpected fixture URL: ${url}`);
    },
  });
  vm.runInContext(`${functions}\nasync function ${navigate.slice('async '.length)}}`, context);
  return { context, state, $, calls, errors, targetsLoaded };
}

test('产品选择器显示“全部”，不会用真实产品替代空筛选', () => {
  const f = fixture(); f.state.auditProductFilter = ''; f.context.renderAudits();
  assert.deepEqual(f.$('audit-product-selector').options.map(item => [item.value, item.textContent]), [['', '全部'], ['p1', '产品一'], ['p2', '产品二']]);
  assert.equal(f.$('audit-product-selector').value, '');
});

test('选择全部保留新建产品，具体产品仍切换目标且使用 v2 列表', async () => {
  const f = fixture(); f.$('audit-query').value = 'needle';
  await f.context.selectAuditProductFilter('');
  assert.equal(f.state.selectedProductId, 'p1'); assert.deepEqual([...f.state.selectedTargetIds], ['selected-target']);
  assert.match(f.calls[0].url, /^\/api\/v1\/audits\?/); assert.equal(f.targetsLoaded.length, 0);
  assert.equal(new URL(f.calls[0].url, 'http://fixture').searchParams.get('q'), 'needle');
  assert.equal(new URL(f.calls[0].url, 'http://fixture').searchParams.get('live'), '1');
  await f.context.selectAuditProductFilter('p2');
  assert.equal(f.state.selectedProductId, 'p2'); assert.equal(f.state.auditProductFilter, 'p2');
  assert.equal(f.state.selectedTargetIds.size, 0); assert.equal(f.targetsLoaded.length, 1);
  assert.ok(f.calls.some(call => call.url.startsWith('/api/v2/products/p2/audits?')));
});

test('全部产品通过全局分页器保留分页、搜索和状态分类', async () => {
  const f = fixture(); f.state.auditProductFilter = '';
  const records = Array.from({ length: 45 }, (_, index) => audit(`audit-${index}`, index % 2 ? 'p1' : 'p2', index < 5 ? 'running' : 'completed'));
  f.context.respond = async url => paginateAudits(records, new URL(url, 'http://fixture').searchParams);
  await f.context.loadAuditsPage(2);
  assert.equal(f.state.auditTotal, 45); assert.equal(f.state.auditPage, 2); assert.equal(f.state.audits.length, 20);
  assert.equal(new Set(f.state.audits.map(item => item.provenance.audit_product_id)).size, 2);
  f.state.auditTab = 'running'; await f.context.loadAuditsPage(1);
  assert.equal(f.state.auditTotal, 5); assert.ok(f.state.audits.every(item => item.status === 'running'));
  f.state.auditTab = 'all'; f.$('audit-query').value = 'audit-44'; await f.context.loadAuditsPage(1);
  assert.equal(f.state.auditTotal, 1); assert.equal(f.state.audits[0].id, 'audit-44');
});

test('切换产品取消旧列表，迟到的具体产品响应不会覆盖全部列表', async () => {
  const f = fixture(), pending = [];
  f.context.respond = url => new Promise(resolve => pending.push({ url, resolve }));
  const old = f.context.loadAuditsPage(1); f.state.auditProductFilter = ''; const current = f.context.loadAuditsPage(1);
  pending[1].resolve({ items: [audit('new', 'p2')], count: 1, page: 1, total_pages: 1 }); await current;
  pending[0].resolve({ items: [audit('old', 'p1')], count: 1, page: 1, total_pages: 1 }); await old;
  assert.equal(f.state.audits[0].id, 'new'); assert.equal(f.calls[0].options.signal.aborted, true);
});

test('跨产品任务详情和调度、暂停始终使用任务真实归属', async () => {
  const f = fixture(), value = audit('audit-p2', 'p2'); f.state.auditProductFilter = ''; f.state.audits = [value];
  f.context.respond = async () => value;
  await f.context.selectAudit(value.id);
  assert.equal(f.state.auditDetailProductId, 'p2'); assert.match(f.calls[0].url, /^\/api\/v2\/products\/p2\/audits\/audit-p2$/);
  for (const action of ['dispatch', 'pause']) await f.context.requestAuditAction(value, action);
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 2);
  for (const call of f.calls.filter(call => call.options.method === 'POST')) assert.equal(call.url, '/api/v2/products/p2/audits/audit-p2/actions');
  assert.equal(f.state.selectedProductId, 'p1'); assert.equal(f.errors.length, 0);
});

test('旧列表无审计归属时从 v1 解析，不把对象当前产品当成原审计产品', async () => {
  const f = fixture(), value = audit('audit-p2', 'p2'); f.state.audits = [{ ...value, provenance: { product_id: 'transferred-target-product' } }];
  f.context.respond = async () => value;
  await f.context.selectAudit(value.id);
  assert.match(f.calls[0].url, /^\/api\/v1\/audits\/audit-p2\?/); assert.match(f.calls[1].url, /^\/api\/v2\/products\/p2\/audits\/audit-p2$/);
  f.calls.length = 0; f.context.respond = async () => ({ ...value, provenance: undefined });
  await f.context.requestAuditAction({ ...value, provenance: undefined }, 'dispatch');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.method, undefined); assert.match(f.errors[0].message, /无法确认任务所属产品/);
});

test('全部下跨产品重试加载原产品目标和私有草稿，筛选仍保持全部', async () => {
  const f = fixture(), value = audit('audit-p2', 'p2', 'failed'); f.state.auditProductFilter = '';
  const form = f.$('audit-form'); form.reset = () => {}; form.elements = new Proxy({}, { get: (target, name) => target[name] ??= new Element() });
  const original = f.context.respond;
  f.context.respond = async (url, options) => url.endsWith('/retry-draft') ? { memory_mode: 'facts_only', mining_strategy: 'focus_area', additional_instructions_enabled: true, additional_instructions: 'fixture instruction', test_environment_enabled: false, test_environment_context: '' } : original(url, options);
  await f.context.retryAudit(value);
  assert.equal(f.state.selectedProductId, 'p2'); assert.equal(f.state.auditProductFilter, '');
  assert.ok(f.calls.some(call => call.url === '/api/v2/products/p2/audits/audit-p2/retry-draft' && call.options.method === 'POST'));
  assert.equal(f.$('repository-select').value, 'p2-target'); assert.equal(form.elements.memory_mode.value, 'facts_only');
  assert.equal(f.$('audit-dialog').open, true); assert.notEqual(form.elements.audit_id.value, value.id);
});

test('新版深链导航对齐产品筛选，显式全部保留可新建的实际产品', async () => {
  const f = fixture(); await f.context.navigate('audits', { product_id: 'p2', q: 'task', status: 'completed' }, 'audit-p2');
  assert.equal(f.state.auditProductFilter, 'p2'); assert.equal(f.state.selectedProductId, 'p2'); assert.equal(f.$('audit-query').value, 'task'); assert.equal(f.context.openedId, 'audit-p2');
  await f.context.navigate('audits', { product_id: '' });
  assert.equal(f.state.auditProductFilter, ''); assert.equal(f.state.selectedProductId, 'p2');
});
