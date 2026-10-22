import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { RuntimeTestingService } from '../lib/runtime-testing/service.mjs';
import { authorize, selection, seal } from '../lib/runtime-testing/contract.mjs';
import { readReportSource, reportSourceRequest, selectReportFindings, verifyReportSource } from '../lib/runtime-testing/report-source.mjs';
import { verifyRuntimeEvidenceFiles } from '../lib/runtime-testing/evidence.mjs';
import { workerInput } from '../lib/runtime-testing/environment-prompt.mjs';
import { AgentSlots } from '../lib/agent-slots.mjs';
import { atomicJson, hash } from '../lib/task-board/contract.mjs';
import { createBoard, TaskBoardStore } from '../lib/task-board/store.mjs';
import { renderBoardReport, prepareReview, acceptReview, finalizeBoard, verifyBoardCompletion } from '../lib/task-board/review.mjs';

const scope = 'a'.repeat(64), auditId = 'report-validation-test';
const finding = id => ({ finding_id: id, title: `候选 ${id}`, description: '测试对象授权检查', vulnerability_type_id: 'JW-ACCESS-01',
  location: { path: 'src/orders.ts', line: 42 }, reproduction: { steps: ['先正常访问专用测试对象，再比较另一授权身份。'] }, review: { verdict: 'TRUE_POSITIVE', reason: '静态证据支持。', evidence_refs: ['src/orders.ts:42'], gaps: [] } });
const sourceReport = () => seal({ protocol: 'report-validation.v1', source: { report_id: 'report-original', audit_id: 'original', repository_id: 'test-repo', report_path: 'final/security-audit-report.original.md', report_sha256: 'b'.repeat(64), model_sha256: 'c'.repeat(64), model_path: 'final/task-board-report-model.original.json', scope_digest: scope, finding_count: 2 }, findings: [finding('f-one'), finding('f-two')] });
const submission = (extra = {}) => ({ execution_status: 'COMPLETED', outcome: 'NOT_OBSERVED', cleanup_status: 'NOT_REQUIRED', summary: '测试夹具正常交付。', observations: [], gaps: [], changes: [], evidence_ids: [], ...extra });
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'report-validation-'))), reports = join(root, 'reports'); await mkdir(reports);
  const selected = selection({ runtime_testing: { protocol: 'runtime-testing.v2', mode: 'TARGETED_CONFIRMATION', explicit_authorization: true, budget_minutes: 10, allowed_actions: ['navigate', 'normal_interaction', 'test_input'] } });
  const authorization = authorize({ auditId, selected, enabled: options.enabled ?? true, context: options.context ?? '授权 http://fixture.test 的专用测试记录。', scopeDigest: scope });
  const calls = { workers: [], browser: 0, planner: 0, hints: [] };
  const service = new RuntimeTestingService({ root: join(reports, 'runtime-testing', auditId), privateRoot: join(root, 'private', 'runtime'),
    authorization: authorization.public, privateContext: authorization.private, sourceReport: options.sourceReport ?? sourceReport(), agentSlots: new AgentSlots(2),
    planner: () => { calls.planner++; assert.fail('报告验证不得启动 Planner'); },
    browserFactory: async () => { calls.browser++; return { tools: async () => [{ name: 'navigate_page', inputSchema: { type: 'object' } }], close: async () => {},
      call: async (name, args) => ({ content: [], structuredContent: { pages: [{ id: 1, selected: true, url: args.url }] } }) }; },
    worker: async ({ controller, active }) => {
      calls.workers.push(active.packet);
      if (options.worker) return options.worker({ controller, active, service });
      if (options.onConfirm && active.packet.phase === 'CONFIRM') return options.onConfirm({ controller, active, service });
      if (active.packet.phase === 'CONTACT') await controller.configureEnvironment(active.token, { target_url: 'http://fixture.test', origins: ['http://fixture.test'], identities: [{ id: 'test-user', role: 'test-user' }], sensitive_values: ['PRIVATE_SECRET'] });
      else calls.hints.push(workerInput(active.packet, controller.authorization, controller.privateContext, { scope: controller.state.scopes.find(row => row.id === active.packet.scope_ref.id), revision: service.exploration.state.finding_revisions.find(row => row.id === active.packet.finding_revision_id) }));
      const ev = await controller.call(active.token, 'navigate_page', { identity_id: 'test-user', url: 'http://fixture.test/orders' });
      await controller.submit(active.token, submission({ evidence_ids: [ev.evidence_id], ...(active.packet.phase === 'CONFIRM' ? { outcome: 'SUPPORTED', observations: ['专用测试数据出现权限对照差异。'], proof: { application_input: '真实应用入口', reachability: '测试页面可达', attacker_influence: '测试参数', boundary_failure: '对照差异', impact: '仅专用记录', countercheck: '正常请求对照' } } : {}) }));
      if (options.exhaust && active.packet.phase === 'CONTACT') controller.state.elapsed_ms = controller.state.budget_ms;
    } });
  t.after(async () => { await service.shutdown(); await rm(root, { recursive: true, force: true }); });
  await service.start(); return { service, calls, root, reports };
}
async function settle(service) {
  for (let i = 0; i < 40; i++) {
    await service.draining; await service.exploration.running; await new Promise(resolve => setImmediate(resolve));
    if (!service.draining && !service.exploration.running && ['COMPLETED', 'BLOCKED', 'SKIPPED', 'QUARANTINED'].includes(service.exploration.state.status)) return;
  }
  assert.fail(JSON.stringify(service.exploration.snapshot()));
}

