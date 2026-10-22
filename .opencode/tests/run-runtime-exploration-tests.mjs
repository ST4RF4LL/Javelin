import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { authorize, selection, digest, EXPLORATION_PROTOCOL } from '../lib/runtime-testing/contract.mjs';
import { RuntimeTestingService } from '../lib/runtime-testing/service.mjs';
import { verifyRuntimeEvidenceFiles, runtimeCandidates } from '../lib/runtime-testing/evidence.mjs';
import { createBoard, TaskBoardStore } from '../lib/task-board/store.mjs';
import { atomicJson, hash } from '../lib/task-board/contract.mjs';
import { prepareReview, acceptReview, finalizeBoard, verifyBoardCompletion } from '../lib/task-board/review.mjs';
import { AuditRunner } from '../web/dynamic-validation-observatory/audit-runner.mjs';
import { ProductStore } from '../web/dynamic-validation-observatory/product-store.mjs';
import { AgentSlots } from '../lib/agent-slots.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LIMITS } from '../lib/runtime-exploration/contract.mjs';
import { workerInput } from '../lib/runtime-testing/environment-prompt.mjs';

const scope = 'a'.repeat(64), auditId = 'audit-exploration-test';
async function fixture(t, { planner, enabled = true, context = '授权使用 http://fixture.test，仅观察专用测试记录。', staticStore, httpEvidence = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runtime-exploration-'))); const reports = join(root, 'reports'); await mkdir(reports);
  const selected = selection({ runtime_testing: { protocol: EXPLORATION_PROTOCOL, mode: 'INTEGRATED_TESTING', budget_minutes: 10, allowed_actions: ['navigate', 'normal_interaction', 'test_input'], explicit_authorization: true } });
  const auth = authorize({ auditId, selected, enabled, context, scopeDigest: scope });
  const counts = { browser: 0, worker: 0, planner: 0, calls: 0 };
  const service = new RuntimeTestingService({ root: join(reports, 'runtime-testing', auditId), privateRoot: join(root, 'private', 'runtime'),
    authorization: auth.public, privateContext: auth.private, staticStore, agentSlots: new AgentSlots(2),
    planner: async (input, signal) => { counts.planner++; return planner ? planner(input, signal) : { summary: '没有需要追加的实验。', complete: true, intents: [], gaps: [] }; },
    browserFactory: async () => { counts.browser++; return { tools: async () => ['navigate_page', 'get_network_request'].map(name => ({ name, inputSchema: { type: 'object' } })), close: async () => {},
      call: async (name, args) => { counts.calls++; return { content: [{ type: 'text', text: '测试页面' }], structuredContent: name === 'get_network_request'
        ? { networkRequest: { requestId: 1, method: 'GET', url: 'http://fixture.test/orders', status: '200', requestHeaders: { Authorization: 'Bearer secret-never-public' }, responseHeaders: { 'Content-Type': 'application/json' }, responseBody: '{"fixture":true}' } }
        : { pages: [{ id: 1, url: args.url, selected: true }] } }; } }; },
    worker: async ({ controller, active }) => {
      counts.worker++;
      if (active.packet.phase === 'CONTACT' && controller.authorization.environment_ready === false) await controller.configureEnvironment(active.token, {
        target_url: 'http://fixture.test/', origins: ['http://fixture.test'], identities: [{ id: 'test-user', role: 'test-user' }], sensitive_values: ['secret-never-public'],
      });
      const evidence = await controller.call(active.token, 'navigate_page', { identity_id: 'test-user', url: 'http://fixture.test/orders' });
      if (httpEvidence) await controller.call(active.token, 'get_network_request', { identity_id: 'test-user', reqid: 1 });
      await controller.submit(active.token, { execution_status: 'COMPLETED', outcome: active.packet.phase === 'CONTACT' ? 'NOT_OBSERVED' : 'SUPPORTED', cleanup_status: 'NOT_REQUIRED', summary: '已观察到测试夹具中的边界差异。',
        proof: { application_input: '真实应用入口', reachability: '可访问测试页面', attacker_influence: '专用测试参数', boundary_failure: '观察到对照差异', impact: '仅测试数据', countercheck: '正常访问作为对照' }, observations: ['正常请求和对照请求已记录。'], evidence_ids: [evidence.evidence_id], changes: [], gaps: [] });
    },
  });
  t.after(async () => { await service.shutdown(); await rm(root, { recursive: true, force: true }); });
  await service.start();
  return { root, reports, service, counts };
}
async function settle(service) {
  for (let i = 0; i < 30; i++) {
    await service.draining; await service.exploration?.running;
    await new Promise(resolve => setImmediate(resolve));
    if (!service.draining && !service.exploration?.running && ['COMPLETED', 'BLOCKED', 'SKIPPED'].includes(service.exploration?.state.status)) return;
  }
  assert.fail(`未收敛：${JSON.stringify(service.exploration.snapshot())}`);
}
function plan(input) {
  if (input.previous_intents.length) return { summary: '对照实验已交付，停止本轮探索。', complete: true, intents: [], gaps: [] };
  const source = input.scopes.find(row => row.kind === 'RUNTIME_SURFACE');
  return { summary: '根据观察到的订单入口核对身份边界。', complete: false, gaps: [], intents: [{ scope_id: source.id, question: '专用测试对象是否遵守身份边界？',
    expected_behavior: '只返回授权的测试对象。', steps: ['通过应用页面查看专用测试对象。'], counterchecks: ['比较正常请求与反证请求。'], identity_ids: ['test-user'], actions: ['navigate'], evidence_ids: source.evidence_ids }] };
}

test('v2 未授权或空环境不启动 Planner、Worker、浏览器', async t => {
  for (const args of [{ enabled: false }, { context: '' }]) {
    const f = await fixture(t, args); await f.service.contact(); await settle(f.service);
    assert.deepEqual(f.counts, { browser: 0, worker: 0, planner: 0, calls: 0 });
  }
});
test('独立黑盒从真实页面发现入口，不依赖静态 Finding；事件重放不会重复实验', async t => {
  const f = await fixture(t, { planner: plan }); await f.service.contact(); await settle(f.service);
  assert.equal(f.counts.worker, 2); assert.equal(f.counts.planner, 2);
  assert.equal(f.service.exploration.state.intents.length, 1);
  for (let i = 0; i < 4; i++) { f.service.exploration.notify(); await settle(f.service); }
  assert.equal(f.counts.worker, 2);
  const packet = f.service.controller.state.packets[1]; assert.equal(packet.scope_ref.kind, 'RUNTIME_SURFACE'); assert.equal(packet.focus_area_id, null);
  await f.service.close();
  const bundle = await verifyRuntimeEvidenceFiles(join(f.service.root, 'evidence-set.json'));
  assert.equal(bundle.protocol, EXPLORATION_PROTOCOL); assert.equal(bundle.packets.length, 2);
  const candidates = runtimeCandidates(bundle); assert.equal(candidates.length, 1); assert.equal(candidates[0].source_mapping, 'UNKNOWN'); assert.equal(candidates[0].evidence_chain.length, 2);
  assert.doesNotMatch(JSON.stringify(f.service.exploration.snapshot()), /secret-never-public/);
});
test('独立动态复用精确候选和三方复核，最终中文报告不假装完成源码审计', async t => {
  const f = await fixture(t, { planner: plan }); await f.service.contact(); await settle(f.service); await f.service.close();
  const path = join(f.root, 'board.json'); await createBoard({ path, auditId, auditMode: 'dynamic', scopeDigest: scope, bacMode: 'off' });
  const store = await new TaskBoardStore({ path, reportsRoot: f.reports, auditId, scopeDigest: scope }).open(); t.after(() => store.close());
  const input = await prepareReview(store, { runtimeRequired: true });
  const doc = JSON.parse(await readFile(join(f.reports, input.path), 'utf8'));
  assert.equal(doc.tasks.length, 0); assert.equal(doc.candidates.length, 1);
  const artifact = async (role, extra) => { const value = { protocol: 'task-board.v1', audit_id: auditId, input_sha256: input.sha256, role, agent_session_id: `session-${role}`, ...extra };
    const path = `validation/${role}.json`; await atomicJson(join(f.reports, path), value); return { path, sha256: hash(await readFile(join(f.reports, path))) }; };
  const quality = await artifact('REPORT_REVIEW', { assessments: [] });
  await assert.rejects(acceptReview(store, { quality }));
  const findings = verdict => doc.candidates.map(row => ({ candidate_id: row.candidate_id, verdict, reason: '已核对封存的基线、实验和反证。', evidence_refs: [doc.runtime.path], gaps: [] }));
  const affirmative = await artifact('AFFIRMATIVE', { findings: findings('PROVEN') });
  const negative = await artifact('NEGATIVE', { findings: findings('NOT_REFUTED'), affirmative_sha256: affirmative.sha256 });
  const moderator = await artifact('MODERATOR', { findings: findings('TRUE_POSITIVE'), affirmative_sha256: affirmative.sha256, negative_sha256: negative.sha256 });
  await acceptReview(store, { quality, affirmative, negative, moderator }); await finalizeBoard(store);
  const audit = { id: auditId, audit_mode: 'dynamic', task_board_path: path, runtime_testing: { protocol: EXPLORATION_PROTOCOL }, bac_analysis: { mode: 'off' }, runtime_scope_digest: scope };
  const verification = await verifyBoardCompletion({ audit, reportsRoot: f.reports }); assert.equal(verification.complete, true, JSON.stringify(verification.errors));
  const report = await readFile(join(f.reports, verification.final_report_path), 'utf8'); assert.match(report, /独立动态测试/); assert.doesNotMatch(report, /本轮未发布审计任务/);
});
test('独立动态创建不要求源码，产品归属、执行目录和报告根可恢复', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dynamic-create-'))); const configPath = join(root, '.opencode', 'opencode.json'); await atomicJson(configPath, { mcp: {} });
  const products = new ProductStore({ path: join(root, 'catalog.sqlite') }); await products.ready; const product = await products.createProduct({ name: '测试产品' });
  const child = new EventEmitter(); child.pid = 12345; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = signal => { queueMicrotask(() => child.emit('close', 0, signal)); return true; };
  let launch;
  const runner = new AuditRunner({ platformRoot: root, stateRoot: join(root, 'state'), configPath, enabled: true,
    terminalMonitor: { async probe() {
      // Exercise real dispatch, paths and finalization without a target, browser
      // or model process. A missing login is an explicit dynamic gap.
      const runtime = runner.runtimeTestingServices.get(auditId);
      runtime.worker = async ({ controller, active }) => controller.submit(active.token, { execution_status: 'SKIPPED', outcome: 'INCONCLUSIVE',
        cleanup_status: 'NOT_REQUIRED', summary: '测试夹具未提供登录信息，本轮跳过。', observations: [], evidence_ids: [], changes: [], gaps: ['缺少测试登录信息。'] });
      return { available: false, message: '仅使用受控进程替身' };
    }, async stop() {} }, spawnProcess(command, args, options) { launch = { command, args, options }; return child; } }); await runner.ready;
  runner.setQueueScheduler({ async enqueueNewAudit() { return true; } });
  t.after(async () => { await runner.shutdown(); products.close(); await rm(root, { recursive: true, force: true }); });
  const snapshot = { kind: 'runtime-environment', product_id: product.id, target_id: null, target_name: product.name, source_scopes: [], storage_namespace: 'runtime-test-product' };
  const input = { audit_mode: 'dynamic', audit_id: auditId, target_id: null, execution_spec: snapshot, execution_spec_digest: hash(JSON.stringify(snapshot)),
    test_environment_enabled: true, test_environment_context: '授权测试环境 http://fixture.test', runtime_testing: { protocol: EXPLORATION_PROTOCOL, mode: 'INTEGRATED_TESTING', explicit_authorization: true } };
  const audit = await runner.createAuditFromTarget(input, 'dynamic-create-key'); assert.equal(audit.source_kind, 'runtime'); assert.equal(audit.status, 'queued');
  const internal = runner.audits.get(audit.id); const paths = await runner.prepareExecutionWorkspace(internal, runner.repositoryForAudit(audit));
  assert.equal(paths.source_root, null); assert.equal(internal.source_baseline, undefined); assert.match(internal.runtime_scope_digest, /^[a-f0-9]{64}$/);
  await products.linkRuntimeAudit({ auditId, productId: product.id, snapshot, snapshotDigest: input.execution_spec_digest });
  assert.equal(products.auditProductId(products.auditLink(auditId)), product.id); assert.ok((await products.auditLinksForProduct(product.id)).has(auditId));
  assert.equal((await runner.createAuditFromTarget(input, 'dynamic-create-key')).id, auditId);
  assert.equal((await runner.retryDraft(auditId)).audit_mode, 'dynamic');
  await assert.rejects(runner.createAuditFromTarget({ ...input, audit_id: 'no-auth', test_environment_enabled: false }, 'no-auth-key'), /授权/);
  await runner.dispatchQueuedAudit(auditId);
  assert.equal(launch.options.env.AUDIT_SOURCE_ROOT, ''); assert.equal(launch.options.env.AUDIT_RUNTIME_PROTOCOL, EXPLORATION_PROTOCOL);
  assert.equal(launch.options.env.AUDIT_MEMORY_CONNECTION_PATH, '');
  const runtime = runner.runtimeTestingServices.get(auditId); await settle(runtime); await runtime.close();
  const board = runner.taskBoardServices.get(auditId).store;
  const review = await prepareReview(board, { runtimeRequired: true });
  const qualityPath = 'validation/dispatch-quality.json';
  await atomicJson(join(paths.reports_root, qualityPath), { protocol: 'task-board.v1', audit_id: auditId, input_sha256: review.sha256, role: 'REPORT_REVIEW', agent_session_id: 'session-dispatch-review', assessments: [] });
  await acceptReview(board, { quality: { path: qualityPath, sha256: hash(await readFile(join(paths.reports_root, qualityPath))) } });
  await finalizeBoard(board); child.emit('close', 0, null);
  const deadline = Date.now() + 3000;
  while (runner.getAudit(auditId).status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runner.getAudit(auditId).status, 'completed', runner.getAudit(auditId).error);
  assert.equal(runner.taskBoardServices.size, 0); assert.equal(runner.runtimeTestingServices.size, 0);
  await products.unlinkAudit(auditId, null); assert.equal(products.auditLink(auditId), null);
});

