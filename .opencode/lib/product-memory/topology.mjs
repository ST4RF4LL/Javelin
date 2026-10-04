import { realpath, stat } from 'node:fs/promises';
import { join, resolve, basename, relative, isAbsolute, parse as parsePath } from 'node:path';
import { discoverTree, sourceSnapshot } from './source.mjs';
import { uid, now, check, parse, hash, within, atomicJson, text } from './contract.mjs';

export const topologyMethods = {
  tree(productId) {
    this.products.assertProduct(productId);
    return { roots: this.db.prepare('SELECT * FROM pm_roots WHERE product_id=? ORDER BY path').all(productId).map(r => ({ ...r, overrides: parse(r.overrides_json, {}), discovery: parse(r.discovery_json), overrides_json: undefined, discovery_json: undefined })),
      nodes: this.db.prepare('SELECT * FROM pm_nodes WHERE product_id=? ORDER BY path,id').all(productId).map(r => ({ ...r, details: parse(r.details_json, {}), details_json: undefined })) };
  },
  repo(productId, repoId) {
    this.products.assertProduct(productId);
    const row = this.db.prepare("SELECT * FROM pm_nodes WHERE id=? AND product_id=? AND kind='repo'").get(repoId, productId);
    check(row, '产品空间内没有该 Repo。', 404); return { ...row, details: parse(row.details_json, {}) };
  },
  async bindRoot(productId, input) {
    await this.ready; this.products.assertProduct(productId, { writable: true });
    const scope = await this.products.canonicalScope({ name: 'product-root', path: input.path }, 0);
    const roots = this.tree(productId).roots;
    for (const root of roots) check(root.path === scope.path || !within(root.path, scope.path) && !within(scope.path, root.path), '产品根目录不能互相重叠。');
    const result = await this.write(() => {
      const existing = this.db.prepare('SELECT * FROM pm_roots WHERE product_id=? AND path=?').get(productId, scope.path);
      if (existing) return existing;
      const id = uid('root'); this.db.prepare('INSERT INTO pm_roots(id,product_id,path,status,updated_at) VALUES(?,?,?,?,?)').run(id, productId, scope.path, 'PENDING', now());
      this.event(productId, null, 'root.bound', id, { path: scope.path });
      return this.db.prepare('SELECT * FROM pm_roots WHERE id=?').get(id);
    });
    this.refreshRoot(productId, result.id).catch(error => { this.lastError = error.message; });
    return result;
  },
  async refreshRoot(productId, rootId) {
    await this.ready; this.products.assertProduct(productId, { writable: true });
    if (this.discoveries.has(rootId)) return this.discoveries.get(rootId);
    const job = this.discoverRoot(productId, rootId).catch(async error => {
      await this.write(() => this.db.prepare("UPDATE pm_roots SET status='PARTIAL',discovery_json=?,updated_at=? WHERE id=? AND product_id=?").run(JSON.stringify({ gaps: [{ reason: error.message }], complete: false }), now(), rootId, productId)); throw error;
    }).finally(() => this.discoveries.delete(rootId));
    this.discoveries.set(rootId, job); return job;
  },
  async discoverRoot(productId, rootId) {
    const root = this.db.prepare('SELECT * FROM pm_roots WHERE id=? AND product_id=?').get(rootId, productId);
    check(root, '产品根目录不存在。', 404);
    await this.write(() => this.db.prepare("UPDATE pm_roots SET status='SCANNING',updated_at=? WHERE id=?").run(now(), rootId));
    let result;
    try { check(await realpath(root.path) === root.path, '产品目录链接发生变化。'); result = await discoverTree(root.path, { overrides: parse(root.overrides_json, {}) }); }
    catch (error) { result = { nodes: [], gaps: [{ path: '.', reason: error.message }], complete: false }; }
    // Resolve targets outside the catalog transaction; disk checks may await.
    for (const node of result.nodes.filter(n => n.kind === 'repo')) {
      const old = this.db.prepare('SELECT target_id FROM pm_nodes WHERE root_id=? AND relative_path=?').get(rootId, node.relative_path);
      const existing = old?.target_id ? this.products.targetById(old.target_id) : null;
      const matching = existing?.product_id === productId ? existing : this.db.prepare('SELECT t.id FROM audit_targets t JOIN source_scopes s ON s.target_id=t.id WHERE t.product_id=? AND s.path=? ORDER BY t.created_at LIMIT 1').get(productId, node.path);
      try { node.target_id = matching?.id ?? (await this.products.createTarget(productId, { name: node.name, description: '由产品目录发现登记。', source_scopes: [{ name: 'source', path: node.path }] })).id; }
      catch (error) { node.target_error = error.message; result.gaps.push({ path: node.relative_path, reason: error.message }); result.complete = false; }
    }
    return this.write(() => {
      const current = this.db.prepare('SELECT * FROM pm_roots WHERE id=?').get(rootId);
      check(current.version === root.version, '目录规则已变化，发现结果过期。', 409);
      const ids = new Map();
      for (const node of result.nodes) {
        const old = this.db.prepare('SELECT * FROM pm_nodes WHERE root_id=? AND relative_path=?').get(rootId, node.relative_path)
          ?? this.db.prepare('SELECT * FROM pm_nodes WHERE product_id=? AND path=? AND root_id IS NULL AND kind=?').get(productId, node.path, node.kind);
        const id = old?.id ?? uid(node.kind === 'repo' ? 'repo' : 'module'); ids.set(node.relative_path, id);
        if (old?.kind === 'repo' && node.kind !== 'repo') {
          const used = this.db.prepare('SELECT 1 FROM pm_snapshots WHERE repo_id=? LIMIT 1').get(old.id);
          if (used) { result.gaps.push({ path: node.relative_path, reason: '已有审计历史的 Repo 边界不能自动改变，请显式迁移。' }); result.complete = false; continue; }
        }
        this.db.prepare(`INSERT INTO pm_nodes(id,product_id,root_id,parent_id,relative_path,path,name,kind,source_kind,status,target_id,details_json,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET root_id=excluded.root_id,relative_path=excluded.relative_path,parent_id=excluded.parent_id,path=excluded.path,name=excluded.name,kind=excluded.kind,source_kind=excluded.source_kind,status=excluded.status,target_id=COALESCE(excluded.target_id,pm_nodes.target_id),details_json=excluded.details_json,version=pm_nodes.version+1,updated_at=excluded.updated_at`)
          .run(id, productId, rootId, ids.get(node.parent_path) ?? null, node.relative_path, node.path, node.name, node.kind, node.source_kind, node.target_error ? 'UNAVAILABLE' : 'PRESENT', node.target_id ?? null, JSON.stringify(node.details), now());
      }
      for (const old of this.db.prepare('SELECT id,relative_path FROM pm_nodes WHERE root_id=?').all(rootId)) if (!ids.has(old.relative_path)) this.db.prepare('UPDATE pm_nodes SET status=?,version=version+1,updated_at=? WHERE id=?').run(result.complete ? 'MISSING' : 'UNKNOWN', now(), old.id);
      const summary = { ...result, nodes: undefined, nodes_count: result.nodes.length, completed_at: now() };
      this.db.prepare('UPDATE pm_roots SET generation=generation+1,status=?,discovery_json=?,updated_at=? WHERE id=?').run(result.complete ? 'READY' : 'PARTIAL', JSON.stringify(summary), now(), rootId);
      this.event(productId, null, 'root.discovered', rootId, summary); return this.tree(productId);
    });
  },
  async setBoundary(productId, rootId, input) {
    await this.ready; this.products.assertProduct(productId, { writable: true });
    check(!this.discoveries.has(rootId), '目录发现正在执行，请稍后修改边界。', 409);
    await this.write(() => {
      const root = this.db.prepare('SELECT * FROM pm_roots WHERE id=? AND product_id=?').get(rootId, productId);
      check(root, '根目录不存在。', 404); check(root.version === Number(input.version), '目录版本已变化。', 412);
      check(['repo', 'module', 'ignore', 'auto'].includes(input.kind), '边界类型无效。');
      const path = text(input.relative_path, '目录位置', 2000); check(path === '.' || !isAbsolute(path) && path.split(/[\\/]/).every(p => p && p !== '..' && p !== '.'), '目录位置无效。');
      const overrides = parse(root.overrides_json, {}); if (input.kind === 'auto') delete overrides[path]; else overrides[path] = input.kind;
      this.db.prepare('UPDATE pm_roots SET overrides_json=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(overrides), now(), rootId);
    });
    return this.refreshRoot(productId, rootId);
  },
  async ensureRepo(productId, targetId, path, { historical = false } = {}) {
    await this.ready; const target = this.products.getTarget(productId, targetId);
    const canonical = await realpath(path).catch(error => { if (historical) return resolve(path); throw error; });
    const existing = this.db.prepare("SELECT id,path FROM pm_nodes WHERE product_id=? AND kind='repo' AND status='PRESENT' ORDER BY length(path) DESC").all(productId).find(r => within(r.path, canonical));
    if (existing) return this.repo(productId, existing.id);
    return this.write(() => {
      const found = this.db.prepare("SELECT id FROM pm_nodes WHERE product_id=? AND path=? AND kind='repo' AND target_id IS NOT NULL").get(productId, canonical);
      if (found) return this.repo(productId, found.id);
      const id = uid('repo'); this.db.prepare('INSERT INTO pm_nodes(id,product_id,relative_path,path,name,kind,source_kind,status,target_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, productId, '.', canonical, target.name, 'repo', 'directory', 'PRESENT', targetId, now());
      return this.repo(productId, id);
    });
  },
  async captureSnapshot(productId, repoId, sourceRoot = null) {
    await this.ready; const repo = this.repo(productId, repoId); const root = await realpath(sourceRoot ?? repo.path);
    check(within(repo.path, root), '源码子范围不属于该 Repo。');
    const manifest = await sourceSnapshot(root);
    const existing = this.db.prepare('SELECT * FROM pm_snapshots WHERE repo_id=? AND digest=? AND source_root=?').get(repoId, manifest.digest, root);
    if (existing) return this.snapshot(productId, existing.id);
    const id = uid('snapshot'), path = join(this.stateRoot, 'snapshots', `${id}.json`);
    await atomicJson(path, manifest);
    return this.write(() => {
      const same = this.db.prepare('SELECT id FROM pm_snapshots WHERE repo_id=? AND digest=? AND source_root=?').get(repoId, manifest.digest, root);
      if (same) return this.snapshot(productId, same.id);
      this.db.prepare('INSERT INTO pm_snapshots(id,product_id,repo_id,digest,source_root,branch_hint,complete,manifest_path,summary_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, productId, repoId, manifest.digest, root, manifest.branch_hint, manifest.complete ? 1 : 0, path, JSON.stringify({ file_count: manifest.file_count, total_bytes: manifest.total_bytes, gaps: manifest.gaps, excluded_count: manifest.excluded.length }), now());
      this.event(productId, repoId, 'snapshot.created', id, { digest: manifest.digest, complete: manifest.complete }); return this.snapshot(productId, id);
    });
  },
  snapshot(productId, id) {
    this.products.assertProduct(productId); const row = this.db.prepare('SELECT * FROM pm_snapshots WHERE id=? AND product_id=?').get(id, productId);
    check(row, '源码快照不存在。', 404); return { ...row, complete: Boolean(row.complete), summary: parse(row.summary_json, {}), summary_json: undefined };
  },
};
