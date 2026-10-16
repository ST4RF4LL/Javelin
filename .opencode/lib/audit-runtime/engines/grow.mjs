import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { readCheckpointSession } from './grow-session.mjs';
export { hasPersistedGrowSession, readCheckpointSession } from './grow-session.mjs';

const require = createRequire(import.meta.url);
const yaml = require('yaml');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERATED = '<!-- javelin-generated-grow-agent.v1 -->';
const TOOL_MAP = {
  read: ['read_file'], glob: ['grep', 'list_dir'], grep: ['grep'], list: ['list_dir'],
  edit: ['search_replace', 'write'], bash: ['run_terminal_command', 'get_command_or_subagent_output', 'kill_command_or_subagent'],
  lsp: ['lsp'], webfetch: ['web_fetch'], websearch: ['web_search'],
  task: ['spawn_subagent', 'get_command_or_subagent_output', 'kill_command_or_subagent', 'send_subagent_message', 'ask_subagent'],
};

export function serializeGrowConfig(config) {
  return stringifyToml(config);
}

async function optionalRead(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function privateWrite(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600);
}
export async function readGrowConfiguration(environment = process.env) {
  const home = resolve(environment.JAVELIN_GROW_USER_HOME || environment.GROW_HOME || join(homedir(), '.grow'));
  const raw = await optionalRead(join(home, 'config.toml'));
  if (!raw) return { home, config: {} };
  try { return { home, config: parseToml(raw.replace(/^\uFEFF/u, '')) }; }
  catch { throw new Error('Grow 的 config.toml 无法解析，请检查本机 Grow 配置。'); }
}
export async function growModelCatalog(environment = process.env) {
  const { config } = await readGrowConfiguration(environment);
  const models = Object.entries(config.provider ?? {}).flatMap(([provider, definition]) =>
    Object.entries(definition.models ?? {}).map(([id, model]) => ({ id: `${provider}/${id}`, name: model.name || id, provider,
      context_window: Number(model.context_window || definition.options?.context_window) || null })));
  return { default_model: config.models?.default || null, models };
}

