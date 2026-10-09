import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, ChevronLeft, ChevronRight, File, Files, RefreshCw, Search } from 'lucide-react';
import { Button } from '../components/ui/button';
import { EmptyState, ErrorState, Loading, PageHeading } from '../components/common';
import { useWorkspace } from '../lib/workspace';

type SourceOptions = { products: { id: string; name: string }[]; audits: { id: string; name: string; product_id: string }[] };
type FocusArea = { task_id: string; title: string; domain: string; status: string; locations: { line: number | null; symbol: string | null }[] };
type Coverage = {
  audit_id: string; available: boolean; reason?: string; association_available: boolean; inventory_complete: boolean;
  publication: string | null; scope_digest: string;
  summary: { total_files: number; associated_files: number; unassociated_files: number; association_percentage: number;
    focus_areas: number; unmatched_references: number; unlocated_focus_areas: number; exclusions: number; inventory_errors: number };
  items: { file_id: string; path: string; type: string; association: string; focus_areas: FocusArea[] }[];
  unmatched_references: { task_id: string; title: string; path: string; reason: string }[];
  total: number; offset: number; limit: number; next_offset: number | null;
};

async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.message || data?.error || `读取失败（${response.status}），请重试。`);
  return data;
}

const statusLabels: Record<string, string> = { PENDING: '待执行', RUNNING: '执行中', REPORTED: '已交报告', GAP: '存在缺口', FAILED: '执行失败' };

