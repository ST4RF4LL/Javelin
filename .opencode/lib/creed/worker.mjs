import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareAgentLaunch, normalizeAgentLine } from '../audit-runtime/engines/index.mjs';
import { readGrowConfiguration } from '../audit-runtime/engines/grow.mjs';
import { atomicJson, check, digest, hash, METHOD_VERSION, PROMPT_VERSION } from './common.mjs';
import { readCreedFunction } from './inventory.mjs';
import { creedPrompt, parseCreedResponse, standardCreedReport, REPORT_SCHEMA } from './contract.mjs';

const guardian = fileURLToPath(new URL('../task-board/worker-host.mjs', import.meta.url));
const ROLE = 'creed-function-auditor';
const DENIED_TOOLS = ['read', 'glob', 'grep', 'list', 'edit', 'write', 'bash', 'shell', 'skill', 'lsp', 'task', 'subagent', 'question', 'webfetch', 'websearch'];
const cancelled = () => Object.assign(new Error('CREED 工作项已取消，未接收交付。'), { code: 'CREED_CANCELLED' });
async function readOptional(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

export async function creedConfiguration(environment = process.env) {
  const disk = environment.OPENCODE_CONFIG ? await readOptional(environment.OPENCODE_CONFIG) ?? {} : {};
  const overlay = JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? '{}');
  const servers = { ...(disk.mcp?.servers ?? disk.mcp ?? {}), ...(overlay.mcp?.servers ?? overlay.mcp ?? {}) };
  const config = { ...disk, ...overlay, plugin: [], instructions: [],
    mcp: Object.fromEntries(Object.keys(servers).map(name => [name, { enabled: false }])),
    agent: { [ROLE]: { mode: 'primary', description: 'CREED 单函数假设分析，只返回一次结构化响应',
      prompt: '执行用户给定的 CREED 单函数分析，只输出一个完整 JSON。全部工具均禁用，不能读取其他文件或使用已有漏洞标签。不得把多轮会话声称为单次分析。',
      permission: { '*': 'deny' }, tools: Object.fromEntries(DENIED_TOOLS.map(name => [name, false])) } } };
  if (disk.mcp?.servers || overlay.mcp?.servers) config.mcp = { servers: config.mcp };
  delete config.plugins;
  return config;
}

export function createCreedCollector() {
  const state = { session_id: null, starts: 0, finishes: 0, model_requests: 0, tool_calls: 0, text: '', error: null, usage: [] };
  const startIds = new Set(), finishIds = new Set(), partIds = new Map();
  const unique = (ids, event) => { const id = event.part?.id ?? event.part?.messageID ?? event.messageID; if (!id) return true; if (ids.has(id)) return false; ids.add(id); return true; };
  return {
    state,
    consume(event) {
      const id = event.sessionID ?? event.session_id ?? event.session?.id;
      if (typeof id === 'string' && id) {
        if (state.session_id && state.session_id !== id) state.error = 'CREED 收到其他会话的输出。';
        else state.session_id = id;
      }
      if (event.type === 'tool_use' || event.part?.type === 'tool') { state.tool_calls++; state.error = 'CREED 单响应分析尝试调用工具，已停止执行。'; }
      if (event.type === 'step_start' && unique(startIds, event)) state.starts++;
      if (event.type === 'step_finish' && unique(finishIds, event)) {
        state.finishes++;
        if (event.part?.tokens && typeof event.part.tokens === 'object') state.usage.push(event.part.tokens);
      }
      state.model_requests = Math.max(state.starts, state.finishes);
      if (state.model_requests > 1) state.error = 'CREED 引擎产生了多次模型响应，不能作为单次函数分析接收。';
      if (event.type === 'text') {
        const value = String(event.part?.text ?? event.text ?? '');
        const key = event.part?.id;
        if (key && partIds.has(key)) {
          if (partIds.get(key) !== value) state.error = 'CREED 引擎重复发送不一致的文本片段。';
        } else { state.text += value; if (key) partIds.set(key, value); }
        if (Buffer.byteLength(state.text) > 2 * 1024 * 1024) state.error = 'CREED 响应超过受控大小上限。';
      }
      if (event.type === 'error') state.error = 'CREED 模型请求或引擎执行失败。';
      return !state.error;
    },
    finish() {
      check(!state.error, state.error, 'CREED_EXECUTION');
      check(state.session_id && state.finishes === 1 && state.model_requests === 1 && state.tool_calls === 0, 'CREED 缺少一次完整模型响应及真实会话的运行证据。', 'CREED_TELEMETRY');
      check(state.text.trim(), 'CREED 引擎没有返回结构化响应。', 'CREED_SCHEMA');
      return state;
    },
  };
}

