import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ServiceUnavailableException } from '@nestjs/common';
import type { TaskModels } from '../shared/contracts.js';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const catalogModule = new URL('.opencode/web/dynamic-validation-observatory/opencode-model-settings.mjs', new URL('../../../../../', import.meta.url));
type CatalogSnapshot = { models: string[]; sources: { status: string }[] };
type SettingsModule = {
  OpenCodeModelCatalog: new (options: { configPaths: string[] }) => { snapshot(): Promise<CatalogSnapshot> };
  normalizeOpenCodeModel: (value: unknown) => string | null;
};

export function localModelPaths() {
  const platformConfig = join(root, '.opencode', 'opencode.json');
  const configHome = resolve(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'));
  return {
    configPaths: [platformConfig, join(dirname(platformConfig), 'opencode.jsonc'), join(configHome, 'opencode.json'), join(configHome, 'opencode.jsonc'), join(configHome, 'opencode', 'opencode.json'), join(configHome, 'opencode', 'opencode.jsonc')],
    settingsPath: join(dirname(resolve(process.env.AUDIT_WORKBENCH_STATE_ROOT || join(root, 'reports', 'platform', 'audit-runs'))), 'opencode-model-settings.json'),
  };
}

// Reuse the original platform's JSON/JSONC parser and model-ID normalization.
// Read only: never initialize another settings store or expose provider secrets.
export async function readLocalTaskModels(paths = localModelPaths()): Promise<TaskModels> {
  const module = await import(catalogModule.href) as SettingsModule;
  const catalog = new module.OpenCodeModelCatalog({ configPaths: paths.configPaths });
  let selectedModel = 'default';
  try {
    const text = await readFile(paths.settingsPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (text !== null) {
      const settings = JSON.parse(text);
      if (!settings || typeof settings !== 'object' || Array.isArray(settings) || (settings.schema_version !== undefined && settings.schema_version !== 1)) throw new Error('Invalid model settings');
      selectedModel = module.normalizeOpenCodeModel(settings.model ?? settings.selected_model) || 'default';
    }
  } catch {
    throw new ServiceUnavailableException('本机模型选择配置无法读取，请检查 opencode-model-settings.json。');
  }
  const snapshot = await catalog.snapshot();
  if (!snapshot.sources.some(source => source.status === 'ready')) throw new ServiceUnavailableException('未能读取本机 OpenCode 配置，请检查 JSON/JSONC 文件。');
  return { models: [{ value: 'default', label: '默认' }, ...snapshot.models.map(value => ({ value, label: value }))], selectedModel };
}
