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

export function registerLegacyRoutes(server: FastifyInstance, live: LiveService, runtime: RuntimeService) {
  const page = async (_request: unknown, reply: any) => reply.header('Cache-Control', 'no-store').type(assets['index.html']).send(await readFile(new URL('index.html', publicRoot)));
  server.get('/legacy', (_request, reply) => reply.redirect('/legacy/'));
  server.get('/api/workbench/legacy', (_request, reply) => reply.redirect('/legacy/'));
  server.get('/legacy/', page);
  server.get('/workbench', (_request, reply) => reply.redirect('/'));
  for (const [name, type] of Object.entries(assets)) {
    if (name === 'index.html') continue;
    server.get(`/${name}`, async (_request, reply) => reply.header('Cache-Control', 'no-cache').type(type).send(await readFile(new URL(name, publicRoot))));
  }
  // 原界面的绝对 API 路径在同一端口转发；浏览器无需单独访问 4173。
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
