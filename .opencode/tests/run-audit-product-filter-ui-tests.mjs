import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { auditListPath, auditScope, resolveAuditScope, auditCanDelete, auditSelectionKey, deleteAuditRequest } from '../web/dynamic-validation-observatory/public/app.js';
import { paginateAudits } from '../web/dynamic-validation-observatory/audit-list.mjs';

const source = await readFile(new URL('../web/dynamic-validation-observatory/public/app.js', import.meta.url), 'utf8');
// Execute the real controller functions with fixture I/O; no browser, port,
// Agent, or production task is started by these regression checks.
const functionNames = ['renderAudits', 'renderAuditSelection', 'selectAuditPage', 'openBatchDeleteAudits', 'renderBatchDeleteAudits', 'closeBatchDeleteAudits', 'submitBatchDeleteAudits', 'loadAuditsPage', 'findAudit', 'auditProductId', 'selectAudit', 'requestAuditAction', 'retryAudit', 'selectAuditProductFilter', 'loadProductTargets', 'openAuditDialog', 'auditDeleteButton', 'openDeleteAuditDialog', 'closeDeleteAuditDialog', 'submitDeleteAudit'];
functionNames.push('renderTaskBoard');
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
  close() { this.open = false; }
  get options() { return this.children; }
}
const audit = (id, productId, status = 'queued') => ({ id, name: id, repository_id: `${productId}-target`, repository_name: productId, status, version: 4, progress: 0, stage: '等待调度', stages: [], provenance: { audit_product_id: productId, product_id: productId, audit_managed: true } });

test('任务面板增量按钮使用后台完整范围，点击同任务动作并带版本；成功后禁用重复提交', async () => {
  const f = fixture(), item = audit('audit-incremental', 'p2', 'completed');
  item.mining_strategy = 'focus_area';
  item.task_board = { total: 5, reported: 2, running: 0, pending: 0, gap: 3, failed: 0, publication: 'SEALED', validation: { status: 'REVIEWED' }, tracks: { focus_area: { total: 5, reported: 2 } } };
  f.state.audits = [item]; let submitted = false;
  f.context.respond = async (url, options) => {
    if (options.method === 'POST') { submitted = true; return { ...item, status: 'queued' }; }
    if (url.includes('/task-board?')) return { total: 1, items: [{ task_id: 'one', title: '当前页缺口', kind: 'focus_area', domain: 'web', status: 'GAP', attempt_count: 1, prompt: '补查授权路径' }], next_offset: null,
      incremental: { available: !submitted, task_count: 3, file_count: 0, round: submitted ? 1 : 0, reason: submitted ? '增量审计已入队' : '补做未完成项' } };
    return item;
  };
  const panel = f.context.renderTaskBoard(item); await panel.taskBoardReady;
  const nodes = node => [node, ...node.children.flatMap(nodes)];
  const button = nodes(panel).find(node => node.tagName === 'button' && node.textContent.startsWith('增量审计'));
  assert.equal(button.textContent, '增量审计（3 项）'); assert.equal(button.disabled, false);
  await button.listeners.click();
  const writes = f.calls.filter(call => call.options.method === 'POST'); assert.equal(writes.length, 1);
  assert.equal(writes[0].url, '/api/v2/products/p2/audits/audit-incremental/actions');
  assert.deepEqual(JSON.parse(writes[0].options.body), { action: 'incremental' });
  assert.equal(writes[0].options.headers['If-Match'], '"4"'); assert.ok(writes[0].options.headers['Idempotency-Key']);
  assert.equal(button.disabled, true); assert.equal(f.errors.length, 0);
});

