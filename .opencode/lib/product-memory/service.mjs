import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ProductMemoryStore } from './store.mjs';
import { readBoard } from '../task-board/store.mjs';
import { uid, now, hash, check, parse, page, atomicJson, readBound } from './contract.mjs';

function findingEvidence(finding) {
  const location = finding.location ?? finding.primary_location ?? {};
  const path = location.path ?? location.file ?? finding.file;
  return typeof path === 'string' ? [{ path, ...(Number.isInteger(location.line ?? location.line_start ?? finding.line) ? { line: location.line ?? location.line_start ?? finding.line } : {}) }] : [];
}
function findingEntity(finding, evidence) {
  return evidence.length ? `finding:${hash({ type: finding.vulnerability_type_id ?? finding.type ?? null, title: finding.title, locations: evidence.map(e => ({ path: e.path, symbol: e.symbol ?? null })) })}` : finding.finding_id ?? finding.id ?? finding.candidate_id ?? hash(finding);
}
export class ProductMemoryService {
  constructor({ products, runner, stateRoot }) {
    this.products = products; this.runner = runner;
    this.store = new ProductMemoryStore({ products, stateRoot }); this.ready = this.store.ready; this.ingesting = new Map();
    products.memoryLifecycle = (operation, target, destination) => {
      if (!this.store.db) return;
      const nodes = this.store.db.prepare('SELECT id,root_id,relative_path FROM pm_nodes WHERE target_id=?').all(target.id);
      for (const node of nodes) {
        const active = this.store.db.prepare("SELECT 1 FROM pm_jobs j JOIN pm_campaigns c ON c.id=j.campaign_id WHERE j.repo_id=? AND c.status IN ('RUNNING','PAUSED','CANCELLING') LIMIT 1").get(node.id);
        check(!active, '该对象属于尚未封存的产品批次，请先结束批次。', 409);
        this.detachDiscovery(node);
        this.store.db.prepare("UPDATE pm_nodes SET target_id=NULL,status='DETACHED',version=version+1,updated_at=? WHERE id=?").run(now(), node.id);
        this.store.event(target.product_id, node.id, `repo.target_${operation}`, node.id, { target_id: target.id, destination_product_id: destination ?? null, memory_policy: 'RETAIN_IN_ORIGINAL_PRODUCT' });
      }
    };
    products.memoryScopeChanged = (target, scopes) => {
      if (!this.store.db) return;
      const repo = this.store.db.prepare("SELECT * FROM pm_nodes WHERE target_id=? AND kind='repo'").get(target.id); if (!repo) return;
      check(scopes.length === 1 && !(scopes[0].include_patterns?.length || scopes[0].exclude_patterns?.length), '已有 Repo 记忆的对象须保持单一目录；多 Repo 审计请使用产品批次。', 409);
      if (repo.path === scopes[0].path) return;
      check(!this.store.db.prepare("SELECT 1 FROM pm_jobs j JOIN pm_campaigns c ON c.id=j.campaign_id WHERE j.repo_id=? AND c.status IN ('RUNNING','PAUSED','CANCELLING') LIMIT 1").get(repo.id), '产品批次尚未封存，不能变更 Repo 路径。', 409);
      check(!this.store.db.prepare("SELECT 1 FROM pm_nodes WHERE product_id=? AND path=? AND kind='repo' AND id<>?").get(target.product_id, scopes[0].path, repo.id), '新路径已登记为另一 Repo，不能按路径自动合并历史。', 409);
      this.detachDiscovery(repo);
      this.store.db.prepare("UPDATE pm_nodes SET path=?,root_id=NULL,parent_id=NULL,relative_path='.',status='PRESENT',version=version+1,updated_at=? WHERE id=?").run(scopes[0].path, now(), repo.id);
      this.store.event(target.product_id, repo.id, 'repo.relocated', repo.id, { before: repo.path, after: scopes[0].path, identity: 'EXPLICIT_TARGET_SCOPE_CHANGE' });
    };
  }
  detachDiscovery(node) {
    if (!node.root_id) return;
    const root = this.store.db.prepare('SELECT overrides_json FROM pm_roots WHERE id=?').get(node.root_id);
    if (root) this.store.db.prepare('UPDATE pm_roots SET overrides_json=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify({ ...parse(root.overrides_json, {}), [node.relative_path]: 'ignore' }), now(), node.root_id);
  }
  async prepare(audit, repository, paths) {
    await this.ready;
    const target = this.products.targetById(audit.execution_spec?.target_id ?? audit.repository_id);
    if (!target) return null;
    const repo = await this.store.ensureRepo(target.product_id, target.id, paths.source_root);
    const snapshot = await this.store.captureSnapshot(target.product_id, repo.id, paths.source_root);
    const existing = this.store.binding(audit.id);
    if (existing) check(existing.snapshot_id === snapshot.id, '本次审计源码与已绑定的长期记忆快照不同，请新建审计。', 409, 'memory-source-drift');
    const binding = await this.store.bindAudit({ auditId: audit.id, productId: target.product_id, repoId: repo.id, snapshotId: snapshot.id,
      campaignId: existing?.campaign_id ?? null, mode: existing?.mode ?? audit.memory_mode ?? 'full' });
    audit.memory = { protocol: 'product-memory.v1', product_id: binding.product_id, repo_id: repo.id, snapshot_id: snapshot.id, mode: binding.mode, source_complete: snapshot.complete };
    return this.adapter(audit.id, paths.reports_root, () => audit.provider_session_id);
  }
  adapter(auditId, reportsRoot, primarySession = () => null) {
    return {
      context: (taskId, isolationMode) => this.agentRequest(auditId, { op: 'context' }, { taskId, memoryMode: isolationMode }),
      request: (body, principal = {}) => this.agentRequest(auditId, body, { ...principal, sessionId: Object.hasOwn(principal, 'sessionId') ? principal.sessionId : primarySession() }),
      ingest: (task, attempt) => this.ingestTask(auditId, reportsRoot, task, attempt),
      finalize: board => this.ingestFinal(auditId, reportsRoot, board),
    };
  }
  async agentRequest(auditId, body, principal = {}) {
    await this.ready; let binding = this.store.binding(auditId); check(binding, '记忆绑定不存在。', 409);
    if (principal.memoryMode === 'blind') binding = { ...binding, mode: 'blind' };
    const productId = binding.product_id, taskId = principal.taskId ?? 'recon';
    const repo = this.store.repo(productId, binding.repo_id);
    check(repo.target_id && this.products.targetById(repo.target_id)?.product_id === productId, '对象归属已变化，本会话的记忆权限已失效。', 409);
    const args = body.input ?? {};
    if (body.op === 'context') return this.store.context(auditId, taskId, { ...args, isolation_mode: binding.mode });
    if (['search', 'show', 'issue', 'todos', 'compare'].includes(body.op)) {
      if (['off', 'blind'].includes(binding.mode)) return { status: 'SKIPPED', reason: '本次模式不读取历史记忆。' };
      if (body.op === 'search') return (await this.store.context(auditId, taskId, { ...args, isolation_mode: binding.mode })).observations;
      let result;
      if (body.op === 'todos') { result = binding.mode === 'facts_only' ? { items: [], status: 'SKIPPED' } : this.store.todos(productId, { ...args, limit: Math.min(20, Number(args.limit) || 10) }); result.items = result.items.map(t => ({ ...t, answers: t.answers.slice(-3) })); }
      if (body.op === 'issue') { check(binding.mode === 'full', '本次模式不读取历史漏洞判断。'); const issue = this.store.issue(productId, args.id); result = { ...issue, observations_total: issue.observations.length, observations: issue.observations.slice(-20).map(o => ({ ...o, data: undefined, summary: JSON.stringify(o.data).slice(0, 1200), evidence_refs: o.evidence_refs.slice(0, 5) })), feedback: issue.feedback.slice(-10), relations: issue.relations.slice(-20) }; }
      if (body.op === 'show') { result = this.store.observation(productId, args.id); check(binding.mode !== 'facts_only' || !['finding', 'lesson'].includes(result.kind), '本次模式不读取漏洞经验。'); }
      if (body.op === 'compare') { const diff = await this.store.compare(productId, args.repo_id ?? binding.repo_id, args.before, args.after, args.kind ?? 'files'), { limit, offset } = page(args); result = { ...diff, total: diff.changes.length, changes: diff.changes.slice(offset, offset + limit), limit, offset }; }
      await this.store.saveRead(binding, taskId, body, result);
      return result;
    }
    check(principal.sessionId, '提交记忆需要平台登记的真实 Agent 会话。', 409);
    if (body.op === 'propose') {
      const rows = Array.isArray(args.observations) ? args.observations : [args]; check(rows.length > 0 && rows.length <= 50, '每次提交 1 至 50 条观察。');
      const result = [];
      for (const row of rows) result.push(await this.store.observe(auditId, row, { taskId, sessionId: principal.sessionId }));
      return { items: result };
    }
    if (body.op === 'todo-create') return this.store.createTodo(productId, { ...args, origin_repo_id: binding.repo_id, campaign_id: binding.campaign_id, snapshot_refs: [{ repo_id: binding.repo_id, snapshot_id: binding.snapshot_id }] }, `${auditId}:${taskId}:${args.idempotency_key ?? hash(args)}`);
    if (body.op === 'todo-answer') return this.store.todoAction(productId, args.id, { ...args, action: 'answer', owner: auditId }, binding);
    throw Object.assign(new Error('不支持的记忆操作；Agent 不能修改人工判断。'), { statusCode: 422 });
  }
  async ingestTask(auditId, reportsRoot, task, attempt = {}) {
    if (!task.report || !this.store.binding(auditId)) return;
    const key = `task:${auditId}:${task.task_id}:${task.report.sha256}`;
    return this.ingestOnce(key, task.report.sha256, auditId, async () => {
      const bytes = await readBound(reportsRoot, task.report), report = parse(bytes.toString('utf8'));
      check(report && report.audit_id === auditId && report.task_id === task.task_id, '记忆入库报告身份不一致。');
      const retained = await this.retainEvidence(bytes);
      check(!attempt.session_id || !report.agent_session_id || report.agent_session_id === attempt.session_id, '报告声明的会话与平台登记会话不一致。');
      const options = { taskId: task.task_id, sessionId: attempt.session_id ?? null, trust: attempt.session_id ? 'OBSERVED' : 'PROPOSED' };
      const rows = [...(report.memory_observations ?? []), ...(report.coverage_observations ?? []).map(row => ({ ...row, kind: 'coverage' }))];
      check(rows.length <= 1000, '报告观察数量超过上限。');
      const gaps = [];
      for (const row of rows) try { await this.store.observe(auditId, row, options); } catch (error) { gaps.push(error.message); }
      for (const finding of (report.findings ?? []).slice(0, 500)) {
        let evidence = findingEvidence(finding);
        try { await this.store.evidence(this.store.binding(auditId), evidence); } catch { evidence = []; }
        const data = { ...finding, system_verdict: 'CANDIDATE', source_report: task.report, retained_report: retained };
        await this.store.observe(auditId, { kind: 'finding', entity_key: findingEntity(finding, evidence), title: finding.title ?? '未命名候选', data, evidence_refs: evidence }, options);
      }
      for (const todo of (report.memory_todos ?? []).slice(0, 100)) try {
        const binding = this.store.binding(auditId);
        await this.store.createTodo(binding.product_id, { ...todo, origin_repo_id: binding.repo_id, campaign_id: binding.campaign_id, snapshot_refs: [{ repo_id: binding.repo_id, snapshot_id: binding.snapshot_id }] }, `${key}:${hash(todo)}`);
      } catch (error) { gaps.push(error.message); }
      if (gaps.length) await this.store.observe(auditId, { kind: 'gap', entity_key: `memory-ingestion:${task.task_id}`, title: '部分记忆观察未通过校验', data: { reasons: [...new Set(gaps)] }, evidence_refs: [] }, options);
      return { gaps };
    });
  }
  async ingestOnce(key, digest, auditId, callback) {
    if (this.ingesting.has(key)) return this.ingesting.get(key);
    const binding = this.store.binding(auditId); if (!binding) return;
    const existing = this.store.db.prepare('SELECT * FROM pm_ingestions WHERE source_key=?').get(key);
    if (existing?.status === 'DONE') return;
    const operation = (async () => {
      try {
        const result = await callback();
        await this.store.write(() => this.store.db.prepare("INSERT INTO pm_ingestions(source_key,product_id,digest,status,updated_at) VALUES(?,?,?,'DONE',?) ON CONFLICT(source_key) DO UPDATE SET status='DONE',error=NULL,updated_at=excluded.updated_at").run(key, binding.product_id, digest, now())); return result;
      } catch (error) {
        await this.store.write(() => this.store.db.prepare("INSERT INTO pm_ingestions(source_key,product_id,digest,status,error,updated_at) VALUES(?,?,?,'FAILED',?,?) ON CONFLICT(source_key) DO UPDATE SET status='FAILED',error=excluded.error,updated_at=excluded.updated_at").run(key, binding.product_id, digest, error.message, now())); throw error;
      }
    })().finally(() => this.ingesting.delete(key));
    this.ingesting.set(key, operation); return operation;
  }
  async ingestFinal(auditId, reportsRoot, board) {
    if (!board.final_report || !this.store.binding(auditId)) return;
    const ref = { path: board.final_report.model, sha256: board.final_report.model_sha256 };
    return this.ingestOnce(`final:${auditId}`, ref.sha256, auditId, async () => {
      const bytes = await readBound(reportsRoot, ref), model = parse(bytes.toString('utf8')); check(model?.audit_id === auditId, '最终报告身份不一致。');
      const retained = await this.retainEvidence(bytes);
      for (const finding of [...(model.findings ?? []), ...(model.excluded_findings ?? [])]) {
        let evidence = findingEvidence(finding); try { await this.store.evidence(this.store.binding(auditId), evidence); } catch { evidence = []; }
        await this.store.observe(auditId, { kind: 'finding', entity_key: findingEntity(finding, evidence), title: finding.title ?? '复核结果', data: { ...finding, system_verdict: finding.review?.verdict ?? 'INCONCLUSIVE', source_report: ref, retained_report: retained }, evidence_refs: evidence }, { taskId: 'final-review', trust: 'REVIEWED' });
      }
      return { imported: true };
    });
  }
  async retainEvidence(bytes) {
    const sha256 = hash(bytes), root = join(this.store.stateRoot, 'evidence'); await mkdir(root, { recursive: true });
    await writeFile(join(root, `${sha256}.json`), bytes, { mode: 0o600, flag: 'wx' }).catch(async error => { if (error.code !== 'EEXIST' || hash(await readFile(join(root, `${sha256}.json`))) !== sha256) throw error; });
    return { path: `evidence/${sha256}.json`, sha256 };
  }
  async issueForFinding(productId, finding, workflow = null) {
    await this.ready;
    const prior = this.store.db.prepare('SELECT * FROM pm_finding_links WHERE resource_id=? AND product_id=?').get(finding.resource_id, productId);
    if (prior) return this.store.issue(productId, prior.issue_id);
    const audit = this.runner.getAudit(finding.audit_id); check(audit, '该历史发现缺少可核对的审计归属。', 409);
    const target = this.products.targetById(audit.execution_spec?.target_id ?? audit.repository_id); check(target?.product_id === productId, '发现不属于当前产品。', 404);
    let memoryAuditId = audit.id;
    let binding = this.store.binding(memoryAuditId);
    if (!binding || binding.product_id !== productId) { memoryAuditId = `legacy:${productId}:${audit.id}`; binding = this.store.binding(memoryAuditId); }
    if (!binding) {
      const source = audit.execution_spec?.source_scopes?.[0]?.path ?? target.source_scopes[0]?.path;
      const repo = await this.store.ensureRepo(productId, target.id, source, { historical: true });
      // Historical findings must never acquire a newly read source version.
      const manifest = { protocol: 'repo-source-snapshot.v1', files: [], excluded: [], gaps: [{ reason: '历史任务尚未迁移可复用的逐文件基线；仅保留历史观察。' }] };
      const digest = hash(manifest), id = uid('snapshot'), path = join(this.store.stateRoot, 'snapshots', `${id}.json`);
      await atomicJson(path, { ...manifest, digest });
      const snapshotId = await this.store.write(() => {
        const old = this.store.db.prepare('SELECT id FROM pm_snapshots WHERE repo_id=? AND digest=? AND source_root=?').get(repo.id, digest, source); if (old) return old.id;
        this.store.db.prepare('INSERT INTO pm_snapshots(id,product_id,repo_id,digest,source_root,complete,manifest_path,summary_json,created_at) VALUES(?,?,?,?,?,0,?,?,?)').run(id, productId, repo.id, digest, source, path, JSON.stringify({ legacy: true, gaps: manifest.gaps }), now()); return id;
      });
      binding = await this.store.bindAudit({ auditId: memoryAuditId, productId, repoId: repo.id, snapshotId });
    }
    const found = this.store.db.prepare("SELECT o.id FROM pm_observations o WHERE o.product_id=? AND o.audit_id=? AND o.kind='finding' AND (o.entity_key=? OR json_extract(o.data_json,'$.finding_id')=? OR json_extract(o.data_json,'$.id')=?) ORDER BY o.event_sequence DESC LIMIT 1").get(productId, audit.id, finding.id, finding.id, finding.id);
    const observation = found ? this.store.observation(productId, found.id) : await this.store.observe(memoryAuditId, { kind: 'finding', entity_key: finding.id, title: finding.title ?? '历史发现', data: { ...finding, workflow: undefined, system_verdict: finding.status, historical_import: true }, evidence_refs: [] }, { taskId: 'legacy-import', trust: 'LEGACY_UNBOUND' });
    await this.store.write(() => this.store.db.prepare('INSERT OR IGNORE INTO pm_finding_links(resource_id,product_id,issue_id,audit_id,finding_id) VALUES(?,?,?,?,?)').run(finding.resource_id, productId, observation.issue_id, audit.id, finding.id));
    if (workflow?.version && !this.store.issue(productId, observation.issue_id).feedback.length) {
      const verdict = { confirmed: 'TRUE_POSITIVE', rejected: 'FALSE_POSITIVE', insufficient_evidence: 'INSUFFICIENT_EVIDENCE' }[workflow.status];
      if (verdict) await this.store.feedback(productId, observation.issue_id, { version: 0, human_verdict: verdict, reason: workflow.note || '迁移旧处理状态；原记录未提供理由。', scope: { kind: 'LEGACY', source_status: workflow.status, original_updated_at: workflow.updated_at, missing_history: true } }, { actor: '历史本地操作者', idempotencyKey: `legacy:${finding.resource_id}:${workflow.version}` });
    }
    return this.store.issue(productId, observation.issue_id);
  }
  findingSummary(productId, resourceId, finding = null) {
    if (!this.store.db || !productId) return null;
    const row = this.store.db.prepare('SELECT i.* FROM pm_finding_links l JOIN pm_issues i ON i.id=l.issue_id WHERE l.resource_id=? AND l.product_id=?').get(resourceId, productId)
      ?? (finding && this.store.db.prepare("SELECT i.* FROM pm_observations o JOIN pm_issue_observations io ON io.observation_id=o.id JOIN pm_issues i ON i.id=io.issue_id WHERE o.product_id=? AND o.audit_id=? AND (json_extract(o.data_json,'$.finding_id')=? OR json_extract(o.data_json,'$.id')=?) ORDER BY o.event_sequence DESC LIMIT 1").get(productId, finding.audit_id, finding.id, finding.id));
    if (!row) return null;
    return { issue_id: row.id, human_verdict: row.human_verdict, remediation: row.remediation, duplicate_of: row.duplicate_of, version: row.version,
      observation_count: Number(this.store.db.prepare('SELECT COUNT(DISTINCT o.audit_id) AS n FROM pm_issue_observations io JOIN pm_observations o ON o.id=io.observation_id WHERE io.issue_id=?').get(row.id).n) };
  }
  start() {
    if (this.closed || this.discoveryTimer) return;
    const refresh = async () => {
      await this.ready;
      const roots = this.store.db.prepare("SELECT r.id,r.product_id FROM pm_roots r JOIN products p ON p.id=r.product_id WHERE p.status='active'").all();
      for (const root of roots) { if (this.closed) break; try { await this.store.refreshRoot(root.product_id, root.id); } catch (error) { this.store.lastError = error.message; } }
    };
    this.discoveryTimer = setInterval(() => { refresh().catch(error => { this.store.lastError = error.message; }); }, 5 * 60000); this.discoveryTimer.unref?.();
    refresh().catch(error => { this.store.lastError = error.message; });
    this.ingestionTimer = setInterval(() => { this.reconcile().catch(error => { this.store.lastError = error.message; }); }, 30000); this.ingestionTimer.unref?.();
    this.reconcile().catch(error => { this.store.lastError = error.message; });
  }
  async reconcile() {
    if (this.closed) return; if (this.reconciling) return this.reconciling;
    this.reconciling = (async () => {
      await this.ready;
      const audits = (this.runner.listAudits?.() ?? []).filter(a => a.task_board_path && a.paths?.reports_root && this.store.binding(a.id));
      const offset = (this.reconcileOffset ?? 0) % Math.max(1, audits.length); this.reconcileOffset = offset + 20;
      for (const audit of audits.slice(offset, offset + 20)) {
        if (this.closed) break;
        try {
          const board = await readBoard(audit.task_board_path);
          for (const task of board.tasks.filter(t => t.report)) await this.ingestTask(audit.id, audit.paths.reports_root, task, board.attempts.find(a => a.attempt_id === task.attempt_id));
          if (board.final_report) await this.ingestFinal(audit.id, audit.paths.reports_root, board);
        } catch (error) { this.store.lastError = `审计 ${audit.id} 记忆入库待重试：${error.message}`; }
      }
    })().finally(() => { this.reconciling = null; });
    return this.reconciling;
  }
  async syncLegacyFeedback(productId, finding, workflow) {
    const verdict = { confirmed: 'TRUE_POSITIVE', rejected: 'FALSE_POSITIVE', insufficient_evidence: 'INSUFFICIENT_EVIDENCE' }[workflow.status];
    if (!verdict) return;
    const issue = await this.issueForFinding(productId, finding);
    return this.store.feedback(productId, issue.id, { version: issue.version, human_verdict: verdict, reason: workflow.note || '旧版处理入口未填写理由。', scope: { kind: 'LEGACY', source_status: workflow.status, original_updated_at: workflow.updated_at } }, { idempotencyKey: `workflow:${finding.resource_id}:${workflow.version}` });
  }
  async shutdown() { this.closed = true; clearInterval(this.discoveryTimer); clearInterval(this.ingestionTimer); await this.reconciling; await Promise.allSettled([...this.ingesting.values(), ...this.store.discoveries.values()]); }
}