async function runSingleResponse({ launch, signal, spawnProcess, cwd, collector }) {
  if (signal?.aborted) throw cancelled();
  return new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, [guardian, launch.command, ...launch.args], { cwd, env: launch.environment,
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stopping = null, failed = null, byteCount = 0;
    const stop = () => {
      if (stopping) return;
      if (child.connected) child.send({ type: 'stop' }, () => {});
      child.kill('SIGTERM'); stopping = setTimeout(() => child.kill('SIGKILL'), 7000); stopping.unref?.();
    };
    const abort = () => { failed = cancelled(); stop(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const consume = line => {
      if (!line.trim()) return;
      const normalized = normalizeAgentLine(line, launch);
      if (normalized == null) return;
      let event;
      try { event = JSON.parse(normalized); } catch { return; }
      if (!collector.consume(event)) { failed = Object.assign(new Error(collector.state.error), { code: 'CREED_EXECUTION' }); stop(); }
    };
    let buffer = '';
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', chunk => {
      byteCount += Buffer.byteLength(chunk);
      if (byteCount > 8 * 1024 * 1024) { failed = Object.assign(new Error('CREED 引擎输出超过受控上限。'), { code: 'CREED_OUTPUT_LIMIT' }); stop(); return; }
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); consume(line); }
    });
    // Drain stderr without publishing source/configuration or private engine diagnostics.
    child.stderr?.on('data', () => {});
    const cleanup = () => { signal?.removeEventListener('abort', abort); clearTimeout(stopping); };
    child.once('error', error => { cleanup(); reject(Object.assign(new Error('CREED 执行器无法启动。'), { code: error.code ?? 'CREED_SPAWN' })); });
    child.once('close', code => {
      cleanup(); if (buffer) consume(buffer);
      if (signal?.aborted) reject(cancelled());
      else if (failed) reject(failed);
      else if (code !== 0) reject(Object.assign(new Error(`CREED 执行器退出码：${code ?? 'unknown'}。`), { code: 'CREED_EXIT' }));
      else resolve();
    });
  });
}

