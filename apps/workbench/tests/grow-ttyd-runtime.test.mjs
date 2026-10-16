import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createTtydRuntime } from '../scripts/ttyd-runtime.mjs';

class MockTtyd extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.signals = [];
  }
  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
  kill(signal) {
    this.signals.push(signal);
    queueMicrotask(() => this.exit(null, signal));
    return true;
  }
}

async function until(predicate, message) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}

const argument = (target, name) => target.args[target.args.indexOf(name) + 1];
async function prepareCheckpointHead(target) {
  const home = target.environment.GROW_HOME;
  await writeFile(join(home, 'javelin-session.json'), JSON.stringify({
    schema: 'javelin-grow-session.v1', sessionId: target.boundSessionId, cwd: target.cwd,
  }));
  await writeFile(join(home, 'javelin-interactive-head.json'), JSON.stringify({
    schema: 'javelin-grow-interactive-head.v1', baseSessionId: target.boundSessionId,
    parentSessionId: argument(target, '--resume'), sessionId: argument(target, '--session-id'), cwd: target.cwd,
  }));
}
async function persistGrowSummary(target, sessionId, cwd = target.cwd) {
  const directory = join(target.environment.GROW_HOME, 'sessions', 'fixture-project', sessionId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'summary.json'), JSON.stringify({ info: { id: sessionId, cwd } }));
}

async function fixture(t, runtimeOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'grow-ttyd-runtime-'));
  const stateRoot = join(root, 'state');
  const auditId = 'audit-grow-checkpoint';
  const auditRoot = join(stateRoot, auditId);
  const workspace = join(root, 'workspace');
  const growHome = join(root, 'grow-home');
  const generation = randomUUID();
  const providerSessionId = randomUUID();
  const leasePath = join(auditRoot, 'agent-terminal-lease.json');
  await Promise.all([mkdir(auditRoot, { recursive: true }), mkdir(workspace), mkdir(growHome)]);
  const audit = {
    id: auditId, name: 'Grow checkpoint fixture', status: 'paused', pid: null,
    provider_session_id: providerSessionId,
    execution: { engine: 'grow', generation },
    paths: { workspace_root: workspace },
    terminal: { live: false },
  };
  const binding = {
    engine: 'grow', audit_id: auditId, generation,
    command: join(root, 'bin', process.platform === 'win32' ? 'grow.exe' : 'grow'),
    cwd: workspace, environment: { GROW_HOME: growHome },
  };
  const saveAudit = () => writeFile(join(auditRoot, 'run.json'), JSON.stringify(audit));
  await Promise.all([saveAudit(), writeFile(join(auditRoot, 'agent-terminal.json'), JSON.stringify(binding))]);
  const spawns = [];
  const preparations = [];
  const { prepareGrowTerminal = async () => {}, onSpawn = () => {}, onReady = () => {}, ...options } = runtimeOptions;
  const runtime = createTtydRuntime({
    stateRoot, command: 'fixture-ttyd', checkMs: 10, idleMs: 60_000, ...options,
    async prepareGrowTerminal(target) {
      const lease = JSON.parse(await readFile(target.leasePath, 'utf8'));
      assert.equal(lease.pid, spawns.at(-1).child.pid, '准备角色时必须已经占有当前终端租约');
      assert.equal(lease.generation, target.generation);
      preparations.push({ target, lease });
      await prepareGrowTerminal(target);
    },
    spawnProcess(command, args, options) {
      const child = new MockTtyd(900_000 + spawns.length);
      spawns.push({ command, args, options, child });
      onSpawn(child);
      setImmediate(() => {
        child.stderr.write(`Listening on port: ${29000 + spawns.length}\n`);
        onReady(child);
      });
      return child;
    },
  });
  t.after(async () => {
    await runtime.close();
    for (const { child } of spawns) { child.stdout.destroy(); child.stderr.destroy(); }
    await rm(root, { recursive: true, force: true });
  });
  return {
    runtime, auditRoot, auditId, audit, binding, saveAudit, generation, providerSessionId, leasePath, spawns, preparations,
    readAudit: () => readFile(join(auditRoot, 'run.json'), 'utf8').then(JSON.parse),
    readLease: () => readFile(leasePath, 'utf8').then(JSON.parse),
    writeLease: lease => writeFile(leasePath, JSON.stringify(lease)),
  };
}

