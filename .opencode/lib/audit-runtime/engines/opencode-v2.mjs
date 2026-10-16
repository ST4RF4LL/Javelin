import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';

export const V2_PLUGIN_DIRECTORY = fileURLToPath(new URL('./opencode-v2-plugin/', import.meta.url));
export const V2_INSTRUCTIONS = `当前执行基座是 OpenCode v2。既有审计协议中的 bash 工具在这里叫 shell；task 工具在这里叫 subagent，subagent_type 参数对应 agent，task_id/续接子会话对应 sessionID。read/edit/write 的 filePath 参数对应 path；skill 的 name 参数对应 id。MCP 按当前工具目录通过 execute 中的 tools.<server>.<tool> 调用，不猜测名称。不要把业务任务 task_id 当成会话 ID。使用 subagent({agent,description,prompt})，需要等待交付的委派保持前台；只有相互独立的工作才能设置 background:true，完成通知会自动到达，不轮询、不 sleep。后台任务面板仍是领取、交付、复核和封存的唯一事实来源，工具成功或会话 idle 都不等于审计完成。保持原有源码只读、动态授权、技能范围和中文报告约束。`;

async function isolatedStorage(environment, engineRoot) {
  const root = resolve(environment.JAVELIN_OPENCODE_V2_HOME || join(environment.AUDIT_ENGINE_ROOT || engineRoot, 'workspace', 'agent-data', 'opencode-v2'));
  const result = { JAVELIN_OPENCODE_V2_HOME: root, XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache') };
  await Promise.all(Object.values(result).map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const authDirectory = join(result.XDG_DATA_HOME, 'opencode');
  await mkdir(authDirectory, { recursive: true, mode: 0o700 });
  // v2 uses the same opencode.db filename as v1. Only bootstrap its legacy
  // credential import, never copy, open or migrate the user's v1 database.
  const previousAuth = join(environment.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode', 'auth.json');
  try {
    const auth = await readFile(previousAuth);
    await writeFile(join(authDirectory, 'auth.json'), auth, { mode: 0o600, flag: 'wx' });
  } catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
  return result;
}

function merge(base, patch) {
  const result = structuredClone(base ?? {});
  for (const [key, value] of Object.entries(patch ?? {})) result[key] = value && typeof value === 'object' && !Array.isArray(value)
    ? merge(result[key] && typeof result[key] === 'object' && !Array.isArray(result[key]) ? result[key] : {}, value) : structuredClone(value);
  return result;
}

function absoluteReferences(value, directory) {
  if (typeof value === 'string') return value.replace(/\{file:([^}]+)\}/g, (_, path) => `{file:${isAbsolute(path) || path.startsWith('~/') ? path : resolve(directory, path)}}`);
  if (Array.isArray(value)) return value.map(item => absoluteReferences(item, directory));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, absoluteReferences(item, directory)]));
  return value;
}

async function readAgents(directory) {
  const result = {};
  async function walk(root, prefix = '') {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const path = join(root, entry.name), name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) { await walk(path, `${name}/`); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const text = await readFile(path, 'utf8'), match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      if (!match) throw new Error(`OpenCode v2 无法读取 Agent 定义：${name}`);
      const definition = parseYaml(match[1]);
      if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error(`OpenCode v2 Agent 元信息无效：${name}`);
      result[name.slice(0, -3)] = { ...definition, prompt: `${absoluteReferences(match[2], directory)}\n\n${V2_INSTRUCTIONS}` };
    }
  }
  await walk(join(directory, 'agents'));
  await walk(join(directory, 'agent'));
  return result;
}

