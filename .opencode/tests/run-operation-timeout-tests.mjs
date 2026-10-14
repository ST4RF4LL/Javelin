import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { operationTimeout, timeoutRecoveryPolicy, timeoutRetryDelay } from '../lib/audit-runtime/operation-timeout.mjs';
import { TimeoutRecoverySettingsStore } from '../lib/audit-runtime/timeout-recovery-settings.mjs';
import { TaskBoardService } from '../lib/task-board/service.mjs';
import { createBoard } from '../lib/task-board/store.mjs';
import { atomicJson, PROTOCOL } from '../lib/task-board/contract.mjs';

const error = { name: 'UnknownError', data: { message: 'The operation timed out.' } };
const timeout = { type: 'error', sessionID: 'ses_timeout_worker', error };
test('识别真实超时错误，拒绝工具输出、模型引用、额度和认证错误', () => {
  for (const value of [error, JSON.stringify(error), timeout, { type: 'session.error', properties: { sessionID: 'ses_fixture', error } }, 'Error: The operation timed out']) assert.ok(operationTimeout(value));
  for (const value of [null, '{}', { type: 'text', part: { text: JSON.stringify(error) } },
    { type: 'tool_use', part: { state: { output: JSON.stringify(timeout) } } },
    `[python/task] ${JSON.stringify(timeout)}`, '示例报错：The operation timed out.',
    { type: 'error', error: { name: 'APIError', data: { message: 'Insufficient quota' } } },
    { type: 'error', error: { name: 'UnknownError', data: { message: 'Unauthorized' } } }]) assert.equal(operationTimeout(value), null);
  assert.deepEqual(timeoutRecoveryPolicy(), { limit: 20, delay_ms: 10000 });
  assert.deepEqual([1, 2, 3, 20].map(n => timeoutRetryDelay(n, timeoutRecoveryPolicy())), [10000, 10000, 10000, 10000]);
  assert.equal(timeoutRecoveryPolicy({ AUDIT_TIMEOUT_MAX_RECOVERIES: '0' }).limit, 0);
  assert.equal(timeoutRecoveryPolicy({ AUDIT_TIMEOUT_MAX_RECOVERIES: '-1' }).limit, 20);
});

