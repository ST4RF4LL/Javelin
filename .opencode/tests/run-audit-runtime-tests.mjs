import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AuditRunner } from '../web/dynamic-validation-observatory/audit-runner.mjs';
import { NativeSessionController } from '../lib/audit-runtime/native-sessions.mjs';
import { startAuditService } from '../scripts/audit-service.mjs';
import { DEFAULT_SERVICE_ORIGIN, readServiceConnection, ensureAuditService } from '../lib/audit-runtime/service-process.mjs';
import { createNativeClient } from '../lib/audit-runtime/native-client.mjs';
import plugin from '../lib/audit-runtime/opencode-session-plugin.mjs';
import { atomicJson, hash } from '../lib/task-board/contract.mjs';
import { prepareReview, acceptReview, finalizeBoard } from '../lib/task-board/review.mjs';
import { AgentSessionBridge } from '../lib/audit-runtime/session-bridge.mjs';
import { TaskBoardStore, readBoard } from '../lib/task-board/store.mjs';

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'audit-runtime-')));
  const source = join(root, 'source'), configPath = join(root, '.opencode/opencode.json'), stateRoot = join(root, 'state');
  await mkdir(source); await writeFile(join(source, 'main.js'), 'export const fixture = true;\n');
  await atomicJson(configPath, { mcp: {} });
  const launches = [], runner = new AuditRunner({ stateRoot, platformRoot: root, configPath, enabled: true,
    terminalMonitor: { async probe() { return { available: false, message: '隔离测试' }; }, async stop() {} },
    spawnProcess(command, args, config) {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 999999;
      child.kill = signal => { if (signal === 'SIGTERM') queueMicrotask(() => child.emit('close', 0, signal)); return true; };
      launches.push({ command, args, config, child }); return child;
    }, ...options });
  runner.setQueueScheduler({ async enqueueNewAudit() { return true; } });
  await runner.ready;
  t.after(async () => { await runner.shutdown().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const snapshot = { target_id: 'native-fixture', target_name: '当前会话测试', source_scopes: [{ id: 'source-one', path: source }] };
  const input = { target_id: snapshot.target_id, execution_spec: snapshot, execution_spec_digest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), bac_analysis: 'off' };
  const registration = { registration_id: 'registration-one', source_root: source,
    session: { engine: 'opencode', session_id: 'ses_existing_fixture', directory: source, control: true } };
  return { root, stateRoot, source, configPath, runner, launches, input, registration };
}

async function unfinishedBoard(f, audit) {
  await f.runner.stopTaskBoard(audit);
  audit.paths = await f.runner.prepareExecutionWorkspace(audit, f.runner.repositoryForAudit(audit));
  const store = await new TaskBoardStore({ path: audit.task_board_path, reportsRoot: audit.paths.reports_root, auditId: audit.id, scopeDigest: audit.source_baseline.scope_digest }).open();
  await store.publish({ tasks: [{ task_id: 'unfinished', kind: 'focus_area', title: '补查授权路径', domain: 'web', source_ref: 'threat:fixture', prompt: '分析 main.js', code_refs: [{ path: 'main.js', line: 1 }] }] });
  const job = await store.claim('web', 5000);
  await store.receive({ taskId: job.task.task_id, attemptId: job.attempt.attempt_id, inputRoot: f.root,
    receipt: { protocol: 'task-board.v1', audit_id: audit.id, task_id: job.task.task_id, attempt_id: job.attempt.attempt_id, outcome: 'GAP', reason: '模型额度耗尽' } });
  await store.seal(); await store.close(); audit.status = 'completed'; audit.provider_session_id = 'ses_previous';
  return readBoard(audit.task_board_path);
}

test('Web 增量入口重开已完成缺口任务、同请求只入队一次、运行时拒绝重复，启动沿用 session', async t => {
  const f = await fixture(t), created = await f.runner.createAuditFromTarget(f.input, 'incremental-web');
  const audit = f.runner.audits.get(created.id); await unfinishedBoard(f, audit);
  audit.todo_completion = { complete: true, delivery_outcome: 'NO_REPORTS' };
  const before = await f.runner.taskBoardPage(audit.id, { status: 'REPORTED' });
  assert.equal(before.items.length, 0); assert.equal(before.incremental.task_count, 1, '计划不受当前分页筛选影响');
  assert.equal(before.incremental.available, true);
  const version = audit.version;
  await f.runner.action(audit.id, 'incremental', version, 'same-incremental-request');
  assert.equal(audit.status, 'queued'); assert.equal(audit.todo_completion, null);
  assert.equal(audit.incremental_audit.number, 1); assert.equal(audit.queue.provider_session_id, 'ses_previous');
  await f.runner.action(audit.id, 'incremental', version, 'same-incremental-request');
  assert.equal((await readBoard(audit.task_board_path)).incremental_rounds.length, 1);
  await assert.rejects(f.runner.action(audit.id, 'incremental', audit.version, 'second-request'), { code: 'audit-not-recoverable' });
  await f.runner.dispatchQueuedAudit(audit.id);
  const launch = f.launches.find(row => row.args.includes('--session'));
  assert.ok(launch); assert.equal(launch.args[launch.args.indexOf('--session') + 1], 'ses_previous');
  assert.match(launch.args.join(' '), /增量审计/); assert.match(launch.args.join(' '), /禁止重新联系测试目标/);
  assert.equal((await f.runner.taskBoardPage(audit.id)).incremental.available, false);
});

