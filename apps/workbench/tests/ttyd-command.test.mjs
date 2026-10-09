import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { ttydAttachCommand } from '../scripts/ttyd-command.mjs';
import { ttydCommand } from '../scripts/ttyd-runtime.mjs';

const launcher = fileURLToPath(new URL('../scripts/ttyd-attach-launch.cjs', import.meta.url));
const { launchAttach } = createRequire(import.meta.url)(launcher);
const target = { command: 'C:\\Users\\测试 用户\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\node_modules\\opencode-windows-x64\\bin\\opencode.exe',
  args: ['attach', 'http://127.0.0.1:52784', '--session', `ses_${'a'.repeat(40)}`, '--dir', `D:\\项目 (工作区)&验证\\${'long-directory\\'.repeat(12)}`],
  cwd: 'D:\\项目 (工作区)&验证', environment: { OPENCODE_SERVER_PASSWORD: 'private-fixture' } };

test('Windows 通过 PowerShell 启动附加客户端，长路径和会话仍通过环境传递', () => {
  assert.ok(Buffer.byteLength([target.command, ...target.args].join(' ')) > 256);
  const launch = ttydAttachCommand(target, { platform: 'win32', systemRoot: 'C:\\Windows', executable: 'C:\\Program Files\\nodejs\\node.exe', launcherPath: 'D:\\平台 目录\\ttyd-attach-launch.cjs' });
  assert.ok(Buffer.byteLength([launch.command, ...launch.args].join(' ')) < 240);
  assert.equal(launch.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(launch.cwd, target.cwd);
  assert.deepEqual(launch.args.slice(0, 3), ['-NoLogo', '-NoProfile', '-Command']);
  assert.ok(!launch.args.includes('-NoExit'));
  assert.match(launch.args[3], /exit \$LASTEXITCODE$/);
  assert.equal(launch.environment.JAVELIN_TTYD_NODE, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(launch.environment.OPENCODE_SERVER_PASSWORD, 'private-fixture');
  let called;
  launchAttach(launch.environment, (...args) => { called = args; });
  assert.equal(called[0], target.command); assert.deepEqual(called[1], target.args);
  assert.equal(called[2].cwd, target.cwd); assert.equal(called[2].stdio, 'inherit');
  assert.equal(called[2].shell, false); assert.equal(called[2].windowsHide, false);
  assert.equal(called[2].env.JAVELIN_TTYD_ATTACH, undefined);
  assert.equal(called[2].env.JAVELIN_TTYD_LAUNCHER, undefined);
  assert.equal(called[2].env.JAVELIN_TTYD_NODE, undefined);
});

test('Windows 系统目录含空格时保留引号，过长或无效路径明确报错', () => {
  const launch = ttydAttachCommand(target, { platform: 'win32', systemRoot: 'C:\\Windows System' });
  assert.equal(launch.command, '"C:\\Windows System\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"');
  for (const systemRoot of ['relative', 'C:\\bad"root', 'C:\\' + 'long'.repeat(80)]) {
    assert.throws(() => ttydAttachCommand(target, { platform: 'win32', systemRoot }), { status: 503 });
  }
});

test('macOS/Linux 继续直接附加 OpenCode，不使用 Windows 启动器', () => {
  for (const platform of ['darwin', 'linux']) assert.deepEqual(ttydAttachCommand(target, { platform }), {
    command: target.command, args: target.args, cwd: target.cwd, environment: target.environment,
  });
});

// Runs on a host with ttyd installed, including Windows. This exercises the
// actual inherited PTY, UTF-8 input and resize, without a model or an audit.
test('真实 ttyd → 平台启动器 → 客户端保留 TTY、中文输入、窗口尺寸和长参数', { timeout: 15000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ttyd-attach-')));
  const cwd = join(root, '中文 目录 (PTY)&test'); await mkdir(cwd);
  const script = join(cwd, 'client.cjs'), marker = `长路径参数 '" $(Write-Error unexpected) & ; ${'1234567890'.repeat(40)}`;
  await writeFile(script, `const assert = require('node:assert/strict');
assert.equal(process.argv[2], ${JSON.stringify(marker)});
assert.equal(process.cwd(), ${JSON.stringify(cwd)});
assert.equal(process.stdin.isTTY, true); assert.equal(process.stdout.isTTY, true);
assert.equal(process.env.JAVELIN_TTYD_ATTACH, undefined);
assert.equal(process.env.JAVELIN_TTYD_NODE, undefined);
process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');
process.stdin.on('data', data => { process.stdout.write('INPUT:' + data); if(data.includes('quit')) process.exit(0); });
process.stdout.on('resize', () => process.stdout.write('SIZE:' + process.stdout.columns + 'x' + process.stdout.rows));
process.stdout.write('TTY_READY');`);
  const executableTarget = { command: process.execPath, args: [script, marker], cwd, environment: {} };
  // Exercise the same bootstrap on POSIX, where Windows path resolution isn't available.
  const launch = process.platform === 'win32' ? ttydAttachCommand(executableTarget) : {
    command: process.execPath, args: ['-e', 'require(process.env.JAVELIN_TTYD_LAUNCHER)'], cwd,
    environment: { JAVELIN_TTYD_LAUNCHER: launcher, JAVELIN_TTYD_ATTACH: JSON.stringify(executableTarget) },
  };
  const child = spawn(ttydCommand(), ['-p', '0', '-i', '127.0.0.1', '-W', '-w', launch.cwd, '--', launch.command, ...launch.args], {
    cwd: launch.cwd, env: { ...process.env, ...launch.environment, TERM: 'xterm-256color' }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ws;
  try {
    const port = await new Promise((resolve, reject) => {
      let log = ''; child.once('error', reject); child.once('exit', () => reject(new Error('ttyd 未就绪便退出')));
      child.stderr.on('data', chunk => { log += chunk; const found = /Listening on port:\s*(\d+)/.exec(log); if(found) resolve(found[1]); });
    });
    const origin = `http://127.0.0.1:${port}`, token = await (await fetch(`${origin}/token`)).json();
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, 'tty', { origin });
    let output = ''; ws.on('error', () => {}); ws.on('message', data => { const text = data.toString(); if (text[0] === '0') output += text.slice(1); });
    await once(ws, 'open'); ws.send(JSON.stringify({ AuthToken: token.token, columns: 120, rows: 30 }));
    async function expect(text) { const end = Date.now() + 3500; while (!output.includes(text) && Date.now() < end) await delay(25); assert.ok(output.includes(text), `缺少 ${text}: ${output}`); }
    await expect('TTY_READY'); ws.send('0中文终端输入'); await expect('INPUT:中文终端输入');
    ws.send(`1${JSON.stringify({ columns: 100, rows: 35 })}`); await expect('SIZE:100x35');
    const closed = once(ws, 'close'); ws.send('0quit'); await closed;
  } finally {
    ws?.terminate();
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});
