import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_DECISION_MODEL_CONFIG = Object.freeze({
  endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
  api_key: '',
  model: 'startlux-decision-4b',
  protocol: 'openai',
  proxy: '',
});
const CONFIG_FIELDS = Object.keys(DEFAULT_DECISION_MODEL_CONFIG);
const SETTINGS_FIELDS = [...CONFIG_FIELDS, 'enabled'];
function invalid(message, code = 'decision-model-settings-invalid') {
  return Object.assign(new Error(message), { statusCode: 422, code });
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function settingsInput(value) {
  if (!object(value) || Object.keys(value).some(key => !SETTINGS_FIELDS.includes(key))) throw invalid('Decision Model 设置包含未知字段或格式无效。');
  if (Object.hasOwn(value, 'enabled') && typeof value.enabled !== 'boolean') throw invalid('Decision Model 使能开关须为布尔值。');
  const { enabled, ...config } = value;
  return { enabled, config };
}
function requireConnectionFields(config) {
  if (!Object.hasOwn(config, 'endpoint') || !Object.hasOwn(config, 'model')) throw invalid('首次配置 Decision Model 须明确填写 API 地址和模型名称。');
}
function address(value, label, { optional = false, proxy = false } = {}) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/u.test(value)) throw invalid(`${label}须为不含控制字符的 HTTP(S) URL。`);
  const text = value.trim();
  if (optional && !text) return '';
  let url;
  try { url = new URL(text); } catch { throw invalid(`${label}须为完整 HTTP(S) URL。`); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || text.includes('#') || /[\x00-\x20\x7f\\]/u.test(text)) {
    throw invalid(`${label}仅支持 HTTP(S)，不能包含账号、密码、片段或控制字符。`);
  }
  if (proxy && (url.pathname !== '/' || url.search)) throw invalid('代理须为不含认证信息、路径或查询参数的 HTTP(S) 地址。');
  return url.href;
}

export function normalizeDecisionModelConfig(value, base = DEFAULT_DECISION_MODEL_CONFIG) {
  if (!object(value) || Object.keys(value).some(key => !CONFIG_FIELDS.includes(key))) throw invalid('Decision Model 设置包含未知字段或格式无效。');
  const merged = { ...base, ...value };
  const endpoint = address(merged.endpoint, 'API 地址');
  const proxy = address(merged.proxy, '代理地址', { optional: true, proxy: true });
  if (typeof merged.model !== 'string' || !merged.model.trim() || merged.model.length > 240 || /[\x00-\x1f\x7f]/u.test(merged.model)) throw invalid('模型名称不能为空或包含控制字符，且须不超过 240 个字符。');
  if (!['openai', 'systemone'].includes(merged.protocol)) throw invalid('协议仅支持 OpenAI 兼容接口或 System One。');
  if (typeof merged.api_key !== 'string' || merged.api_key.length > 8192 || /[\x00-\x1f\x7f]/u.test(merged.api_key)) throw invalid('API Key 须为不含换行或控制字符的文本。');
  if (endpoint !== base.endpoint && base.api_key && !Object.hasOwn(value, 'api_key')) {
    throw invalid('API 地址已变更，请重新输入 API Key，或明确清空后使用无密钥连接。', 'decision-model-key-required');
  }
  return { endpoint, api_key: merged.api_key.trim(), model: merged.model.trim(), protocol: merged.protocol, proxy };
}

export class DecisionModelSettingsStore {
  constructor({ path } = {}) {
    if (!path) throw new Error('Decision Model 设置路径不能为空。');
    this.path = resolve(path);
    this.config = { ...DEFAULT_DECISION_MODEL_CONFIG };
    this.enabled = false;
    this.configured = false;
    this.updated_at = null;
    this.writes = Promise.resolve();
    this.ready = this.initialize();
    this.ready.catch(() => {});
  }
  async initialize() {
    let contents;
    try { contents = await readFile(this.path, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      throw invalid('无法读取 Decision Model 设置文件，请检查文件权限。', 'decision-model-settings-read');
    }
    try {
      const saved = JSON.parse(contents);
      if (!object(saved) || saved.schema_version !== 1 || Object.keys(saved).some(key => ![...SETTINGS_FIELDS, 'schema_version', 'updated_at'].includes(key)) || typeof saved.updated_at !== 'string' || !Number.isFinite(Date.parse(saved.updated_at))) throw new Error('invalid');
      const { enabled = false, config } = settingsInput(Object.fromEntries(SETTINGS_FIELDS.filter(key => Object.hasOwn(saved, key)).map(key => [key, saved[key]])));
      requireConnectionFields(config);
      this.config = normalizeDecisionModelConfig(config);
      this.enabled = enabled;
      this.configured = true;
      this.updated_at = saved.updated_at;
    } catch {
      throw invalid('Decision Model 设置文件格式无效，请修复或移走该文件后重新配置。', 'decision-model-settings-read');
    }
  }
  async getPrivate() { await this.ready; return { ...this.config }; }
  async getEnabledConfig() {
    try {
      await this.ready;
      return this.configured && this.enabled ? { ...this.config } : null;
    } catch { return null; }
  }
  async snapshot() {
    await this.ready;
    const { api_key, ...config } = this.config;
    return { ...config, api_key_configured: Boolean(api_key), configured: this.configured, enabled: this.enabled, updated_at: this.updated_at };
  }
  async prepare(input = {}) {
    await this.ready;
    return normalizeDecisionModelConfig(settingsInput(input).config, this.config);
  }
  async update(input) {
    await this.ready;
    const operation = this.writes.catch(() => {}).then(async () => {
      const { enabled = this.enabled, config: changes } = settingsInput(input);
      if (!this.configured) requireConnectionFields(changes);
      const config = normalizeDecisionModelConfig(changes, this.config);
      const updated_at = new Date().toISOString();
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(temporary, `${JSON.stringify({ schema_version: 1, ...config, enabled, updated_at }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, this.path);
      } catch {
        throw invalid('无法保存 Decision Model 设置，请检查目标目录和文件权限。', 'decision-model-settings-write');
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
      this.config = config;
      this.enabled = enabled;
      this.configured = true;
      this.updated_at = updated_at;
      return this.snapshot();
    });
    this.writes = operation;
    return operation;
  }
}
