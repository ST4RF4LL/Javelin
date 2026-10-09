import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { connectTtyd } from './fixtures/ttyd-client.mjs';
import { OpenCodeProcessMonitor } from '../../../.opencode/web/dynamic-validation-observatory/opencode-process-monitor.mjs';
import { startTerminalMonitor } from '../scripts/start-terminal-monitor.mjs';

const fixture = fileURLToPath(new URL('./fixtures/opencode-shared-fixture.mjs', import.meta.url));
async function until(fn, message, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn().catch(() => null); if (result) return result; await delay(40); }
  throw new Error(message);
}
async function setup() {
  await chmod(fixture, 0o755);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'shared-opencode-test-')));
  const stateRoot = join(root, 'state'); await mkdir(stateRoot);
  const audit = { id: 'audit-shared-fixture', name: '共享会话回归', status: 'running', paths: { workspace_root: root } };
  const monitor = new OpenCodeProcessMonitor({ stateRoot, command: fixture });
  const launch = async session => {
    audit.terminal = await monitor.start({ audit, repository: { path: root }, environment: { ...process.env, AUDIT_FIXTURE_MARKER: 'watchdog-env-preserved' },
      args: ['run', '--format', 'json', ...(session ? ['--session', session] : []), '--dir', root, '--title', audit.name, 'fixture prompt'], providerSessionId: session || null });
    const child = monitor.launch(audit.terminal); child.stdout.resume(); child.stderr.resume();
    const binding = await until(() => readFile(join(stateRoot, audit.id, 'opencode-server.json'), 'utf8').then(JSON.parse), '服务未就绪');
    audit.provider_session_id = binding.session_id;
    await writeFile(join(stateRoot, audit.id, 'run.json'), JSON.stringify(audit));
    await until(async () => (await monitor.capture(audit.terminal)).includes('FIXTURE_STARTED'), 'JSON 未启动');
    return binding;
  };
  const binding = await launch();
  const request = (path, options = {}, connection = binding) => fetch(`${connection.url}${path}`, { ...options,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${connection.password}`).toString('base64')}` }, signal: AbortSignal.timeout(500) });
  return { root, stateRoot, audit, monitor, binding, launch, request,
    async close() { await monitor.stop(audit.terminal); await rm(root, { recursive: true, force: true }); } };
}
async function connect(base) { return connectTtyd(base, 'audit-shared-fixture'); }

test('共享服务：JSON 与 PTY 连接同一 session，输入可追踪，关闭页面/sidecar 不影响任务，暂停恢复覆盖服务', { timeout: 30_000 }, async () => {
  const f = await setup(); let app, connection;
  try {
    assert.equal(f.audit.terminal.shared_server, true);
    const created = JSON.parse((await readFile(join(f.root, 'session-create.jsonl'), 'utf8')).trim());
    assert.deepEqual(created.permission, ['question', 'plan_enter', 'plan_exit'].map(permission => ({ permission, action: 'deny', pattern: '*' })));
    assert.match(await f.monitor.capture(f.audit.terminal), /watchdog-env-preserved/);
    app = await startTerminalMonitor({ port: 0, stateRoot: f.stateRoot });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const listed = await (await fetch(`${base}/api/audits/audit-shared-fixture/terminal`)).text();
    assert.equal(listed.includes(f.binding.password), false);
    assert.equal(listed.includes(f.binding.url), false);
    connection = await connect(base);
    await until(async () => connection.output.includes('ATTACH_READY ses_shared_fixture'), 'TUI 未连接');
    assert.equal(connection.terminal.readOnly, false);
    connection.resize(100, 35);
    await until(async () => connection.output.includes('SIZE 100x35'), 'PTY 尺寸未同步');
    connection.input('USER_INSTRUCTION_FIXTURE 中文');
    await until(async () => (await f.monitor.capture(f.audit.terminal)).includes('USER_INSTRUCTION_FIXTURE'), '用户输入未进入 JSON 监控');
    const closed = once(connection.ws, 'close'); connection.ws.close(); await closed;
    assert.equal((await f.request('/')).status, 200);
    connection = await connectTtyd(base, f.audit.id, { readOnly: true });
    await until(async () => connection.output.includes('ATTACH_READY'), '只读连接失败');
    connection.input('READONLY_MUST_NOT_ARRIVE'); await delay(100);
    assert.equal((await f.monitor.capture(f.audit.terminal)).includes('READONLY_MUST_NOT_ARRIVE'), false);
    connection.ws.close(); await once(connection.ws, 'close');
    connection = await connect(base);
    await until(async () => connection.output.includes('ATTACH_READY'), '重连失败');
    await app.close(); app = null;
    assert.equal((await f.request('/')).status, 200);
    await f.monitor.signalRun(f.audit.terminal, 'SIGSTOP');
    assert.equal((await f.request('/')).status, 200, '暂停模型执行时保留会话服务');
    const pausedOutput = await f.monitor.capture(f.audit.terminal); await delay(100);
    assert.equal(await f.monitor.capture(f.audit.terminal), pausedOutput);
    await f.monitor.signalRun(f.audit.terminal, 'SIGCONT');
    assert.equal((await f.request('/')).status, 200);
    await f.monitor.abort(f.audit.terminal);
    await until(async () => readFile(f.audit.terminal.exit_path, 'utf8').then(JSON.parse), '取消未结束进程');
    await assert.rejects(f.request('/'));
    await assert.rejects(readFile(join(f.stateRoot, f.audit.id, 'opencode-server.json')), { code: 'ENOENT' });
  } finally { connection?.ws.terminate(); await app?.close(); await f.close(); }
});