export async function runCreedWorker({ job, input, workRoot, sourceRoot, workspaceRoot, engine = 'opencode', command = 'opencode', model = null,
  environment = process.env, signal, spawnProcess = spawn, onLog = async () => {}, prepareLaunch = prepareAgentLaunch }) {
  if (signal?.aborted) throw cancelled();
  const ref = job.task.creed?.function;
  check(job.task.strategy_id === 'creed' && job.task.kind === 'function' && ref && input.task.task_id === job.task.task_id && input.attempt_id === job.attempt.attempt_id, 'CREED 工作项绑定无效。');
  const source = await readCreedFunction(sourceRoot, ref), prompt = creedPrompt(source, ref.language), config = await creedConfiguration(environment);
  config.agent[ROLE].prompt = `${config.agent[ROLE].prompt}\n\n${prompt}`;
  const engineSettingsDigest = engine === 'grow' ? digest((await readGrowConfiguration(environment)).config) : null;
  const binding = { method_version: METHOD_VERSION, prompt_version: PROMPT_VERSION, schema_sha256: digest(REPORT_SCHEMA),
    function: ref, scope_digest: input.scope_digest, engine, model, configuration_digest: digest(config), prompt_sha256: hash(prompt) };
  if (engineSettingsDigest) binding.engine_settings_digest = engineSettingsDigest;
  const requestDigest = digest(binding), reportPath = input.report_path ?? join(workRoot, 'report.json'), receiptPath = input.receipt_path ?? join(workRoot, 'receipt.json');
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const previous = await readOptional(join(workRoot, 'creed-request.json'));
  if (previous) check(previous.request_digest === requestDigest, 'CREED 原执行尝试的源码、方法或模型配置已变化，请创建新执行尝试。', 'CREED_BINDING_CHANGED');
  const cached = previous ? await readOptional(reportPath) : null;
  if (cached) {
    const raw = await readOptional(join(workRoot, 'creed-response.json')), receipt = await readOptional(receiptPath);
    check(raw && receipt?.outcome === 'REPORTED' && receipt.audit_id === input.audit_id && receipt.task_id === input.task.task_id && receipt.attempt_id === input.attempt_id
      && cached.audit_id === input.audit_id && cached.task_id === input.task.task_id && cached.attempt_id === input.attempt_id && cached.agent_session_id
      && cached.creed?.execution?.request_digest === requestDigest && cached.creed.execution.response_sha256 === hash(raw.text)
      && previous.report_sha256 === digest(cached), 'CREED 缓存交付绑定无效。', 'CREED_CACHE_INVALID');
    parseCreedResponse(raw.text, source.split('\n').length);
    return { session_id: cached.agent_session_id, reused: true };
  }
  check(!previous, 'CREED 此执行尝试已发起但没有完整交付；请保留原响应并创建新执行尝试。', 'CREED_ATTEMPT_ALREADY_USED');
  await atomicJson(join(workRoot, 'creed-request.json'), { binding, request_digest: requestDigest, prompt });
  // Keep complete source out of command arguments and Windows environment-size limits.
  const configPath = join(workRoot, 'creed-engine-config.json');
  await atomicJson(configPath, config);
  const privateEnvironment = { ...environment, OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_CONTENT: '{}', AUDIT_TASK_BOARD_CONNECTION_PATH: '', AUDIT_TODO_PATH: '',
    AUDIT_TODO_CLI: '', AUDIT_RUNTIME_CONNECTION_PATH: '', AUDIT_RUNTIME_CLI: '', AUDIT_RUNTIME_PROTOCOL: '', AUDIT_RUNTIME_STATE_ROOT: '',
    AUDIT_MEMORY_CONNECTION_PATH: '', AUDIT_MEMORY_CLI: '', AUDIT_MEMORY_MODE: 'off', AUDIT_TEST_ENVIRONMENT_CONTEXT_PATH: '',
    AUDIT_TEST_ENVIRONMENT_CONTEXT_SHA256: '', AUDIT_QUICK_DYNAMIC_ENABLED: 'false' };
  const collector = createCreedCollector();
  try {
    const launch = await prepareLaunch({ engine, command, environment: privateEnvironment, config, role: ROLE,
      prompt: '按当前角色提供的完整函数和 CREED 契约完成一次分析，仅返回所要求的 JSON；所有工具保持禁用。', files: [],
      model, cwd: workspaceRoot, outputRoot: join(workRoot, 'agent-runtime'), title: job.task.title });
    await runSingleResponse({ launch, signal, spawnProcess, cwd: workspaceRoot, collector });
    if (signal?.aborted) throw cancelled();
    const state = collector.finish();
    await atomicJson(join(workRoot, 'creed-response.json'), { text: state.text, session_id: state.session_id, model_requests: state.model_requests, tool_calls: state.tool_calls, usage: state.usage });
    const result = parseCreedResponse(state.text, source.split('\n').length);
    const execution = { request_digest: requestDigest, response_sha256: hash(state.text), engine, model,
      logical_requests: 1, response_scope: 'FUNCTION_ANALYSIS', observed_model_responses: state.model_requests, transport_attempts: null,
      telemetry_note: '仅记录本工作项可观测的函数分析响应；引擎内部标题生成等请求及底层 HTTP 重试次数未完整暴露，不能据此推断总调用数。', tool_calls: state.tool_calls, usage: state.usage };
    const report = standardCreedReport(result, { input, ref, sessionId: state.session_id, execution });
    if (signal?.aborted) throw cancelled();
    await atomicJson(join(workRoot, 'session.json'), { protocol: input.protocol, audit_id: input.audit_id, task_id: input.task.task_id,
      attempt_id: input.attempt_id, agent_session_id: state.session_id });
    await atomicJson(reportPath, report);
    await atomicJson(join(workRoot, 'creed-request.json'), { binding, request_digest: requestDigest, prompt, report_sha256: digest(report) });
    if (signal?.aborted) throw cancelled();
    await atomicJson(receiptPath, { protocol: input.protocol, audit_id: input.audit_id, task_id: input.task.task_id,
      attempt_id: input.attempt_id, outcome: 'REPORTED', report_path: 'report.json' });
    await Promise.resolve(onLog('stdout', `[creed/${input.task.task_id}] 已接收一次结构化假设分析，共 ${report.findings.length} 条待复核发现。`)).catch(() => {});
    return { session_id: state.session_id };
  } catch (error) {
    await atomicJson(join(workRoot, 'creed-response.json'), { text: collector.state.text, session_id: collector.state.session_id,
      model_requests: collector.state.model_requests, tool_calls: collector.state.tool_calls, usage: collector.state.usage,
      failure: { code: error.code ?? 'CREED_EXECUTION', reason: error.message } });
    throw error;
  }
}
