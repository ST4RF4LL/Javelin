import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { TaskBoardService } from '../lib/task-board/service.mjs';
import { MINING_STRATEGIES, selectMiningStrategies, atomicJson, hash, PROTOCOL } from '../lib/task-board/contract.mjs';
import { createBoard, readBoard, TaskBoardStore } from '../lib/task-board/store.mjs';
import { prepareReview, acceptReview, finalizeBoard, verifyBoardCompletion } from '../lib/task-board/review.mjs';
import { nextReviewBatch, submitReviewBatch, readBound } from '../lib/task-board/review-batches.mjs';
import { nextFileBatch, completeFileBatch } from '../lib/task-board/file-batches.mjs';
import { groupConfirmedFindings } from '../lib/task-board/finding-groups.mjs';
import { reopenIncremental } from '../lib/task-board/incremental.mjs';
const auditId = 'audit-multi', scope = 'a'.repeat(64);
const spec = (id, strategy = 'focus_area', extra = {}) => ({ task_id: id, strategy_id: strategy, kind: strategy === 'api' ? 'api' : strategy === 'creed' ? 'function' : 'focus_area',
  title: `审查 ${id}`, domain: 'java', source_ref: `threat:${id}`, code_refs: [{ path: `${id}.java`, line: 1 }], prompt: '审查当前范围的控制条件与源码证据。', ...extra });
async function fixture(t, strategies = ['focus_area']) {
  const root = await mkdtemp(join(tmpdir(), 'multi-strategy-')), reportsRoot = join(root, 'reports'), sourceRoot = join(root, 'source'), path = join(root, 'board.json');
  await mkdir(reportsRoot); await mkdir(sourceRoot);
  await createBoard({ path, auditId, miningStrategies: strategies, apiList: strategies.includes('api') ? 'GET /one' : '', bacMode: 'off' });
  const store = await new TaskBoardStore({ path, reportsRoot, auditId, scopeDigest: scope }).open();
  const content = 'int compute() { return 1; }\n'; await writeFile(join(sourceRoot, 'one.java'), content);
  const file = { file_id: 'file:one', path: 'one.java', type: 'file', content_kind: 'source', sha256: hash(content), size: content.length };
  const manifest = { audit_id: auditId, scope_digest: scope, complete: true, files: [file], exclusions: [] };
  if (strategies.includes('file_sweep')) await store.initializeFiles(manifest);
  const fn = { function_id: 'function-one', path: 'one.java', symbol: 'compute', start_line: 1, end_line: 1, file_sha256: file.sha256, source_sha256: hash(content.trim()) };
  if (strategies.includes('creed')) await store.mutate(board => { board.creed_inventory = { protocol: 'creed-inventory.v1', functions: [fn], gaps: [], scope_digest: scope }; });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, reportsRoot, sourceRoot, path, store, file, fn };
}
async function deliver(f, job, findings = []) {
  const work = join(f.root, job.attempt.attempt_id); await mkdir(work);
  await atomicJson(join(work, 'report.json'), { summary: '已核查指定工作项。', findings, gaps: [] });
  await f.store.receive({ taskId: job.task.task_id, attemptId: job.attempt.attempt_id, inputRoot: work,
    receipt: { protocol: PROTOCOL, audit_id: auditId, task_id: job.task.task_id, attempt_id: job.attempt.attempt_id, outcome: 'REPORTED', report_path: 'report.json' } });
}
async function artifact(f, name, value) {
  const path = `validation/${name}.json`; await atomicJson(join(f.reportsRoot, path), value);
  return { path, sha256: hash(await readFile(join(f.reportsRoot, path))) };
}
async function completeReview(f, ref, round) {
  for (;;) {
    const next = await nextReviewBatch(f.store); if (next.done) break;
    const packet = await readBound(f.reportsRoot, next.input);
    const result = await artifact(f, `${round}-${next.batch_id}-${next.role}`, { protocol: PROTOCOL, audit_id: auditId,
      input_sha256: next.input_sha256, batch_input_sha256: next.input.sha256, batch_id: next.batch_id, role: next.role,
      agent_session_id: `${round}-${next.batch_id}-${next.role}`,
      ...(f.declareDependencies === false ? {} : { dependency_scope: { complete: true, source_paths: [...new Set([...packet.tasks.flatMap(task => task.code_refs.map(ref => ref.path)), ...(f.reviewExtraPath ? [f.reviewExtraPath] : [])])] } }),
      ...(next.affirmative ? { affirmative_sha256: next.affirmative.sha256 } : {}), ...(next.negative ? { negative_sha256: next.negative.sha256 } : {}),
      findings: packet.candidates.map(row => ({ candidate_id: row.candidate_id, verdict: { AFFIRMATIVE: 'PROVEN', NEGATIVE: 'NOT_REFUTED', MODERATOR: 'TRUE_POSITIVE' }[next.role],
        reason: '已核对根因与条件。', evidence_refs: [...packet.tasks.flatMap(task => task.code_refs.map(ref => `${ref.path}:1`)), ...(f.reviewExtraPath ? [`${f.reviewExtraPath}:3`] : [])], gaps: [] })) });
    await submitReviewBatch(f.store, { batch_id: next.batch_id, role: next.role, result });
  }
  const quality = await artifact(f, `${round}-quality`, { protocol: PROTOCOL, audit_id: auditId, input_sha256: ref.sha256,
    role: 'REPORT_REVIEW', agent_session_id: `${round}-quality`, assessments: f.store.snapshot().tasks.map(task => ({ task_id: task.task_id,
      status: task.status === 'REPORTED' ? 'REVIEWED' : 'GAP', reason: '按实际交付记录复核。', evidence_refs: ['one.java:1'], gaps: task.status === 'REPORTED' ? [] : ['工作项尚未交付'] })) });
  await acceptReview(f.store, { quality }); return finalizeBoard(f.store);
}