async function sourceStore(f, t, findings = []) {
  const path = join(f.root, 'source-board.json');
  await createBoard({ path, auditId, scopeDigest: scope, miningStrategy: 'focus_area', bacMode: 'off', auditMode: 'joint' });
  const store = await new TaskBoardStore({ path, auditId, reportsRoot: f.reports, scopeDigest: scope }).open(); t.after(() => store.close());
  await store.publish({ tasks: [{ task_id: 'static-one', kind: 'focus_area', domain: 'web', title: '订单入口审计', prompt: '检查源码中的权限边界。', source_ref: 'threat:orders', code_refs: [] }] });
  const job = await store.claim('web', 600000); const inputRoot = join(f.root, 'source-delivery'); await mkdir(inputRoot);
  await atomicJson(join(inputRoot, 'report.json'), { summary: '订单源码已交付。', findings, gaps: [] });
  const receipt = { protocol: 'task-board.v1', audit_id: auditId, task_id: job.task.task_id, attempt_id: job.attempt.attempt_id, outcome: 'REPORTED', report_path: 'report.json' };
  await store.receive({ taskId: job.task.task_id, attemptId: job.attempt.attempt_id, receipt, inputRoot });
  await store.receive({ taskId: job.task.task_id, attemptId: job.attempt.attempt_id, receipt, inputRoot });
  assert.equal(store.snapshot().outbox.length, 1);
  await store.seal(); f.service.exploration.staticStore = () => store;
  return store;
}

