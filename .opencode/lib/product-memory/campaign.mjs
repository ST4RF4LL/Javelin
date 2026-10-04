import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { uid, now, hash, check, text, parse, page, within, atomicJson, readBound } from './contract.mjs';
import { sourceSnapshot } from './source.mjs';
import { runCrossRepoAgent } from './cross-worker.mjs';
import { globalAgentSlots } from '../agent-slots.mjs';
import { readBoard } from '../task-board/store.mjs';

const CHILD_ACTIVE = new Set(['queued', 'preparing', 'recovering', 'running', 'pausing', 'paused', 'cancelling']);
const JOB_TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'GAP']);
export class ProductAuditService {
  constructor({ memory, runner, products, stateRoot, createAudit = null, worker = runCrossRepoAgent, agentSlots = globalAgentSlots }) {
    this.memory = memory; this.store = memory.store; this.runner = runner; this.products = products; this.stateRoot = stateRoot; this.worker = worker; this.agentSlots = agentSlots;
    this.createAudit = createAudit ?? ((input, key) => runner.createAuditFromTarget(input, key)); this.active = new Map(); this.closed = false;
    this.ready = this.initialize();
  }
  async initialize() {
    await this.memory.ready; await mkdir(this.stateRoot, { recursive: true });
    // A running standalone analysis cannot be assumed dead or silently restarted.
    await this.store.write(() => {
      this.store.db.prepare("UPDATE pm_jobs SET status='INTERRUPTED',error='服务重启；请恢复产品批次后重新执行有界分析。',updated_at=? WHERE kind='CROSS_REPO' AND status='RUNNING'").run(now());
      this.store.db.prepare("UPDATE pm_campaigns SET status='PAUSED',version=version+1,updated_at=? WHERE id IN (SELECT campaign_id FROM pm_jobs WHERE status='INTERRUPTED')").run(now());
    });
  }
  start() {
    if (this.closed || this.timer) return;
    this.listener = () => this.tick().catch(error => { this.lastError = error.message; }); this.runner.on?.('event', this.listener);
    this.timer = setInterval(this.listener, 3000); this.timer.unref?.(); this.listener();
  }
  canDispatch(campaignId) { return !this.closed && this.store.db.prepare('SELECT status FROM pm_campaigns WHERE id=?').get(campaignId)?.status === 'RUNNING'; }
  get(productId, id) {
    this.products.assertProduct(productId); const row = this.store.db.prepare('SELECT * FROM pm_campaigns WHERE id=? AND product_id=?').get(id, productId); check(row, '产品审计批次不存在。', 404);
    const jobs = this.store.db.prepare('SELECT * FROM pm_jobs WHERE campaign_id=? ORDER BY created_at,id').all(id).map(j => ({ ...j, spec: parse(j.spec_json), result: parse(j.result_json), spec_json: undefined, result_json: undefined }));
    return { ...row, spec: parse(row.spec_json), report: parse(row.report_json), spec_json: undefined, report_json: undefined, jobs,
      progress: { total: jobs.length, completed: jobs.filter(j => j.status === 'COMPLETED').length, gaps: jobs.filter(j => ['FAILED', 'GAP', 'CANCELLED'].includes(j.status)).length } };
  }
  list(productId, input = {}) {
    this.products.assertProduct(productId); const { limit, offset } = page(input);
    const total = Number(this.store.db.prepare('SELECT COUNT(*) AS n FROM pm_campaigns WHERE product_id=?').get(productId).n);
    return { items: this.store.db.prepare('SELECT id FROM pm_campaigns WHERE product_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(productId, limit, offset).map(r => {
      const campaign = this.get(productId, r.id);
      return { ...campaign, spec: { memory_mode: campaign.spec.memory_mode, repos: campaign.spec.repos.map(({ repo_id, name, snapshot_id }) => ({ repo_id, name, snapshot_id })) }, jobs: campaign.jobs.map(j => ({ ...j, spec: { name: j.spec.name }, result: undefined })) };
    }), total, limit, offset };
  }
  async create(productId, input, idempotencyKey) {
    await this.ready; this.products.assertProduct(productId, { writable: true }); check(this.runner.enabled, '运行驱动未启用。', 503);
    text(idempotencyKey, '幂等键', 200); check(!input.test_environment_enabled, '产品联合审计当前提供静态挖掘；动态测试仍由单 Repo 的显式授权入口执行。');
    const inputDigest = hash(input), old = this.store.db.prepare('SELECT * FROM pm_campaigns WHERE product_id=? AND idempotency_key=?').get(productId, idempotencyKey);
    if (old) { check(old.digest === inputDigest, '产品批次幂等键冲突。', 409); return this.get(productId, old.id); }
    const tree = this.store.tree(productId); let nodes = tree.nodes.filter(n => n.kind === 'repo' && n.status === 'PRESENT');
    if (input.node_id) { const node = tree.nodes.find(n => n.id === input.node_id); check(node, '选择的目录节点不存在。', 404); nodes = nodes.filter(n => within(node.path, n.path)); }
    if (input.repo_ids) { check(Array.isArray(input.repo_ids) && input.repo_ids.length > 0, 'Repo 选择不能为空。'); const ids = new Set(input.repo_ids); nodes = nodes.filter(n => ids.has(n.id)); check(nodes.length === ids.size, '部分 Repo 不存在、不可用或不属于选定范围。'); }
    check(nodes.length > 0 && nodes.length <= 100, '每个批次选择 1 至 100 个可用 Repo。');
    for (const a of nodes) for (const b of nodes) if (a.id !== b.id) check(!within(a.path, b.path), '所选 Repo 源码范围重叠，请先调整目录边界。');
    const repos = [];
    for (const node of nodes) {
      check(node.target_id, 'Repo 未关联审计对象。');
      const target = await this.products.targetExecutionSnapshot(productId, node.target_id);
      check(target.snapshot.source_scopes.length === 1 && target.snapshot.source_scopes[0].path === node.path, 'Repo 对象路径与目录树不同，请刷新或重新关联。');
      const snapshot = await this.store.captureSnapshot(productId, node.id);
      repos.push({ repo_id: node.id, name: node.name, snapshot_id: snapshot.id, source_root: snapshot.source_root, source_digest: snapshot.digest,
        snapshot_manifest: snapshot.manifest_path, complete: snapshot.complete, target_id: node.target_id, target_snapshot: target.snapshot, target_digest: target.digest });
    }
    const spec = { protocol: 'product-audit.v1', repos, roots: tree.roots.map(r => ({ id: r.id, generation: r.generation, version: r.version })),
      scope_gaps: tree.roots.filter(r => r.status !== 'READY').map(r => ({ root_id: r.id, reason: '目录发现尚未完整，报告只覆盖已选择的 Repo。' })),
      model: input.model ?? null, memory_mode: ['full', 'facts_only', 'off', 'blind'].includes(input.memory_mode) ? input.memory_mode : 'full',
      repo_concurrency: Math.min(4, Math.max(1, Number(input.repo_concurrency ?? 2))), max_followup_rounds: Math.min(2, Math.max(0, Number(input.max_followup_rounds ?? 2))), max_followup_jobs: 20,
      analysis_timeout_ms: 10 * 60000, max_analysis_rounds: 3, additional_instructions: text(input.additional_instructions ?? '', '审计说明', 8000, true),
      repo_options: input.repo_options ?? {}, read_watermark: this.store.watermark(productId), created_at: now() };
    check(Number.isInteger(spec.repo_concurrency) && Number.isInteger(spec.max_followup_rounds), '并发或补审预算无效。');
    const id = uid('product-audit');
    await this.store.write(() => {
      const raced = this.store.db.prepare('SELECT id,digest FROM pm_campaigns WHERE product_id=? AND idempotency_key=?').get(productId, idempotencyKey);
      if (raced) { check(raced.digest === inputDigest, '产品批次幂等键冲突。', 409); return; }
      this.store.db.prepare('INSERT INTO pm_campaigns(id,product_id,name,status,spec_json,idempotency_key,digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, productId, text(input.name ?? '产品联合静态审计', '任务名称', 160), 'RUNNING', JSON.stringify(spec), idempotencyKey, inputDigest, now(), now());
      for (const repo of repos) this.insertJob(id, repo.repo_id, 'REPO', 0, { ...repo, repo_options: spec.repo_options[repo.repo_id] ?? {} });
      this.store.event(productId, null, 'campaign.created', id, { repo_ids: repos.map(r => r.repo_id) });
    });
    this.tick().catch(error => { this.lastError = error.message; }); return this.get(productId, this.store.db.prepare('SELECT id FROM pm_campaigns WHERE product_id=? AND idempotency_key=?').get(productId, idempotencyKey).id);
  }
  insertJob(campaignId, repoId, kind, round, spec) {
    const id = uid('job'), auditId = kind === 'CROSS_REPO' ? null : uid('audit');
    this.store.db.prepare('INSERT INTO pm_jobs(id,campaign_id,repo_id,kind,round,status,audit_id,spec_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, campaignId, repoId, kind, round, 'PENDING', auditId, JSON.stringify(spec), now(), now()); return id;
  }
  async updateJob(id, status, result = null, error = null) { return this.store.write(() => this.store.db.prepare('UPDATE pm_jobs SET status=?,result_json=?,error=?,updated_at=? WHERE id=?').run(status, result ? JSON.stringify(result) : null, error, now(), id)); }
  async launchChild(campaign, job) {
    const repo = job.spec, auditId = job.audit_id;
    await this.updateJob(job.id, 'DISPATCHING');
    try {
      await this.store.bindAudit({ auditId, productId: campaign.product_id, repoId: repo.repo_id, snapshotId: repo.snapshot_id, campaignId: campaign.id, mode: campaign.spec.memory_mode });
      const prior = this.runner.getAudit(auditId);
      if (!prior) {
        const instructions = [campaign.spec.additional_instructions, `本次属于产品批次 ${campaign.id}，只审计当前 Repo。使用长期记忆接口查询相关历史和产品待办；候选、误报理由与历史版本必须独立核实。`,
          ...(repo.todo_ids ?? []).map(id => `定向补审待办 ${id}：${this.store.todo(campaign.product_id, id).question}。完成后经 audit-memory todo-answer 关联当前证据。`) ].filter(Boolean).join('\n');
        const options = repo.repo_options ?? {};
        await this.createAudit({ target_id: repo.target_id, execution_spec: repo.target_snapshot, execution_spec_digest: repo.target_digest,
          audit_id: auditId, name: `${campaign.name} · ${repo.name}${job.kind === 'FOLLOWUP' ? ' · 定向补审' : ''}`, model: campaign.spec.model, task_protocol: 'task-board.v1', product_campaign_id: campaign.id,
          memory_mode: campaign.spec.memory_mode, mining_strategy: options.mining_strategy ?? 'focus_area', api_inventory: options.api_inventory ?? '', bac_analysis: options.bac_analysis ?? 'auto',
          additional_instructions_enabled: true, additional_instructions: instructions, test_environment_enabled: false, test_environment_context: '' }, `product-job:${job.id}`);
      }
      if (!this.products.auditLink(auditId)) await this.products.linkAudit({ auditId, productId: campaign.product_id, targetId: repo.target_id, snapshot: repo.target_snapshot, snapshotDigest: repo.target_digest });
      await this.updateJob(job.id, 'RUNNING');
    } catch (error) { await this.updateJob(job.id, 'FAILED', null, error.message); }
  }
  async tick() {
    if (this.closed) return; if (this.pumping) { this.pendingTick = true; return this.pumping; }
    this.pumping = (async () => {
      await this.ready;
      const ids = this.store.db.prepare("SELECT id,product_id FROM pm_campaigns WHERE status IN ('RUNNING','CANCELLING') ORDER BY created_at").all();
      for (const row of ids) {
        let campaign = this.get(row.product_id, row.id);
        for (const job of campaign.jobs.filter(j => j.kind !== 'CROSS_REPO' && ['RUNNING', 'DISPATCHING'].includes(j.status))) {
          const audit = this.runner.getAudit(job.audit_id);
          if (!audit && campaign.status === 'CANCELLING') { await this.updateJob(job.id, 'CANCELLED'); continue; }
          if (!audit && job.status === 'DISPATCHING') { await this.launchChild(campaign, job); continue; }
          if (!audit) { await this.updateJob(job.id, 'GAP', null, '子任务记录缺失，未自动重建已派发的审计。'); continue; }
          if (campaign.status === 'CANCELLING' && CHILD_ACTIVE.has(audit.status) && audit.status !== 'cancelling') {
            try { await this.runner.action(audit.id, 'cancel', audit.version, `product-cancel:${campaign.id}:${audit.id}`); } catch (error) { this.lastError = error.message; }
            continue;
          }
          if (audit.status === 'interrupted') {
            await this.updateJob(job.id, 'INTERRUPTED', null, audit.interruption_reason ?? 'Repo 子任务已中断；恢复产品批次后接续原审计。');
            if (campaign.status === 'RUNNING') await this.store.write(() => this.store.db.prepare("UPDATE pm_campaigns SET status='PAUSED',version=version+1,updated_at=? WHERE id=? AND status='RUNNING'").run(now(), campaign.id));
            continue;
          }
          if (CHILD_ACTIVE.has(audit.status)) continue;
          try {
            if (audit.task_board_path && audit.paths?.reports_root) {
              const board = await readBoard(audit.task_board_path);
              for (const task of board.tasks.filter(t => t.report)) await this.memory.ingestTask(audit.id, audit.paths.reports_root, task, board.attempts.find(a => a.attempt_id === task.attempt_id));
              if (board.final_report) await this.memory.ingestFinal(audit.id, audit.paths.reports_root, board);
            }
          } catch (error) { await this.updateJob(job.id, 'GAP', null, `记忆入库不完整：${error.message}`); continue; }
          await this.updateJob(job.id, audit.status === 'completed' ? 'COMPLETED' : audit.status === 'cancelled' ? 'CANCELLED' : 'FAILED', { audit_id: audit.id, status: audit.status, final_report: audit.final_report_path ?? null }, audit.error ?? null);
        }
        campaign = this.get(row.product_id, row.id);
        if (campaign.status === 'PAUSED') continue;
        if (campaign.status === 'CANCELLING') {
          if (!campaign.jobs.some(j => ['RUNNING', 'DISPATCHING'].includes(j.status)) && !this.active.has(campaign.id)) await this.seal(campaign, 'CANCELLED');
          continue;
        }
        if (this.products.assertProduct(campaign.product_id).status !== 'active') continue;
        await this.planTodos(campaign);
        campaign = this.get(row.product_id, row.id);
        const running = campaign.jobs.filter(j => j.kind !== 'CROSS_REPO' && ['RUNNING', 'DISPATCHING'].includes(j.status)).length;
        for (const job of campaign.jobs.filter(j => j.kind !== 'CROSS_REPO' && j.status === 'PENDING').slice(0, Math.max(0, campaign.spec.repo_concurrency - running))) await this.launchChild(campaign, job);
        campaign = this.get(row.product_id, row.id);
        if (campaign.jobs.some(j => j.kind !== 'CROSS_REPO' && !JOB_TERMINAL.has(j.status))) continue;
        if (this.active.has(campaign.id)) continue;
        const analyses = campaign.jobs.filter(j => j.kind === 'CROSS_REPO').sort((a, b) => a.round - b.round);
        const pending = analyses.find(j => j.status === 'PENDING');
        if (pending) { this.launchCross(campaign, pending); continue; }
        const latest = analyses.at(-1);
        const hasNewChildren = latest && campaign.jobs.some(j => j.kind !== 'CROSS_REPO' && j.round > latest.round);
        if (campaign.spec.repos.length > 1 && (!latest || hasNewChildren) && analyses.length < campaign.spec.max_analysis_rounds) {
          await this.store.write(() => this.insertJob(campaign.id, null, 'CROSS_REPO', analyses.length, { source_refs: campaign.spec.repos.map(r => ({ repo_id: r.repo_id, snapshot_id: r.snapshot_id })) })); this.pendingTick = true; continue;
        }
        if (!analyses.some(j => !JOB_TERMINAL.has(j.status))) await this.seal(campaign);
      }
    })().finally(() => { this.pumping = null; if (this.pendingTick && !this.closed) { this.pendingTick = false; queueMicrotask(() => this.tick().catch(e => { this.lastError = e.message; })); } });
    return this.pumping;
  }
  async planTodos(campaign) {
    if (campaign.spec.memory_mode !== 'full') return;
    const todos = this.store.db.prepare("SELECT id FROM pm_todos WHERE product_id=? AND status='OPEN' ORDER BY created_at LIMIT 100").all(campaign.product_id).map(r => this.store.todo(campaign.product_id, r.id));
    const existing = new Set(campaign.jobs.flatMap(j => (j.spec.todo_ids ?? []).map(id => `${id}:${j.repo_id}`)));
    let count = campaign.jobs.filter(j => j.kind === 'FOLLOWUP').length;
    const round = 1 + Math.max(0, ...campaign.jobs.filter(j => j.kind === 'CROSS_REPO').map(j => j.round));
    if (round > campaign.spec.max_followup_rounds) return;
    for (const todo of todos) {
      const targets = todo.data.target_repo_ids.length ? todo.data.target_repo_ids : campaign.spec.repos.filter(r => r.repo_id !== todo.origin_repo_id).map(r => r.repo_id);
      for (const repo of campaign.spec.repos.filter(r => targets.includes(r.repo_id))) {
        if (existing.has(`${todo.id}:${repo.repo_id}`) || count >= campaign.spec.max_followup_jobs) continue;
        await this.store.write(() => this.insertJob(campaign.id, repo.repo_id, 'FOLLOWUP', round, { ...repo, todo_ids: [todo.id] }));
        existing.add(`${todo.id}:${repo.repo_id}`); count++;
      }
    }
  }
  launchCross(campaign, job) {
    const release = this.agentSlots.tryAcquire(`cross:${campaign.id}`); if (!release) return;
    const controller = new AbortController();
    const promise = this.analyze(campaign, job, controller.signal).catch(async error => this.updateJob(job.id, controller.signal.aborted ? (this.get(campaign.product_id, campaign.id).status === 'CANCELLING' ? 'CANCELLED' : 'INTERRUPTED') : 'FAILED', null, error.message))
      .finally(() => { release(); this.active.delete(campaign.id); this.tick().catch(error => { this.lastError = error.message; }); });
    this.active.set(campaign.id, { controller, promise });
  }
  async analyze(campaign, job, signal) {
    await this.updateJob(job.id, 'RUNNING');
    const sourceManifest = [];
    for (const repo of campaign.spec.repos) {
      const current = await sourceSnapshot(repo.source_root); check(current.digest === repo.source_digest, `Repo ${repo.name} 源码已变化，不能拼接旧版本证据。`, 409);
      sourceManifest.push({ repo_id: repo.repo_id, snapshot_id: repo.snapshot_id, source_root: repo.source_root, snapshot_manifest: repo.snapshot_manifest, digest: repo.source_digest });
    }
    const observations = []; let remaining = 200;
    for (const repo of campaign.spec.repos) {
      const ownAudits = campaign.jobs.filter(j => j.audit_id).map(j => j.audit_id);
      const rows = this.store.search(campaign.product_id, { repo_id: repo.repo_id, snapshot_id: repo.snapshot_id, limit: Math.max(1, Math.min(20, remaining)), ...(['blind', 'off'].includes(campaign.spec.memory_mode) ? { audit_ids: ownAudits } : {}) }, campaign.spec.memory_mode === 'facts_only' ? { mode: 'facts_only' } : null);
      rows.items = rows.items.slice(0, remaining).map(o => ({ ...o, data: undefined, summary: JSON.stringify(o.data).slice(0, 1500), evidence_refs: o.evidence_refs.slice(0, 5) })); remaining -= rows.items.length;
      observations.push({ repo_id: repo.repo_id, ...rows, truncated: rows.total > rows.items.length });
    }
    const base = { protocol: 'cross-repo.v1', campaign_id: campaign.id, memory_mode: campaign.spec.memory_mode, additional_instructions: campaign.spec.additional_instructions, source_manifest: sourceManifest, observations,
      issues: campaign.spec.memory_mode === 'full' ? this.store.issues(campaign.product_id, { limit: 30 }) : { items: [] }, todos: campaign.spec.memory_mode === 'full' ? this.store.todos(campaign.product_id, { limit: 30 }) : { items: [] }, role: 'ANALYZE' };
    const invoke = async (role, extras = {}) => {
      const input = { ...base, ...extras, role }; input.input_digest = hash(input);
      const outputRoot = join(this.stateRoot, campaign.id, job.id, role.toLowerCase());
      await mkdir(outputRoot, { recursive: true }); let loggedBytes = 0;
      const result = await this.worker({ input, outputRoot, runner: this.runner, model: campaign.spec.model, signal: AbortSignal.any([signal, AbortSignal.timeout(campaign.spec.analysis_timeout_ms)]), onLog: async (source, line) => { if (loggedBytes >= 1024 * 1024) return; const chunk = `[${source}] ${line.slice(0, 16000)}\n`; loggedBytes += Buffer.byteLength(chunk); await appendFile(join(outputRoot, 'execution.log'), chunk, { mode: 0o600 }); } });
      check(result.result?.campaign_id === campaign.id && result.result?.input_digest === input.input_digest && result.result?.role === role && result.session_id && result.result.agent_session_id === result.session_id, '跨 Repo 结果绑定不一致。'); return result;
    };
    const analysis = await invoke('ANALYZE'); await this.validateAnalysis(campaign, analysis.result);
    const roles = {};
    if (analysis.result.candidates.length) {
      roles.affirmative = await invoke('AFFIRMATIVE', { analysis: analysis.result, analysis_sha256: analysis.sha256 });
      roles.negative = await invoke('NEGATIVE', { analysis: analysis.result, analysis_sha256: analysis.sha256, affirmative: roles.affirmative.result, affirmative_sha256: roles.affirmative.sha256 });
      roles.moderator = await invoke('MODERATOR', { analysis: analysis.result, analysis_sha256: analysis.sha256, affirmative: roles.affirmative.result, affirmative_sha256: roles.affirmative.sha256, negative: roles.negative.result, negative_sha256: roles.negative.sha256 });
      await this.validateReviews(campaign, analysis, roles);
    }
    check(!signal.aborted && this.canDispatch(campaign.id), '产品批次已暂停或取消。', 409);
    for (const repo of campaign.spec.repos) check((await sourceSnapshot(repo.source_root)).digest === repo.source_digest, `Repo ${repo.name} 在跨 Repo 分析期间发生变化，结果不能封存。`, 409);
    for (const todo of analysis.result.todo_proposals ?? []) await this.store.createTodo(campaign.product_id, { ...todo, campaign_id: campaign.id, snapshot_refs: sourceManifest.filter(r => r.repo_id === todo.origin_repo_id).map(r => ({ repo_id: r.repo_id, snapshot_id: r.snapshot_id })) }, `cross:${job.id}:${hash(todo)}`);
    for (const relation of analysis.result.issue_relations ?? []) await this.store.relate(campaign.product_id, relation);
    await this.store.write(() => {
      for (const candidate of analysis.result.candidates) {
        const reviews = Object.fromEntries(Object.entries(roles).map(([role, value]) => [role, value.result.findings.find(f => f.candidate_id === candidate.candidate_id)]));
        this.store.db.prepare('INSERT INTO pm_candidates(id,product_id,campaign_id,data_json,reviews_json,status,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(`${job.id}:${candidate.candidate_id}`, campaign.product_id, campaign.id, JSON.stringify({ ...candidate, analysis_ref: { path: analysis.path, sha256: analysis.sha256 }, source_manifest: sourceManifest }), JSON.stringify(reviews), reviews.moderator?.verdict ?? 'INCONCLUSIVE', now());
      }
    });
    await this.updateJob(job.id, analysis.result.scope_coverage.some(r => r.status === 'GAP') || analysis.result.gaps.length ? 'GAP' : 'COMPLETED', { analysis, roles });
  }
  async validateAnalysis(campaign, value) {
    const repos = campaign.spec.repos; const ids = repos.map(r => r.repo_id);
    check(value.protocol === 'cross-repo.v1' && Array.isArray(value.scope_coverage) && value.scope_coverage.length === ids.length && new Set(value.scope_coverage.map(r => r.repo_id)).size === ids.length && value.scope_coverage.every(r => ids.includes(r.repo_id) && ['REVIEWED', 'GAP'].includes(r.status) && typeof r.reason === 'string' && r.reason.trim()), '跨 Repo 覆盖不完整。');
    check(Array.isArray(value.edges) && value.edges.length <= 1000 && Array.isArray(value.candidates) && value.candidates.length <= 100 && Array.isArray(value.gaps), '跨 Repo 输出结构无效。');
    const manifests = new Map(); for (const repo of repos) manifests.set(repo.repo_id, new Map((await this.store.manifest(repo.snapshot_id, campaign.product_id)).files.map(f => [f.path, f])));
    const location = ref => { const repo = repos.find(r => r.repo_id === ref?.repo_id); check(repo && ref.snapshot_id === repo.snapshot_id && manifests.get(repo.repo_id).get(ref.path)?.sha256 === ref.sha256 && Number.isInteger(ref.line) && ref.line > 0 && (manifests.get(repo.repo_id).get(ref.path).line_count == null || ref.line <= manifests.get(repo.repo_id).get(ref.path).line_count), '跨 Repo 证据不属于当前版本或位置无效。'); };
    const edgeIds = new Set();
    for (const edge of value.edges) {
      check(typeof edge.id === 'string' && edge.id && !edgeIds.has(edge.id) && ['CALLS', 'PUBLISHES_TO', 'CONSUMES_FROM', 'PROPAGATES_IDENTITY', 'READS', 'WRITES', 'DEPENDS_ON'].includes(edge.kind), '跨 Repo 边类型或身份无效。'); edgeIds.add(edge.id);
      location(edge.from); location(edge.to); check(edge.from.repo_id !== edge.to.repo_id, '跨 Repo 边必须连接两个 Repo。');
      check(edge.claim && Array.isArray(edge.evidence_refs) && edge.evidence_refs.length > 0 && Array.isArray(edge.preconditions), '跨 Repo 边缺少依据与前提。'); edge.evidence_refs.forEach(location);
    }
    const candidateIds = new Set();
    for (const c of value.candidates) {
      check(typeof c.candidate_id === 'string' && c.candidate_id && !candidateIds.has(c.candidate_id) && c.title && c.description && Array.isArray(c.edge_ids) && c.edge_ids.length > 0 && c.edge_ids.every(id => edgeIds.has(id)) && Array.isArray(c.preconditions) && Array.isArray(c.gaps), '链路候选缺少完整边引用。'); candidateIds.add(c.candidate_id);
      for (const id of c.observation_ids ?? []) { const observation = this.store.observation(campaign.product_id, id); check(repos.some(r => r.repo_id === observation.repo_id && r.snapshot_id === observation.snapshot_id), '候选引用了本次范围或版本外观察。'); }
    }
    return location;
  }
  async validateReviews(campaign, analysisRun, roles) {
    const analysis = analysisRun.result, location = await this.validateAnalysis(campaign, analysis);
    const ids = analysis.candidates.map(c => c.candidate_id), sessions = new Set([analysisRun.session_id]);
    const verdicts = { affirmative: ['PROVEN', 'NOT_PROVEN', 'INCONCLUSIVE'], negative: ['REFUTED', 'NOT_REFUTED', 'INCONCLUSIVE'], moderator: ['TRUE_POSITIVE', 'FALSE_POSITIVE', 'INCONCLUSIVE'] };
    for (const [role, value] of Object.entries(roles)) {
      check(!sessions.has(value.session_id), '跨 Repo 正反方与裁决必须使用独立会话。'); sessions.add(value.session_id);
      const rows = value.result.findings; check(Array.isArray(rows) && rows.length === ids.length && new Set(rows.map(r => r.candidate_id)).size === ids.length && rows.every(r => ids.includes(r.candidate_id) && verdicts[role].includes(r.verdict) && r.reason && Array.isArray(r.evidence_refs) && Array.isArray(r.gaps)), '跨 Repo 复核没有逐项覆盖全部候选。');
      check(value.result.analysis_sha256 === analysisRun.sha256, '跨 Repo 复核未绑定分析摘要。');
      for (const row of rows) { row.evidence_refs.forEach(location); if (['PROVEN', 'REFUTED', 'TRUE_POSITIVE', 'FALSE_POSITIVE'].includes(row.verdict)) check(row.evidence_refs.length > 0, '明确复核结论必须携带当前版本证据。'); }
    }
    check(roles.negative.result.affirmative_sha256 === roles.affirmative.sha256 && roles.moderator.result.affirmative_sha256 === roles.affirmative.sha256 && roles.moderator.result.negative_sha256 === roles.negative.sha256, '跨 Repo 三方结果摘要不一致。');
  }
  async seal(campaign, forcedStatus = null) {
    const candidates = this.store.db.prepare('SELECT * FROM pm_candidates WHERE campaign_id=?').all(campaign.id).map(r => ({ ...r, data: parse(r.data_json), reviews: parse(r.reviews_json), data_json: undefined, reviews_json: undefined }));
    const auditIds = campaign.jobs.filter(j => j.audit_id).map(j => j.audit_id);
    const observed = auditIds.length ? this.store.db.prepare(`SELECT o.*,io.issue_id FROM pm_observations o JOIN pm_issue_observations io ON io.observation_id=o.id WHERE o.product_id=? AND o.audit_id IN (${auditIds.map(() => '?').join(',')}) AND o.kind='finding' ORDER BY o.event_sequence`).all(campaign.product_id, ...auditIds) : [];
    const findings = [...new Map(observed.map(o => { const data = parse(o.data_json); return [`${o.audit_id}:${o.issue_id}`, { issue_id: o.issue_id, repo_id: o.repo_id, audit_id: o.audit_id, snapshot_id: o.snapshot_id, observation_id: o.id, title: o.title, verdict: data.system_verdict ?? 'CANDIDATE', evidence_refs: parse(o.evidence_json), retained_report: data.retained_report }]; })).values()];
    const canonical = id => { const seen = new Set(); let current = id; while (!seen.has(current)) { seen.add(current); const next = this.store.db.prepare('SELECT duplicate_of FROM pm_issues WHERE id=? AND product_id=?').get(current, campaign.product_id)?.duplicate_of; if (!next) break; current = next; } return current; };
    const issueSummary = { observed_issues: new Set(findings.map(f => f.issue_id)).size, unique_issues: new Set(findings.map(f => canonical(f.issue_id))).size, affected_repos: new Set(findings.map(f => f.repo_id)).size, confirmed_static_issues: new Set(findings.filter(f => f.verdict === 'TRUE_POSITIVE').map(f => canonical(f.issue_id))).size };
    const deferred = this.store.todos(campaign.product_id, { status: 'OPEN', limit: 100 });
    const gaps = [...campaign.spec.scope_gaps, ...campaign.jobs.filter(j => j.status !== 'COMPLETED').map(j => ({ job_id: j.id, reason: j.error ?? '该部分未完整交付。' })), ...campaign.spec.repos.filter(r => !r.complete).map(r => ({ repo_id: r.repo_id, reason: '源码快照不完整。' }))];
    const status = forcedStatus ?? (gaps.length ? 'PARTIAL' : 'COMPLETED');
    const report = { protocol: 'product-audit.v1', campaign_id: campaign.id, product_id: campaign.product_id, status, source_manifest: campaign.spec.repos.map(({ repo_id, snapshot_id, source_digest }) => ({ repo_id, snapshot_id, source_digest })),
      jobs: campaign.jobs.map(({ id, repo_id, audit_id, kind, status, result, error }) => ({ id, repo_id, audit_id, kind, status, result, error })), findings, issue_summary: issueSummary, candidates, deferred_todos: deferred.items, deferred_todos_total: deferred.total, gaps, created_at: now() };
    const reportRoot = join(this.stateRoot, campaign.id); await mkdir(reportRoot, { recursive: true });
    const body = [`# ${campaign.name}`, '', `产品联合静态审计：${status}。`, `本次范围：${campaign.spec.repos.length} 个 Repo；唯一问题（含未确认候选）：${issueSummary.unique_issues} 个；静态确认问题：${issueSummary.confirmed_static_issues} 个；跨 Repo 确认候选：${candidates.filter(c => c.status === 'TRUE_POSITIVE').length} 个。`, '', '## Repo 与任务结果', '', ...report.jobs.map(j => `- ${j.repo_id ?? '跨 Repo 关联'} / ${j.audit_id ?? j.id}：${j.status}${j.error ? `；${j.error}` : ''}`), '', '## Repo 问题观察', '', ...findings.map(f => `- ${f.title}：${f.verdict}。Repo ${f.repo_id}，审计 ${f.audit_id}，问题 ${f.issue_id}。`), '', '## 跨 Repo 分析', '', ...candidates.map(c => `- ${c.data.title}：${c.status}。${c.reviews.moderator?.reason ?? '尚未形成裁决。'}`), '', '## 缺口与后续待办', '', ...gaps.map(g => `- ${g.reason}`), ...deferred.items.map(t => `- ${t.id}：${t.question}（${t.status}，本轮未据此扩大范围）。`), '', '历史人工判断与本轮机器裁决分别保存；本报告不代表动态测试已执行。', ''].join('\n');
    await atomicJson(join(reportRoot, 'report.json'), report); await writeFile(join(reportRoot, 'report.md'), body, { mode: 0o600 });
    await this.store.write(() => this.store.db.prepare('UPDATE pm_campaigns SET status=?,report_json=?,version=version+1,updated_at=? WHERE id=? AND status IN (\'RUNNING\',\'CANCELLING\')').run(status, JSON.stringify({ path: join(reportRoot, 'report.md'), sha256: hash(body), model_path: join(reportRoot, 'report.json'), summary: { repos: campaign.spec.repos.length, gaps: gaps.length, cross_repo_confirmed: candidates.filter(c => c.status === 'TRUE_POSITIVE').length } }), now(), campaign.id));
  }
  async action(productId, id, input) {
    await this.ready; const campaign = this.get(productId, id); check(campaign.version === Number(input.version), '产品批次版本已变化。', 412);
    check(['pause', 'resume', 'cancel'].includes(input.action), '不支持的产品批次操作。');
    const next = { pause: 'PAUSED', resume: 'RUNNING', cancel: 'CANCELLING' }[input.action];
    check(['RUNNING', 'PAUSED'].includes(campaign.status), '已封存的产品批次不能改写；请创建新批次。', 409);
    await this.store.write(() => {
      check(this.get(productId, id).version === Number(input.version), '产品批次版本已变化。', 412);
      this.store.db.prepare('UPDATE pm_campaigns SET status=?,version=version+1,updated_at=? WHERE id=?').run(next, now(), id);
      if (input.action === 'resume') this.store.db.prepare("UPDATE pm_jobs SET status=CASE WHEN kind='CROSS_REPO' THEN 'PENDING' ELSE 'RUNNING' END,updated_at=? WHERE campaign_id=? AND status='INTERRUPTED'").run(now(), id);
      if (input.action === 'cancel') this.store.db.prepare("UPDATE pm_jobs SET status='CANCELLED',updated_at=? WHERE campaign_id=? AND status IN ('PENDING','INTERRUPTED')").run(now(), id);
    });
    if (input.action !== 'resume') this.active.get(id)?.controller.abort();
    if (input.action !== 'resume') await this.active.get(id)?.promise;
    for (const job of campaign.jobs.filter(j => j.kind !== 'CROSS_REPO' && ['RUNNING', 'DISPATCHING', 'INTERRUPTED'].includes(j.status))) {
      const audit = this.runner.getAudit(job.audit_id); if (!audit || !CHILD_ACTIVE.has(audit.status) && audit.status !== 'interrupted') continue;
      if (input.action === 'resume' && audit.status === 'queued') { this.runner.dispatchQueuedAudit?.(audit.id).catch(error => { this.lastError = error.message; }); continue; }
      const action = input.action === 'cancel' && audit.status !== 'interrupted' ? 'cancel' : input.action === 'pause' && audit.status === 'running' ? 'pause' : input.action === 'resume' && audit.status === 'interrupted' ? 'recover' : input.action === 'resume' && audit.status === 'paused' ? 'resume' : null;
      if (action) try { await this.runner.action(audit.id, action, audit.version, `campaign:${id}:${input.action}:${campaign.version}:${audit.id}`); } catch (error) { this.lastError = error.message; }
    }
    this.tick().catch(error => { this.lastError = error.message; }); return this.get(productId, id);
  }
  async shutdown() { this.closed = true; clearInterval(this.timer); if (this.listener) this.runner.off?.('event', this.listener); for (const active of this.active.values()) active.controller.abort(); await this.pumping; await Promise.allSettled([...this.active.values()].map(a => a.promise)); }
}