test('结束后禁止连接；恢复复用原 session，生成新服务；服务崩溃令 JSON 执行器退出', { timeout: 25_000 }, async () => {
  const f = await setup(); let app;
  try {
    await f.request('/finish');
    await until(() => readFile(f.audit.terminal.exit_path, 'utf8').then(JSON.parse), '结束未写出状态');
    app = await startTerminalMonitor({ port: 0, stateRoot: f.stateRoot });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const response = await fetch(`${base}/api/audits/audit-shared-fixture/terminal`);
    assert.equal(response.status, 409);
    const recovered = await f.launch(f.binding.session_id);
    assert.equal(recovered.session_id, f.binding.session_id); assert.notEqual(recovered.generation, f.binding.generation);
    const stale = await fetch(`${base}/api/audits/${f.audit.id}/terminal?generation=${f.binding.generation}`, { method: 'POST', headers: { Origin: base } });
    assert.equal(stale.status, 409);
    const current = await fetch(`${base}/api/audits/${f.audit.id}/terminal?generation=${recovered.generation}`); assert.equal(current.status, 200);
    assert.equal((await readFile(join(f.root, 'creates.txt'), 'utf8')).trim().split('\n').length, 1);
    process.kill(recovered.server_pid, 'SIGKILL');
    await until(() => readFile(f.audit.terminal.exit_path, 'utf8').then(JSON.parse), '服务崩溃后 Runner 未退出');
    await assert.rejects(readFile(join(f.stateRoot, f.audit.id, 'opencode-server.json')), { code: 'ENOENT' });
  } finally { await app?.close(); await f.close(); }
});

test('输入按任务状态和服务代次校验，旧进程不会接收暂停或恢复后输入', { timeout: 20_000 }, async () => {
  const f = await setup(); let app, connection;
  try {
    app = await startTerminalMonitor({ port: 0, stateRoot: f.stateRoot });
    connection = await connect(`http://127.0.0.1:${app.server.address().port}`);
    await until(async () => connection.output.includes('ATTACH_READY'), 'TUI 未连接');
    f.audit.status = 'paused';
    await writeFile(join(f.stateRoot, f.audit.id, 'run.json'), JSON.stringify(f.audit));
    connection.input('MUST_NOT_ARRIVE');
    await delay(120);
    assert.equal((await f.monitor.capture(f.audit.terminal)).includes('MUST_NOT_ARRIVE'), false);
    const bad = await fetch(`http://127.0.0.1:${app.server.address().port}/api/audits/..%2Foutside/terminal`);
    assert.equal(bad.status, 404);
  } finally { connection?.ws.terminate(); await app?.close(); await f.close(); }
});

test('并发打开只启动一份ttyd，空闲回收后可重开；不回收OpenCode服务', { timeout: 20_000 }, async () => {
  const f = await setup(); let app, connection;
  try {
    app = await startTerminalMonitor({ port: 0, stateRoot: f.stateRoot, idleMs: 150, checkMs: 25 });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const results = await Promise.all(Array.from({ length: 4 }, () => fetch(`${base}/api/audits/${f.audit.id}/terminal`, { method: 'POST', headers: { Origin: base } }).then(r => r.json())));
    assert.equal(new Set(results.map(r => r.url)).size, 1); assert.equal(app.runtime.status().workers, 1);
    connection = await connect(base); await until(async () => connection.output.includes('ATTACH_READY'), '连接未就绪');
    await delay(180); assert.equal(app.runtime.status().workers, 1);
    connection.ws.close(); await once(connection.ws, 'close');
    await until(async () => app.runtime.status().workers === 0, '空闲ttyd未回收');
    assert.equal((await f.request('/')).status, 200);
    connection = await connect(base); await until(async () => connection.output.includes('ATTACH_READY'), '回收后不能重开');
    assert.notEqual(connection.terminal.url, results[0].url);
  } finally { connection?.ws.terminate(); await app?.close(); await f.close(); }
});

test('缺失ttyd可恢复报错，不遗留启动中进程，也不终止审计', { timeout: 15_000 }, async () => {
  const f = await setup(); let app;
  try {
    app = await startTerminalMonitor({ port: 0, stateRoot: f.stateRoot, command: '/no-such-ttyd' });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const response = await fetch(`${base}/api/audits/${f.audit.id}/terminal`, { method: 'POST', headers: { Origin: base } });
    assert.equal(response.status, 503); assert.equal(app.runtime.status().workers, 0);
    assert.equal((await f.request('/')).status, 200);
  } finally { await app?.close(); await f.close(); }
});

