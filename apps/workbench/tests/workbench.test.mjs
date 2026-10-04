import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../build/api/server/main.js';

let app, origin, upstream, upstreamEvents = 0, failFindings = false;
const upstreamReads = [];
const liveAudit = { id: 'fixture-audit', name: '真实接口契约样例', repository_id: 'fixture-repo', status: 'running', progress: 37, finding_count: 1, version: 8, updated_at: '2026-10-01T10:00:00Z', stages: [{ id: 'scope', label: '范围冻结', state: 'complete' }] };
const previousUpstream = process.env.WORKBENCH_UPSTREAM;
before(async () => {
  upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname; upstreamReads.push(req.url);
    if (path.endsWith('/findings') && failFindings) { res.writeHead(503); res.end('{}'); return; }
    if (path.endsWith('/events')) { upstreamEvents++; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('id: fixture-event-9\ndata: {"type":"audit.updated"}\n\n'); return; }
    res.setHeader('Content-Type', 'application/json');
    if (path.endsWith('/workspace')) res.end(JSON.stringify({ audits: [liveAudit], summary: { audit_count: 1, active_audits: 3, finding_count: 1 }, reports: [] }));
    else if (path === '/api/v2/products') res.end(JSON.stringify({ items: [{ id: 'fixture-product', name: '真实产品目录', target_count: 3, status: 'active' }], count: 1 }));
    else if (path.endsWith('/repositories')) res.end(JSON.stringify({ items: [{ id: 'fixture-repo', name: 'Fixture repository', audit_count: 1 }] }));
    else if (path.endsWith('/findings')) res.end(JSON.stringify({ items: [{ id: 'fixture-finding', title: '接口契约样例', severity: 'HIGH', audit_id: liveAudit.id }], count: 1 }));
    else if (path.endsWith('/logs')) res.end(JSON.stringify({ items: [{ occurred_at: '2026-10-01T10:00:00Z', kind: 'text', label: 'OpenCode', body: 'Fixture event' }] }));
    else if (path.endsWith('/fixture-audit')) res.end(JSON.stringify(liveAudit));
    else if (path.endsWith('/audits')) res.end(JSON.stringify({ items: [liveAudit], count: 1, page: 1, page_size: 20, total_pages: 1 }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  process.env.WORKBENCH_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
  app = await createApp(); await app.listen(0, '127.0.0.1'); origin = await app.getUrl();
});
after(async () => { await app?.close(); upstream?.closeAllConnections(); await new Promise(resolve => upstream?.close(resolve)); if (previousUpstream === undefined) delete process.env.WORKBENCH_UPSTREAM; else process.env.WORKBENCH_UPSTREAM = previousUpstream; });
async function request(path, options) { const response = await fetch(`${origin}/api/workbench/${path}`, options); return { status: response.status, data: await response.json() }; }
const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('预览数据明确标注来源；任务筛选和查询保持一致', async () => {
  const { data } = await request('snapshot'); assert.equal(data.source, 'demo'); assert.equal(data.summary.audits, data.audits.length);
  assert.ok(data.audits.every(a => a.source === 'demo'));
  const running = await request('audits?status=running'); assert.ok(running.data.items.every(a => a.status === 'running'));
  const inactive = await request('audits?status=completed'); assert.ok(inactive.data.items.some(a => a.status === 'paused'));
  const search = await request('audits?q=identity-service'); assert.equal(search.data.count, 1);
  assert.equal((await request('audits?q=no-such-repo')).data.count, 0);
});
test('创建、暂停和恢复演示任务，旧版本操作被拒绝', async () => {
  assert.equal((await request('audits', post({ name: '', repository: 'payment-service' }))).status, 400);
  const created = await request('audits', post({ name: '预览集成测试', repository: 'payment-service' }));
  assert.equal(created.status, 201); assert.equal(created.data.source, 'demo');
  const path = `audits/${created.data.id}/actions`;
  const paused = await request(path, post({ action: 'pause', version: created.data.version })); assert.equal(paused.data.status, 'paused');
  assert.equal((await request(path, post({ action: 'resume', version: created.data.version }))).status, 409);
  const resumed = await request(path, post({ action: 'resume', version: paused.data.version })); assert.equal(resumed.data.status, 'running');
});
test('真实数据模式拒绝写操作，且不接受未知数据源', async () => {
  assert.equal((await request('audits?source=live', post({ name: 'must-not-run' }))).status, 403);
  assert.equal((await request('audits/fixture-audit/actions?source=live', post({ action: 'pause', version: 8 }))).status, 403);
  assert.equal((await request('snapshot?source=unknown')).status, 400);
});
test('跨站写请求被拒绝，同源写请求正常执行', async () => {
  const body = post({ name: '来源检查', repository: 'payment-service' });
  assert.equal((await request('audits', { ...body, headers: { ...body.headers, Origin: 'https://unrelated.invalid' } })).status, 403);
  assert.equal((await request('audits', { ...body, headers: { ...body.headers, Origin: origin } })).status, 201);
});
test('真实 API 适配正确，真实数据不会混入演示记录', async () => {
  const snapshot = await request('snapshot?source=live'); assert.equal(snapshot.data.source, 'live'); assert.equal(snapshot.data.audits[0].id, liveAudit.id); assert.equal(snapshot.data.summary.running, 1);
  assert.equal((await request('findings?source=live')).data.findings[0].severity, 'high');
  assert.equal(snapshot.data.products[0].id, 'fixture-product'); assert.equal(snapshot.data.products[0].targetCount, 3); assert.deepEqual(snapshot.data.products[0].repositories, []);
  const detail = await request('audits/fixture-audit?source=live'); assert.equal(detail.data.version, 8); assert.equal(detail.data.logs[0].message, 'Fixture event');
  assert.equal(detail.data.logs[0].agent, 'OpenCode'); assert.equal(detail.data.logs[0].time, '2026-10-01T10:00:00Z');
  assert.equal(detail.data.stages[0].status, 'done');
  assert.equal((await request('audits?source=live')).data.items[0].source, 'live');
});
test('SSE 建立连接并携带可回放的事件 ID', async () => {
  const abort = new AbortController();
  const response = await fetch(`${origin}/api/workbench/audits/demo-20261001-001/events`, { signal: abort.signal });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(); let text = ''; const deadline = setTimeout(() => abort.abort(), 3000);
  try { while (!text.includes('audit-updated')) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); } assert.match(text, /id: \d+/); assert.match(text, /audit-updated/); }
  finally { clearTimeout(deadline); abort.abort(); await reader.cancel().catch(() => {}); }
});
test('上游 SSE 可以通过 NestJS 传递更新事件', async () => {
  const response = await fetch(`${origin}/api/workbench/audits/fixture-audit/events?source=live`, { signal: AbortSignal.timeout(3000) });
  const body = await response.text(); assert.match(body, /fixture-event-9/); assert.match(body, /audit-updated/); assert.equal(upstreamEvents, 1);
});
test('SPA 深链接可刷新；未知 API 和资源返回 404', async () => {
  const deep = await fetch(`${origin}/audits/demo-20261001-001`, { headers: { Accept: 'text/html' } }); assert.equal(deep.status, 200); assert.match(await deep.text(), /<html lang="zh-CN"/);
  assert.equal((await fetch(`${origin}/api/no-such-api`, { headers: { Accept: 'text/html' } })).status, 404);
  assert.equal((await fetch(`${origin}/assets/no-such-file.js`)).status, 404);
});