test('增量入口在源码漂移时不改动任务面板', async t => {
  const f = await fixture(t), created = await f.runner.createAuditFromTarget(f.input, 'incremental-drift');
  const audit = f.runner.audits.get(created.id); await unfinishedBoard(f, audit);
  const original = await readFile(audit.task_board_path, 'utf8');
  await writeFile(join(f.source, 'main.js'), 'changed source\n');
  await assert.rejects(f.runner.action(audit.id, 'incremental', audit.version, 'source-drift'));
  assert.equal(await readFile(audit.task_board_path, 'utf8'), original); assert.equal(audit.status, 'completed');
  assert.equal(f.launches.length, 0);
});

test('完成性 watchdog 与增量重开互斥，旧校验不能关闭新一轮任务', async t => {
  const f = await fixture(t), created = await f.runner.createAuditFromTarget(f.input, 'incremental-watchdog');
  const audit = f.runner.audits.get(created.id); await unfinishedBoard(f, audit); audit.status = 'interrupted';
  let release, entered = false;
  f.runner.todoCompletionVerifier = async () => { entered = true; return new Promise(resolve => { release = resolve; }); };
  const checking = f.runner.reconcileManagedCompletion(audit);
  while (!entered) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.runner.action(audit.id, 'incremental', audit.version, 'watchdog-race'), { code: 'audit-operation-in-progress' });
  release({ complete: false, errors: ['旧轮次缺口'] }); await checking;
  await f.runner.action(audit.id, 'incremental', audit.version, 'watchdog-race');
  assert.equal(audit.status, 'queued'); assert.equal(audit.todo_completion, null);
  assert.equal((await readBoard(audit.task_board_path)).tasks[0].status, 'PENDING');
});

test('原生增量审计向原会话发送指令，完成确认前不宣布成功，不新建主进程', async t => {
  const f = await fixture(t);
  const hub = new NativeSessionController({ runner: f.runner, token: 'a'.repeat(64),
    createAudit: (input, session) => f.runner.createAuditFromTarget({ ...f.input, ...input }, input.idempotency_key, { nativeSession: session }) });
  t.after(() => hub.close());
  const native = await hub.register(f.registration), audit = f.runner.audits.get(native.audit.id);
  await unfinishedBoard(f, audit);
  await f.runner.action(audit.id, 'incremental', audit.version, 'native-incremental');
  const hb = { audit_id: audit.id, client_id: native.client_id };
  const pending = await hub.heartbeat(hb);
  assert.equal(pending.status, 'recovering'); assert.equal(pending.command.action, 'incremental');
  assert.match(pending.command.prompt, /第 1 轮增量审计/); assert.ok(pending.command.environment.AUDIT_TASK_BOARD_CONNECTION_PATH);
  await hub.heartbeat({ ...hb, ack: { id: pending.command.id } });
  assert.equal(audit.status, 'running'); assert.equal(audit.execution.session_id, f.registration.session.session_id);
  assert.equal(f.launches.filter(row => row.args.includes('--agent') && row.args.includes('security-audit-orchestrator')).length, 0);
});

