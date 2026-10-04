import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { FileCheck2, ArrowUpRight, Download, FileText, ShieldCheck } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../components/ui/dialog';
import { Button } from '../components/ui/button';
import { PageHeading, Loading, ErrorState, EmptyState } from '../components/common';
import { useSnapshot, useWorkspace } from '../lib/workspace';
import { api } from '../lib/api';
import { reportDocument } from '../lib/report-document';
import { dateText } from '../lib/utils';
import type { Report, Source } from '../../shared/contracts';

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function ReportReader({ report, source, close }: { report: Report; source: Source; close: () => void }) {
  const [raw, setRaw] = useState(false);
  const query = useQuery({ queryKey: ['report', source, report.id], queryFn: ({ signal }) => api.report(report.id, signal), enabled: source === 'live', retry: false, staleTime: 60000, refetchOnWindowFocus: false });
  const demoBody = `# ${report.name}\n\n> 演示报告：仅用于新版工作台预览，不代表真实审计结果。\n\n审计对象：${report.repository}\n\n任务编号：${report.auditId}\n\n此文件演示报告交付流程。`;
  const body = source === 'demo' ? demoBody : query.data?.body || '';
  const document = useMemo(() => reportDocument(query.data?.html || '', body), [query.data?.html, body]);
  const download = useMutation({ mutationFn: async () => {
    const blob = source === 'live' ? await api.reportDownload(report.id) : new Blob([demoBody], { type: 'text/markdown;charset=utf-8' });
    save(blob, `${report.id}.md`);
  } });
  return <>
    <DialogHeader><DialogTitle>{report.name}</DialogTitle><DialogDescription>{report.repository} · 封存于 {dateText(query.data?.date || report.date)}</DialogDescription></DialogHeader>
    {source === 'live' && query.isPending && <Loading label="正在读取报告正文…" />}
    {query.error && <ErrorState error={query.error} retry={query.refetch} />}
    {(source === 'demo' || query.data) && <>
      <div className="report-reader-toolbar"><span className="small-muted">{source === 'demo' ? '演示报告' : query.data?.presentation?.derived ? '阅读版 · 下载可获取封存原文' : '封存报告正文'}</span><Button variant="outline" size="sm" onClick={() => setRaw(!raw)}>{raw ? '阅读排版' : '查看 Markdown'}</Button></div>
      {raw ? <pre className="report-raw" tabIndex={0}>{body}</pre> : <iframe className="report-frame" title={`${report.name}正文`} sandbox="" referrerPolicy="no-referrer" srcDoc={document} />}
    </>}
    {download.error && <p className="report-download-error" role="alert">{download.error.message}</p>}
    <div className="dialog-footer">{report.auditId && <Button asChild variant="outline"><Link to={`/audits/${encodeURIComponent(report.auditId)}`} onClick={close}>关联任务</Link></Button>}<Button onClick={() => download.mutate()} disabled={download.isPending}><Download size={15} />{download.isPending ? '正在下载…' : source === 'demo' ? '下载演示报告' : '下载封存原文'}</Button></div>
  </>;
}
export default function PreviewReports() {
  const query = useSnapshot(); const { source } = useWorkspace(); const [selected, setSelected] = useState<Report | null>(null);
  return <div className="page-enter">
    <PageHeading eyebrow="REPORTS & DELIVERABLES" title="审计报告" description="查看完整审计报告，追溯证据与关联任务，下载封存原文。" />
    {query.data && <div className="report-banner"><div className="report-banner-icon"><FileCheck2 size={26} /></div><div><h2>每一份报告，都是一次完整的证据交付</h2><p>按任务追溯发现、复核与最终结论。</p></div><strong>{query.data.reports.length}<span>份报告</span></strong></div>}
    <section className="panel"><div className="panel-heading"><h2>报告记录</h2><span className="small-muted">{source === 'demo' ? '预览样例' : '已封存报告'}</span></div>
      {query.isPending && <Loading label="正在读取报告列表…" />}
      {query.error && <ErrorState error={query.error} retry={query.refetch} />}
      {query.data && (query.data.reports.length ? query.data.reports.map(r => <div className="report-row" key={r.id}><span className="report-file"><FileText size={23} /></span><div><button className="audit-name" onClick={() => setSelected(r)}>{r.name}</button><div className="repo-meta">{r.repository}<span>·</span>{dateText(r.date)}</div></div><span className="report-status"><ShieldCheck size={14} />{r.status}</span><Button variant="outline" onClick={() => setSelected(r)}>查看报告<ArrowUpRight size={14} /></Button></div>) : <EmptyState title="暂时没有报告" description="审计完成后，报告记录会显示在这里。" />)}
    </section>
    <Dialog open={!!selected} onOpenChange={open => { if (!open) setSelected(null); }}><DialogContent className="report-dialog">{selected && <ReportReader key={`${source}-${selected.id}`} report={selected} source={source} close={() => setSelected(null)} />}</DialogContent></Dialog>
  </div>;
}
