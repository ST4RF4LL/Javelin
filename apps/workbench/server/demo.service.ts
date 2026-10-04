import { Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';
import type { Audit, AuditPage, Finding, Product, Report, Snapshot, Stage } from '../shared/contracts.js';

const stageNames = ['范围冻结', '资产侦察', '威胁建模', '专业审计', '证据关联', '独立复核', '报告封存'];
export function stages(progress: number): Stage[] {
  const current = progress === 100 ? 7 : Math.min(6, Math.floor(progress / 15));
  return stageNames.map((label, i) => ({ id: `stage-${i}`, label, status: i < current ? 'done' : i === current ? 'active' : 'pending' }));
}
const recent = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
function seedAudit(id: string, name: string, repository: string, product: string, status: Audit['status'], progress: number, findings: number, minutes: number): Audit {
  return {
    id, name, repository, product, status, progress, findings, branch: 'main', commit: `a8f3c${id.slice(-3)}`,
    updatedAt: recent(minutes), version: 1, strategy: '高风险 Focus Area', model: '默认审计模型', source: 'demo',
    stage: stageNames[Math.min(6, Math.floor(progress / 15))],
    tasks: { total: 24, done: Math.floor(progress * .24), gap: 0 }, stages: stages(progress),
    logs: [
      { sequence: 1, time: recent(14), level: 'info', agent: 'orchestrator', message: '已创建演示审计，冻结源码范围与任务策略。' },
      { sequence: 2, time: recent(12), level: 'success', agent: 'recon', message: '资产侦察完成：识别 38 个接口与 6 个关键业务模块。' },
      { sequence: 3, time: recent(9), level: 'success', agent: 'threat-modeler', message: '威胁建模完成，生成 24 项专业审计任务。' },
      { sequence: 4, time: recent(6), level: 'info', agent: 'java-worker', message: '正在追踪订单接口的身份绑定与数据库访问路径。' },
      { sequence: 5, time: recent(3), level: 'warning', agent: 'evidence', message: '收到一条待复核候选，已保存源码位置与控制流证据。' },
      { sequence: 6, time: recent(1), level: 'info', agent: 'monitor', message: '已合并专业任务回执，等待下一批证据。' },
    ],
  };
}

@Injectable()
export class DemoService {
  private audits: Audit[] = [
    seedAudit('demo-20261001-001', '支付核心服务 · 全面安全审计', 'payment-service', '交易与支付平台', 'running', 68, 6, 0),
    seedAudit('demo-20261001-002', '身份认证中心 · 权限边界审查', 'identity-service', '统一身份平台', 'running', 32, 2, 4),
    seedAudit('demo-20260930-003', '管理控制台 · API 专项审计', 'admin-console', '运营管理平台', 'completed', 100, 12, 76),
    seedAudit('demo-20260930-004', 'Agent 工具调用 · 安全边界审查', 'agent-gateway', '智能体平台', 'paused', 45, 3, 120),
    seedAudit('demo-20260929-005', '订单服务 · 增量安全审计', 'order-service', '交易与支付平台', 'completed', 100, 4, 1300),
    seedAudit('demo-20261001-006', '知识检索服务 · 数据访问审计', 'knowledge-api', '智能体平台', 'queued', 0, 0, 10),
  ];
  private findingRows: Finding[] = [
    { id: 'DEMO-F001', title: '订单查询接口缺少对象归属校验', severity: 'high', status: '待独立复核', repository: 'payment-service', auditId: 'demo-20261001-001', path: 'src/order/OrderController.java:128', description: '演示候选：查询路径已关联到数据库访问条件，需要进一步核对全局授权守卫与对象归属约束。此内容用于界面预览，不代表真实漏洞。' },
    { id: 'DEMO-F002', title: '管理端导出接口存在输入校验缺口', severity: 'medium', status: '已确认 · 演示', repository: 'admin-console', auditId: 'demo-20260930-003', path: 'src/api/export.ts:86', description: '演示记录：导出参数进入业务处理前缺少统一的类型与边界检查。此记录为预览样例。' },
    { id: 'DEMO-F003', title: 'Agent 工具执行缺少操作范围约束', severity: 'critical', status: '证据不足', repository: 'agent-gateway', auditId: 'demo-20260930-004', path: 'src/tools/dispatcher.ts:214', description: '演示候选：工具授权与执行范围需要联合检查；尚未形成完整证据链。此内容不代表实际风险结论。' },
    { id: 'DEMO-F004', title: '审计日志缺少敏感字段脱敏', severity: 'low', status: '待独立复核', repository: 'identity-service', auditId: 'demo-20261001-002', path: 'src/logging/AuditLogger.java:42', description: '演示候选：检查结构化日志中的敏感字段处理与日志访问边界。' },
  ];
  private lastTick = new Map<string, number>();
  private listeners = new Map<string, Set<() => void>>();
  get(id: string) { const audit = this.audits.find(item => item.id === id); if (!audit) throw new NotFoundException('没有找到该演示任务。'); return structuredClone(audit); }
  list(query: Record<string, string>): AuditPage {
    const pageSize = 20;
    const filtered = this.audits.filter(a => (!query.q || `${a.name} ${a.repository} ${a.id}`.toLowerCase().includes(query.q.toLowerCase())) &&
      (!query.status || query.status === 'all' || (query.status === 'completed' ? !['running', 'preparing', 'recovering', 'pausing', 'cancelling'].includes(a.status) : a.status === query.status)));
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.max(1, Math.min(totalPages, Number(query.page) || 1));
    return { items: structuredClone(filtered.slice((page - 1) * pageSize, page * pageSize)), count: filtered.length, page, pageSize, totalPages };
  }
  findings(auditId?: string, query: Record<string, string> = {}) {
    const rows = this.findingRows.filter(f => (!auditId || f.auditId === auditId) && (!query.severity || f.severity === query.severity) && (!query.q || `${f.title} ${f.repository}`.toLowerCase().includes(query.q.toLowerCase())));
    return { findings: rows, count: rows.length, page: 1, pageSize: 20, totalPages: 1 };
  }
  snapshot(): Snapshot {
    const products: Product[] = [
      { id: 'demo-payments', name: '交易与支付平台', description: '覆盖订单、支付与交易核心服务', repositories: ['payment-service', 'order-service'], audits: 2, findings: 10 },
      { id: 'demo-identity', name: '统一身份平台', description: '身份认证、会话与访问权限', repositories: ['identity-service'], audits: 1, findings: 2 },
      { id: 'demo-admin', name: '运营管理平台', description: '运营管理与内部业务控制台', repositories: ['admin-console'], audits: 1, findings: 12 },
      { id: 'demo-agent', name: '智能体平台', description: '工具调用、知识检索与执行边界', repositories: ['agent-gateway', 'knowledge-api'], audits: 2, findings: 3 },
    ];
    const reports: Report[] = this.audits.filter(a => a.status === 'completed').map(a => ({ id: `report-${a.id}`, name: a.name.replace(/审计|审查/, '报告'), auditId: a.id, repository: a.repository, date: a.updatedAt, status: '演示报告' }));
    return { source: 'demo', generatedAt: new Date().toISOString(), audits: structuredClone(this.audits), products, reports,
      summary: { audits: this.audits.length, running: this.audits.filter(a => a.status === 'running').length, findings: this.audits.reduce((n, a) => n + a.findings, 0), reports: reports.length } };
  }
  create(input: { name?: unknown; repository?: unknown; strategy?: unknown }): Audit {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw new BadRequestException('任务名称需要为 1–120 个字符。');
    const repositories = this.snapshot().products.flatMap(p => p.repositories);
    if (typeof input.repository !== 'string' || !repositories.includes(input.repository)) throw new BadRequestException('请选择演示项目。');
    const audit = seedAudit(`demo-${randomUUID().slice(0, 8)}`, input.name.trim(), input.repository, this.snapshot().products.find(p => p.repositories.includes(input.repository as string))!.name, 'running', 5, 0, 0);
    audit.logs = [{ sequence: 1, time: new Date().toISOString(), level: 'info', agent: 'orchestrator', message: '演示任务已创建。仅模拟状态变化，不执行真实审计。' }];
    audit.strategy = input.strategy === 'api' ? '逐接口 API 审查' : '高风险 Focus Area';
    this.audits.unshift(audit); return structuredClone(audit);
  }
  action(id: string, action: string, version: number) {
    const audit = this.audits.find(a => a.id === id); if (!audit) throw new NotFoundException();
    if (audit.version !== version) throw new ConflictException('任务状态已更新，请刷新后重试。');
    if (action === 'pause' && audit.status === 'running') audit.status = 'paused';
    else if (action === 'resume' && audit.status === 'paused') audit.status = 'running';
    else throw new ConflictException('当前任务不支持此操作。');
    this.update(audit, action === 'pause' ? '任务已暂停，保留当前证据与进度。' : '任务已恢复，继续处理未完成的审计任务。');
    return structuredClone(audit);
  }
  private update(audit: Audit, message: string) {
    audit.version++; audit.updatedAt = new Date().toISOString();
    audit.stages = stages(audit.progress); audit.tasks.done = Math.floor(audit.progress * .24);
    audit.logs.push({ sequence: (audit.logs.at(-1)?.sequence ?? 0) + 1, time: audit.updatedAt, level: 'info', agent: 'monitor', message });
    audit.logs = audit.logs.slice(-100);
    this.listeners.get(audit.id)?.forEach(fn => fn());
  }
  stream(id: string, after: number) {
    this.get(id);
    return new Observable<{ id: string; data: unknown }>(subscriber => {
      const emit = () => { const a = this.get(id); const sequence = a.logs.at(-1)?.sequence ?? 0; subscriber.next({ id: String(sequence), data: { type: 'audit-updated', auditId: id, sequence } }); };
      const set = this.listeners.get(id) ?? new Set(); set.add(emit); this.listeners.set(id, set);
      if ((this.get(id).logs.at(-1)?.sequence ?? 0) > after) emit();
      const timer = setInterval(() => {
        const audit = this.audits.find(a => a.id === id)!;
        if (audit.status === 'running' && Date.now() - (this.lastTick.get(id) ?? 0) >= 4500) {
          this.lastTick.set(id, Date.now()); audit.progress = Math.min(100, audit.progress + 1);
          audit.stage = stageNames[Math.min(6, Math.floor(audit.progress / 15))];
          if (audit.progress === 100) audit.status = 'completed';
          const messages = ['已接收专业任务回执，正在同步审计进度。', '正在核对源码引用与候选证据的一致性。', '专业 Worker 持续检查输入到敏感操作的访问路径。', '已更新任务面板，等待独立复核结果。'];
          this.update(audit, audit.status === 'completed' ? '演示审计已完成，报告已生成。' : messages[audit.progress % messages.length]);
        } else subscriber.next({ data: { type: 'heartbeat' }, id: String(this.get(id).logs.at(-1)?.sequence ?? 0) });
      }, 5000);
      return () => { clearInterval(timer); set.delete(emit); if (!set.size) this.listeners.delete(id); };
    });
  }
}
