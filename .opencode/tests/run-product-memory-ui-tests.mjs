import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const uiSource = await readFile(new URL('../web/dynamic-validation-observatory/public/product-memory-ui.js', import.meta.url), 'utf8');
const { initProductMemoryUI } = await import(`data:text/javascript;base64,${Buffer.from(uiSource).toString('base64')}`);

class Element {
  constructor(tag, className = '', text = '') { this.tagName = tag; this.className = className; this.textContent = text; this.children = []; this.style = {}; this.value = ''; this.listeners = {}; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  remove() {}
}
const element = (...args) => new Element(...args);
const textOf = node => `${node.textContent ?? ''} ${node.children?.map(textOf).join(' ') ?? ''}`;
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, api) {
  const nodes = new Map(['product-memory-workspace', 'finding-memory'].map(id => [id, element('div')]));
  const original = { document: globalThis.document, window: globalThis.window };
  const events = {};
  globalThis.document = { getElementById: id => nodes.get(id), body: element('body'), hidden: false };
  globalThis.window = { addEventListener: (type, callback) => { events[type] = callback; } };
  const state = { selectedProductId: 'p1', view: 'projects', runtime: { runner: { enabled: true } }, products: [] };
  const ui = initProductMemoryUI({ state, api, element, table: () => { const table = element('table'), body = element('tbody'); table.append(body); return [table, body]; }, toast: () => {}, loadFindingsPage: async () => {} });
  t.after(() => { events.pagehide?.(); globalThis.document = original.document; globalThis.window = original.window; });
  return { nodes, state, ui };
}
function response(url, name = '当前 Repo') {
  if (url.endsWith('/tree')) return { roots: [], nodes: [{ id: 'repo', kind: 'repo', source_kind: 'directory', status: 'PRESENT', name, path: '/source', relative_path: '.' }] };
  if (url.includes('/product-audits')) return { items: [] };
  return { items: [], total: 0, next_offset: null };
}

test('产品页面能装配目录、批次、经验、问题、待办，并丢弃旧产品响应', async t => {
  const pending = []; const f = fixture(t, url => new Promise(resolve => pending.push({ url, resolve })));
  const first = f.ui.refresh(true); await tick(); f.state.selectedProductId = 'p2'; const second = f.ui.refresh(true); await tick();
  for (const call of pending.filter(p => p.url.includes('/p2/'))) call.resolve(response(call.url, '新产品 Repo')); await tick();
  for (const call of pending.filter(p => p.url.includes('/p2/memory/search'))) call.resolve(response(call.url)); await second;
  for (const call of pending.filter(p => p.url.includes('/p1/'))) call.resolve(response(call.url, '过期 Repo')); await first;
  const text = textOf(f.nodes.get('product-memory-workspace')); assert.match(text, /新产品 Repo/); assert.doesNotMatch(text, /过期 Repo/); assert.match(text, /长期记忆/); assert.match(text, /产品级审计批次/);
});

test('同产品刷新按请求顺序隔离，不让较慢的旧响应覆盖新树', async t => {
  const pending = []; const f = fixture(t, url => new Promise(resolve => pending.push({ url, resolve })));
  const first = f.ui.refresh(true); await tick(); const second = f.ui.refresh(true); await tick();
  for (const call of pending.slice(4, 8)) call.resolve(response(call.url, '最新树')); await tick();
  for (const call of pending.slice(8)) call.resolve(response(call.url)); await second;
  for (const call of pending.slice(0, 4)) call.resolve(response(call.url, '旧树')); await first;
  assert.match(textOf(f.nodes.get('product-memory-workspace')), /最新树/); assert.doesNotMatch(textOf(f.nodes.get('product-memory-workspace')), /旧树/);
});

test('漏洞详情显示人工理由、系统观察与待办，切换发现后不显示旧详情', async t => {
  let resolve; const f = fixture(t, () => new Promise(r => { resolve = r; }));
  f.state.selectedFindingResourceId = 'finding-1'; const load = f.ui.openFinding({ resource_id: 'finding-1', provenance: { product_id: 'p1' } });
  resolve({ id: 'issue', repo_id: 'repo', title: '授权边界', version: 1, human_verdict: 'FALSE_POSITIVE', remediation: 'OPEN', observations: [{ audit_id: 'audit', snapshot_id: 'version', data: { system_verdict: 'CANDIDATE' }, title: '授权边界' }], feedback: [{ created_at: new Date().toISOString(), actor: '本地操作者', reason: '外层守卫有效', data: { after: { human_verdict: 'FALSE_POSITIVE', remediation: 'OPEN' } } }], relations: [] }); await load;
  const text = textOf(f.nodes.get('finding-memory')); assert.match(text, /外层守卫有效/); assert.match(text, /CANDIDATE/); assert.match(text, /创建产品待办/);
  const stale = f.ui.openFinding({ resource_id: 'finding-1', provenance: { product_id: 'p1' } }); f.state.selectedFindingResourceId = 'finding-2'; resolve({ invalid: true }); await stale;
  assert.doesNotMatch(textOf(f.nodes.get('finding-memory')), /invalid/);
});