test('双入口：Web 创建主进程，原生登记沿用真实 session；登记重试不重复创建，动态未授权为 SKIPPED', async t => {
  const f = await fixture(t);
  const web = await f.runner.createAuditFromTarget(f.input, 'web-fixture');
  await assert.rejects(f.runner.createAuditFromTarget({ ...f.input, engine: 'codex' }, 'unsupported-managed-engine'), { code: 'agent-launch-unavailable' });
  assert.equal(web.execution.entry, 'web'); assert.equal(web.execution.ownership, 'service');
  await f.runner.dispatchQueuedAudit(web.id); assert.equal(f.launches.length, 1);
  await f.runner.captureProviderSession(f.runner.audits.get(web.id), JSON.stringify({ sessionID: 'ses_web_fixture' }));
  assert.equal(f.runner.getAudit(web.id).execution.session_id, 'ses_web_fixture');
  const hub = new NativeSessionController({ runner: f.runner, token: 'a'.repeat(64),
    createAudit: (input, session) => f.runner.createAuditFromTarget({ ...f.input, ...input }, input.idempotency_key, { nativeSession: session }) });
  t.after(() => hub.close());
  const native = await hub.register(f.registration), duplicate = await hub.register(f.registration);
  assert.equal(native.audit.id, duplicate.audit.id); assert.equal(native.client_id, duplicate.client_id);
  assert.equal(f.launches.length, 1); assert.equal(native.audit.execution.session_id, 'ses_existing_fixture');
  assert.equal(native.audit.execution.ownership, 'external'); assert.equal(native.audit.pid, null);
  assert.equal(native.environment.AUDIT_TASK_PROTOCOL, 'task-board.v1');
  assert.equal(native.audit.runtime_testing_state.status, 'SKIPPED');
  assert.doesNotMatch(JSON.stringify(native.audit), /native_context|OPENCODE_CONFIG_CONTENT/);
  assert.doesNotMatch(native.prompt, /\.opencode.*\.opencode.*workflow\.md/);
  const heartbeat = { audit_id: native.audit.id, client_id: native.client_id };
  await hub.heartbeat({ ...heartbeat, idle: true, events: [{ message: '当前会话检查了源码。' }] });
  assert.equal(f.runner.getAudit(native.audit.id).status, 'running', 'idle 不等于完成');
  assert.match(await readFile(join(f.stateRoot, native.audit.id, 'runner.log.jsonl'), 'utf8'), /检查了源码/);
  const audit = f.runner.audits.get(native.audit.id);
  await hub.action(audit, 'pause', 'pause-one');
  const pending = await hub.heartbeat(heartbeat);
  assert.equal(pending.status, 'pausing'); assert.equal(pending.command.action, 'pause');
  await hub.heartbeat({ ...heartbeat, ack: { id: pending.command.id } });
  assert.equal(audit.status, 'paused'); assert.equal(f.runner.taskBoardServices.has(audit.id), false);
  await hub.action(audit, 'resume', 'resume-one');
  const resumed = await hub.heartbeat(heartbeat);
  await hub.heartbeat({ ...heartbeat, ack: { id: resumed.command.id } });
  assert.equal(audit.status, 'running'); assert.equal(f.launches.length, 1, '恢复原生任务不启动第二个主进程');
  await hub.action(audit, 'cancel', 'cancel-one');
  const cancelled = await hub.heartbeat(heartbeat);
  const ack = await hub.heartbeat({ ...heartbeat, ack: { id: cancelled.command.id } });
  assert.equal(ack.status, 'cancelled'); assert.equal(ack.terminal, false, '取消后仍保留控制连接以支持恢复');
});

test('外部会话失联保留制品、停止领取，不终止主进程；重登记恢复，旧客户端拒绝', async t => {
  const f = await fixture(t); let now = 1000;
  const hub = new NativeSessionController({ runner: f.runner, token: 'a'.repeat(64), clock: () => now, heartbeatMs: 1000,
    createAudit: (input, session) => f.runner.createAuditFromTarget({ ...f.input, ...input }, input.idempotency_key, { nativeSession: session }) });
  t.after(() => hub.close());
  const native = await hub.register(f.registration);
  now += 2000; await hub.check();
  assert.equal(f.runner.getAudit(native.audit.id).status, 'interrupted'); assert.equal(f.launches.length, 0);
  await assert.rejects(hub.heartbeat({ audit_id: native.audit.id, client_id: native.client_id }), { code: 'agent-session-stale' });
  const reconnected = await hub.register(f.registration);
  assert.equal(reconnected.audit.id, native.audit.id); assert.equal(reconnected.audit.status, 'running');
  assert.equal(f.launches.length, 0);
  const audit = f.runner.audits.get(native.audit.id), heartbeat = { audit_id: audit.id, client_id: reconnected.client_id };
  await hub.action(audit, 'pause', 'pause-before-disconnect');
  const command = (await hub.heartbeat(heartbeat)).command;
  await hub.heartbeat({ ...heartbeat, ack: { id: command.id } });
  now += 2000; await hub.check();
  assert.equal((await hub.register(f.registration)).audit.status, 'paused', '暂停状态不能因重连而自动运行');
  await writeFile(join(f.source, 'main.js'), 'changed frozen source\n');
  await assert.rejects(hub.action(audit, 'resume', 'drift-recovery'));
  assert.equal(audit.status, 'interrupted'); assert.equal(f.runner.taskBoardServices.has(audit.id), false);
});

