import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { filterValidationActivity, capturedBodyText } from '../web/dynamic-validation-observatory/public/app.js';
import { buildHar } from '../web/dynamic-validation-observatory/har-exporter.mjs';
import { normalizeBrowserExchangeV2 } from '../web/dynamic-validation-observatory/http-exchange.mjs';
import { buildBrunoCollection } from '../web/dynamic-validation-observatory/bruno-exporter.mjs';

const source = await readFile(new URL('../web/dynamic-validation-observatory/public/app.js', import.meta.url), 'utf8');
const names = ['renderValidation', 'validationStateLabel', 'validationExportActions', 'renderHttpEvidence', 'renderValidationActivity', 'applyValidationResources', 'validationResourceRequests', 'showValidationActivityWhenReady', 'loadViewResources', 'refreshLiveWorkspace', 'updateExchangeSelectionControls', 'selectValidation', 'downloadExchangeExport'];
const functions = names.map(name => source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'))?.[0] ?? assert.fail(name)).join('\n');
class Element {
  constructor(tagName = 'div', className = '', text = '') { Object.assign(this, { tagName, className, textContent: String(text), children: [], dataset: {}, listeners: {}, value: '', attributes: {} }); this.classList = { toggle() {} }; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, listener) { this.listeners[key] = listener; }
  querySelectorAll() { return descendants(this).filter(node => node.tagName === 'details' && node.open && node.dataset.actionId); }
  click() { return this.listeners.click?.(); }
  scrollIntoView() {}
  remove() {}
}
const descendants = node => [node, ...node.children.flatMap(child => descendants(child))];
const textOf = node => descendants(node).map(child => child.textContent).join('\n');
function fixture() {
  const nodes = new Map(), exports = [], errors = [], notices = [];
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  $('validation-activity-status').value = 'all';
  const state = { view: 'validation', validationTab: 'activity', validationRequestSequence: 0, sourceOptionsRequestSequence: 0, selectedRequestExchangeIds: new Set(), validationActivity: [], validationActivityExchanges: [], validationActivityLoaded: true, validationActivityPage: 1,
    requestExchanges: [], validationRuns: [], validationRequests: [], runtimeAudits: [], sourceFilters: { validation: {} } };
  const context = vm.createContext({ state, $, disposed: false, filterValidationActivity, capturedBodyText, AbortSignal, URLSearchParams, Blob, Response,
    element: (...args) => new Element(...args), metric: (label, value, note) => new Element('div', '', `${label}: ${value} ${note}`),
    matchesSource: record => !state.sourceFilters.validation.audit_id || record.audit_id === state.sourceFilters.validation.audit_id,
    sourceContext: value => new Element('p', '', `${value.audit_id}/${value.finding_id}`), formatDate: value => value ?? '—',
    downloadBruno: async ids => exports.push(['bruno', [...ids]]), downloadHar: async ids => exports.push(['har', [...ids]]),
    copyExchange: async () => {}, showError: error => errors.push(error), toast: value => notices.push(value),
    api: async () => ({ items: [] }), status: value => new Element('span', '', value),
    renderSourceFilters() {}, renderValidationRequests() {}, renderValidationList() {}, renderRequestHistory() {},
    renderActiveView() {}, connectValidationEventStream() {}, connectEventStream() {}, applyWorkspace() {},
    loadWorkspaceView: async () => ({}), refreshSelectedAudit: async () => {}, loadAuditsPage: async () => {},
    filteredRequestExchanges: () => [],
    document: { createElement: tag => new Element(tag), body: new Element(), querySelectorAll: () => [] },
    window: { setTimeout: callback => callback() }, URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
  });
  vm.runInContext(functions, context);
  return { context, $, state, exports, errors, notices };
}
const record = (id, extra = {}) => ({ id, audit_id: 'audit-one', finding_id: id, title: `漏洞 ${id}`, status: 'COMPLETED', actions: [], exchange_ids: [], gaps: [], ...extra });
const exchange = { exchange_id: 'http_one', started_at: '2026-10-03T00:00:00Z', duration_ms: 17, request: { method: 'POST', url: 'https://fixture.invalid/test', headers: [], body: { text: '{"test":1}' } }, response: { status: 403, headers: [{ name: 'Content-Type', value: 'text/plain' }], body: { text: '<script>example</script>', truncated: true } } };

test('动态验证默认显示动作，补充验证与原HTTP筛选仍可访问', async () => {
  const html = await readFile(new URL('../web/dynamic-validation-observatory/public/index.html', import.meta.url), 'utf8');
  assert.match(source, /validationTab: "activity"/);
  assert.match(html, /id="validation-tab-activity"[^>]*aria-selected="true"/);
  for (const id of ['validation-requests-panel', 'validation-results-panel', 'validation-exchanges-panel', 'export-selected-bruno']) assert.ok(html.includes(`id="${id}"`));
});

test('搜索与范围能区分实际HTTP、动作、受阻和未执行记录', () => {
  const rows = [record('http', { exchange_ids: ['http_one'] }), record('browser', { actions: [{ id: 'a', tool: 'click' }] }), record('blocked', { status: 'BLOCKED' }), record('skip', { status: 'SKIPPED' })];
  assert.deepEqual(filterValidationActivity(rows, { scope: 'http' }).map(row => row.id), ['http']);
  assert.deepEqual(filterValidationActivity(rows, { query: 'click' }).map(row => row.id), ['browser']);
  assert.deepEqual(filterValidationActivity(rows, { scope: 'blocked' }).map(row => row.id), ['blocked']);
  assert.deepEqual(filterValidationActivity(rows, { scope: 'pending' }).map(row => row.id), ['skip']);
});

test('缺失正文不会显示为空，截断响应不会显示为完整响应', () => {
  assert.match(capturedBodyText(null), /未记录正文/);
  assert.match(capturedBodyText({ text: '' }), /已捕获空正文/);
  assert.match(capturedBodyText({ text: 'partial', truncated: true }), /截断[\s\S]*partial/);
  assert.match(capturedBodyText({ text: '<Response body not available anymore>', available: false }), /正文不可用/);
});

test('HAR保留真实状态及截断缺口，缺失正文和未知耗时不伪造', () => {
  const item = structuredClone(exchange); item.duration_ms = null; item.audit_id = 'audit-one'; item.finding_id = 'finding-one';
  item.request.url = 'https://user:password@fixture.invalid/test';
  item.request.body = { text: '<Request body not available anymore>', available: false };
  item.response.body = { text: '<Response body not available anymore>', available: false };
  const document = JSON.parse(buildHar([item]).bytes.toString()); const entry = document.log.entries[0];
  assert.equal(entry.request.postData, undefined); assert.equal(entry.response.content.text, undefined);
  assert.equal(entry.response.status, 403); assert.equal(entry._dynval.duration_ms, null);
  assert.equal(entry.timings.wait, -1); assert.equal(entry._dynval.audit_id, 'audit-one');
  assert.equal(entry.request.url, 'https://fixture.invalid/test');
  const clipped = JSON.parse(buildHar([exchange]).bytes.toString()).log.entries[0];
  assert.equal(clipped._dynval.response_body_truncated, true); assert.match(clipped.response.content.text, /example/);
  assert.throws(() => buildHar([{ ...exchange, started_at: null }]), { code: 'har-export-timestamp-missing' });
});

test('旧捕获转换保留缺失与二进制标记、未知时间和显式证据归属', () => {
  for (const body of [{ omitted: true }, { text: 'AA==', encoding: 'base64' }, { text: 'unavailable', available: false }, { text: 'stale', capture_status: 'missing' }]) {
    const item = normalizeBrowserExchangeV2({ ...exchange, started_at: undefined, duration_ms: undefined, audit_id: 'audit-original', repository_id: 'repo-original', finding_id: 'finding-original',
      evidence_binding: { audit_id: 'audit-bound', repository_id: 'repo-bound', finding_id: 'finding-bound' }, request: { ...exchange.request, body } });
    assert.equal(item.audit_id, 'audit-original'); assert.equal(item.repository_id, 'repo-original'); assert.equal(item.finding_id, 'finding-original');
    assert.equal(item.evidence_binding.audit_id, 'audit-bound'); assert.equal(item.evidence_binding.repository_id, 'repo-bound'); assert.equal(item.evidence_binding.finding_id, 'finding-bound');
    assert.equal(item.started_at, null); assert.equal(item.duration_ms, null); assert.equal(item.capture_gaps.length, 2);
    assert.equal(buildBrunoCollection([item]).replayable_count, 0);
  }
});

test('一个漏洞动作展示其响应，导出只包含该漏洞绑定的HTTP记录', async () => {
  const f = fixture(); f.state.validationActivity = [record('first', { actions: [{ id: 'step', tool: 'get_network_request', phase: 'CONFIRM', status: 'COMPLETED', exchange_ids: ['http_one'] }], exchange_ids: ['http_one'] }), record('second', { exchange_ids: ['http_other'] })];
  f.state.validationActivityExchanges = [exchange]; f.context.renderValidationActivity();
  const detail = f.$('validation-case-detail');
  assert.match(textOf(detail), /HTTP 403/); assert.match(textOf(detail), /截断/);
  const body = descendants(detail).find(node => node.tagName === 'pre' && node.textContent.includes('<script>example</script>'));
  assert.ok(body); assert.equal(body.children.length, 0);
  await descendants(detail).find(node => node.tagName === 'button' && node.textContent.includes('Bruno')).click();
  assert.deepEqual(f.exports, [['bruno', ['http_one']]]);
  await f.$('validation-case-list').children[1].click();
  assert.equal(f.state.selectedValidationCaseId, 'second');
  await descendants(detail).find(node => node.tagName === 'button' && node.textContent.includes('Bruno')).click();
  assert.deepEqual(f.exports[1], ['bruno', ['http_other']]);
});

test('BLOCKED且没有HTTP的真实记录仍显示原因，导出按钮禁用', () => {
  const f = fixture(); f.state.validationActivity = [record('environment', { finding_id: null, title: '环境接触 / 未关联漏洞', status: 'BLOCKED', gaps: ['环境接触未完成'] })];
  f.context.renderValidationActivity(); const detail = f.$('validation-case-detail');
  assert.match(textOf(detail), /环境接触未完成/); assert.match(textOf(detail), /尚无已捕获/);
  assert.ok(descendants(detail).filter(node => node.tagName === 'button').every(node => node.disabled));
});

test('审计切换和分页不把旧漏洞留在详情区', () => {
  const f = fixture(); f.state.validationActivity = Array.from({ length: 17 }, (_, index) => record(`f-${index}`, { audit_id: index < 16 ? 'one' : 'two' }));
  f.context.renderValidationActivity(); assert.equal(f.state.selectedValidationCaseId, 'f-0');
  f.state.validationActivityPage = 2; f.context.renderValidationActivity(); assert.equal(f.state.selectedValidationCaseId, 'f-15');
  f.state.sourceFilters.validation.audit_id = 'two'; f.context.renderValidationActivity(); assert.equal(f.state.selectedValidationCaseId, 'f-16');
  assert.doesNotMatch(textOf(f.$('validation-case-detail')), /one\/f-/);
});

test('其他旧资源失败不吞掉已返回的验证动作，失败状态可重试', () => {
  const f = fixture(); f.context.applyValidationResources([{ error: '旧结果失败' }, { items: [] }, { items: [] }, { items: [] }, { items: [record('present')], exchanges: [exchange] }]);
  f.context.renderValidationActivity(); assert.equal(f.state.validationActivity.length, 1);
  assert.equal(f.$('validation-activity-error').hidden, false); assert.match(textOf(f.$('validation-activity-error')), /旧结果失败/);
  assert.equal(f.$('validation-case-detail').children.some(node => textOf(node).includes('漏洞 present')), true);
});

test('资源请求带当前筛选与超时，单项失败返回明确错误', async () => {
  const f = fixture(), calls = []; f.state.sourceFilters.validation = { audit_id: 'one', product_id: 'p' };
  f.context.api = async (url, options) => { calls.push([url, options]); if (url.includes('/validation-activity')) throw new Error('HTTP 404'); return { items: [] }; };
  const values = await Promise.all(f.context.validationResourceRequests());
  assert.equal(calls.length, 5); assert.ok(calls.every(([url, options]) => url.includes('audit_id=one') && url.includes('product_id=p') && options.signal));
  assert.match(values[4].error, /验证动作.*404/);
});

test('旧后台ZIP响应不伪装JSON下载，部分证据导出明确提示局限', async () => {
  const f = fixture(); f.context.fetch = async () => new Response('zip', { headers: { 'Content-Type': 'application/zip' } });
  await assert.rejects(f.context.downloadExchangeExport('/api/v1/http-exchanges/export/bruno', ['http_one'], 'test.json', 'Bruno'), /旧版 ZIP/);
  assert.equal(f.context.document.body.children.length, 0);
  f.context.fetch = async () => new Response(JSON.stringify({ version: '1', items: [] }), { headers: { 'Content-Type': 'application/json' } });
  await f.context.downloadExchangeExport('/api/v1/http-exchanges/export/bruno', ['http_one'], 'test.json', 'Bruno');
  assert.match(f.notices[0], /0 条请求，1 条不完整记录仅保留证据/);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('来源选项未返回或失败时，验证动作仍独立加载并显示', async () => {
  const f = fixture(), sources = deferred(), calls = [];
  f.context.api = async (url, options) => {
    calls.push([url, options]);
    if (url === '/api/v1/provenance/options') return sources.promise;
    if (url.includes('/validation-activity')) return { items: [record('available')], exchanges: [] };
    return { items: [] };
  };
  const loading = f.context.loadViewResources('validation');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 6);
  assert.ok(calls[0][1].signal);
  assert.equal(f.state.validationActivity[0].id, 'available');
  sources.reject(new Error('HTTP 503'));
  await loading;
  assert.equal(f.state.validationActivity[0].id, 'available');
  assert.match(f.errors[0].message, /来源筛选读取失败.*503/);
});

test('旧补充接口未决时验证动作立即显示，最终仍汇总旧接口错误', async () => {
  for (const loader of ['loadViewResources', 'refreshLiveWorkspace']) {
    const f = fixture(), oldResults = deferred(); let renders = 0;
    f.context.renderActiveView = () => { renders++; };
    f.context.api = async url => {
      if (url.startsWith('/api/runs?')) return oldResults.promise;
      if (url.includes('/validation-activity')) return { items: [record('ready')], exchanges: [exchange] };
      return { items: [] };
    };
    const loading = f.context[loader]('validation');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.state.validationActivity[0].id, 'ready', loader);
    assert.equal(f.state.validationActivityExchanges[0], exchange);
    assert.ok(renders > 0);
    oldResults.reject(new Error('旧结果超时')); await loading;
    assert.equal(f.state.validationActivity[0].id, 'ready');
    assert.match(f.state.validationActivityError, /补充验证结果.*旧结果超时/);
  }
});

test('较早的自动刷新不得覆盖同一筛选下较新的验证资源', async () => {
  const f = fixture(), older = deferred(); let activityRequests = 0;
  f.context.api = async url => {
    if (url.includes('/validation-activity')) return ++activityRequests === 1 ? older.promise : { items: [record('newer')], exchanges: [] };
    return { items: [] };
  };
  const refresh = f.context.refreshLiveWorkspace();
  await f.context.loadViewResources('validation');
  assert.equal(f.state.validationActivity[0].id, 'newer');
  older.resolve({ items: [record('older')], exchanges: [] });
  await refresh;
  assert.equal(f.state.validationActivity[0].id, 'newer');
});

test('慢来源选项不被先完成的自动刷新丢弃，后续来源请求仍优先', async () => {
  const f = fixture(), sources = deferred(), stale = deferred(); let sourceRequests = 0;
  const firstOptions = { products: [{ id: 'product-one' }], audits: [{ id: 'audit-one' }], reports: [] };
  const latestOptions = { products: [{ id: 'product-two' }], audits: [{ id: 'audit-two' }], reports: [] };
  f.context.api = async url => {
    if (url === '/api/v1/provenance/options') {
      sourceRequests++;
      return sourceRequests === 1 ? sources.promise : sourceRequests === 2 ? stale.promise : latestOptions;
    }
    if (url.includes('/validation-activity')) return { items: [record('current')], exchanges: [] };
    return { items: [] };
  };
  const loading = f.context.loadViewResources('validation');
  await f.context.refreshLiveWorkspace();
  assert.equal(sourceRequests, 1);
  sources.resolve(firstOptions); await loading;
  assert.equal(f.state.sourceOptions, firstOptions);
  const older = f.context.loadViewResources('validation');
  await f.context.loadViewResources('validation');
  stale.resolve(firstOptions); await older;
  assert.equal(f.state.sourceOptions, latestOptions);
});

test('HTTP列表选择超过100条时两个导出按钮均禁用并说明限制', () => {
  const f = fixture();
  for (const count of [0, 100, 101, 500]) {
    f.state.selectedRequestExchangeIds = new Set(Array.from({ length: count }, (_, index) => `http_${index}`));
    f.context.updateExchangeSelectionControls();
    for (const id of ['export-selected-bruno', 'export-selected-har']) assert.equal(f.$(id).disabled, count === 0 || count > 100);
    if (count > 100) assert.match(f.$('selected-exchange-count').textContent, /一次最多导出 100 条/);
  }
});

test('切换结果先显示加载状态，较早详情失败不覆盖新结果', async () => {
  const f = fixture(), old = deferred(), next = deferred(), calls = [];
  f.$('validation-detail').append(new Element('p', '', '先前结果'));
  f.context.api = async (url, options) => { calls.push(options); return url.endsWith('/old') ? old.promise : next.promise; };
  const previous = f.context.selectValidation('old');
  assert.doesNotMatch(textOf(f.$('validation-detail')), /先前结果/);
  assert.match(textOf(f.$('validation-detail')), /正在读取/);
  const current = f.context.selectValidation('new');
  old.reject(new Error('过期请求失败')); await previous;
  assert.equal(f.errors.length, 0);
  next.resolve({ run: { audit_id: 'audit-new', finding: { id: 'finding-new', outcome: 'SUPPORTED' }, environment: {}, actor: {}, network: { exchanges: [] } } });
  await current;
  assert.match(textOf(f.$('validation-detail')), /audit-new.*finding-new/);
  assert.ok(calls.every(options => options.signal));
});

test('来源范围切换后不保留其他审计的结果详情', () => {
  const f = fixture(); f.state.selectedValidationId = 'run-one';
  f.state.validationRuns = [{ id: 'run-one', audit_id: 'audit-one' }];
  f.state.sourceFilters.validation.audit_id = 'audit-two';
  f.$('validation-detail').hidden = false;
  f.context.renderValidation();
  assert.equal(f.state.selectedValidationId, null);
  assert.equal(f.$('validation-detail').hidden, true);
});