test('四种方式的 15 种非空组合可发布、独立封存并保持正确来源和覆盖分母', async t => {
  for (let mask = 1; mask < 16; mask++) {
    const strategies = MINING_STRATEGIES.filter((_, index) => mask & 1 << index), f = await fixture(t, strategies);
    assert.deepEqual(selectMiningStrategies([...strategies].reverse(), strategies.includes('api') ? 'GET /one' : ''), strategies);
    for (const strategy of strategies) {
      let extra = {};
      if (strategy === 'api') extra = { source_ref: f.store.snapshot().api_sources[0].source_id };
      if (strategy === 'file_sweep') {
        const file = await f.store.claimFile({}); await f.store.readFile(f.sourceRoot, file); extra = { source_ref: file.file_id };
      }
      if (strategy === 'creed') extra = { source_ref: f.fn.function_id, creed: { protocol: 'creed.v1', function: f.fn } };
      await f.store.publish({ tasks: [spec(`item-${strategy}`, strategy, extra)] });
      if (strategy === 'file_sweep') {
        const file = f.store.snapshot().file_sweep.files[0];
        await f.store.completeFile({ file_id: file.file_id, attempt_id: file.attempt_id, outcome: 'BROWSED', summary: '已浏览并发布疑点。', task_ids: [`item-${strategy}`] }, f.sourceRoot);
      }
      const result = await f.store.seal({ strategy_id: strategy });
      assert.equal(result.sealed, strategy === strategies.at(-1));
    }
    for (;;) { const job = await f.store.claim('java', 1000); if (!job) break; await deliver(f, job); }
    const summary = f.store.summary(); assert.equal(summary.complete, true); assert.equal(summary.total, strategies.length);
    for (const id of strategies) assert.equal(summary.strategy_coverage[id].reported, 1);
    if (strategies.includes('file_sweep')) assert.equal(summary.file_sweep.published_areas, 1);
    const reloaded = await readBoard(f.path); assert.deepEqual(reloaded.mining_strategies, strategies);
  }
});