test('Grow checkpoint 终端限制单连接，重复打开复用进程，readonly 冲突不启动第二个客户端', async t => {
  const f = await fixture(t);
  const [worker, duplicate] = await Promise.all([
    f.runtime.open(f.auditId, { generation: f.generation, readOnly: false }),
    f.runtime.open(f.auditId, { generation: f.generation, readOnly: false }),
  ]);
  assert.equal(duplicate, worker);
  assert.equal(f.spawns.length, 1);
  const { command, args, options } = f.spawns[0];
  assert.equal(command, 'fixture-ttyd');
  assert.equal(args[args.indexOf('-m') + 1], '1');
  assert.ok(args.includes('-o'), '每个交互分支只启动一次；断开后新请求从实际持久化 head 创建下一分支');
  assert.ok(args.includes('-W'));
  assert.equal(options.cwd, f.binding.cwd);
  assert.equal(options.env.GROW_HOME, f.binding.environment.GROW_HOME);
  assert.equal(options.env.GROW_DISABLE_AUTOUPDATER, '1');
  for (const key of ['GROW_MEMORY', 'GROW_WORKFLOWS', 'GROW_GOAL']) assert.equal(options.env[key], '0');
  assert.ok(args.some(argument => argument.includes(f.providerSessionId)));
  assert.equal(f.preparations.length, 1);
  assert.equal(f.preparations[0].lease.id, worker.id);
  assert.equal(worker.target.args[worker.target.args.indexOf('--agent') + 1], join(f.binding.environment.GROW_HOME, 'agents', 'interactive-security-audit-orchestrator.md'));
  assert.ok(args.some(argument => argument.includes('--agent')));
  assert.ok(args.some(argument => argument.includes('--no-memory')));
  assert.ok(args.some(argument => argument.includes('--no-plan')));
  assert.deepEqual(await f.readLease(), { pid: worker.child.pid, generation: f.generation, id: worker.id });
  assert.equal(await f.runtime.open(f.auditId, { readOnly: false }), worker);
  await assert.rejects(f.runtime.open(f.auditId, { readOnly: true }), { status: 409 });
  assert.equal(f.spawns.length, 1);
  await f.runtime.close();
  assert.deepEqual(worker.child.signals, ['SIGTERM']);
  await assert.rejects(f.readLease(), { code: 'ENOENT' });
});