function fixture() {
  const nodes = new Map(), calls = [], errors = [], targetsLoaded = [];
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const state = { view: 'audits', selectedProductId: 'p1', auditProductFilter: 'p1', selectedTargetIds: new Set(['selected-target']), products: [{ id: 'p1', name: '产品一', status: 'active' }, { id: 'p2', name: '产品二', status: 'active' }], targets: [], workspace: { audits: [], queue: {} }, audits: [], auditTab: 'all', auditPage: 1, auditPageSize: 20, auditTotal: 0, auditTotalPages: 1, runtime: { runner: { enabled: true } }, auditDialogRequest: 0, modelSettings: { selected_model: 'default', options: [{ value: 'default', label: '默认' }] } };
  Object.assign(state, { taskBoardViews: new Map(), selectedAudits: new Map(), auditSelectionScope: null, batchDeleteItems: [], batchDeleteStarted: false, batchDeleteBusy: false, batchDeleteStop: false });
  const context = vm.createContext({ state, $, document: { querySelectorAll: () => [] }, URLSearchParams, AbortController, crypto, structuredClone, auditListPath, auditScope, resolveAuditScope, auditCanDelete, auditSelectionKey, deleteAuditRequest,
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

test('暂停后的刷新与 SSE 重叠：响应头已到达时取消旧列表不会报 map 错误', async () => {
  const f = fixture(), value = audit('audit-pause', 'p1', 'running');
  const apiSource = source.match(/^async function api\([^]*?^}/m)[0];
  Object.assign(f.context, { DOMException, onMutation() {} });
  vm.runInContext(apiSource, f.context);
  let headersArrived;
  const firstHeaders = new Promise(resolve => { headersArrived = resolve; });
  let listRequests = 0;
  f.context.fetch = async (url, options) => {
    if (options.method === 'POST') return Response.json({ ...value, status: 'paused' });
    if (++listRequests === 1) {
      // Like fetch on a streamed HTTP response: abort happens in json(),
      // after fetch itself has already fulfilled with status 200.
      const response = new Response(new ReadableStream({ start(controller) {
        options.signal.addEventListener('abort', () => controller.error(new DOMException('aborted while reading body', 'AbortError')), { once: true });
      } }));
      headersArrived(); return response;
    }
    return Response.json({ items: [{ ...value, status: 'paused' }], count: 1, page: 1, total_pages: 1 });
  };
  f.context.load = () => f.context.loadAuditsPage(1);
  const sseRefresh = f.context.loadAuditsPage(1);
  await firstHeaders;
  await f.context.requestAuditAction(value, 'pause');
  await sseRefresh;
  assert.equal(f.errors.length, 0);
  assert.equal(f.state.audits[0].status, 'paused');
  assert.equal(f.state.auditLoading, false);
});

test('成功状态中的截断 JSON 不会伪装成空对象；服务端错误仍保留 HTTP 状态', async () => {
  const f = fixture();
  Object.assign(f.context, { DOMException, onMutation() {} });
  vm.runInContext(source.match(/^async function api\([^]*?^}/m)[0], f.context);
  f.context.fetch = async () => new Response('{"items":');
  await assert.rejects(f.context.api('/fixture'), /响应未完整读取/);
  f.context.fetch = async () => new Response('Bad gateway', { status: 502 });
  await assert.rejects(f.context.api('/fixture'), error => error.status === 502);
  f.context.fetch = async () => Response.json({ message: '审计版本已变化' }, { status: 412 });
  await assert.rejects(f.context.api('/fixture'), error => error.status === 412 && error.message === '审计版本已变化');
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

test('所有产品提供删除入口；运行和暂停任务禁用，打开确认框不发送删除', () => {
  const f = fixture();
  for (const status of ['queued', 'failed', 'interrupted', 'cancelled', 'completed', 'artifact_only', 'running', 'paused', 'preparing', 'cancelling']) {
    const value = audit(`audit-${status}`, 'p2', status), button = f.context.auditDeleteButton(value);
    assert.equal(button.disabled, ['running', 'paused', 'preparing', 'cancelling'].includes(status));
    if (!button.disabled) {
      let stopped = false; button.listeners.click({ stopPropagation() { stopped = true; } });
      assert.equal(stopped, true); assert.equal(f.$('delete-audit-dialog').open, true);
      assert.equal(f.$('delete-audit-id').textContent, value.id);
      f.context.closeDeleteAuditDialog();
    }
  }
  assert.equal(f.calls.length, 0);
});

test('全部筛选下删除使用任务所属产品，列表刷新后仍可确认；成功关闭当前详情', async () => {
  const f = fixture(), value = audit('audit-delete-p2', 'p2', 'completed');
  f.state.auditProductFilter = ''; f.state.audits = [value];
  f.context.openDeleteAuditDialog(value);
  f.state.audits = []; // Background pagination must not lose the pending selection.
  f.state.selectedAuditId = value.id; f.$('audit-drawer').open = true;
  f.context.respond = async () => ({ deleted: true, audit_id: value.id });
  await f.context.submitDeleteAudit({ preventDefault() {} });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, '/api/v2/products/p2/audits/audit-delete-p2');
  assert.equal(f.calls[0].options.method, 'DELETE'); assert.equal(f.calls[0].options.headers['If-Match'], '"4"');
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { confirmation: value.id });
  assert.equal(f.$('audit-drawer').open, false); assert.equal(f.$('delete-audit-dialog').open, false);
});

test('删除版本冲突保留确认窗口和任务，历史制品走兼容接口', async () => {
  const f = fixture(), value = audit('audit-delete-conflict', 'p2', 'completed');
  f.state.audits = [value]; f.context.openDeleteAuditDialog(value);
  f.context.respond = async () => { throw new Error('审计版本已变化，请刷新后重试。'); };
  await f.context.submitDeleteAudit({ preventDefault() {} });
  assert.equal(f.$('delete-audit-dialog').open, true); assert.equal(f.state.audits.length, 1);
  assert.match(f.$('delete-audit-form-error').textContent, /版本已变化/);
  f.calls.length = 0;
  const historical = audit('audit-history', 'product-undefined', 'artifact_only');
  f.state.audits = [historical]; f.context.openDeleteAuditDialog(historical);
  f.context.respond = async () => ({ deleted: true, audit_id: historical.id });
  await f.context.submitDeleteAudit({ preventDefault() {} });
  assert.equal(f.calls[0].url, '/api/v1/audits/audit-history');
});

test('批量选择仅包含可删除任务，翻页保留且筛选变化清空，活动状态更新会取消选中', async () => {
  const f = fixture(), first = audit('audit-first', 'p1', 'completed'), queued = audit('audit-queued', 'p1');
  const second = audit('audit-second', 'p2', 'failed');
  f.context.respond = async url => ({ items: new URL(url, 'http://fixture').searchParams.get('page') === '2' ? [second] : [first, queued, audit('audit-running', 'p1', 'running'), audit('audit-paused', 'p1', 'paused')], count: 5, page: Number(new URL(url, 'http://fixture').searchParams.get('page')), total_pages: 2 });
  await f.context.loadAuditsPage(1); f.context.selectAuditPage(true);
  assert.equal(f.state.selectedAudits.size, 2); assert.equal(f.$('audit-select-page').checked, true);
  await f.context.loadAuditsPage(2); f.context.selectAuditPage(true);
  assert.equal(f.state.selectedAudits.size, 3); assert.equal(f.$('audit-selection-count').textContent, '已选 3 个任务');
  f.context.selectAuditPage(false); assert.equal(f.state.selectedAudits.size, 2);
  queued.status = 'running'; await f.context.loadAuditsPage(1);
  assert.equal(f.state.selectedAudits.size, 1); assert.ok(f.state.selectedAudits.has(auditSelectionKey(first)));
  f.$('audit-query').value = 'new filter'; await f.context.loadAuditsPage(1);
  assert.equal(f.state.selectedAudits.size, 0); assert.equal(f.$('batch-delete-audits').disabled, true);
});

test('批量确认展示冻结任务清单，取消不发送请求，跨产品与历史任务逐项走已有删除接口', async () => {
  const f = fixture(), records = [audit('audit-one', 'p1', 'completed'), audit('audit-two', 'p2', 'failed'), audit('audit-history-batch', 'product-undefined', 'artifact_only')];
  f.state.audits = records; f.state.workspace.audits = records; f.context.selectAuditPage(true);
  f.context.openBatchDeleteAudits(); assert.equal(f.$('batch-delete-dialog').open, true); assert.equal(f.calls.length, 0);
  assert.equal(f.$('batch-delete-list').children.length, 3);
  f.context.closeBatchDeleteAudits(); assert.equal(f.calls.length, 0);
  f.context.openBatchDeleteAudits();
  records[0].version = 99; // The user's confirmation refers to the displayed version, not a later refresh.
  f.context.respond = async (url, options) => ({ deleted: true, audit_id: JSON.parse(options.body).confirmation });
  await f.context.submitBatchDeleteAudits({ preventDefault() {} });
  assert.deepEqual(f.calls.map(call => call.url), ['/api/v2/products/p1/audits/audit-one', '/api/v2/products/p2/audits/audit-two', '/api/v1/audits/audit-history-batch']);
  assert.ok(f.calls.every(call => call.options.method === 'DELETE' && call.options.headers['If-Match'] === '"4"'));
  assert.equal(f.state.selectedAudits.size, 0); assert.equal(f.state.audits.length, 0);
  assert.equal(f.state.workspace.audits.length, 0); assert.equal(f.$('batch-delete-dialog').open, true);
  assert.equal(f.$('batch-delete-summary').textContent, '已删除 3/3 · 未成功 0 · 未处理 0');
  await f.context.submitBatchDeleteAudits({ preventDefault() {} }); assert.equal(f.calls.length, 3);
});

test('批量部分失败继续处理；冲突任务重新选择，连接失败保留，列表刷新失败不覆盖删除结果', async () => {
  const f = fixture(), records = [audit('audit-conflict', 'p1', 'completed'), audit('audit-okay', 'p2', 'completed'), audit('audit-offline', 'p2', 'failed')];
  f.state.audits = records; f.context.selectAuditPage(true); f.context.openBatchDeleteAudits();
  f.context.respond = async (url, options) => {
    if (url.endsWith('audit-conflict')) throw Object.assign(new Error('审计版本已变化，请刷新后重试。'), { status: 412 });
    if (url.endsWith('audit-offline')) throw new TypeError('connection reset');
    return { deleted: true, audit_id: JSON.parse(options.body).confirmation };
  };
  f.context.load = async () => { throw new Error('列表暂不可用'); };
  await f.context.submitBatchDeleteAudits({ preventDefault() {} });
  assert.equal(f.calls.length, 3); assert.deepEqual(Array.from(f.state.batchDeleteItems, item => item.status), ['failed', 'deleted', 'failed']);
  assert.match(f.state.batchDeleteItems[0].error, /版本已变化/); assert.match(f.state.batchDeleteItems[2].error, /结果未确认/);
  assert.equal(f.state.selectedAudits.size, 1); assert.ok(f.state.selectedAudits.has(auditSelectionKey(records[2])));
  assert.match(f.state.batchDeleteItems[0].error, /重新勾选/); assert.match(f.$('batch-delete-error').textContent, /删除结果已保留，列表刷新失败/);
  f.context.closeBatchDeleteAudits(); f.context.openBatchDeleteAudits();
  assert.equal(f.state.batchDeleteItems.length, 1); assert.equal(f.calls.length, 3);
});

test('删除处理中不能重复提交或关闭，停止操作只取消尚未发出的请求', async () => {
  const f = fixture(); f.state.audits = [audit('audit-first', 'p1', 'completed'), audit('audit-second', 'p1', 'completed')];
  f.context.selectAuditPage(true); f.context.openBatchDeleteAudits(); let complete;
  f.context.respond = async () => new Promise(resolve => { complete = resolve; });
  const pending = f.context.submitBatchDeleteAudits({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.batchDeleteBusy, true); f.context.closeBatchDeleteAudits(); assert.equal(f.$('batch-delete-dialog').open, true);
  await f.context.submitBatchDeleteAudits({ preventDefault() {} }); assert.equal(f.calls.length, 1);
  f.state.batchDeleteStop = true; complete({ deleted: true, audit_id: 'audit-first' }); await pending;
  assert.equal(f.calls.length, 1); assert.deepEqual(Array.from(f.state.batchDeleteItems, item => item.status), ['deleted', 'pending']);
  assert.equal(f.state.selectedAudits.size, 1); assert.equal(f.state.batchDeleteBusy, false);
});

test('删除应答缺少成功标识或任务编号不匹配时，不移除本地任务和选择', async () => {
  const f = fixture(), value = audit('audit-unconfirmed', 'p1', 'completed');
  f.state.audits = [value]; f.context.selectAuditPage(true); f.context.openBatchDeleteAudits();
  f.context.respond = async () => ({ deleted: true, audit_id: 'another-audit' });
  await f.context.submitBatchDeleteAudits({ preventDefault() {} });
  assert.equal(f.state.audits.length, 1); assert.equal(f.state.selectedAudits.size, 1);
  assert.match(f.state.batchDeleteItems[0].error, /结果未能确认/);
});
