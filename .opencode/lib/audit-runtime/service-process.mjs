import { spawn } from 'node:child_process';
import { open, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { localServiceFetch, serviceRequestErrorCode } from './local-service-transport.mjs';
import { assertAuditRuntimeDependencies } from './runtime-dependencies.mjs';

export const SERVICE_PROTOCOL = 'audit-runtime-service.v1';
export const DEFAULT_SERVICE_ORIGIN = 'http://127.0.0.1:4183';
const entry = fileURLToPath(new URL('../../scripts/audit-service.mjs', import.meta.url));
export const platformRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export const defaultServiceRoot = join(platformRoot, 'reports/platform/audit-service');

export async function serviceHealth(origin, fetcher = localServiceFetch) {
  try {
    const response = await fetcher(`${origin}/api/v1/runtime/health`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok) throw Object.assign(new Error(`审计服务 ${origin} 健康检查失败：HTTP ${response.status}`), { code: 'AUDIT_SERVICE_HTTP_ERROR' });
    const value = await response.json().catch(() => null);
    if (value?.service !== 'opencode-audit-workbench') throw Object.assign(new Error(`审计服务 ${origin} 未返回有效健康信息，端口可能被其他服务占用。`), { code: 'AUDIT_SERVICE_PROTOCOL_ERROR' });
    return value;
  } catch (error) {
    const code = serviceRequestErrorCode(error);
    if (code === 'ECONNREFUSED') return null;
    if (['AUDIT_SERVICE_HTTP_ERROR', 'AUDIT_SERVICE_PROTOCOL_ERROR'].includes(code)) throw error;
    throw Object.assign(new Error(`无法读取审计服务 ${origin} 的健康状态（${code}）。请检查服务日志与端口；未启动第二个 Runner。`, { cause: error }), { code: 'AUDIT_SERVICE_CONNECTION_FAILED', reason_code: code });
  }
}

// The dashboard is a client of this detached process, never its lifecycle owner.
export async function ensureAuditService({ origin = DEFAULT_SERVICE_ORIGIN, modernOrigin = 'http://127.0.0.1:4181',
  serviceRoot = defaultServiceRoot, stateRoot, fetcher = localServiceFetch, spawnProcess = spawn, timeoutMs = 30_000 } = {}) {
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
    assertAuditRuntimeDependencies();
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
  let lastConnectionError;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    let health;
    try { health = await serviceHealth(origin, fetcher); }
    catch (error) {
      // Only retry reads after a known initialization/start, never launch on an ambiguous preflight.
      if (!['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(error.reason_code)) throw error;
      lastConnectionError = error.reason_code;
    }
    if (health?.runtime_service?.protocol === SERVICE_PROTOCOL && health.runtime_service.ready) return { health, started: Boolean(child) };
    if (health && !health.runtime_service) throw new Error('端口已被旧版后台占用，请先完成旧版后台迁移。');
    if (!health && child?.exitCode != null) throw new Error(`审计服务 ${origin} 已退出（退出码 ${child.exitCode}），请查看 ${join(serviceRoot, 'service.log')}。`);
    await delay(150);
  }
  throw new Error(`审计服务 ${origin} 尚未就绪${lastConnectionError ? `（${lastConnectionError}）` : ''}，请查看 ${join(serviceRoot, 'service.log')}；未终止可能已经开始的任务。`);
}

export async function readServiceConnection(serviceRoot = defaultServiceRoot) {
  const connection = JSON.parse(await readFile(join(serviceRoot, 'connection.json'), 'utf8'));
  const url = new URL(connection.origin);
  if (connection.protocol !== SERVICE_PROTOCOL || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.pathname !== '/' || url.search || url.hash || url.username || url.password || !/^[a-f0-9]{64}$/.test(connection.token ?? '')) throw new Error('本机审计服务连接文件无效。');
  return connection;
}