test('静态报告回执生成一次版本事件，CONFIRM 绑定不可变 Finding 且拒绝伪造版本', async t => {
  const f = await fixture(t, { planner: input => {
    if (input.previous_intents.length) return { summary: '候选已完成定向实验。', complete: true, intents: [], gaps: [] };
    const rev = input.finding_revisions[0], surface = input.scopes.find(row => row.id === rev.scope_id);
    return { summary: '针对已交付的源码候选核实运行行为。', complete: false, gaps: [], intents: [{ ...plan({ ...input, scopes: [{ ...surface, kind: 'RUNTIME_SURFACE' }] }).intents[0],
      finding_revision_id: rev.id, vulnerability_type_id: 'JW-ACCESS-01' }] };
  } });
  const finding = { finding_id: 'source-order', title: '对象访问边界待验证', description: '在授权测试对象上核对。' };
  await sourceStore(f, t, [finding]); await f.service.contact(); await settle(f.service);
  const packet = f.service.controller.state.packets[1];
  assert.equal(packet.phase, 'CONFIRM'); assert.equal(packet.finding_object_digest, digest(finding));
  assert.equal(f.service.exploration.state.finding_revisions.length, 1);
  const original = JSON.parse(await readFile(join(f.service.root, 'packets', `${packet.id}.input.json`), 'utf8'));
  const bindings = { scope: f.service.controller.state.scopes.find(row => row.id === original.scope_ref.id), revision: f.service.exploration.state.finding_revisions[0] };
  const input = workerInput(original, f.service.controller.authorization, f.service.controller.privateContext, bindings);
  assert.equal(input.scope.id, original.scope_ref.id); assert.equal(input.finding_revision.id, original.finding_revision_id);
  assert.equal(input.source_hint.title, finding.title);
  assert.throws(() => workerInput(original, f.service.controller.authorization, {}, { ...bindings, scope: { ...bindings.scope, task_id: 'forged' } }), /scope-binding/);
  await assert.rejects(f.service.controller.start({ ...original, id: 'forged-confirm', finding_object_digest: 'b'.repeat(64) }), /revision/);
  await f.service.close(); await verifyRuntimeEvidenceFiles(join(f.service.root, 'evidence-set.json'));
  const review = await prepareReview(f.service.exploration.staticStore(), { runtimeRequired: true });
  const doc = JSON.parse(await readFile(join(f.reports, review.path), 'utf8'));
  assert.equal(doc.candidates.length, 1, '已绑定的 CONFIRM 不能重复生成运行候选');
});

