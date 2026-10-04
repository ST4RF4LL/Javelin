import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductStore } from '../web/dynamic-validation-observatory/product-store.mjs';
import { ProductMemoryStore } from '../lib/product-memory/store.mjs';
import { discoverTree, sourceSnapshot } from '../lib/product-memory/source.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'product-memory-'));
  const source = join(root, 'source'); await mkdir(source); await writeFile(join(source, 'main.py'), 'def entry():\n    return 1\n');
  const products = new ProductStore({ path: join(root, 'catalog.sqlite') }); await products.ready;
  const memory = new ProductMemoryStore({ products, stateRoot: join(root, 'memory') }); await memory.ready;
  const product = await products.createProduct({ name: '测试产品' });
  const target = await products.createTarget(product.id, { name: '代码', source_scopes: [{ name: 'source', path: source }] });
  const repo = await memory.ensureRepo(product.id, target.id, source); const snapshot = await memory.captureSnapshot(product.id, repo.id);
  await memory.bindAudit({ auditId: 'audit-a', productId: product.id, repoId: repo.id, snapshotId: snapshot.id });
  t.after(async () => { await Promise.allSettled([...memory.discoveries.values()]); await products.writeQueue; products.close(); await rm(root, { recursive: true, force: true }); });
  return { root, source, products, memory, product, target, repo, snapshot };
}
const observation = (kind = 'finding') => ({ kind, title: '测试观察', entity_key: 'main.entry', data: { vulnerability_type_id: 'TEST', security_invariant: '调用需要授权' }, evidence_refs: [{ path: 'main.py', line: 1 }] });

test('混合目录发现保留模块并在源码 Repo 边界停止', async t => {
  const f = await fixture(t), root = join(f.root, 'tree');
  await mkdir(join(root, 'module', 'git-repo', '.git'), { recursive: true });
  await mkdir(join(root, 'module', 'exported', 'src'), { recursive: true });
  await writeFile(join(root, 'module', 'exported', 'pyproject.toml'), '[project]\nname="export"');
  const found = await discoverTree(root);
  assert.deepEqual(found.nodes.filter(n => n.kind === 'repo').map(n => n.relative_path), ['module/exported', 'module/git-repo']);
  assert.equal(found.nodes.some(n => n.relative_path.endsWith('/src')), false);
  const bound = await f.memory.bindRoot(f.product.id, { path: root }); await f.memory.refreshRoot(f.product.id, bound.id);
  const ids = f.memory.tree(f.product.id).nodes.filter(n => n.root_id === bound.id && n.kind === 'repo').map(n => n.id);
  await f.memory.refreshRoot(f.product.id, bound.id);
  assert.deepEqual(f.memory.tree(f.product.id).nodes.filter(n => n.root_id === bound.id && n.kind === 'repo').map(n => n.id), ids);
});

test('无 Git 快照与文件差异，部分清单不误报删除', async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'added.py'), 'print(1)');
  const next = await f.memory.captureSnapshot(f.product.id, f.repo.id);
  const diff = await f.memory.compare(f.product.id, f.repo.id, f.snapshot.id, next.id);
  assert.equal(diff.summary.ADDED, 1); assert.equal(diff.summary.UNCHANGED, 1);
  const partial = await sourceSnapshot(f.source, { maxFiles: 1 }); assert.equal(partial.complete, false);
  const uncertain = await f.memory.compare(f.product.id, f.repo.id, f.snapshot.id, next.id, 'interface'); assert.equal(uncertain.comparable, false);
});

test('并发观察幂等且证据不能越过绑定范围', async t => {
  const f = await fixture(t);
  const rows = await Promise.all(Array.from({ length: 8 }, () => f.memory.observe('audit-a', observation(), { taskId: 'task-a' })));
  assert.equal(new Set(rows.map(r => r.id)).size, 1); assert.equal(f.memory.search(f.product.id).total, 1);
  await assert.rejects(() => f.memory.observe('audit-a', { ...observation(), evidence_refs: [{ path: '../other.py' }] }));
  await assert.rejects(() => f.memory.observe('audit-a', { ...observation(), evidence_refs: [{ path: 'missing.py' }] }));
});

