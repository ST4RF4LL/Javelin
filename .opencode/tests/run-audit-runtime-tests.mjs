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
import { readServiceConnection, ensureAuditService } from '../lib/audit-runtime/service-process.mjs';
import { createNativeClient } from '../lib/audit-runtime/native-client.mjs';
import plugin from '../lib/audit-runtime/opencode-session-plugin.mjs';
import { atomicJson, hash } from '../lib/task-board/contract.mjs';
import { prepareReview, acceptReview, finalizeBoard } from '../lib/task-board/review.mjs';
import { AgentSessionBridge } from '../lib/audit-runtime/session-bridge.mjs';

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
  assert.equal((await fetch(`${service.origin}/api/internal/service/stop`, { method: 'POST', headers })).status, 409);
  assert.equal((await client.call('register', f.registration)).audit.id, registered.audit.id);
  const targets = await service.backend.productStore.targetIds(registered.audit.execution_spec.product_id ?? 'undefined');
  assert.equal(targets.length, 1);
});

test('服务初始化健康状态等待就绪，不重复启动 Runner', async () => {
  let reads = 0;
  const result = await ensureAuditService({ origin: 'http://127.0.0.1:49199',
    fetcher: async () => ({ ok: true, json: async () => ({ service: 'opencode-audit-workbench', runtime_service: { protocol: 'audit-runtime-service.v1', ready: ++reads > 1 } }) }),
    spawnProcess() { throw new Error('不应启动'); } });
  assert.equal(result.started, false); assert.equal(reads, 2);
});

test('原生当前会话通过任务交付、独立质量复核和报告封存完成，保留真实会话且无主进程启动', async t => {
  const f = await fixture(t);
  const hub = new NativeSessionController({ runner: f.runner, token: 'a'.repeat(64),
    createAudit: (input, session) => f.runner.createAuditFromTarget({ ...f.input, ...input }, input.idempotency_key, { nativeSession: session }) });
  t.after(() => hub.close());
  const native = await hub.register(f.registration), id = native.audit.id;
  const service = f.runner.taskBoardServices.get(id), store = service.store;
  service.worker = async ({ job, input }) => {
    await atomicJson(input.report_path, { summary: '受控夹具：已检查入口代码，无漏洞候选。', findings: [], gaps: [] });
    await atomicJson(input.receipt_path, { protocol: 'task-board.v1', audit_id: id, task_id: job.task.task_id, attempt_id: input.attempt_id, outcome: 'REPORTED', report_path: 'report.json' });
  };
  await store.publish({ tasks: [{ task_id: 'fixture-source', kind: 'focus_area', title: '检查受控文件', domain: 'web',
    source_ref: 'threat:fixture', prompt: '检查 main.js', code_refs: [{ path: 'main.js', line: 1 }] }] });
  await store.seal(); service.pump();
  for (let i = 0; i < 100 && !store.summary().mining_complete; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.summary().reported, 1);
  const input = await prepareReview(store, { runtimeRequired: true }), relative = 'validation/native-fixture-quality.json';
  await atomicJson(join(service.reportsRoot, relative), { protocol: 'task-board.v1', audit_id: id, input_sha256: input.sha256,
    role: 'REPORT_REVIEW', agent_session_id: 'fixture-independent-review',
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
  let registered, heartbeat, replies = [], aborts = [], prompts = [];
  const hooks = await plugin({ directory: '/tmp', client: { session: {
    abort: async args => { aborts.push(args.path.id); }, promptAsync: async args => { prompts.push(args.path.id); },
  } } }, { api: { async call(operation, input) {
    if (operation === 'register') { registered = input; return { audit: { id: 'audit-plugin', status: 'running' }, client_id: 'client-fixture', workspace_root: '/tmp/audit-fixture',
      prompt: '按冻结范围审计', environment: { AUDIT_TASK_PROTOCOL: 'task-board.v1' }, heartbeat_ms: 10 }; }
    heartbeat = input; return replies.shift() ?? { status: 'running' };
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
  replies.push({ status: 'completed', terminal: true });
});
