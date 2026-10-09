import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { LiveService } from './live.service.js';
import type { RuntimeService } from './runtime.service.js';

const assets: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8',
  'product-memory-ui.js': 'text/javascript; charset=utf-8', 'styles.css': 'text/css; charset=utf-8', 'logo_DJ.png': 'image/png',
};
const publicRoot = new URL('../../../../../.opencode/web/dynamic-validation-observatory/public/', import.meta.url);

export function registerLegacyRoutes(server: FastifyInstance, live: LiveService, runtime: RuntimeService, legacy = false) {
  const page = async (_request: unknown, reply: any) => reply.header('Cache-Control', 'no-store').type(assets['index.html']).send(await readFile(new URL('index.html', publicRoot)));
  for (const path of ['/legacy', '/legacy/', '/legacy/*', '/api/workbench/legacy']) server.get(path, (_request, reply) => reply.code(404).send({ message: '旧界面入口未开放，请显式启用 4173 原界面。' }));
  // Shared feature document for the modern Shadow DOM mount; not a legacy entry.
  server.get('/api/workbench/feature-document', page);
  if (legacy) { server.get('/', page); server.get('/index.html', page); }
  server.get('/workbench', (_request, reply) => reply.redirect(legacy ? process.env.WORKBENCH_MODERN_ORIGIN || 'http://127.0.0.1:4181' : '/'));
  for (const [name, type] of Object.entries(assets)) {
    if (name === 'index.html') continue;
    server.get(`/${name}`, async (_request, reply) => reply.header('Cache-Control', 'no-cache').type(type).send(await readFile(new URL(name, publicRoot))));
  }
  // Both interfaces share the same execution service through same-origin APIs.
  for (const url of ['/api/v1/*', '/api/v2/*', '/api/runs', '/api/runs/*', '/api/health']) {
    server.route({ url, method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], handler: async (request, reply) => {
      const mutation = !['GET', 'HEAD'].includes(request.method);
      if (mutation && runtime.config.liveReadOnly) return reply.code(403).send({ message: '当前入口只读，不能修改原平台。' });
      const path = request.raw.url || request.url;
      // 只允许固定版本的原平台 API，禁止路径归一化后越出命名空间。
      const target = new URL(path, live.origin);
      if (target.origin !== live.origin || !/^\/api\/(?:v[12]\/|runs(?:\/|$)|health$)/.test(target.pathname)) return reply.code(400).send({ message: '原平台接口路径无效。' });
      const abort = new AbortController();
      const close = () => { clearTimeout(timer); abort.abort(); };
      request.raw.once('aborted', close); reply.raw.once('close', close);
      let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(close, mutation ? 60000 : 20000);
      try {
        const headers: Record<string, string> = { Accept: String(request.headers.accept || 'application/json'), Origin: live.origin };
        for (const name of ['if-match', 'idempotency-key', 'last-event-id']) if (typeof request.headers[name] === 'string') headers[name] = request.headers[name];
        if (mutation) headers['Content-Type'] = 'application/json';
        const response = await live.transport(target, { method: request.method, headers, signal: abort.signal, redirect: 'error', ...(mutation ? { body: JSON.stringify(request.body ?? {}) } : {}) });
        if (response.headers.get('content-type')?.includes('text/event-stream')) { clearTimeout(timer); timer = undefined; }
        reply.code(response.status);
        for (const name of ['content-type', 'content-disposition', 'etag', 'cache-control', 'x-accel-buffering']) {
          const value = response.headers.get(name); if (value) reply.header(name, value);
        }
        if (!response.body) return reply.send();
        const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
        body.once('close', () => { clearTimeout(timer); request.raw.removeListener('aborted', close); });
        return reply.send(body);
      } catch {
        clearTimeout(timer); request.raw.removeListener('aborted', close);
        return reply.code(503).send({ message: mutation ? '原平台操作结果未确认，请查询原记录后再决定是否重试。' : '原平台服务暂不可用，请检查平台进程。', code: 'LEGACY_UNAVAILABLE' });
      }
    } });
  }
}
