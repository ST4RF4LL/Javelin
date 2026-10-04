import { ArrowRight, RefreshCw, AlertCircle, SearchX, LoaderCircle, GitBranch, MoreHorizontal } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from './ui/button';
import { cn, relativeTime, statusLabels } from '../lib/utils';
import type { Audit } from '../../shared/contracts';
import type { ReactNode } from 'react';
import { RetryAuditButton } from './retry-audit';
export function StatusBadge({ status }: { status: string }) { return <span className={cn('status-badge', `status-${status}`)}><span className="status-dot" />{statusLabels[status] || status}</span>; }
export function ProgressBar({ progress, compact = false }: { progress: number; compact?: boolean }) { return <div className={cn('progress-cell', compact && 'compact')}><div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="审计进度"><div style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} /></div><span>{progress}%</span></div>; }
export function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) { return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>; }
export function Loading({ label = '正在读取工作区…' }: { label?: string }) { return <div className="loading-state" role="status"><LoaderCircle className="animate-spin" size={24} /><p>{label}</p></div>; }
export function ErrorState({ error, retry }: { error: Error; retry: () => void }) { return <div className="empty-state error-state" role="alert"><AlertCircle size={32} /><h3>暂时无法连接工作台</h3><p>{error.message}</p><Button variant="outline" onClick={retry}><RefreshCw size={14} />重新连接</Button></div>; }
export function EmptyState({ title = '暂时没有匹配的记录', description = '试试其他关键词或筛选条件。' }: { title?: string; description?: string }) { return <div className="empty-state"><SearchX size={28} /><h3>{title}</h3><p>{description}</p></div>; }
export function AuditTable({ audits }: { audits: Audit[] }) {
  if (!audits.length) return <EmptyState />;
  return <div className="table-scroll"><table className="audit-table"><thead><tr><th>任务名称 / 审计对象</th><th>状态</th><th>审计进度</th><th>发现</th><th>最近更新</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{audits.map(a => <tr key={a.id}><td><Link className="audit-name" to={`/audits/${encodeURIComponent(a.id)}`}>{a.name}</Link><div className="repo-meta"><GitBranch size={12} />{a.repository}<span>·</span><code>{a.commit.slice(0, 7)}</code></div></td><td><StatusBadge status={a.status} /></td><td><ProgressBar progress={a.progress} /><span className="stage-caption">{a.status === 'completed' ? '审计已完成' : a.stage}</span></td><td><span className={cn('finding-count', a.findings > 0 && 'has-findings')}>{a.findings.toString().padStart(2, '0')}</span></td><td className="muted nowrap">{relativeTime(a.updatedAt)}</td><td><RetryAuditButton audit={a} /><Link to={`/audits/${encodeURIComponent(a.id)}`} className="row-action" aria-label={`查看 ${a.name}`}><ArrowRight size={16} /></Link></td></tr>)}</tbody></table></div>;
}