test('执行状态单写入者；只读 Runner 不改运行状态或登记文件，不执行恢复', async t => {
  const f = await fixture(t);
  const web = await f.runner.createAuditFromTarget(f.input, 'read-only-fixture');
  const path = join(f.stateRoot, web.id, 'run.json'), before = await readFile(path, 'utf8');
  const reader = new AuditRunner({ stateRoot: f.stateRoot, platformRoot: f.root, configPath: f.configPath, enabled: false });
  await reader.ready;
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal(await reader.dispatchQueuedAudit(web.id), null);
  await assert.rejects(reader.action(web.id, 'cancel', web.version, 'readonly-cancel'), { code: 'runner-disabled' });
  await reader.shutdown();
  const competing = new AuditRunner({ stateRoot: f.stateRoot, platformRoot: f.root, configPath: f.configPath, enabled: true });
  await assert.rejects(competing.ready, { code: 'audit-state-owned' });
  assert.equal(await readFile(path, 'utf8'), before);
});

test('后台 HTTP 当前会话入口鉴权、范围登记和健康检查；后台停止保护活动任务', async t => {
  const f = await fixture(t), serviceRoot = join(f.root, 'connection');
  const service = await startAuditService({ port: 0, serviceRoot, stateRoot: f.stateRoot,
    backendOptions: { runner: f.runner, platformConfigPath: f.configPath, modelConfigPaths: [f.configPath], runtimeRoot: join(f.root, 'reports') } });
  t.after(() => service.close());
  const connection = await readServiceConnection(serviceRoot);
  const headers = { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' };
  const endpoint = `${service.origin}/api/internal/agent-sessions/register`;
  assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, origin: 'http://127.0.0.1' }, body: '{}' })).status, 403);
  const client = createNativeClient({ connection });
  const registered = await client.call('register', f.registration);
  assert.equal(registered.audit.execution.entry, 'agent'); assert.equal(f.launches.length, 0);
  const health = await (await fetch(`${service.origin}/api/v1/runtime/health`)).json();
  assert.equal(health.runtime_service.ready, true); assert.equal(health.runner.registered_agent_sessions, 1);
  for (const path of ['/', '/index.html', '/app.js', '/legacy/']) assert.equal((await fetch(`${service.origin}${path}`)).status, 404);
  assert.equal((await fetch(`${service.origin}/api/internal/service/stop`, { method: 'POST', headers })).status, 409);
  assert.equal((await client.call('register', f.registration)).audit.id, registered.audit.id);
  const targets = await service.backend.productStore.targetIds(registered.audit.execution_spec.product_id ?? 'undefined');
  assert.equal(targets.length, 1);
});

test('服务初始化健康状态等待就绪，不重复启动 Runner', async t => {
  const serviceRoot = await mkdtemp(join(tmpdir(), 'service-wait-')); t.after(() => rm(serviceRoot, { recursive: true, force: true }));
  let reads = 0;
  const result = await ensureAuditService({ origin: 'http://127.0.0.1:49199', serviceRoot,
    fetcher: async () => ({ ok: true, json: async () => ({ service: 'opencode-audit-workbench', runtime_service: { protocol: 'audit-runtime-service.v1', ready: ++reads > 1 } }) }),
    spawnProcess() { throw new Error('不应启动'); } });
  assert.equal(result.started, false); assert.equal(reads, 2);
});

test('默认审计 API 使用独立端口；旧连接仍活动时拒绝创建第二个执行器', async t => {
  assert.equal(DEFAULT_SERVICE_ORIGIN, 'http://127.0.0.1:4183');
  const serviceRoot = await mkdtemp(join(tmpdir(), 'service-migration-')); t.after(() => rm(serviceRoot, { recursive: true, force: true }));
  const calls = [], fetcher = async url => { calls.push(url); return { ok: true, json: async () => ({ service: 'opencode-audit-workbench', runtime_service: { ready: true } }) }; };
  const result = await ensureAuditService({ serviceRoot, fetcher, spawnProcess() { throw new Error('不能启动'); } });
  assert.equal(result.started, false); assert.deepEqual(calls, [`${DEFAULT_SERVICE_ORIGIN}/api/v1/runtime/health`]);
  await atomicJson(join(serviceRoot, 'connection.json'), { protocol: 'audit-runtime-service.v1', origin: 'http://127.0.0.1:4173', token: 'a'.repeat(64) });
  calls.length = 0;
  await assert.rejects(ensureAuditService({ serviceRoot, fetcher, spawnProcess() { throw new Error('不能启动'); } }), /未启动第二个 Runner/);
  assert.deepEqual(calls, ['http://127.0.0.1:4173/api/v1/runtime/health']);
});