test('运行线索进入独立源码补充板，原板封存与分母不变，补充报告纳入统一复核', async t => {
  const { SourceFollowupService } = await import('../lib/source-followup/service.mjs');
  const f = await fixture(t, { planner: plan }); const store = await sourceStore(f, t);
  await f.service.contact(); await settle(f.service);
  const original = store.snapshot(); assert.equal(f.service.exploration.state.followup_candidates.length, 1);
  const followup = new SourceFollowupService({ auditId, runtime: f.service, main: { store, scopeDigest: scope },
    options: { reportsRoot: f.reports, scopeDigest: scope, privateRoot: join(f.root, 'followup'), workspaceRoot: f.root, sourceRoot: f.root,
      environment: {}, agentSlots: new AgentSlots(1), worker: async ({ input }) => {
        await atomicJson(input.report_path, { summary: '运行入口在当前源码中的映射未知。', findings: [], gaps: ['部署版本未知，不能把运行观察直接归因于当前源码。'] });
        await atomicJson(input.receipt_path, { protocol: 'task-board.v1', audit_id: input.audit_id, task_id: input.task.task_id, attempt_id: input.attempt_id, outcome: 'REPORTED', report_path: 'report.json' });
      } } });
  t.after(() => followup.shutdown());
  await assert.rejects(followup.prepare(), /尚未交付/);
  for (let i = 0; i < 100 && !followup.service.store.summary().mining_complete; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await followup.prepare(); await followup.prepare();
  assert.deepEqual(store.snapshot().tasks, original.tasks); assert.deepEqual(store.snapshot().publication, original.publication);
  assert.equal(store.summary().total, 1); assert.ok(store.snapshot().source_followup);
  await f.service.close();
  const ref = await prepareReview(store, { runtimeRequired: true }); const input = JSON.parse(await readFile(join(f.reports, ref.path), 'utf8'));
  assert.equal(input.tasks.length, 2); assert.ok(input.tasks[1].reported_gaps.length); assert.equal(input.candidates.length, 1);
  const frozen = join(f.reports, store.snapshot().source_followup.path); await writeFile(frozen, '{}');
  await assert.rejects(prepareReview(store, { runtimeRequired: true }), /摘要/);
});

test('在规划期间取消撤销提议，迟到结果不能执行；全局 Agent 配额释放', async t => {
  let releasePlan, started;
  const entered = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { planner: async input => { started(); return new Promise(resolve => { releasePlan = () => resolve(plan(input)); }); } });
  await f.service.contact(); await entered;
  const stopping = f.service.shutdown(); releasePlan(); await stopping;
  assert.equal(f.counts.worker, 1); assert.equal(f.service.controller.state.packets.length, 1); assert.equal(f.service.agentSlots.active.size, 0);
  const graph = f.service.exploration.snapshot(); f.service.exploration.notify(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.service.exploration.snapshot(), graph);
});

