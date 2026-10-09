import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Exercise the real monitor and adapter without a browser, PTY or new dependency.
// Child-window operations are recorded; no terminal is started by these tests.
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../../../.opencode/web/dynamic-validation-observatory/monitor/audit-monitor.js', import.meta.url))],
  bundle: true, format: 'esm', platform: 'node', write: false,
  nodePaths: [fileURLToPath(new URL('../node_modules', import.meta.url))], loader: { '.css': 'empty' },

});
const { createAuditMonitor, replaceAuditSections } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

class NodeFixture {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.childNodes = []; this.parentNode = null;
    this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.className = ''; this.hidden = false;
    this.scrollTop = 0; this.scrollHeight = 1000; this.clientHeight = 200; this.open = false; this._text = ''; this._value = '';
    this.classList = { toggle: (name, enabled) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      if (enabled ?? !names.has(name)) names.add(name); else names.delete(name);
      this.className = [...names].join(' ');
    } };
  }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.childNodes.map(node => node.textContent).join(''); }
  set value(value) { this._value = String(value); }
  get value() { return this._value; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.childNodes.push(node); } }
  replaceChildren(...nodes) {
    for (const node of [...this.childNodes]) node.remove();
    this._text = ''; this.append(...nodes);
    if (this.tagName === 'SELECT') this._value = this.childNodes[0]?.value || '';
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes; siblings.splice(siblings.indexOf(this), 1); this.parentNode = null;
    this.removals = (this.removals || 0) + 1;
  }
  insertBefore(node, reference) { node.remove(); node.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(reference), 0, node); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  addEventListener(name, listener) { const listeners = this.listeners.get(name) || []; listeners.push(listener); this.listeners.set(name, listeners); }
  fire(name, values = {}) { for (const fn of this.listeners.get(name) || []) fn({ target: this, currentTarget: this, preventDefault() {}, ...values }); }
  click() { if (!this.disabled) this.fire('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  getRootNode() { return this.parentNode?.getRootNode() || this.ownerDocument; }
  querySelectorAll(selector) { return descendants(this).filter(node => node.tagName.toLowerCase() === selector); }
}

const descendants = node => node.childNodes.flatMap(child => [child, ...descendants(child)]);
const find = (node, className) => descendants(node).find(child => child.className.split(/\s+/).includes(className));
const findAll = (node, className) => descendants(node).filter(child => child.className.split(/\s+/).includes(className));
const audit = overrides => ({ id: 'audit-test', task_board: { reported: 0, total: 4, running: 1, pending: 3 },
  terminal: { live: true, socket_name: 'socket-test', target: 'audit:tui' }, ...overrides });
const log = (id, text, overrides = {}) => ({ occurred_at: '2026-10-04T16:00:00.000Z', source: 'stdout', kind: 'raw', label: 'Runner 输出',
  body: `[web/${id}] ${JSON.stringify({ type: 'tool_use', sessionID: 'ses-test', part: { id: `prt-${text}`, callID: `call-${text}`, tool: 'read',
    state: { status: 'running', input: { filePath: `${text}.py` }, output: text } } })}`, detail: '', ...overrides });

function fixture(options = {}) {
  const document = { createElement: tag => new NodeFixture(tag, document) };
  const frames = [], popups = [], blobs = [], revoked = [];
  const window = options.window || { location: { port: options.port || '4181' }, requestAnimationFrame: fn => frames.push(fn),
    URL: { createObjectURL: blob => { blobs.push(blob); return `blob:test-${blobs.length}`; }, revokeObjectURL: url => revoked.push(url) },
    open(url, target, features) {
      if (options.blocked) return null;
      if (options.openError) throw new Error('open fixture failed');
      const child = { url, target, features, opener: window, closed: false, focused: 0, navigations: [],
        location: { replace(value) { child.navigations.push(value); } }, focus() { this.focused++; } };
      popups.push(child); return child;
    },
  };
  const monitor = createAuditMonitor({ document, window, audit: options.audit || audit(), serverUrl: options.serverUrl,
    renderOriginalEvent: item => {
      const node = document.createElement('article'); node.className = 'original-event'; node.textContent = item.body;
      if (item.detail) { const detail = document.createElement('details'); detail.className = 'original-detail'; detail.textContent = item.detail; node.append(detail); }
      return node;
    } });
  return { ...monitor, document, window, popups, blobs, revoked,
    get: name => find(monitor.element, name), all: name => findAll(monitor.element, name),
    tab: view => descendants(monitor.element).find(node => node.dataset.view === view),
    flush() { let count = 0; while (frames.length) { frames.shift()(); if (++count > 100) throw new Error('RAF loop'); } },
  };
}

test('重复刷新去重，工具状态变化仍可见，不将单步完成当成任务完成', () => {
  const f = fixture(); f.tab('events').click();
  const running = log('task-1', 'inspect');
  f.setEvents([running]); f.setEvents([running]);
  assert.equal(f.all('monitor-event').length, 1);
  const completed = { ...running, body: running.body.replace('"running"', '"completed"') };
  f.setEvents([completed]);
  assert.equal(f.all('monitor-event').length, 2);
  assert.equal(f.all('monitor-event-state').at(-1).textContent, '工具已完成');
  assert.equal(f.get('monitor-summary').textContent, '已交付 0 / 4 · 运行 1 · 待执行 3');
  f.destroy();
});

test('筛选、停止跟随、详情展开和滚动位置在事件刷新后保留', () => {
  const f = fixture(); f.tab('events').click();
  const first = log('task-1', 'inspect'); f.setEvents([first, log('task-2', 'other')]); f.flush();
  const details = f.get('monitor-event-detail'); details.open = true;
  const tasks = f.get('monitor-select'); tasks.value = 'task-1'; tasks.fire('change');
  const search = f.get('monitor-search'); search.value = 'inspect'; search.fire('input'); f.flush();
  const viewport = f.get('monitor-event-viewport'); viewport.scrollTop = 123; viewport.fire('scroll');
  assert.equal(f.get('monitor-follow').getAttribute('aria-pressed'), 'false');
  f.setEvents([first, log('task-1', 'next')]); f.flush();
  assert.equal(tasks.value, 'task-1'); assert.equal(search.value, 'inspect');
  assert.equal(f.get('monitor-event-detail'), details); assert.equal(details.open, true);
  assert.equal(viewport.scrollTop, 123); assert.equal(f.get('monitor-event-count').textContent, '1 / 3 条');
  f.destroy();
});

test('pinned 替换其他详情章节不会断开监控 DOM 节点', () => {
  const f = fixture(), panel = f.document.createElement('main');
  const old = f.document.createElement('section'); panel.append(old, f.element);
  const before = f.element.removals || 0, next = f.document.createElement('section');
  replaceAuditSections(panel, [next, f.element], f.element);
  assert.deepEqual(panel.childNodes, [next, f.element]); assert.equal(old.parentNode, null);
  assert.equal(f.element.removals || 0, before);
  f.destroy();
});

test('最多保留 500 个事件，导出按当前筛选且推理正文不会出现在回退视图', async () => {
  const f = fixture({ audit: audit({ terminal: null }) });
  f.setEvents(Array.from({ length: 501 }, (_, i) => log(`task-${i}`, `sample-${i}`)));
  assert.equal(f.all('monitor-event').length, 500);
  assert.equal(f.all('monitor-agent')[0].textContent, 'task-1');
  const tasks = f.get('monitor-select'); tasks.value = 'task-500'; tasks.fire('change');
  descendants(f.element).find(node => node.textContent === '导出当前视图').click();
  const exported = await f.blobs[0].text(); assert.match(exported, /sample-500/); assert.doesNotMatch(exported, /sample-499/);
  f.setEvents([{ kind: 'reasoning', body: 'PRIVATE_REASONING_FIXTURE' }]);
  tasks.value = ''; tasks.fire('change'); f.tab('original').click();
  assert.doesNotMatch(f.element.textContent, /PRIVATE_REASONING_FIXTURE/); assert.match(f.element.textContent, /正文不展示/);
  f.destroy(); assert.deepEqual(f.revoked, ['blob:test-1']);
});

test('任务事件与原始事件切换后恢复调用参数展开状态', () => {
  const f = fixture(); f.tab('events').click(); f.setEvents([log('task-1', 'inspect')]);
  f.get('monitor-event-detail').open = true;
  f.tab('original').click(); f.tab('events').click();
  assert.equal(f.get('monitor-event-detail').open, true);
  f.destroy();
});

test('两个事件视图各自保存展开和滚动位置，开启跟随后仍滚动到新事件', () => {
  const f = fixture(); f.tab('events').click();
  f.setEvents([{ occurred_at: '2026-10-04T16:00:00Z', kind: 'tool', label: '读取源码', tool: 'read', body: 'source', detail: 'input' }]);
  f.flush(); f.get('monitor-follow').click();
  const viewport = f.get('monitor-event-viewport');
  f.get('monitor-event-detail').open = true; viewport.scrollTop = 123;
  f.tab('original').click();
  assert.equal(f.get('original-detail').open, false); assert.equal(viewport.scrollTop, 0);
  f.get('original-detail').open = true; viewport.scrollTop = 321;
  f.tab('events').click();
  assert.equal(f.get('monitor-event-detail').open, true); assert.equal(viewport.scrollTop, 123);
  f.tab('original').click();
  assert.equal(f.get('original-detail').open, true); assert.equal(viewport.scrollTop, 321);
  f.get('original-detail').open = false; f.tab('events').click();
  assert.equal(f.get('monitor-event-detail').open, true);
  f.get('monitor-follow').click(); f.setEvents([log('task-1', 'next')]); f.flush();
  assert.equal(viewport.scrollTop, viewport.scrollHeight);
  f.destroy();
});

test('SSE 恢复后更新连接提示，复用最后同步时间而不伪造新同步', () => {
  const f = fixture(); f.setConnection('reconnecting');
  assert.match(f.get('monitor-footer').textContent, /正在重连/);
  f.setConnection('connected'); assert.equal(f.get('monitor-footer').textContent, '事件已连接 · 等待首次同步');
  f.setEvents([log('task-1', 'inspect')]); const synced = f.get('monitor-footer').textContent;
  f.setConnection('reconnecting'); f.setConnection('connected');
  assert.equal(f.get('monitor-footer').textContent, synced); assert.doesNotMatch(synced, /重连/);
  f.destroy();
});

const sharedAudit = overrides => audit({ status: 'running', provider_session_id: 'ses_fixture',
  terminal: { live: true, shared_server: true, socket_name: 'owa-fixture', server_generation: 'generation-1' }, ...overrides });

test('点击才弹出独立终端，保持事件筛选、展开、滚动和原始视图', () => {
  const f = fixture({ audit: sharedAudit() });
  f.setAudit(sharedAudit()); assert.equal(f.popups.length, 0);
  assert.equal(f.element.dataset.view, 'events'); assert.equal(f.tab('terminal'), undefined);
  f.setEvents([log('task-1', 'inspect')]); f.flush();
  f.get('monitor-follow').click(); f.get('monitor-event-detail').open = true;
  f.get('monitor-event-viewport').scrollTop = 123;
  f.get('monitor-search').value = 'inspect';
  f.get('monitor-open-terminal').click();
  const child = f.popups[0], url = new URL(child.navigations[0]);
  assert.match(child.features, /popup=yes/); assert.equal(child.opener, null);
  assert.equal(url.pathname, '/audits/audit-test/');
  assert.equal(url.searchParams.get('generation'), 'generation-1');
  assert.equal(f.element.dataset.view, 'events'); assert.equal(f.get('monitor-event-detail').open, true);
  assert.equal(f.get('monitor-event-viewport').scrollTop, 123); assert.equal(f.get('monitor-search').value, 'inspect');
  f.tab('original').click(); f.get('monitor-open-terminal').click();
  assert.equal(f.element.dataset.view, 'original'); assert.equal(f.popups.length, 1); assert.equal(child.focused, 2);
  f.destroy(); assert.equal(child.closed, false);
});

test('子窗口跨详情重开复用；普通刷新不重新导航，服务代次改变后点击才更新连接', () => {
  const f = fixture({ audit: sharedAudit() }); f.get('monitor-open-terminal').click(); const child = f.popups[0];
  f.setAudit(sharedAudit()); assert.equal(child.navigations.length, 1); f.destroy();
  const g = fixture({ window: f.window, audit: sharedAudit() }); g.get('monitor-open-terminal').click();
  assert.equal(f.popups.length, 1); assert.equal(child.navigations.length, 1); assert.equal(child.focused, 2);
  g.setAudit(sharedAudit({ terminal: { ...sharedAudit().terminal, server_generation: 'generation-2' } }));
  assert.equal(child.navigations.length, 1);
  g.get('monitor-open-terminal').click(); assert.equal(child.navigations.length, 2);
  g.destroy(); assert.equal(child.closed, false);
});

test('子窗口关闭后按需重开，不同任务使用不同窗口', () => {
  const f = fixture({ audit: sharedAudit() }); f.get('monitor-open-terminal').click();
  f.popups[0].closed = true; f.setAudit(sharedAudit()); assert.equal(f.popups.length, 1);
  f.get('monitor-open-terminal').click(); assert.equal(f.popups.length, 2);
  const g = fixture({ window: f.window, audit: sharedAudit({ id: 'audit-other' }) }); g.get('monitor-open-terminal').click();
  assert.equal(f.popups.length, 3);
  assert.equal(new URL(f.popups[2].navigations[0]).pathname, '/audits/audit-other/');
  f.destroy(); g.destroy();
});

test('弹窗被拦截或打开异常提供链接，事件读取仍可恢复', () => {
  for (const flags of [{ blocked: true }, { openError: true }]) {
    const f = fixture({ ...flags, audit: sharedAudit() }); f.get('monitor-open-terminal').click();
    assert.match(f.get('monitor-notice').textContent, /允许此站点弹出窗口/);
    const fallback = f.get('monitor-popup-fallback'); assert.equal(fallback.target, '_blank'); assert.match(fallback.rel, /noopener/);
    assert.equal(new URL(fallback.href).pathname, '/audits/audit-test/');
    f.setEvents([log('task-1', 'inspect')]); const card = f.get('monitor-event'); f.setEventsError('HTTP fixture 503');
    assert.equal(f.get('monitor-event'), card); assert.match(f.get('monitor-notice').textContent, /HTTP fixture 503/);
    f.setEvents([log('task-1', 'inspect')]); assert.doesNotMatch(f.get('monitor-notice').textContent, /HTTP fixture 503/);
    f.destroy();
  }
});

test('暂停、结束、缺失或无效终端禁用入口，恢复后等待用户点击', () => {
  for (const change of [{ status: 'paused' }, { status: 'completed' }, { terminal: null }]) {
    const f = fixture({ audit: sharedAudit(change) }); assert.equal(f.get('monitor-open-terminal').disabled, true);
    f.get('monitor-open-terminal').click(); assert.equal(f.popups.length, 0);
    f.setAudit(sharedAudit()); assert.equal(f.get('monitor-open-terminal').disabled, false); assert.equal(f.popups.length, 0);
    f.get('monitor-open-terminal').click(); assert.equal(f.popups.length, 1); f.destroy();
  }
  const f = fixture({ serverUrl: 'invalid', audit: sharedAudit() });
  assert.equal(f.get('monitor-open-terminal').disabled, true); assert.match(f.get('monitor-notice').textContent, /连接地址无效/); f.destroy();
});

test('旧入口也能打开子窗口，旧任务保持只读；键盘导航只遍历两个事件标签', () => {
  const f = fixture({ port: '4173', audit: audit({ status: 'running' }) }); f.get('monitor-open-terminal').click();
  const url = new URL(f.popups[0].navigations[0]); assert.equal(url.pathname, '/audits/audit-test/');
  assert.equal(url.searchParams.has('socket'), false); assert.equal(url.searchParams.has('target'), false);
  assert.equal(f.get('monitor-open-terminal').textContent, '原始终端（只读）↗');
  const tabs = f.get('monitor-tabs'); tabs.fire('keydown', { key: 'End' }); assert.equal(f.element.dataset.view, 'original');
  tabs.fire('keydown', { key: 'ArrowRight' }); assert.equal(f.element.dataset.view, 'events');
  tabs.fire('keydown', { key: 'ArrowLeft' }); assert.equal(f.element.dataset.view, 'original');
  tabs.fire('keydown', { key: 'Home' }); assert.equal(f.element.dataset.view, 'events'); f.destroy();
});
