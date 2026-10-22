import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/dynamic-validation-observatory/public/app.js', import.meta.url), 'utf8');
const functions = ['cancelValidationDraft', 'validationDraftButton', 'renderReports', 'renderFindings'].map(name => {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm')); assert.ok(match, name); return match[0];
}).join('\n');
class Element {
  constructor(tag, _className, text = '') { this.tag = tag; this.textContent = text; this.children = []; this.listeners = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute() {}
  close() { this.open = false; }
}
function fixture(writable = true) {
  const nodes = new Map(), calls = [], drafts = [], errors = [];
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element('div')); return nodes.get(id); };
  const element = (...args) => new Element(...args);
  const state = { validationDraftSequence: 0, findingPage: 1, findingTotal: 1, findingTotalPages: 1,
    findings: [{ id: 'finding-a', resource_id: 'finding-resource', title: '测试漏洞', severity: 'HIGH' }], workspace: { reports: [{ id: 'report-a', name: '报告' }] } };
  const context = vm.createContext({ $, state, element, disposed: false, AbortController, AbortSignal, encodeURIComponent,
    onValidationCreate: writable ? draft => drafts.push(draft) : null, showError: error => errors.push(error),
    api: (url, options) => new Promise((resolve, reject) => calls.push({ url, options, resolve, reject })),
    renderSourceFilters() {}, matchesSource: () => true, sortReportsByTime: rows => rows, bytes: String, formatDate: String,
    sourceContext: () => element('div'), status: () => element('span'), short: String });
  vm.runInContext(functions, context);
  const all = node => [node, ...node.children.flatMap(all)];
  return { context, $, calls, drafts, errors, state, all };
}
test('真实报告页和漏洞页均出现入口，点击只读取草稿，不创建任务', async () => {
  const f = fixture(); f.context.renderReports(); f.context.renderFindings();
  for (const [container, label, path] of [['report-grid', '基于报告验证', 'reports/report-a'], ['finding-table', '验证此漏洞', 'findings/finding-resource']]) {
    const button = f.all(f.$(container)).find(node => node.textContent === label); assert.ok(button);
    const pending = button.listeners.click(); assert.equal(button.disabled, true);
    await button.listeners.click(); const call = f.calls.at(-1);
    assert.equal(call.url, `/api/workbench/${path}/validation-draft`); assert.equal(call.options.body, '{}');
    call.resolve({ sourceFindingCount: 1 }); await pending; assert.equal(button.disabled, false);
  }
  assert.equal(f.calls.length, 2); assert.equal(f.drafts.length, 2); assert.equal(f.errors.length, 0);
  const readonly = fixture(false); readonly.context.renderReports(); readonly.context.renderFindings();
  assert.equal(readonly.all(readonly.$('report-grid')).some(node => node.textContent === '基于报告验证'), false);
  assert.equal(readonly.all(readonly.$('finding-table')).some(node => node.textContent === '验证此漏洞'), false);
});
test('关闭弹窗或切换页面后忽略迟到的验证草稿；错误可重试', async () => {
  const f = fixture(), dialog = f.$('finding-dialog'); dialog.open = true;
  const button = f.context.validationDraftButton('findings', { resource_id: 'a' }, 'finding-dialog');
  let pending = button.listeners.click(); dialog.close(); f.calls.at(-1).resolve({}); await pending;
  assert.equal(f.drafts.length, 0);
  dialog.open = true; pending = button.listeners.click(); f.context.cancelValidationDraft();
  assert.equal(f.calls.at(-1).options.signal.aborted, true); f.calls.at(-1).resolve({}); await pending;
  assert.equal(f.drafts.length, 0);
  pending = button.listeners.click(); f.calls.at(-1).reject(new Error('来源报告已变化')); await pending;
  assert.equal(f.errors.length, 1); assert.equal(button.disabled, false);
});
