#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, appendFile, stat, mkdir, readdir, copyFile, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildOpenCodeEnvironment } from '../web/dynamic-validation-observatory/opencode-runtime-config.mjs';
import { prepareAgentLaunch } from '../lib/audit-runtime/engines/index.mjs';
import { AgentSettingsStore, normalizeAgentCommand } from '../lib/audit-runtime/agent-settings.mjs';

const platformRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const role = 'security-audit-orchestrator';
export function parseArguments(args) {
  const options = { engine: 'opencode', cwd: process.cwd() };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help' || args[index] === '-h') { options.help = true; continue; }
    if (args[index] === '--prepare-only') { options.prepareOnly = true; continue; }
    const key = { '--engine': 'engine', '--cwd': 'cwd', '--command': 'command', '--output-root': 'outputRoot' }[args[index]];
    if (!key || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`无效参数：${args[index]}`);
    options[key] = args[++index];
  }
  if (!['opencode', 'opencode-v2', 'grow'].includes(options.engine)) throw new Error('engine 必须为 opencode、opencode-v2 或 grow。');
  return options;
}

export async function prepareNativeLaunch({ engine = 'opencode', command, cwd = process.cwd(), outputRoot, environment = process.env,
  configPath = join(platformRoot, '.opencode', 'opencode.json'), prepare = prepareAgentLaunch } = {}) {
  cwd = resolve(cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error('Agent 工作目录不是目录。');
  const root = outputRoot ? resolve(outputRoot) : join(platformRoot, 'workspace', 'native-agent-sessions', randomUUID());
  const env = await buildOpenCodeEnvironment(configPath, environment);
  // A native entry has not registered an audit yet. Never inherit a parent
  // managed task's identity or impersonate its execution ownership.
  for (const key of Object.keys(env)) if (key.startsWith('AUDIT_') && key !== 'AUDIT_SERVICE_ROOT') delete env[key];
  env.AUDIT_ENGINE_ROOT = platformRoot;
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.mcp = { ...config.mcp, ...JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}').mcp };
  config.default_agent = role;
  if (engine === 'grow') {
    config.mcp ??= {};
    config.mcp['audit-current-session'] = { type: 'local', command: [process.execPath, join(platformRoot, '.opencode', 'scripts', 'audit-session-mcp.mjs')], enabled: true };
  }
  const executionDirectory = engine === 'grow' ? join(root, 'native-workspace') : cwd;
  if (engine === 'grow') await mkdir(executionDirectory, { recursive: true, mode: 0o700 });
  const launch = await prepare({ engine, command: command ?? { opencode: 'opencode', 'opencode-v2': 'opencode2', grow: 'grow' }[engine],
    environment: env, config, role, prompt: '', cwd: executionDirectory, outputRoot: root });
  if (engine === 'opencode-v2') {
    // A private server reads this launch's isolated role/plugin configuration.
    // Reusing a pre-existing daemon could silently reuse unrelated settings.
    return { ...launch, args: ['--standalone', cwd], cwd, engine };
  }
  if (engine === 'grow') {
    const agentFile = launch.args[launch.args.indexOf('--agent') + 1];
    if (!agentFile || !launch.sessionId) throw new Error('Grow 未提供原生角色文件或会话编号。');
    const nativeCwd = executionDirectory;
    await mkdir(join(nativeCwd, '.grow', 'agents'), { recursive: true, mode: 0o700 });
    if (launch.agentDirectory) for (const entry of await readdir(launch.agentDirectory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== `${role}.md`) await copyFile(join(launch.agentDirectory, entry.name), join(nativeCwd, '.grow', 'agents', entry.name));
    }
    await symlink(dirname(configPath), join(nativeCwd, '.opencode'), process.platform === 'win32' ? 'junction' : 'dir');
    await appendFile(agentFile, `\n\n## 原生当前会话登记\n本次 Grow 由 CLI --session-id 预配的真实会话 UUID 为 ${launch.sessionId}，engine 为 grow，实际当前目录 directory 为 ${nativeCwd}。用户选择的审计源码目录 source_root 为 ${cwd}。这是宿主会话编号，不得换成随机 ID 或业务任务 ID。用户要求开始审计后，使用 audit-current-session MCP 的 audit_register，传入 engine、session_id、directory 及 source_root；继续在当前会话执行返回的 prompt，不另起主审计会话。没有 AUDIT_TASK_PROTOCOL 环境变量时，任务板等命令使用 audit_command，定期 audit_checkpoint 同步进度和校验报告。若运行时显示会话 UUID 与上面不同，停止登记并报告身份不符。\n`);
    return { ...launch, args: ['--cwd', nativeCwd, '--agent', agentFile, '--session-id', launch.sessionId, '--permission-mode', 'ask', '--no-memory', '--no-plan'],
      environment: { ...launch.environment, JAVELIN_AGENT_SESSION_ID: launch.sessionId, JAVELIN_AGENT_ENGINE: 'grow' }, cwd: nativeCwd, sourceRoot: cwd, engine };
  }
  return { ...launch, args: [cwd, '--agent', role], cwd, engine };
}

export async function resolveNativeCommand({ engine, command, environment = process.env, store } = {}) {
  const stateRoot = environment.AUDIT_WORKBENCH_STATE_ROOT || join(platformRoot, 'reports', 'platform', 'audit-runs');
  const settings = store ?? new AgentSettingsStore({ path: join(dirname(resolve(stateRoot)), 'agent-settings.json'), environment });
  // Explicit command selection is a one-launch override; never update the
  // saved Web default, and do not let persisted settings override this flag.
  return command ? settings.inspect(engine, normalizeAgentCommand(command)) : settings.resolve(engine);
}

export async function main(args = process.argv.slice(2), { spawnProcess = spawn, store, environment = process.env } = {}) {
  const options = parseArguments(args);
  if (options.help) {
    process.stdout.write('用法：node .opencode/scripts/coding-agent.mjs --engine opencode|opencode-v2|grow [--cwd 源码目录] [--command 可执行文件] [--prepare-only]\n打开配置好的原生交互会话；输入审计要求后才登记任务，不自动启动审计或调用模型。\n');
    return;
  }
  const available = await resolveNativeCommand({ ...options, store, environment });
  if (!available.available) throw new Error(available.reason);
  const launch = await prepareNativeLaunch({ ...options, command: available.command, environment });
  process.stdout.write(`已准备 ${options.engine} 原生交互入口。请在打开的会话输入审计要求；登记将沿用该会话。\n`);
  if (options.prepareOnly) {
    process.stdout.write(`${JSON.stringify({ command: launch.command, args: launch.args, directory: launch.cwd,
      config_path: launch.environment.OPENCODE_CONFIG ?? join(launch.environment.GROW_HOME, 'config.toml'), session_id: launch.sessionId ?? null }, null, 2)}\n`);
    return;
  }
  const child = spawnProcess(launch.command, launch.args, { cwd: launch.cwd, env: launch.environment, shell: false, stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    process.exitCode = result.code ?? (result.signal ? 1 : 0);
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
