import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { useEffect, useState } from 'react';
import { Plus, Search, SlidersHorizontal, ChevronLeft, ChevronRight, X, ScanLine } from 'lucide-react';
import { Button } from '../components/ui/button';
import { PageHeading, AuditTable, Loading, ErrorState } from '../components/common';
import { useWorkspace } from '../lib/workspace';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
export default function PreviewAudits() {
  const { source, setCreateOpen } = useWorkspace(); const [params, setParams] = useSearchParams(); const [search, setSearch] = useState(params.get('q') || '');
  const status = params.get('status') || 'all'; const page = params.get('page') || '1';
  useEffect(() => { setSearch(params.get('q') || ''); }, [params.get('q')]);
  const update = (key: string, value: string) => { const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); if (key !== 'page') next.delete('page'); setParams(next); };
  const queryParams = new URLSearchParams({ status, page, q: params.get('q') || '' });
  const query = useQuery({ queryKey: ['audits', source, queryParams.toString()], queryFn: ({ signal }) => api.audits(source, queryParams, signal), refetchInterval: source === 'live' ? 10000 : false, retry: 1 });
  return <div className="page-enter"><PageHeading eyebrow="AUDIT OPERATIONS" title="审计任务" description="追踪任务进度、专业协作与证据交付，随时回到审计现场。" action={<Button onClick={() => setCreateOpen(true)}><Plus size={16} />新建审计</Button>} />
    <section className="panel"><div className="list-toolbar"><div className="filter-tabs" role="group" aria-label="任务状态">{[{ id: 'all', name: '全部任务' }, { id: 'running', name: '运行中' }, { id: 'completed', name: '非运行任务' }].map(t => <button key={t.id} aria-pressed={status === t.id} className={cn(status === t.id && 'selected')} onClick={() => update('status', t.id)}>{t.name}{t.id === 'all' && query.data && status === 'all' && <span>{query.data.count}</span>}</button>)}</div><form className="search-field" onSubmit={e => { e.preventDefault(); update('q', search.trim()); }}><Search size={16} /><input aria-label="搜索审计任务" placeholder="搜索任务名称、仓库或 ID…" value={search} onChange={e => setSearch(e.target.value)} />{search && <button aria-label="清空搜索" type="button" onClick={() => { setSearch(''); update('q', ''); }}><X size={14} /></button>}<button className="search-submit" type="submit">搜索</button></form></div>
      {query.isPending ? <Loading /> : query.error ? <ErrorState error={query.error} retry={query.refetch} /> : <><AuditTable audits={query.data.items} /><div className="table-footer"><span>共 {query.data.count} 个任务<span className="footer-hint"> · {source === 'demo' ? '演示工作空间' : '真实工作空间'}</span></span><div><span>第 {query.data.page} / {query.data.totalPages} 页</span><Button variant="outline" size="icon" aria-label="上一页" disabled={query.data.page <= 1} onClick={() => update('page', String(query.data.page - 1))}><ChevronLeft size={15} /></Button><Button variant="outline" size="icon" aria-label="下一页" disabled={query.data.page >= query.data.totalPages} onClick={() => update('page', String(query.data.page + 1))}><ChevronRight size={15} /></Button></div></div></>}
    </section><div className="page-tip"><ScanLine size={15} /><span>点击任务名称查看执行阶段、实时日志与关联发现。{source === 'demo' && '演示任务可体验暂停和恢复。'}</span></div>
  </div>;
}
