import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, checkedJson } from '../runtime-testing/controller.mjs';
import { check, digest, EXPLORATION_PROTOCOL, redactStructured } from '../runtime-testing/contract.mjs';
import { controlledBytes, hash } from '../task-board/contract.mjs';
import { runProposalAgent } from './agent.mjs';
import { PROTOCOL, LIMITS, planSchema, normalizePlan, projectPacket, findingRevisions, runtimeSurfaces } from './contract.mjs';

function compact(value, depth = 0) {
  if (typeof value === 'string') return value.length > 1600 ? `${value.slice(0, 1600)}…[摘要截断]` : value;
  if (!value || typeof value !== 'object') return value;
  if (depth > 7) return '[深层内容已省略]';
  if (Array.isArray(value)) return value.slice(0, 12).map(item => compact(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, compact(item, depth + 1)]));
}

export class RuntimeExplorationService {
  constructor({ runtime, staticStore = () => null, planner, onChange = async () => {} }) {
    Object.assign(this, { runtime, staticStore, planner, onChange });
    this.controller = runtime.controller; this.path = join(runtime.root, 'exploration.json');
    this.closed = false; this.running = null; this.abortController = new AbortController();
    this.ready = this.initialize();
  }
  async initialize() {
    await this.controller.ready;
    const grant = this.controller.authorization;
    await mkdir(this.runtime.root, { recursive: true });
    try {
      this.state = await checkedJson(this.runtime.root, 'exploration.json');
      check(this.state.protocol === PROTOCOL && this.state.audit_id === grant.audit_id && this.state.environment_revision === grant.environment_revision, 'exploration-binding-changed');
      if (['PLANNING', 'EXECUTING'].includes(this.state.status)) { this.state.status = 'BLOCKED'; this.state.gaps.push('规划进程中断，保留既有意图和证据；不会自动重放目标操作。'); }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = { protocol: PROTOCOL, audit_id: grant.audit_id, environment_revision: grant.environment_revision,
        status: grant.status === 'SKIPPED' ? 'SKIPPED' : 'WAITING_CONTACT', rounds: 0, scopes: [], facts: [], intents: [], finding_revisions: [],
        consumed_events: [], followup_candidates: [], gaps: [], summary: '等待环境接触与基线证据。' };
    }
    await this.save();
  }
  snapshot() { return this.state ? structuredClone(this.state) : null; }
  publicSnapshot() {
    if (!this.state) return null;
    const { protocol, status, rounds, summary, gaps, scopes, intents, followup_candidates } = this.state;
    return structuredClone({ protocol, status, rounds, summary, gaps, scopes, intents,
      finding_revision_count: this.state.finding_revisions.length, fact_count: this.state.facts.length,
      followup_candidates: followup_candidates.map(({ id, status, source_mapping, reason }) => ({ id, status, source_mapping, reason })) });
  }
  progress() {
    if (!this.state) return null;
    const { status, rounds, summary, gaps } = this.state;
    return { status, rounds, summary, gaps, scope_count: this.state.scopes.length, intent_count: this.state.intents.length,
      finding_revision_count: this.state.finding_revisions.length, source_followup_count: this.state.followup_candidates.length };
  }
  async save() { await atomicJson(this.path, this.state); await this.onChange(this.snapshot()); }
  notify() {
    if (this.closed || this.running) { this.again = !this.closed; return; }
    this.running = Promise.resolve().then(() => this.tick()).catch(async error => {
      this.state.status = this.closed ? 'STOPPED' : 'BLOCKED';
      this.state.gaps.push(`动态规划已停止：${error.code ?? 'PLANNER_FAILED'}。`);
      await this.save();
    }).finally(() => { this.running = null; if (this.again && !this.closed) { this.again = false; this.notify(); } });
  }
  async ingest() {
    const state = this.controller.state, grant = this.controller.authorization;
    const records = await Promise.all(state.evidence.slice(-256).map(async ref => ({ id: ref.id, record: await checkedJson(this.runtime.root, ref.path, ref.sha256) })));
    for (const surface of runtimeSurfaces(records, grant)) {
      if (!this.state.scopes.some(scope => scope.id === surface.id) && this.state.scopes.length < LIMITS.surfaces) {
        this.state.scopes.push(surface);
        this.state.facts.push({ id: `fact-${surface.id}`, kind: 'RUNTIME_OBSERVED', summary: `${surface.method} ${surface.origin}${surface.path}`, evidence_ids: surface.evidence_ids });
      }
    }
    const board = this.staticStore()?.snapshot();
    if (board && board.scope_digest === grant.scope_digest) {
      for (const event of board.outbox ?? []) {
        if (event.type !== 'static.report.accepted' || this.state.consumed_events.includes(event.event_id)) continue;
        const task = board.tasks.find(task => task.task_id === event.task_id && task.attempt_id === event.attempt_id);
        if (!task?.report || task.report.sha256 !== event.payload_sha256) continue;
        const bytes = await controlledBytes(this.staticStore().reportsRoot, task.report.path);
        check(hash(bytes) === task.report.sha256, 'exploration-static-report-changed');
        let report;
        try { report = JSON.parse(bytes.toString('utf8')); } catch { this.state.consumed_events.push(event.event_id); continue; }
        const scopeId = `static-${digest(task.task_id).slice(0, 32)}`;
        if (!this.state.scopes.some(scope => scope.id === scopeId) && this.state.scopes.length >= LIMITS.surfaces) {
          const gap = '动态探索入口已达上限，后续静态报告保留在原任务中，未自动追加运行实验。';
          if (!this.state.gaps.includes(gap)) this.state.gaps.push(gap);
          this.state.consumed_events.push(event.event_id); continue;
        }
        if (!this.state.scopes.some(scope => scope.id === scopeId)) this.state.scopes.push({ id: scopeId, kind: 'STATIC_TASK', task_id: task.task_id,
          spec_digest: task.spec_digest, scope_digest: board.scope_digest, evidence_ids: [event.event_id] });
        this.state.finding_revisions.push(...findingRevisions({ auditId: grant.audit_id, task, report, reportRef: task.report, scopeDigest: board.scope_digest }));
        this.state.facts.push({ id: event.event_id, kind: 'STATIC_HINT', task_id: task.task_id, summary: report.summary,
          runtime_requests: report.runtime_requests ?? [], code_refs: task.code_refs, evidence_ids: [event.event_id] });
        this.state.consumed_events.push(event.event_id);
      }
    }
    for (const event of state.outbox ?? []) {
      if (this.state.consumed_events.includes(event.event_id)) continue;
      const result = await checkedJson(this.runtime.root, event.payload_ref);
      check(result.artifact_digest === event.payload_digest && digest(result) === event.payload_digest, 'exploration-runtime-result-changed');
      const packet = state.packets.find(row => row.id === event.packet_id);
      const fact = { id: event.event_id, kind: 'RUNTIME_OBSERVATION', packet_id: event.packet_id, summary: result.summary,
        outcome: result.outcome, observations: result.observations, gaps: result.gaps, proof: result.proof, evidence_ids: result.evidence_ids,
        evidence_digest: result.artifact_digest, deployment_binding: 'UNKNOWN' };
      this.state.facts.push(fact);
      const intent = this.state.intents.find(row => row.id === event.packet_id);
      if (intent) { intent.status = packet.execution_status; intent.outcome = packet.outcome; intent.result_digest = result.artifact_digest; }
      if (board && packet.phase !== 'CONTACT' && result.outcome === 'SUPPORTED' && this.state.followup_candidates.length < LIMITS.followups) {
        this.state.followup_candidates.push({ id: `followup-${digest(event).slice(0, 32)}`, source: fact, status: 'PROPOSED',
          source_mapping: 'UNKNOWN', reason: '待在冻结源码中定位运行入口；运行行为尚未绑定到具体源码。' });
      }
      this.state.consumed_events.push(event.event_id);
    }
    this.state = redactStructured(this.state, this.controller.privateContext);
    // Scope identity and digests are controlled metadata; redaction must never
    // convert a model-written credential into an executable identity.
    if (!this.controller.closed) await this.controller.exclusive(async () => {
      for (const scope of this.state.scopes) if (!state.scopes.some(row => row.id === scope.id)) state.scopes.push(structuredClone(scope));
      state.finding_revisions = this.state.finding_revisions.map(({ finding, ...binding }) => binding);
      await this.controller.save();
    });
  }
  context() {
    const grant = this.controller.authorization;
    const board = this.staticStore()?.snapshot();
    const currentRevisions = this.state.finding_revisions.filter(revision => !board || board.tasks.some(task =>
      task.task_id === revision.task_id && task.report?.sha256 === revision.report.sha256));
    const context = { protocol: PROTOCOL, audit_id: grant.audit_id, authorization: { protocol: grant.protocol, origins: grant.origins, ssh_targets: grant.ssh_targets ?? [], identities: grant.identities,
      allowed_actions: grant.allowed_actions.filter(action => action !== 'test_mutation'), environment_revision: grant.environment_revision, deployment_binding: 'UNKNOWN' },
      scopes: [], facts: [], finding_revisions: [],
      previous_intents: this.state.intents.map(({ id, scope_ref, question, status, outcome }) => ({ id, scope_ref, question: question.slice(0, 300), status, outcome })),
      limits: LIMITS, remaining_intents: LIMITS.intents - this.state.intents.length,
      context_truncated: false, capabilities: { browser: grant.origins.length ? 'chrome-devtools-mcp' : false, ssh: Boolean(grant.ssh_targets?.length), direct_http: false, shell: false, remote_shell: Boolean(grant.ssh_targets?.length), destructive_operations: false } };
    const append = (field, rows, budget) => {
      let used = 0;
      for (const row of rows) {
        const size = JSON.stringify(row).length;
        if (used + size > budget || JSON.stringify(context).length + size + 2 > LIMITS.contextCharacters) { context.context_truncated = true; continue; }
        context[field].push(row); used += size;
      }
    };
    // Scope objects remain byte-for-byte reproducible for packet binding. Only
    // narrative projections are shortened; original artifacts stay immutable.
    append('scopes', [...this.state.scopes].reverse(), 20000);
    const scopeIds = new Set(context.scopes.map(scope => scope.id));
    append('finding_revisions', currentRevisions.slice(-48).reverse().filter(row => scopeIds.has(row.scope_id)).map(row => ({ ...row, finding: compact(row.finding) })), 18000);
    append('facts', this.state.facts.slice(-64).reverse().map(row => compact(row)), 16000);
    // A scope needs its actual observation reference even when its full fact is
    // outside the narrative budget. References alone do not invent observations.
    for (const scope of context.scopes) if (!context.facts.some(fact => fact.evidence_ids?.some(id => scope.evidence_ids.includes(id)))) {
      append('facts', [{ id: `ref-${scope.id}`, kind: 'EVIDENCE_REFERENCE', evidence_ids: scope.evidence_ids }], 16000);
    }
    if (context.context_truncated) {
      const gap = '规划上下文达到大小上限，仅传递部分证据摘要；完整记录仍保存在动态制品中，未读部分不计为已覆盖。';
      if (!this.state.gaps.includes(gap)) this.state.gaps.push(gap);
    }
    return context;
  }
  async tick() {
    await this.ready;
    if (this.closed || this.controller.authorization.protocol !== EXPLORATION_PROTOCOL) return;
    const current = this.controller.state;
    if (['SKIPPED', 'CLOSED', 'BLOCKED', 'QUARANTINED'].includes(current.status)) {
      if (current.status !== 'SKIPPED') await this.ingest();
      this.state.status = current.status === 'CLOSED' ? 'COMPLETED' : current.status;
      this.state.summary = current.reason ?? '动态分支已结束。'; await this.save(); return;
    }
    if (!current.baseline_packet || current.active_packet || this.runtime.queue.length || this.runtime.draining) return;
    if (this.controller.authorization.mode === 'CONTACT_ONLY') { this.state.status = 'COMPLETED'; await this.save(); return; }
    const before = digest({ events: this.state.consumed_events, scopes: this.state.scopes });
    await this.ingest();
    const inputChanged = before !== digest({ events: this.state.consumed_events, scopes: this.state.scopes });
    if (this.state.status === 'BLOCKED' || this.state.status === 'COMPLETED' && !inputChanged) return;
    if (this.state.rounds >= LIMITS.rounds || this.state.intents.length >= LIMITS.intents
      || current.budget_ms - current.cleanup_reserve_ms - current.elapsed_ms < 10000) {
      this.state.status = 'COMPLETED'; this.state.summary = '本轮动态探索已达到规划、实验或时间预算；未覆盖项保留为缺口。'; if (!this.state.gaps.includes(this.state.summary)) this.state.gaps.push(this.state.summary); await this.save(); return;
    }
    if (!this.state.scopes.length) { this.state.status = 'COMPLETED'; this.state.gaps.push('环境接触未提供可校验的 Web 入口或 SSH 登录证据，未创建黑盒实验。'); await this.save(); return; }
    this.state.status = 'PLANNING'; this.state.rounds++; await this.save();
    const context = this.context(), started = performance.now();
    const proposal = this.planner ? { value: normalizePlan(await this.planner(context, this.abortController.signal), context) }
      : await runProposalAgent({ ...this.runtime, privateRoot: join(this.runtime.privateRoot, 'planner'), role: 'runtime-exploration-planner',
        instructions: await readFile(new URL('./planner.md', import.meta.url), 'utf8'), input: context, schema: planSchema,
        validate: value => normalizePlan(value, context), signal: this.abortController.signal,
        timeoutMs: Math.min(180000, Math.max(10000, current.budget_ms - current.cleanup_reserve_ms - current.elapsed_ms)) });
    if (this.closed) return;
    current.elapsed_ms += proposal.elapsed_ms ?? Math.floor(performance.now() - started);
    await this.controller.save();
    this.state.summary = proposal.value.summary; this.state.gaps.push(...proposal.value.gaps);
    const intents = proposal.value.intents.filter(intent => (this.controller.authorization.mode !== "TARGETED_CONFIRMATION" || intent.finding_revision_id) && !this.state.intents.some(row => row.dedupe_key === intent.dedupe_key)).slice(0, LIMITS.intents - this.state.intents.length);
    this.state.intents.push(...intents); this.state.status = intents.length ? 'EXECUTING' : 'COMPLETED';
    if (!intents.length && !proposal.value.complete) this.state.gaps.push('规划未产生新的可执行意图，已停止重复规划。');
    await this.save();
    for (const intent of intents) {
      if (this.closed || ['CLOSED', 'BLOCKED', 'QUARANTINED'].includes(current.status)) break;
      await this.runtime.enqueue(projectPacket(intent, this.controller.authorization, this.state.finding_revisions));
    }
  }
  async stop() {
    this.closed = true; this.abortController.abort(); await this.running?.catch(() => {});
    await this.ready;
    if (['PLANNING', 'EXECUTING', 'WAITING_CONTACT'].includes(this.state.status)) { this.state.status = 'STOPPED'; await this.save(); }
  }
}
