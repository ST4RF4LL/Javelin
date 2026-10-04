import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { ProductStore } from '../web/dynamic-validation-observatory/product-store.mjs';
import { ProductMemoryService } from '../lib/product-memory/service.mjs';
import { ProductAuditService } from '../lib/product-memory/campaign.mjs';
import { AgentSlots } from '../lib/agent-slots.mjs';
import { hash } from '../lib/product-memory/contract.mjs';

async function fixture(t, worker = null) {
  const root = await mkdtemp(join(tmpdir(), 'product-audit-'));
  const products = new ProductStore({ path: join(root, 'catalog.sqlite') }); await products.ready;
  const product = await products.createProduct({ name: '联合产品' });
  const runner = Object.assign(new EventEmitter(), { enabled: true, audits: new Map(), calls: [], getAudit(id) { return this.audits.get(id); },
    async createAuditFromTarget(input) { this.calls.push(input); const audit = { ...input, id: input.audit_id, status: 'running', version: 1 }; this.audits.set(audit.id, audit); return audit; },
    async action(id, action) { const audit = this.audits.get(id); audit.status = { pause: 'paused', resume: 'running', recover: 'running', cancel: 'cancelled' }[action]; audit.version++; return audit; } });
  const memory = new ProductMemoryService({ products, runner, stateRoot: join(root, 'memory') }); await memory.ready;
  const repos = [];
  for (const name of ['entry', 'executor', 'outside']) {
    const source = join(root, name); await mkdir(source); await writeFile(join(source, 'main.py'), `# ${name}\ndef call():\n    return 1\n`);
    const target = await products.createTarget(product.id, { name, source_scopes: [{ name: 'source', path: source }] });
    const repo = await memory.store.ensureRepo(product.id, target.id, source); repos.push(repo);
  }
  const invocations = [];
  const fakeWorker = async ({ input }) => {
    invocations.push(input);
    const result = { protocol: 'cross-repo.v1', campaign_id: input.campaign_id, input_digest: input.input_digest, role: input.role, agent_session_id: `session-${invocations.length}`,
      scope_coverage: input.source_manifest.map(r => ({ repo_id: r.repo_id, status: 'REVIEWED', reason: '已检查受控样例。' })), edges: [], candidates: [], gaps: [], todo_proposals: [], issue_relations: [] };
    return { result, session_id: result.agent_session_id, sha256: hash(result), path: join(root, 'fake-result.json') };
  };
  const campaigns = new ProductAuditService({ products, memory, runner, stateRoot: join(root, 'campaigns'), worker: worker ?? fakeWorker, agentSlots: new AgentSlots(2) }); await campaigns.ready;
  campaigns.closed = true;
  t.after(async () => { await campaigns.shutdown(); await memory.shutdown(); await products.writeQueue; products.close(); await rm(root, { recursive: true, force: true }); });
  const create = input => campaigns.create(product.id, { name: '样例审计', repo_ids: repos.slice(0, 2).map(r => r.id), max_followup_rounds: 0, ...input }, 'create-1');
  const settle = async () => { campaigns.closed = false; for (let i = 0; i < 8; i++) { await campaigns.tick(); await Promise.all([...campaigns.active.values()].map(a => a.promise)); } };
  return { root, product, products, runner, memory, repos, campaigns, create, settle, invocations };
}

test('产品批次冻结范围、限制 Repo 并发、幂等派发并封存报告', async t => {
  const f = await fixture(t); const campaign = await f.create({ repo_concurrency: 1 });
  assert.equal(campaign.spec.repos.length, 2); assert.equal((await f.create({ repo_concurrency: 1 })).id, campaign.id);
  await f.settle(); assert.equal(f.runner.calls.length, 1);
  assert.equal(f.runner.calls[0].test_environment_enabled, false); assert.equal(f.runner.calls[0].task_protocol, 'task-board.v1');
  f.runner.audits.values().next().value.status = 'completed'; await f.settle(); assert.equal(f.runner.calls.length, 2);
  for (const audit of f.runner.audits.values()) audit.status = 'completed'; await f.settle();
  const done = f.campaigns.get(f.product.id, campaign.id); assert.equal(done.status, 'COMPLETED'); assert.equal(f.invocations.length, 1);
  assert.equal(done.jobs.length, 3); assert.equal(done.report.summary.repos, 2);
  assert.match(await readFile(done.report.path, 'utf8'), /产品联合静态审计/);
  assert.ok(f.runner.calls.every(c => c.execution_spec.source_scopes[0].path !== f.repos[2].path));
});

