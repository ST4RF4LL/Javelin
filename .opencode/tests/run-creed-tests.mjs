import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { hash } from '../lib/creed/common.mjs';
import { extractFunctions, buildCreedInventory, creedTasks, readCreedFunction, normalizeCreedOptions,
  parseCreedResponse, creedPrompt, standardCreedReport, creedConfiguration, createCreedCollector, runCreedWorker } from '../lib/creed/index.mjs';
import { normalizeGrowEvent } from '../lib/audit-runtime/engines/grow.mjs';
import { normalizeEvent as normalizeV2Event } from '../lib/audit-runtime/engines/opencode-v2.mjs';
import { prepareAgentLaunch } from '../lib/audit-runtime/engines/index.mjs';
import { parse as parseToml } from 'smol-toml';

function response() {
  return { actions: [
    { id: 'A1', level: 'high', description: '返回指定对象', evidence_lines: [1] },
    { id: 'A2', level: 'low', description: '按传入编号查找对象', evidence_lines: [2] },
  ], beliefs: [{ id: 'B1', statement: '调用者已被授权访问该对象', action_ids: ['A1', 'A2'], evidence_lines: [2],
    sanity: { reasonable: true, explanation: '对象访问需要授权依据。' },
    violation: { conditions: ['调用方未验证对象权限且编号可由不可信输入控制。'], explanation: '当前函数未包含权限检查，调用方是否补充检查尚未知。' } }],
  findings: [{ id: 'F1', title: '对象访问可能缺少授权约束', description: '该函数直接按编号返回对象，是否可越权取决于调用方约束。',
    root_cause: '函数未建立当前主体与目标对象的授权关系。', exploitation_conditions: ['需要核实调用方是否允许用户控制编号且未检查权限。'],
    supporting_belief_ids: ['B1'], evidence_lines: [2], severity: 'UNASSESSED', recommendation: '核实入口授权；若未建立授权关系，应在查询或访问前约束对象范围。' }] };
}
const source = '// 文件头：中文\n\nexport function get(id) {\n  return store.get(id);\n}\n';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'javelin-creed-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source'), workRoot = join(root, 'attempt'); await mkdir(sourceRoot);
  await writeFile(join(sourceRoot, 'app.js'), source);
  const manifest = { scope_digest: hash('scope'), files: [{ type: 'file', path: 'app.js', sha256: hash(source), content_kind: 'source', review_required: true }] };
  const inventory = await buildCreedInventory({ sourceRoot, manifest }), task = creedTasks(inventory)[0];
  const job = { task, attempt: { attempt_id: 'attempt-one' } };
  const input = { protocol: 'task-board.v1', audit_id: 'audit-creed', task, attempt_id: job.attempt.attempt_id, scope_digest: manifest.scope_digest,
    report_path: join(workRoot, 'report.json'), receipt_path: join(workRoot, 'receipt.json') };
  const engine = join(root, 'engine.mjs');
  await writeFile(engine, `const mode=process.env.CREED_FIXTURE_MODE||'success';
const engine=process.env.CREED_FIXTURE_ENGINE, session='ses_creed_fixture';
const output=e=>process.stdout.write(JSON.stringify(e)+'\\n');
if(mode==='hang'){output({type:'step_start',sessionID:session,part:{id:'start1'}}); setInterval(()=>{},1000);}
else {
 if(engine==='grow') {
   output({type:'text',sessionId:session,data:process.env.CREED_FIXTURE_RESPONSE});
   if(mode==='tool')output({type:'tool_call',sessionId:session,toolCallId:'tool1',toolName:'read_file',status:'in_progress'});
   if(mode!=='no-telemetry')output({type:'usage',sessionId:session,messageId:'finish1',usage:{input_tokens:20,output_tokens:40}});
   if(mode==='multiple')output({type:'usage',sessionId:session,messageId:'finish2',usage:{input_tokens:20,output_tokens:40}});
   output({type:'end',sessionId:session,stopReason:'end_turn'});
 } else {
   output({type:'step_start',sessionID:session,part:{id:'start1'}});
   output({type:'text',sessionID:session,part:{id:'text1',text:process.env.CREED_FIXTURE_RESPONSE}});
   if(mode==='tool')output({type:'tool_use',sessionID:session,part:{type:'tool',tool:'read',state:{status:'running'}}});
   if(mode!=='no-telemetry')output({type:'step_finish',sessionID:session,part:{id:'finish1',tokens:{input:20,output:40}}});
   if(mode==='multiple')output({type:'step_start',sessionID:session,part:{id:'start2'}});
 }
}`);
  let calls = 0;
  const prepareLaunch = async options => {
    assert.equal(options.config.agent['creed-function-auditor'].permission['*'], 'deny');
    assert.ok(options.config.agent['creed-function-auditor'].prompt.includes('Action'));
    assert.ok(options.prompt.length < 1000); assert.equal(options.environment.OPENCODE_CONFIG_CONTENT, '{}');
    const privateConfig = JSON.parse(await readFile(options.environment.OPENCODE_CONFIG, 'utf8'));
    assert.deepEqual(privateConfig, options.config);
    const state = { sessionId: 'ses_creed_fixture', tools: new Map() };
    return { command: process.execPath, args: [engine], environment: options.environment,
      eventTransform: options.engine === 'grow' ? event => normalizeGrowEvent(event, state) : options.engine === 'opencode-v2' ? normalizeV2Event : undefined };
  };
  return { root, sourceRoot, workRoot, manifest, inventory, task, job, input,
    args: { job, input, workRoot, sourceRoot, workspaceRoot: root, prepareLaunch,
      environment: { ...process.env, OPENCODE_CONFIG: '', OPENCODE_CONFIG_CONTENT: '{}', JAVELIN_GROW_USER_HOME: join(root, 'grow-user'), CREED_FIXTURE_RESPONSE: JSON.stringify(response()) },
      spawnProcess: (...args) => { calls++; return spawn(...args); } }, calls: () => calls };
}

