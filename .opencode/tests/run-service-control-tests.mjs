import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { connectServiceControl, cancelAllServiceTasks } from '../lib/audit-runtime/service-control.mjs';
import { SERVICE_PROTOCOL } from '../lib/audit-runtime/service-process.mjs';

async function fixture(t, options = {}) {
  const serviceRoot = await mkdtemp(join(tmpdir(), 'service-control-'));
  const calls = [], audits = [{ id: 'audit-a', status: 'running', version: 3, provenance: { audit_product_id: 'original-product', product_id: 'current-product' } }];
  let job = { id: 'job-a', status: 'running' }, cancelCount = 0;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    calls.push({ path: req.url, method: req.method, headers: req.headers, body });
    const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/api/v1/runtime/health') return json({ service: 'opencode-audit-workbench', runtime_service: { protocol: SERVICE_PROTOCOL, ready: true, generation: options.mismatched ? 'other' : 'fixture', pid: 1234 }, runtime_build: { source_sha256: 'OLD_DAEMON_CODE' },
      runner: { active_processes: audits.some(row => row.status === 'running') ? 1 : 0 }, dynamic_runner: { active_processes: job ? 1 : 0 } });
    if (req.url.startsWith('/api/v1/audits?')) {
      if (options.invalidList) return json({});
      const page = Number(new URL(req.url, 'http://localhost').searchParams.get('page'));
      return json({ items: page === 1 ? [{ id: 'done', status: 'completed' }] : audits, total_pages: 2 });
    }
    if (req.url === '/api/v1/validation-requests') return json({ items: job ? [{ job }, { job }] : [] });
    if (req.url === '/api/v1/audits/audit-a?live=1') return json(audits[0]);
    if (req.url === '/api/v2/products/original-product/audits/audit-a/actions') {
      cancelCount++;
      if (options.conflict && cancelCount === 1) { audits[0].version++; return json({ code: 'version-mismatch' }, 412); }
      if (options.failCancel) return json({ code: 'agent-session-offline', message: 'PRIVATE_ERROR_DETAIL' }, 409);
      audits[0].status = 'cancelled'; return json(audits[0], 202);
    }
    if (req.url === '/api/v1/validations/job-a/actions') { job = null; return json({ status: 'cancelled' }, 202); }
    return json({ code: 'unexpected-route' }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await writeFile(join(serviceRoot, 'connection.json'), JSON.stringify({ protocol: SERVICE_PROTOCOL, origin, token: 'a'.repeat(64), generation: 'fixture', pid: 1234 }));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(serviceRoot, { force: true, recursive: true }); });
  return { serviceRoot, origin, calls, audits };
}
test('旧代码后台仍可分页列出活动任务，查询不取消、不启动其他 Runner', async t => {
  const f = await fixture(t), control = await connectServiceControl(f);
  assert.deepEqual(await control.tasks(), [{ kind: 'audit', id: 'audit-a', status: 'running' }, { kind: 'validation', id: 'job-a', status: 'running' }]);
  assert.ok(f.calls.every(call => call.method === 'GET'));
});
test('取消使用原产品、当前版本与幂等键；版本冲突重读，动态验证去重', async t => {
  const f = await fixture(t, { conflict: true }), control = await connectServiceControl(f), messages = [];
  await cancelAllServiceTasks(control, { pollMs: 1, notify: message => messages.push(message) });
  const posts = f.calls.filter(call => call.method === 'POST'); assert.equal(posts.length, 3);
  assert.equal(posts[0].headers['if-match'], '"3"'); assert.equal(posts[1].headers['if-match'], '"4"');
  assert.equal(posts[0].headers['idempotency-key'], posts[1].headers['idempotency-key']);
  assert.ok(posts.every(call => call.headers.origin === f.origin && call.body.action === 'cancel'));
  assert.match(messages.at(-1), /已确认没有活动任务/);
});
test('实例变化与列表读取失败均拒绝继续，不把错误当空列表', async t => {
  const wrong = await fixture(t, { mismatched: true }); await assert.rejects(connectServiceControl(wrong), /身份已变化/);
  const invalid = await fixture(t, { invalidList: true }), control = await connectServiceControl(invalid);
  await assert.rejects(cancelAllServiceTasks(control), /分页格式无效/);
  assert.ok([...wrong.calls, ...invalid.calls].every(call => call.method === 'GET'));
});
test('取消失败继续处理其他任务，返回遗留 ID，不泄露后台错误正文或强制改状态', async t => {
  const f = await fixture(t, { failCancel: true }), control = await connectServiceControl(f), messages = [];
  await assert.rejects(cancelAllServiceTasks(control, { pollMs: 1, notify: message => messages.push(message) }), /audit-a（running）/);
  assert.equal(f.calls.filter(call => call.path === '/api/v1/validations/job-a/actions').length, 1);
  assert.doesNotMatch(messages.join('\n'), /PRIVATE_ERROR_DETAIL/);
  assert.equal(f.audits[0].status, 'running');
});
test('正在取消时只轮询，进程未退出或状态未知不宣布结束', async () => {
  let clock = 0, writes = 0;
  for (const pending of [[{ kind: 'audit', id: 'slow-task', status: 'cancelling' }], []]) {
    const control = { health: async () => ({ runner: { active_processes: 1 }, dynamic_runner: { active_processes: 0 } }), tasks: async () => pending, cancel: async () => { writes++; } };
    await assert.rejects(cancelAllServiceTasks(control, { timeoutMs: 5, pollMs: 1, now: () => clock, sleep: async ms => { clock += ms; } }), /尚未确认全部结束/);
  }
  assert.equal(writes, 0);
});
test('CLI 可直接管理旧后台，tasks 为只读，cancel-all 完成后正常退出', async t => {
  const f = await fixture(t);
  const run = command => promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/audit-service.mjs', import.meta.url)), command, '--service-root', f.serviceRoot], { timeout: 10000 });
  const listing = await run('tasks'); assert.match(listing.stdout, /audit-a/); assert.ok(f.calls.every(call => call.method === 'GET'));
  const cancelled = await run('cancel-all'); assert.match(cancelled.stdout, /已确认没有活动任务/); assert.doesNotMatch(cancelled.stdout, new RegExp('a'.repeat(64)));
});
