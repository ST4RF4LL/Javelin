import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { prepareLaunch, normalizeEvent, V2_PLUGIN_DIRECTORY } from '../lib/audit-runtime/engines/opencode-v2.mjs';
import { createV2Plugin } from '../lib/audit-runtime/engines/opencode-v2-plugin.mjs';
import { startSharedRun } from '../lib/audit-runtime/engines/opencode-v2-shared.mjs';
import { parseArguments, prepareNativeLaunch, resolveNativeCommand } from '../scripts/coding-agent.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'javelin-v2-')), config = join(root, '.opencode');
  await mkdir(join(config, 'agents'), { recursive: true });
  await writeFile(join(config, 'agents', 'security-audit-orchestrator.md'), '---\nmode: primary\npermission:\n  task: allow\n  question: deny\n---\n读取原审计协议；不要扩大动态授权。\n');
  await writeFile(join(config, 'opencode.json'), JSON.stringify({ permission: { question: 'deny' }, provider: { internal: { options: { baseURL: 'https://llm.invalid/v1' } } },
    plugin: ['./old-v1-plugin.mjs'], subagent_depth: 2, mcp: { browser: { enabled: false } } }));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, config, environment: { JAVELIN_OPENCODE_V2_HOME: join(root, 'agent-data'), XDG_DATA_HOME: join(root, 'old-data'), OPENCODE_CONFIG: join(config, 'opencode.json'), OPENCODE_CONFIG_DIR: config,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { 'security-audit-orchestrator': { permission: { edit: 'deny' } } }, mcp: { browser: { enabled: false } } }) } };
}

test('v2 launch isolates legacy plugins while preserving actual roles, permissions, providers, skills and resume', async t => {
  const f = await fixture(t), before = await readFile(f.environment.OPENCODE_CONFIG, 'utf8');
  const launch = await prepareLaunch({ command: '/custom/opencode2', environment: f.environment, role: 'security-audit-orchestrator', prompt: '开始审计',
    files: ['/tmp/input.json'], model: 'internal/model#high', sessionId: 'ses_existing', cwd: f.root, outputRoot: join(f.root, 'run') });
  const config = JSON.parse(await readFile(launch.environment.OPENCODE_CONFIG, 'utf8'));
  assert.equal(launch.command, '/custom/opencode2'); assert.deepEqual(launch.args.slice(0, 4), ['run', '--standalone', '--format', 'json']);
  assert.equal(launch.args[launch.args.indexOf('--session') + 1], 'ses_existing');
  assert.equal(launch.args[launch.args.indexOf('--model') + 1], 'internal/model#high');
  assert.match(config.agent['security-audit-orchestrator'].prompt, /不要扩大动态授权/);
  assert.match(config.agent['security-audit-orchestrator'].prompt, /subagent_type 参数对应 agent/);
  assert.deepEqual(config.agent['security-audit-orchestrator'].permission, { task: 'allow', question: 'deny', edit: 'deny' });
  assert.equal(config.provider.internal.options.baseURL, 'https://llm.invalid/v1');
  assert.equal(config.mcp.browser.enabled, false); assert.deepEqual(config.plugins, [V2_PLUGIN_DIRECTORY]);
  assert.equal(config.plugin, undefined); assert.equal(config.experimental.subagent_depth, 2);
  assert.deepEqual(config.skills, [join(f.config, 'skills')]);
  assert.equal(launch.environment.OPENCODE_CONFIG_CONTENT, '{}');
  assert.equal(launch.environment.OPENCODE_CONFIG_PROJECT_DISABLE, 'true');
  assert.equal(await readFile(f.environment.OPENCODE_CONFIG, 'utf8'), before);
  assert.equal((await stat(launch.configPath)).mode & 0o777, 0o600);
});

