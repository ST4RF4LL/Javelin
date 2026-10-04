import { Injectable, ServiceUnavailableException, BadRequestException, HttpException } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { Audit, AuditPage, Snapshot, FindingPage, Report, ReportContent, AuditAction, TaskOptions, TaskTarget, TaskModels, RealAuditDraft } from '../shared/contracts.js';
import { createUpstreamTransport } from './upstream-transport.js';
import { readLocalTaskModels } from './local-models.js';
import { createTaskInput, identifier, idempotencyKey, textField } from './task-contract.js';

type Row = Record<string, any>;
type ReadPolicy = { timeoutMs?: number; label?: string; signal?: AbortSignal; format?: 'bytes' };
function normalizeReport(r: Row): Report { return { id: r.id, name: r.name || r.title || '审计报告', auditId: r.audit_id, repository: r.repository_name || r.repository_id || '', date: r.sealed_at || r.updated_at || r.created_at || '', status: r.status || '已归档' }; }
export function normalizeAudit(a: Row): Audit {
  const actions: Record<string, AuditAction[]> = { running: ['pause', 'cancel'], paused: ['resume', 'cancel'], queued: ['dispatch'], failed: ['recover'], interrupted: ['recover'], cancelled: ['recover'] };
  if (a.execution_incomplete) for (const status of ['failed', 'interrupted', 'cancelled']) actions[status] = [];
  return { id: String(a.id), name: a.name || a.id, repository: a.repository_name || a.repository_id || '未关联项目',
    product: a.provenance?.product_name || a.product_name || '未关联产品', branch: a.branch || a.git_ref || a.ref || '—', commit: a.commit || '—',
    productId: a.provenance?.audit_product_id || a.provenance?.product_id || a.product_id, targetId: a.provenance?.target_id || a.target_id || a.repository_id, allowedActions: a.managed === false || a.provenance?.audit_managed === false || a.source === 'artifact' ? [] : (actions[a.status] || []), error: typeof a.error === 'string' ? a.error : undefined,
    runtimeTestingStatus: a.runtime_testing_state?.status || (a.runtime_testing ? '等待调度' : a.task_context?.dynamic_validation_enabled ? '旧版动态验证已启用' : 'SKIPPED'),
    canRetry: ['queued', 'failed', 'interrupted', 'cancelled', 'completed', 'artifact_only'].includes(a.status) && !!a.repository_id,
    executionIncomplete: a.execution_incomplete === true,
    status: a.status, progress: Number(a.progress) || 0, stage: a.stage || '等待调度', findings: Number(a.finding_count) || 0,
    updatedAt: a.updated_at || a.created_at || '', version: a.version || 0, strategy: a.mining_strategy === 'api' ? '逐接口 API 审查' : '高风险 Focus Area',
    model: a.model || '默认模型', tasks: { total: a.todo?.total || 0, done: a.todo?.done || 0, gap: a.todo?.gap || 0 },
    stages: (a.stages || []).map((s: Row) => ({ id: s.id, label: s.label || s.name || s.id, status: ['done', 'complete', 'completed', 'COMPLETE', 'DONE'].includes(s.state || s.status) ? 'done' : ['active', 'running', 'RUNNING'].includes(s.state || s.status) ? 'active' : 'pending' })),
    logs: [], source: 'live' };
}