export default function FileCoverage() {
  const { source } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const auditId = params.get('audit_id') || '';
  const productId = params.get('product_id') || '';
  const association = ['associated', 'unassociated'].includes(params.get('association') || '') ? params.get('association')! : 'all';
  const [search, setSearch] = useState(params.get('q') || '');
  const queryText = params.get('q') || '';
  useEffect(() => { setSearch(queryText); }, [queryText]);
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const options = useQuery({ queryKey: ['file-coverage-options'], queryFn: ({ signal }) => read<SourceOptions>('/api/v1/provenance/options', signal), enabled: source === 'live', retry: 1 });
  const audit = useQuery({ queryKey: ['file-coverage-audit', auditId], enabled: source === 'live' && !!auditId, retry: 1,
    queryFn: ({ signal }) => read<{ id: string; name: string; managed?: boolean; status: string; provenance?: { audit_product_id?: string; audit_managed?: boolean } }>(`/api/v1/audits/${encodeURIComponent(auditId)}?live=1`, signal),
  });
  const owner = audit.data?.provenance?.audit_product_id;
  const managed = audit.data && audit.data.managed !== false && audit.data.provenance?.audit_managed !== false && audit.data.status !== 'artifact_only';
  const endpoint = owner ? `/api/v2/products/${encodeURIComponent(owner)}/audits/${encodeURIComponent(auditId)}` : `/api/v1/audits/${encodeURIComponent(auditId)}`;
  const coverage = useQuery({ queryKey: ['file-coverage', auditId, owner, offset, queryText, association], enabled: source === 'live' && !!managed,
    queryFn: ({ signal }) => read<Coverage>(`${endpoint}/file-coverage?${new URLSearchParams({ offset: String(offset), limit: '100', q: queryText, association })}`, signal),
    retry: 1, refetchInterval: 10000,
  });
  const data = coverage.data;
  function update(values: Record<string, string>) {
    const next = new URLSearchParams(params);
    next.delete('offset');
    for (const [key, value] of Object.entries(values)) if (value) next.set(key, value); else next.delete(key);
    setParams(next);
  }
  const auditOptions = options.data?.audits.filter(item => !productId || item.product_id === productId) || [];
  return <div className="page-enter file-coverage-page">
    <PageHeading eyebrow="FOCUS AREA · FILE COVERAGE" title="文件覆盖率" description="查看 Focus Area 在项目文件中的分布，定位尚未关联的文件。" action={<Button variant="outline" onClick={() => { void options.refetch(); if (auditId) void audit.refetch(); if (managed) void coverage.refetch(); }}><RefreshCw size={15} className={coverage.isFetching ? 'animate-spin' : ''} />刷新</Button>} />
    {source !== 'live' ? <EmptyState title="请选择真实数据" description="文件覆盖率使用真实审计的文件清单和 Focus Area 定位信息。" /> : <>
      <section className="panel coverage-scope">
        <label>产品<select aria-label="覆盖率产品" value={productId} onChange={event => update({ product_id: event.target.value, audit_id: '' })}><option value="">全部产品</option>{options.data?.products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
        <label>审计任务<select aria-label="覆盖率审计任务" value={auditId} onChange={event => update({ audit_id: event.target.value })}><option value="">选择审计任务</option>{auditId && !auditOptions.some(item => item.id === auditId) && <option value={auditId}>{audit.data?.name || auditId}</option>}{auditOptions.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}</select></label>
        {auditId && <Link className="coverage-audit-link" to={`/audits/${encodeURIComponent(auditId)}`}>查看任务<ArrowUpRight size={15} /></Link>}
      </section>
      {options.isPending && <p className="small-muted" role="status">正在读取审计任务…</p>}
      {options.error && <ErrorState error={options.error} retry={options.refetch} />}
      {!auditId ? <EmptyState title="选择一个审计任务" description="文件列表来自该任务启动时保存的源码范围，关联信息随 Focus Area 发布更新。" /> : audit.error ? <ErrorState error={audit.error} retry={audit.refetch} /> : audit.isPending ? <Loading /> : !managed ? <EmptyState title="历史制品未保存文件关联信息" description="请选择工作台创建的审计任务。" /> : coverage.isPending ? <Loading /> : !data ? <ErrorState error={coverage.error || new Error('文件关联信息暂不可用')} retry={coverage.refetch} /> : !data.available ? <EmptyState title="文件清单尚未就绪" description={data.reason} /> : <>
        <div className="coverage-note"><Files size={18} /><p>黄色表示关联了 Focus Area，灰色表示暂无关联。当前统计仅反映任务定位，<strong>不代表文件已审查或漏洞已确认。</strong></p></div>
        {coverage.error && <div className="task-alert" role="alert">刷新失败，当前显示上次结果。{coverage.error.message}</div>}
        {!data.association_available && <div className="task-alert">本次历史任务没有通用任务面板定位记录，暂时只展示文件清单。</div>}
        {!data.inventory_complete && <div className="task-alert">本次文件清单存在 {data.summary.inventory_errors} 个枚举错误，当前范围不完整。</div>}
        <div className="coverage-metrics">
          <section className="panel"><span>范围内文件</span><strong>{data.summary.total_files.toLocaleString()}</strong><small>本次审计保存的文件清单</small></section>
          <section className="panel associated"><span><i className="coverage-dot yellow" />已关联 Focus Area</span><strong>{data.association_available ? data.summary.associated_files.toLocaleString() : '—'}</strong><small>{data.summary.focus_areas} 个 Focus Area</small></section>
          <section className="panel"><span><i className="coverage-dot" />暂无关联</span><strong>{data.association_available ? data.summary.unassociated_files.toLocaleString() : '—'}</strong><small>未被 Focus Area 定位引用</small></section>
          <section className="panel"><span>Focus Area 文件关联率</span><strong>{data.association_available ? `${data.summary.association_percentage}%` : '—'}</strong><small>{data.publication === 'OPEN' ? '任务发布尚未封存' : '按文件去重统计'}</small></section>
        </div>
        <section className="panel coverage-files">
          <div className="list-toolbar"><div className="filter-tabs" role="group" aria-label="文件关联状态">{[['all', '全部文件'], ['associated', '已关联'], ['unassociated', '未关联']].map(([value, label]) => <button key={value} className={association === value ? 'selected' : ''} aria-pressed={association === value} onClick={() => update({ association: value === 'all' ? '' : value })}>{label}</button>)}</div>
            <form className="search-field" onSubmit={event => { event.preventDefault(); update({ q: search.trim() }); }}><Search size={16} /><input aria-label="搜索文件路径" placeholder="搜索文件路径…" value={search} onChange={event => setSearch(event.target.value)} /><button className="search-submit" type="submit">搜索</button></form></div>
          <div className="coverage-list-heading"><span>文件路径</span><span>Focus Area 关联</span></div>
          <div className="coverage-file-list">{data.items.length ? data.items.map(file => <details key={`${auditId}:${file.path}`} className={`coverage-file ${file.association}`}>
            <summary><span className="coverage-file-path"><File size={16} /><code>{file.path}</code>{file.type === 'symlink' && <small>符号链接</small>}</span><span className="coverage-file-state"><i className={`coverage-dot ${file.focus_areas.length ? 'yellow' : ''}`} />{file.focus_areas.length ? `${file.focus_areas.length} 个 Focus Area` : data.association_available ? '暂无关联' : '未采集关联'}</span></summary>
            <div className="coverage-file-details">{file.focus_areas.length ? file.focus_areas.map(area => <article key={area.task_id}><div><strong>{area.title}</strong><span>{statusLabels[area.status] || area.status}</span></div><p><code>{area.task_id}</code> · {area.domain}</p><ul>{area.locations.map((location, index) => <li key={index}>{location.line ? `第 ${location.line} 行` : '未指定行号'}{location.symbol ? ` · ${location.symbol}` : ''}</li>)}</ul></article>) : <p>当前没有 Focus Area 将此文件列为代码定位。</p>}</div>
          </details>) : <EmptyState title="没有符合条件的文件" description="请调整路径搜索或关联状态筛选。" />}</div>
          <div className="table-footer"><span>{data.total.toLocaleString()} 个符合条件的文件 · 每页 {data.limit} 个</span><div><span>第 {Math.floor(data.offset / data.limit) + 1} / {Math.max(1, Math.ceil(data.total / data.limit))} 页</span><Button variant="outline" size="icon" aria-label="上一页文件" disabled={!data.offset || coverage.isFetching} onClick={() => update({ offset: String(Math.max(0, data.offset - data.limit)) })}><ChevronLeft size={16} /></Button><Button variant="outline" size="icon" aria-label="下一页文件" disabled={data.next_offset == null || coverage.isFetching} onClick={() => update({ offset: String(data.next_offset) })}><ChevronRight size={16} /></Button></div></div>
        </section>
        {(data.summary.unmatched_references > 0 || data.summary.unlocated_focus_areas > 0) && <details className="panel coverage-unmatched"><summary>定位缺口：{data.summary.unmatched_references} 条未匹配引用 · {data.summary.unlocated_focus_areas} 个 Focus Area 未提供文件定位</summary><p>仅精确关联清单中的文件。以下引用未计入黄色文件。</p>{data.unmatched_references.map((ref, index) => <p key={index}><code>{ref.path}</code> · {ref.title}（{ref.task_id}）<br /><small>{ref.reason}</small></p>)}{data.summary.unmatched_references > data.unmatched_references.length && <p>显示前 {data.unmatched_references.length} 条未匹配引用。</p>}</details>}
        <p className="coverage-footnote">统计范围固定为任务启动时的源码清单，后续新增文件需在新审计中体现。范围排除记录 {data.summary.exclusions} 项。页面每 10 秒同步。</p>
      </>}
    </>}
  </div>;
}
