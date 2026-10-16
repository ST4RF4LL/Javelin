import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve, win32 } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { atomicJson } from '../task-board/contract.mjs';
import { resolveExecutablePath, resolvedOpenCodeExecutables } from '../../web/dynamic-validation-observatory/executable-resolution.mjs';

const execute = promisify(execFile);
export const AGENT_PROFILES = Object.freeze([
  { id: 'opencode', label: 'OpenCode v1', command: 'opencode' },
  { id: 'opencode-v2', label: 'OpenCode v2', command: 'opencode2' },
  { id: 'grow', label: 'Grow', command: 'grow' },
]);
function invalid(message, code = 'agent-settings-invalid') { return Object.assign(new Error(message), { statusCode: 422, code }); }
export function normalizeAgentEngine(value = 'opencode') {
  if (!AGENT_PROFILES.some(profile => profile.id === value)) throw invalid('Agent 基座仅支持 OpenCode v1、OpenCode v2 或 Grow。', 'agent-engine-invalid');
  return value;
}
export function normalizeAgentCommand(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f"'`|;&<>]/u.test(value)) throw invalid('可执行程序须为单个程序名或绝对路径，不能附带参数或 shell 命令。');
  const command = value.trim();
  const absolute = isAbsolute(command) || win32.isAbsolute(command) || command.startsWith('~/');
  if (!absolute && (!/^[A-Za-z0-9_.+-]+$/.test(command) || command.startsWith('-'))) throw invalid('请填写 PATH 中的程序名或可执行文件的绝对路径。');
  return command;
}
function normalizeSettings(value, defaults) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value.schema_version !== undefined && value.schema_version !== 1)) throw invalid('Agent 设置格式无效。');
  if (value.commands !== undefined && (!value.commands || typeof value.commands !== 'object' || Array.isArray(value.commands))) throw invalid('Agent 程序配置无效。');
  for (const key of Object.keys(value.commands ?? {})) normalizeAgentEngine(key);
  if (value.enabled !== undefined && (!value.enabled || typeof value.enabled !== 'object' || Array.isArray(value.enabled))) throw invalid('Agent 启用设置无效。');
  for (const [id, enabled] of Object.entries(value.enabled ?? {})) {
    normalizeAgentEngine(id);
    if (typeof enabled !== 'boolean') throw invalid('Agent 启用设置须为布尔值。');
  }
  const enabled = Object.fromEntries(AGENT_PROFILES.map(({ id }) => [id, value.enabled?.[id] ?? defaults.enabled?.[id] ?? true]));
  const commands = Object.fromEntries(AGENT_PROFILES.map(({ id }) => {
    const command = value.commands?.[id] ?? defaults.commands?.[id];
    return [id, !enabled[id] && typeof command === 'string' && !command.trim() ? '' : normalizeAgentCommand(command)];
  }));
  const preferred = Object.hasOwn(value, 'default_engine') ? value.default_engine : defaults.default_engine ?? null;
  if (preferred !== null) normalizeAgentEngine(preferred);
  const defaultEngine = preferred && enabled[preferred] ? preferred : AGENT_PROFILES.find(({ id }) => enabled[id])?.id ?? null;
  return { schema_version: 1, default_engine: defaultEngine, enabled, commands, updated_at: value.updated_at ?? null };
}

