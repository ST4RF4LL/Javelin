import { readFile } from 'node:fs/promises';
import { check, hash, parse, page } from './contract.mjs';

export async function productMemoryRoute({ request, response, url, memory, campaigns, json, requestJson, assertSafeMutation, validateModel }) {
  const match = url.pathname.match(/^\/api\/v2\/products\/([^/]+)\/(tree|roots|repos|memory|issues|product-audits)(?:\/(.*))?$/);
  if (!match) return false;
  await memory.ready; const store = memory.store, productId = decodeURIComponent(match[1]), area = match[2], parts = (match[3] ?? '').split('/').filter(Boolean).map(decodeURIComponent), query = Object.fromEntries(url.searchParams);
  store.products.assertProduct(productId);
  const mutation = !['GET', 'HEAD'].includes(request.method); if (mutation) { assertSafeMutation(request); store.products.assertProduct(productId, { writable: true }); }
  const body = mutation ? await requestJson(request) : null;
  const version = () => body?.version ?? Number(String(request.headers['if-match'] ?? '0').replaceAll('"', ''));
  const reply = (value, status = 200) => { json(response, status, value); return true; };
  if (area === 'tree' && request.method === 'GET') return reply(store.tree(productId));
  if (area === 'roots') {
    if (!parts.length && request.method === 'POST') return reply(await store.bindRoot(productId, body), 202);
    if (parts.length === 2 && parts[1] === 'refresh' && request.method === 'POST') {
      check(store.tree(productId).roots.some(r => r.id === parts[0]), '根目录不存在。', 404);
      store.refreshRoot(productId, parts[0]).catch(error => { store.lastError = error.message; }); return reply({ status: 'SCANNING' }, 202);
    }
    if (parts.length === 2 && parts[1] === 'boundary' && request.method === 'POST') return reply(await store.setBoundary(productId, parts[0], { ...body, version: version() }));
  }
  if (area === 'repos') {
    const repo = store.repo(productId, parts[0]);
    if (parts.length === 1 && request.method === 'GET') return reply(repo);
    if (parts[1] === 'snapshots' && request.method === 'GET') { const { limit, offset } = page(query); return reply({ items: store.db.prepare('SELECT id FROM pm_snapshots WHERE product_id=? AND repo_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(productId, repo.id, limit, offset).map(r => store.snapshot(productId, r.id)) }); }
    if (parts[1] === 'compare' && request.method === 'POST') { const result = await store.compare(productId, repo.id, body.before, body.after, body.kind ?? 'files'); const { limit, offset } = page(body); return reply({ ...result, total: result.changes.length, changes: result.changes.slice(offset, offset + limit), limit, offset }); }
  }
  if (area === 'memory') {
    if (parts[0] === 'search' && request.method === 'GET') return reply(store.search(productId, query));
    if (parts[0] === 'observations' && parts[1] && request.method === 'GET') return reply(store.observation(productId, parts[1]));
    if (parts[0] === 'todos') {
      if (parts.length === 1 && request.method === 'GET') return reply(store.todos(productId, query));
      if (parts.length === 1 && request.method === 'POST') return reply(await store.createTodo(productId, body, request.headers['idempotency-key']), 201);
      if (parts.length === 2 && request.method === 'GET') return reply(store.todo(productId, parts[1]));
      if (parts.length === 3 && parts[2] === 'actions' && request.method === 'POST') return reply(await store.todoAction(productId, parts[1], { ...body, version: version() }));
    }
  }
  if (area === 'issues') {
    if (!parts.length && request.method === 'GET') return reply(store.issues(productId, query));
    if (parts.length === 1 && request.method === 'GET') return reply(store.issue(productId, parts[0]));
    if (parts.length === 2 && parts[1] === 'feedback' && request.method === 'POST') return reply(await store.feedback(productId, parts[0], { ...body, version: version() }, { idempotencyKey: request.headers['idempotency-key'] }));
    if (parts.length === 2 && parts[1] === 'relations' && request.method === 'POST') return reply(await store.relate(productId, { ...body, from_id: parts[0] }, { confirmed: body.confirmed === true, revoke: body.revoke === true }), 201);
  }
  if (area === 'product-audits') {
    await campaigns.ready;
    if (!parts.length && request.method === 'GET') return reply(campaigns.list(productId, query));
    if (!parts.length && request.method === 'POST') { const model = await validateModel(body); return reply(await campaigns.create(productId, { ...body, model }, request.headers['idempotency-key']), 202); }
    if (parts.length === 1 && request.method === 'GET') return reply(campaigns.get(productId, parts[0]));
    if (parts.length === 2 && parts[1] === 'actions' && request.method === 'POST') return reply(await campaigns.action(productId, parts[0], { ...body, version: version() }));
    if (parts.length === 2 && parts[1] === 'report' && request.method === 'GET') {
      const campaign = campaigns.get(productId, parts[0]); check(campaign.report, '产品报告尚未封存。', 409);
      const bytes = await readFile(campaign.report.path); check(hash(bytes) === campaign.report.sha256, '产品报告摘要校验失败。');
      return reply({ markdown: bytes.toString('utf8'), summary: campaign.report.summary });
    }
  }
  throw Object.assign(new Error('产品记忆接口或操作不存在。'), { statusCode: 404 });
}