test('v2 的动作详情仍可读取真实请求/响应；不把列表摘要伪装成 HTTP 证据', async t => {
  const { readRuntimeTestingActivity } = await import('../web/dynamic-validation-observatory/runtime-testing-activity.mjs');
  const f = await fixture(t, { planner: plan }); await f.service.contact(); await settle(f.service); await f.service.close();
  const activity = await readRuntimeTestingActivity({ reportsRoot: f.reports, repositoryId: 'runtime-product', audit: { id: auditId } });
  assert.equal(activity.cases.length, 2); assert.ok(activity.cases.every(row => row.actions.length === 1));
  assert.equal(activity.exchanges.length, 0); assert.ok(activity.cases.every(row => row.status !== 'EVIDENCE_INVALID'));
});

test('v2 捕获的 HTTP 记录能导出 Bruno 集合，保留响应并脱敏凭据', async t => {
  const { readRuntimeTestingActivity } = await import('../web/dynamic-validation-observatory/runtime-testing-activity.mjs');
  const { buildBrunoCollection } = await import('../web/dynamic-validation-observatory/bruno-exporter.mjs');
  const f = await fixture(t, { planner: plan, httpEvidence: true }); await f.service.contact(); await settle(f.service); await f.service.close();
  const activity = await readRuntimeTestingActivity({ reportsRoot: f.reports, repositoryId: 'runtime-product', audit: { id: auditId } });
  assert.equal(activity.exchanges.length, 2);
  const collection = buildBrunoCollection(activity.exchanges).document;
  assert.equal(collection.items.length, 2); assert.equal(collection.items[0].request.url, '{{baseUrl}}/orders');
  assert.equal(JSON.parse(collection.items[0].examples[0].response.body.content).fixture, true);
  assert.ok(!JSON.stringify(collection).includes('secret-never-public'));
});

