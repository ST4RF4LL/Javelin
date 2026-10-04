import { Agent as HttpAgent, request as httpRequest, type RequestOptions } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

type Requester = typeof httpRequest;
// 使用独立连接池直接访问配置的原平台；不共享全局 fetch 调度器或环境代理。
export function createUpstreamTransport(requesters: { http?: Requester; https?: Requester } = {}) {
  const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8 });
  const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8 });
  const transport: typeof fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('原平台地址无效。');
    if (options.body != null && typeof options.body !== 'string') throw new TypeError('原平台请求体必须是 JSON 字符串。');
    options.signal?.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      const headers = Object.fromEntries(new Headers(options.headers));
      if (typeof options.body === 'string') headers['content-length'] = String(Buffer.byteLength(options.body));
      const config: RequestOptions = { method: options.method || 'GET', headers, agent: url.protocol === 'https:' ? httpsAgent : httpAgent, signal: options.signal || undefined };
      const makeRequest = url.protocol === 'https:' ? requesters.https || httpsRequest : requesters.http || httpRequest;
      const outgoing = makeRequest(url, config, incoming => {
        const status = incoming.statusCode || 502;
        if (status >= 300 && status < 400 && incoming.headers.location) { incoming.destroy(); reject(new Error('原平台返回了重定向，已停止转发。')); return; }
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach(item => responseHeaders.append(key, item));
          else if (value !== undefined) responseHeaders.set(key, String(value));
        }
        // 不请求压缩，保留原字节流，报告下载与 SSE 都沿用这一条连接。
        const body = [204, 205, 304].includes(status) || options.method === 'HEAD' ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        if (!body) incoming.resume();
        resolve(new Response(body, { status, headers: responseHeaders }));
      });
      outgoing.once('error', reject);
      outgoing.end(options.body || undefined);
    });
  };
  return { fetch: transport, close() { httpAgent.destroy(); httpsAgent.destroy(); } };
}
