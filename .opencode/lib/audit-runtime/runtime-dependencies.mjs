import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('../../package.json', import.meta.url));

// Check package manifests without loading code, including packages with import-only exports.
export function assertAuditRuntimeDependencies() {
  const { dependencies = {} } = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const searchPaths = [];
  for (let directory = dirname(manifestPath);;) {
    searchPaths.push(join(directory, 'node_modules'));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const missing = Object.keys(dependencies).filter(name => !searchPaths.some(directory => existsSync(join(directory, name, 'package.json'))));
  if (missing.length) {
    throw Object.assign(new Error(`审计后端缺少依赖：${missing.join('、')}。请在仓库根目录执行 npm --prefix .opencode ci --include=optional，成功后重新启动平台。仅安装 apps/workbench 的依赖不会安装后端依赖。`), {
      code: 'AUDIT_RUNTIME_DEPENDENCIES_MISSING', missing,
    });
  }
}
