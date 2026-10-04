import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ProductStore } from '../web/dynamic-validation-observatory/product-store.mjs';
import { ProductMemoryService } from '../lib/product-memory/service.mjs';
import { productMemoryRoute } from '../lib/product-memory/routes.mjs';
import { TaskBoardService } from '../lib/task-board/service.mjs';
import { hash } from '../lib/product-memory/contract.mjs';
import { queryKnowledge } from '../lib/knowledge-workflow.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'memory-integration-'))), source = join(root, 'source'), reports = join(root, 'reports');
  await mkdir(source); await mkdir(reports); await writeFile(join(source, 'main.py'), 'def entry():\n    return 1\n');
  const products = new ProductStore({ path: join(root, 'catalog.sqlite') }); await products.ready;
  const product = await products.createProduct({ name: '集成产品' }), target = await products.createTarget(product.id, { name: '测试源码', source_scopes: [{ name: 'source', path: source }] });
  const audit = { id: 'audit-test', repository_id: target.id, provider_session_id: 'session-main', execution_spec: { target_id: target.id, source_scopes: target.source_scopes } };
  const runner = { getAudit: id => id === audit.id ? audit : null }, memory = new ProductMemoryService({ products, runner, stateRoot: join(root, 'memory') });
  await memory.ready; const adapter = await memory.prepare(audit, {}, { source_root: source, reports_root: reports });
  t.after(async () => { await memory.shutdown(); await products.writeQueue; products.close(); await rm(root, { recursive: true, force: true }); });
  return { root, source, reports, products, product, target, audit, runner, memory, store: memory.store, adapter };
}
const fact = () => ({ kind: 'interface', entity_key: 'GET /entry', title: '入口接口', data: { method: 'GET', path: '/entry' }, evidence_refs: [{ path: 'main.py', line: 1 }] });

test('真实会话写观察、受控 HTTP 凭据不能升级为 TaskBoard 调度或人工反馈权限', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.memory.agentRequest(f.audit.id, { op: 'propose', input: fact() }), /真实 Agent 会话/);
  const result = await f.adapter.request({ op: 'propose', input: fact() }); assert.equal(result.items[0].session_id, 'session-main');
  await assert.rejects(() => f.adapter.request({ op: 'feedback', input: {} }), /不能修改人工判断/);
  const service = new TaskBoardService({ auditId: f.audit.id, path: join(f.root, 'board.json'), reportsRoot: f.reports, sourceRoot: f.source, workspaceRoot: f.root, privateRoot: join(f.root, 'private'), memory: f.adapter });
  const session = join(f.root, 'session.json'); await writeFile(session, JSON.stringify({ agent_session_id: 'session-worker' }));
  service.memoryTokens.set('scoped', { taskId: 'task-worker', sessionId: 'session-worker' }); service.closed = true;
  const call = async (url, token, body) => {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]); Object.assign(request, { url, method: 'POST', headers: { authorization: `Bearer ${token}` } });
    const response = { writeHead(code) { this.code = code; }, end(bytes) { this.body = JSON.parse(bytes); } }; await service.handle(request, response); return response;
  };
  const write = await call('/memory', 'scoped', { op: 'propose', input: fact() }); assert.equal(write.code, 200); assert.equal(write.body.items[0].session_id, 'session-worker');
  service.memoryTokens.set('unregistered', { taskId: 'task-worker', sessionId: null });
  assert.notEqual((await call('/memory', 'unregistered', { op: 'propose', input: fact() })).code, 200);
  assert.notEqual((await call('/publish', 'scoped', {})).code, 200); assert.notEqual((await call('/memory', 'wrong', {})).code, 200);
  service.memoryTokens.delete('scoped'); assert.notEqual((await call('/memory', 'scoped', {})).code, 200);
});

test('盲审 Worker 不能通过主审计的 full 模式或知识 CLI 恢复历史上下文', async t => {
  const f = await fixture(t); await f.adapter.request({ op: 'propose', input: { ...fact(), kind: 'finding' } });
  const context = await f.adapter.context('blind-task', 'blind'); assert.equal(context.observations.status, 'SKIPPED'); assert.deepEqual(context.issues, []);
  const queried = await f.adapter.request({ op: 'context', input: { isolation_mode: 'full' } }, { memoryMode: 'blind', sessionId: 'blind-worker' }); assert.equal(queried.observations.status, 'SKIPPED');
  const knowledge = await queryKnowledge({ command: 'show', track: 'coverage', id: 'existing-case' }, { environment: { AUDIT_MEMORY_MODE: 'blind' }, execute: async () => { throw new Error('不应启动'); } }); assert.equal(knowledge.status, 'SKIPPED');
});