export class AgentSettingsStore {
  constructor({ path, commands = {}, environment = process.env, home = homedir(), platform = process.platform, probe = execute, resolveCommand = resolveExecutablePath, clock = () => Date.now() } = {}) {
    if (!path) throw new Error('Agent 设置路径不能为空。');
    Object.assign(this, { path: resolve(path), environment, home, platform, probe, resolveCommand, clock });
    this.document = normalizeSettings({ default_engine: 'opencode', commands: { ...Object.fromEntries(AGENT_PROFILES.map(profile => [profile.id, profile.command])), ...commands } }, {});
    this.writes = Promise.resolve(); this.probes = new Map(); this.ready = this.initialize();
  }
  async initialize() {
    try { this.document = normalizeSettings(JSON.parse(await readFile(this.path, 'utf8')), this.document); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async get() { await this.ready; return structuredClone(this.document); }
  async update(value) {
    await this.ready;
    const operation = this.writes.catch(() => {}).then(async () => {
      const next = { ...normalizeSettings(value, this.document), updated_at: new Date(this.clock()).toISOString() };
      await atomicJson(this.path, next); this.document = next; this.probes.clear();
      return structuredClone(next);
    });
    this.writes = operation; return operation;
  }
  async resolve(engine, { refresh = false } = {}) {
    const settings = await this.get();
    if (engine == null && settings.default_engine === null) throw invalid('未启用任何 Agent，请先在工作台设置中启用。', 'agent-engine-disabled');
    const id = normalizeAgentEngine(engine ?? settings.default_engine);
    const command = settings.commands[id], key = `${id}:${command}`;
    if (!settings.enabled[id]) return { id, label: AGENT_PROFILES.find(profile => profile.id === id).label, command, configured_command: command,
      enabled: false, available: false, version: null, reason: '未启用；可在工作台设置中开启。' };
    const cached = this.probes.get(key);
    if (!refresh && cached && this.clock() - cached.at < 30000) return structuredClone(await cached.result);
    const result = this.inspect(id, command);
    this.probes.set(key, { at: this.clock(), result });
    return structuredClone(await result);
  }
  async inspect(id, configuredCommand) {
    const profile = AGENT_PROFILES.find(item => item.id === id);
    const suffix = this.platform === 'win32' ? '.exe' : '';
    const fallbacks = configuredCommand !== profile.command ? [] : id === 'opencode-v2'
      ? [join(this.home, '.opencode', 'bin', `opencode2${suffix}`), join(this.home, '.opencode2', 'bin', `opencode2${suffix}`)]
      : [join(this.home, id === 'grow' ? '.grow' : '.opencode', 'bin', `${profile.command}${suffix}`)];
    let command = configuredCommand.startsWith('~/') ? join(this.home, configuredCommand.slice(2)) : configuredCommand;
    command = await this.resolveCommand(command, this.environment, this.platform);
    for (const fallback of fallbacks) { if (command) break; command = await this.resolveCommand(fallback, this.environment, this.platform); }
    if (command && this.platform === 'win32' && /\.(cmd|bat)$/i.test(extname(command)) && id === 'opencode') {
      const wrapper = command;
      command = (await resolvedOpenCodeExecutables({ command, environment: this.environment, platform: this.platform,
        resolveCommand: async candidate => candidate === wrapper ? wrapper : null }))[0] ?? null;
    }
    const base = { id, label: profile.label, command: command || configuredCommand, configured_command: configuredCommand, enabled: true, available: false, version: null };
    if (!command) return { ...base, reason: `未找到 ${profile.label} 可执行程序，请配置已安装程序的绝对路径。` };
    if (this.platform === 'win32' && /\.(cmd|bat)$/i.test(extname(command))) return { ...base, reason: '请配置原生 .exe 程序路径；不能以 shell 包装脚本启动执行器。' };
    try {
      const options = { env: this.environment, windowsHide: true, shell: false, timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf8' };
      const output = await this.probe(command, ['--version'], options);
      const version = `${output.stdout ?? ''}\n${output.stderr ?? ''}`.match(/\bv?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\b/i)?.[1];
      if (!version) return { ...base, reason: '程序未返回可识别的版本号，请检查是否选中了正确的 Agent。' };
      if (id !== 'grow' && Number(version.split('.')[0]) !== (id === 'opencode-v2' ? 2 : 1)) return { ...base, version, reason: `检测到版本 ${version}，与 ${profile.label} 不匹配，请选择对应程序。` };
      if (id === 'opencode-v2') {
        const help = await this.probe(command, ['run', '--help'], options);
        if (!/--server\b/.test(help.stdout ?? '') || !/--standalone\b/.test(help.stdout ?? '')) return { ...base, version, reason: '此 v2 程序缺少 run --server / --standalone 接口，无法使用当前适配器。' };
      }
      return { ...base, version, available: true, capabilities: { structured_events: true, session_resume: true } };
    } catch (error) {
      return { ...base, reason: error.killed || error.code === 'ETIMEDOUT' ? '版本检测超时，请确认程序可在本机正常启动。' : '程序版本检测失败，请检查可执行文件、权限和依赖。' };
    }
  }
  async snapshot(options = {}) {
    const document = await this.get();
    return { ...document, profiles: await Promise.all(AGENT_PROFILES.map(({ id }) => this.resolve(id, options))) };
  }
}

export function normalizeGrowModel(value) {
  if (value === undefined || value === null || value === 'default') return null;
  if (typeof value !== 'string' || value.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value)) throw invalid('Grow 模型名称无效。', 'grow-model-invalid');
  return value;
}
export class GrowModelCatalog {
  constructor({ configPaths = [join(process.env.JAVELIN_GROW_USER_HOME || process.env.GROW_HOME || join(homedir(), '.grow'), 'config.toml')] } = {}) { this.configPaths = [...new Set(configPaths.map(path => resolve(path)))]; }
  async snapshot() {
    const models = new Set(), sources = [];
    for (const path of this.configPaths) {
      try {
        const config = parseToml((await readFile(path, 'utf8')).replace(/^\uFEFF/u, ''));
        const configured = new Set();
        const values = [config.model, config.models?.default, ...Object.values(config.profiles ?? {}).map(profile => profile?.model)];
        for (const [provider, definition] of Object.entries(config.provider ?? config.providers ?? {})) {
          if (!definition?.models || typeof definition.models !== 'object' || Array.isArray(definition.models)) continue;
          for (const name of Object.keys(definition.models)) values.push(`${provider}/${name}`);
        }
        for (const value of values) {
          try { const id = normalizeGrowModel(value); if (id) configured.add(id); } catch { /* Invalid model IDs are not exposed as selectable options. */ }
        }
        for (const id of configured) models.add(id);
        sources.push({ path, status: 'ready', model_count: configured.size, message: null });
      } catch (error) { sources.push({ path, status: error.code === 'ENOENT' ? 'missing' : 'invalid', model_count: 0, message: error.code === 'ENOENT' ? null : '配置不是有效 TOML。' }); }
    }
    return { models: [...models].sort(), sources };
  }
}
export class GrowModelSettingsStore {
  constructor({ path }) { this.path = path; this.document = { schema_version: 1, model: null, updated_at: null }; this.writes = Promise.resolve(); this.ready = this.initialize(); }
  async initialize() {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      if (!saved || saved.schema_version !== 1) throw invalid('Grow 模型设置格式无效。');
      this.document = { schema_version: 1, model: normalizeGrowModel(saved.model), updated_at: saved.updated_at ?? null };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async get() { await this.ready; return structuredClone(this.document); }
  async update(value, availableModels = []) {
    const model = normalizeGrowModel(value);
    if (model && !availableModels.includes(model)) throw invalid('所选模型不在当前 Grow 配置清单中。', 'grow-model-not-configured');
    await this.ready;
    const operation = this.writes.catch(() => {}).then(async () => {
      const next = { schema_version: 1, model, updated_at: new Date().toISOString() };
      await atomicJson(this.path, next); this.document = next; return structuredClone(next);
    });
    this.writes = operation; return operation;
  }
}