test('报告驱动仅做短 CONTACT 和逐项 CONFIRM，完整复现线索传入 Worker，零 Planner', async t => {
  const f = await fixture(t); await f.service.contact(); await settle(f.service);
  assert.deepEqual(f.calls.workers.map(row => row.phase), ['CONTACT', 'CONFIRM', 'CONFIRM']);
  assert.equal(f.calls.workers[0].budget_seconds, 120); assert.equal(f.calls.workers[1].budget_seconds, 300); assert.equal(f.calls.planner, 0);
  assert.deepEqual(f.calls.hints[0].source_hint.finding.reproduction, finding('f-one').reproduction);
  for (let i = 0; i < 3; i++) { f.service.exploration.notify(); await settle(f.service); }
  assert.equal(f.calls.workers.length, 3);
  await f.service.close(); const evidence = await verifyRuntimeEvidenceFiles(join(f.service.root, 'evidence-set.json')); assert.equal(evidence.packets.length, 3);
  assert.ok(f.service.exploration.state.report_validation.findings.every(row => row.execution_status === 'COMPLETED'));
  const path = join(f.root, 'board.json'); await createBoard({ path, auditId, auditMode: 'dynamic', scopeDigest: scope, bacMode: 'off' });
  const store = await new TaskBoardStore({ path, reportsRoot: f.reports, auditId, scopeDigest: scope }).open(); t.after(() => store.close());
  const input = await prepareReview(store, { runtimeRequired: true }); const doc = JSON.parse(await readFile(join(f.reports, input.path), 'utf8'));
  assert.equal(doc.tasks.length, 0); assert.equal(doc.candidates.length, 2);
  const artifact = async (role, extra) => { const path = `validation/${role}.json`; await atomicJson(join(f.reports, path), { protocol: 'task-board.v1', audit_id: auditId, input_sha256: input.sha256, role, agent_session_id: `session-${role}`, ...extra }); return { path, sha256: hash(await readFile(join(f.reports, path))) }; };
  const findings = verdict => doc.candidates.map(row => ({ candidate_id: row.candidate_id, verdict, reason: '已核对独立动态证据。', evidence_refs: [doc.runtime.path], gaps: [] }));
  const quality = await artifact('REPORT_REVIEW', { assessments: [] });
  const affirmative = await artifact('AFFIRMATIVE', { findings: findings('PROVEN') });
  const negative = await artifact('NEGATIVE', { findings: findings('NOT_REFUTED'), affirmative_sha256: affirmative.sha256 });
  const moderator = await artifact('MODERATOR', { findings: findings('TRUE_POSITIVE'), affirmative_sha256: affirmative.sha256, negative_sha256: negative.sha256 });
  await acceptReview(store, { quality, affirmative, negative, moderator }); await finalizeBoard(store);
  const result = await verifyBoardCompletion({ audit: { id: auditId, audit_mode: 'dynamic', task_board_path: path, runtime_testing: { protocol: 'runtime-testing.v2' }, bac_analysis: { mode: 'off' }, runtime_scope_digest: scope }, reportsRoot: f.reports });
  assert.equal(result.complete, true, JSON.stringify(result.errors));
  const report = await readFile(join(f.reports, result.final_report_path), 'utf8'); assert.match(report, /最终报告动态验证/); assert.match(report, /f-one/); assert.match(report, /f-two/);
  await writeFile(join(f.service.root, 'source-report.json'), JSON.stringify({ ...sourceReport(), findings: [] }));
  await assert.rejects(verifyRuntimeEvidenceFiles(join(f.service.root, 'evidence-set.json')), /changed/);
});

