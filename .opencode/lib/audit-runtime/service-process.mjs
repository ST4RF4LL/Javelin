import { spawn } from 'node:child_process';
import { open, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const SERVICE_PROTOCOL = 'audit-runtime-service.v1';
export const DEFAULT_SERVICE_ORIGIN = 'http://127.0.0.1:4183';
const entry = fileURLToPath(new URL('../../scripts/audit-service.mjs', import.meta.url));
export const platformRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export const defaultServiceRoot = join(platformRoot, 'reports/platform/audit-service');

export async function serviceHealth(origin, fetcher = fetch) {
  try {
    const response = await fetcher(`${origin}/api/v1/runtime/health`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok) throw new Error(`审计服务健康检查失败：HTTP ${response.status}`);
    const value = await response.json();
    if (value.service !== 'opencode-audit-workbench') throw new Error('端口被其他服务占用。');
    return value;
  } catch (error) {
    if ((error.code ?? error.cause?.code) === 'ECONNREFUSED') return null;
    throw error;
  }
}

// The dashboard is a client of this detached process, never its lifecycle owner.
export async function ensureAuditService({ origin = DEFAULT_SERVICE_ORIGIN, modernOrigin = 'http://127.0.0.1:4181',
  serviceRoot = defaultServiceRoot, stateRoot, fetcher = fetch, spawnProcess = spawn, timeoutMs = 30_000 } = {}) {
  // Detect the old daemon before attempting to acquire the same task state.
  let saved;
  try { saved = await readServiceConnection(serviceRoot); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (saved && saved.origin !== origin && await serviceHealth(saved.origin, fetcher)) {
    throw new Error(`审计后台仍在 ${saved.origin} 运行。请先结束活动任务，再执行 node .opencode/scripts/audit-service.mjs stop 后重新启动；未启动第二个 Runner。`);
  }
  const current = await serviceHealth(origin, fetcher);
  if (current && current.runtime_service?.ready !== false) return { health: current, started: false };
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('自动启动审计服务只支持本机 HTTP origin。');
  let child, failure;
  if (!current) {
    await mkdir(serviceRoot, { recursive: true, mode: 0o700 });
    const log = await open(join(serviceRoot, 'service.log'), 'a', 0o600);
    try {
    child = spawnProcess(process.execPath, [entry, 'serve', '--port', url.port, '--service-root', serviceRoot,
      '--modern-ui-origin', modernOrigin, ...(stateRoot ? ['--state-root', stateRoot] : [])],
    { cwd: platformRoot, env: process.env, detached: true, shell: false, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
    child.on('error', error => { failure = error; }); child.unref();
    } finally { await log.close(); }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    const health = await serviceHealth(origin, fetcher);
    if (health?.runtime_service?.protocol === SERVICE_PROTOCOL && health.runtime_service.ready) return { health, started: Boolean(child) };
    if (health && !health.runtime_service) throw new Error('端口已被旧版后台占用，请先完成旧版后台迁移。');
    if (!health && child?.exitCode != null) throw new Error(`审计服务启动失败，请查看 ${join(serviceRoot, 'service.log')}。`);
    await delay(150);
  }
  throw new Error(`审计服务尚未就绪，请查看 ${join(serviceRoot, 'service.log')}；未终止可能已经开始的任务。`);
}

export async function readServiceConnection(serviceRoot = defaultServiceRoot) {
  const connection = JSON.parse(await readFile(join(serviceRoot, 'connection.json'), 'utf8'));
  const url = new URL(connection.origin);
  if (connection.protocol !== SERVICE_PROTOCOL || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.pathname !== '/' || url.search || url.hash || url.username || url.password || !/^[a-f0-9]{64}$/.test(connection.token ?? '')) throw new Error('本机审计服务连接文件无效。');
  return connection;
}