test('终端轮询检查实际 ttyd：PTY 启动失败可诊断并重连，凭据不进入错误响应', { timeout: 15_000 }, async () => {
  const f = await setup(); let app; const children = [];
  try {
    app = await startTerminalMonitor({ port: 0, stateRoot: f.stateRoot, spawnProcess() {
      const child = Object.assign(new EventEmitter(), { pid: 900000 + children.length, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
      child.kill = signal => { child.signalCode = signal; child.emit('exit', null, signal); return true; };
      children.push(child); queueMicrotask(() => child.stderr.write('Listening on port: 12345\n')); return child;
    } });
    const base = `http://127.0.0.1:${app.server.address().port}`, endpoint = `${base}/api/audits/${f.audit.id}/terminal`;
    const open = async () => (await fetch(endpoint, { method: 'POST', headers: { Origin: base } })).json();
    const initial = await open();
    assert.equal((await fetch(`${endpoint}?worker=${initial.worker}`)).status, 200);
    assert.equal((await fetch(`${endpoint}?worker=${initial.worker}&readonly=1`)).status, 409);
    children[0].stderr.write(`private credential ${f.binding.password}\nCreateProcessW failed\npty_spawn: 2 (No such file)\n`);
    const failure = await fetch(`${endpoint}?worker=${initial.worker}`), error = await failure.text();
    assert.equal(failure.status, 503); assert.match(error, /无法启动交互客户端/); assert.equal(error.includes(f.binding.password), false);
    const retried = await open(); assert.notEqual(retried.worker, initial.worker);
    assert.equal((await fetch(`${endpoint}?worker=${retried.worker}`)).status, 200);
    children[1].kill('SIGTERM');
    assert.equal((await fetch(`${endpoint}?worker=${retried.worker}`)).status, 409);
    assert.equal((await f.request('/')).status, 200, '终端故障不能关闭执行服务');
  } finally { await app?.close(); await f.close(); }
});

test('默认 AuditRunner 直接启动共享进程：JSON、暂停、恢复、取消全链路不调用 tmux/psmux', { timeout: 15000 }, async () => {
  const { AuditRunner } = await import('../../../.opencode/web/dynamic-validation-observatory/audit-runner.mjs');
  const { createHash } = await import('node:crypto');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'direct-runner-test-'))), source = join(root, 'source'), config = join(root, 'opencode.json');
  await mkdir(source); await writeFile(join(source, 'test.js'), 'export const fixture = true;'); await writeFile(config, '{"mcp":{}}');
  const stateRoot = join(root, 'state'), runner = new AuditRunner({ stateRoot, platformRoot: root, configPath: config, enabled: true, command: fixture });
  runner.setQueueScheduler({ async enqueueNewAudit() { return true; } });
  try {
    await runner.ready;
    const spec = { target_id: 'direct-fixture', target_name: '直接进程测试', source_scopes: [{ id: 'source', path: source }] };
    const audit = await runner.createAuditFromTarget({ target_id: spec.target_id, execution_spec: spec, execution_spec_digest: createHash('sha256').update(JSON.stringify(spec)).digest('hex'), bac_analysis: 'off' }, 'direct-runner-fixture');
    await runner.dispatchQueuedAudit(audit.id);
    await until(async () => runner.getAudit(audit.id).provider_session_id, '未绑定会话');
    let current = runner.getAudit(audit.id);
    assert.equal(current.terminal.backend, 'opencode-process'); assert.equal(current.terminal.socket_name, undefined);
    assert.equal(runner.health().active_tmux_monitors, 0);
    assert.match(await runner.terminalMonitor.capture(current.terminal), /session_bound/);
    await runner.action(audit.id, 'pause', current.version, 'direct-pause');
    assert.equal(runner.getAudit(audit.id).status, 'paused');
    const startsBeforeResume = await readFile(join(current.paths.workspace_root, 'run-starts.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    await runner.action(audit.id, 'resume', runner.getAudit(audit.id).version, 'direct-resume');
    current = runner.getAudit(audit.id); assert.equal(current.status, 'running'); assert.equal(current.provider_session_id, 'ses_shared_fixture');
    await until(async () => (await readFile(join(current.paths.workspace_root, 'run-starts.txt'), 'utf8')).length > startsBeforeResume.length, '恢复后未继续执行');
    await runner.action(audit.id, 'pause', current.version, 'direct-pause-before-cancel');
    current = runner.getAudit(audit.id);
    const starts = await readFile(join(current.paths.workspace_root, 'run-starts.txt'), 'utf8');
    await runner.action(audit.id, 'cancel', current.version, 'direct-cancel');
    await until(async () => runner.getAudit(audit.id).status === 'cancelled', '取消未结束');
    assert.equal(await readFile(join(current.paths.workspace_root, 'run-starts.txt'), 'utf8'), starts, '取消暂停任务不能重新提交指令');
    assert.equal(runner.health().active_processes, 0);
    await assert.rejects(readFile(join(stateRoot, audit.id, 'opencode-server.json')), { code: 'ENOENT' });
  } finally { await runner.shutdown(); await rm(root, { recursive: true, force: true }); }
});