test('AST extracts complete Java/Python/C/C++/JS/TS/TSX functions and preserves Unicode/decorators', async () => {
  const examples = {
    'a.java': 'class A { A() {} int f(int x) { return x; } abstract int g(); }',
    'a.py': '@authorized\ndef f(x):\n    return x\n',
    'a.c': 'int f(int x) { const char *s="}"; return x; }',
    'a.cpp': 'class A { public: int f() { return 1; } };',
    'a.ts': '// 中文😀\nconst λ = (x: string) => x;',
    'a.tsx': 'function View() { return <span>正常</span> }',
    'a.js': 'const f = () => { return "}"; };',
  };
  for (const [path, code] of Object.entries(examples)) {
    const out = await extractFunctions(code, { path }); assert.equal(out.gaps.length, 0, path); assert.ok(out.functions.length >= 1, path);
    for (const fn of out.functions) assert.equal(hash(code.slice(fn.start_index, fn.end_index)), fn.source_sha256, path);
    if (path === 'a.java') { assert.equal(out.functions.length, 2); assert.equal(out.functions[1].qualified_symbol, 'A.f'); }
    if (path === 'a.py') { assert.equal(out.functions[0].start_line, 1); assert.ok(code.slice(out.functions[0].start_index, out.functions[0].end_index).startsWith('@authorized')); }
  }
});

test('unsupported, malformed and oversized functions are explicit gaps instead of truncated analysis', async () => {
  assert.equal((await extractFunctions('fn f() {}', { path: 'a.rs' })).gaps[0].code, 'UNSUPPORTED_LANGUAGE');
  const malformed = await extractFunctions('function broken( {', { path: 'a.js' }); assert.ok(malformed.gaps.some(row => row.code === 'PARSE_ERROR'));
  const large = await extractFunctions('function f() { return 123456789; }', { path: 'a.js', maxFunctionBytes: 10 });
  assert.equal(large.functions.length, 0); assert.equal(large.gaps[0].code, 'FUNCTION_SIZE_LIMIT');
});

