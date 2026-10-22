import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { runtimeBuild } from '../../../.opencode/web/dynamic-validation-observatory/runtime-build.mjs';
import { ensureWorkbenchTerminalMonitor, terminalMonitorConfiguration } from './start-terminal-monitor.mjs';
import { DEFAULT_SERVICE_ORIGIN, ensureAuditService } from '../../../.opencode/lib/audit-runtime/service-process.mjs';
import { assertAuditRuntimeDependencies } from '../../../.opencode/lib/audit-runtime/runtime-dependencies.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const apiEntry = new URL('../build/api/server/main.js', import.meta.url);
const origin = process.env.WORKBENCH_UPSTREAM || DEFAULT_SERVICE_ORIGIN;
let app, legacyApp, ownedTerminal, stopping = false;

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
    throw new Error(`无法确认审计服务状态（${reason}），请检查网络与权限后重试；未启动第二个 Runner。`, { cause: error });
  }
  const health = await response.json().catch(() => null);
  if (!response.ok || health?.service !== 'opencode-audit-workbench') throw new Error('上游端口未返回有效的审计平台健康信息，请检查 WORKBENCH_UPSTREAM。');
  if (!health.runner?.enabled) throw new Error('审计服务正在以只读模式运行。请正常停止它，再执行此命令；或用 --enable-runner 重启服务。');
  if (new URL(upstream).hostname === '127.0.0.1' && (health.runtime_build?.protocol !== runtimeBuild.protocol || health.runtime_build?.source_sha256 !== runtimeBuild.source_sha256)) {
    throw Object.assign(new Error('审计服务尚未加载当前代码。请先结束活动任务，再执行 node .opencode/scripts/audit-service.mjs stop 后重新启动；此次未启动第二个 Runner。'), { code: 'UPSTREAM_RESTART_REQUIRED' });
  }
  return health;
}
async function close() {
  if (stopping) return; stopping = true;
  await ownedTerminal?.close();
  await legacyApp?.close();
  await app?.close();
}
async function main() {
  const args = process.argv.slice(2);
  if (!existsSync(fileURLToPath(apiEntry))) throw new Error('请先执行 npm --prefix apps/workbench run build。');
  const { listenOptions, listenHelp, listenOrigin } = await import('../build/api/server/listen-options.js');
  const { host, port, legacy, help } = listenOptions(args, process.env, { allowLegacy: true });
  if (help) { process.stdout.write(`用法：npm --prefix apps/workbench run start:platform -- [--host <IP>] [--port <端口>] [--legacy]\n${listenHelp}\n--legacy 同时开启 4173 原界面，使用相同监听地址。\n`); return; }
  if (port === terminalMonitorConfiguration().port) throw new Error('平台端口不能与终端端口相同，请修改 --port 或 WORKBENCH_TERMINAL_PORT。');
  const modernOrigin = listenOrigin(host, port);
  const upstream = new URL(origin);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.pathname !== '/' || upstream.search || upstream.hash || upstream.username || upstream.password) throw new Error('WORKBENCH_UPSTREAM 必须是无凭据的 HTTP(S) origin。');
  if (['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname) && upstream.port === '4173') throw new Error('4173 是原界面保留入口，不能作为新版后台。请移除 WORKBENCH_UPSTREAM 的旧值后重新启动。');
  const existing = await probeBackend(upstream.origin);
  if (!existing && upstream.origin !== DEFAULT_SERVICE_ORIGIN) throw new Error('指定的审计服务未运行，请先启动该服务。');
  if (!existing) assertAuditRuntimeDependencies();
  process.env.WORKBENCH_MODE = 'integrated'; process.env.WORKBENCH_ENABLE_TASKS = '1';
  process.env.WORKBENCH_UPSTREAM = upstream.origin;
  process.env.WORKBENCH_LEGACY_ENABLED = legacy ? '1' : '0';
  process.env.WORKBENCH_HOST = host; process.env.WORKBENCH_PORT = String(port);
  process.env.WORKBENCH_MODERN_ORIGIN = modernOrigin;
  const { createApp } = await import(apiEntry.href);
  app = await createApp();
  // 先绑定新版端口，避免端口冲突时启动额外 Runner。
  await app.listen(port, host);
  if (legacy) {
    // A second UI client, never a second audit Runner.
    legacyApp = await createApp({ legacy: true });
    await legacyApp.listen(4173, host);
  }
  if (!existing) {
    await ensureAuditService({ origin: upstream.origin, modernOrigin });
    await probeBackend(upstream.origin);
  }
  try { ownedTerminal = await ensureWorkbenchTerminalMonitor(); }
  catch (error) { process.stderr.write(`交互终端服务未就绪：${error.message}\n`); }
  process.stdout.write(`\n新平台已启动：${modernOrigin}\n${['0.0.0.0', '::'].includes(host) ? `已监听所有网卡；其他设备请访问 http://<本机实际 IP>:${port}（IPv6 地址需加方括号），并放行此 TCP 端口。\n` : ''}${legacy ? `原界面保留入口：${listenOrigin(host, 4173)}/` : '原界面：未开启（需要时添加 --legacy）'}\n审计 API：${upstream.origin}（${existing ? '复用已有服务' : '已在后台启动'}）\n请求诊断：${process.env.WORKBENCH_DIAGNOSTICS_DIR || resolve(root, 'reports/platform/workbench-api/requests.jsonl')}\nCtrl+C 只关闭 Web 与本次终端连接，审计任务继续运行。后台管理：node .opencode/scripts/audit-service.mjs status|stop\n`);
  process.once('SIGINT', () => { void close().catch(fail); });
  process.once('SIGTERM', () => { void close().catch(fail); });
}
function fail(error) { process.stderr.write(`新平台启动或关闭失败：${error.message}\n`); process.exitCode = 1; }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { await close().catch(fail); fail(error); }
}
