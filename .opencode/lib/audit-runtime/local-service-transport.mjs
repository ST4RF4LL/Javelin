import { Agent, request } from 'node:http';

// Local control-plane requests must not inherit fetch dispatchers or proxy settings.
export async function localServiceFetch(input, options = {}) {
  const url = new URL(input);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.hash) {
    throw new TypeError('本机审计服务只接受无凭据的 127.0.0.1 HTTP 地址。');
  }
  if (options.body != null && typeof options.body !== 'string') throw new TypeError('本机审计服务请求体必须是字符串。');
  const signal = options.signal ?? AbortSignal.timeout(5000);
  signal.throwIfAborted();
  const agent = new Agent({ keepAlive: false });
  try {
    return await new Promise((resolve, reject) => {
      const headers = Object.fromEntries(new Headers(options.headers));
      if (options.body != null) headers['content-length'] = String(Buffer.byteLength(options.body));
      const outgoing = request(url, { method: options.method ?? 'GET', headers, agent, signal }, incoming => {
        const status = incoming.statusCode ?? 502;
        incoming.on('error', reject);
        if (status >= 300 && status < 400) {
          incoming.destroy(); reject(Object.assign(new Error('本机审计服务返回重定向，已拒绝跟随。'), { code: 'AUDIT_SERVICE_REDIRECT' })); return;
        }
        const chunks = []; let bytes = 0;
        incoming.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) {
            incoming.destroy(); reject(Object.assign(new Error('本机审计服务响应超过大小限制。'), { code: 'AUDIT_SERVICE_RESPONSE_LIMIT' })); return;
          }
          chunks.push(chunk);
        });
        incoming.on('end', () => {
          try {
            const body = [204, 205, 304].includes(status) || options.method === 'HEAD' ? null : Buffer.concat(chunks);
            resolve(new Response(body, { status, headers: { 'Content-Type': incoming.headers['content-type'] ?? 'application/json' } }));
          } catch (error) { reject(error); }
        });
      });
      outgoing.on('error', reject);
      outgoing.end(options.body);
    });
  } finally { agent.destroy(); }
}

export function serviceRequestErrorCode(error) {
  const seen = new Set();
  let code;
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (current.name === 'TimeoutError') return 'ETIMEDOUT';
    if (typeof current.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(current.code)) code ??= current.code;
  }
  return code ?? 'NETWORK_ERROR';
}