test('inventory honors frozen source, segment-based paths, exact symbols, and explicit count limits', async t => {
  const f = await fixture(t); await mkdir(join(f.sourceRoot, 'src')); await mkdir(join(f.sourceRoot, 'src2'));
  const code = 'class A { f() {return 1} g() {return 2} }';
  for (const path of ['src/a.js', 'src2/a.js']) await writeFile(join(f.sourceRoot, path), code);
  const manifest = { scope_digest: hash('scope2'), files: ['src/a.js', 'src2/a.js'].map(path => ({ type: 'file', path, sha256: hash(code), content_kind: 'source' })) };
  const selected = await buildCreedInventory({ sourceRoot: f.sourceRoot, manifest, options: { paths: ['src'], symbols: ['A.f'] } });
  assert.equal(selected.functions.length, 1); assert.equal(selected.functions[0].path, 'src/a.js'); assert.equal(selected.functions[0].symbol, 'f');
  const capped = await buildCreedInventory({ sourceRoot: f.sourceRoot, manifest, maxFunctions: 1 });
  assert.equal(capped.functions.length, 1); assert.equal(capped.summary.omitted_functions, 3); assert.equal(capped.complete, false);
  await writeFile(join(f.sourceRoot, 'src/a.js'), 'changed');
  const changed = await buildCreedInventory({ sourceRoot: f.sourceRoot, manifest }); assert.ok(changed.gaps.some(row => row.code === 'SOURCE_CHANGED'));
  await assert.rejects(readCreedFunction(f.sourceRoot, selected.functions[0]), { code: 'SOURCE_CHANGED' });
  assert.throws(() => normalizeCreedOptions({ paths: ['../outside'] })); assert.throws(() => normalizeCreedOptions({ paths: ['C:\\outside'] }));
  assert.throws(() => normalizeCreedOptions({ maxFunctions: 1000 })); assert.throws(() => normalizeCreedOptions({ symbols: ['x'.repeat(401)] }));
  assert.deepEqual(normalizeCreedOptions({ paths: ['./src/', 'src', 'src//./nested/'] }).paths, ['src', 'src/nested']);
});

test('source symlinks cannot expand the authorized snapshot', async t => {
  const f = await fixture(t); const outside = join(f.root, 'outside.js'); await writeFile(outside, source);
  try { await symlink(outside, join(f.sourceRoot, 'linked.js')); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('当前 Windows 测试账号没有创建符号链接的权限。'); return; } throw error; }
  const inventory = await buildCreedInventory({ sourceRoot: f.sourceRoot, manifest: { scope_digest: hash('scope'), files: [{ type: 'file', path: 'linked.js', sha256: hash(source) }] } });
  assert.equal(inventory.functions.length, 0); assert.equal(inventory.gaps.length, 1);
});

test('CREED validates linked evidence, all sanity/violation checks, IDs and original response order', () => {
  const good = response(); assert.deepEqual(parseCreedResponse(JSON.stringify(good), 3), good);
  const noFindings = response(); noFindings.findings = []; assert.equal(parseCreedResponse(JSON.stringify(noFindings), 3).findings.length, 0);
  for (const mutation of [
    report => { report.beliefs[0].action_ids = ['unknown']; }, report => { report.findings[0].supporting_belief_ids = ['unknown']; },
    report => { report.findings[0].evidence_lines = [4]; }, report => { report.actions[1].id = report.actions[0].id; },
    report => { report.beliefs[0].sanity.reasonable = false; delete report.beliefs[0].violation; },
  ]) { const bad = response(); mutation(bad); assert.throws(() => parseCreedResponse(JSON.stringify(bad), 3), { code: 'CREED_SCHEMA' }); }
  assert.throws(() => parseCreedResponse('{"actions":[],"actions":[],"beliefs":[],"findings":[]}', 3), /重复字段/);
  assert.throws(() => parseCreedResponse('not JSON', 3), { code: 'CREED_SCHEMA' });
  const prompt = creedPrompt('return input;', 'javascript'); assert.match(prompt, /包括已判断不合理的假设/); assert.match(prompt, /不输出私有推理/);
});