for (const strategy of ['focus_area', 'file_sweep']) test(`原生当前会话 ${strategy} 通过任务交付、独立质量复核和报告封存完成，保留真实会话且无主进程启动`, async t => {
  const f = await fixture(t);
  const hub = new NativeSessionController({ runner: f.runner, token: 'a'.repeat(64),
    createAudit: (input, session) => f.runner.createAuditFromTarget({ ...f.input, ...input }, input.idempotency_key, { nativeSession: session }) });
  t.after(() => hub.close());
  const native = await hub.register({ ...f.registration, mining_strategy: strategy }), id = native.audit.id;
  const service = f.runner.taskBoardServices.get(id), store = service.store;
  assert.equal(store.snapshot().mining_strategy, strategy);
  service.worker = async ({ job, input }) => {
    await atomicJson(input.report_path, { summary: '受控夹具：已检查入口代码，无漏洞候选。', findings: [], gaps: [] });
    await atomicJson(input.receipt_path, { protocol: 'task-board.v1', audit_id: id, task_id: job.task.task_id, attempt_id: input.attempt_id, outcome: 'REPORTED', report_path: 'report.json' });
  };
  const file = strategy === 'file_sweep' ? await store.claimFile({}) : null;
  if (file) await store.readFile(f.source, file);
  await store.publish({ tasks: [{ task_id: 'fixture-source', kind: 'focus_area', title: '检查受控文件', domain: 'web',
    source_ref: file?.file_id ?? 'threat:fixture', prompt: '检查 main.js', code_refs: [{ path: 'main.js', line: 1 }] }] });
  if (file) await store.completeFile({ file_id: file.file_id, attempt_id: file.attempt_id, outcome: 'BROWSED', summary: '已浏览模块入口并发布相关区域核查任务。', task_ids: ['fixture-source'] }, f.source);
  await store.seal(); service.pump();
  for (let i = 0; i < 100 && !store.summary().mining_complete; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.summary().reported, 1);
  const input = await prepareReview(store, { runtimeRequired: true }), relative = 'validation/native-fixture-quality.json';
  await atomicJson(join(service.reportsRoot, relative), { protocol: 'task-board.v1', audit_id: id, input_sha256: input.sha256,
    role: 'REPORT_REVIEW', agent_session_id: 'fixture-independent-review',
    ...(file ? { file_discovery: { status: 'REVIEWED', reason: '已核对浏览记录与初筛依据。', evidence_refs: ['main.js:1'], gaps: [] } } : {}),
    assessments: [{ task_id: 'fixture-source', status: 'REVIEWED', reason: '受控夹具核验了入口与对应报告。', evidence_refs: ['main.js:1'], gaps: [] }] });
  await acceptReview(store, { quality: { path: relative, sha256: hash(await readFile(join(service.reportsRoot, relative))) } });
  await finalizeBoard(store);
  const result = await hub.heartbeat({ audit_id: id, client_id: native.client_id, check_completion: true });
  assert.equal(result.status, 'completed'); assert.equal(result.terminal, true);
  assert.equal(f.runner.getAudit(id).execution.session_id, f.registration.session.session_id);
  assert.equal(f.launches.length, 0);
  assert.equal(f.runner.taskBoardServices.has(id), false);
});

test('通用 Agent 桥接使用同一登记、受控 CLI 和完成门禁，未适配控制的引擎不伪造控制能力', async () => {
  let registration, command, heartbeatCount = 0;
  const bridge = new AgentSessionBridge({ api: { async call(operation, input) {
    if (operation === 'register') { registration = input; return { audit: { id: 'audit-codex-native', status: 'running' }, client_id: 'fixture',
      workspace_root: '/tmp', prompt: '当前会话继续执行', environment: { AUDIT_TASK_PROTOCOL: 'task-board.v1' }, heartbeat_ms: 5000 }; }
    heartbeatCount++; return { status: 'running' };
  } }, execute: async (...args) => { command = args; return { stdout: '{"next_action":"PUBLISH"}' }; } });
  try {
    await bridge.register({ engine: 'codex', session_id: 'actual-codex-thread-id', directory: '/tmp', source_root: '/tmp' });
    assert.equal(registration.session.control, false); assert.equal(registration.session.session_id, 'actual-codex-thread-id');
    await bridge.command('codex:actual-codex-thread-id', 'task_board', ['status']);
    assert.equal(command[0], process.execPath); assert.match(command[1][0], /scripts\/task-board.mjs$/);
    assert.equal(command[2].shell, false); assert.equal(command[2].env.AUDIT_TASK_PROTOCOL, 'task-board.v1');
    assert.equal(heartbeatCount, 2);
    await assert.rejects(bridge.command('codex:actual-codex-thread-id', 'bash', ['anything']), /命令参数无效/);
  } finally { bridge.close(); }
});

