import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AuditRunner } from '../web/dynamic-validation-observatory/audit-runner.mjs';
import { PROTOCOL, atomicJson, hash } from '../lib/task-board/contract.mjs';
import { acceptReview, finalizeBoard, prepareReview } from '../lib/task-board/review.mjs';
import { readAuditTerminal } from '../../apps/workbench/scripts/audit-terminal-runtime.mjs';
import { ttydAttachCommand } from '../../apps/workbench/scripts/ttyd-command.mjs';
import { waitForInteractiveRelease } from '../lib/audit-runtime/engines/interactive-lease.mjs';

async function eventually(check) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check());
}
function child() {
  const process = new EventEmitter(); process.pid = 999999; process.exitCode = null; process.stdout = new PassThrough(); process.stderr = new PassThrough();
  let closed = false;
  process.kill = signal => { if (!closed) { closed = true; process.exitCode = 0; queueMicrotask(() => process.emit('close', 0, signal)); } return true; };
  return process;
}
async function fixture(t, engine) {
  const root = await mkdtemp(join(tmpdir(), 'javelin-engine-')), configPath = join(root, '.opencode', 'opencode.json');
  const source = join(root, 'source'), growHome = join(root, 'user-grow');
  await mkdir(source); await mkdir(growHome); await writeFile(join(source, 'app.py'), 'def public(): return 1\n');
  await atomicJson(configPath, { mcp: {} });
  await symlink(fileURLToPath(new URL('../agents', import.meta.url)), join(root, '.opencode', 'agents'), 'dir');
  await writeFile(join(growHome, 'config.toml'), '[models]\ndefault="fixture/fast"\n');
  const calls = [], mains = [];
  let mainSpec;
  const monitor = {
    async probe() { return { available: true, backend: 'agent-process' }; },
    async start(spec) { mainSpec = spec; return { backend: 'agent-process', live: true, supported: true, status: 'ready', shared_server: false }; },
    launch() { const process = child(); mains.push(process); calls.push({ main: true, ...mainSpec }); return process; },
    async stop() { const process = mains.at(-1); if (process && process.exitCode === null) { const closed = new Promise(resolve => process.once('close', resolve)); process.kill('SIGTERM'); await closed; } },
    async abort() { mains.at(-1)?.kill('SIGTERM'); }, async capture() { return ''; },
  };
  const runner = new AuditRunner({ stateRoot: join(root, 'state'), platformRoot: root, configPath, enabled: true,
    environment: { ...process.env, JAVELIN_GROW_USER_HOME: growHome }, terminalMonitor: monitor,
    spawnProcess(command, args, options) {
      const process = child(); calls.push({ command, args, options });
      setImmediate(async () => {
        try {
          let input;
          if (engine === 'grow') {
            const prompt = await readFile(args[args.indexOf('--prompt-file') + 1], 'utf8');
            input = JSON.parse(prompt.match(/<javelin-input[^>]*>\n([\s\S]*?)\n<\/javelin-input>/)[1]);
            process.stdout.write(JSON.stringify({ type: 'text', sessionId: args[args.indexOf('--session-id') + 1], data: '核对当前代码' }) + '\n');
          } else {
            input = JSON.parse(await readFile(args[args.indexOf('--file') + 1], 'utf8'));
            process.stdout.write(JSON.stringify({ type: 'text', sessionID: 'ses_worker_' + engine, part: { text: '核对当前代码' } }) + '\n');
          }
          await atomicJson(input.report_path, { summary: '已核对源码与权限控制。', findings: [], gaps: [] });
          await atomicJson(input.receipt_path, { protocol: PROTOCOL, audit_id: input.audit_id, task_id: input.task.task_id,
            attempt_id: input.attempt_id, outcome: 'REPORTED', report_path: 'report.json' });
          process.kill('done');
        } catch (error) { process.emit('error', error); process.kill('error'); }
      });
      return process;
    } });
  runner.agentSettings = { async resolve(id) { return { available: true, command: '/fixture/' + id }; } };
  runner.setQueueScheduler({ async enqueueNewAudit() { return true; } });
  t.after(async () => { await runner.shutdown(); await rm(root, { recursive: true, force: true }); });
  const snapshot = { target_id: 'fixture', target_name: '源码夹具', source_scopes: [{ id: 'source', path: await realpath(source) }] };
  const audit = await runner.createAuditFromTarget({ audit_id: 'audit-engine-' + engine, engine, target_id: 'fixture',
    execution_spec: snapshot, execution_spec_digest: hash(JSON.stringify(snapshot)), model: 'fixture/fast', bac_analysis: 'off',
    runtime_testing: { protocol: 'runtime-testing.v1', mode: 'CONTACT_ONLY', budget_minutes: 10, identity_mode: 'auto', allowed_actions: ['navigate'], explicit_authorization: false } }, 'create-' + engine);
  await runner.dispatchQueuedAudit(audit.id);
  return { root, runner, audit, calls, mains, monitor };
}

