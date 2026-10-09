import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// 在模块加载时固定摘要；健康检查不能把磁盘上的新代码冒充已加载版本。
const sources = [
  './server.mjs', './audit-runner.mjs', './product-store.mjs',
  './opencode-model-settings.mjs', './audit-queue-scheduler.mjs', './snapshot-cache.mjs',
  './runtime-build.mjs', './file-focus-coverage.mjs', '../../lib/runtime-testing/contract.mjs', '../../lib/task-board/contract.mjs',
  '../../lib/runtime-testing/service.mjs', '../../lib/runtime-testing/controller.mjs', '../../lib/runtime-testing/environment-leases.mjs',
  '../../lib/runtime-testing/browser.mjs', '../../lib/runtime-testing/worker-mcp.mjs', '../../lib/runtime-testing/worker-instructions.md',
  './tmux-monitor.mjs', './tmux-launcher.mjs', './opencode-shared-run.mjs', './opencode-runtime-config.mjs',
  '../../lib/task-board/store.mjs', '../../lib/task-board/service.mjs', '../../lib/task-board/review.mjs',
  '../../lib/task-board/report-integrity.mjs', '../../lib/task-board/report-correction.mjs', '../../lib/bac/contract.mjs',
  '../../scripts/audit-service.mjs', '../../lib/audit-runtime/service-process.mjs', '../../lib/audit-runtime/state-lease.mjs',
  '../../lib/audit-runtime/contract.mjs', '../../lib/audit-runtime/native-sessions.mjs',
  '../../lib/audit-runtime/native-client.mjs', '../../lib/audit-runtime/opencode-session-plugin.mjs',
  '../../lib/audit-runtime/session-bridge.mjs', '../../scripts/audit-session-mcp.mjs',
];
const digest = createHash('sha256');
for (const path of sources) digest.update(path).update('\0').update(readFileSync(new URL(path, import.meta.url))).update('\0');

export const runtimeBuild = Object.freeze({
  protocol: 'audit-workbench-runtime.v1',
  source_sha256: digest.digest('hex'),
  loaded_at: new Date().toISOString(),
  pid: process.pid,
});