function permissionAllows(permission, key) {
  const value = permission?.[key] ?? permission?.['*'] ?? 'allow';
  return typeof value === 'object' ? Object.values(value).some(item => item === 'allow') : value === 'allow';
}
function matches(pattern, value) {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`).test(value);
}
function allowedServers(definition, servers, name) {
  const rules = definition.permission ?? {};
  return Object.keys(servers).filter(server => {
    if (server === 'audit-current-session' && name !== 'security-audit-orchestrator') return false;
    const tool = `${server}_*`;
    const applicable = Object.entries(rules).filter(([pattern]) => pattern !== '*' && (matches(pattern, tool) || pattern.startsWith(`${server}_`)));
    if (applicable.some(([, value]) => value === 'deny')) return false;
    return applicable.some(([, value]) => value === 'allow') || rules['*'] === 'allow';
  });
}
function roleBody(definition) {
  const permission = definition.permission ?? {};
  return [
    '## Javelin / Grow 执行契约',
    '使用当前任务的 task-board、回执及报告协议；.opencode 是 Javelin 的规范文件目录，不代表必须启动 OpenCode。禁止再启动另一个主审计进程。',
    '技能可从技能目录加载，也可直接读取对应 SKILL.md。源码只读；只在当前任务明确指定的制品目录写报告。',
    '需要委派时使用 spawn_subagent，subagent_type 为指定角色名称，capability_mode 为 all，background 为 true；用 get_command_or_subagent_output 收集结果。独立三方复核必须使用三个不同的子会话，不得自己伪造它们的结果。',
    '当前角色不允许委派时，直接完成唯一工作包。不要调用 create_goal、工作流引擎或交互提问来创建第二套审计调度。',
    `当前角色权限声明（路径范围也必须遵守）：${JSON.stringify(permission)}`,
    String(definition.prompt || ''),
  ].join('\n\n');
}
function agentDefinition(name, definition, servers) {
  const tools = [...new Set(Object.entries(TOOL_MAP).filter(([key]) => definition.tools?.[key] !== false && permissionAllows(definition.permission, key)).flatMap(([, names]) => names))];
  // This field controls child inheritance only. Registration belongs to the
  // top-level session and must never become a delegated child's authority.
  const inherited = allowedServers(definition, servers, name).filter(server => server !== 'audit-current-session');
  // Grow treats an empty tools declaration as the stock profile. Keep the two
  // catalog meta-tools even with an empty catalog so a deny-all role stays closed.
  tools.push('search_tool', 'use_tool');
  return { name, description: definition.description || `Javelin ${name}`, tools, capabilityMode: 'all',
    mcpInheritance: inherited.length ? { named: inherited } : 'none' };
}
function renderAgent(name, definition, servers, { primaryTools = [] } = {}) {
  const header = agentDefinition(name, definition, servers);
  header.tools.unshift(...primaryTools.filter(tool => !header.tools.includes(tool)));
  return `---\n${yaml.stringify({ ...header, tools: header.tools.join(', ') }).trim()}\n---\n\n${GENERATED}\n\n${roleBody(definition)}\n`;
}
async function canonicalRoles(root, overrides) {
  const roles = {};
  if (root) {
    let entries = [];
    try { entries = await readdir(join(root, 'agents'), { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const content = await readFile(join(root, 'agents', entry.name), 'utf8');
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      roles[entry.name.slice(0, -3)] = match ? { ...yaml.parse(match[1]), prompt: match[2] } : { prompt: content };
    }
  }
  for (const [name, override] of Object.entries(overrides ?? {})) roles[name] = { ...roles[name], ...override,
    permission: { ...roles[name]?.permission, ...override.permission }, tools: { ...roles[name]?.tools, ...override.tools } };
  return roles;
}
function convertMcp(mcp = {}) {
  return Object.fromEntries(Object.entries(mcp).flatMap(([name, item]) => {
    if (item?.enabled === false) return [];
    if (item?.type === 'local' && Array.isArray(item.command) && item.command.length) return [[name, {
      command: item.command[0], args: item.command.slice(1), env: item.environment ?? {}, enabled: true,
      ...(Number.isFinite(item.timeout) ? { tool_timeout_sec: Math.ceil(item.timeout / 1000) } : {}),
    }]];
    if (item?.type === 'remote' && typeof item.url === 'string') return [[name, { url: item.url, headers: item.headers ?? {}, enabled: true }]];
    return [];
  }));
}

/** Prepare a private headless Grow session; never starts a process or modifies the user's Grow home. */
export async function prepareLaunch({ command = 'grow', environment = process.env, config = {}, role, prompt, files = [], model = null,
  sessionId: resumeId = null, cwd, outputRoot, title = null }) {
  if (!cwd || !outputRoot || !role || !/^[a-zA-Z0-9._-]+$/.test(role)) throw new Error('Grow 启动参数缺少工作目录、私有输出目录或有效角色。');
  if (resumeId && !UUID.test(resumeId)) throw new Error('Grow 恢复需要真实的 UUID 会话编号。');
  // Grow 2.2.2 may reuse persisted ACP event IDs when a resumed process delegates
  // again. Its native fork preserves the history while allocating a fresh event
  // namespace. Keep the home stable so every fork can locate its parent history.
  const sessionHome = resolve(outputRoot, 'grow-home');
  const resumedFromSessionId = resumeId ? readCheckpointSession(sessionHome, resumeId) : null;
  const sessionId = randomUUID();
  const configuredHome = resumeId && await optionalRead(join(sessionHome, 'config.toml'));
  const source = configuredHome ? { home: environment.JAVELIN_GROW_USER_HOME || environment.GROW_HOME || join(homedir(), '.grow'), config: parseToml(configuredHome) } : await readGrowConfiguration(environment);
  const definitions = await canonicalRoles(environment.OPENCODE_CONFIG_DIR, config.agent);
  if (!definitions[role]) throw new Error(`找不到 Grow 审计角色：${role}`);
  let mcp = convertMcp(config.mcp);
  const allowed = allowedServers(definitions[role], mcp, role);
  mcp = Object.fromEntries(Object.entries(mcp).filter(([name]) => allowed.includes(name)));
  const selected = definitions[role];
  // Grow validates all three workspace capability categories on a primary role.
  // Declare missing host-required tools but deny their calls explicitly. This
  // keeps MCP-only workers constrained without weakening their permission map.
  const selectedTools = agentDefinition(role, selected, mcp).tools;
  const primaryTools = [], primaryDenials = [];
  if (!selectedTools.some(tool => ['read_file', 'grep', 'list_dir'].includes(tool))) { primaryTools.push('read_file'); primaryDenials.push('Read'); }
  if (!selectedTools.includes('search_replace')) { primaryTools.push('search_replace'); primaryDenials.push('Write', 'Edit'); }
  if (!selectedTools.includes('run_terminal_command')) { primaryTools.push('run_terminal_command'); primaryDenials.push('Bash'); }
  const canDelegate = selected.tools?.task !== false && permissionAllows(selected.permission, 'task');
  const growConfig = { ...source.config,
    cli: { ...source.config.cli, auto_update: false, use_leader: false },
    models: { ...source.config.models, ...(model ? { default: model } : {}) },
    skills: { ...source.config.skills, paths: environment.OPENCODE_CONFIG_DIR ? [join(environment.OPENCODE_CONFIG_DIR, 'skills')] : [] },
    subagents: { ...source.config.subagents, enabled: canDelegate, permission_mode: 'always-approve', max_depth: Math.max(2, Number(source.config.subagents?.max_depth) || 2) },
    mcp_servers: mcp, plugins: { paths: [], disabled: source.config.plugins?.disabled ?? [] },
  };
  await mkdir(sessionHome, { recursive: true, mode: 0o700 });
  await privateWrite(join(sessionHome, 'config.toml'), serializeGrowConfig(growConfig));
  const selectedAgent = join(sessionHome, 'agents', `${role}.md`);
  await privateWrite(selectedAgent, renderAgent(role, selected, mcp, { primaryTools }));
  const inlineAgents = {};
  if (canDelegate) {
    // Grow 2.2.2 does not discover agents under an overridden GROW_HOME. Inline
    // definitions keep each launch isolated without touching the audited cwd.
    // Full instructions stay in files to avoid Windows' command-line limit.
    for (const [name, definition] of Object.entries(definitions)) {
      const path = join(sessionHome, 'agents', `${name}.md`);
      if (name !== role) await privateWrite(path, renderAgent(name, definition, mcp));
      if (name === 'security-audit-orchestrator' || name === role) continue;
      inlineAgents[name] = { ...agentDefinition(name, definition, mcp), prompt: permissionAllows(definition.permission, 'read')
        ? `先完整读取 ${JSON.stringify(path)}，将其中 Markdown 正文作为当前角色的执行规范；文件内路径限制也必须遵守。`
        : roleBody(definition) };
    }
  }
  const attachments = await Promise.all(files.map(async file => `\n\n<javelin-input path=${JSON.stringify(resolve(file))}>\n${await readFile(file, 'utf8')}\n</javelin-input>`));
  const promptPath = join(sessionHome, `prompt-${randomUUID()}.txt`);
  await privateWrite(promptPath, `${title ? `任务：${title}\n\n` : ''}${prompt}${attachments.join('')}`);
  const env = { ...environment, GROW_HOME: sessionHome, JAVELIN_GROW_USER_HOME: resolve(source.home), GROW_DISABLE_AUTOUPDATER: '1',
    GROW_MEMORY: '0', GROW_WORKFLOWS: '0', GROW_GOAL: '0', GROW_SUBAGENTS: canDelegate ? '1' : '0' };
  // Keep the canonical config directory only in Javelin's parent process, not in the child engine.
  for (const name of Object.keys(env)) if (name.startsWith('OPENCODE_')) delete env[name];
  const args = ['--cwd', cwd, '--agent', selectedAgent, '--prompt-file', promptPath, '--output-format', 'streaming-json',
    '--permission-mode', 'always-approve', '--no-memory', '--no-plan', ...(canDelegate ? [] : ['--no-subagents']),
    ...primaryDenials.flatMap(rule => ['--deny', rule]),
    ...(canDelegate ? ['--agents', JSON.stringify(inlineAgents)] : []),
    ...(resumedFromSessionId ? ['--resume', resumedFromSessionId, '--fork-session'] : []), '--session-id', sessionId,
    ...(model ? ['--model', model] : [])];
  await privateWrite(join(sessionHome, 'javelin-session.json'), JSON.stringify({
    schema: 'javelin-grow-session.v1', sessionId, resumedFromSessionId, cwd: resolve(cwd), role,
    childRoles: Object.keys(inlineAgents), canDelegate, primaryDenials, model,
    userHome: resolve(source.home),
  }, null, 2));
  const eventState = { sessionId, tools: new Map() };
  return { command, args, environment: env, sessionId, resumedFromSessionId, sessionHome, agentDirectory: join(sessionHome, 'agents'),
    eventTransform: event => normalizeGrowEvent(event, eventState) };
}

/** Called only after the caller has paused the audit and acquired its terminal lease.
 * Grow's --agents is headless-only, so TUI child roles must be discoverable in the
 * platform-owned execution workspace. The audited source directory is never used.
 */
export async function prepareCheckpointTui({ sessionHome, sessionId, forkSessionId = randomUUID(), cwd, command = 'grow', environment = process.env }) {
  if (!sessionHome || !UUID.test(sessionId || '') || !cwd) throw new Error('Grow 交互恢复缺少有效会话和执行目录。');
  if (!UUID.test(forkSessionId) || forkSessionId === sessionId) throw new Error('Grow 交互恢复需要新的分支会话编号。');
  let manifest;
  try { manifest = JSON.parse(await readFile(join(sessionHome, 'javelin-session.json'), 'utf8')); }
  catch { throw new Error('缺少 Grow 会话角色记录，请先从工作台恢复一次任务以更新会话配置。'); }
  const validRole = name => typeof name === 'string' && /^[a-zA-Z0-9._-]+$/.test(name) && !['.', '..'].includes(name);
  if (manifest.schema !== 'javelin-grow-session.v1' || readCheckpointSession(sessionHome, manifest.sessionId) !== sessionId || manifest.cwd !== resolve(cwd)
    || !validRole(manifest.role) || !Array.isArray(manifest.childRoles) || !manifest.childRoles.every(validRole)) {
    throw new Error('Grow 会话与执行目录或审计角色不匹配。');
  }
  const agentDirectory = join(resolve(sessionHome), 'agents');
  const selectedAgent = join(agentDirectory, `${manifest.role}.md`);
  const selectedContent = await readFile(selectedAgent, 'utf8');
  if (!selectedContent.includes(GENERATED)) throw new Error('Grow 主审计角色记录无效。');
  const interactiveAgent = join(agentDirectory, `interactive-${manifest.role}.md`);
  const children = manifest.childRoles.filter(name => name !== manifest.role && name !== 'security-audit-orchestrator');
  // Inspect every destination before writing so existing user-authored roles are
  // never partially overwritten even if this API is called with a wrong cwd.
  const copies = await Promise.all(children.map(async name => {
    const destination = join(cwd, '.grow', 'agents', `${name}.md`);
    const previous = await optionalRead(destination);
    const content = await readFile(join(agentDirectory, `${name}.md`), 'utf8');
    if (!content.includes(GENERATED) || (previous && !previous.includes(GENERATED))) throw new Error(`Grow 子角色 ${name} 与现有项目文件冲突。`);
    return { destination, content };
  }));
  for (const { destination, content } of copies) await privateWrite(destination, content);
  await privateWrite(interactiveAgent, `${selectedContent}\n\n## 暂停检查会话的操作边界\n后台审计任务已暂停；这是供检查代码、解释现有结果和记录后续指导的交互分支。此约束优先于上面的正常执行角色规则。不要领取、发布、交付、复核或封存任务，不修改审计报告或回执，不调用审计动态测试，不尝试重启后台调度。用户在此追加的指令由工作台恢复任务后，在继承当前分支历史的后台审计会话中执行；当前只记录并说明执行计划。\n`);
  await privateWrite(join(sessionHome, 'javelin-interactive-head.json'), JSON.stringify({
    schema: 'javelin-grow-interactive-head.v1', baseSessionId: manifest.sessionId,
    parentSessionId: sessionId, sessionId: forkSessionId, cwd: resolve(cwd), preparedAt: new Date().toISOString(),
  }, null, 2));
  const env = { ...environment, GROW_HOME: resolve(sessionHome), JAVELIN_GROW_USER_HOME: manifest.userHome,
    GROW_DISABLE_AUTOUPDATER: '1', GROW_MEMORY: '0', GROW_WORKFLOWS: '0', GROW_GOAL: '0', GROW_SUBAGENTS: manifest.canDelegate ? '1' : '0' };
  for (const name of Object.keys(env)) if (name.startsWith('OPENCODE_')) delete env[name];
  const denials = Array.isArray(manifest.primaryDenials) ? manifest.primaryDenials.filter(rule => ['Read', 'Write', 'Edit', 'Bash'].includes(rule)) : [];
  const args = ['--cwd', resolve(cwd), '--agent', interactiveAgent, '--resume', sessionId, '--fork-session', '--session-id', forkSessionId,
    '--permission-mode', 'ask', '--no-memory', '--no-plan',
    ...(manifest.canDelegate ? [] : ['--no-subagents']), ...denials.flatMap(rule => ['--deny', rule]),
    ...(manifest.model ? ['--model', manifest.model] : [])];
  return { command, args, environment: env, sessionId: forkSessionId, resumedFromSessionId: sessionId, sessionHome: resolve(sessionHome), agentDirectory };
}