test('Grow 交互分支落盘后当前终端仍有效并复用，重新打开才从新 head 分叉', async t => {
  const f = await fixture(t, { prepareGrowTerminal: prepareCheckpointHead });
  const initial = f.runtime.resolve(f.auditId);
  const initialFork = argument(initial, '--session-id');
  assert.equal(argument(initial, '--resume'), f.providerSessionId);
  assert.equal(initial.boundSessionId, f.providerSessionId);
  assert.ok(initial.args.includes('--fork-session'));
  assert.match(initialFork, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(argument(f.runtime.resolve(f.auditId), '--session-id'), initialFork);
  const worker = await f.runtime.open(f.auditId);
  assert.equal(argument(worker.target, '--session-id'), initialFork);
  assert.equal(argument(f.runtime.resolve(f.auditId), '--resume'), f.providerSessionId, '仅准备了 head、没有 Grow summary 时仍从原会话恢复');

  await persistGrowSummary(worker.target, initialFork);
  const advanced = f.runtime.resolve(f.auditId);
  const nextFork = argument(advanced, '--session-id');
  assert.equal(argument(advanced, '--resume'), initialFork);
  assert.notEqual(nextFork, initialFork);
  assert.equal(advanced.fingerprint, worker.target.fingerprint, '交互 head 推进不改变当前终端所有权');
  assert.equal(advanced.boundSessionId, f.providerSessionId);
  assert.equal(f.runtime.valid(worker), true);
  assert.equal(f.runtime.get(worker.id), worker);
  assert.equal(await f.runtime.open(f.auditId), worker);
  assert.equal(f.spawns.length, 1);
  assert.equal(f.preparations.length, 1);
  assert.deepEqual(worker.child.signals, []);

  worker.child.exit(0);
  await until(() => f.runtime.status().workers === 0, '关闭交互终端后未释放租约');
  const nextWorker = await f.runtime.open(f.auditId);
  assert.equal(argument(nextWorker.target, '--resume'), initialFork);
  assert.equal(argument(nextWorker.target, '--session-id'), nextFork);
  assert.ok(nextWorker.target.args.includes('--fork-session'));
  assert.equal(f.spawns.length, 2);
  assert.equal(f.preparations.length, 2);
  // The next browser has not connected yet, so its newly prepared UUID has no
  // Grow summary. Keep the last persisted parent instead of losing that branch.
  assert.equal(argument(f.runtime.resolve(f.auditId), '--resume'), initialFork);
  assert.equal(f.runtime.valid(nextWorker), true);
  assert.equal(await f.runtime.open(f.auditId), nextWorker);
  assert.equal(f.spawns.length, 2);

  f.audit.provider_session_id = randomUUID();
  await f.saveAudit();
  assert.equal(f.runtime.valid(nextWorker), false, '托管主会话发生变化时仍必须使旧终端失效');
});

test('Grow 未启动的预配 head 和其他工作目录的 summary 均不能充当恢复会话', async t => {
  const f = await fixture(t, { prepareGrowTerminal: prepareCheckpointHead });
  const worker = await f.runtime.open(f.auditId);
  const preparedFork = argument(worker.target, '--session-id');
  worker.child.exit(0);
  await until(() => f.runtime.status().workers === 0, '预配终端未完成清理');
  assert.equal(argument(f.runtime.resolve(f.auditId), '--resume'), f.providerSessionId);
  await persistGrowSummary(worker.target, preparedFork, join(f.binding.cwd, 'unrelated-project'));
  assert.equal(argument(f.runtime.resolve(f.auditId), '--resume'), f.providerSessionId);
  const nextWorker = await f.runtime.open(f.auditId);
  assert.equal(argument(nextWorker.target, '--resume'), f.providerSessionId);
  assert.equal(argument(nextWorker.target, '--session-id'), preparedFork, '相同 generation 与 parent 使用稳定的预配 UUID');
  assert.equal(f.spawns.length, 2);
});

test('Grow 先获取租约再准备审计角色，准备完成前不返回可连接终端', async t => {
  const started = Promise.withResolvers();
  const prepared = Promise.withResolvers();
  const f = await fixture(t, {
    async prepareGrowTerminal(target) { started.resolve(target); await prepared.promise; },
  });
  let opened = false;
  const opening = f.runtime.open(f.auditId).then(worker => { opened = true; return worker; });
  try {
    const target = await started.promise;
    assert.equal(target.leasePath, f.leasePath);
    assert.equal(opened, false);
    assert.equal(f.runtime.status().workers, 0);
    assert.equal((await f.readLease()).pid, f.spawns[0].child.pid);
    assert.deepEqual(f.spawns[0].child.signals, []);
  } finally {
    prepared.resolve();
    await opening;
  }
  assert.equal(opened, true);
  assert.equal(f.runtime.status().workers, 1);
});

test('Grow 角色准备失败关闭所属 ttyd 并删除租约，修正后可以重新打开', async t => {
  let attempts = 0;
  const f = await fixture(t, {
    async prepareGrowTerminal() {
      attempts++;
      if (attempts === 1) throw new Error('fixture role preparation failed');
    },
  });
  await assert.rejects(f.runtime.open(f.auditId), /fixture role preparation failed/);
  assert.equal(f.runtime.status().workers, 0);
  assert.deepEqual(f.spawns[0].child.signals, ['SIGTERM']);
  await assert.rejects(f.readLease(), { code: 'ENOENT' });
  const worker = await f.runtime.open(f.auditId);
  assert.equal(attempts, 2);
  assert.equal(f.spawns.length, 2);
  assert.equal(f.runtime.get(worker.id), worker);
  assert.deepEqual(await f.readLease(), { pid: worker.child.pid, generation: f.generation, id: worker.id });
  assert.deepEqual(worker.child.signals, []);
});

test('Grow ttyd 在角色准备期间退出，准备结束前保留租约避免与后台恢复并发', async t => {
  const started = Promise.withResolvers();
  const prepared = Promise.withResolvers();
  const f = await fixture(t, {
    async prepareGrowTerminal() { started.resolve(); await prepared.promise; },
  });
  const opening = assert.rejects(f.runtime.open(f.auditId), { status: 409 });
  try {
    await started.promise;
    const lease = await f.readLease();
    f.spawns[0].child.exit(0);
    await delay(20);
    assert.deepEqual(await f.readLease(), lease, '角色准备尚未结束，不能释放租约');
  } finally {
    prepared.resolve();
    await opening;
  }
  assert.equal(f.runtime.status().workers, 0);
  await assert.rejects(f.readLease(), { code: 'ENOENT' });
});

test('Grow ttyd 在创建租约期间退出，不再启动角色准备且回收刚创建的租约', async t => {
  const f = await fixture(t, {
    onSpawn(child) {
      const pid = child.pid;
      let accessed = false;
      Object.defineProperty(child, 'pid', { get() {
        if (!accessed) { accessed = true; queueMicrotask(() => child.exit(0)); }
        return pid;
      } });
    },
  });
  await assert.rejects(f.runtime.open(f.auditId), { status: 409 });
  assert.equal(f.preparations.length, 0);
  assert.equal(f.runtime.status().workers, 0);
  await assert.rejects(f.readLease(), { code: 'ENOENT' });
});

test('Grow ttyd 宣告就绪后立即退出，不向前端返回已死亡终端或启动角色准备', async t => {
  const f = await fixture(t, { onReady: child => child.exit(0) });
  await assert.rejects(f.runtime.open(f.auditId), { status: 409 });
  assert.equal(f.preparations.length, 0);
  assert.equal(f.runtime.status().workers, 0);
  await assert.rejects(f.readLease(), { code: 'ENOENT' });
});

test('OpenCode v2 ttyd 不继承宿主 OPENCODE_DB，也不修改宿主环境', async t => {
  const previous = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = 'host-database-must-not-leak';
  t.after(() => { if (previous === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = previous; });
  const f = await fixture(t);
  f.audit.execution.engine = 'opencode-v2';
  f.audit.status = 'running';
  f.audit.provider_session_id = 'ses_v2_terminal_fixture';
  f.audit.terminal = { live: true, shared_server: true, server_generation: f.generation };
  await f.saveAudit();
  await writeFile(join(f.auditRoot, 'opencode-server.json'), JSON.stringify({
    schema_version: 'opencode-v2-shared-run.v1', audit_id: f.auditId,
    session_id: f.audit.provider_session_id, generation: f.generation,
    directory: f.binding.cwd, command: f.binding.command,
    password: 'a'.repeat(64), url: 'http://127.0.0.1:29100',
    config_path: join(f.binding.environment.GROW_HOME, 'opencode.json'),
    config_directory: f.binding.environment.GROW_HOME,
  }));
  await f.runtime.open(f.auditId);
  assert.equal(Object.hasOwn(f.spawns[0].options.env, 'OPENCODE_DB'), false);
  assert.equal(process.env.OPENCODE_DB, 'host-database-must-not-leak');
  assert.equal(f.preparations.length, 0);
});

test('Grow readonly 终端也独占原会话，不能同时打开可写终端', async t => {
  const f = await fixture(t);
  const worker = await f.runtime.open(f.auditId, { readOnly: true });
  assert.equal(f.spawns[0].args.includes('-W'), false);
  await assert.rejects(f.runtime.open(f.auditId, { readOnly: false }), { status: 409 });
  assert.equal(f.spawns.length, 1);
  assert.equal((await f.readLease()).id, worker.id);
});

test('Grow 回收确定死亡的旧 ttyd 租约后可以重新打开', async t => {
  const f = await fixture(t);
  const stalePid = 800_001;
  const probes = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    probes.push({ pid, signal });
    assert.equal(pid, stalePid);
    assert.equal(signal, 0, '仅检查存活状态，不终止其他进程');
    throw Object.assign(new Error('fixture process does not exist'), { code: 'ESRCH' });
  });
  await f.writeLease({ pid: stalePid, generation: 'old-generation', id: 'old-worker' });
  const worker = await f.runtime.open(f.auditId);
  assert.deepEqual(probes, [{ pid: stalePid, signal: 0 }]);
  assert.equal(f.spawns.length, 1);
  assert.deepEqual(await f.readLease(), { pid: worker.child.pid, generation: f.generation, id: worker.id });
});

