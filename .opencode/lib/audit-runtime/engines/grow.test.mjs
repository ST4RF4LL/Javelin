import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { growModelCatalog, hasPersistedGrowSession, normalizeGrowEvent, prepareCheckpointTui, prepareLaunch, readCheckpointSession, serializeGrowConfig } from './grow.mjs';

const require = createRequire(import.meta.url), yaml = require('yaml');
import * as toml from 'smol-toml';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'javelin-grow-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'user'), cwd = join(root, 'workspace'), canonical = join(root, 'canonical'), outputRoot = join(root, 'private');
  await Promise.all([home, cwd, join(canonical, 'agents'), join(canonical, 'skills')].map(path => mkdir(path, { recursive: true })));
  const userConfig = '[models]\ndefault="example/secure"\ninference_idle_timeout_secs=600\n[provider.example]\napi_backend="responses"\n[provider.example.options]\napi_key="fixture-secret"\n[provider.example.models.secure]\nname="Secure model"\ncontext_window=128000\n[mcp_servers.unrelated]\ncommand="unrelated"\n';
  await writeFile(join(home, 'config.toml'), userConfig);
  for (const [name, permissions] of Object.entries({ orchestrator: { '*': 'allow', 'chrome-devtools_*': 'deny' }, specialist: { '*': 'deny', read: 'allow', bash: 'allow', edit: 'allow', task: 'deny', 'atlas_*': 'allow' } })) {
    await writeFile(join(canonical, 'agents', `${name}.md`), `---\n${yaml.stringify({ description: name, permission: permissions })}---\nCurrent ${name} task-board protocol.\n`);
  }
  return { root, home, cwd, outputRoot, userConfig, canonical, environment: { GROW_HOME: home, OPENCODE_CONFIG_DIR: canonical,
    OPENCODE_CONFIG_CONTENT: '{"secret":"discarded"}', OPENCODE_CONFIG: 'discarded.json', AUDIT_TASK_PROTOCOL: 'task-board.v1' } };
}
const mcp = {
  atlas: { type: 'local', command: ['atlas', 'mcp'], environment: { EXAMPLE: '1' } },
  'chrome-devtools': { type: 'local', command: ['node', 'browser.mjs'] },
};
test('isolates configuration, discovers canonical roles, translates permissions and protects user configuration', async t => {
  const f = await fixture(t), input = join(f.root, 'packet.json');
  await writeFile(input, '{"task_id":"fixture"}');
  const launch = await prepareLaunch({ ...f, role: 'orchestrator', prompt: '开始审计', files: [input], config: { mcp }, command: '/bin/grow' });
  assert.equal(launch.command, '/bin/grow');
  assert.match(launch.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(launch.args[launch.args.indexOf('--session-id') + 1], launch.sessionId);
  assert.equal(launch.args.includes('--resume'), false);
  assert.equal(launch.args.includes('--no-subagents'), false);
  assert.equal(launch.environment.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(launch.environment.OPENCODE_CONFIG_DIR, undefined);
  assert.equal(launch.environment.AUDIT_TASK_PROTOCOL, 'task-board.v1');
  assert.equal(launch.environment.GROW_HOME, launch.sessionHome);
  assert.equal(launch.environment.GROW_DISABLE_AUTOUPDATER, '1');
  assert.equal(await readFile(join(f.home, 'config.toml'), 'utf8'), f.userConfig);
  const configPath = join(launch.sessionHome, 'config.toml');
  const config = toml.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.provider.example.options.api_key, 'fixture-secret');
  assert.equal(config.models.inference_idle_timeout_secs, 600);
  assert.deepEqual(Object.keys(config.mcp_servers), ['atlas']);
  assert.deepEqual(config.skills.paths, [join(f.canonical, 'skills')]);
  assert.equal(config.cli.auto_update, false);
  assert.equal(config.cli.use_leader, false);
  if (process.platform !== 'win32') assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  const agent = await readFile(join(launch.agentDirectory, 'specialist.md'), 'utf8');
  assert.match(agent, /Current specialist task-board protocol/);
  assert.match(agent, /mcpInheritance:\n  named:\n    - atlas/);
  assert.doesNotMatch(agent.split('---')[1], /spawn_subagent/);
  const inline = JSON.parse(launch.args[launch.args.indexOf('--agents') + 1]);
  assert.deepEqual(inline.specialist.mcpInheritance, { named: ['atlas'] });
  assert.ok(inline.specialist.tools.includes('read_file'));
  assert.match(inline.specialist.prompt, /agents.*specialist\.md/);
  await assert.rejects(() => stat(join(f.cwd, '.grow')), { code: 'ENOENT' });
  const prompt = await readFile(launch.args[launch.args.indexOf('--prompt-file') + 1], 'utf8');
  assert.match(prompt, /开始审计/); assert.match(prompt, /"task_id":"fixture"/);
  assert.equal(launch.args.some(arg => arg.includes('"task_id"') || arg.includes('fixture-secret')), false);
});
test('static workers cannot spawn children or inherit disabled browser MCP', async t => {
  const f = await fixture(t);
  const launch = await prepareLaunch({ ...f, role: 'specialist', prompt: '审计唯一工作包', config: { mcp: { ...mcp, 'chrome-devtools': { enabled: false } } } });
  assert.ok(launch.args.includes('--no-subagents'));
  const config = toml.parse(await readFile(join(launch.sessionHome, 'config.toml'), 'utf8'));
  assert.deepEqual(Object.keys(config.mcp_servers), ['atlas']);
  assert.equal(config.subagents.enabled, false);
});
test('controlled runtime worker receives its explicitly permitted gateway only', async t => {
  const f = await fixture(t);
  const launch = await prepareLaunch({ ...f, role: 'runtime-testing-worker', prompt: '读取内联工作包', config: {
    agent: { 'runtime-testing-worker': { prompt: 'runtime instructions', permission: { '*': 'deny', 'runtime-browser_*': 'allow' } } },
    mcp: { ...mcp, 'runtime-browser': { type: 'local', command: ['node', 'gateway.mjs'], environment: { RUNTIME_WORKER_TOKEN: 'private-fixture' } } },
  } });
  const config = toml.parse(await readFile(join(launch.sessionHome, 'config.toml'), 'utf8'));
  assert.deepEqual(Object.keys(config.mcp_servers), ['runtime-browser']);
  const role = await readFile(launch.args[launch.args.indexOf('--agent') + 1], 'utf8');
  assert.match(role, /tools: read_file, search_replace, run_terminal_command, search_tool, use_tool/);
  assert.equal(launch.args[launch.args.indexOf('--deny') + 1], 'Read');
  assert.ok(launch.args.includes('Bash'));
});
test('recovery forks the saved history in the same private home to avoid Grow ACP event-ID collisions', async t => {
  const f = await fixture(t);
  const first = await prepareLaunch({ ...f, role: 'specialist', prompt: '首轮' });
  const second = await prepareLaunch({ ...f, role: 'specialist', prompt: '恢复', sessionId: first.sessionId });
  assert.equal(second.sessionHome, first.sessionHome);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(second.resumedFromSessionId, first.sessionId);
  assert.ok(second.args.includes('--resume'));
  assert.ok(second.args.includes('--fork-session'));
  assert.equal(second.args[second.args.indexOf('--resume') + 1], first.sessionId);
  assert.equal(second.args[second.args.indexOf('--session-id') + 1], second.sessionId);
  assert.notEqual(second.args[second.args.indexOf('--prompt-file') + 1], first.args[first.args.indexOf('--prompt-file') + 1]);
  await assert.rejects(() => prepareLaunch({ ...f, role: 'specialist', sessionId: 'ses_opencode', prompt: '' }), /UUID/);
});
test('role overrides and model selection remain per launch', async t => {
  const f = await fixture(t);
  const launch = await prepareLaunch({ ...f, role: 'specialist', prompt: '', model: 'example/secure', config: { agent: {
    specialist: { prompt: 'Replacement scope', permission: { bash: 'deny' } },
  } } });
  const role = await readFile(launch.args[launch.args.indexOf('--agent') + 1], 'utf8');
  assert.match(role, /Replacement scope/);
  assert.ok(launch.args.includes('Bash'));
  assert.equal(launch.args[launch.args.indexOf('--model') + 1], 'example/secure');
});
test('never writes to existing user-authored project roles', async t => {
  const f = await fixture(t), target = join(f.cwd, '.grow', 'agents');
  await mkdir(target, { recursive: true }); await writeFile(join(target, 'specialist.md'), 'user-owned');
  await prepareLaunch({ ...f, role: 'orchestrator', prompt: '' });
  assert.equal(await readFile(join(target, 'specialist.md'), 'utf8'), 'user-owned');
});
test('only the primary audit orchestrator can receive the current-session registration MCP', async t => {
  const f = await fixture(t);
  const launch = await prepareLaunch({ ...f, role: 'security-audit-orchestrator', prompt: '', config: {
    agent: { 'security-audit-orchestrator': { prompt: '当前会话登记', permission: { '*': 'allow' } }, other: { prompt: '子角色', permission: { '*': 'allow' } } },
    mcp: { 'audit-current-session': { type: 'local', command: ['node', 'register.mjs'] } },
  } });
  const inline = JSON.parse(launch.args[launch.args.indexOf('--agents') + 1]);
  assert.equal(inline['security-audit-orchestrator'], undefined);
  assert.equal(inline.other.mcpInheritance, 'none');
  const settings = toml.parse(await readFile(join(launch.sessionHome, 'config.toml'), 'utf8'));
  assert.deepEqual(Object.keys(settings.mcp_servers), ['audit-current-session']);
});
test('paused TUI restores its explicit primary role and discoverable children without an inline agent argument', async t => {
  const f = await fixture(t);
  const launch = await prepareLaunch({ ...f, role: 'security-audit-orchestrator', prompt: '', config: {
    agent: { 'security-audit-orchestrator': { prompt: '主审计', permission: { '*': 'allow' } } },
  } });
  await assert.rejects(() => stat(join(f.cwd, '.grow')), { code: 'ENOENT' });
  const terminal = await prepareCheckpointTui({ ...launch, cwd: f.cwd });
  assert.equal(terminal.args[terminal.args.indexOf('--resume') + 1], launch.sessionId);
  assert.equal(terminal.args[terminal.args.indexOf('--session-id') + 1], terminal.sessionId);
  assert.notEqual(terminal.sessionId, launch.sessionId);
  assert.equal(readCheckpointSession(launch.sessionHome, launch.sessionId), launch.sessionId);
  assert.equal(terminal.args[terminal.args.indexOf('--agent') + 1], join(launch.agentDirectory, 'interactive-security-audit-orchestrator.md'));
  assert.match(await readFile(terminal.args[terminal.args.indexOf('--agent') + 1], 'utf8'), /后台审计任务已暂停/);
  assert.doesNotMatch(await readFile(join(launch.agentDirectory, 'security-audit-orchestrator.md'), 'utf8'), /后台审计任务已暂停/);
  assert.equal(terminal.args.includes('--agents'), false);
  assert.equal(terminal.args.includes('--prompt-file'), false);
  assert.equal(terminal.args[terminal.args.indexOf('--permission-mode') + 1], 'ask');
  assert.equal(terminal.environment.GROW_HOME, launch.sessionHome);
  assert.match(await readFile(join(f.cwd, '.grow', 'agents', 'specialist.md'), 'utf8'), /Current specialist task-board protocol/);
  await assert.rejects(() => stat(join(f.cwd, '.grow', 'agents', 'security-audit-orchestrator.md')), { code: 'ENOENT' });
  await assert.rejects(() => prepareCheckpointTui({ ...launch, cwd: f.root }), /不匹配/);
  await writeFile(join(f.cwd, '.grow', 'agents', 'specialist.md'), 'user-owned');
  await assert.rejects(() => prepareCheckpointTui({ ...launch, cwd: f.cwd }), /冲突/);
  assert.equal(await readFile(join(f.cwd, '.grow', 'agents', 'specialist.md'), 'utf8'), 'user-owned');
});
test('interactive branches become resume parents only after a matching Grow session summary exists', async t => {
  const f = await fixture(t);
  const launch = await prepareLaunch({ ...f, role: 'orchestrator', prompt: '' });
  const terminal = await prepareCheckpointTui({ ...launch, cwd: f.cwd });
  assert.equal(readCheckpointSession(launch.sessionHome, launch.sessionId), launch.sessionId);
  const record = join(launch.sessionHome, 'sessions', encodeURIComponent(f.cwd), terminal.sessionId, 'summary.json');
  await mkdir(join(record, '..'), { recursive: true });
  await writeFile(record, JSON.stringify({ info: { id: terminal.sessionId, cwd: f.cwd } }));
  assert.equal(readCheckpointSession(launch.sessionHome, launch.sessionId), terminal.sessionId);
  const second = await prepareCheckpointTui({ ...launch, cwd: f.cwd, sessionId: terminal.sessionId });
  // Merely preparing a second branch must not erase the latest real parent.
  assert.equal(readCheckpointSession(launch.sessionHome, launch.sessionId), terminal.sessionId);
  const secondRecord = join(launch.sessionHome, 'sessions', encodeURIComponent(f.cwd), second.sessionId, 'summary.json');
  await mkdir(join(secondRecord, '..'), { recursive: true });
  await writeFile(secondRecord, JSON.stringify({ info: { id: second.sessionId, cwd: f.cwd } }));
  assert.equal(readCheckpointSession(launch.sessionHome, launch.sessionId), second.sessionId);
  const resumed = await prepareLaunch({ ...f, role: 'orchestrator', prompt: '', sessionId: launch.sessionId });
  assert.equal(resumed.resumedFromSessionId, second.sessionId);
  assert.notEqual(resumed.sessionId, second.sessionId);
});
test('MCP-only TUI retains built-in denials and disables delegated sessions', async t => {
  const f = await fixture(t);
  const launch = await prepareLaunch({ ...f, role: 'runtime-worker', prompt: '', config: {
    agent: { 'runtime-worker': { prompt: '只使用网关', permission: { '*': 'deny', 'runtime-browser_*': 'allow' } } },
  } });
  const terminal = await prepareCheckpointTui({ ...launch, cwd: f.cwd });
  assert.ok(terminal.args.includes('--no-subagents'));
  for (const rule of ['Read', 'Write', 'Edit', 'Bash']) assert.ok(terminal.args.includes(rule));
  await assert.rejects(() => stat(join(f.cwd, '.grow')), { code: 'ENOENT' });
});
test('model catalog returns identifiers and metadata without credentials', async t => {
  const f = await fixture(t);
  const catalog = await growModelCatalog(f.environment);
  assert.equal(catalog.default_model, 'example/secure');
  assert.deepEqual(catalog.models, [{ id: 'example/secure', provider: 'example', name: 'Secure model', context_window: 128000 }]);
  assert.doesNotMatch(JSON.stringify(catalog), /fixture-secret|api_key/);
});
test('TOML serializer round trips nested tables, arrays and quoted paths', () => {
  const config = { provider: { 'company.example': { models: { 'm/v1': { name: 'A "model"\n下一行', enabled: true, context_window: 12 } } } },
    values: ['C:\\Program Files\\Grow', { name: 'nested', values: [1, 2] }] };
  assert.deepEqual(JSON.parse(JSON.stringify(toml.parse(serializeGrowConfig(config)))), config);
});
test('Grow text, tool update and error events retain correlated session identity', () => {
  const state = { sessionId: 'fixture', tools: new Map() };
  assert.equal(normalizeGrowEvent({ type: 'text', data: '结果' }, state).part.text, '结果');
  normalizeGrowEvent({ type: 'tool_call', toolCallId: 'c1', toolName: 'read_file', status: 'in_progress', rawInput: { path: 'x.py' } }, state);
  normalizeGrowEvent({ type: 'tool_call_update', toolCallId: 'c1', status: null, rawInput: null, rawOutput: null, toolName: null }, state);
  const end = normalizeGrowEvent({ type: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: 'source' }, state);
  assert.equal(end.type, 'tool_use'); assert.equal(end.part.tool, 'read_file'); assert.deepEqual(end.part.state.input, { path: 'x.py' });
  assert.equal(end.part.state.output, 'source'); assert.equal(end.sessionID, 'fixture');
  assert.equal(normalizeGrowEvent({ type: 'error', message: 'The operation timed out.' }, state).error.data.message, 'The operation timed out.');
  assert.equal(normalizeGrowEvent({ type: 'error', message: 'Could not start session.' }, state).sessionID, null);
});
test('per-response usage is counted once and aggregate end usage stays informational', () => {
  const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, reasoning_tokens: 1 };
  const step = normalizeGrowEvent({ type: 'usage', usage, stopReason: 'tool_use' });
  assert.deepEqual(step.part.tokens, { input: 10, output: 2, reasoning: 1, total: 117, cache: { read: 100, write: 5 } });
  const end = normalizeGrowEvent({ type: 'end', sessionId: 'actual', usage, stopReason: 'max_tokens', usage_is_incomplete: true });
  assert.equal(end.type, 'session_end'); assert.equal(end.part, undefined); assert.equal(end.sessionID, 'actual');
  assert.equal(end.stopReason, 'max_tokens'); assert.equal(end.usage_is_incomplete, true);
});

