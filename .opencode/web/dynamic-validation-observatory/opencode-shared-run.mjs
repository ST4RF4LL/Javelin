import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const SHARED_CONNECTION_FILE = 'opencode-server.json';
// Match non-interactive `opencode run` session creation: attaching a TUI must
// not introduce questions or plan-mode gates into the existing audit workflow.
export const RUN_PERMISSIONS = ['question', 'plan_enter', 'plan_exit'].map(permission => ({ permission, action: 'deny', pattern: '*' }));

// Both children belong to the launcher's owned tree. The monitor controls this
// tree, including the server that actually executes the audit.
export async function startSharedRun(spec, { environment, output, spawnProcess = spawn }) {
  const connectionPath = join(spec.state_directory, SHARED_CONNECTION_FILE);
  const generation = randomUUID();
  const password = randomBytes(32).toString('hex');
  const env = { ...environment, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password };
  let server, runner, stopping, readyTimer;
  const children = new Set();
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      clearTimeout(readyTimer);
      await rm(connectionPath, { force: true });
      await Promise.all([...children].map(child => new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const timer = setTimeout(() => child.kill('SIGKILL'), 2500);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      })));
    })();
    return stopping;
  }
  const onSignal = () => { void stop(); };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, onSignal);
  const start = args => {
    if (stopping) throw new Error('任务启动已取消。');
    const child = spawnProcess(spec.command, args, { cwd: spec.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    children.add(child);
    return child;
  };
  try {
    await rm(connectionPath, { force: true });
    server = start(['serve', '--hostname', '127.0.0.1', '--port', '0']);
    const url = await new Promise((resolve, reject) => {
      let buffer = '';
      readyTimer = setTimeout(() => reject(new Error('OpenCode 服务启动超时。')), 30_000);
      const failed = () => reject(new Error('OpenCode 服务在就绪前退出。'));
      server.once('error', failed); server.once('close', failed);
      server.stderr.on('data', () => {}); // Never copy server credentials/configuration into the public log.
      server.stdout.on('data', chunk => {
        buffer = (buffer + chunk).slice(-8192);
        const match = buffer.match(/opencode server listening on (http:\/\/127\.0\.0\.1:(\d+))/);
        if (match && Number(match[2]) > 0 && Number(match[2]) <= 65535) { clearTimeout(readyTimer); resolve(match[1]); }
      });
    });
    const request = async (path, options = {}) => {
      const response = await fetch(`${url}${path}${path.includes('?') ? '&' : '?'}directory=${encodeURIComponent(spec.cwd)}`, {
        ...options, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
      if (!response.ok) throw new Error(`OpenCode 会话连接失败（HTTP ${response.status}）。`);
      return response.json();
    };
    const args = [...spec.args];
    const sessionIndex = args.indexOf('--session');
    const requestedId = sessionIndex >= 0 ? args[sessionIndex + 1] : null;
    const titleIndex = args.indexOf('--title');
    const session = requestedId
      ? await request(`/session/${encodeURIComponent(requestedId)}`)
      : await request('/session', { method: 'POST', body: JSON.stringify({ title: titleIndex >= 0 ? args[titleIndex + 1] : spec.audit_id, permission: RUN_PERMISSIONS }) });
    if (!/^ses_[A-Za-z0-9_-]+$/.test(session?.id ?? '') || requestedId && session.id !== requestedId) throw new Error('OpenCode 返回了不匹配的会话。');
    if (stopping || server.exitCode !== null || server.signalCode !== null) throw new Error('OpenCode 服务已退出。');
    if (!requestedId) args.splice(1, 0, '--session', session.id);
    args.splice(1, 0, '--attach', url);
    const binding = { schema_version: 'opencode-shared-run.v1', audit_id: spec.audit_id, generation,
      session_id: session.id, url, username: 'opencode', password, command: spec.command,
      directory: spec.cwd, server_pid: server.pid, launcher_pid: process.pid, created_at: new Date().toISOString() };
    const temporaryPath = `${connectionPath}.${generation}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(binding)}\n`, { mode: 0o600 });
    await rename(temporaryPath, connectionPath);
    output(`${JSON.stringify({ type: 'session_bound', sessionID: session.id, shared_server: true, generation })}\n`);
    runner = start(args);
    for (const stream of [runner.stdout, runner.stderr]) stream.on('data', output);
    return await new Promise((resolve, reject) => {
      runner.once('error', () => reject(new Error('OpenCode JSON 客户端启动失败。')));
      runner.once('close', (code, signal) => resolve({ code, signal }));
      server.once('close', () => {
        if (!stopping && runner.exitCode === null && runner.signalCode === null) {
          output(`${JSON.stringify({ type: 'error', sessionID: session.id, error: { message: 'OpenCode 服务异常退出。' } })}\n`);
          runner.kill('SIGTERM');
        }
      });
    });
  } finally {
    await stop();
    await rm(connectionPath, { force: true });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, onSignal);
  }
}
