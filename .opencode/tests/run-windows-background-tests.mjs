import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { EnvironmentHealthService } from '../web/dynamic-validation-observatory/environment-health.mjs';
import { OpenCodeProcessMonitor } from '../web/dynamic-validation-observatory/opencode-process-monitor.mjs';
import { AuditRunner } from '../web/dynamic-validation-observatory/audit-runner.mjs';
import { ensureAuditService, SERVICE_PROTOCOL } from '../lib/audit-runtime/service-process.mjs';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'windows-background-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('Windows 环境探测隐藏控制台；并发强制刷新共用同一批进程，缓存读取不启动进程', async t => {
  const root = await temporary(t), calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const health = new EnvironmentHealthService({ projectRoot: root, platform: 'win32', architecture: 'x64', environment: {},
    resolveCommand: async command => command,
    execute: async (command, args, options) => { calls.push({ command, args, options }); await gate; return { stdout: 'fixture 1.0.0', stderr: '' }; } });
  const first = health.snapshot({ force: true });
  const duplicate = health.snapshot({ force: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.length > 3);
  assert.ok(calls.every(call => call.options.windowsHide === true));
  assert.ok(calls.every(call => !/chrome|psmux|tmux|openconsole/i.test(call.command)));
  release();
  assert.strictEqual(await first, await duplicate);
  assert.ok(calls.every(call => call.options.windowsHide === true));
  const count = calls.length;
  await health.snapshot(); assert.equal(calls.length, count);
});

test('Windows 默认执行器只探测 OpenCode，完全不探测 tmux/psmux', async t => {
  const root = await temporary(t), calls = [];
  const monitor = new OpenCodeProcessMonitor({ stateRoot: root, platform: 'win32', environment: {},
    resolveCommand: async command => /opencode/i.test(command) ? 'C:\\tools\\opencode.exe' : null,
    execute: async (command, args, options) => { calls.push({ command, args, options }); return { stdout: '--format --session --attach', stderr: '' }; } });
  assert.equal((await monitor.probe()).backend, 'opencode-process');
  await monitor.probe();
  assert.equal(calls.length, 1); assert.equal(calls[0].options.windowsHide, true);
  assert.ok(calls.every(call => !/tmux|psmux|openconsole/i.test(call.command)));
});

test('加载 55 个已完成历史任务并刷新列表、运行 watchdog 不重新启动 Agent 或轮询终端', async t => {
  const root = await temporary(t), stateRoot = join(root, 'runs');
  await mkdir(stateRoot);
  await Promise.all(Array.from({ length: 55 }, async (_, i) => {
    const id = `audit-history-${i}`, directory = join(stateRoot, id); await mkdir(directory);
    await writeFile(join(directory, 'run.json'), JSON.stringify({ id, name: id, status: 'completed', created_at: '2026-10-01T00:00:00Z',
      terminal: { supported: true, live: false, status: 'archived', socket_name: 'owa-0123456789abcdef', target: 'audit:tui' } }));
    await writeFile(join(directory, 'terminal.txt'), '已归档输出');
  }));
  let launches = 0, probes = 0;
  const runner = new AuditRunner({ stateRoot, platformRoot: root, enabled: true,
    spawnProcess() { launches++; throw new Error('历史任务不能启动 Agent'); },
    terminalMonitor: { async targetLive() { probes++; return false; }, async capture() { probes++; return ''; } } });
  t.after(() => runner.shutdown());
  await runner.ready;
  assert.equal((await runner.listAuditsWithTodo()).length, 55);
  await runner.runCompletionWatchdog(); await runner.reconcileTerminalCompletions();
  for (const audit of runner.listAudits()) assert.equal((await runner.terminalSnapshot(audit.id)).output, '已归档输出');
  assert.equal(launches, 0); assert.equal(probes, 0);
});

test('独立执行服务以隐藏控制台方式启动；轮询就绪不重复创建服务进程', async t => {
  const root = await temporary(t); let reads = 0, starts = 0;
  const result = await ensureAuditService({ serviceRoot: root,
    fetcher: async () => {
      if (++reads === 1) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      return { ok: true, json: async () => ({ service: 'opencode-audit-workbench', runtime_service: { protocol: SERVICE_PROTOCOL, ready: true } }) };
    },
    spawnProcess(command, args, options) {
      starts++; assert.equal(command, process.execPath); assert.equal(args[args.indexOf('--port') + 1], '4183');
      assert.equal(options.windowsHide, true); assert.equal(options.detached, true); assert.equal(options.shell, false);
      const child = new EventEmitter(); child.unref = () => {}; return child;
    } });
  assert.equal(result.started, true); assert.equal(starts, 1); assert.equal(reads, 2);
});

for (const [method, reason, recoveryKey, schedule] of [
  ['forceOperationTimeoutInterruption', 'operation-timed-out', 'timeout_recovery', 'scheduleOperationTimeoutRecovery'],
  ['forceContextWindowInterruption', 'context-window-exceeded', 'context_window_recovery', 'scheduleContextWindowRecovery'],
]) {
  test(`watchdog 强制收尾清理无 socket 的共享进程：${method}`, async t => {
    const root = await temporary(t), stopped = [], signals = [], recoveries = [];
    const runner = new AuditRunner({ stateRoot: join(root, 'runs'), platformRoot: root, enabled: false,
      terminalMonitor: { async stop(terminal) { stopped.push(terminal); } } });
    t.after(() => runner.shutdown()); await runner.ready;
    const id = 'audit-forced-process', audit = { id, status: 'running', version: 1, interruption_reason: reason,
      [recoveryKey]: { attempts: 1, state: 'waiting-for-runner-close' },
      terminal: { supported: true, live: true, backend: 'opencode-process' } };
    const child = { kill(signal) { signals.push(signal); } };
    runner.audits.set(id, audit); runner.processes.set(id, child);
    runner[schedule] = value => recoveries.push(value.id);
    assert.equal(await runner[method](id, child, 1), true);
    assert.deepEqual(signals, ['SIGKILL']); assert.equal(stopped.length, 1);
    assert.equal(audit.terminal.live, false); assert.equal(audit.terminal.status, 'closed');
    assert.equal(runner.health().active_processes, 0); assert.deepEqual(recoveries, [id]);
  });
}