test('暂停、恢复与取消传递给子任务，终态不再派发', async t => {
  const f = await fixture(t), campaign = await f.create({}); await f.settle();
  let current = f.campaigns.get(f.product.id, campaign.id);
  current = await f.campaigns.action(f.product.id, campaign.id, { action: 'pause', version: current.version });
  assert.equal(current.status, 'PAUSED'); assert.equal(f.campaigns.canDispatch(current.id), false);
  assert.ok([...f.runner.audits.values()].every(a => a.status === 'paused'));
  current = await f.campaigns.action(f.product.id, campaign.id, { action: 'resume', version: current.version });
  assert.ok([...f.runner.audits.values()].every(a => a.status === 'running'));
  await f.campaigns.action(f.product.id, campaign.id, { action: 'cancel', version: current.version }); await f.settle();
  assert.equal(f.campaigns.get(f.product.id, campaign.id).status, 'CANCELLED'); assert.equal(f.invocations.length, 0);
});

test('源码漂移阻止跨 Repo 旧证据拼接，并报告部分完成', async t => {
  const f = await fixture(t), campaign = await f.create({}); await f.settle();
  for (const audit of f.runner.audits.values()) audit.status = 'completed';
  await writeFile(join(f.repos[0].path, 'main.py'), '# changed\n'); await f.settle();
  const done = f.campaigns.get(f.product.id, campaign.id);
  assert.equal(done.status, 'PARTIAL'); assert.equal(f.invocations.length, 0); assert.match(done.jobs.find(j => j.kind === 'CROSS_REPO').error, /源码已变化/);
});

test('blind 跨 Repo 分析只接收本轮观察，不泄露历史同版本漏洞或人工判断', async t => {
  const f = await fixture(t), snapshot = await f.memory.store.captureSnapshot(f.product.id, f.repos[0].id);
  await f.memory.store.bindAudit({ auditId: 'historical', productId: f.product.id, repoId: f.repos[0].id, snapshotId: snapshot.id });
  await f.memory.store.observe('historical', { kind: 'finding', entity_key: 'history', title: '历史秘密标签', data: { root_cause: 'history' }, evidence_refs: [{ path: 'main.py' }] });
  await f.create({ memory_mode: 'blind' }); await f.settle();
  for (const audit of f.runner.audits.values()) audit.status = 'completed'; await f.settle();
  assert.equal(f.invocations.length, 1); assert.doesNotMatch(JSON.stringify(f.invocations[0]), /历史秘密标签|historical/);
  assert.deepEqual(f.invocations[0].issues.items, []);
});

test('产品 TODO 只在本轮范围内派发且预算有界', async t => {
  const f = await fixture(t);
  await f.memory.store.createTodo(f.product.id, { origin_repo_id: f.repos[0].id, type: 'CHECK_PATTERN', question: '核查框架调用', target_repo_ids: [f.repos[1].id, f.repos[2].id] }, 'todo');
  const campaign = await f.create({ max_followup_rounds: 1 }); await f.settle();
  let current = f.campaigns.get(f.product.id, campaign.id); const followups = current.jobs.filter(j => j.kind === 'FOLLOWUP');
  assert.equal(followups.length, 1); assert.equal(followups[0].repo_id, f.repos[1].id);
  for (let i = 0; i < 4; i++) { for (const audit of f.runner.audits.values()) audit.status = 'completed'; await f.settle(); }
  current = f.campaigns.get(f.product.id, campaign.id); assert.equal(current.jobs.filter(j => j.kind === 'FOLLOWUP').length, 1);
  assert.equal(f.runner.calls.length, 3); assert.equal(f.memory.store.todos(f.product.id, { status: 'OPEN' }).total, 1);
});

test('跨 Repo 图必须绑定双方版本，三方复核不可复用会话或省略证据', async t => {
  const f = await fixture(t), campaign = await f.create({}); const refs = [];
  for (const repo of campaign.spec.repos) { const manifest = await f.memory.store.manifest(repo.snapshot_id, f.product.id); refs.push({ repo_id: repo.repo_id, snapshot_id: repo.snapshot_id, ...manifest.files[0], line: 2 }); }
  const analysis = { protocol: 'cross-repo.v1', scope_coverage: refs.map(r => ({ repo_id: r.repo_id, status: 'REVIEWED', reason: '证据齐全' })), edges: [{ id: 'edge', kind: 'CALLS', from: refs[0], to: refs[1], claim: '外部入口调用执行端', evidence_refs: refs, preconditions: [] }], candidates: [{ candidate_id: 'chain', title: '调用链', description: '跨组件边界', edge_ids: ['edge'], observation_ids: [], preconditions: [], gaps: [] }], gaps: [] };
  await f.campaigns.validateAnalysis(campaign, analysis);
  await assert.rejects(() => f.campaigns.validateAnalysis(campaign, { ...analysis, edges: [{ ...analysis.edges[0], to: { ...refs[1], snapshot_id: 'wrong' } }] }));
  const run = { result: analysis, session_id: 'analysis', sha256: hash(analysis) };
  const roles = Object.fromEntries(['affirmative', 'negative', 'moderator'].map((role, i) => [role, { session_id: role, sha256: role, result: { analysis_sha256: run.sha256, affirmative_sha256: 'affirmative', negative_sha256: 'negative', findings: [{ candidate_id: 'chain', verdict: ['PROVEN', 'NOT_REFUTED', 'TRUE_POSITIVE'][i], reason: '已核对源码', evidence_refs: refs, gaps: [] }] } }]));
  await f.campaigns.validateReviews(campaign, run, roles);
  roles.negative.session_id = 'affirmative'; await assert.rejects(() => f.campaigns.validateReviews(campaign, run, roles));
  roles.negative.session_id = 'negative'; roles.moderator.result.findings[0].evidence_refs = []; await assert.rejects(() => f.campaigns.validateReviews(campaign, run, roles));
});