test('当前源码变化或虚构行号不能作为已绑定版本的新证据', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.store.observe(f.audit.id, { ...fact(), evidence_refs: [{ path: 'main.py', line: 999 }] }), /行号超出/);
  await writeFile(join(f.source, 'main.py'), 'changed\n'); await assert.rejects(() => f.store.observe(f.audit.id, fact()), /摘要不一致/);
});

test('受摘要约束的报告与专项记忆附件入库幂等，封存结论保留独立副本', async t => {
  const f = await fixture(t);
  const report = { protocol: 'task-board.v1', audit_id: f.audit.id, task_id: 'task', agent_session_id: 'worker', memory_observations: [fact()], coverage_observations: [], findings: [{ finding_id: 'F1', title: '入口授权遗漏', vulnerability_type_id: 'TEST', location: { path: 'main.py', line: 1 } }], gaps: [] };
  const bytes = JSON.stringify(report); await writeFile(join(f.reports, 'task.json'), bytes);
  const task = { task_id: 'task', report: { path: 'task.json', sha256: hash(bytes) } }; await f.memory.ingestTask(f.audit.id, f.reports, task); await f.memory.ingestTask(f.audit.id, f.reports, task);
  assert.equal(f.store.search(f.product.id).total, 2);
  const model = { audit_id: f.audit.id, findings: [{ ...report.findings[0], finding_id: 'task:F1', review: { verdict: 'TRUE_POSITIVE', reason: '完整静态证据链' } }], excluded_findings: [] }, modelBytes = JSON.stringify(model);
  await writeFile(join(f.reports, 'model.json'), modelBytes);
  await f.memory.ingestFinal(f.audit.id, f.reports, { final_report: { model: 'model.json', model_sha256: hash(modelBytes) } });
  const rows = f.store.search(f.product.id, { kind: 'finding' }).items; assert.equal(new Set(rows.map(r => r.issue_id)).size, 1);
  const reviewed = rows.find(r => r.trust === 'REVIEWED'); assert.equal(reviewed.data.system_verdict, 'TRUE_POSITIVE');
  await rm(f.reports, { recursive: true }); assert.equal(hash(await readFile(join(f.store.stateRoot, reviewed.data.retained_report.path))), reviewed.data.retained_report.sha256);
});

test('历史发现使用独立未知基线，不污染原审计的恢复绑定', async t => {
  const f = await fixture(t); await f.store.write(() => f.store.db.prepare('DELETE FROM pm_bindings WHERE audit_id=?').run(f.audit.id));
  const finding = { id: 'old-finding', audit_id: f.audit.id, resource_id: 'resource-old', title: '历史问题', status: 'TRUE_POSITIVE' };
  const issue = await f.memory.issueForFinding(f.product.id, finding, { status: 'rejected', version: 1, note: '外层守卫有效' });
  assert.equal(f.store.binding(f.audit.id), null); assert.equal(issue.observations[0].trust, 'LEGACY_UNBOUND'); assert.equal(issue.feedback[0].reason, '外层守卫有效');
  const prepared = await f.memory.prepare(f.audit, {}, { source_root: f.source, reports_root: f.reports }); assert.ok(prepared);
  assert.notEqual(f.store.binding(f.audit.id).snapshot_id, issue.observations[0].snapshot_id);
  assert.equal(f.memory.findingSummary(f.product.id, finding.resource_id).human_verdict, 'FALSE_POSITIVE');
});

test('已有 Repo 纳入产品树时保持身份，显式路径修改保留历史', async t => {
  const f = await fixture(t), original = f.store.binding(f.audit.id).repo_id;
  const bound = await f.store.bindRoot(f.product.id, { path: f.source }); await f.store.refreshRoot(f.product.id, bound.id);
  assert.equal(f.store.tree(f.product.id).nodes.filter(n => n.kind === 'repo').length, 1); assert.equal(f.store.tree(f.product.id).nodes[0].id, original);
  const nextPath = join(f.root, 'moved'); await rename(f.source, nextPath);
  await f.products.updateTarget(f.product.id, f.target.id, { source_scopes: [{ name: 'source', path: nextPath }] }, f.target.version);
  assert.equal(f.store.repo(f.product.id, original).path, nextPath); assert.equal(f.store.snapshot(f.product.id, f.audit.memory.snapshot_id).source_root, f.source);
});