test('v2 data stays separate from v1 and stable across runs while importing only first-use credentials', async t => {
  const f = await fixture(t), previous = join(f.environment.XDG_DATA_HOME, 'opencode');
  await mkdir(previous, { recursive: true });
  await writeFile(join(previous, 'auth.json'), '{"fixture":{"type":"api","key":"fixture-only"}}');
  await writeFile(join(previous, 'opencode.db'), 'v1 database untouched');
  const first = await prepareLaunch({ environment: { ...f.environment, OPENCODE_DB: join(previous, 'opencode.db') }, cwd: f.root, outputRoot: join(f.root, 'run-one') });
  const second = await prepareLaunch({ environment: f.environment, cwd: f.root, outputRoot: join(f.root, 'run-two') });
  assert.equal(first.environment.XDG_DATA_HOME, second.environment.XDG_DATA_HOME);
  assert.notEqual(first.environment.XDG_DATA_HOME, f.environment.XDG_DATA_HOME);
  assert.equal(first.environment.OPENCODE_DB, undefined);
  assert.equal(await readFile(join(previous, 'opencode.db'), 'utf8'), 'v1 database untouched');
  const privateAuth = join(first.environment.XDG_DATA_HOME, 'opencode', 'auth.json');
  assert.match(await readFile(privateAuth, 'utf8'), /fixture-only/);
  assert.equal((await stat(privateAuth)).mode & 0o777, 0o600);
  await writeFile(privateAuth, '{"fixture":"updated-by-v2"}');
  await prepareLaunch({ environment: f.environment, cwd: f.root });
  assert.equal(await readFile(privateAuth, 'utf8'), '{"fixture":"updated-by-v2"}');
});

test('v2 launch rejects missing roles rather than silently running general build', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareLaunch({ environment: f.environment, role: 'missing-agent', cwd: f.root }), /未配置审计角色/);
});

test('v2 JSON keeps real session IDs and tool names, with compatible error and subagent metadata', () => {
  const source = { type: 'tool_use', sessionID: 'ses_child', part: { type: 'tool', partID: 'prt_x', id: 'call_x', tool: 'subagent', state: { input: { agent: 'python-source-auditor' } } } };
  const event = normalizeEvent(source);
  assert.equal(event.sessionID, 'ses_child'); assert.equal(event.part.callID, 'call_x');
  assert.equal(event.part.tool, 'subagent'); assert.equal(event.part.state.input.subagent_type, 'python-source-auditor');
  assert.equal(source.part.callID, undefined);
  const error = normalizeEvent({ type: 'error', error: { type: 'unknown', message: 'The operation timed out.' } });
  assert.equal(error.error.data.message, 'The operation timed out.'); assert.equal(error.error.name, 'UnknownError');
});

function pluginContext() {
  const hooks = {}, tools = new Map(), queue = []; let wake;
  const subscription = { async *[Symbol.asyncIterator]() { while (true) { if (!queue.length) await new Promise(resolve => { wake = resolve; }); const next = queue.shift(); if (!next) return; yield next; } } };
  const register = name => async (kind, callback) => { hooks[`${name}.${kind}`] = callback; return { async dispose() {} }; };
  const sessionCalls = [];
  const ctx = { location: { directory: '/source' }, session: { hook: register('session'),
    async interrupt(input) { sessionCalls.push(['interrupt', input]); }, async switchAgent(input) { sessionCalls.push(['agent', input]); }, async prompt(input) { sessionCalls.push(['prompt', input]); } },
    tool: { hook: register('tool'), async transform(callback) { callback({ add(tool) { tools.set(tool.name, tool); }, update(name, update) { if (tools.has(name)) update(tools.get(name)); } }); return { async dispose() {} }; } },
    shell: { hook: register('shell') }, event: { subscribe({ signal }) { signal.addEventListener('abort', () => { queue.push(null); wake?.(); }); return subscription; } } };
  return { ctx, hooks, tools, sessionCalls, emit(event) { queue.push(event); wake?.(); } };
}