test('进程级 Worker 配额不会随产品 Repo 数放大，释放幂等', () => {
  const slots = new AgentSlots(2), a = slots.tryAcquire('a'), b = slots.tryAcquire('b');
  assert.equal(slots.tryAcquire('c'), null); a(); a(); assert.equal(slots.active.size, 1); const c = slots.tryAcquire('c'); assert.equal(typeof c, 'function'); b(); c(); assert.equal(slots.active.size, 0);
});

test('Repo 中断使父批次暂停，恢复接续原审计而不重建子任务', async t => {
  const f = await fixture(t), campaign = await f.create({}); await f.settle();
  const first = f.runner.audits.values().next().value; first.status = 'interrupted'; await f.settle();
  const paused = f.campaigns.get(f.product.id, campaign.id); assert.equal(paused.status, 'PAUSED'); assert.equal(paused.jobs.find(j => j.audit_id === first.id).status, 'INTERRUPTED');
  await f.campaigns.action(f.product.id, campaign.id, { action: 'resume', version: paused.version }); assert.equal(first.status, 'running');
  for (const audit of f.runner.audits.values()) audit.status = 'completed'; await f.settle(); assert.equal(f.runner.calls.length, 2); assert.equal(f.campaigns.get(f.product.id, campaign.id).status, 'COMPLETED');
});

test('跨 Repo 候选经过四个独立会话，裁决与源码版本共同封存', async t => {
  const roles = [];
  const worker = async ({ input, outputRoot }) => {
    roles.push(input.role);
    const refs = await Promise.all(input.source_manifest.map(async source => ({ repo_id: source.repo_id, snapshot_id: source.snapshot_id, ...JSON.parse(await readFile(source.snapshot_manifest, 'utf8')).files[0], line: 2 })));
    const result = { protocol: 'cross-repo.v1', role: input.role, campaign_id: input.campaign_id, input_digest: input.input_digest, agent_session_id: `session-${input.role}` };
    if (input.role === 'ANALYZE') Object.assign(result, { scope_coverage: refs.map(r => ({ repo_id: r.repo_id, status: 'REVIEWED', reason: '样例链路已检查' })), edges: [{ id: 'entry-exec', kind: 'CALLS', from: refs[0], to: refs[1], claim: '受控入口向执行组件传参', evidence_refs: refs, preconditions: [] }], candidates: [{ candidate_id: 'chain', title: '跨组件边界', description: '样例链路', edge_ids: ['entry-exec'], observation_ids: [], preconditions: [], gaps: [] }], gaps: [] });
    else Object.assign(result, { analysis_sha256: input.analysis_sha256, affirmative_sha256: input.affirmative_sha256, negative_sha256: input.negative_sha256, findings: [{ candidate_id: 'chain', verdict: { AFFIRMATIVE: 'PROVEN', NEGATIVE: 'NOT_REFUTED', MODERATOR: 'TRUE_POSITIVE' }[input.role], reason: '静态调用及身份边界已核查', evidence_refs: refs, gaps: [] }] });
    const bytes = JSON.stringify(result), path = join(outputRoot, 'result.json'); await writeFile(path, bytes); return { result, sha256: hash(bytes), session_id: result.agent_session_id, path };
  };
  const f = await fixture(t, worker), campaign = await f.create({}); await f.settle(); for (const audit of f.runner.audits.values()) audit.status = 'completed'; await f.settle();
  assert.deepEqual(roles, ['ANALYZE', 'AFFIRMATIVE', 'NEGATIVE', 'MODERATOR']); const done = f.campaigns.get(f.product.id, campaign.id); assert.equal(done.status, 'COMPLETED'); assert.equal(done.report.summary.cross_repo_confirmed, 1);
  const report = JSON.parse(await readFile(done.report.model_path, 'utf8')); assert.equal(report.candidates[0].data.source_manifest.length, 2); assert.equal(report.candidates[0].reviews.moderator.verdict, 'TRUE_POSITIVE');
});
