import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { waitForInteractiveRelease } from '../../../.opencode/lib/audit-runtime/engines/interactive-lease.mjs';
import { readAuditTerminal } from './audit-terminal-runtime.mjs';
import { ttydAttachCommand } from './ttyd-command.mjs';

export const ttydCommand = () => process.env.WORKBENCH_TTYD_BIN || 'ttyd';
export async function checkTtyd(command = ttydCommand()) {
  try {
    const { stdout } = await promisify(execFile)(command, ['--version'], { timeout: 5000, windowsHide: true });
    if (!/^ttyd(?: version)?\s+1\./.test(stdout.trim())) throw new Error('unsupported');
    return stdout.trim();
  } catch {
    throw new Error('ttyd 未就绪。macOS 请执行 brew install ttyd；其他宿主机请安装 ttyd，或设置 WORKBENCH_TTYD_BIN。');
  }
}

export function createTtydRuntime({ stateRoot, command = ttydCommand(), spawnProcess = spawn, idleMs = 120_000, checkMs = 500,
  prepareGrowTerminal = async target => (await import('../../../.opencode/lib/audit-runtime/engines/grow.mjs')).prepareCheckpointTui({
    sessionHome: target.environment.GROW_HOME, sessionId: target.args[target.args.indexOf('--resume') + 1],
    forkSessionId: target.args[target.args.indexOf('--session-id') + 1], cwd: target.cwd, command: target.command,
  }) } = {}) {
  const workers = new Map(), pending = new Map(), starting = new Set();
  let closed = false;
  const resolve = (id, options) => readAuditTerminal(stateRoot, id, options);
  function release(worker) {
    worker.leaseCleanup ??= (async () => {
      await worker.leaseClaim?.catch(() => {});
      await worker.rolePreparation?.catch(() => {});
      if (worker.ownsLease) {
        const lease = await readFile(worker.target.leasePath, 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (lease?.id === worker.id) await rm(worker.target.leasePath, { force: true });
      }
      workers.delete(worker.id);
    })();
    return worker.leaseCleanup;
  }
  function valid(worker) {
    if (closed || worker.stopped || worker.child.exitCode != null || worker.child.signalCode != null) return false;
    try { return resolve(worker.target.auditId, worker.options).fingerprint === worker.target.fingerprint; } catch { return false; }
  }
  async function stop(worker) {
    if (worker.stopping) return worker.stopping;
    worker.stopped = true;
    for (const connection of worker.connections) connection();
    worker.stopping = new Promise(done => {
      if (!worker.child.pid || worker.child.exitCode !== null || worker.child.signalCode !== null) return done();
      const timer = setTimeout(() => worker.child.kill('SIGKILL'), 3000); timer.unref();
      worker.child.once('exit', () => { clearTimeout(timer); done(); });
      worker.child.kill('SIGTERM');
    }).then(() => release(worker));
    return worker.stopping;
  }
  async function launch(target, options) {
    if (target.leasePath) await waitForInteractiveRelease(target.leasePath, { timeout: 0 }).catch(error => { throw Object.assign(error, { status: 409 }); });
    const attachment = ttydAttachCommand(target);
    const id = randomBytes(12).toString('hex'), basePath = `/t/${id}`;
    const credential = `workbench:${randomBytes(24).toString('hex')}`;
    const args = ['-p', '0', '-i', '127.0.0.1', '-b', basePath, '-c', credential, '-O', '-m', target.kind === 'grow' ? '1' : '8',
      ...(target.kind === 'grow' ? ['-o'] : []),
      '-t', `titleFixed=${target.kind === 'grow' ? 'Grow' : target.kind === 'opencode-v2' ? 'OpenCode v2' : 'OpenCode'} · ttyd`, '-t', 'fontSize=14', '-t', 'disableLeaveAlert=true',
      '-t', 'theme={"background":"#10151c","foreground":"#e1e7ef"}', '-w', attachment.cwd,
      ...(target.readOnly ? [] : ['-W']), '--', attachment.command, ...attachment.args];
    const environment = { ...process.env, ...attachment.environment, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    if (target.kind === 'opencode-v2') delete environment.OPENCODE_DB;
    const child = spawnProcess(command, args, { cwd: attachment.cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const worker = { id, basePath, target, options, child, credential, port: null, connections: new Set(), touched: Date.now(), stopped: false };
    let diagnostic = '';
    child.stderr.on('data', bytes => {
      // Keep only fixed diagnostics; ttyd logs command arguments and its
      // credentials, which must never be exposed by the public API.
      diagnostic = (diagnostic + bytes.toString()).slice(-4096);
      if (/CreatePseudoConsole|conpty_init|conpty_setup/.test(diagnostic)) worker.failure = 'Windows 伪终端创建失败，请确认使用 Windows 10 1809 或更新系统及原生 ttyd。';
      else if (/CreateProcessW|pty_spawn:/.test(diagnostic)) worker.failure = 'ttyd 无法启动交互客户端，请检查 PowerShell、所选 Agent 安装及工作目录。';
    });
    starting.add(worker);
    // ttyd logs its local ephemeral port. Never log child command or credentials.
    try {
      await new Promise((done, fail) => {
        let output = '';
        const timer = setTimeout(() => finish(new Error('ttyd 启动超时。')), 10_000);
        const onExit = () => finish(Object.assign(new Error(worker.failure || 'ttyd 在终端就绪前退出，请检查原生 ttyd 安装。'), { status: 503 }));
        const onError = () => finish(Object.assign(new Error('无法启动 ttyd，请检查安装及 WORKBENCH_TTYD_BIN。'), { status: 503 }));
        function finish(error) {
          clearTimeout(timer); child.off('exit', onExit); child.off('error', onError); child.stderr.off('data', onData);
          error ? fail(error) : done();
        }
        function onData(bytes) {
          output = (output + bytes.toString()).slice(-4096);
          const port = /Listening on port:\s*(\d+)/.exec(output)?.[1];
          if (port) { worker.port = Number(port); finish(); }
        }
        child.stderr.on('data', onData); child.once('exit', onExit); child.once('error', onError);
      });
      child.stdout.resume(); child.stderr.resume(); child.on('error', () => {});
      child.once('exit', () => { worker.stopped = true; for (const close of worker.connections) close(); void release(worker).catch(() => {}); });
      if (!valid(worker)) throw Object.assign(new Error('任务状态已改变，请从工作台重新打开终端。'), { status: 409 });
      if (target.leasePath) {
        worker.leaseClaim = writeFile(target.leasePath, JSON.stringify({ pid: child.pid, generation: target.generation, id }), { flag: 'wx', mode: 0o600 })
          .then(() => { worker.ownsLease = true; });
        await worker.leaseClaim;
        if (!valid(worker)) throw Object.assign(new Error('任务已恢复或终端已退出，请重新打开终端。'), { status: 409 });
        // No browser has the credential/link yet. Prepare project role discovery
        // only while holding the lease that blocks a concurrent managed resume.
        worker.rolePreparation = Promise.resolve().then(() => {
          if (!valid(worker)) throw Object.assign(new Error('任务已恢复或终端已退出，请重新打开终端。'), { status: 409 });
          return prepareGrowTerminal(target);
        });
        await worker.rolePreparation;
        if (!valid(worker)) throw Object.assign(new Error('任务已恢复，请关闭交互终端。'), { status: 409 });
      }
      workers.set(id, worker);
      return worker;
    } catch (error) { await stop(worker); throw error; }
    finally { starting.delete(worker); }
  }
  async function open(auditId, options = {}) {
    if (closed) throw Object.assign(new Error('终端服务正在关闭。'), { status: 503 });
    const target = resolve(auditId, options);
    const existing = [...workers.values()].find(worker => worker.target.fingerprint === target.fingerprint);
    if (existing && valid(existing) && !existing.failure) { existing.touched = Date.now(); return existing; }
    if (existing?.failure) await stop(existing);
    if (target.kind === 'grow' && [...workers.values()].some(worker => worker.target.auditId === auditId)) throw Object.assign(new Error('该 Grow 会话已打开交互终端，请先关闭原窗口。'), { status: 409 });
    const key = target.kind === 'grow' ? `grow:${auditId}` : target.fingerprint;
    if (pending.has(key)) {
      const worker = await pending.get(key);
      if (worker.target.fingerprint !== target.fingerprint) throw Object.assign(new Error('该会话正在打开另一终端，请先关闭原窗口。'), { status: 409 });
      return worker;
    }
    if (workers.size + pending.size >= 32) throw Object.assign(new Error('当前终端连接过多，请关闭空闲终端后重试。'), { status: 429 });
    const operation = launch(target, { generation: target.generation, readOnly: target.readOnly });
    pending.set(key, operation);
    try { return await operation; } finally { pending.delete(key); }
  }
  function get(id) {
    const worker = workers.get(id);
    if (!worker || !valid(worker)) throw Object.assign(new Error('终端连接已过期；请重新连接或从工作台恢复任务。'), { status: 409 });
    if (worker.failure) throw Object.assign(new Error(worker.failure), { status: 503 });
    worker.touched = Date.now(); return worker;
  }
  const interval = setInterval(() => {
    for (const worker of workers.values()) if (!valid(worker) || (!worker.connections.size && Date.now() - worker.touched > idleMs)) void stop(worker);
  }, checkMs); interval.unref();
  return { resolve, open, get, valid,
    status: () => ({ workers: workers.size, connections: [...workers.values()].reduce((n, w) => n + w.connections.size, 0) }),
    async close() {
      closed = true; clearInterval(interval);
      await Promise.all([...workers.values(), ...starting].map(stop));
      await Promise.allSettled([...pending.values()]);
    },
  };
}