test('OpenCode 插件使用 ToolContext 的当前 ID，并向子会话注入同一任务环境', async t => {
  let registered, heartbeat, replies = [], aborts = [], prompts = [], forwardedErrors = [];
  const hooks = await plugin({ directory: '/tmp', client: { session: {
    abort: async args => { aborts.push(args.path.id); }, promptAsync: async args => { prompts.push(args.path.id); },
  } } }, { api: { async call(operation, input) {
    if (operation === 'register') { registered = input; return { audit: { id: 'audit-plugin', status: 'running' }, client_id: 'client-fixture', workspace_root: '/tmp/audit-fixture',
      prompt: '按冻结范围审计', environment: { AUDIT_TASK_PROTOCOL: 'task-board.v1' }, heartbeat_ms: 10 }; }
    heartbeat = input; forwardedErrors.push(...(input.events ?? []).filter(event => JSON.parse(event.message).type === 'error')); return replies.shift() ?? { status: 'running' };
  } } });
  const response = JSON.parse(await hooks.tool.audit_register.execute({ source_root: '/tmp' }, { sessionID: 'ses_actual_context', agent: 'security-audit-orchestrator' }));
  assert.equal(response.session_id, 'ses_actual_context'); assert.equal(registered.session.session_id, response.session_id);
  const env = { env: {} }; await hooks['shell.env']({ sessionID: response.session_id }, env);
  assert.equal(env.env.AUDIT_TASK_PROTOCOL, 'task-board.v1');
  await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_child', parentID: response.session_id } } } });
  const childEnv = { env: {} }; await hooks['shell.env']({ sessionID: 'ses_child' }, childEnv); assert.deepEqual(childEnv, env);
  const deadline = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(predicate()); };
  t.after(() => { replies.push({ status: 'completed', terminal: true }); });
  replies.push({ status: 'pausing', command: { id: 'pause-id', action: 'pause' } });
  await deadline(() => aborts.length === 1); assert.equal(aborts[0], response.session_id);
  replies.push({ status: 'recovering', command: { id: 'resume-id', action: 'resume', prompt: '继续当前审计' } });
  await deadline(() => prompts.length === 1); assert.equal(prompts[0], response.session_id);
  assert.equal(heartbeat.audit_id, 'audit-plugin');
  replies.push({ status: 'recovering', command: { id: 'timeout-id', action: 'recover', prompt: '从超时处继续' } });
  await hooks.event({ event: { type: 'session.error', properties: { sessionID: response.session_id,
    error: { name: 'UnknownError', data: { message: 'The operation timed out.' } } } } });
  await deadline(() => prompts.length === 2 && forwardedErrors.length === 1);
  assert.equal(aborts[1], response.session_id); assert.equal(prompts[1], response.session_id);
  replies.push({ status: 'completed', terminal: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  const idleEnv = { env: {} }; await hooks['shell.env']({ sessionID: response.session_id }, idleEnv);
  assert.deepEqual(idleEnv.env, {}, '完成后保持被动连接，不注入审计环境');
  replies.push({ status: 'recovering', command: { id: 'incremental-id', action: 'incremental', prompt: '增补缺口', environment: { AUDIT_TASK_PROTOCOL: 'task-board.v1', AUDIT_INCREMENTAL_FIXTURE: 'new' } } });
  await deadline(() => prompts.length === 3);
  const incrementalEnv = { env: {} }; await hooks['shell.env']({ sessionID: response.session_id }, incrementalEnv);
  assert.equal(incrementalEnv.env.AUDIT_INCREMENTAL_FIXTURE, 'new');
  assert.equal(aborts[2], response.session_id); assert.equal(prompts[2], response.session_id);
  replies.push({ status: 'completed', terminal: true });
});

const timeoutError = { type: 'error', sessionID: 'ses_timeout_main', error: { name: 'UnknownError', data: { message: 'The operation timed out.' } } };
const until = async predicate => { for (let n = 0; n < 500 && !predicate(); n++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(predicate()); };

test('设置 API 修改后，正在运行的主任务与专业任务服务使用新策略', async t => {
  const f = await fixture(t, { environment: {} });
  const created = await f.runner.createAuditFromTarget(f.input, 'settings-live-task');
  f.runner.queueScheduler = null; await f.runner.dispatchQueuedAudit(created.id);
  const workers = f.runner.taskBoardServices.get(created.id);
  const service = await startAuditService({ port: 0, serviceRoot: join(f.root, 'settings-connection'), stateRoot: f.stateRoot,
    backendOptions: { runner: f.runner, platformConfigPath: f.configPath, modelConfigPaths: [f.configPath], runtimeRoot: join(f.root, 'reports') } });
  t.after(() => service.close());
  const endpoint = `${service.origin}/api/v1/settings/timeout-recovery`;
  assert.deepEqual((await (await fetch(endpoint)).json()).timeout_recovery, { max_recoveries: 20, retry_delay_seconds: 10, updated_at: null });
  const response = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_recoveries: 7, retry_delay_seconds: 42 }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).timeout_recovery.retry_delay_seconds, 42);
  assert.deepEqual(workers.getTimeoutRecoveryPolicy(), { limit: 7, delay_ms: 42000 });
  assert.equal((await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 422);
  assert.deepEqual(f.runner.timeoutRecoveryPolicy, { limit: 7, delay_ms: 42000 });
  f.launches[0].child.stdout.write(`${JSON.stringify(timeoutError)}\n`);
  await until(() => f.runner.timeoutRecoveryTimers.has(created.id));
  const audit = f.runner.audits.get(created.id);
  const remaining = Date.parse(audit.timeout_recovery.next_retry_at) - Date.now();
  assert.ok(remaining > 40000 && remaining <= 42000); assert.equal(audit.timeout_recovery.limit, 7);
  await f.runner.action(audit.id, 'pause', audit.version, 'stop-settings-fixture');
});