test('策略参数拒绝空集合、重复、冲突及API缺清单，旧面板读取不改写字节', async t => {
  for (const values of [[], ['api'], ['focus_area', 'focus_area'], ['unknown']]) assert.throws(() => selectMiningStrategies(values));
  assert.throws(() => selectMiningStrategies(['focus_area', 'creed'], '', 'focus_area'), /不一致/);
  const f = await fixture(t); await f.store.close();
  const path = join(f.root, 'legacy.json'); await createBoard({ path, auditId, miningStrategy: 'focus_area' });
  const before = await readFile(path); const board = await readBoard(path);
  assert.equal(board.mining_contract, undefined); assert.deepEqual(await readFile(path), before);
});

test('同领域策略轮换，不合并不同方法；单策略封存不阻止其他方式发布', async t => {
  const f = await fixture(t, ['focus_area', 'api']); const source = f.store.snapshot().api_sources[0].source_id;
  await f.store.publish({ tasks: [spec('focus-1'), spec('focus-2'), spec('api-1', 'api', { source_ref: source })] });
  await assert.rejects(f.store.seal(), /分别封存/);
  await f.store.seal({ strategy_id: 'focus_area' });
  await assert.rejects(f.store.publish({ tasks: [spec('focus-3')] }), /封存/);
  await f.store.publish({ tasks: [spec('api-2', 'api', { source_ref: source })] });
  const first = await f.store.claim('java', 1000); await deliver(f, first);
  const second = await f.store.claim('java', 1000); assert.notEqual(first.task.strategy_id, second.task.strategy_id);
  await deliver(f, second); await f.store.seal({ strategy_id: 'api' });
});

test('失败增量的领取集合锁定，历史待执行项保留，成功后可交付部分报告', async t => {
  const f = await fixture(t); await f.store.publish({ tasks: [spec('failed'), spec('pending')] }); await f.store.seal();
  const job = await f.store.claim('java', 1000); await f.store.fail(job.task.task_id, job.attempt.attempt_id, '退出', { terminal: true });
  await reopenIncremental(f.store, 'f'.repeat(64));
  await assert.rejects(f.store.publish({ tasks: [spec('extra')] }), /增量/);
  const retry = await f.store.claim('java', 1000); assert.equal(retry.task.task_id, 'failed'); await deliver(f, retry);
  assert.equal(await f.store.claim('java', 1000), null); assert.equal(f.store.summary().complete, false); assert.equal(f.store.summary().round_complete, true);
  const ref = await prepareReview(f.store);
  const quality = await artifact(f, 'round-quality', { protocol: PROTOCOL, audit_id: auditId, input_sha256: ref.sha256, role: 'REPORT_REVIEW', agent_session_id: 'quality',
    assessments: [{ task_id: 'failed', status: 'REVIEWED', reason: '已交付', evidence_refs: ['failed.java:1'], gaps: [] }, { task_id: 'pending', status: 'GAP', reason: '未执行', evidence_refs: [], gaps: ['未执行'] }] });
  await acceptReview(f.store, { quality }); const result = await finalizeBoard(f.store); assert.equal(result.delivery_outcome, 'PARTIAL');
  assert.equal(f.store.snapshot().tasks.find(row => row.task_id === 'pending').status, 'PENDING');
  const checked = await verifyBoardCompletion({ audit: { id: auditId, mining_strategies: ['focus_area'], task_board_path: f.path, source_baseline: { scope_digest: scope } }, reportsRoot: f.reportsRoot });
  assert.deepEqual(checked.errors, []);
});

