import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { connectTtyd } from './fixtures/ttyd-client.mjs';
import { OpenCodeTmuxMonitor } from '../../../.opencode/web/dynamic-validation-observatory/tmux-monitor.mjs';
import { startTerminalMonitor } from '../scripts/start-terminal-monitor.mjs';

const fixture = fileURLToPath(new URL('./fixtures/opencode-shared-fixture.mjs', import.meta.url));
const emptyTmux = { listSessions: async () => ({ sessions: [], warnings: [] }), resolve: async () => undefined };
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
  const monitor = new OpenCodeTmuxMonitor({ stateRoot, command: fixture });
  const launch = async session => {
    audit.terminal = await monitor.start({ audit, repository: { path: root }, environment: { ...process.env, AUDIT_FIXTURE_MARKER: 'watchdog-env-preserved' },
      args: ['run', '--format', 'json', ...(session ? ['--session', session] : []), '--dir', root, '--title', audit.name, 'fixture prompt'], providerSessionId: session || null });
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
    app = await startTerminalMonitor({ port: 0, stateRoot: f.stateRoot, tmux: emptyTmux });
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
    await assert.rejects(f.request('/'), /abort|timeout/i);
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
    app = await startTerminalMonitor({ port: 0, stateRoot: f.stateRoot, tmux: emptyTmux });
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
    app = await startTerminalMonitor({ port: 0, stateRoot: f.stateRoot, tmux: emptyTmux });
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