test('installed Grow obeys launch, child-role and deny-all contracts against a local fake model', {
  skip: !process.env.GROW_TEST_COMMAND, timeout: 45_000,
}, async t => {
  const f = await fixture(t);
  let mode = 'static', delegated = false, deniedReadRequested = false, deniedShellRequested = false;
  const requests = [];
  const privateFixture = join(f.root, 'should-not-read.txt');
  await writeFile(privateFixture, 'JAVELIN_PRIVATE_READ_MARKER');
  const mcpPath = join(f.root, 'fixture-mcp.cjs');
  await writeFile(mcpPath, `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.id == null) return;
    const result = message.method === 'initialize'
      ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
      : message.method === 'tools/list'
      ? {tools:[{name:'fixture_probe',description:'Fixture probe tool',inputSchema:{type:'object',properties:{}}}]}
      : {content:[{type:'text',text:'JAVELIN_MCP_EXECUTED'}]};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
  });\n`);
  const gateway = { 'runtime-browser': { type: 'local', command: [process.execPath, mcpPath] } };
  const server = http.createServer(async (request, response) => {
    let data = ''; for await (const chunk of request) data += chunk;
    const body = JSON.parse(data), tools = (body.tools ?? []).map(tool => tool.function?.name);
    requests.push({ mode, tools, messages: JSON.stringify(body.messages),
      toolResults: (body.messages ?? []).filter(message => message.role === 'tool').map(message => ({ id: message.tool_call_id, content: message.content })) });
    let delta = { role: 'assistant', content: `fixture complete ${requests.length}` }, reason = 'stop';
    if (mode === 'delegate' && tools.includes('spawn_subagent') && !delegated) {
      delegated = true; reason = 'tool_calls';
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: `fixture-spawn-${requests.length}`, type: 'function', function: {
        name: 'spawn_subagent', arguments: JSON.stringify({ prompt: 'Fixture only; return ready without using tools.',
          description: 'Fixture child', subagent_type: 'specialist', capability_mode: 'all', background: false }),
      } }] };
    }
    if (mode === 'deny-all' && tools.length && (!deniedReadRequested || !deniedShellRequested)) {
      const name = deniedReadRequested ? 'run_terminal_command' : 'read_file';
      const schema = body.tools.find(tool => tool.function?.name === name).function.parameters;
      const args = {};
      for (const key of schema.required ?? []) {
        const property = schema.properties[key];
        args[key] = property.type === 'boolean' ? false : property.type === 'integer' || property.type === 'number' ? 1
          : /command|cmd/.test(key) ? 'printf JAVELIN_SHELL_SHOULD_NOT_RUN' : privateFixture;
      }
      if (name === 'read_file') deniedReadRequested = true; else deniedShellRequested = true;
      reason = 'tool_calls';
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: `fixture-denied-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
    } else if (mode === 'deny-all' && tools.length) {
      const toolResults = JSON.stringify((body.messages ?? []).filter(message => message.role === 'tool'));
      if (!toolResults.includes('JAVELIN_MCP_EXECUTED')) {
        const discovered = toolResults.includes('runtime-browser__fixture_probe');
        const name = discovered ? 'use_tool' : 'search_tool';
        const args = discovered ? { tool_name: 'runtime-browser__fixture_probe', tool_input: {} } : { query: 'fixture_probe', limit: 5 };
        reason = 'tool_calls';
        delta = { role: 'assistant', tool_calls: [{ index: 0, id: `fixture-mcp-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
      }
    }
    if (mode === 'delegate' && tools.length && !tools.includes('spawn_subagent') && !(body.messages ?? []).some(message => message.tool_call_id?.startsWith('fixture-child-search-'))) {
      reason = 'tool_calls';
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: `fixture-child-search-${requests.length}`, type: 'function', function: {
        name: 'search_tool', arguments: JSON.stringify({ query: 'fixture_probe', limit: 5 }),
      } }] };
    }
    response.setHeader('Content-Type', 'text/event-stream');
    const frame = { id: `fixture-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'probe' };
    response.write(`data: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta: {}, finish_reason: reason }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await writeFile(join(f.home, 'config.toml'), serializeGrowConfig({ cli: { auto_update: false }, features: { remote_fetch: false, codebase_indexing: false },
    models: { default: 'fixture/probe' }, provider: { fixture: { api_backend: 'chat_completions',
      options: { base_url: `http://127.0.0.1:${server.address().port}/v1` }, models: { probe: { context_window: 32000 } } } } }));
  let mostRecentLaunch;
  const run = async (role, config = {}, prepared = null) => {
    const launch = prepared || await prepareLaunch({ ...f, command: process.env.GROW_TEST_COMMAND, role, config, prompt: 'Fixture only; complete the requested probe.',
      environment: { ...f.environment, PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
    mostRecentLaunch = launch;
    const child = spawn(launch.command, launch.args, { cwd: f.cwd, env: launch.environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 12_000);
    t.after(() => { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    clearTimeout(timeout);
    assert.equal(code, 0, stderr);
    const events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(events.find(event => event.type === 'error'), undefined);
    assert.equal(events.findLast(event => event.type === 'end')?.sessionId, launch.sessionId);
    assert.ok(events.map(launch.eventTransform || (event => normalizeGrowEvent(event, { sessionId: launch.sessionId }))).some(event => event?.sessionID === launch.sessionId));
    return events;
  };
  await run('specialist');
  const staticTools = requests.find(row => row.mode === 'static' && row.tools.length)?.tools;
  assert.ok(staticTools.includes('run_terminal_command'));
  assert.ok(staticTools.includes('read_file'));
  assert.ok(staticTools.includes('write'));
  assert.equal(staticTools.includes('spawn_subagent'), false);
  mode = 'deny-all';
  await run('deny-all', { agent: { 'deny-all': { prompt: 'Use only the runtime gateway.', permission: { '*': 'deny', 'runtime-browser_*': 'allow' } } }, mcp: gateway });
  assert.deepEqual(requests.find(row => row.mode === 'deny-all' && row.tools.length)?.tools, ['run_terminal_command', 'read_file', 'search_replace', 'search_tool', 'use_tool']);
  const denied = new Map(requests.filter(row => row.mode === 'deny-all').flatMap(row => row.toolResults).map(result => [result.id, result.content]));
  assert.match(denied.get('fixture-denied-read_file') ?? '', /denied|permission|not allowed/i);
  assert.match(denied.get('fixture-denied-run_terminal_command') ?? '', /denied|permission|not allowed/i);
  const deniedResults = [...denied.values()].join('\n');
  assert.doesNotMatch(deniedResults, /JAVELIN_PRIVATE_READ_MARKER|JAVELIN_SHELL_SHOULD_NOT_RUN/);
  assert.match(deniedResults, /JAVELIN_MCP_EXECUTED/);
  mode = 'delegate';
  const events = await run('orchestrator', { mcp: gateway });
  const completedChild = events.find(event => event.rawOutput?.type === 'SubagentCompleted');
  assert.equal(completedChild?.rawOutput.subagent_type, 'specialist');
  assert.match(completedChild.rawOutput.subagent_id, /^[0-9a-f-]{36}$/);
  const childRequest = requests.find(row => row.mode === 'delegate' && row.messages.includes('specialist.md') && !row.tools.includes('spawn_subagent'));
  assert.ok(childRequest?.tools.includes('read_file'));
  assert.equal(childRequest.tools.includes('ask_user_question'), false);
  const childSearch = requests.filter(row => row.mode === 'delegate').flatMap(row => row.toolResults).find(result => result.id?.startsWith('fixture-child-search-'));
  assert.match(childSearch?.content ?? '', /No MCP tools are available/);
  await assert.rejects(() => stat(join(f.cwd, '.grow')), { code: 'ENOENT' });
  const completedLaunch = mostRecentLaunch;
  const terminal = await prepareCheckpointTui({ ...completedLaunch, cwd: f.cwd });
  // Exercise the real resume/parser/role loader without requiring a browser or
  // a human terminal. Only the probe prompt/output flags make this run headless;
  // the TUI's explicit role, project children and resume ID remain unchanged.
  const resumedPrompt = join(f.root, 'resume.txt');
  await writeFile(resumedPrompt, 'Continue this fixture session; delegate one new specialist probe.');
  terminal.args.push('--prompt-file', resumedPrompt, '--output-format', 'streaming-json');
  assert.equal(readCheckpointSession(completedLaunch.sessionHome, completedLaunch.sessionId), completedLaunch.sessionId);
  delegated = false;
  const resumed = await run(null, {}, terminal);
  assert.equal(resumed.findLast(event => event.type === 'end')?.sessionId, terminal.sessionId);
  assert.equal(resumed.find(event => event.rawOutput?.type === 'SubagentCompleted')?.rawOutput.subagent_type, 'specialist');
  const resumedRequest = requests.find(row => row.tools.includes('spawn_subagent') && row.messages.includes('Continue this fixture session;'));
  assert.match(resumedRequest?.messages ?? '', /Fixture only; complete the requested probe/);
  assert.equal(readCheckpointSession(completedLaunch.sessionHome, completedLaunch.sessionId), terminal.sessionId);
  assert.equal(hasPersistedGrowSession(terminal.sessionHome, terminal.sessionId, f.cwd), true);
  const managedResume = await prepareLaunch({ ...f, command: process.env.GROW_TEST_COMMAND, role: 'orchestrator', config: { mcp: gateway },
    environment: { ...completedLaunch.environment, OPENCODE_CONFIG_DIR: f.canonical }, sessionId: completedLaunch.sessionId,
    prompt: 'Continue after the terminal checkpoint; delegate a new fixture child.' });
  assert.equal(managedResume.resumedFromSessionId, terminal.sessionId);
  delegated = false;
  const continued = await run(null, {}, managedResume);
  assert.equal(continued.find(event => event.rawOutput?.type === 'SubagentCompleted')?.rawOutput.subagent_type, 'specialist');
  const continuedRequest = requests.find(row => row.tools.includes('spawn_subagent') && row.messages.includes('Continue after the terminal checkpoint;'));
  assert.match(continuedRequest?.messages ?? '', /Continue this fixture session/);
});