/** Project Grow's native NDJSON onto the existing monitor contract; aggregate end usage is not counted twice. */
export function normalizeGrowEvent(event, state = {}) {
  if (!event || typeof event !== 'object') return null;
  const liveUpdate = ['text', 'thought', 'tool_call', 'tool_call_update', 'usage', 'plan', 'end'].includes(event.type);
  const sessionID = event.sessionId || event.session_id || (liveUpdate ? state.sessionId : null) || null;
  const base = { sessionID, timestamp: event.timestamp || Date.now(), engine: 'grow' };
  if (event.type === 'text' || event.type === 'thought') return { ...base, type: event.type === 'thought' ? 'reasoning' : 'text',
    part: { type: event.type === 'thought' ? 'reasoning' : 'text', text: String(event.data ?? '') } };
  if (event.type === 'tool_call' || event.type === 'tool_call_update') {
    const key = event.toolCallId;
    const previous = state.tools?.get(key) ?? {};
    const merged = { ...previous, ...Object.fromEntries(Object.entries(event).filter(([, value]) => value !== null && value !== undefined)) };
    state.tools?.set(key, merged);
    const status = merged.status === 'in_progress' ? 'running' : merged.status === 'failed' ? 'error' : merged.status || 'running';
    return { ...base, type: 'tool_use', part: { type: 'tool', tool: merged.toolName || merged.title || 'grow-tool', callID: key,
      state: { status, input: merged.rawInput ?? {}, output: typeof merged.rawOutput === 'string' ? merged.rawOutput : JSON.stringify(merged.rawOutput ?? merged.content ?? ''),
        title: merged.title || merged.toolName || '' } } };
  }
  if (event.type === 'usage') {
    const usage = event.usage ?? {};
    const input = Number(usage.input_tokens) || 0, output = Number(usage.output_tokens) || 0;
    const read = Number(usage.cache_read_input_tokens) || 0, write = Number(usage.cache_creation_input_tokens) || 0;
    return { ...base, type: 'step_finish', part: { type: 'step-finish', reason: event.stopReason, messageID: event.messageId,
      tokens: { input, output, reasoning: Number(usage.reasoning_tokens) || 0, total: input + output + read + write, cache: { read, write } } } };
  }
  if (event.type === 'error') return { ...base, type: 'error', error: { name: 'GrowError', data: { message: String(event.message || 'Grow 执行失败。') } } };
  if (event.type === 'end') return { ...base, type: 'session_end', stopReason: event.stopReason, requestId: event.requestId,
    usage_summary: event.usage ?? null, usage_is_incomplete: event.usage_is_incomplete === true };
  return { ...event, ...base };
}