test('Grow 遇到仍存活的外部租约返回 409，保留租约且不启动进程', async t => {
  const f = await fixture(t);
  const liveLease = { pid: 800_002, generation: f.generation, id: 'external-worker' };
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, liveLease.pid);
    assert.equal(signal, 0);
    return true;
  });
  await f.writeLease(liveLease);
  await assert.rejects(f.runtime.open(f.auditId), { status: 409 });
  assert.equal(f.spawns.length, 0);
  assert.deepEqual(await f.readLease(), liveLease);
});

test('Grow 审计恢复运行后只关闭所属 ttyd 并释放租约，JSON 任务状态保持运行', async t => {
  const f = await fixture(t);
  const worker = await f.runtime.open(f.auditId);
  let connectionClosed = false;
  worker.connections.add(() => { connectionClosed = true; });
  f.audit.status = 'running';
  f.audit.pid = 800_003;
  f.audit.terminal.live = true;
  await f.saveAudit();
  await until(() => f.runtime.status().workers === 0, '任务恢复后未关闭交互终端');
  assert.equal(connectionClosed, true);
  assert.deepEqual(worker.child.signals, ['SIGTERM']);
  await assert.rejects(f.readLease(), { code: 'ENOENT' });
  const savedAudit = await f.readAudit();
  assert.equal(savedAudit.status, 'running');
  assert.equal(savedAudit.pid, 800_003);
  await assert.rejects(f.runtime.open(f.auditId), { status: 409 });
  assert.equal(f.spawns.length, 1);
});