test('无授权或空环境保留每项 SKIPPED 且不启动 Worker、Planner 或浏览器', async t => {
  for (const options of [{ enabled: false }, { context: '' }]) {
    const f = await fixture(t, options); await f.service.contact(); await settle(f.service);
    assert.equal(f.calls.workers.length, 0); assert.equal(f.calls.browser, 0); assert.equal(f.calls.planner, 0);
    assert.ok(f.service.exploration.state.report_validation.findings.every(row => row.execution_status === 'SKIPPED'));
  }
});
test('单漏洞仅验证选中项；空、重复、跨报告和快照不一致均拒绝', async t => {
  const source = sourceReport(), selected = selectReportFindings(source, ['f-two']);
  assert.equal(selected.source.finding_count, 1);
  assert.deepEqual(reportSourceRequest(selected.source).finding_ids, ['f-two']);
  for (const ids of [[], ['missing'], ['f-one', 'f-one'], null]) assert.throws(() => selectReportFindings(source, ids));
  assert.throws(() => verifyReportSource(seal({ ...selected, source: { ...selected.source, finding_ids: ['f-one'] } })), /不一致/);
  const f = await fixture(t, { sourceReport: selected }); await f.service.contact(); await settle(f.service);
  assert.deepEqual(f.calls.workers.map(row => row.phase), ['CONTACT', 'CONFIRM']);
  assert.equal(f.calls.hints[0].source_hint.finding.finding_id, 'f-two');
  assert.equal(f.calls.planner, 0);
});
test('环境准备失败后逐项记录未执行原因，不启动探索或候选验证', async t => {
  const f = await fixture(t, { worker: ({ controller, active }) => controller.submit(active.token, submission({ execution_status: 'SKIPPED', outcome: 'INCONCLUSIVE', gaps: ['缺少必要的登录材料。'] })) });
  await f.service.contact(); await settle(f.service); await f.service.close();
  assert.equal(f.calls.workers.length, 1); assert.equal(f.calls.browser, 0);
  assert.ok(f.service.exploration.state.report_validation.findings.every(row => row.execution_status === 'SKIPPED' && row.reason === 'ENVIRONMENT_CONTACT_INCOMPLETE'));
});
test('总预算耗尽仍保留未测候选清单，不再消耗预算进行探索', async t => {
  const f = await fixture(t, { exhaust: true }); await f.service.contact(); await settle(f.service); await f.service.close();
  assert.equal(f.calls.workers.length, 1); assert.ok(f.service.exploration.state.report_validation.findings.every(row => row.reason === 'BUDGET_EXHAUSTED'));
});
test('取消在途 CONTACT 后结果为 CANCELLED，剩余候选逐项 SKIPPED', async t => {
  let started; const active = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { worker: async () => { started(); await new Promise(() => {}); } });
  await f.service.contact(); await active; await f.service.shutdown();
  assert.equal(f.service.controller.state.packets[0].execution_status, 'CANCELLED');
  assert.ok(f.service.exploration.state.report_validation.findings.every(row => row.execution_status === 'SKIPPED'));
});
test('必要登录超时后停止环境复用，所有报告候选记为未执行', async t => {
  const f = await fixture(t, { worker: async () => new Promise(() => {}) });
  f.service.controller.setTimer = callback => setTimeout(callback, 5);
  await f.service.contact(); await settle(f.service); await f.service.close();
  assert.equal(f.service.controller.state.packets[0].execution_status, 'TIMED_OUT');
  assert.equal(f.calls.workers.length, 1); assert.ok(f.service.exploration.state.report_validation.findings.every(row => row.execution_status === 'SKIPPED'));
});
test('单项条件不足可以跳过并继续下一项，清理失败则保留证据并停止后续项', async t => {
  const skipped = await fixture(t, { onConfirm: ({ controller, active }) => controller.submit(active.token, submission({ execution_status: 'SKIPPED', outcome: 'INCONCLUSIVE', gaps: ['当前测试部署没有该业务入口。'] })) });
  await skipped.service.contact(); await settle(skipped.service); await skipped.service.close();
  assert.equal(skipped.calls.workers.length, 3); assert.ok(skipped.service.exploration.state.report_validation.findings.every(row => row.execution_status === 'SKIPPED'));
  const failed = await fixture(t, { onConfirm: async ({ controller, active }) => {
    const ev = await controller.call(active.token, 'navigate_page', { identity_id: 'test-user', url: 'http://fixture.test/orders' });
    await controller.submit(active.token, submission({ outcome: 'SUPPORTED', cleanup_status: 'FAILED', evidence_ids: [ev.evidence_id], observations: ['测试标记已保存，清理路径失败。'], gaps: ['需人工删除专用测试记录。'],
      changes: [{ marker: 'unique-fixture-marker', resource: '专用测试记录', cleanup_status: 'FAILED' }],
      proof: { application_input: '真实应用入口', reachability: '测试页面可达', attacker_influence: '测试参数', boundary_failure: '对照差异', impact: '专用记录', countercheck: '正常请求对照' } }));
  } });
  await failed.service.contact(); await settle(failed.service); await failed.service.close();
  assert.equal(failed.calls.workers.length, 2);
  const rows = failed.service.exploration.state.report_validation.findings;
  assert.equal(rows[0].outcome, 'SUPPORTED'); assert.equal(rows[0].cleanup_status, 'FAILED'); assert.equal(rows[1].execution_status, 'SKIPPED');
  const evidence = await verifyRuntimeEvidenceFiles(join(failed.service.root, 'evidence-set.json')); assert.equal(evidence.cleanup_status, 'FAILED');
});

