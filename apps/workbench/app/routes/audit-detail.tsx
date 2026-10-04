import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pause, Play, Copy, GitBranch, Cpu, Target, Check, Terminal, Download, ShieldCheck, CircleDot, FileSearch, ArrowUpRight, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { StatusBadge, ErrorState, Loading, ProgressBar, EmptyState } from '../components/common';
import { useWorkspace, useFindings } from '../lib/workspace';
import { api, ApiError } from '../lib/api';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../components/ui/dialog';
import { cn, severityLabels, findingStatusLabels } from '../lib/utils';
import type { AuditAction, LogEntry } from '../../shared/contracts';
import { RetryAuditButton } from '../components/retry-audit';
function Logs({ logs, connection }: { logs: LogEntry[]; connection: string }) {
  const [follow, setFollow] = useState(true); const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => { if (follow && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }, [logs, follow]);
  function download() { const blob = new Blob([logs.map(l => `${l.time} [${l.agent}] ${l.message}`).join('\n')], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'audit-log.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  return <section className="terminal-panel"><div className="terminal-header"><div><Terminal size={16} /><strong>执行日志</strong><span className="terminal-live"><i className={connection === '已连接' ? 'connected' : ''} />{connection}</span></div><div><label><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />自动滚动</label><button aria-label="下载日志" onClick={download}><Download size={15} /></button></div></div><div className="terminal-body" ref={viewport} aria-label="运行日志">{logs.length ? logs.map(l => <div className="log-row" key={l.sequence}><time>{l.time && Number.isFinite(Date.parse(l.time)) ? new Date(l.time).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}</time><span className={`log-level ${l.level}`}>{l.level === 'success' ? 'DONE' : l.level === 'warning' ? 'WARN' : 'INFO'}</span><span className="log-agent">{l.agent}</span><p>{l.message}</p></div>) : <p className="log-empty">此任务暂无可显示的运行日志。</p>}<div className="terminal-cursor"><span>❯</span><i /></div></div><div className="terminal-footer"><span>有序事件流 · {logs.length} 条记录</span><span>只读日志</span></div></section>;
}
export default function PreviewAuditDetail() {
  const { id = '' } = useParams(); const { source, runtime } = useWorkspace(); const client = useQueryClient(); const findingQuery = useFindings(id);
  const [connection, setConnection] = useState('连接中');
  const [cancelOpen, setCancelOpen] = useState(false);
  const actionKeys = useRef(new Map<string, string>());
  const query = useQuery({ queryKey: ['audit', source, id], queryFn: ({ signal }) => api.audit(source, id, signal), retry: 1, refetchInterval: source === 'live' ? 4000 : false });
  useEffect(() => {
    setConnection('连接中');
    if (!query.isSuccess) return;
    const stream = new EventSource(`/api/workbench/audits/${encodeURIComponent(id)}/events?source=${source}`);
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    stream.onopen = () => setConnection('已连接'); stream.onerror = () => setConnection('重连中 · 定时刷新继续');
    stream.onmessage = event => { try { if (JSON.parse(event.data).type === 'heartbeat') return; } catch { return; }
      if (refreshTimer) return; refreshTimer = setTimeout(() => { refreshTimer = undefined; void client.invalidateQueries({ queryKey: ['audit', source, id] }); }, 1000);
    };
    return () => { stream.close(); clearTimeout(refreshTimer); };
  }, [source, id, query.isSuccess, client]);
  const labels: Record<AuditAction, string> = { pause: '暂停任务', resume: '恢复任务', recover: '断点恢复', dispatch: '立即调度', cancel: '取消任务' };
  const mutation = useMutation({
    mutationFn: (action: AuditAction) => {
      const version = query.data!.version; const token = `${id}:${version}:${action}`;
      if (!actionKeys.current.has(token)) actionKeys.current.set(token, crypto.randomUUID());
      return api.action(source, id, action, version, actionKeys.current.get(token)!);
    }, retry: false,
    onSuccess: data => {
      client.setQueryData(['audit', source, id], { ...data, logs: query.data?.logs || [] });
      void client.invalidateQueries({ queryKey: ['audit', source, id] }); void client.invalidateQueries({ queryKey: ['snapshot', source] }); void client.invalidateQueries({ queryKey: ['audits', source] });
      setCancelOpen(false); toast.success(source === 'live' ? '操作已提交，正在同步执行状态' : data.status === 'paused' ? '演示任务已暂停' : '演示任务已恢复');
    }, onError: error => { toast.error(error.message); void query.refetch(); },
  });
  if (query.isPending) return <Loading />; if (!query.data) return <ErrorState error={query.error || new Error('任务不可用')} retry={query.refetch} />;
  const audit = query.data; const findings = findingQuery.data?.findings || [];
  return <div className="page-enter"><Link className="back-link" to="/audits"><ArrowLeft size={15} />返回审计任务</Link><div className="detail-heading"><div><div className="eyebrow">AUDIT / {audit.id}</div><h1>{audit.name}</h1><div className="detail-subtitle"><StatusBadge status={audit.status} /><span>{audit.product}</span><button className="text-icon" aria-label="复制任务 ID" onClick={() => { void navigator.clipboard.writeText(id).then(() => toast.success('任务 ID 已复制'), () => toast.error('浏览器未允许复制，请手动复制任务 ID。')); }}><Copy size={13} /></button></div></div><div className="detail-actions"><RetryAuditButton audit={audit} />{(source === 'live' ? runtime.liveReadOnly ? [] : audit.allowedActions || [] : audit.status === 'running' ? ['pause' as const] : audit.status === 'paused' ? ['resume' as const] : []).map(action => <Button key={action} variant={action === 'resume' || action === 'dispatch' ? 'default' : 'outline'} disabled={mutation.isPending} onClick={() => action === 'cancel' ? setCancelOpen(true) : mutation.mutate(action)}>{mutation.isPending && mutation.variables === action ? <LoaderCircle className="animate-spin" size={15} /> : action === 'pause' ? <Pause size={15} /> : <Play size={15} />}{labels[action]}</Button>)}</div></div>
    {mutation.error && <div className="task-alert" role="alert"><p>{mutation.error.message}</p>{mutation.error instanceof ApiError && mutation.error.requestId && <small>请求编号：{mutation.error.requestId}</small>}</div>}
    {query.error && <div className="task-alert" role="alert">暂时无法更新，当前显示上次读取的状态。{query.error.message}</div>}
    {audit.error && <div className="task-alert" role="alert">执行提示：{audit.error}</div>}
    {audit.logsError && <div className="task-alert" role="alert">{audit.logsError}</div>}
    <Dialog open={cancelOpen} onOpenChange={value => { if (!mutation.isPending) setCancelOpen(value); }}><DialogContent><DialogHeader><DialogTitle>取消此任务？</DialogTitle><DialogDescription>将停止此任务的执行，已产生的报告和运行记录会保留。满足原平台的恢复条件时可尝试断点恢复。</DialogDescription></DialogHeader><div className="dialog-footer"><Button variant="outline" disabled={mutation.isPending} onClick={() => setCancelOpen(false)}>继续运行</Button><Button disabled={mutation.isPending} onClick={() => mutation.mutate('cancel')}>{mutation.isPending ? '正在取消…' : '确认取消'}</Button></div></DialogContent></Dialog>
    <div className="detail-meta"><span><GitBranch size={15} />{audit.repository}<code>{audit.commit.slice(0, 7)}</code></span><span><Target size={15} />{audit.strategy}</span><span><Cpu size={15} />{audit.model}</span></div>
    {source === 'live' && <div className="runtime-meta"><span>任务版本：v{audit.version}</span><span>更新时间：{audit.updatedAt && Number.isFinite(Date.parse(audit.updatedAt)) ? new Date(audit.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '等待更新'}</span><span>动态测试：{audit.runtimeTestingStatus || '等待执行状态'}</span><span>页面每 4 秒同步</span></div>}
    <section className="panel pipeline-panel"><div className="panel-heading"><div className="inline-title"><h2>执行流水线</h2><span className="small-muted">每一步都有证据可循</span></div><strong className="pipeline-progress">{audit.progress}<small>%</small></strong></div><div className="pipeline">{audit.stages.length ? audit.stages.map((s, i) => <div key={s.id} className={`pipeline-step ${s.status}`}><div className="pipeline-node">{s.status === 'done' ? <Check size={17} /> : s.status === 'active' ? <CircleDot size={20} /> : <span>{String(i + 1).padStart(2, '0')}</span>}</div><strong>{s.label}</strong><small>{s.status === 'done' ? '已完成' : s.status === 'active' ? '正在执行' : '等待开始'}</small></div>) : <p className="muted">该任务没有可展示的阶段信息。</p>}</div></section>
    <Tabs defaultValue="overview" className="detail-tabs"><TabsList><TabsTrigger value="overview">执行概览</TabsTrigger><TabsTrigger value="logs">运行日志<span className="tab-count">{audit.logs.length}</span></TabsTrigger><TabsTrigger value="findings">关联发现<span className="tab-count">{findingQuery.isPending ? '…' : findingQuery.error ? '!' : findingQuery.data?.count ?? findings.length}</span></TabsTrigger></TabsList>
      <TabsContent value="overview"><div className="detail-grid"><Logs logs={audit.logs} connection={connection} /><aside className="detail-side"><section className="panel"><div className="panel-heading"><h2>任务交付</h2><FileSearch size={17} className="muted" /></div><div className="delivery-count"><strong>{audit.tasks.done}<span> / {audit.tasks.total}</span></strong><small>已交付任务</small></div><div className="delivery-progress"><ProgressBar progress={audit.tasks.total ? Math.round(audit.tasks.done / audit.tasks.total * 100) : 0} /></div><div className="delivery-stats"><div><span className="green-dot" />已交付<strong>{audit.tasks.done}</strong></div><div><span className="purple-dot" />尚未交付<strong>{Math.max(0, audit.tasks.total - audit.tasks.done - audit.tasks.gap)}</strong></div><div><span className="orange-dot" />已记录缺口<strong>{audit.tasks.gap}</strong></div></div></section><section className="evidence-note"><ShieldCheck size={22} /><h3>从候选到可信结论</h3><p>发现经过证据关联与独立复核后，才能进入最终报告。</p><Link to={`/findings?audit_id=${encodeURIComponent(audit.id)}`}>查看漏洞发现<ArrowUpRight size={14} /></Link></section></aside></div></TabsContent>
      <TabsContent value="logs"><Logs logs={audit.logs} connection={connection} /></TabsContent>
      <TabsContent value="findings"><section className="panel">{findingQuery.isPending ? <Loading /> : findingQuery.error ? <ErrorState error={findingQuery.error} retry={findingQuery.refetch} /> : findings.length ? findings.map(f => <div className="finding-detail-row" key={f.id}><span className={`severity severity-${f.severity}`}>{severityLabels[f.severity]}</span><div><h3>{f.title}</h3><code>{f.path}</code><p>{f.description}</p></div><span className="small-muted">{findingStatusLabels[f.status] || f.status}</span></div>) : <EmptyState title="暂时没有关联发现" description="收到专业任务报告后，候选与证据会显示在这里。" />}{!!findingQuery.data && findingQuery.data.count > findings.length && <div className="table-footer"><span>显示 {findings.length} / {findingQuery.data.count} 条</span><Link to={`/findings?audit_id=${encodeURIComponent(audit.id)}`}>查看全部关联发现</Link></div>}</section></TabsContent>
    </Tabs>{source === 'demo' && <div className="page-tip"><CircleDot size={14} /><span>此页面模拟审计执行。日志、进度和候选均为演示数据。</span></div>}
  </div>;
}