test('Planner 进程仅能提交结构化提议，退出后释放服务、附件和全局配额', async t => {
  const { runProposalAgent } = await import('../lib/runtime-exploration/agent.mjs');
  const { readdir } = await import('node:fs/promises');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'proposal-gateway-'))), configPath = join(root, 'config.json');
  await atomicJson(configPath, { mcp: { 'chrome-devtools': { enabled: true } } }); t.after(() => rm(root, { recursive: true, force: true }));
  const slots = new AgentSlots(1); let request, endpoint, child;
  const result = await runProposalAgent({ role: 'runtime-exploration-planner', instructions: '仅提交中文提议。', input: { summary: '脱敏事实' }, schema: { type: 'object' }, validate: value => value,
    command: 'opencode', engine: 'opencode', environment: { ...process.env, OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_CONTENT: '{}' },
    workspaceRoot: root, privateRoot: join(root, 'planner'), agentSlots: slots, timeoutMs: 2000,
    spawnProcess(command, args, options) {
      const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
      assert.equal(config.mcp['chrome-devtools'].enabled, false); assert.deepEqual(config.agent['runtime-exploration-planner'].permission, { '*': 'deny', 'audit-proposal_*': 'allow' });
      assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
      const connection = config.mcp['audit-proposal'].environment; endpoint = connection.AUDIT_PROPOSAL_ENDPOINT;
      child = new EventEmitter(); child.stdout = new PassThrough(); child.exitCode = null;
      child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('close', 0)); };
      request = new Promise(resolve => setImmediate(resolve)).then(async () => {
        child.stdout.write(JSON.stringify({ type: 'step_start', sessionID: 'session-proposal-fixture' }) + '\n');
        const response = await fetch(endpoint + '/submit', { method: 'POST', headers: { authorization: `Bearer ${connection.AUDIT_PROPOSAL_TOKEN}` }, body: JSON.stringify({ summary: '本轮无需实验。' }) });
        assert.equal(response.status, 200); await response.json();
      });
      return child;
    },
  });
  await request; assert.equal(result.value.summary, '本轮无需实验。'); assert.equal(result.session_id, 'session-proposal-fixture');
  assert.equal(child.exitCode, 0); assert.equal(slots.active.size, 0); assert.deepEqual(await readdir(join(root, 'planner')), []);
  await assert.rejects(fetch(endpoint + '/schema', { method: 'POST' }));
});