test('旧 Grow ttyd 的退出和重复关闭清理不能删除其他持有者的新租约', async t => {
  const f = await fixture(t);
  const worker = await f.runtime.open(f.auditId);
  const nextLease = { pid: 800_004, generation: randomUUID(), id: 'new-worker-owner' };
  await f.writeLease(nextLease);
  worker.child.exit(0);
  await Promise.all([f.runtime.close(), f.runtime.close()]);
  worker.child.emit('exit', 0, null);
  await f.runtime.close();
  assert.deepEqual(await f.readLease(), nextLease);
  assert.deepEqual(worker.child.signals, []);
  assert.equal(f.runtime.status().workers, 0);
});

test('已退出的 Grow 终端完成清理后，新终端租约不受旧退出事件影响', async t => {
  const f = await fixture(t);
  const oldWorker = await f.runtime.open(f.auditId);
  oldWorker.child.exit(0);
  await until(() => f.runtime.status().workers === 0, '旧终端租约未完成清理');
  await assert.rejects(f.readLease(), { code: 'ENOENT' });
  const nextWorker = await f.runtime.open(f.auditId);
  assert.notEqual(nextWorker.id, oldWorker.id);
  oldWorker.child.emit('exit', 0, null);
  await delay(20);
  assert.equal(f.runtime.get(nextWorker.id), nextWorker);
  assert.deepEqual(await f.readLease(), { pid: nextWorker.child.pid, generation: f.generation, id: nextWorker.id });
  assert.equal(f.spawns.length, 2);
});
