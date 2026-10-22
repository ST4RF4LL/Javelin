import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import WebSocket, { WebSocketServer } from 'ws';
import { listenOptions, listenOrigin } from '../build/api/server/listen-options.js';
import { createApp } from '../build/api/server/main.js';
import { LiveService } from '../build/api/server/live.service.js';
import { terminalPage } from '../scripts/terminal-page.mjs';

const execute = promisify(execFile);
const lan = Object.values(networkInterfaces()).flat().find(item => item && !item.internal && item.family === 'IPv4')?.address;
const listen = async (server, host = '127.0.0.1') => { server.listen(0, host); await once(server, 'listening'); return server.address().port; };

test('监听参数支持 CLI 优先、环境变量、自定义 IPv4/IPv6，拒绝非法参数', () => {
  assert.deepEqual(listenOptions([], {}), { host: '127.0.0.1', port: 4181, legacy: false, help: false });
  assert.equal(listenOptions([], { WORKBENCH_HOST: '192.168.1.25', WORKBENCH_PORT: '4281' }).host, '192.168.1.25');
  assert.deepEqual(listenOptions(['--host=0.0.0.0', '--port', '4281', '--legacy'], { WORKBENCH_HOST: '::1', WORKBENCH_PORT: '4282' }, { allowLegacy: true }), { host: '0.0.0.0', port: 4281, legacy: true, help: false });
  assert.equal(listenOrigin(listenOptions(['--host', '[::1]'], {}).host, 4281), 'http://[::1]:4281');
  for (const args of [['--host'], ['--host='], ['--host', 'http://192.168.1.25'], ['--host', '999.1.1.1'], ['--port', '0'], ['--port', '4183'], ['--port', '65536'], ['--unknown']]) assert.throws(() => listenOptions(args, {}), args.join(' '));
});

test('启动命令帮助和参数错误不启动服务；实际 CLI 可绑定所有网卡及本机指定 IP', { timeout: 30000 }, async () => {
  const platform = fileURLToPath(new URL('../scripts/start-platform.mjs', import.meta.url));
  const help = await execute(process.execPath, [platform, '--help']); assert.match(help.stdout, /--host/);
  await assert.rejects(execute(process.execPath, [platform, '--host', 'bad-address']), /IPv4/);
  for (const alias of ['start:audit-workbench:platform', 'start:audit-workbench:modern']) {
    const result = await execute('npm', ['--prefix', '.opencode', 'run', alias, '--', '--help'], { cwd: fileURLToPath(new URL('../../../', import.meta.url)) });
    assert.match(result.stdout, /WORKBENCH_HOST/);
  }
  for (const host of ['0.0.0.0', lan || '127.0.0.1']) {
    const reservation = http.createServer(), port = await listen(reservation);
    await new Promise(resolve => reservation.close(resolve));
    const child = spawn(process.execPath, [fileURLToPath(new URL('../build/api/server/main.js', import.meta.url)), '--host', host, '--port', String(port)], {
      env: { ...process.env, WORKBENCH_MODE: 'preview', WORKBENCH_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit'); let output = '';
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { clearInterval(poll); reject(new Error(output || '启动超时')); }, 8000);
        const poll = setInterval(() => { if (output.includes('新版工作台：')) { clearInterval(poll); clearTimeout(timer); resolve(); } }, 25);
      });
      assert.match(output, new RegExp(`${host}:${port}`));
      const response = await fetch(`http://${lan || '127.0.0.1'}:${port}/api/workbench/health`, { signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200); assert.equal((await response.json()).mode, 'preview');
    } finally { child.kill('SIGTERM'); await exited; }
  }
});

