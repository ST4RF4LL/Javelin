import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { normalizeDecisionModelConfig } from './settings.mjs';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const STATUS_MARKER = '\n__decision_http_status__:';
function failure(message, code = 'decision-model-test-failed', statusCode = 502) {
  return Object.assign(new Error(message), { code, statusCode });
}
function cancelled() { return failure('连接测试已取消。', 'decision-model-test-cancelled', 499); }
function quote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}
function probeBody(config) {
  if (config.protocol === 'systemone') return {
    model: config.model,
    state: 'The connection marker is READY.',
    questions: { ready: { type: 'noul', instructions: '判断 state 中的 connection marker 是否为 READY。', criteria: { true: 'connection marker 为 READY。', false: 'connection marker 不是 READY。' } } },
  };
  return {
    model: config.model,
    messages: [
      { role: 'system', content: 'Return only a JSON object with one boolean field ready.' },
      { role: 'user', content: 'The connection marker is READY. Return {"ready":true} if the marker is READY, otherwise {"ready":false}.' },
    ],
    temperature: 0,
    max_tokens: 128,
    stream: false,
  };
}
function request(config, timeoutMs, signal) {
  if (signal?.aborted) return Promise.reject(cancelled());
  const lines = [
    `url = ${quote(config.endpoint)}`,
    'request = "POST"',
    'header = "Content-Type: application/json"',
    'header = "Accept: application/json"',
    `data-binary = ${quote(JSON.stringify(probeBody(config)))}`,
    `proxy = ${quote(config.proxy)}`,
    `noproxy = ${quote(config.proxy ? '' : '*')}`,
  ];
  if (config.api_key) lines.push(`header = ${quote(`Authorization: Bearer ${config.api_key}`)}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '--disable', '--globoff', '--silent', '--proto', '=http,https', '--max-time', String(timeoutMs / 1000),
      '--max-filesize', String(MAX_RESPONSE_BYTES), '--write-out', `${STATUS_MARKER}%{http_code}`, '--config', '-',
    ], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let bytes = 0, chunks = [], settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      chunks = [];
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const abort = () => finish(cancelled());
    const timer = setTimeout(() => finish(failure('连接测试超时，请检查模型加载状态、API 地址和代理。', 'decision-model-timeout', 504)), timeoutMs);
    child.once('error', error => finish(error.code === 'ENOENT'
      ? failure('未找到 curl，请先在主机安装 curl 并加入 PATH 后重试。', 'decision-model-curl-missing')
      : failure('无法启动连接测试，请检查主机 curl 的可执行权限。')));
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES + STATUS_MARKER.length + 3) finish(failure('接口响应超过 1 MiB，已停止连接测试。', 'decision-model-response-too-large'));
      else chunks.push(chunk);
    });
    child.once('close', code => {
      signal?.removeEventListener('abort', abort);
      if (settled) return;
      if (code === 28) return finish(failure('连接测试超时，请检查模型加载状态、API 地址和代理。', 'decision-model-timeout', 504));
      if (code === 63) return finish(failure('接口响应超过 1 MiB，已停止连接测试。', 'decision-model-response-too-large'));
      if (code !== 0) return finish(failure('无法连接模型接口，请检查 API 地址、代理、证书和服务状态。', 'decision-model-connection-failed'));
      const output = Buffer.concat(chunks).toString('utf8');
      const marker = output.lastIndexOf(STATUS_MARKER);
      const status = output.slice(marker + STATUS_MARKER.length);
      if (marker < 0 || !/^\d{3}$/.test(status)) return finish(failure('接口未返回有效 HTTP 状态。'));
      const body = output.slice(0, marker);
      if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) return finish(failure('接口响应超过 1 MiB，已停止连接测试。', 'decision-model-response-too-large'));
      finish(null, { status: Number(status), body });
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.stdin.end(`${lines.join('\n')}\n`);
  });
}
function parseResult(config, body) {
  let response;
  try { response = JSON.parse(body); } catch { throw failure('接口响应不是有效 JSON，请核对 API 地址和协议。', 'decision-model-response-invalid'); }
  if (!response || typeof response !== 'object' || Array.isArray(response) || (Object.hasOwn(response, 'error') && response.error !== null)) throw failure('接口返回错误或无效数据，请检查模型名称、API Key 和协议。', 'decision-model-response-invalid');
  let result;
  if (config.protocol === 'systemone') {
    const answer = response.answers?.ready;
    if (!answer || answer.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw failure('响应不符合 System One Noul 协议，请核对接口和模型。', 'decision-model-response-invalid');
    result = { noul: answer.noul };
  } else {
    const content = response.choices?.[0]?.message?.content;
    let answer;
    try { answer = typeof content === 'string' ? JSON.parse(content) : null; } catch { /* A successful HTTP status alone is not a successful probe. */ }
    if (!answer || typeof answer !== 'object' || Array.isArray(answer) || answer.ready !== true || Object.keys(answer).length !== 1) throw failure('模型未返回预期的 {"ready":true}，请检查模型和 OpenAI 兼容协议。', 'decision-model-response-invalid');
    result = { ready: true };
  }
  const responseModel = typeof response.model === 'string' && response.model.length <= 240 && !/[\x00-\x1f\x7f]/u.test(response.model)
    ? (config.api_key ? response.model.split(config.api_key).join('[已隐藏]') : response.model) : null;
  const usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].filter(key => Number.isSafeInteger(response.usage?.[key]) && response.usage[key] >= 0).map(key => [key, response.usage[key]]));
  return { result, response_model: responseModel, ...(Object.keys(usage).length ? { usage } : {}) };
}

export async function testDecisionModel(input, { timeoutMs = 30000, signal } = {}) {
  const config = normalizeDecisionModelConfig(input);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw failure('连接测试超时须为 1 至 120000 毫秒。', 'decision-model-timeout-invalid', 422);
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw failure('连接测试取消信号格式无效。', 'decision-model-signal-invalid', 422);
  const started = performance.now();
  const { status, body } = await request(config, timeoutMs, signal);
  if (status < 200 || status >= 300) {
    const hint = status === 401 || status === 403 ? '请检查 API Key 和接口访问权限。'
      : status >= 300 && status < 400 ? '连接测试不跟随重定向，请填写最终 API 地址。'
        : status === 404 ? '请填写完整 API 接口地址，并确认协议。' : status === 429 ? '请稍后重试或检查接口配额。' : '请检查模型名称、协议和服务状态。';
    throw failure(`模型接口返回 HTTP ${status}。${hint}`, 'decision-model-http-error');
  }
  return { ok: true, protocol: config.protocol, model: config.model, latency_ms: Math.round(performance.now() - started), ...parseResult(config, body) };
}