test('Web JSON 超时沿用审计和 session，去重、拒绝旧进程事件，耗尽后保持未完成', async t => {
  const f = await fixture(t, { environment: { AUDIT_TIMEOUT_RETRY_DELAY_MS: '0', AUDIT_TIMEOUT_MAX_RECOVERIES: '2' } });
  const created = await f.runner.createAuditFromTarget(f.input, 'timeout-web');
  f.runner.queueScheduler = null; await f.runner.dispatchQueuedAudit(created.id);
  const audit = f.runner.audits.get(created.id), root = audit.paths.workspace_root;
  await writeFile(join(root, 'checkpoint-note.txt'), '已保存的证据');
  f.launches[0].child.stdout.write(`${JSON.stringify({ type: 'text', part: { text: JSON.stringify(timeoutError) } })}\n`);
  assert.equal(audit.timeout_recovery, undefined);
  f.launches[0].child.stdout.write(`${JSON.stringify(timeoutError)}\n${JSON.stringify(timeoutError)}\n`);
  await until(() => f.launches.length === 2 && audit.timeout_recovery?.state === 'restarted');
  assert.equal(audit.status, 'running'); assert.equal(audit.recovery_count, 1);
  assert.equal(f.launches[1].args[f.launches[1].args.indexOf('--session') + 1], timeoutError.sessionID);
  assert.equal(audit.paths.workspace_root, root); assert.equal(await readFile(join(root, 'checkpoint-note.txt'), 'utf8'), '已保存的证据');
  f.launches[0].child.stdout.write(`${JSON.stringify(timeoutError)}\n`);
  assert.equal(audit.timeout_recovery.attempts, 1);
  f.launches[1].child.stdout.write(`${JSON.stringify(timeoutError)}\n`);
  await until(() => f.launches.length === 3 && audit.timeout_recovery?.state === 'restarted');
  f.launches[2].child.stdout.write(`${JSON.stringify(timeoutError)}\n`);
  await until(() => audit.status === 'interrupted' && audit.timeout_recovery?.state === 'exhausted' && !f.runner.completions.has(audit.id));
  assert.equal(f.launches.length, 3); assert.match(audit.error, /用完 2 次/);
  assert.equal(f.runner.timeoutRecoveryTimers.size, 0);
  await until(() => !f.runner.completions.has(audit.id));
  await f.runner.action(audit.id, 'recover', audit.version, 'manual-recover-after-exhaustion');
  assert.equal(f.launches.length, 4);
  f.launches[3].child.stdout.write(`${JSON.stringify(timeoutError)}\n`);
  await until(() => f.launches.length === 5 && audit.timeout_recovery?.state === 'restarted');
  assert.equal(audit.timeout_recovery.attempts, 1);
  assert.equal(audit.status, 'running');
});