test('v2 watchdog maps real role/subagent identity and preserves non-text tool content', async () => {
  const p = pluginContext(), seen = [];
  const cleanup = await createV2Plugin({ environment: { AUDIT_TASK_PROTOCOL: 'task-board.v1' }, watchdogFactory: async () => ({
    'chat.message': async input => seen.push(input),
    'experimental.chat.system.transform': async (_input, output) => output.system.push('检查真实交付缺口'),
    'tool.execute.after': async (input, output) => { seen.push(input); output.output += '\n仍有缺口'; },
  }) }).setup(p.ctx);
  const context = { sessionID: 'ses_main', agent: 'security-audit-orchestrator', system: [] };
  await p.hooks['session.context'](context); assert.deepEqual(context.system, [{ type: 'text', text: '检查真实交付缺口' }]);
  const event = { status: 'completed', tool: 'subagent', sessionID: 'ses_main', input: { agent: 'python-source-auditor' },
    result: { content: [{ type: 'text', text: '报告' }, { type: 'file', uri: 'file:///evidence', mime: 'application/json' }] } };
  await p.hooks['tool.execute.after'](event);
  assert.equal(seen.at(-1).args.subagent_type, 'python-source-auditor'); assert.equal(event.result.content[1].type, 'file');
  assert.match(event.result.content.at(-1).text, /仍有缺口/);
  const retry = { sessionID: 'ses_main', error: { type: 'unknown', message: 'The operation timed out.' }, decision: { retry: true, delay: 10 } };
  p.hooks['session.retry'](retry); assert.deepEqual(retry.decision, { retry: false }); await cleanup();
});

test('v2 native registration keeps the actual current session and injects isolated per-session shell environment', async () => {
  const p = pluginContext(), calls = [], shellEnvironments = [];
  p.tools.set('shell', { async execute() { const shell = { env: {} }; await p.hooks['shell.create.before'](shell); shellEnvironments.push(shell.env); return { content: 'ok' }; } });
  const cleanup = await createV2Plugin({ environment: {}, api: { async call(operation, input) {
    calls.push({ operation, input });
    if (operation === 'register') return { audit: { id: 'audit-fixture', status: 'running' }, client_id: 'native-client', heartbeat_ms: 999999,
      workspace_root: '/frozen-workspace', prompt: '只执行当前审计', environment: { AUDIT_ID: 'audit-fixture' } };
    return { status: 'pausing', command: { id: 'pause-one', action: 'pause' } };
  } }, watchdogFactory: async () => ({}) }).setup(p.ctx);
  await p.tools.get('audit_register').execute({ source_root: '/source' }, { sessionID: 'ses_actual', agent: 'security-audit-orchestrator' });
  assert.equal(calls[0].input.session.engine, 'opencode-v2'); assert.equal(calls[0].input.session.session_id, 'ses_actual');
  const before = { tool: 'shell', sessionID: 'ses_actual', input: { command: 'node task-board.mjs status' } };
  await p.hooks['tool.execute.before'](before); assert.equal(before.input.workdir, '/frozen-workspace');
  await p.tools.get('shell').execute({}, { sessionID: 'ses_actual' });
  await p.tools.get('shell').execute({}, { sessionID: 'ses_unrelated' });
  assert.equal(shellEnvironments[0].AUDIT_ID, 'audit-fixture'); assert.equal(shellEnvironments[1].AUDIT_ID, undefined);
  p.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_actual' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(p.sessionCalls[0], ['interrupt', { sessionID: 'ses_actual' }]);
  await assert.rejects(p.hooks['tool.execute.before'](before), /暂停/);
  await cleanup();
});

function fakeChild() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.pid = 990001; child.exitCode = null; child.signalCode = null;
  child.finish = (code = 0, signal = null) => { if (child.exitCode !== null || child.signalCode !== null) return; child.exitCode = code; child.signalCode = signal; child.emit('close', code, signal); };
  child.kill = signal => { queueMicrotask(() => child.finish(null, signal)); return true; }; return child;
}