test('规划上下文受总字符预算约束；更正报告后旧版本仅存档，不再用于新实验', async t => {
  const f = await fixture(t); const store = await sourceStore(f, t, [{ finding_id: 'old', title: '旧版本' }]);
  await f.service.contact(); await settle(f.service);
  const graph = f.service.exploration;
  const previous = graph.state.finding_revisions[0];
  await store.mutate(board => { board.tasks[0].report.sha256 = 'f'.repeat(64); });
  graph.state.finding_revisions.push({ ...previous, id: 'revision-current', report: { ...previous.report, sha256: 'f'.repeat(64) }, finding: { title: '当前版本', description: '长文本'.repeat(200000) } });
  graph.state.facts.push(...Array.from({ length: 80 }, (_, index) => ({ id: `large-${index}`, summary: '响应正文'.repeat(200000), evidence_ids: ['evidence'] })));
  const context = graph.context();
  assert.ok(JSON.stringify(context).length <= LIMITS.contextCharacters); assert.equal(context.context_truncated, true);
  assert.deepEqual(context.finding_revisions.map(row => row.id), ['revision-current']);
  assert.ok(graph.snapshot().finding_revisions.some(row => row.id === previous.id));
  const response = await fetch(`${f.service.endpoint}/status`, { method: 'POST', headers: { authorization: `Bearer ${f.service.token}` }, body: '{}' });
  const status = await response.json(); assert.equal(status.exploration.facts, undefined); assert.equal(status.finding_revisions, undefined);
});

