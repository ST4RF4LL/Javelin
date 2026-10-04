import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AppModule } from './app.module.js';
import { LiveService } from './live.service.js';
import { RuntimeService } from './runtime.service.js';
import { registerLegacyRoutes } from './legacy-routes.js';

export async function createApp() {
  const adapter = new FastifyAdapter({ bodyLimit: 1024 * 1024, forceCloseConnections: true, genReqId: () => randomUUID() });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { logger: ['error', 'warn'] });
  const server = adapter.getInstance();
  if (!app.get(RuntimeService).config.liveReadOnly) {
    const directory = process.env.WORKBENCH_DIAGNOSTICS_DIR || fileURLToPath(new URL('../../../../../reports/platform/workbench-api/', import.meta.url));
    await mkdir(directory, { recursive: true });
    let warned = false;
    const upstreamFailures = new WeakMap<object, { upstreamPhase: string; upstreamStatus?: number; upstreamCode?: string }>();
    server.addHook('onSend', async (request, reply, payload) => {
      if (reply.statusCode >= 500 && typeof payload === 'string') {
        try {
          const failure = JSON.parse(payload);
          if (['UPSTREAM_TIMEOUT', 'UPSTREAM_UNAVAILABLE'].includes(failure.code) && ['headers', 'body'].includes(failure.upstreamPhase)) {
            upstreamFailures.set(request, { upstreamPhase: failure.upstreamPhase, upstreamStatus: Number.isInteger(failure.upstreamStatus) ? failure.upstreamStatus : undefined, upstreamCode: typeof failure.upstreamCode === 'string' && /^[A-Z0-9_]{1,40}$/.test(failure.upstreamCode) ? failure.upstreamCode : undefined });
          }
        } catch { /* Non-JSON errors have no upstream metadata. */ }
      }
      return payload;
    });
    server.addHook('onResponse', async (request, reply) => {
      if (!request.url.startsWith('/api/')) return;
      const entry = { time: new Date().toISOString(), requestId: request.id, method: request.method, route: request.routeOptions.url || 'unknown', auditId: (request.params as { id?: string })?.id, status: reply.statusCode, durationMs: Math.round(reply.elapsedTime), ...upstreamFailures.get(request) };
      await appendFile(resolve(directory, 'requests.jsonl'), `${JSON.stringify(entry)}\n`).catch(() => { if (!warned) { warned = true; process.stderr.write('新版 API 诊断日志写入失败，请检查报告目录权限。\n'); } });
    });
  }
  server.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-ID', request.id);
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      const allowed = new Set([`http://${request.headers.host}`, 'http://127.0.0.1:5180']);
      if (origin && !allowed.has(origin)) return reply.code(403).send({ message: '拒绝跨站写请求。' });
      if (!origin && request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ message: '拒绝跨站写请求。' });
    }
  });
  registerLegacyRoutes(server, app.get(LiveService), app.get(RuntimeService));
  const root = fileURLToPath(new URL('../../client/', import.meta.url));
  if (existsSync(root)) {
    await app.register(fastifyStatic, { root, wildcard: false });
    server.get('/*', (request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/assets/') || !['GET', 'HEAD'].includes(request.method) || !request.headers.accept?.includes('text/html')) return reply.code(404).send({ message: '资源不存在。' });
      return reply.sendFile('index.html');
    });
  }
  await app.init(); return app;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp(); app.enableShutdownHooks();
  const runtime = app.get(RuntimeService).config;
  const port = Number(process.env.WORKBENCH_PORT || (runtime.mode === 'integrated' ? 4181 : 4180));
  await app.listen(port, '127.0.0.1');
  process.stdout.write(`新版工作台：http://127.0.0.1:${port}（${runtime.mode === 'integrated' ? runtime.liveReadOnly ? '融合入口 · 真实数据只读' : '真实任务运行模式' : '演示预览'}）\n`);
}