test('嵌入新版时使用独立文档，卸载后释放轮询并丢弃在途响应', async t => {
  const nodes = new Map(['product-memory-workspace', 'finding-memory'].map(id => [id, element('div')]));
  const document = { getElementById: id => nodes.get(id), body: element('body'), hidden: false };
  const listeners = new Map(), pending = [];
  const window = { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) };
  const state = { selectedProductId: 'scoped-product', view: 'projects', runtime: { runner: { enabled: true } }, products: [] };
  let cleared = false; const timer = {};
  t.mock.method(globalThis, 'setInterval', () => timer);
  t.mock.method(globalThis, 'clearInterval', value => { assert.equal(value, timer); cleared = true; });
  const ui = initProductMemoryUI({ document, window, state, api: url => new Promise(resolve => pending.push({ url, resolve })), element, table: () => [element('table'), element('tbody')], toast: () => {} });
  const refreshing = ui.refresh(true); await tick(); ui.destroy();
  for (const item of pending) item.resolve(response(item.url, '不应渲染的旧响应'));
  await refreshing;
  assert.equal(cleared, true); assert.equal(listeners.has('pagehide'), false);
  assert.doesNotMatch(textOf(nodes.get('product-memory-workspace')), /不应渲染的旧响应/);
});

test('产品联合审计选择基座与对应模型，切换时忽略旧基座迟到响应并显式提交', async t => {
  const pending = [], writes = [];
  const agents = { default_engine: 'grow', profiles: [{ id: 'grow', label: 'Grow', available: true }, { id: 'opencode-v2', label: 'OpenCode v2', available: true }] };
  const f = fixture(t, async (url, options = {}) => {
    if (url === '/api/v1/settings/agents') return { agents };
    if (url.startsWith('/api/v1/settings/model')) return new Promise(resolve => pending.push({ url, resolve }));
    if (options.method === 'POST') { writes.push(JSON.parse(options.body)); return { id: 'campaign' }; }
    return response(url);
  });
  const walk = node => [node, ...(node.children ?? []).flatMap(walk)];
  const opening = walk(f.nodes.get('product-memory-workspace')).find(node => node.textContent === '审计整个产品').listeners.click();
  await tick();
  assert.equal(pending[0].url, '/api/v1/settings/model?engine=grow');
  const modelResponse = (model, id = 'default') => ({ model: { options: [{ value: id, label: model }], selected_model: id } });
  pending[0].resolve(modelResponse('Grow 默认')); await opening;
  const dialog = globalThis.document.body.children.at(-1), form = walk(dialog).find(node => node.tagName === 'form');
  const [engine, model] = walk(form).filter(node => node.tagName === 'select');
  engine.value = 'opencode-v2'; const old = engine.listeners.change(); await tick();
  engine.value = 'grow'; const fresh = engine.listeners.change(); await tick();
  pending[2].resolve(modelResponse('Grow 模型', 'grow/fast')); await fresh;
  pending[1].resolve(modelResponse('旧 v2 模型', 'v2/old')); await old;
  assert.equal(model.value, 'grow/fast'); assert.doesNotMatch(textOf(model), /旧 v2/);
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(writes.length, 1); assert.equal(writes[0].engine, 'grow'); assert.equal(writes[0].model, 'grow/fast');
});

test('联合审计过滤未启用基座，全部关闭时不读模型也不创建任务', async t => {
  const walk = node => [node, ...(node.children ?? []).flatMap(walk)];
  const agents = { default_engine: 'grow', profiles: [{ id: 'grow', label: 'Grow', enabled: true, available: true }, { id: 'opencode-v2', label: 'OpenCode v2', enabled: false, available: false }] };
  const calls = [];
  const f = fixture(t, async (url, options = {}) => {
    calls.push({ url, method: options.method });
    if (url === '/api/v1/settings/agents') return { agents };
    if (url.startsWith('/api/v1/settings/model')) return { model: { options: [{ value: 'default', label: '默认模型' }], selected_model: 'default' } };
    return response(url);
  });
  const open = () => walk(f.nodes.get('product-memory-workspace')).find(node => node.textContent === '审计整个产品').listeners.click();
  await open();
  let dialog = globalThis.document.body.children.at(-1);
  assert.deepEqual(walk(dialog).find(node => node.tagName === 'select').children.map(node => node.value), ['grow']);
  dialog.close(); calls.length = 0;
  agents.default_engine = null; agents.profiles[0].enabled = false;
  await open(); dialog = globalThis.document.body.children.at(-1);
  const form = walk(dialog).find(node => node.tagName === 'form');
  assert.match(textOf(form), /请先在工作台设置中启用/);
  assert.ok(walk(form).filter(node => node.tagName === 'select').slice(0, 2).every(node => node.disabled));
  await form.listeners.submit({ preventDefault() {} });
  assert.deepEqual(calls.map(call => call.url), ['/api/v1/settings/agents']);
});
