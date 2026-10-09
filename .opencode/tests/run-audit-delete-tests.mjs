import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditRunner } from '../web/dynamic-validation-observatory/audit-runner.mjs';
import { startAuditService } from '../scripts/audit-service.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'audit-delete-'))), source = join(root, 'source'), config = join(root, 'opencode.json');
  await mkdir(source); await writeFile(join(source, 'keep.txt'), '源码必须保留'); await writeFile(config, '{}');
  const runner = new AuditRunner({ stateRoot: join(root, 'runs'), platformRoot: root, configPath: config, enabled: true,
    spawnProcess() { throw new Error('删除测试禁止启动 Agent'); } });
  const queue = { ready: Promise.resolve(), enqueueNewAudit: async () => true, shutdown: async () => {}, snapshot: async () => ({ enabled: false, items: [] }) };
  const service = await startAuditService({ port: 0, stateRoot: runner.stateRoot, serviceRoot: join(root, 'service'),
    backendOptions: { runner, queueScheduler: queue, platformConfigPath: config, runtimeRoot: join(root, 'reports'), modelCatalog: { snapshot: async () => ({ models: [], sources: [] }) } } });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const store = service.backend.productStore;
  const product = await store.createProduct({ name: '删除测试产品' }), other = await store.createProduct({ name: '其他产品' });
  const target = await store.createTarget(product.id, { name: '被测目录', source_scopes: [{ name: 'source', path: source }] }, { storageNamespace: 'fixture-storage' });
  const request = (path, options = {}) => fetch(`${service.origin}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const response = await request(`/api/v2/products/${product.id}/audits`, { method: 'POST', headers: { 'Idempotency-Key': 'delete-fixture' }, body: JSON.stringify({ target_id: target.id, name: '删除夹具', bac_analysis: 'off' }) });
  assert.equal(response.status, 202, await response.clone().text());
  const audit = await response.json(), path = `/api/v2/products/${product.id}/audits/${audit.id}`;
  const remove = (overrides = {}) => request(overrides.path ?? path, { method: 'DELETE', headers: { 'If-Match': `"${overrides.version ?? runner.getAudit(audit.id)?.version ?? audit.version}"` }, body: JSON.stringify({ confirmation: overrides.confirmation ?? audit.id }) });
  return { root, source, runner, service, store, product, other, target, audit, path, request, remove };
}

test('正式产品删除任务和可归属制品，保留源码、同对象其他任务；解除关联后可删除对象', async t => {
  const f = await fixture(t), reports = join(f.runner.artifactsRoot, f.target.storage_namespace, 'coverage');
  const peer = await (await f.request(`/api/v2/products/${f.product.id}/audits`, { method: 'POST', headers: { 'Idempotency-Key': 'delete-peer' }, body: JSON.stringify({ target_id: f.target.id, name: '保留任务', bac_analysis: 'off' }) })).json();
  await mkdir(reports, { recursive: true });
  const owned = join(reports, `coverage-summary.${f.audit.id}.json`), kept = join(reports, 'coverage-summary.audit-keep.json');
  await writeFile(owned, JSON.stringify({ audit_id: f.audit.id, coverage_status: 'INCOMPLETE' }));
  await writeFile(kept, JSON.stringify({ audit_id: 'audit-keep', coverage_status: 'INCOMPLETE' }));
  await f.request('/api/v1/audits?live=1'); // Prime the display cache before mutation.
  const response = await f.remove(); assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json(); assert.equal(result.deleted, true); assert.equal(result.removed_artifact_files, 1);
  assert.equal(f.runner.getAudit(f.audit.id), null); assert.equal(f.store.auditLink(f.audit.id), null);
  for (const path of [owned, join(f.runner.stateRoot, f.audit.id)]) await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.source, 'keep.txt'), 'utf8'), '源码必须保留'); assert.ok((await stat(kept)).isFile());
  assert.equal((await f.request(f.path)).status, 404);
  for (const path of ['/api/v1/audits?live=1', `/api/v2/products/${f.product.id}/audits?live=1`]) {
    const listing = await (await f.request(path)).json(); assert.equal(listing.items.some(item => item.id === f.audit.id), false);
  }
  assert.ok((await f.store.listProductEvents(f.product.id)).some(event => event.type === 'audit.deleted' && event.resource_id === f.audit.id));
  assert.ok(f.runner.getAudit(peer.id)); assert.ok(f.store.auditLink(peer.id));
  await assert.rejects(f.store.deleteTarget(f.product.id, f.target.id, f.target.version), { code: 'target-has-audits' });
  const peerDelete = await f.request(`/api/v2/products/${f.product.id}/audits/${peer.id}`, { method: 'DELETE', headers: { 'If-Match': `"${peer.version}"` }, body: JSON.stringify({ confirmation: peer.id }) });
  assert.equal(peerDelete.status, 200);
  await f.store.deleteTarget(f.product.id, f.target.id, f.target.version);
  assert.equal(await readFile(join(f.source, 'keep.txt'), 'utf8'), '源码必须保留');
});

test('错误产品、错误确认、过期版本和活动任务均不能删除，也不移除任务关联', async t => {
  const f = await fixture(t);
  assert.equal((await f.remove({ path: `/api/v2/products/${f.other.id}/audits/${f.audit.id}` })).status, 404);
  assert.equal((await f.remove({ confirmation: 'wrong-audit' })).status, 422);
  assert.equal((await f.remove({ version: f.audit.version + 1 })).status, 412);
  assert.equal((await f.remove({ path: `/api/v1/audits/${f.audit.id}` })).status, 409);
  for (const status of ['running', 'paused', 'recovering', 'cancelling']) {
    const audit = f.runner.audits.get(f.audit.id); audit.status = status;
    const response = await f.remove(); assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'audit-delete-active');
    assert.ok(f.store.auditLink(f.audit.id)); assert.ok((await stat(join(f.runner.stateRoot, f.audit.id))).isDirectory());
  }
  f.runner.audits.get(f.audit.id).status = 'cancelled';
  assert.equal((await f.remove()).status, 200);
});

test('对象转移后只能通过当前产品删除，历史产品接口不能越界操作', async t => {
  const f = await fixture(t), audit = f.runner.audits.get(f.audit.id); audit.status = 'completed';
  await f.runner.persist(audit);
  await f.store.transferTarget(f.product.id, f.target.id, f.other.id, f.target.version);
  assert.equal((await f.remove()).status, 404); assert.ok(f.store.auditLink(audit.id));
  assert.equal((await f.remove({ path: `/api/v2/products/${f.other.id}/audits/${audit.id}` })).status, 200);
  assert.equal(f.store.auditLink(audit.id), null);
});

test('删除等待写入落盘时阻止调度和恢复，操作失败后释放删除锁', async t => {
  const f = await fixture(t); let release;
  f.runner.writeQueues.set(f.audit.id, new Promise(resolve => { release = resolve; }));
  const deleting = f.runner.deleteAudit(f.audit.id, { repositoryId: f.target.id, expectedVersion: f.audit.version });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await f.runner.dispatchQueuedAudit(f.audit.id), null);
    await assert.rejects(f.runner.action(f.audit.id, 'recover', f.audit.version, 'concurrent-recovery'), { code: 'audit-operation-in-progress' });
    await assert.rejects(f.runner.deleteAudit(f.audit.id), { code: 'audit-operation-in-progress' });
  } finally { release(); }
  assert.equal((await deleting).deleted, true); assert.equal(f.runner.deleting.size, 0);
  await assert.rejects(f.runner.deleteAudit('invalid', { repositoryId: 'missing' }), { code: 'repository-not-allowed' });
  assert.equal(f.runner.deleting.size, 0);
});