test('仅完整根因和成立条件相同的跨方法确认发现归并，原始证据与CREED解释保留', () => {
  const cause = { path: 'a.java', symbol: 'f', weakness: 'missing-owner', trust_boundary: 'tenant', preconditions: 'authenticated same tenant' };
  const occurrence = (id, strategy, extra = {}) => ({ finding_id: id, task_id: id, strategy_ids: [strategy], claim_scope: 'SOURCE', title: '同标题', root_cause: cause,
    severity: 'HIGH', review: { verdict: 'TRUE_POSITIVE', reason: '有依据', evidence_refs: [`${id}:1`], gaps: [] }, ...extra });
  const grouped = groupConfirmedFindings([occurrence('a', 'focus_area'), occurrence('b', 'creed', { creed_analysis: { beliefs: ['B1'] } })]);
  assert.equal(grouped.length, 1); assert.equal(grouped[0].source_occurrences.length, 2); assert.equal(grouped[0].creed_analyses.length, 1);
  assert.equal(groupConfirmedFindings([occurrence('a', 'focus_area'), occurrence('b', 'creed', { root_cause: { ...cause, preconditions: 'admin only' } })]).length, 2);
  assert.equal(groupConfirmedFindings([occurrence('a', 'focus_area', { root_cause: 'same' }), occurrence('b', 'creed', { root_cause: 'same' })]).length, 2);
});

test('增量复核复用未变的独立批次；关联源码变化时失效且历史绑定不可篡改', async t => {
  for (const mode of ['separate', 'same-source', 'cross-file', 'undeclared']) {
    const related = mode !== 'separate';
    const f = await fixture(t); f.declareDependencies = mode !== 'undeclared'; f.reviewExtraPath = mode === 'cross-file' ? 'shared.java' : null;
    await f.store.publish({ tasks: [spec('good'), spec('retry', 'focus_area', { code_refs: [{ path: mode === 'same-source' ? 'good.java' : mode === 'cross-file' ? 'shared.java' : 'retry.java', line: 1 }] })] }); await f.store.seal();
    await deliver(f, await f.store.claim('java', 1000), [{ finding_id: 'one', title: '已交付发现', location: { file: 'good.java', line: 1 } }]);
    for (let i = 0; i < 3; i++) { const job = await f.store.claim('java', 1000); await f.store.fail(job.task.task_id, job.attempt.attempt_id, '失败'); }
    await f.store.skip({ task_id: 'retry', reason: '失败耗尽' });
    const first = await prepareReview(f.store, { bounded: true }); await completeReview(f, first, 'original');
    const originalModerator = f.store.snapshot().validation.bundle.batches[0].moderator;
    await reopenIncremental(f.store, 'e'.repeat(64)); await deliver(f, await f.store.claim('java', 1000));
    const next = await prepareReview(f.store, { bounded: true });
    assert.equal(f.store.snapshot().validation.reused_batch_count ?? 0, related ? 0 : 1); assert.equal((await nextReviewBatch(f.store)).done, !related);
    await completeReview(f, next, 'incremental'); await finalizeBoard(f.store);
    const plan = await readBound(f.reportsRoot, f.store.snapshot().validation.batch_plan);
    assert.equal(Boolean(plan.batches[0].reused_from), !related);
    if (!related) {
      await writeFile(join(f.reportsRoot, originalModerator.path), '{}');
      const checked = await verifyBoardCompletion({ audit: { id: auditId, mining_strategies: ['focus_area'], task_board_path: f.path, source_baseline: { scope_digest: scope } }, reportsRoot: f.reportsRoot });
      assert.ok(checked.errors.some(error => error.includes('摘要不匹配')));
    }
  }
});

