import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const SHARED_CONNECTION_FILE = 'opencode-server.json';
export const RUN_PERMISSIONS = ['question', 'plan_enter', 'plan_exit'].map(action => ({ action, effect: 'deny', resource: '*' }));

// v2.0.29: serve --stdio emits {url}; stdin is its ownership lease. Both the
// JSON client and ttyd TUI use --server and the same /api/session identity.
export async function startSharedRun(spec, { environment, output, spawnProcess = spawn, fetcher = fetch }) {
  const connectionPath = join(spec.state_directory, SHARED_CONNECTION_FILE), generation = randomUUID();
  const password = randomBytes(32).toString('hex');
  const env = { ...environment, OPENCODE_PASSWORD: password };
  delete env.OPENCODE_SERVER_USERNAME; delete env.OPENCODE_SERVER_PASSWORD;
  let server, runner, stopping, readyTimer, request, sessionId, runFinished, wake;
  let paused = false, serverFailed = false, controls = Promise.resolve();
  const children = new Set();
  const notify = message => { if (spec.controllable && process.connected) process.send(message, () => {}); };
  const live = child => child && child.exitCode === null && child.signalCode === null;
  const waitUntilResumed = async () => { while (paused && !stopping) await new Promise(resolve => { wake = resolve; }); };
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      clearTimeout(readyTimer); paused = false; wake?.();
      await rm(connectionPath, { force: true });
      // EOF shuts down the owned v2 server even if its JSON client is gone.
      server?.stdin?.end();
      await Promise.all([...children].map(child => new Promise(resolve => {
        if (!live(child)) return resolve();
        const timer = setTimeout(() => child.kill('SIGKILL'), 2500);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      })));
    })();
    return stopping;
  }
  const onSignal = () => { void stop(); }, onDisconnect = () => { void stop(); };
  const onControl = message => {
    if (!spec.controllable || message?.type !== 'audit-control' || !['pause', 'resume', 'stop'].includes(message.action)) return;
    controls = controls.then(async () => {
      if (message.action === 'stop') await stop();
      else if (stopping) throw new Error('任务正在结束。');
      else if (message.action === 'pause') {
        paused = true;
        try {
          if (request && sessionId && live(runner)) {
            runner.kill('SIGTERM');
            let timer;
            try { await Promise.race([runFinished, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('OpenCode v2 会话未确认暂停。')), 7000); })]); }
            finally { clearTimeout(timer); }
            await request(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, { method: 'POST' });
          }
        } catch (error) { await stop(); throw error; }
      } else { paused = false; wake?.(); }
      notify({ type: 'audit-control-result', id: message.id });
    }).catch(error => notify({ type: 'audit-control-result', id: message.id, error: error.message }));
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, onSignal);
  if (spec.controllable) { process.on('message', onControl); process.on('disconnect', onDisconnect); }
  const start = (args, serving = false) => {
    if (stopping) throw new Error('任务启动已取消。');
    const child = spawnProcess(spec.command, args, { cwd: spec.cwd, env, stdio: [serving ? 'pipe' : 'ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    children.add(child);
    if (Number.isSafeInteger(child.pid)) {
      notify({ type: 'audit-child', pid: child.pid, active: true });
      child.once('close', () => notify({ type: 'audit-child', pid: child.pid, active: false }));
    }
    return child;
  };
  try {
    await rm(connectionPath, { force: true });
    server = start(['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], true);
    const url = await new Promise((resolve, reject) => {
      let buffer = '';
      readyTimer = setTimeout(() => reject(new Error('OpenCode v2 服务启动超时。')), 30_000);
      const failed = () => reject(new Error('OpenCode v2 服务在就绪前退出。'));
      server.once('error', failed); server.once('close', failed);
      server.stderr.on('data', () => {});
      server.stdout.on('data', chunk => {
        buffer += chunk.toString();
        if (buffer.length > 65536) { reject(new Error('OpenCode v2 服务就绪消息无效。')); return; }
        for (let newline; (newline = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let ready;
          try { ready = JSON.parse(line); } catch { continue; }
          if (typeof ready?.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(ready.url)) continue;
          const parsed = new URL(ready.url);
          if (Number(parsed.port) < 1 || Number(parsed.port) > 65535) continue;
          clearTimeout(readyTimer); resolve(parsed.origin);
        }
      });
    });
    request = async (path, options = {}) => {
      const response = await fetcher(`${url}${path}`, { ...options,
        headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000), redirect: 'error' });
      if (!response.ok) throw new Error(`OpenCode v2 会话连接失败（HTTP ${response.status}）。`);
      return response.status === 204 ? undefined : response.json();
    };
    const info = await request('/api/info');
    if (!/^2\./.test(info?.version ?? '')) throw new Error('OpenCode v2 服务版本不匹配。');
    const args = spec.args.filter(value => value !== '--standalone');
    if (args.includes('--attach') || args.includes('--server')) throw new Error('OpenCode v2 启动参数包含重复服务连接。');
    const sessionIndex = args.indexOf('--session'), requestedId = sessionIndex >= 0 ? args[sessionIndex + 1] : null;
    const titleIndex = args.indexOf('--title'), roleIndex = args.indexOf('--agent');
    const envelope = requestedId ? await request(`/api/session/${encodeURIComponent(requestedId)}`)
      : await request('/api/session', { method: 'POST', body: JSON.stringify({ title: titleIndex >= 0 ? args[titleIndex + 1] : spec.audit_id,
        ...(roleIndex >= 0 ? { agent: args[roleIndex + 1] } : {}), location: { directory: spec.cwd }, permissions: RUN_PERMISSIONS }) });
    const session = envelope?.data;
    if (!/^ses_[A-Za-z0-9_-]+$/.test(session?.id ?? '') || requestedId && session.id !== requestedId) throw new Error('OpenCode v2 返回了不匹配的会话。');
    sessionId = session.id;
    if (stopping || !live(server)) throw new Error('OpenCode v2 服务已退出。');
    if (!requestedId) args.splice(1, 0, '--session', session.id);
    args.splice(1, 0, '--server', url);
    const binding = { schema_version: 'opencode-v2-shared-run.v1', audit_id: spec.audit_id, generation,
      session_id: session.id, url, password, command: spec.command, directory: spec.cwd,
      config_path: env.OPENCODE_CONFIG, config_directory: env.OPENCODE_CONFIG_DIR,
      environment: Object.fromEntries(['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'JAVELIN_OPENCODE_V2_HOME'].filter(key => typeof env[key] === 'string').map(key => [key, env[key]])),
      server_pid: server.pid, launcher_pid: process.pid, created_at: new Date().toISOString() };
    const temporaryPath = `${connectionPath}.${generation}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(binding)}\n`, { mode: 0o600 });
    await rename(temporaryPath, connectionPath);
    output(`${JSON.stringify({ type: 'session_bound', sessionID: session.id, shared_server: true, generation })}\n`);
    server.once('close', () => {
      if (!stopping) {
        serverFailed = true;
        output(`${JSON.stringify({ type: 'error', sessionID: session.id, error: { message: 'OpenCode v2 服务异常退出。' } })}\n`);
        void stop();
      }
    });
    while (!stopping) {
      await waitUntilResumed(); if (stopping) break;
      runner = start(args);
      for (const stream of [runner.stdout, runner.stderr]) stream.on('data', output);
      runFinished = new Promise((resolve, reject) => {
        runner.once('error', () => reject(new Error('OpenCode v2 JSON 客户端启动失败。')));
        runner.once('close', (code, signal) => resolve({ code, signal }));
      });
      const result = await runFinished;
      if (serverFailed) return { code: 1, signal: null };
      if (!paused || stopping) return result;
      args[args.length - 1] = '继续当前审计会话。先读取当前任务面板与既有制品，从尚未完成的步骤继续，保持原冻结范围与授权限制。';
    }
    return { code: serverFailed ? 1 : 0, signal: 'SIGTERM' };
  } finally {
    await stop(); await rm(connectionPath, { force: true });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, onSignal);
    process.off('message', onControl); process.off('disconnect', onDisconnect);
  }
}
