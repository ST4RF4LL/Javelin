import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// 在模块加载时固定摘要；健康检查不能把磁盘上的新代码冒充已加载版本。
const sources = [
  './server.mjs', './audit-runner.mjs', './product-store.mjs',
  './opencode-model-settings.mjs', './audit-queue-scheduler.mjs', './snapshot-cache.mjs',
  './runtime-build.mjs', '../../lib/runtime-testing/contract.mjs', '../../lib/task-board/contract.mjs',
];
const digest = createHash('sha256');
for (const path of sources) digest.update(path).update('\0').update(readFileSync(new URL(path, import.meta.url))).update('\0');

export const runtimeBuild = Object.freeze({
  protocol: 'audit-workbench-runtime.v1',
  source_sha256: digest.digest('hex'),
  loaded_at: new Date().toISOString(),
  pid: process.pid,
});