test('旧进程日志延迟落盘不能再次触发新会话恢复', async t => {
  const f = await fixture(t, { environment: { AUDIT_TIMEOUT_RETRY_DELAY_MS: '0' } });
  const created = await f.runner.createAuditFromTarget(f.input, 'late-timeout-log');
  f.runner.queueScheduler = null; await f.runner.dispatchQueuedAudit(created.id);
  const audit = f.runner.audits.get(created.id), original = f.runner.record;
  const pendingLogs = [];
  f.runner.record = async function(row, type, payload, options) {
    if (type === 'agent.output') await new Promise(resolve => pendingLogs.push(resolve));
    return original.call(this, row, type, payload, options);
  };
  f.launches[0].child.stdout.write(`${JSON.stringify(timeoutError)}\n`);
  await until(() => f.launches.length === 2 && audit.timeout_recovery?.state === 'restarted' && pendingLogs.length > 0);
  f.runner.record = original;
  for (const resolve of pendingLogs) resolve();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.launches.length, 2); assert.equal(audit.timeout_recovery.attempts, 1);
  assert.equal(audit.status, 'running');
});

for (const action of ['pause', 'cancel']) test(`退避期间用户 ${action} 优先，旧恢复回调不得重启`, async t => {
  const f = await fixture(t, { environment: { AUDIT_TIMEOUT_RETRY_DELAY_MS: '30000' } });
  const created = await f.runner.createAuditFromTarget(f.input, `stop-timeout-${action}`);
  f.runner.queueScheduler = null; await f.runner.dispatchQueuedAudit(created.id);
  const audit = f.runner.audits.get(created.id);
  f.launches[0].child.stdout.write(`${JSON.stringify(timeoutError)}\n`);
  await until(() => audit.status === 'interrupted' && f.runner.timeoutRecoveryTimers.has(audit.id));
  assert.ok(Date.parse(audit.timeout_recovery.next_retry_at) > Date.now());
  await f.runner.action(audit.id, action, audit.version, `manual-${action}`);
  assert.equal(audit.timeout_recovery.state, 'stopped');
  assert.equal(await f.runner.runOperationTimeoutRecovery(audit.id, 1), false);
  assert.equal(f.launches.length, 1);
  assert.equal(audit.status, action === 'pause' ? 'interrupted' : 'cancelled');
});

test('Web 服务重启重建保存的超时等待，关闭期间不启动模型', async t => {
  const f = await fixture(t, { environment: { AUDIT_TIMEOUT_RETRY_DELAY_MS: '30000' } });
  const created = await f.runner.createAuditFromTarget(f.input, 'persist-timeout');
  f.runner.queueScheduler = null; await f.runner.dispatchQueuedAudit(created.id);
  f.launches[0].child.stdout.write(`${JSON.stringify(timeoutError)}\n`);
  await until(() => f.runner.timeoutRecoveryTimers.has(created.id));
  await f.runner.shutdown(); assert.equal(f.launches.length, 1);
  const second = new AuditRunner({ stateRoot: f.stateRoot, platformRoot: f.root, configPath: f.configPath, enabled: true,
    environment: { AUDIT_TIMEOUT_RETRY_DELAY_MS: '30000' }, terminalMonitor: f.runner.terminalMonitor, spawnProcess: f.runner.spawnProcess });
  try {
    await second.ready;
    assert.equal(second.getAudit(created.id).timeout_recovery.state, 'waiting-to-recover');
    assert.equal(second.timeoutRecoveryTimers.has(created.id), true); assert.equal(f.launches.length, 1);
  } finally { await second.shutdown(); }
});

test('原生 OpenCode 超时在当前 session 请求 recover，子会话错误不会重启主会话', async t => {
  const f = await fixture(t, { environment: { AUDIT_TIMEOUT_RETRY_DELAY_MS: '0' } });
  const hub = new NativeSessionController({ runner: f.runner, token: 'a'.repeat(64),
    createAudit: (input, session) => f.runner.createAuditFromTarget({ ...f.input, ...input }, input.idempotency_key, { nativeSession: session }) });
  t.after(() => hub.close());
  const binding = await hub.register(f.registration), audit = f.runner.audits.get(binding.audit.id);
  const heartbeat = { audit_id: audit.id, client_id: binding.client_id };
  await hub.heartbeat({ ...heartbeat, events: [{ message: JSON.stringify(timeoutError) }] });
  assert.equal(audit.timeout_recovery, undefined);
  await hub.heartbeat({ ...heartbeat, events: [{ message: JSON.stringify({ ...timeoutError, sessionID: audit.execution.session_id }) }] });
  await until(() => audit.timeout_recovery?.state === 'restarted');
  const command = (await hub.heartbeat(heartbeat)).command;
  assert.equal(command.action, 'recover'); assert.match(command.prompt, /复用已交付制品/);
  await hub.heartbeat({ ...heartbeat, ack: { id: command.id } });
  assert.equal(audit.status, 'running'); assert.equal(audit.execution.session_id, f.registration.session.session_id);
  assert.equal(f.launches.length, 0);
});
