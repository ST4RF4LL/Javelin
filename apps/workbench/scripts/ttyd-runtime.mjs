import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { readAuditTerminal } from './audit-terminal-runtime.mjs';

export const ttydCommand = () => process.env.WORKBENCH_TTYD_BIN || 'ttyd';
export async function checkTtyd(command = ttydCommand()) {
  try {
    const { stdout } = await promisify(execFile)(command, ['--version'], { timeout: 5000 });
    if (!/^ttyd(?: version)?\s+1\./.test(stdout.trim())) throw new Error('unsupported');
    return stdout.trim();
  } catch {
    throw new Error('ttyd 未就绪。macOS 请执行 brew install ttyd；其他宿主机请安装 ttyd，或设置 WORKBENCH_TTYD_BIN。');
  }
}

export function createTtydRuntime({ stateRoot, command = ttydCommand(), spawnProcess = spawn, idleMs = 120_000, checkMs = 500, tmuxCommand } = {}) {
  const workers = new Map(), pending = new Map(), starting = new Set();
  let closed = false;
  const resolve = (id, options) => readAuditTerminal(stateRoot, id, { ...options, tmuxCommand });
  function valid(worker) {
    if (closed || worker.stopped) return false;
    try { return resolve(worker.target.auditId, worker.options).fingerprint === worker.target.fingerprint; } catch { return false; }
  }
  async function stop(worker) {
    if (worker.stopping) return worker.stopping;
    worker.stopped = true; workers.delete(worker.id);
    for (const connection of worker.connections) connection();
    worker.stopping = new Promise(done => {
      if (!worker.child.pid || worker.child.exitCode !== null || worker.child.signalCode !== null) return done();
      const timer = setTimeout(() => worker.child.kill('SIGKILL'), 3000); timer.unref();
      worker.child.once('exit', () => { clearTimeout(timer); done(); });
      worker.child.kill('SIGTERM');
    });
    return worker.stopping;
  }
  async function launch(target, options) {
    const id = randomBytes(12).toString('hex'), basePath = `/t/${id}`;
    const credential = `workbench:${randomBytes(24).toString('hex')}`;
    let initialSize;
    if (target.kind === 'tmux') {
      const { stdout } = await promisify(execFile)(target.command, ['-L', target.args[1], 'display-message', '-p', '-t', target.args.at(-1), '#{window_width} #{window_height}'], { timeout: 3000 });
      const [columns, rows] = stdout.trim().split(/\s+/).map(Number);
      if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1) throw new Error('无法读取旧任务的终端尺寸。');
      initialSize = { columns, rows };
    }
    const args = ['-p', '0', '-i', '127.0.0.1', '-b', basePath, '-c', credential, '-O', '-m', '8',
      '-t', 'titleFixed=OpenCode · ttyd', '-t', 'fontSize=14', '-t', 'disableLeaveAlert=true',
      '-t', 'theme={"background":"#10151c","foreground":"#e1e7ef"}', '-w', target.cwd,
      ...(target.readOnly ? [] : ['-W']), target.command, ...target.args];
    const child = spawnProcess(command, args, { cwd: target.cwd,
      env: { ...process.env, ...target.environment, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    const worker = { id, basePath, target, options, child, credential, port: null, connections: new Set(), initialSize, touched: Date.now(), stopped: false };
    starting.add(worker);
    // ttyd logs its local ephemeral port. Never log child command or credentials.
    try {
      await new Promise((done, fail) => {
        let output = '';
        const timer = setTimeout(() => finish(new Error('ttyd 启动超时。')), 10_000);
        const onExit = () => finish(new Error('ttyd 在终端就绪前退出。'));
        const onError = () => finish(new Error('无法启动 ttyd，请检查安装及 WORKBENCH_TTYD_BIN。'));
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
      child.once('exit', () => { worker.stopped = true; workers.delete(id); for (const close of worker.connections) close(); });
      if (!valid(worker)) throw Object.assign(new Error('任务状态已改变，请从工作台重新打开终端。'), { status: 409 });
      workers.set(id, worker);
      return worker;
    } catch (error) { await stop(worker); throw error; }
    finally { starting.delete(worker); }
  }
  async function open(auditId, options = {}) {
    if (closed) throw Object.assign(new Error('终端服务正在关闭。'), { status: 503 });
    const target = resolve(auditId, options);
    const existing = [...workers.values()].find(worker => worker.target.fingerprint === target.fingerprint);
    if (existing && valid(existing)) { existing.touched = Date.now(); return existing; }
    const key = target.fingerprint;
    if (pending.has(key)) return pending.get(key);
    if (workers.size + pending.size >= 32) throw Object.assign(new Error('当前终端连接过多，请关闭空闲终端后重试。'), { status: 429 });
    const operation = launch(target, { generation: target.generation, readOnly: target.readOnly });
    pending.set(key, operation);
    try { return await operation; } finally { pending.delete(key); }
  }
  function get(id) {
    const worker = workers.get(id);
    if (!worker || !valid(worker)) throw Object.assign(new Error('终端连接已过期；请重新连接或从工作台恢复任务。'), { status: 409 });
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