test('远程 Host 的 API 写入、SSE、终端 HTTP/WS 同源转发；跨站请求和任意代理路径被拒绝', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-listen-'));
  const calls = [], worker = 'a'.repeat(24);
  const gateway = http.createServer((req, res) => {
    calls.push({ path: req.url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ worker, url: `/t/${worker}/` }));
  });
  const terminalPort = await listen(gateway);
  const wss = new WebSocketServer({ server: gateway });
  wss.on('connection', (socket, req) => { calls.push({ path: req.url, headers: req.headers }); socket.on('message', (bytes, binary) => socket.send(bytes, { binary })); });
  const env = { WORKBENCH_MODE: 'integrated', WORKBENCH_ENABLE_TASKS: '1', WORKBENCH_TERMINAL_PORT: String(terminalPort), WORKBENCH_DIAGNOSTICS_DIR: root };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  let app, ws;
  try {
    app = await createApp(); await app.listen(0, '0.0.0.0');
    const port = app.getHttpServer().address().port, origin = `http://${lan || '127.0.0.1'}:${port}`;
    const live = app.get(LiveService);
    live.transport = async (url, options) => {
      assert.equal(options.headers.Origin, live.origin);
      if (String(url).endsWith('/events')) return new Response('data: {"status":"running"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      assert.equal(options.method, 'POST'); assert.deepEqual(JSON.parse(options.body), { name: '内网操作' });
      return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
    };
    const response = await fetch(`${origin}/api/v2/products`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '内网操作' }) });
    assert.equal(response.status, 200);
    assert.match(await (await fetch(`${origin}/api/v1/audits/audit-fixture/events`)).text(), /running/);
    const terminalPath = `/terminal/api/audits/audit-fixture/terminal?generation=test`;
    const connected = await fetch(origin + terminalPath, { method: 'POST', headers: { Origin: origin, Authorization: 'must-not-forward', Cookie: 'private=must-not-forward' } });
    assert.equal(connected.status, 200); assert.equal((await connected.json()).url, `/t/${worker}/`);
    assert.equal(calls[0].headers.origin, `http://127.0.0.1:${terminalPort}`);
    assert.equal(calls[0].headers.authorization, undefined); assert.equal(calls[0].headers.cookie, undefined);
    const frame = await fetch(`${origin}/terminal/t/${worker}/`); assert.equal(frame.headers.get('x-frame-options'), 'SAMEORIGIN');
    const count = calls.length;
    assert.equal((await fetch(origin + terminalPath, { method: 'POST', headers: { Origin: 'http://untrusted.invalid' } })).status, 403);
    assert.equal((await fetch(origin + terminalPath, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${origin}/terminal/api/config`)).status, 404);
    assert.equal(calls.length, count);
    const bad = new WebSocket(`${origin.replace('http:', 'ws:')}/terminal/t/${worker}/ws`, 'tty', { origin: 'http://untrusted.invalid' });
    await assert.rejects(once(bad, 'open'), /403/);
    ws = new WebSocket(`${origin.replace('http:', 'ws:')}/terminal/t/${worker}/ws`, 'tty', { origin }); await once(ws, 'open');
    const echoed = once(ws, 'message'); ws.send(Buffer.from([0, 1, 255, 65]));
    assert.deepEqual((await echoed)[0], Buffer.from([0, 1, 255, 65]));
    assert.equal(calls.at(-1).path, `/t/${worker}/ws`);
    const closed = once(ws, 'close'); await app.close(); app = null; await closed;
  } finally {
    ws?.terminate(); await app?.close(); for (const socket of wss.clients) socket.terminate(); wss.close();
    await new Promise(resolve => gateway.close(resolve));
    for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
});

test('终端页面在平台子路径下保持 API、iframe 和返回链接同源', async () => {
  const nodes = new Map();
  const document = { querySelector: key => { if (!nodes.has(key)) nodes.set(key, {}); return nodes.get(key); } };
  const requests = [];
  const html = terminalPage({ auditId: 'audit-fixture', generation: 'v1' });
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  runInNewContext(script, { document, location: { pathname: '/terminal/audits/audit-fixture/' }, window: { addEventListener() {} }, URLSearchParams, AbortSignal,
    setTimeout() {}, clearTimeout() {}, fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ worker: 'a'.repeat(24), generation: 'v1', url: `/t/${'a'.repeat(24)}/`, readOnly: false }) }; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(requests[0].url, /^\/terminal\/api\/audits\/audit-fixture\/terminal\?/);
  assert.match(nodes.get('#terminal').src, /^\/terminal\/t\//); assert.equal(nodes.get('header a').href, '/workbench');
});

test('只读入口不开放终端代理', async () => {
  const previous = process.env.WORKBENCH_MODE; process.env.WORKBENCH_MODE = 'preview';
  const app = await createApp();
  try {
    for (const method of ['GET', 'POST']) {
      const response = await app.inject({ method, url: '/terminal/api/audits/audit-fixture/terminal', headers: { host: '192.168.1.25:4180', origin: 'http://192.168.1.25:4180' } });
      assert.equal(response.statusCode, 403);
    }
  } finally { await app.close(); previous === undefined ? delete process.env.WORKBENCH_MODE : process.env.WORKBENCH_MODE = previous; }
});