test('产品级 HTTP 入口支持无源码创建、幂等查询、重试与删除；环境原文不泄露到列表', async t => {
  const { createAuditWorkbenchServer } = await import('../web/dynamic-validation-observatory/server.mjs');
  const { AgentSettingsStore } = await import('../lib/audit-runtime/agent-settings.mjs');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dynamic-api-'))), configPath = join(root, '.opencode', 'opencode.json');
  await atomicJson(configPath, { mcp: {} });
  const runner = new AuditRunner({ platformRoot: root, stateRoot: join(root, 'state', 'audits'), configPath, enabled: true, spawnProcess() { assert.fail('API 测试不允许启动真实 Agent'); } });
  const server = createAuditWorkbenchServer({ runner, stateRoot: runner.stateRoot, runtimeRoot: join(root, 'runtime'), platformConfigPath: configPath, repositories: [],
    queueScheduler: { ready: Promise.resolve(), enqueueNewAudit: async () => true, snapshot: async () => ({}), shutdown: async () => {} },
    agentSettingsStore: new AgentSettingsStore({ path: join(root, 'agents.json'), resolveCommand: async command => command,
      probe: async (command, args) => ({ stdout: args.includes('--help') ? '--server --standalone' : command === 'opencode2' ? '2.0.29' : command === 'grow' ? 'Grow 2.2.2' : '1.16.19' }) }),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await server.shutdownRunners(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await server.productCatalogReady;
  const product = await server.productStore.createProduct({ name: '仅动态产品' });
  const base = `http://127.0.0.1:${server.address().port}`, path = `/api/v2/products/${product.id}/audits`;
  const request = async (path, method = 'GET', body, extra = {}) => fetch(base + path, { method, headers: { origin: base, 'content-type': 'application/json', 'idempotency-key': 'dynamic-http-key', ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const input = { audit_id: 'dynamic-http', name: '独立动态接口验收', audit_mode: 'dynamic', test_environment_enabled: true,
    test_environment_context: '授权环境 http://fixture.test，私有说明 PRIVATE_HTTP_MARKER', runtime_testing: { explicit_authorization: true, mode: 'INTEGRATED_TESTING' } };
  const created = await request(path, 'POST', input); const audit = await created.json(); assert.equal(created.status, 202, JSON.stringify(audit));
  assert.equal(audit.audit_mode, 'dynamic'); assert.equal(audit.source_kind, 'runtime'); assert.equal(audit.execution_spec.source_scopes.length, 0);
  assert.ok(!JSON.stringify(audit).includes('PRIVATE_HTTP_MARKER'));
  const again = await request(path, 'POST', input); assert.equal((await again.json()).id, audit.id);
  const list = await request(path); const listed = await list.json(); assert.equal(list.status, 200, JSON.stringify(listed));
  assert.ok(listed.items.some(row => row.id === audit.id)); assert.ok(!JSON.stringify(listed).includes('PRIVATE_HTTP_MARKER'));
  const draft = await request(`${path}/${audit.id}/retry-draft`, 'POST', {}); assert.equal(draft.status, 200); assert.match(await draft.text(), /PRIVATE_HTTP_MARKER/);
  const missingAuth = await request(path, 'POST', { ...input, audit_id: 'no-auth-http', test_environment_enabled: false }, { 'idempotency-key': 'no-auth-http' }); assert.equal(missingAuth.status, 422);
  const current = runner.getAudit(audit.id);
  const deleted = await request(`${path}/${audit.id}`, 'DELETE', { confirmation: audit.id }, { 'if-match': `"${current.version}"` });
  assert.equal(deleted.status, 200, await deleted.text()); assert.equal(server.productStore.auditLink(audit.id), null);
});