test('v2 shared server uses real v2 endpoints, owns stdin lease, binds same session to JSON/TUI and hides credentials', async t => {
  const f = await fixture(t), launches = [], requests = [], lines = []; let binding;
  const spec = { command: 'opencode2', cwd: f.root, state_directory: f.root, audit_id: 'audit-v2', args: ['run', '--standalone', '--format', 'json', '--agent', 'security-audit-orchestrator', '开始'] };
  const result = await startSharedRun(spec, { environment: f.environment, output: text => lines.push(text.toString()),
    spawnProcess(command, args, options) {
      const child = fakeChild(); launches.push({ command, args, options, child });
      if (args[0] === 'serve') setImmediate(() => child.stdout.write('{"url":"http://127.0.0.1:47891"}\n'));
      else setImmediate(async () => { binding = JSON.parse(await readFile(join(f.root, 'opencode-server.json'), 'utf8')); child.finish(); });
      return child;
    }, async fetcher(url, options) {
      requests.push({ url, options });
      return new Response(JSON.stringify(url.endsWith('/api/info') ? { version: '2.0.29' } : { data: { id: 'ses_v2_real' } }), { status: 200 });
    } });
  assert.equal(result.code, 0); assert.deepEqual(launches[0].args, ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0']);
  assert.equal(launches[0].options.stdio[0], 'pipe'); assert.equal(launches[0].child.stdin.writableEnded, true);
  assert.equal(launches[1].args.includes('--standalone'), false); assert.equal(launches[1].args.includes('--attach'), false);
  assert.equal(launches[1].args[launches[1].args.indexOf('--server') + 1], 'http://127.0.0.1:47891');
  assert.equal(launches[1].args[launches[1].args.indexOf('--session') + 1], 'ses_v2_real');
  assert.equal(binding.schema_version, 'opencode-v2-shared-run.v1'); assert.equal(binding.session_id, 'ses_v2_real');
  assert.equal(binding.username, undefined); assert.equal(binding.password, launches[0].options.env.OPENCODE_PASSWORD);
  assert.equal(JSON.parse(requests[1].options.body).location.directory, f.root);
  assert.doesNotMatch(lines.join(''), new RegExp(binding.password));
  await assert.rejects(readFile(join(f.root, 'opencode-server.json')), { code: 'ENOENT' });
});

test('v2 shared server fails closed on incompatible server version and reaps only its owned child', async t => {
  const f = await fixture(t), launches = [];
  await assert.rejects(startSharedRun({ command: 'opencode2', cwd: f.root, state_directory: f.root, args: ['run', '审计'] }, {
    environment: {}, output() {}, spawnProcess(_command, args) { const child = fakeChild(); launches.push(child); setImmediate(() => child.stdout.write('{"url":"http://127.0.0.1:47891"}\n')); return child; },
    async fetcher() { return new Response('{"version":"1.18.34"}'); },
  }), /版本不匹配/);
  assert.equal(launches.length, 1); assert.equal(launches[0].signalCode, 'SIGTERM');
});

test('v2 shared pause interrupts the same server session and resume reuses it without a new task', async t => {
  const f = await fixture(t), launches = [], requests = [];
  const running = startSharedRun({ command: 'opencode2', cwd: f.root, state_directory: f.root, controllable: true,
    args: ['run', '--standalone', '--format', 'json', '--session', 'ses_resume', '原始提示词'] }, {
    environment: {}, output() {}, spawnProcess(_command, args) { const child = fakeChild(); launches.push({ args: [...args], child });
      if (args[0] === 'serve') setImmediate(() => child.stdout.write('{"url":"http://127.0.0.1:47891"}\n')); return child; },
    async fetcher(url) { requests.push(url); return new Response(JSON.stringify(url.endsWith('/api/info') ? { version: '2.0.29' } : url.endsWith('/interrupt') ? { interrupted: true } : { data: { id: 'ses_resume' } })); },
  });
  const until = async predicate => { for (let index = 0; index < 100; index++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } throw new Error('test deadline'); };
  await until(() => launches.length === 2);
  process.emit('message', { type: 'audit-control', id: 'pause-v2', action: 'pause' });
  await until(() => requests.some(url => url.endsWith('/api/session/ses_resume/interrupt')));
  process.emit('message', { type: 'audit-control', id: 'resume-v2', action: 'resume' });
  await until(() => launches.length === 3);
  assert.equal(launches[2].args[launches[2].args.indexOf('--session') + 1], 'ses_resume');
  assert.match(launches[2].args.at(-1), /继续当前审计会话/);
  assert.equal(requests.filter(url => url.endsWith('/api/session')).length, 0);
  launches[2].child.finish(); assert.equal((await running).code, 0);
});

test('native launcher prepares v2 TUI without a prompt and clears inherited managed audit identity', async t => {
  const f = await fixture(t);
  const launch = await prepareNativeLaunch({ engine: 'opencode-v2', command: '/opencode2', cwd: f.root, configPath: f.environment.OPENCODE_CONFIG,
    environment: { ...f.environment, AUDIT_TASK_PROTOCOL: 'task-board.v1', AUDIT_ID: 'unrelated-parent', AUDIT_SERVICE_ROOT: '/service' }, outputRoot: join(f.root, 'native') });
  assert.deepEqual(launch.args, ['--standalone', f.root]); assert.equal(launch.environment.AUDIT_TASK_PROTOCOL, undefined);
  assert.equal(launch.environment.AUDIT_ID, undefined); assert.equal(launch.environment.AUDIT_SERVICE_ROOT, '/service');
  assert.equal(JSON.parse(await readFile(launch.configPath, 'utf8')).default_agent, 'security-audit-orchestrator');
  assert.deepEqual(parseArguments(['--engine', 'opencode-v2', '--cwd', f.root, '--prepare-only']), { engine: 'opencode-v2', cwd: f.root, prepareOnly: true });
  assert.throws(() => parseArguments(['--engine', 'unrecognized']), /engine 必须/);
});

test('native Grow launcher uses its actual allocated CLI UUID and exposes the current-session MCP bridge', async t => {
  const f = await fixture(t), agentFile = join(f.root, 'native-agent.md'); await writeFile(agentFile, '# Native agent');
  let request;
  const launch = await prepareNativeLaunch({ engine: 'grow', cwd: f.root, configPath: f.environment.OPENCODE_CONFIG, outputRoot: f.root,
    async prepare(input) { request = input; return { command: 'grow', args: ['--agent', agentFile], environment: { GROW_HOME: f.root }, sessionId: '8f2413fe-90ae-48af-b82c-5c85d84878db' }; } });
  assert.equal(launch.args[launch.args.indexOf('--session-id') + 1], launch.sessionId);
  assert.equal(launch.args.includes('--prompt-file'), false); assert.equal(launch.args.includes('--output-format'), false);
  assert.equal(request.config.mcp['audit-current-session'].type, 'local');
  assert.match(await readFile(agentFile, 'utf8'), new RegExp(launch.sessionId));
  assert.equal(launch.environment.JAVELIN_AGENT_SESSION_ID, launch.sessionId);
  assert.equal(request.cwd, launch.cwd);
});

test('native command uses Web settings unless explicitly overridden without persisting the override', async () => {
  const calls = [], store = {
    async resolve(engine) { calls.push(['saved', engine]); return { command: '/saved/opencode2', available: true }; },
    async inspect(engine, command) { calls.push(['explicit', engine, command]); return { command, available: true }; },
    async update() { throw new Error('must not write settings'); },
  };
  assert.equal((await resolveNativeCommand({ engine: 'opencode-v2', store })).command, '/saved/opencode2');
  assert.equal((await resolveNativeCommand({ engine: 'opencode-v2', command: '/selected/opencode2', store })).command, '/selected/opencode2');
  assert.deepEqual(calls, [['saved', 'opencode-v2'], ['explicit', 'opencode-v2', '/selected/opencode2']]);
  await assert.rejects(resolveNativeCommand({ engine: 'opencode-v2', command: 'opencode;echo unsafe', store }), /可执行程序/);
});