@Injectable()
export class LiveService {
  readonly origin: string;
  readonly modelSource: 'local' | 'upstream';
  localModels = readLocalTaskModels;
  private readonly upstream = createUpstreamTransport();
  transport: typeof fetch = this.upstream.fetch;
  onModuleDestroy() { this.upstream.close(); }
  constructor() {
    const url = new URL(process.env.WORKBENCH_UPSTREAM || 'http://127.0.0.1:4173');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('WORKBENCH_UPSTREAM 必须为不含凭据的 HTTP(S) origin。');
    this.origin = url.origin;
    const source = process.env.WORKBENCH_MODEL_SOURCE || 'auto';
    if (!['auto', 'local', 'upstream'].includes(source)) throw new Error('WORKBENCH_MODEL_SOURCE 仅支持 auto、local 或 upstream。');
    this.modelSource = source === 'local' || (source === 'auto' && this.origin === 'http://127.0.0.1:4173') ? 'local' : 'upstream';
  }
  async request(path: string, options: RequestInit = {}, policy: ReadPolicy = {}) {
    const controller = new AbortController();
    let upstreamPhase = 'headers';
    let upstreamStatus: number | undefined;
    const signal = options.signal || policy.signal;
    const relayAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) relayAbort(); else signal?.addEventListener('abort', relayAbort, { once: true });
    const timeoutMs = policy.timeoutMs ?? (options.method === 'POST' ? 60000 : 15000);
    const timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs);
    let rejectOnAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = () => reject(controller.signal.reason);
      if (controller.signal.aborted) rejectOnAbort(); else controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
    });
    try {
      return await Promise.race([aborted, (async () => {
        const response = await this.transport(`${this.origin}${path}`, { ...options, signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json', ...options.headers } });
        upstreamPhase = 'body'; upstreamStatus = response.status;
        if (response.ok && policy.format === 'bytes') {
          if (!response.body) throw new Error('Empty report response');
          const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
          try {
            while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 8 * 1024 * 1024) { void reader.cancel(); throw new HttpException('报告超过 8 MiB 大小限制。', 413); } chunks.push(value); }
          } finally { reader.releaseLock(); }
          return { bytes: Buffer.concat(chunks), disposition: response.headers.get('content-disposition') };
        }
        const data = await response.json().catch(() => null) as Row | null;
        if (!response.ok) throw new HttpException({ message: typeof data?.message === 'string' ? data.message : typeof data?.error === 'string' ? data.error : `原平台返回 HTTP ${response.status}`, code: data?.code || data?.error }, response.status);
        if (!data || typeof data !== 'object') throw new Error('Invalid upstream JSON');
        return data;
      })()]);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const cause = error as { code?: unknown; cause?: { code?: unknown } } | null;
      const rawCode = cause?.code || cause?.cause?.code;
      const upstreamCode = typeof rawCode === 'string' && /^[A-Z0-9_]{1,40}$/.test(rawCode) ? rawCode : undefined;
      const message = policy.label ? `${policy.label}${controller.signal.aborted ? '读取超时' : '连接失败'}，请重试。` : options.method === 'POST' ? '未能确认原平台的操作结果。请先刷新任务列表；再次提交时会沿用原任务编号，避免重复运行。' : '原工作台暂不可用，请检查原平台服务。';
      throw new ServiceUnavailableException({ message, dependency: policy.label, code: controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE', upstreamPhase, upstreamStatus, upstreamCode });
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', relayAbort); controller.signal.removeEventListener('abort', rejectOnAbort);
    }
  }
  read(path: string, policy: ReadPolicy = {}) { return this.request(path, {}, policy); }
  private write(path: string, body: Row, key?: string, version?: number) {
    return this.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: this.origin, ...(key ? { 'Idempotency-Key': key } : {}), ...(version !== undefined ? { 'If-Match': `"${version}"` } : {}) }, body: JSON.stringify(body) });
  }
  private async catalogue(path: string, label: string, status = 'active') {
    const items: Row[] = [];
    const signal = AbortSignal.timeout(5000);
    for (let page = 1; ; page++) {
      const result = await this.read(`${path}?status=${status}&page_size=100&page=${page}`, { timeoutMs: 5000, signal, label });
      items.push(...(result.items || []));
      if (page >= (result.total_pages || 1)) return items;
      if (page >= 100) throw new ServiceUnavailableException('产品目录过大，请在原工作台管理后重试。');
    }
  }
  async options(): Promise<TaskOptions> {
    const [products, model, runner] = await Promise.all([this.taskProducts(), this.taskModels(), this.taskRunner()]);
    return { ...runner, products: products.items, ...model };
  }
  async taskProducts() {
    const products = await this.catalogue('/api/v2/products', '产品目录');
    return { items: products.map(p => ({ id: p.id, name: p.name, status: p.status })) };
  }
  async taskModels(): Promise<TaskModels> {
    if (this.modelSource === 'local') return this.localModels();
    const model = await this.read('/api/v1/settings/model', { timeoutMs: 5000, label: '模型配置' });
    if (!Array.isArray(model.model?.options) || !model.model.options.length) throw new ServiceUnavailableException('原平台未返回可用的模型选项，请重试模型配置。');
    return { models: model.model.options, selectedModel: model.model.selected_model || 'default' };
  }
  async taskRunner() {
    const health = await this.read('/api/v1/runtime/health', { timeoutMs: 5000, label: '执行器状态' });
    if (typeof health.runner?.enabled !== 'boolean') throw new ServiceUnavailableException('原平台未返回有效的执行器状态，请重新检查。');
    return { runnerEnabled: health.runner.enabled };
  }
  private target(row: Row): TaskTarget {
    const scopes = row.source_scopes || [];
    const reason = row.availability === 'unavailable' ? '源码不可用，请在原工作台检查路径' : scopes.length !== 1 ? '当前 Runner 仅支持单个源码目录' : scopes.some((s: Row) => s.include_patterns?.length || s.exclude_patterns?.length) ? '当前 Runner 不支持范围过滤规则' : '';
    return { id: row.id, name: row.name, path: scopes.map((s: Row) => s.path).join('；'), runnable: !reason, reason };
  }
  async targets(productId: string) {
    identifier(productId, '产品'); return { items: (await this.catalogue(`/api/v2/products/${encodeURIComponent(productId)}/targets`, '源码目录')).map(row => this.target(row)) };
  }
  async registerTarget(productId: string, input: Row) {
    identifier(productId, '产品');
    const name = textField(input.name, '源码名称', 160, true).trim();
    const path = textField(input.path, '源码目录', 4096, true).trim();
    return this.target(await this.write(`/api/v2/products/${encodeURIComponent(productId)}/targets`, { name, source_scopes: [{ name: 'source', path }] }));
  }
  async create(input: Row, key: string) {
    const requestKey = idempotencyKey(key); const { productId, body } = createTaskInput(input);
    const data = await this.write(`/api/v2/products/${encodeURIComponent(productId)}/audits`, body, requestKey);
    return { ...normalizeAudit(data.audit || data), productId };
  }
  async retryDraft(id: string): Promise<RealAuditDraft> {
    this.validId(id);
    const result = await this.read(`/api/v1/audits/${encodeURIComponent(id)}?live=1`);
    const audit = result.audit || result;
    if (!normalizeAudit(audit).canRetry) throw new BadRequestException('当前任务状态不支持新建重试。');
    const productId = identifier(audit.provenance?.audit_product_id || audit.provenance?.product_id || audit.product_id, '任务所属产品');
    const targetId = identifier(audit.provenance?.target_id || audit.repository_id, '源码对象');
    const privateDraft = audit.status === 'artifact_only' ? {} : await this.write(`/api/v2/products/${encodeURIComponent(productId)}/audits/${encodeURIComponent(id)}/retry-draft`, {});
    const runtime = audit.runtime_testing;
    return { productId, targetId, name: `${String(audit.name || id).replace(/（重试）$/u, '').slice(0, 156)}（重试）`,
      model: audit.model || 'default', memoryMode: privateDraft.memory_mode || audit.memory_mode || 'full', bacAnalysis: audit.bac_analysis?.mode || 'auto',
      miningStrategy: privateDraft.mining_strategy || audit.mining_strategy || (privateDraft.api_inventory?.trim() ? 'api' : 'focus_area'), apiInventory: privateDraft.api_inventory || '',
      additionalInstructionsEnabled: privateDraft.additional_instructions_enabled === true, additionalInstructions: privateDraft.additional_instructions || '',
      testEnvironmentEnabled: privateDraft.test_environment_enabled === true, testEnvironmentContext: privateDraft.test_environment_context || '',
      runtimeTesting: { mode: runtime?.mode || 'CONTACT_ONLY', budgetMinutes: runtime?.budget_minutes || 60, identityMode: runtime?.identity_mode || 'auto', testInput: runtime?.allowed_actions?.includes('test_input') === true, testMutation: runtime?.allowed_actions?.includes('test_mutation') === true },
    };
  }
  async action(id: string, input: Row, key: string) {
    identifier(id, '任务编号'); const requestKey = idempotencyKey(key);
    if (!['pause', 'resume', 'recover', 'cancel', 'dispatch'].includes(input.action) || !Number.isSafeInteger(input.version) || input.version < 1) throw new BadRequestException('任务操作或版本无效。');
    const current = await this.read(`/api/v1/audits/${encodeURIComponent(id)}?live=1`);
    const productId = (current.audit || current).provenance?.audit_product_id || (current.audit || current).provenance?.product_id || (current.audit || current).product_id;
    if (productId) identifier(productId, '任务所属产品');
    const path = productId ? `/api/v2/products/${encodeURIComponent(productId)}/audits/${encodeURIComponent(id)}/actions` : `/api/v1/audits/${encodeURIComponent(id)}/actions`;
    const data = await this.write(path, { action: input.action }, requestKey, input.version);
    return { ...normalizeAudit({ ...(current.audit || current), ...(data.audit || data) }), productId };
  }
  async snapshot(): Promise<Snapshot> {
    const [workspace, products, running] = await Promise.all([this.read('/api/v1/workspace?audits=compact&live=1'), this.catalogue('/api/v2/products', '产品目录', 'all'), this.read('/api/v1/audits?tab=running&live=1')]);
    return { source: 'live', generatedAt: workspace.generated_at || new Date().toISOString(), audits: (workspace.audits || []).map(normalizeAudit),
      summary: { audits: workspace.summary?.audit_count || 0, running: running.count || 0, findings: workspace.summary?.finding_count || 0, reports: workspace.summary?.report_count ?? workspace.reports?.length ?? 0, validations: workspace.summary?.validation_run_count ?? 0, targets: products.reduce((sum, product) => sum + (Number(product.target_count) || 0), 0), severity: workspace.summary?.severity || {} },
      products: products.map((p: Row) => ({ id: p.id, name: p.name || p.id, description: p.description || (p.status === 'archived' ? '已归档产品' : '产品空间'), repositories: [], targetCount: Number(p.target_count) || 0, audits: 0, findings: 0 })),
      reports: (workspace.reports || []).map(normalizeReport) };
  }
  async findings(auditId?: string, query: Record<string, string> = {}): Promise<FindingPage> {
    if (auditId) this.validId(auditId);
    const page = Number(query.page || 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new BadRequestException('发现页码无效。');
    if (query.severity && !['critical', 'high', 'medium', 'low', 'info', 'unknown'].includes(query.severity)) throw new BadRequestException('风险级别无效。');
    const params = new URLSearchParams({ page: String(page), live: '1', ...(auditId ? { audit_id: auditId } : {}), ...(query.severity ? { severity: query.severity.toUpperCase() } : {}), ...(query.q ? { q: textField(query.q, '搜索内容', 500) } : {}) });
    const findings = await this.read(`/api/v1/findings?${params}`, { timeoutMs: 8000, label: '漏洞列表' });
    const rows = findings.items || findings.findings;
    if (!Array.isArray(rows)) throw new ServiceUnavailableException('漏洞接口未返回有效列表，请重试。');
    return { findings: rows.map((f: Row) => ({ id: f.resource_id || f.id, title: f.title || f.name || '未命名发现', severity: String(f.severity || 'unknown').toLowerCase(), status: f.workflow?.status || f.status || '待复核', repository: f.repository_name || f.repository_id, auditId: f.audit_id, path: f.location?.path ? `${f.location.path}${f.location.line ? `:${f.location.line}` : ''}` : f.file || '', description: f.description || f.summary || '未提供判断摘要。', remediation: f.remediation || '', evidence: (f.evidence || []).map((e: Row) => ({ kind: e.kind || '证据', text: e.text || '' })) })), count: findings.count ?? rows.length, page: findings.page || page, pageSize: findings.page_size || rows.length || 50, totalPages: findings.total_pages || 1 };
  }
  async report(id: string): Promise<ReportContent> {
    identifier(id, '报告编号');
    const report = await this.read(`/api/v1/reports/${encodeURIComponent(id)}?live=1`, { timeoutMs: 20000, label: '报告正文' });
    if (typeof report.body !== 'string') throw new ServiceUnavailableException('报告接口未返回正文。');
    return { ...normalizeReport(report), body: report.body, html: typeof report.rendered_html === 'string' ? report.rendered_html : '', presentation: report.presentation };
  }
  async downloadReport(id: string) {
    identifier(id, '报告编号');
    const result = await this.request(`/api/v1/reports/${encodeURIComponent(id)}/download?format=original&live=1`, {}, { timeoutMs: 20000, label: '报告下载', format: 'bytes' });
    const name = result.disposition?.match(/filename="([A-Za-z0-9._-]+\.md)"/)?.[1] || `report-${id}.md`;
    return { bytes: result.bytes as Buffer, filename: name };
  }
  async list(query: Record<string, string>): Promise<AuditPage> {
    const params = new URLSearchParams({ live: '1', tab: query.status === 'running' ? 'running' : query.status === 'completed' ? 'completed' : 'all', page_size: '20', page: query.page || '1', q: query.q || '' });
    const data = await this.read(`/api/v1/audits?${params}`);
    return { items: (data.items || []).map(normalizeAudit), count: data.count || 0, page: data.page || 1, pageSize: data.page_size || 20, totalPages: data.total_pages || 1 };
  }
  async get(id: string) {
    this.validId(id); const data = await this.read(`/api/v1/audits/${encodeURIComponent(id)}?live=1`);
    const audit = normalizeAudit(data.audit || data);
    const logs = await this.read(`/api/v1/audits/${encodeURIComponent(id)}/logs?limit=80`).catch(() => { audit.logsError = '日志读取失败，任务状态仍正常更新。请稍后刷新。'; return null; });
    audit.logs = (logs?.items || []).map((l: Row, i: number) => ({ sequence: l.sequence || i + 1, time: l.occurred_at || l.timestamp || l.created_at || '', level: l.level || (l.status === 'error' ? 'warning' : 'info'), agent: l.agent || l.label || l.tool || l.kind || l.type || 'runner', message: l.body || l.message || l.text || l.summary || '收到运行事件。' }));
    return audit;
  }
  stream(id: string, lastEventId: string) {
    this.validId(id);
    return new Observable<{ id?: string; data: unknown }>(subscriber => {
      const abort = new AbortController();
      const connectTimeout = setTimeout(() => { subscriber.error(new ServiceUnavailableException('实时连接超时，页面将继续定时刷新。')); abort.abort(); }, 15000);
      void (async () => {
        try {
          const response = await this.transport(`${this.origin}/api/v1/audits/${encodeURIComponent(id)}/events`, { signal: abort.signal, redirect: 'error', headers: lastEventId ? { 'Last-Event-ID': lastEventId } : {} });
          clearTimeout(connectTimeout);
          if (!response.ok || !response.body) throw new Error('SSE unavailable');
          const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
          try {
            while (!abort.signal.aborted) {
              const { value, done } = await reader.read(); if (done) break;
              buffer += decoder.decode(value, { stream: true }); buffer = buffer.replaceAll('\r\n', '\n');
              let end;
              while ((end = buffer.indexOf('\n\n')) !== -1) {
                const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
                if (block.split('\n').some(line => line.startsWith('data:'))) subscriber.next({ id: block.split('\n').find(line => line.startsWith('id:'))?.slice(3).trim(), data: { type: 'audit-updated', auditId: id } });
              }
              if (buffer.length > 1_048_576) throw new Error('SSE frame too large');
            }
          } finally { reader.releaseLock(); }
          subscriber.complete();
        } catch { if (!abort.signal.aborted) subscriber.error(new ServiceUnavailableException('实时连接已断开。')); }
        finally { clearTimeout(connectTimeout); }
      })();
      return () => { clearTimeout(connectTimeout); abort.abort(); };
    });
  }
  private validId(id: string) { if (!/^[a-zA-Z0-9._-]{1,180}$/.test(id)) throw new BadRequestException('任务 ID 无效。'); }
}