// v2.0.29 normalizes the legacy provider/agent/permission fields itself. Keep
// that proven migration boundary, but never feed a v1 plugin into its new host.
export async function prepareLaunch({ command = 'opencode2', environment = process.env, config, role, prompt = '', files = [], model, sessionId, cwd = process.cwd(), outputRoot, title } = {}) {
  const sourcePath = typeof config === 'string' ? resolve(config) : environment.OPENCODE_CONFIG;
  const sourceDirectory = sourcePath ? dirname(sourcePath) : environment.OPENCODE_CONFIG_DIR || join(cwd, '.opencode');
  let source = {};
  if (sourcePath) source = JSON.parse(await readFile(sourcePath, 'utf8'));
  if (config && typeof config === 'object') source = merge(source, config);
  const overlay = environment.OPENCODE_CONFIG_CONTENT ? JSON.parse(environment.OPENCODE_CONFIG_CONTENT) : {};
  const effective = absoluteReferences(merge(source, overlay), sourceDirectory);
  effective.agent = merge(await readAgents(sourceDirectory), effective.agent);
  if (role && !effective.agent[role] && !effective.agents?.[role]) throw new Error(`OpenCode v2 未配置审计角色：${role}`);
  delete effective.plugin;
  const nativePlugins = Array.isArray(effective.plugins) ? effective.plugins : [];
  effective.plugins = [...new Set([...nativePlugins, V2_PLUGIN_DIRECTORY])];
  effective.experimental = { ...effective.experimental, subagent_depth: effective.experimental?.subagent_depth ?? effective.subagent_depth ?? 2 };
  delete effective.subagent_depth; delete effective.server; delete effective.logLevel;
  const skillSources = Array.isArray(effective.skills) ? effective.skills : [...(effective.skills?.paths ?? []), ...(effective.skills?.urls ?? [])];
  effective.skills = [...new Set([join(sourceDirectory, 'skills'), ...skillSources.map(path => /^(?:[a-z]+:|~\/)/i.test(path) || isAbsolute(path) ? path : resolve(sourceDirectory, path))])];
  const engineRoot = resolve(sourceDirectory, '..');
  const servers = effective.mcp?.servers ?? effective.mcp ?? {};
  for (const server of Object.values(servers)) {
    if (server?.type !== 'local' || !Array.isArray(server.command)) continue;
    server.command = server.command.map(value => typeof value === 'string' && /^(?:\.{1,2}[\\/]|\.opencode[\\/])/.test(value) ? resolve(engineRoot, value) : value);
    if (server.cwd && !isAbsolute(server.cwd)) server.cwd = resolve(engineRoot, server.cwd);
  }
  if (Array.isArray(effective.instructions)) effective.instructions = effective.instructions.map(path => /^(?:[a-z]+:|~\/)/i.test(path) || isAbsolute(path) ? path : resolve(sourceDirectory, path));
  const destination = resolve(outputRoot || environment.AUDIT_WORKSPACE_ROOT || cwd, '.javelin-opencode-v2');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const configPath = join(destination, 'opencode.json');
  await writeFile(configPath, `${JSON.stringify(effective, null, 2)}\n`, { mode: 0o600 });
  const env = { ...environment, ...await isolatedStorage(environment, engineRoot), OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: destination,
    OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_CONFIG_PROJECT_DISABLE: 'true',
    JAVELIN_AGENT_ENGINE: 'opencode-v2' };
  delete env.OPENCODE_DB;
  const args = ['run', '--standalone', '--format', 'json'];
  if (role) args.push('--agent', role);
  if (model) args.push('--model', model);
  if (sessionId) args.push('--session', sessionId);
  if (title) args.push('--title', title);
  for (const file of files) args.push('--file', file);
  args.push(`${prompt}\n\n${V2_INSTRUCTIONS}`);
  return { command, args, environment: env, eventTransform: normalizeEvent, configPath };
}

export function normalizeEvent(event) {
  if (!event || typeof event !== 'object') return event;
  const result = structuredClone(event);
  if (result.type === 'error' && result.error && !result.error.name) {
    result.error = { ...result.error, name: result.error.type === 'aborted' ? 'AbortError' : 'UnknownError', data: { message: result.error.message } };
  }
  if (result.part?.type === 'tool') {
    result.part.callID ??= result.part.id;
    result.part.id ??= result.part.partID;
    // Preserve native names for accurate UI; expose normalized role metadata.
    if (result.part.tool === 'subagent' && result.part.state?.input) result.part.state.input.subagent_type ??= result.part.state.input.agent;
  }
  return result;
}
