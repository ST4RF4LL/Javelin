import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { once, EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import WebSocket from 'ws';
import { startTerminalMonitor, terminalMonitorConfiguration, installTerminalMonitorShutdown, TERMINAL_MONITOR_ORIGINS, TERMINAL_PROTOCOL } from '../scripts/start-terminal-monitor.mjs';
import { checkTtyd } from '../scripts/ttyd-runtime.mjs';
import { readAuditTerminal } from '../scripts/audit-terminal-runtime.mjs';
import { connectTtyd } from './fixtures/ttyd-client.mjs';
const execute = promisify(execFile);
const entry = fileURLToPath(new URL('../scripts/start-terminal-monitor.mjs', import.meta.url));
async function until(fn) { for (let i = 0; i < 150; i++) { if (await fn()) return; await delay(40); } assert.fail('等待终端超时'); }

test('宿主脚本导入不监听、不创建进程，不注册退出处理器', async () => {
  const script = `import net from 'node:net'; import child from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    net.Server.prototype.listen=()=>{throw new Error('import-listened')};
    for(const key of ['spawn','exec','execFile','execFileSync','fork'])child[key]=()=>{throw new Error('import-spawned')};
    syncBuiltinESMExports();const before=[process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')];
    await import(${JSON.stringify(pathToFileURL(entry).href)});
    if(JSON.stringify(before)!==JSON.stringify([process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')]))throw new Error('import-signal-handlers');`;
  await execute(process.execPath, ['--input-type=module', '-e', script], { timeout: 10_000 });
});
test('默认4184且固定本机，不能用环境变量开启任意Shell或外部绑定', () => {
  const value = terminalMonitorConfiguration({ TERMINAL_ALLOW_SHELL: '1', TERMINAL_HOST: '0.0.0.0', TERMINAL_ALLOWED_ORIGINS: '*' });
  assert.equal(value.port, 4184); assert.equal(value.host, '127.0.0.1'); assert.equal(value.backend, 'ttyd'); assert.equal(value.allowShell, false);
  assert.deepEqual(value.allowedOrigins, TERMINAL_MONITOR_ORIGINS);
  assert.equal(terminalMonitorConfiguration({ WORKBENCH_TERMINAL_PORT: '4284' }).port, 4284);
  for (const port of ['0', '4173', '4181', '4183', '-1', '65536', 'oops']) assert.throws(() => terminalMonitorConfiguration({ TERMINAL_PORT: port }));
});
test('HTTP/CORS/Host/WS边界：任意Shell、无关任务和非信任来源均不启动ttyd', async () => {
  let spawned = 0;
  const app = await startTerminalMonitor({ port: 0, spawnProcess: () => { spawned++; throw new Error('不可启动'); } });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    for (const origin of TERMINAL_MONITOR_ORIGINS) {
      const response = await fetch(`${base}/api/config`, { headers: { Origin: origin } });
      assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.equal((await response.json()).workbenchProtocol, TERMINAL_PROTOCOL);
    }
    assert.equal((await fetch(`${base}/api/config`, { headers: { Origin: 'http://untrusted.invalid' } })).status, 403);
    const hostStatus = await new Promise((resolve, reject) => { http.get(`${base}/api/config`, { headers: { Host: 'rebind.invalid' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject); });
    assert.equal(hostStatus, 403);
    assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', body: JSON.stringify({ profile: 'shell' }) })).status, 404);
    assert.equal((await fetch(`${base}/api/audits/audit-missing/terminal`, { method: 'POST', headers: { Origin: base } })).status, 409);
    assert.equal((await fetch(`${base}/api/audits/audit-missing/terminal`, { method: 'POST' })).status, 403);
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/t/000000000000000000000000/ws`, 'tty', { origin: 'http://untrusted.invalid' });
    await assert.rejects(once(ws, 'open'), /403/); assert.equal(spawned, 0);
  } finally { await app.close(); }
});
test('SIGINT/SIGTERM只幂等关闭所属终端，不触发主Runner操作', async () => {
  const target = new EventEmitter(); target.stderr = { write: () => assert.fail('不应报错') }; let closes = 0;
  const stop = installTerminalMonitorShutdown({ close: async () => { closes++; await delay(5); } }, target);
  target.emit('SIGINT'); target.emit('SIGTERM'); await stop(); await stop(); assert.equal(closes, 1);
});
test('端口占用不影响已有服务；缺失ttyd返回安装提示', async () => {
  const existing = http.createServer((_req, response) => response.end('fixture-still-alive'));
  await new Promise(resolve => existing.listen(0, '127.0.0.1', resolve));
  try {
    const port = existing.address().port; await assert.rejects(startTerminalMonitor({ port }), { code: 'EADDRINUSE' });
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'fixture-still-alive');
    await assert.rejects(checkTtyd('/no-such-ttyd'), /brew install ttyd/);
  } finally { await new Promise(resolve => existing.close(resolve)); }
});
test('拒绝任务目录和连接文件的符号链接越界', async () => {
  const root = await mkdtemp('/private/tmp/ttyd-path-test-');
  try {
    await mkdir(join(root, 'state')); await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(root, 'state/audit-outside'));
    assert.throws(() => readAuditTerminal(join(root, 'state'), 'audit-outside'), /工作区/);
    await mkdir(join(root, 'state/audit-file'));
    await writeFile(join(root, 'outside/run.json'), '{}'); await symlink(join(root, 'outside/run.json'), join(root, 'state/audit-file/run.json'));
    assert.throws(() => readAuditTerminal(join(root, 'state'), 'audit-file'), /受控目录/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('真实ttyd连接任务tmux：强制只读，缩放不影响原窗口，重连和关闭保留任务', { timeout: 20_000 }, async () => {
  const root = await mkdtemp('/private/tmp/ttyd-tmux-test-'), id = 'audit-tmux-fixture';
  const socket = `owa-ttyd-test-${process.pid}-${Date.now()}`;
  let app, connection, created = false;
  try {
    await execute('tmux', ['-L', socket, 'new-session', '-d', '-x', '120', '-y', '30', '-s', 'audit', '/bin/cat']); created = true;
    await mkdir(join(root, id)); await writeFile(join(root, id, 'run.json'), JSON.stringify({ id, status: 'running', name: '旧任务只读回归', paths: { workspace_root: root }, terminal: { live: true, socket_name: socket, target: 'audit' } }));
    app = await startTerminalMonitor({ port: 0, stateRoot: root });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    connection = await connectTtyd(base, id); assert.equal(connection.terminal.readOnly, true);
    await until(async () => connection.messages.length > 1);
    connection.input('MUST_NOT_ARRIVE\r'); connection.resize(200, 80); await delay(150);
    const { stdout } = await execute('tmux', ['-L', socket, 'capture-pane', '-p', '-t', 'audit']); assert.equal(stdout.includes('MUST_NOT_ARRIVE'), false);
    assert.equal((await execute('tmux', ['-L', socket, 'display-message', '-p', '-t', 'audit', '#{window_width}'])).stdout.trim(), '120');
    const closed = once(connection.ws, 'close'); connection.ws.close(); await closed;
    connection = await connectTtyd(base, id); await until(async () => connection.messages.length > 1);
    await app.close(); await execute('tmux', ['-L', socket, 'has-session', '-t', 'audit']);
  } finally { connection?.ws.terminate(); await app?.close(); if (created) await execute('tmux', ['-L', socket, 'kill-session', '-t', 'audit']); await rm(root, { recursive: true, force: true }); }
});
test('CLI收到SIGTERM退出并释放自有端口', { timeout: 15_000 }, async () => {
  const reservation = http.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [entry], { env: { ...process.env, WORKBENCH_TERMINAL_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let output = ''; child.stdout.on('data', b => output += b); child.stderr.resume();
  try { await until(async () => output.includes(`127.0.0.1:${port}`)); child.kill('SIGTERM'); const [code, signal] = await exited; assert.equal(code, 0); assert.equal(signal, null); }
  finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; } }
});
