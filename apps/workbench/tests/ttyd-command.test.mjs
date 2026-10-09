import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { ttydAttachCommand } from '../scripts/ttyd-command.mjs';
import { ttydCommand } from '../scripts/ttyd-runtime.mjs';

const target = { command: 'C:\\Users\\测试 用户\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\node_modules\\opencode-windows-x64\\bin\\opencode.exe',
  args: ['attach', 'http://127.0.0.1:52784', '--session', `ses_${'a'.repeat(40)}`, '--dir', `D:\\项目 (工作区)&验证\\${'long-directory\\'.repeat(12)}`],
  cwd: 'D:\\项目 (工作区)&验证', environment: { OPENCODE_SERVER_PASSWORD: 'private-fixture' } };

test('Windows 直接执行 opencode attach，session 可见且工作区长路径不进入命令', () => {
  assert.ok(Buffer.byteLength([target.command, ...target.args].join(' ')) > 256);
  const launch = ttydAttachCommand(target, { platform: 'win32', systemRoot: 'C:\\Windows' });
  assert.ok(Buffer.byteLength([launch.command, ...launch.args].join(' ')) < 240);
  assert.equal(launch.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(launch.cwd, target.cwd);
  assert.deepEqual(launch.args.slice(0, 3), ['-NoLogo', '-NoProfile', '-Command']);
  assert.ok(!launch.args.includes('-NoExit'));
  assert.equal(launch.args[3], `opencode attach ${target.args[1]} --session ${target.args[3]} --dir .`);
  assert.deepEqual(launch.environment, target.environment);
});

test('Windows 系统目录含空格时保留引号', () => {
  const launch = ttydAttachCommand(target, { platform: 'win32', systemRoot: 'C:\\Windows System' });
  assert.equal(launch.command, '"C:\\Windows System\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"');
});

test('macOS/Linux 继续直接附加 OpenCode，不使用 Windows 启动器', () => {
  for (const platform of ['darwin', 'linux']) assert.deepEqual(ttydAttachCommand(target, { platform }), {
    command: target.command, args: target.args, cwd: target.cwd, environment: target.environment,
  });
});

// Runs on a host with ttyd installed, including Windows. This exercises the
// actual inherited PTY, UTF-8 input and resize, without a model or an audit.
test('真实 ttyd 保留客户端 TTY、中文输入、窗口尺寸和退出行为', { timeout: 15000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ttyd-attach-')));
  const cwd = join(root, '中文 目录 (PTY)&test'); await mkdir(cwd);
  const script = join(cwd, 'client.cjs');
  const viaPowerShell = process.platform === 'win32' || !!process.env.WORKBENCH_TEST_POWERSHELL;
  const expectedArgs = ['attach', 'http://127.0.0.1:52784', '--session', 'ses_tty_fixture', '--dir', viaPowerShell ? '.' : cwd];
  await writeFile(script, `const assert = require('node:assert/strict');
assert.deepEqual(process.argv.slice(2), ${JSON.stringify(expectedArgs)});
assert.equal(process.cwd(), ${JSON.stringify(cwd)});
assert.equal(process.stdin.isTTY, true); assert.equal(process.stdout.isTTY, true);
process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');
process.stdin.on('data', data => { process.stdout.write('INPUT:' + data); if(data.includes('quit')) process.exit(0); });
process.stdout.on('resize', () => process.stdout.write('SIZE:' + process.stdout.columns + 'x' + process.stdout.rows));
process.stdout.write('TTY_READY');`);
  // The fixture stands in for opencode and checks the argv actually delivered
  // by PowerShell, including session selection and inherited console handles.
  let launch;
  if (viaPowerShell) {
    const shim = join(root, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
    await writeFile(shim, process.platform === 'win32'
      ? '@echo off\r\n"%WORKBENCH_TEST_NODE%" "%WORKBENCH_TEST_CLIENT%" %*\r\n'
      : '#!/bin/sh\nexec "$WORKBENCH_TEST_NODE" "$WORKBENCH_TEST_CLIENT" "$@"\n');
    await chmod(shim, 0o755);
    launch = ttydAttachCommand({ ...target, cwd, args: expectedArgs,
      environment: { PATH: `${root}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`, WORKBENCH_TEST_NODE: process.execPath, WORKBENCH_TEST_CLIENT: script } }, { platform: 'win32' });
    if (process.platform !== 'win32') launch.command = process.env.WORKBENCH_TEST_POWERSHELL;
  } else launch = ttydAttachCommand({ command: process.execPath, args: [script, ...expectedArgs], cwd, environment: {} });
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