function finalModel() { return { protocol: 'task-board.v1', artifact_type: 'task-board-final-report', report_version: 3, audit_id: 'original', scope_digest: scope,
  summary: { total: 0, reported: 0, gap: 0, mining_strategy: 'focus_area', tracks: { focus_area: { reported: 0, total: 0 } } }, findings: [finding('f-one')],
  excluded_findings: [{ ...finding('uncertain'), review: { ...finding('uncertain').review, verdict: 'INCONCLUSIVE' } }, { ...finding('excluded'), review: { ...finding('excluded').review, verdict: 'FALSE_POSITIVE' } }], runtime_findings: [], tasks: [], assessments: [], residual_gaps: [] }; }
test('从封存模型提取确认和未确定候选，摘要绑定拒绝报告被改写和路径越界', async t => {
  const root = await mkdtemp(join(tmpdir(), 'report-source-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'final')); const model = finalModel(); const report = { id: 'report-original', audit_id: 'original', repository_id: 'test-repo', path: 'final/security-audit-report.original.md' };
  await atomicJson(join(root, 'final/task-board-report-model.original.json'), model); await writeFile(join(root, report.path), renderBoardReport(model));
  const source = await readReportSource({ root, report }); assert.deepEqual(source.findings.map(row => row.finding_id), ['f-one', 'uncertain']); assert.equal(source.source.finding_count, 2);
  assert.equal(reportSourceRequest(source.source).report_sha256, hash(await readFile(join(root, report.path))));
  await writeFile(join(root, report.path), '# 非封存报告'); await assert.rejects(readReportSource({ root, report }), /不一致/);
  await assert.rejects(readReportSource({ root, report: { ...report, path: '../outside.md' } }), /封存/);
});

test('报告 HTTP 入口校验产品与版本，创建独立任务并保存输入快照；读取不启动 Agent', async t => {
  const { AuditRunner } = await import('../web/dynamic-validation-observatory/audit-runner.mjs');
  const { createAuditWorkbenchServer } = await import('../web/dynamic-validation-observatory/server.mjs');
  const { AgentSettingsStore } = await import('../lib/audit-runtime/agent-settings.mjs');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'report-validation-api-'))), configPath = join(root, '.opencode', 'opencode.json');
  await atomicJson(configPath, { mcp: {} });
  const runner = new AuditRunner({ platformRoot: root, stateRoot: join(root, 'state', 'audits'), configPath, repositories: [{ id: 'source-repo', name: '报告来源', path: root }], enabled: true, spawnProcess() { assert.fail('禁止启动真实 Agent'); } });
  await runner.ready;
  const reports = runner.artifactSources()[0].reports_root; await mkdir(join(reports, 'final'), { recursive: true });
  const model = finalModel(); await atomicJson(join(reports, 'final/task-board-report-model.original.json'), model);
  await atomicJson(join(reports, 'correlation/test.original.json'), { audit_id: 'original', canonical_findings: [...model.findings, ...model.excluded_findings] });
  const originalPath = join(reports, 'final/security-audit-report.original.md'), original = renderBoardReport(model); await writeFile(originalPath, original);
  const server = createAuditWorkbenchServer({ runner, stateRoot: runner.stateRoot, runtimeRoot: join(root, 'runtime'), platformConfigPath: configPath,
    queueScheduler: { ready: Promise.resolve(), enqueueNewAudit: async () => true, snapshot: async () => ({}), shutdown: async () => {} },
    agentSettingsStore: new AgentSettingsStore({ path: join(root, 'agents.json'), resolveCommand: async command => command,
      probe: async (command, args) => ({ stdout: args.includes('--help') ? '--server --standalone' : command === 'opencode2' ? '2.0.29' : command === 'grow' ? 'Grow 2.2.2' : '1.16.19' }) }) });
  await server.productCatalogReady; await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await server.shutdownRunners(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, key = 'report-validation-http') => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { origin: base, 'content-type': 'application/json', 'idempotency-key': key }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const workspace = await (await request('/api/v1/workspace')).json(); const report = workspace.reports.find(row => row.audit_id === 'original'); assert.ok(report);
  const response = await request(`/api/v1/reports/${report.id}/validation-source`); const draft = await response.json(); assert.equal(response.status, 200, JSON.stringify(draft));
  assert.equal(draft.finding_count, 2); assert.equal(runner.listAudits().length, 0);
  const findings = (await (await request('/api/v1/findings')).json()).items;
  const target = findings.find(row => row.id === 'f-one'); assert.ok(target?.resource_id);
  const singleResponse = await request(`/api/v1/findings/${target.resource_id}/validation-source`);
  const single = await singleResponse.json(); assert.equal(singleResponse.status, 200, JSON.stringify(single));
  assert.equal(single.finding_count, 1); assert.deepEqual(single.source_report.finding_ids, ['f-one']);
  assert.equal(runner.listAudits().length, 0);
  const excluded = findings.find(row => row.id === 'excluded');
  assert.equal((await request(`/api/v1/findings/${excluded.resource_id}/validation-source`)).status, 422);
  assert.equal((await request('/api/v1/findings/not-found/validation-source')).status, 404);
  const input = { audit_id: 'from-report', audit_mode: 'dynamic', name: '报告验证', source_report: draft.source_report,
    test_environment_enabled: true, test_environment_context: '授权 http://fixture.test 私有登录说明 PRIVATE_CREDENTIAL',
    runtime_testing: { explicit_authorization: true, mode: 'INTEGRATED_TESTING' } };
  const path = `/api/v2/products/${draft.product_id}/audits`;
  const missing = await request(path, { ...input, test_environment_enabled: false }); assert.equal(missing.status, 422);
  const stale = await request(path, { ...input, source_report: { ...draft.source_report, model_sha256: '0'.repeat(64) } }); assert.equal(stale.status, 409);
  const other = await server.productStore.createProduct({ name: '其他产品' });
  const foreign = await request(`/api/v2/products/${other.id}/audits`, input); assert.equal(foreign.status, 404);
  const created = await request(path, input); const audit = await created.json(); assert.equal(created.status, 202, JSON.stringify(audit));
  assert.equal(audit.audit_mode, 'dynamic'); assert.equal(audit.runtime_testing.mode, 'TARGETED_CONFIRMATION'); assert.equal(audit.report_validation.audit_id, 'original');
  assert.equal(audit.private_report_source, undefined); assert.doesNotMatch(JSON.stringify(audit), /PRIVATE_CREDENTIAL/);
  const stored = JSON.parse(await readFile(join(runner.stateRoot, audit.id, 'source-report.json'), 'utf8')); assert.equal(stored.findings.length, 2);
  assert.equal((await (await request(path, input)).json()).id, audit.id); assert.equal(runner.listAudits().length, 1);
  const singleCreated = await request(path, { ...input, audit_id: 'single-finding', source_report: single.source_report }, 'single-finding-key');
  const singleAudit = await singleCreated.json(); assert.equal(singleCreated.status, 202, JSON.stringify(singleAudit));
  assert.deepEqual(singleAudit.report_validation.finding_ids, ['f-one']);
  const singleStored = JSON.parse(await readFile(join(runner.stateRoot, singleAudit.id, 'source-report.json'), 'utf8'));
  assert.deepEqual(singleStored.findings.map(row => row.finding_id), ['f-one']);
  assert.equal(await readFile(originalPath, 'utf8'), original);
  const linked = await request(path); assert.ok((await linked.json()).items.some(row => row.id === audit.id));
  // Exercise the actual queued Runner handoff with an owned fake process and
  // a Worker that records a prerequisite gap. No model or target is contacted.
  runner.customTerminalMonitor = true;
  runner.terminalMonitor = { async probe() {
    const runtime = runner.runtimeTestingServices.get(audit.id);
    runtime.worker = ({ controller, active }) => controller.submit(active.token, submission({ execution_status: 'SKIPPED', outcome: 'INCONCLUSIVE', gaps: ['夹具缺少登录材料。'] }));
    return { available: false, message: '仅使用进程替身' };
  }, async stop() {} };
  const child = new EventEmitter(); child.pid = 12345; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = signal => { queueMicrotask(() => child.emit('close', 0, signal)); return true; };
  runner.spawnProcess = (command, args, options) => { assert.equal(options.env.AUDIT_SOURCE_ROOT, ''); return child; };
  await runner.dispatchQueuedAudit(audit.id);
  const runtime = runner.runtimeTestingServices.get(audit.id); assert.ok(runtime);
  await settle(runtime); await runtime.close();
  assert.equal(runtime.sourceReport, undefined); assert.equal(runtime.exploration.sourceReport.artifact_digest, stored.artifact_digest);
  assert.ok(runtime.exploration.state.report_validation.findings.every(row => row.execution_status === 'SKIPPED'));
  assert.equal(await readFile(originalPath, 'utf8'), original);
});
