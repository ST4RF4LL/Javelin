import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { runtimeBuild } from '../../../.opencode/web/dynamic-validation-observatory/runtime-build.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const apiEntry = new URL('../build/api/server/main.js', import.meta.url);
const origin = process.env.WORKBENCH_UPSTREAM || 'http://127.0.0.1:4173';
const port = Number(process.env.WORKBENCH_PORT || 4181);
let app, ownedBackend, stopping = false;

export async function probeBackend(upstream, transport) {
  if (!transport) {
    const { createUpstreamTransport } = await import('../build/api/server/upstream-transport.js');
    const direct = createUpstreamTransport();
    try { return await probeBackend(upstream, direct.fetch); }
    finally { direct.close(); }
  }
  let response;
  try { response = await transport(`${upstream}/api/v1/runtime/health`, { signal: AbortSignal.timeout(5000), redirect: 'error' }); }
  catch (error) {
    if ((error.code || error.cause?.code) === 'ECONNREFUSED') return null;
    const reason = error.code || error.cause?.code || error.name || '连接失败';
    throw new Error(`无法确认原平台状态（${reason}），请检查网络与权限后重试；未启动第二个 Runner。`, { cause: error });
  }
  const health = await response.json().catch(() => null);
  if (!response.ok || health?.service !== 'opencode-audit-workbench') throw new Error('上游端口未返回有效的审计平台健康信息，请检查 WORKBENCH_UPSTREAM。');
  if (!health.runner?.enabled) throw new Error('原平台正在以只读模式运行。请在原终端正常停止它，再执行此命令；或用 --enable-runner 重启原平台。');
  if (new URL(upstream).origin === 'http://127.0.0.1:4173' && (health.runtime_build?.protocol !== runtimeBuild.protocol || health.runtime_build?.source_sha256 !== runtimeBuild.source_sha256)) {
    throw Object.assign(new Error('4173 正在运行未加载当前代码的后台。请在原终端正常停止该后台，再运行本命令；新版会启动当前版本。此次未启动新版或第二个 Runner。'), { code: 'UPSTREAM_RESTART_REQUIRED' });
  }
  return health;
}
async function close() {
  if (stopping) return; stopping = true;
  await app?.close();
  if (ownedBackend) {
    process.stdout.write('正在停止本次启动的原平台与所属执行进程…\n');
    await ownedBackend.shutdownRunners();
    ownedBackend.closeAllConnections();
    if (ownedBackend.listening) await new Promise(resolve => ownedBackend.close(resolve));
  }
}
async function main() {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 4173) throw new Error('WORKBENCH_PORT 需要是有效端口，且不能占用原平台的 4173。');
  const upstream = new URL(origin);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.pathname !== '/' || upstream.search || upstream.hash || upstream.username || upstream.password) throw new Error('WORKBENCH_UPSTREAM 必须是无凭据的 HTTP(S) origin。');
  if (!existsSync(fileURLToPath(apiEntry))) throw new Error('请先执行 npm --prefix apps/workbench run build。');
  const existing = await probeBackend(upstream.origin);
  if (!existing && upstream.origin !== 'http://127.0.0.1:4173') throw new Error('指定的原平台未运行，请先启动该上游服务。自动启动仅适用于本机默认 4173 端口。');
  process.env.WORKBENCH_MODE = 'integrated'; process.env.WORKBENCH_ENABLE_TASKS = '1';
  const { createApp } = await import(apiEntry.href);
  app = await createApp();
  // 先绑定新版端口，避免端口冲突时启动额外 Runner。
  await app.listen(port, '127.0.0.1');
  if (!existing) {
    const { createAuditWorkbenchServer, parseArgs } = await import(new URL('../../../.opencode/web/dynamic-validation-observatory/server.mjs', import.meta.url));
    ownedBackend = createAuditWorkbenchServer(parseArgs(['--host', '127.0.0.1', '--port', '4173', '--enable-runner', '--modern-ui-origin', `http://127.0.0.1:${port}`]));
    await new Promise((resolve, reject) => { ownedBackend.once('error', reject); ownedBackend.listen(4173, '127.0.0.1', resolve); });
    await ownedBackend.productCatalogReady;
    await probeBackend(upstream.origin);
  }
  process.stdout.write(`\n新平台已启动：http://127.0.0.1:${port}\n原界面保留入口：http://127.0.0.1:${port}/legacy/\n原后台：${upstream.origin}（${existing ? '复用已有 Runner' : '本次启动，已开启 Runner'}）\n请求诊断：${process.env.WORKBENCH_DIAGNOSTICS_DIR || resolve(root, 'reports/platform/workbench-api/requests.jsonl')}\n请保持终端运行，在“创建审计”中提交你的任务。Ctrl+C 将关闭本次启动的服务。\n`);
  process.once('SIGINT', () => { void close().catch(fail); });
  process.once('SIGTERM', () => { void close().catch(fail); });
}
function fail(error) { process.stderr.write(`新平台启动或关闭失败：${error.message}\n`); process.exitCode = 1; }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { await close().catch(fail); fail(error); }
}