test('人工判断保留完整理由、版本、幂等；观察不被改写', async t => {
  const f = await fixture(t), row = await f.memory.observe('audit-a', observation());
  const first = await f.memory.feedback(f.product.id, row.issue_id, { version: 0, human_verdict: 'FALSE_POSITIVE', reason: '外层权限检查支配入口。' }, { idempotencyKey: 'feedback-1' });
  const second = await f.memory.feedback(f.product.id, row.issue_id, { version: 1, human_verdict: 'TRUE_POSITIVE', reason: '发现另一条入口没有通过检查。' }, { idempotencyKey: 'feedback-2' });
  assert.equal(first.version, 1); assert.equal(second.feedback.length, 2); assert.equal(second.feedback[0].reason, '外层权限检查支配入口。');
  assert.equal(f.memory.observation(f.product.id, row.id).trust, 'OBSERVED');
  await assert.rejects(() => f.memory.feedback(f.product.id, row.issue_id, { version: 1, remediation: 'FIX_CLAIMED', reason: '已修改' }, { idempotencyKey: 'feedback-3' }), e => e.statusCode === 412);
  const retry = await f.memory.feedback(f.product.id, row.issue_id, { version: 0, human_verdict: 'FALSE_POSITIVE', reason: '外层权限检查支配入口。' }, { idempotencyKey: 'feedback-1' }); assert.equal(retry.version, 2);
});

test('相同源码证据关联跨轮问题，变化源码不盲目继承结论', async t => {
  const f = await fixture(t), a = await f.memory.observe('audit-a', observation());
  await f.memory.bindAudit({ auditId: 'audit-b', productId: f.product.id, repoId: f.repo.id, snapshotId: f.snapshot.id });
  const b = await f.memory.observe('audit-b', observation()); assert.equal(a.issue_id, b.issue_id);
  await writeFile(join(f.source, 'main.py'), 'def entry():\n    return 2\n'); const next = await f.memory.captureSnapshot(f.product.id, f.repo.id);
  await f.memory.bindAudit({ auditId: 'audit-c', productId: f.product.id, repoId: f.repo.id, snapshotId: next.id });
  const c = await f.memory.observe('audit-c', observation()); assert.notEqual(c.issue_id, a.issue_id);
});

test('产品隔离与 blind 读取隔离', async t => {
  const f = await fixture(t), row = await f.memory.observe('audit-a', observation());
  const other = await f.products.createProduct({ name: '另一个产品' });
  assert.throws(() => f.memory.issue(other.id, row.issue_id), e => e.statusCode === 404);
  await f.memory.bindAudit({ auditId: 'blind', productId: f.product.id, repoId: f.repo.id, snapshotId: f.snapshot.id, mode: 'blind' });
  const context = await f.memory.context('blind', 'task'); assert.equal(context.observations.status, 'SKIPPED'); assert.deepEqual(context.issues, []); assert.deepEqual(context.todos, []);
});

test('长期 TODO 带版本回答，不直接冒充已解决', async t => {
  const f = await fixture(t), row = await f.memory.observe('audit-a', observation('interface'));
  const todo = await f.memory.createTodo(f.product.id, { origin_repo_id: f.repo.id, type: 'FIND_ENTRYPOINT', question: '寻找入口', snapshot_refs: [{ repo_id: f.repo.id, snapshot_id: f.snapshot.id }] }, 'todo-1');
  const answered = await f.memory.todoAction(f.product.id, todo.id, { version: 1, action: 'answer', reason: '已找到调用位置', observation_ids: [row.id] }, f.memory.binding('audit-a'));
  assert.equal(answered.status, 'ANSWERED'); assert.equal(answered.answers.length, 1);
  const resolved = await f.memory.todoAction(f.product.id, todo.id, { version: 2, action: 'resolve', reason: '已完成独立核查' }); assert.equal(resolved.status, 'RESOLVED');
});

test('重复关系不允许跨产品或形成循环', async t => {
  const f = await fixture(t), a = await f.memory.observe('audit-a', observation());
  const b = await f.memory.observe('audit-a', { ...observation(), entity_key: 'other.entry' });
  await f.memory.feedback(f.product.id, a.issue_id, { version: 0, duplicate_of: b.issue_id, reason: '相同修复单元' }, { idempotencyKey: 'duplicate-a' });
  await assert.rejects(() => f.memory.feedback(f.product.id, b.issue_id, { version: 0, duplicate_of: a.issue_id, reason: '反向关联' }, { idempotencyKey: 'duplicate-b' }));
});