test('恢复设置持久化优先于环境变量，拒绝非法值且保留上次有效配置', async t => {
  const root = await mkdtemp(join(tmpdir(), 'timeout-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'settings.json'), store = new TimeoutRecoverySettingsStore({ path, environment: {} });
  assert.deepEqual(await store.get(), { max_recoveries: 20, retry_delay_seconds: 10, updated_at: null });
  await store.update({ max_recoveries: 40, retry_delay_seconds: 12 });
  const restored = new TimeoutRecoverySettingsStore({ path, environment: { AUDIT_TIMEOUT_MAX_RECOVERIES: '1', AUDIT_TIMEOUT_RETRY_DELAY_MS: '100' } });
  await restored.ready;
  assert.deepEqual(restored.policy, { limit: 40, delay_ms: 12000 });
  for (const bad of [null, {}, { max_recoveries: -1, retry_delay_seconds: 10 }, { max_recoveries: 1.2, retry_delay_seconds: 10 },
    { max_recoveries: 101, retry_delay_seconds: 10 }, { max_recoveries: 20, retry_delay_seconds: 301 },
    { max_recoveries: '20', retry_delay_seconds: 10 }, { max_recoveries: 20, retry_delay_seconds: null }]) {
    await assert.rejects(restored.update(bad), { statusCode: 422 });
  }
  assert.deepEqual(restored.policy, { limit: 40, delay_ms: 12000 });
  await restored.update({ max_recoveries: 0, retry_delay_seconds: 10 });
  assert.equal(restored.policy.limit, 0);
});

async function workerFixture(t, behavior, environment = {}) {
  const root = await mkdtemp(join(tmpdir(), 'worker-timeout-')), path = join(root, 'board.json'), auditId = 'audit-worker-timeout';
  await createBoard({ path, auditId });
  const calls = [];
  let failure;
  const service = new TaskBoardService({ path, reportsRoot: join(root, 'reports'), privateRoot: join(root, 'private'), workspaceRoot: root,
    sourceRoot: root, auditId, scopeDigest: 'a'.repeat(64), environment: { AUDIT_TIMEOUT_RETRY_DELAY_MS: '0', ...environment },
    spawnProcess(command, args, options) {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let closed = false;
      child.kill = () => { if (!closed) { closed = true; queueMicrotask(() => child.emit('close', 0)); } return true; };
      const call = { command, args, options, child }; calls.push(call);
      setImmediate(async () => {
        try { call.input = JSON.parse(await readFile(args.at(-1), 'utf8')); await behavior(call, calls.length); }
        catch (error) { failure = error; child.emit('error', error); }
      });
      return child;
    } });
  await service.store.open();
  t.after(async () => { await service.pause(); await service.store.close(); await rm(root, { recursive: true, force: true }); });
  await service.store.publish({ tasks: [{ task_id: 'python-timeout', domain: 'python', kind: 'focus_area', title: '超时夹具',
    prompt: '检查当前路径', source_ref: 'threat:fixture', code_refs: [] }] });
  const job = await service.store.claim('python', 30_000), active = { job, controller: new AbortController() };
  const run = async () => { await service.execute(active); if (failure) throw failure; };
  return { root, service, calls, run, active, job };
}
async function deliver(call) {
  const input = call.input;
  await atomicJson(input.report_path, { summary: '已核对当前任务代码与控制。', findings: [], gaps: [] });
  await atomicJson(input.receipt_path, { protocol: PROTOCOL, audit_id: input.audit_id, task_id: input.task.task_id,
    attempt_id: input.attempt_id, outcome: 'REPORTED', report_path: 'report.json' });
}
const eventually = async predicate => { for (let n = 0; n < 300 && !predicate(); n++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(predicate()); };

test('worker 超时恢复同一 session、attempt、输出路径，正确接收后续报告', async t => {
  const f = await workerFixture(t, async (call, count) => {
    if (count === 1) {
      call.child.stdout.write(`${JSON.stringify(timeout)}\n${JSON.stringify(timeout)}\n`);
    } else { await deliver(call); call.child.emit('close', 0); }
  });
  await f.run();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].args[f.calls[1].args.indexOf('--session') + 1], timeout.sessionID);
  assert.equal(f.calls[0].input.attempt_id, f.calls[1].input.attempt_id);
  assert.equal(f.calls[0].input.output_root, f.calls[1].input.output_root);
  const task = f.service.store.snapshot().tasks[0];
  assert.equal(task.status, 'REPORTED'); assert.equal(task.failure_count ?? 0, 0);
  assert.equal(task.timeout_recovery.attempts, 1);
});

test('最后一行没有换行且退出码 0 的错误仍触发恢复', async t => {
  const f = await workerFixture(t, async (call, count) => {
    if (count === 1) call.child.stderr.end(JSON.stringify(error));
    else { await deliver(call); call.child.emit('close', 0); }
  });
  await f.run(); assert.equal(f.calls.length, 2); assert.equal(f.service.store.summary().reported, 1);
});

test('超时前已完成的报告优先收件，不重复调用模型', async t => {
  const f = await workerFixture(t, async call => { await deliver(call); call.child.stdout.write(`${JSON.stringify(timeout)}\n`); });
  await f.run(); assert.equal(f.calls.length, 1); assert.equal(f.service.store.summary().reported, 1);
});

test('等待期间暂停会中断退避，不启动第二个 worker', async t => {
  const f = await workerFixture(t, async call => { call.child.stdout.write(`${JSON.stringify(timeout)}\n`); }, { AUDIT_TIMEOUT_RETRY_DELAY_MS: '1000' });
  const running = f.run();
  await eventually(() => f.service.store.snapshot().tasks[0].timeout_recovery?.state === 'waiting-to-recover');
  f.active.controller.abort(); await running;
  assert.equal(f.calls.length, 1);
  assert.equal(f.service.store.snapshot().tasks[0].status, 'PENDING');
  assert.equal(f.service.store.snapshot().tasks[0].failure_count ?? 0, 0);
});

test('重试耗尽进入 FAILED，不被通用三次失败机制放大重试次数', async t => {
  const f = await workerFixture(t, async call => { call.child.stdout.write(`${JSON.stringify(timeout)}\n`); }, { AUDIT_TIMEOUT_MAX_RECOVERIES: '2' });
  await f.run(); assert.equal(f.calls.length, 3);
  const task = f.service.store.snapshot().tasks[0];
  assert.equal(task.status, 'FAILED'); assert.equal(task.timeout_recovery.state, 'exhausted');
  assert.equal(task.failure_count, 1); assert.equal(task.timeout_recovery.attempts, 2);
  assert.equal(await f.service.store.claim('python', 30_000), null);
  await f.service.store.skip({ task_id: task.task_id, reason: '模型服务持续超时，保留执行缺口。' });
  assert.equal(f.service.store.snapshot().tasks[0].status, 'GAP');
});

test('运行中的 worker 在下一次超时时读取最新恢复设置', async t => {
  let policy = { limit: 20, delay_ms: 0 };
  const f = await workerFixture(t, async (call, count) => {
    if (count === 2) policy = { limit: 1, delay_ms: 10000 };
    call.child.stdout.write(`${JSON.stringify(timeout)}\n`);
  });
  f.service.getTimeoutRecoveryPolicy = () => policy;
  await f.run();
  assert.equal(f.calls.length, 2);
  const task = f.service.store.snapshot().tasks[0];
  assert.equal(task.timeout_recovery.limit, 1);
  assert.equal(task.timeout_recovery.state, 'exhausted');
});