test('归属转移保留原产品经验且撤销旧会话权限，新产品不能查询旧问题', async t => {
  const f = await fixture(t), row = await f.store.observe(f.audit.id, { ...fact(), kind: 'finding' });
  const destination = await f.products.createProduct({ name: '目标产品' });
  await f.products.transferTarget(f.product.id, f.target.id, destination.id, f.target.version);
  assert.equal(f.store.repo(f.product.id, row.repo_id).status, 'DETACHED');
  assert.throws(() => f.store.issue(destination.id, row.issue_id), e => e.statusCode === 404);
  await assert.rejects(() => f.memory.agentRequest(f.audit.id, { op: 'context' }), /归属已变化/);
  assert.equal(f.store.issue(f.product.id, row.issue_id).observations.length, 1);
  const freshTarget = await f.products.createTarget(f.product.id, { name: '重新登记', source_scopes: [{ name: 'source', path: f.source }] });
  assert.notEqual((await f.store.ensureRepo(f.product.id, freshTarget.id, f.source)).id, row.repo_id);
});

test('产品接口校验所属空间、写请求来源、反馈版本及差异分页', async t => {
  const f = await fixture(t), row = await f.store.observe(f.audit.id, { ...fact(), kind: 'finding' }); let mutationChecks = 0;
  const request = async (path, method = 'GET', body = {}) => {
    let result;
    await productMemoryRoute({ request: { method, headers: { 'idempotency-key': 'api-feedback' } }, response: {}, url: new URL(`http://127.0.0.1/api/v2/products/${f.product.id}/${path}`), memory: f.memory, campaigns: {}, json: (_, status, data) => { result = { status, data }; }, requestJson: async () => body, assertSafeMutation: () => { mutationChecks++; } }); return result;
  };
  assert.equal((await request('tree')).data.nodes.length, 1);
  const updated = await request(`issues/${row.issue_id}/feedback`, 'POST', { version: 0, human_verdict: 'FALSE_POSITIVE', reason: '接口有业务授权守卫' }); assert.equal(updated.data.feedback.length, 1); assert.equal(mutationChecks, 1);
  assert.equal((await request('memory/search?limit=1')).data.items.length, 1);
  await assert.rejects(() => request('issues/missing'), e => e.statusCode === 404);
  const diff = await request(`repos/${row.repo_id}/compare`, 'POST', { before: row.snapshot_id, after: row.snapshot_id, limit: 1 }); assert.equal(diff.data.total, 1); assert.equal(diff.data.changes[0].status, 'UNCHANGED');
});

test('清单删除判定要求相同提取器与完整范围；facts_only 不带问题或 TODO', async t => {
  const f = await fixture(t), before = f.store.binding(f.audit.id);
  await f.store.observe(f.audit.id, fact());
  const inventory = version => ({ kind: 'inventory', entity_key: 'interfaces', title: '接口清单', data: { kind: 'interface', complete: true, extractor_version: version, scope: '.' }, evidence_refs: [{ path: 'main.py' }] });
  await f.store.observe(f.audit.id, inventory('1')); await writeFile(join(f.source, 'main.py'), '# changed\n');
  const after = await f.store.captureSnapshot(f.product.id, before.repo_id); await f.store.bindAudit({ auditId: 'new', productId: f.product.id, repoId: before.repo_id, snapshotId: after.id, mode: 'facts_only' }); await f.store.observe('new', inventory('2'));
  assert.equal((await f.store.compare(f.product.id, before.repo_id, before.snapshot_id, after.id, 'interface')).summary.UNKNOWN, 1);
  await f.store.observe('new', inventory('1')); assert.equal((await f.store.compare(f.product.id, before.repo_id, before.snapshot_id, after.id, 'interface')).summary.REMOVED, 1);
  await f.store.createTodo(f.product.id, { origin_repo_id: before.repo_id, type: 'CHECK_PATTERN', question: '核查同类漏洞' }, 'todo');
  const context = await f.store.context('new', 'task'); assert.deepEqual(context.todos, []); assert.deepEqual(context.issues, []);
});