test('source-controlled config macros remain inert data through repeated config serialization', () => {
  const code = 'function example() {\n  // {file:/outside/private.txt} {env:CREED_FIXTURE_SECRET}\n  return "\\\\u007bfile:literal}";\n}';
  let prompt = creedPrompt(code, 'javascript');
  for (let round = 0; round < 4; round++) {
    assert.doesNotMatch(prompt, /\{(?:file|env):/u);
    const encoded = JSON.stringify({ agent: { worker: { prompt } } }); assert.doesNotMatch(encoded, /\{(?:file|env):/u);
    prompt = JSON.parse(encoded).agent.worker.prompt;
  }
  const input = JSON.parse(prompt.split('\n').find(line => line.startsWith('输入数据=')).slice('输入数据='.length));
  assert.equal(input.source, code.split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n'));
});

test('standard findings expose source locations, action/belief evidence and Chinese conditions', async t => {
  const f = await fixture(t), ref = f.inventory.functions[0];
  const report = standardCreedReport(response(), { input: f.input, ref, sessionId: 'ses_fixture', execution: {} });
  const finding = report.findings[0]; assert.equal(finding.location.line, 4); assert.equal(finding.locations[0].path, 'app.js');
  assert.equal(finding.creed_analysis.beliefs[0].source_lines[0], 4); assert.ok(finding.evidence.facts.every(row => row.locator.line >= 3));
  assert.equal(finding.creed_analysis.external_conditions.length, 1); assert.equal(finding.strategy_id, 'creed'); assert.equal(report.runtime_requests, undefined);
});

test('dedicated configuration disables inherited MCP, tools, memory prompts and plugins', async t => {
  const f = await fixture(t), path = join(f.root, 'config.json');
  await writeFile(path, JSON.stringify({ provider: { example: { options: { baseURL: 'https://models.invalid' } } }, plugin: ['unrelated'], instructions: ['secret.md'], mcp: { browser: { type: 'remote', url: 'https://target.invalid' } } }));
  const config = await creedConfiguration({ OPENCODE_CONFIG: path, OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { ssh: { enabled: true } } }) });
  assert.deepEqual(config.mcp, { browser: { enabled: false }, ssh: { enabled: false } }); assert.deepEqual(config.instructions, []); assert.deepEqual(config.plugin, []);
  assert.equal(config.provider.example.options.baseURL, 'https://models.invalid'); assert.equal(config.agent['creed-function-auditor'].permission['*'], 'deny');
  assert.ok(Object.values(config.agent['creed-function-auditor'].tools).every(value => value === false));
});

test('real engine launch adapters preserve the dedicated role and deny inherited execution capabilities', async t => {
  const f = await fixture(t), config = await creedConfiguration({ OPENCODE_CONFIG_CONTENT: '{}' });
  config.agent['creed-function-auditor'].prompt += '\n完整函数 fixture-only';
  const configPath = join(f.root, 'creed-config.json'); await writeFile(configPath, JSON.stringify(config));
  const environment = { OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_CONFIG_DIR: f.root,
    JAVELIN_OPENCODE_V2_HOME: join(f.root, 'v2-home'), XDG_DATA_HOME: join(f.root, 'old-data'), JAVELIN_GROW_USER_HOME: join(f.root, 'grow-user') };
  for (const engine of ['opencode', 'opencode-v2', 'grow']) {
    const launch = await prepareAgentLaunch({ engine, environment, config, role: 'creed-function-auditor', prompt: '返回一个 JSON',
      cwd: f.root, outputRoot: join(f.root, engine), model: 'fixture/model' });
    assert.ok(launch.args.every(arg => !arg.includes('fixture-only')));
    if (engine === 'grow') {
      const prepared = parseToml(await readFile(join(launch.sessionHome, 'config.toml'), 'utf8'));
      assert.deepEqual(Object.keys(prepared.mcp_servers), []); assert.equal(prepared.subagents.enabled, false);
      assert.ok(launch.args.includes('--no-subagents')); assert.ok(launch.args.includes('Read')); assert.ok(launch.args.includes('Write')); assert.ok(launch.args.includes('Bash'));
      assert.match(await readFile(launch.args[launch.args.indexOf('--agent') + 1], 'utf8'), /完整函数 fixture-only/);
    } else {
      const prepared = JSON.parse(await readFile(launch.environment.OPENCODE_CONFIG, 'utf8'));
      assert.equal(prepared.agent['creed-function-auditor'].permission['*'], 'deny'); assert.deepEqual(prepared.mcp, {});
      assert.match(prepared.agent['creed-function-auditor'].prompt, /完整函数 fixture-only/);
    }
  }
});

for (const engine of ['opencode', 'opencode-v2', 'grow']) test(`${engine}: one native response produces verified delivery, stable binding and reusable same-attempt cache`, async t => {
  const f = await fixture(t), args = { ...f.args, engine, environment: { ...f.args.environment, CREED_FIXTURE_ENGINE: engine } };
  await runCreedWorker(args); assert.equal(f.calls(), 1);
  const report = JSON.parse(await readFile(f.input.report_path, 'utf8')), receipt = JSON.parse(await readFile(f.input.receipt_path, 'utf8'));
  assert.equal(report.agent_session_id, 'ses_creed_fixture'); assert.equal(report.creed.execution.observed_model_responses, 1); assert.equal(report.creed.execution.transport_attempts, null);
  assert.equal(receipt.outcome, 'REPORTED'); assert.equal(report.findings[0].location.line, 4);
  assert.equal((await runCreedWorker(args)).reused, true); assert.equal(f.calls(), 1);
  await assert.rejects(runCreedWorker({ ...args, model: 'changed/model' }), { code: 'CREED_BINDING_CHANGED' }); assert.equal(f.calls(), 1);
});

for (const mode of ['tool', 'multiple', 'no-telemetry', 'invalid-json']) test(`${mode}: preserve raw response and reject delivery without repair calls`, async t => {
  const f = await fixture(t), raw = mode === 'invalid-json' ? '{broken' : JSON.stringify(response());
  await assert.rejects(runCreedWorker({ ...f.args, environment: { ...f.args.environment, CREED_FIXTURE_MODE: mode, CREED_FIXTURE_RESPONSE: raw } }));
  assert.equal(f.calls(), 1); await assert.rejects(readFile(f.input.receipt_path), { code: 'ENOENT' });
  const failed = JSON.parse(await readFile(join(f.workRoot, 'creed-response.json'), 'utf8')); assert.equal(failed.text, raw); assert.ok(failed.failure.code);
  await assert.rejects(runCreedWorker(f.args), { code: 'CREED_ATTEMPT_ALREADY_USED' }); assert.equal(f.calls(), 1);
});

test('cancellation stops only the owned executor and never writes a success receipt', async t => {
  const f = await fixture(t), controller = new AbortController();
  const running = runCreedWorker({ ...f.args, signal: controller.signal, environment: { ...f.args.environment, CREED_FIXTURE_MODE: 'hang' } });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(running, { code: 'CREED_CANCELLED' }); assert.equal(f.calls(), 1); await assert.rejects(readFile(f.input.receipt_path), { code: 'ENOENT' });
  const never = new AbortController(); never.abort(); await assert.rejects(runCreedWorker({ ...f.args, signal: never.signal }), { code: 'CREED_CANCELLED' }); assert.equal(f.calls(), 1);
});

test('collector rejects mixed session events and does not count a session end as a model response', () => {
  const collector = createCreedCollector(); collector.consume({ type: 'text', sessionID: 'one', part: { text: '{}' } }); collector.consume({ type: 'session_end', sessionID: 'one' });
  assert.throws(() => collector.finish(), { code: 'CREED_TELEMETRY' });
  collector.consume({ type: 'step_finish', sessionID: 'two', part: { id: 'finish' } }); assert.throws(() => collector.finish(), { code: 'CREED_EXECUTION' });
});

test('optional real OpenCode CLI uses one local fixture request without expanding source macros', { skip: !process.env.JAVELIN_TEST_CREED_OPENCODE, timeout: 60000 }, async t => {
  const f = await fixture(t), controller = new AbortController(); let calls = 0, requestValid = false, exactSource = false, expanded = false;
  const markerPath = join(f.root, 'host-marker.txt'), missingPath = join(f.root, 'missing-private-file.txt');
  await writeFile(markerPath, 'HOST_FILE_MUST_NOT_BE_READ');
  const macroSource = source.replace('\n}\n', `\n  // {file:${markerPath}} {env:CREED_FIXTURE_SECRET} {file:${missingPath}}\n}\n`);
  await writeFile(join(f.sourceRoot, 'app.js'), macroSource);
  const inventory = await buildCreedInventory({ sourceRoot: f.sourceRoot, manifest: { ...f.manifest, files: [{ ...f.manifest.files[0], sha256: hash(macroSource) }] } });
  const task = creedTasks(inventory)[0], job = { ...f.job, task }, input = { ...f.input, task };
  const exactNumberedSource = (await readCreedFunction(f.sourceRoot, task.creed.function)).split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n');
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); calls++;
    requestValid = req.url === '/v1/chat/completions' && payload.model === 'fixture' && body.includes('Action') && body.includes('return store.get(id)');
    expanded = body.includes('HOST_FILE_MUST_NOT_BE_READ') || body.includes('HOST_ENV_MUST_NOT_BE_READ');
    const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
    const line = strings(payload.messages).flatMap(value => value.split('\n')).find(value => value.startsWith('输入数据='));
    try { exactSource = JSON.parse(line.slice('输入数据='.length)).source === exactNumberedSource; } catch { exactSource = false; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'chatcmpl-local-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture' };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(response()) }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const configPath = join(f.root, 'fixture-config.json');
  await writeFile(configPath, JSON.stringify({ model: 'fixture/fixture', enabled_providers: ['fixture'],
    provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Fixture', options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-only' },
      models: { fixture: { name: 'Fixture', limit: { context: 128000, output: 16384 } } } } } }));
  const environment = { ...f.args.environment, OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: join(f.root, 'empty-config'),
    XDG_CONFIG_HOME: join(f.root, 'xdg-config'), XDG_DATA_HOME: join(f.root, 'xdg-data'), XDG_STATE_HOME: join(f.root, 'xdg-state'), XDG_CACHE_HOME: join(f.root, 'xdg-cache'),
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_CONFIG_PROJECT_DISABLE: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_LSP_DOWNLOAD: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true', DO_NOT_TRACK: '1', NO_PROXY: '127.0.0.1,localhost', CREED_FIXTURE_SECRET: 'HOST_ENV_MUST_NOT_BE_READ' };
  await mkdir(environment.OPENCODE_CONFIG_DIR);
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const result = await runCreedWorker({ ...f.args, job, input, engine: 'opencode', command: process.env.JAVELIN_TEST_CREED_OPENCODE,
      model: 'fixture/fixture', environment, signal: controller.signal, prepareLaunch: prepareAgentLaunch });
    const report = JSON.parse(await readFile(f.input.report_path, 'utf8'));
    assert.equal(calls, 1); assert.equal(requestValid, true); assert.ok(result.session_id);
    assert.equal(expanded, false); assert.equal(exactSource, true);
    assert.equal(report.creed.execution.observed_model_responses, 1); assert.equal(report.creed.execution.tool_calls, 0);
    assert.equal(report.findings[0].location.line, 4); assert.equal(report.findings[0].location.path, 'app.js');
  } finally { clearTimeout(timer); }
});