test('融合模式默认真实数据并拒绝演示、任务写入；回退地址只取服务端配置', async () => {
  const previousMode = process.env.WORKBENCH_MODE;
  process.env.WORKBENCH_MODE = 'integrated';
  let integrated;
  try {
    integrated = await createApp(); await integrated.listen(0, '127.0.0.1');
    const base = await integrated.getUrl();
    const config = await (await fetch(`${base}/api/workbench/config`)).json();
    assert.equal(config.defaultSource, 'live'); assert.equal(config.demoEnabled, false);
    const snapshot = await (await fetch(`${base}/api/workbench/snapshot`)).json();
    assert.equal(snapshot.source, 'live'); assert.equal(snapshot.audits[0].id, liveAudit.id);
    assert.equal((await fetch(`${base}/api/workbench/snapshot?source=demo`)).status, 403);
    assert.equal((await fetch(`${base}/api/workbench/audits`, post({ name: 'must-not-run' }))).status, 403);
    assert.equal((await fetch(`${base}/api/workbench/audits/demo-id/events?source=demo`)).status, 403);
    const events = await fetch(`${base}/api/workbench/audits/fixture-audit/events`, { signal: AbortSignal.timeout(3000) });
    assert.match(await events.text(), /fixture-event-9/);
    const back = await fetch(`${base}/legacy?next=https://unrelated.invalid`, { redirect: 'manual' });
    assert.equal(back.status, 302); assert.equal(back.headers.get('location'), '/legacy/');
    const preview = await request('config'); assert.equal(preview.data.defaultSource, 'demo'); assert.equal(preview.data.demoEnabled, true);
  } finally { await integrated?.close(); if (previousMode === undefined) delete process.env.WORKBENCH_MODE; else process.env.WORKBENCH_MODE = previousMode; }
});


test('漏洞接口失败不会阻塞概览；任务与工作区沿用原平台缓存读取协议', async () => {
  failFindings = true;
  try {
    assert.equal((await request('snapshot?source=live')).status, 200);
    assert.equal((await request('findings?source=live')).status, 503);
    await request('audits?source=live'); await request('audits/fixture-audit?source=live');
    for (const path of ['/api/v1/workspace', '/api/v1/audits', '/api/v1/audits/fixture-audit']) {
      const reads = upstreamReads.map(value => new URL(value, 'http://fixture')).filter(url => url.pathname === path);
      assert.ok(reads.length > 0); assert.ok(reads.every(url => url.searchParams.get('live') === '1'));
    }
  } finally { failFindings = false; }
});