for (const engine of ['opencode', 'opencode-v2', 'grow']) test(`${engine}: 主任务、专业worker、报告收件复核封存使用同一基座，未授权动态测试跳过`, async t => {
  const { runner, audit, calls, mains, monitor } = await fixture(t, engine);
  const run = runner.audits.get(audit.id), service = runner.taskBoardServices.get(audit.id);
  assert.equal(run.execution.engine, engine); assert.equal(service.engine, engine);
  assert.equal(run.runtime_testing_state.status, 'SKIPPED');
  const main = calls[0];
  if (engine === 'grow') assert.ok(main.args.includes('--prompt-file'));
  else if (engine === 'opencode-v2') assert.ok(main.args.includes('--standalone'));
  else assert.ok(main.args.includes('--format'));
  await service.store.publish({ tasks: [{ task_id: 'one', kind: 'focus_area', domain: 'python', title: '测试任务',
    prompt: '核对当前代码', source_ref: 'threat:fixture', code_refs: [] }] });
  await service.store.seal(); service.pump();
  await eventually(() => service.store.summary().reported === 1);
  const worker = calls.find(call => !call.main);
  assert.equal(worker.args[1], '/fixture/' + engine);
  assert.equal(worker.options.shell, false); assert.equal(worker.options.windowsHide, true);
  if (engine === 'grow') {
    const firstId = worker.args[worker.args.indexOf('--session-id') + 1];
    const prompt = await readFile(worker.args[worker.args.indexOf('--prompt-file') + 1], 'utf8');
    const inputPath = JSON.parse(prompt.match(/<javelin-input path=("[^\n]+")>/)[1]);
    const input = JSON.parse(await readFile(inputPath, 'utf8'));
    const result = await service.runWorkerOnce({ job: { task: input.task, attempt: { attempt_id: input.attempt_id } },
      inputPath, sessionId: firstId, signal: new AbortController().signal });
    const forked = calls.findLast(call => !call.main);
    assert.equal(forked.args[forked.args.indexOf('--resume') + 1], firstId);
    assert.notEqual(result.session_id, firstId);
    assert.equal(result.session_id, forked.args[forked.args.indexOf('--session-id') + 1]);
    const persisted = JSON.parse(await readFile(join(inputPath, '..', 'session.json'), 'utf8'));
    assert.equal(persisted.agent_session_id, result.session_id);
    assert.equal(persisted.resumed_from_session_id, firstId);
  }
  const input = await prepareReview(service.store, { runtimeRequired: true }), quality = 'validation/quality.json';
  await atomicJson(join(service.reportsRoot, quality), { protocol: PROTOCOL, audit_id: audit.id, input_sha256: input.sha256,
    role: 'REPORT_REVIEW', agent_session_id: 'review-independent-session', assessments: [{ task_id: 'one', status: 'REVIEWED',
      reason: '已核对源码与报告', evidence_refs: ['app.py:1'], gaps: [] }] });
  await acceptReview(service.store, { quality: { path: quality, sha256: hash(await readFile(join(service.reportsRoot, quality))) } });
  await finalizeBoard(service.store);
  // Archive capture must not wait for an already-closed fixture child.
  monitor.stop = async () => {};
  mains.at(-1).kill('done');
  await eventually(() => runner.getAudit(audit.id).status === 'completed');
  assert.equal(runner.taskBoardServices.size, 0);
});

