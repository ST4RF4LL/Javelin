import { spawn } from 'node:child_process';

// A Grow CLI owns its session. Stop before reopening it; never run two writers.
export async function startOwnedRun(spec, { environment, output, spawnProcess = spawn }) {
  const child = spawnProcess(spec.command, spec.args, { cwd: spec.cwd, env: environment,
    shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const notify = message => { if (spec.controllable && process.connected) process.send(message, () => {}); };
  let stopping, timer;
  const done = new Promise(resolve => {
    child.once('error', error => resolve({ code: 1, error: error.message }));
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
  const stop = () => stopping ??= (async () => {
    child.kill('SIGTERM'); timer = setTimeout(() => child.kill('SIGKILL'), 5000); timer.unref?.();
    await done; clearTimeout(timer);
  })();
  const onSignal = () => { void stop(); };
  const onMessage = message => {
    if (message?.type !== 'audit-control') return;
    if (message.action === 'stop') void stop().then(() => notify({ type: 'audit-control-result', id: message.id }));
    else notify({ type: 'audit-control-result', id: message.id, error: '此引擎通过停止进程并恢复会话进行暂停与继续。' });
  };
  if (Number.isSafeInteger(child.pid)) notify({ type: 'audit-child', pid: child.pid, active: true });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', output);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, onSignal);
  process.on('disconnect', onSignal); process.on('message', onMessage);
  try { return await done; }
  finally {
    clearTimeout(timer);
    if (Number.isSafeInteger(child.pid)) notify({ type: 'audit-child', pid: child.pid, active: false });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, onSignal);
    process.off('disconnect', onSignal); process.off('message', onMessage);
  }
}