test('真实看板服务自动规划CREED并走专用执行器；错误响应只失败一个工作项且不隐式重发', async t => {
  for (const malformed of [false, true]) {
    const f = await fixture(t, ['creed']); await f.store.mutate(board => { delete board.creed_inventory; }); await f.store.close();
    const content = 'class One { int compute() { return 1; } }\n'; await writeFile(join(f.sourceRoot, 'one.java'), content);
    const manifestPath = join(f.root, 'manifest.json'); await atomicJson(manifestPath, { audit_id: auditId, scope_digest: scope, complete: true,
      files: [{ ...f.file, sha256: hash(content) }], exclusions: [] });
    let calls = 0, resolveDone; const done = new Promise(resolve => { resolveDone = resolve; });
    const output = { actions: [{ id: 'A1', level: 'high', description: '计算值', evidence_lines: [1] }, { id: 'A2', level: 'low', description: '返回常量', evidence_lines: [1] }], beliefs: [], findings: [] };
    const service = new TaskBoardService({ path: f.path, reportsRoot: f.reportsRoot, privateRoot: join(f.root, 'private'), workspaceRoot: process.cwd(),
      sourceRoot: f.sourceRoot, auditId, scopeDigest: scope, fileManifestPath: manifestPath, bacMode: 'off', environment: { OPENCODE_CONFIG_CONTENT: '{}' },
      onChange: async summary => { if (summary.reported || summary.failed) resolveDone(summary); },
      spawnProcess: (command, args, options) => {
        calls++; assert.equal(options.env.AUDIT_MEMORY_MODE, 'off'); assert.equal(options.env.AUDIT_RUNTIME_CONNECTION_PATH, '');
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { child.emit('close', 1); };
        setImmediate(() => {
          for (const event of [{ type: 'step_start', sessionID: 'ses_fixture', part: { id: 'start' } },
            { type: 'text', sessionID: 'ses_fixture', part: { id: 'text', text: malformed ? '{broken' : JSON.stringify(output) } },
            { type: 'step_finish', sessionID: 'ses_fixture', part: { id: 'finish', tokens: { input: 1, output: 1 } } }]) child.stdout.write(`${JSON.stringify(event)}\n`);
          child.stdout.end(); child.emit('close', 0);
        });
        return child;
      } });
    t.after(() => service.shutdown()); await service.start();
    const deadline = setTimeout(() => resolveDone(null), 3000); const summary = await done; clearTimeout(deadline); assert.ok(summary);
    assert.equal(calls, 1); assert.equal(summary.total, 1); assert.equal(summary.publication, 'SEALED');
    if (malformed) {
      const item = service.store.snapshot().tasks[0]; assert.equal(item.status, 'FAILED'); assert.equal(item.execution_failure.kind, 'CREED_SCHEMA');
      await service.store.skip({ task_id: item.task_id, reason: '结构化响应失败，保留原始证据。' });
      assert.equal(service.store.snapshot().tasks[0].execution_failure.attempt_id, item.attempt_id);
    } else assert.equal(summary.reported, 1);
    await service.shutdown();
  }
});

test('增量轮次禁止文件批次CONTINUE/DEFERRED与领取，暂停恢复也不改变历史浏览状态', async t => {
  const f = await fixture(t, ['focus_area', 'file_sweep']);
  await f.store.publish({ tasks: [spec('failed')] });
  const job = await f.store.claim('java', 1000); await f.store.fail(job.task.task_id, job.attempt.attempt_id, '失败', { terminal: true });
  const batch = await nextFileBatch(f.store, f.sourceRoot); assert.equal(batch.files.length, 1);
  const before = f.store.snapshot().file_sweep;
  await reopenIncremental(f.store, 'a'.repeat(64));
  for (const outcome of ['CONTINUE', 'DEFERRED']) await assert.rejects(completeFileBatch(f.store, f.sourceRoot,
    { results: [{ ...batch.files[0], outcome, resume_note: '不能写入历史浏览状态' }] }), /重试失败工作项/);
  await assert.rejects(nextFileBatch(f.store, f.sourceRoot), /重试失败工作项/);
  await f.store.resetFileClaims(); assert.deepEqual(f.store.snapshot().file_sweep, before);
  await f.store.close(); await f.store.open(); assert.deepEqual(f.store.snapshot().file_sweep, before);
});