test('Grow暂停保存会话并关闭进程，继续任务继承历史并绑定新分支UUID', async t => {
  const { runner, audit, mains, monitor, calls } = await fixture(t, 'grow');
  const id = calls[0].args[calls[0].args.indexOf('--session-id') + 1];
  await runner.captureProviderSession(runner.audits.get(audit.id), JSON.stringify({ sessionID: id }));
  const stop = monitor.stop; monitor.stop = async () => { monitor.stop = async () => {}; await stop(); };
  await runner.action(audit.id, 'pause', runner.getAudit(audit.id).version, 'pause-grow');
  assert.equal(runner.getAudit(audit.id).status, 'paused'); assert.equal(runner.processes.size, 0);
  await eventually(() => !runner.completions.has(audit.id));
  await runner.action(audit.id, 'resume', runner.getAudit(audit.id).version, 'resume-grow');
  await runner.dispatchQueuedAudit(audit.id);
  const resumed = calls.filter(call => call.main).at(-1);
  assert.equal(resumed.args[resumed.args.indexOf('--resume') + 1], id);
  assert.equal(resumed.args.includes('--fork-session'), true);
  const nextId = resumed.args[resumed.args.indexOf('--session-id') + 1];
  assert.notEqual(nextId, id);
  assert.equal(runner.getAudit(audit.id).execution.resumed_from_session_id, id);
  mains.at(-1).stdout.write(JSON.stringify({ type: 'text', sessionId: nextId, data: '继续核对未完成任务' }) + '\n');
  await eventually(() => runner.getAudit(audit.id).provider_session_id === nextId);
  assert.equal(runner.getAudit(audit.id).execution.session_id, nextId);
  monitor.abort = async () => { mains.at(-1).kill('SIGTERM'); };
});

test('Grow终端拒绝并发运行，暂停后只恢复绑定session，Windows命令保持独立基座', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'engine-terminal-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'audit-grow-terminal', directory = join(root, id), cwd = join(root, 'workspace'); await mkdir(directory); await mkdir(cwd);
  const session = '11111111-1111-4111-8111-111111111111';
  const audit = { id, status: 'running', pid: 12, execution: { engine: 'grow', generation: 'generation' }, provider_session_id: session,
    paths: { workspace_root: cwd }, terminal: { live: true } };
  await atomicJson(join(directory, 'run.json'), audit);
  await atomicJson(join(directory, 'agent-terminal.json'), { audit_id: id, engine: 'grow', generation: 'generation', command: '/fixture/grow', cwd, environment: { GROW_HOME: join(root, 'grow-home') } });
  assert.throws(() => readAuditTerminal(root, id), /先暂停/);
  await atomicJson(join(directory, 'run.json'), { ...audit, status: 'paused', pid: null, terminal: { live: false } });
  const target = readAuditTerminal(root, id); assert.equal(target.args[target.args.indexOf('--resume') + 1], session); assert.equal(target.kind, 'grow');
  const command = ttydAttachCommand(target, { platform: 'win32' });
  assert.match(command.args.at(-1), /--resume/); assert.doesNotMatch(command.args.at(-1), /opencode attach/);
  assert.equal(command.environment.JAVELIN_TERMINAL_AGENT, '/fixture/grow');
  assert.throws(() => readAuditTerminal(root, id, { generation: 'stale' }), /失效/);
});

test('Grow恢复先等待交互终端退出，不杀其他进程；过期连接记录可回收', async t => {
  const root = await mkdtemp(join(tmpdir(), 'engine-lease-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'lease.json'); await atomicJson(path, { pid: 12345 });
  await assert.rejects(waitForInteractiveRelease(path, { timeout: 0, alive: () => true }), /交互终端尚未关闭/);
  await waitForInteractiveRelease(path, { alive: () => false });
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('OpenCode v2终端沿用共享服务的隔离数据目录，只继承绑定中的目录白名单', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'engine-v2-terminal-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'audit-v2-terminal', directory = join(root, id); await mkdir(directory);
  const environment = Object.fromEntries(['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'JAVELIN_OPENCODE_V2_HOME']
    .map(key => [key, join(root, key)]));
  await atomicJson(join(directory, 'run.json'), { id, status: 'running', execution: { engine: 'opencode-v2' },
    provider_session_id: 'ses_fixture', paths: { workspace_root: root }, terminal: { live: true, shared_server: true, server_generation: 'generation' } });
  await atomicJson(join(directory, 'opencode-server.json'), { schema_version: 'opencode-v2-shared-run.v1', audit_id: id,
    session_id: 'ses_fixture', generation: 'generation', directory: root, command: '/fixture/opencode2',
    url: 'http://127.0.0.1:12345/', password: 'a'.repeat(64), config_path: join(root, 'config.json'), config_directory: root,
    environment: { ...environment, OPENCODE_DB: '/legacy/opencode.db', UNRELATED_SECRET: 'do-not-inherit' } });
  const target = readAuditTerminal(root, id);
  assert.equal(target.kind, 'opencode-v2');
  assert.deepEqual(target.args, ['--server', 'http://127.0.0.1:12345/', '--session', 'ses_fixture']);
  for (const [key, value] of Object.entries(environment)) assert.equal(target.environment[key], value);
  assert.equal(target.environment.OPENCODE_DB, undefined); assert.equal(target.environment.UNRELATED_SECRET, undefined);
});
