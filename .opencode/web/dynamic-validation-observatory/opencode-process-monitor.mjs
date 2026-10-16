import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform as osPlatform, arch } from 'node:os';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolvedOpenCodeExecutables } from './executable-resolution.mjs';

const launcher = fileURLToPath(new URL('./opencode-process-launcher.mjs', import.meta.url));
const alive = child => child.exitCode == null && child.signalCode == null;

// Owns a plain hidden Node supervisor, with OpenCode serve/run as its children.
// ttyd only creates an attach client when the user opens the terminal page.
export class OpenCodeProcessMonitor {
  constructor({ stateRoot, command = 'opencode', engine = 'opencode', environment = process.env, platform = osPlatform(), architecture = arch(),
    execute = promisify(execFile), resolveCommand, spawnProcess = spawn } = {}) {
    Object.assign(this, { stateRoot, command, engine, environment, platform, architecture, execute, resolveCommand, spawnProcess });
    this.runs = new Map(); this.specs = new Map(); this.probeResult = null;
  }
  async probe() {
    if (this.probeResult) return this.probeResult;
    if (this.engine !== 'opencode') return this.probeResult = { available: true, shared_server: this.engine === 'opencode-v2',
      backend: 'agent-process', opencode_command: this.command,
      message: this.engine === 'grow' ? 'Grow JSON 监控已就绪；暂停或结束后可打开交互终端。' : 'OpenCode v2 共享会话已就绪。' };
    const candidates = await resolvedOpenCodeExecutables(this);
    for (const command of candidates) {
      try {
        const result = await this.execute(command, ['run', '--help'], { env: this.environment, timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true });
        const help = `${result.stdout}\n${result.stderr}`;
        if (!['--format', '--session', '--attach'].every(flag => help.includes(flag))) continue;
        this.command = command;
        return this.probeResult = { available: true, shared_server: true, backend: 'opencode-process', opencode_command: command, message: 'OpenCode 共享会话已就绪；交互窗口由 ttyd 按需连接。' };
      } catch { /* Try the next configured executable. */ }
    }
    return this.probeResult = { available: false, backend: 'opencode-process', message: 'OpenCode CLI 未就绪或不支持 run --attach；JSON 审计仍可使用普通 Runner，交互终端暂不可用。' };
  }
  directory(terminal) {
    const directory = resolve(terminal?.state_directory || '');
    if (!['opencode-process', 'agent-process'].includes(terminal?.backend) || dirname(directory) !== resolve(this.stateRoot)) throw new Error('任务执行目录不匹配。');
    return directory;
  }
  async start({ audit, environment, executionDirectory, repository, providerSessionId = null, args }) {
    if (!/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(audit.id) || !Array.isArray(args) || (this.engine === 'opencode' && args[0] !== 'run')) throw new Error('审计执行参数无效。');
    const directory = join(this.stateRoot, audit.id), cwd = executionDirectory || repository.path;
    await mkdir(directory, { recursive: true });
    const terminal = { backend: this.engine === 'opencode' ? 'opencode-process' : 'agent-process', engine: this.engine,
      transport: this.engine === 'grow' ? 'grow-run' : `${this.engine}-run+shared-server`, supported: true, shared_server: this.engine !== 'grow',
      live: true, status: 'starting', state_directory: directory, provider_session_id: providerSessionId,
      output_path: join(directory, 'opencode-run.jsonl'), exit_path: join(directory, 'opencode-run-exit.json'),
      message: this.engine === 'grow' ? 'Grow 正在执行；JSON 事件自动更新，暂停或结束后可在 ttyd 恢复会话。' : 'Agent 正在启动共享会话；JSON 事件自动更新，交互终端由 ttyd 按需打开。' };
    await Promise.all([rm(terminal.output_path, { force: true }), rm(terminal.exit_path, { force: true })]);
    const path = join(directory, 'opencode-process-run.json');
    await writeFile(path, JSON.stringify({ engine: this.engine, command: this.command, args, cwd, state_directory: directory, audit_id: audit.id,
      diagnostic_path: terminal.output_path, exit_path: terminal.exit_path }), { mode: 0o600 });
    if (this.engine === 'grow') await writeFile(join(directory, 'agent-terminal.json'), JSON.stringify({ engine: this.engine,
      audit_id: audit.id, generation: audit.execution.generation, command: this.command, cwd,
      environment: { GROW_HOME: environment.GROW_HOME } }), { mode: 0o600 });
    this.specs.set(directory, { path, cwd, environment });
    return terminal;
  }
  launch(terminal) {
    const directory = this.directory(terminal), spec = this.specs.get(directory);
    if (!spec || this.runs.has(directory)) throw new Error('任务执行配置缺失或已经启动。');
    this.specs.delete(directory);
    const child = this.spawnProcess(process.execPath, [launcher, spec.path], { cwd: spec.cwd, env: spec.environment,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], shell: false, windowsHide: true });
    const nativeKill = child.kill.bind(child), requests = new Map(), children = new Set();
    let killTimer;
    const send = action => new Promise((resolve, reject) => {
      if (!alive(child)) return action === 'stop' ? resolve() : reject(new Error('任务进程已经结束。'));
      if (!child.connected) return reject(new Error('执行控制通道不可用。'));
      const id = randomUUID(), timer = setTimeout(() => { requests.delete(id); reject(new Error('执行控制响应超时。')); }, 10000);
      requests.set(id, { resolve, reject, timer });
      child.send({ type: 'audit-control', id, action }, error => { if (error) { clearTimeout(timer); requests.delete(id); reject(error); } });
    });
    const force = () => {
      // These PIDs arrive only over our supervisor's private IPC channel, never from task output.
      for (const pid of children) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      if (alive(child)) nativeKill('SIGKILL');
    };
    const stop = () => {
      if (!alive(child)) return false;
      if (!killTimer) { killTimer = setTimeout(force, 12000); killTimer.unref(); void send('stop').catch(force); }
      return true;
    };
    child.kill = signal => {
      if (signal === 'SIGSTOP' || signal === 'SIGCONT') return alive(child); // signalRun awaits the IPC acknowledgement.
      if (signal === 'SIGKILL') { force(); return true; }
      return stop();
    };
    child.on('message', message => {
      if (message?.type === 'audit-child' && Number.isSafeInteger(message.pid) && message.pid > 1) {
        message.active ? children.add(message.pid) : children.delete(message.pid); return;
      }
      const pending = requests.get(message?.id); if (!pending || message.type !== 'audit-control-result') return;
      requests.delete(message.id); clearTimeout(pending.timer);
      message.error ? pending.reject(new Error(message.error)) : pending.resolve();
    });
    child.once('close', () => {
      clearTimeout(killTimer); this.runs.delete(directory); children.clear();
      for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('任务进程已结束。')); }
      requests.clear();
    });
    this.runs.set(directory, { child, send, stop });
    return child;
  }
  // Archived legacy tasks are read from disk. Never probe or launch psmux/tmux.
  async capture(terminal, lines = 400) {
    const path = ['opencode-process', 'agent-process'].includes(terminal?.backend) ? join(this.directory(terminal), 'opencode-run.jsonl') : terminal?.output_path;
    if (!path) return '';
    return (await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).split(/\r?\n/).slice(-lines).join('\n');
  }
  async signalRun(terminal, signal) {
    const run = this.runs.get(this.directory(terminal));
    if (!run || !['SIGSTOP', 'SIGCONT'].includes(signal)) throw new Error('任务控制会话不可用。');
    await run.send(signal === 'SIGSTOP' ? 'pause' : 'resume');
  }
  async abort(terminal) { if (['opencode-process', 'agent-process'].includes(terminal?.backend)) this.runs.get(this.directory(terminal))?.stop(); }
  async stop(terminal) {
    if (!['opencode-process', 'agent-process'].includes(terminal?.backend)) return;
    const directory = this.directory(terminal); this.specs.delete(directory);
    const run = this.runs.get(directory); if (!run || !alive(run.child)) return;
    const closed = new Promise(resolve => run.child.once('close', resolve)); run.stop(); await closed;
  }
}
