import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Sparkles, ArrowRight, LoaderCircle, Target, ListChecks, FlaskConical } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { Button } from './ui/button';
import { useSnapshot, useWorkspace } from '../lib/workspace';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { CreateRealAudit } from './create-real-audit';
export function CreateAudit() {
  const { source, createOpen, setCreateOpen, runtime } = useWorkspace(); const snapshot = useSnapshot();
  const [name, setName] = useState(''); const [repository, setRepository] = useState('payment-service'); const [strategy, setStrategy] = useState('focus');
  const navigate = useNavigate(); const client = useQueryClient();
  const mutation = useMutation({ mutationFn: () => api.create(source, { name, repository, strategy }), onSuccess: audit => { void client.invalidateQueries(); setCreateOpen(false); setName(''); toast.success('演示任务已创建'); navigate(`/audits/${audit.id}`); }, onError: e => toast.error(e.message) });
  if (source === 'live' && !runtime.liveReadOnly) return createOpen ? <CreateRealAudit /> : null;
  if (source === 'live') return <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="create-dialog"><DialogHeader><DialogTitle>当前入口只读</DialogTitle><DialogDescription>请使用 start:platform 启动任务模式后创建审计。</DialogDescription></DialogHeader><div className="dialog-footer"><Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button>{runtime.legacyUrl && <Button asChild><a href={runtime.legacyUrl}>原界面保留入口<ArrowRight size={16} /></a></Button>}</div></DialogContent></Dialog>;
  return <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="create-dialog"><DialogHeader><div className="dialog-symbol"><Sparkles size={22} /></div><DialogTitle>创建一次安全审计</DialogTitle><DialogDescription>选择审计对象与策略，让专业 Agent 协同检查代码风险。</DialogDescription></DialogHeader>
    <div className="demo-note"><FlaskConical size={16} /><span>{source === 'demo' ? '当前为演示预览。创建任务只模拟执行，不会启动真实 Agent。' : '真实数据模式暂为只读，请在原工作台创建审计。'}</span></div>
    <form onSubmit={e => { e.preventDefault(); mutation.mutate(); }} className="create-form"><label>任务名称<input autoComplete="off" required maxLength={120} placeholder="例如：支付服务 · 权限专项审计" value={name} onChange={e => setName(e.target.value)} /></label><label>审计对象<select value={repository} onChange={e => setRepository(e.target.value)}>{snapshot.data?.products.flatMap(p => p.repositories).map(r => <option key={r} value={r}>{r}</option>)}</select></label>
      <fieldset><legend>审计策略</legend><div className="strategy-options">{[{ id: 'focus', icon: Target, name: '高风险 Focus Area', caption: '从威胁建模定位关键风险' }, { id: 'api', icon: ListChecks, name: '逐接口 API 审查', caption: '按接口检查访问与数据边界' }].map(s => <label key={s.id} className={cn('strategy-option', strategy === s.id && 'selected')}><input type="radio" name="strategy" value={s.id} checked={strategy === s.id} onChange={() => setStrategy(s.id)} /><s.icon size={19} /><strong>{s.name}</strong><span>{s.caption}</span></label>)}</div></fieldset>
      <div className="dialog-footer"><Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>取消</Button><Button disabled={source !== 'demo' || mutation.isPending}>{mutation.isPending ? <LoaderCircle className="animate-spin" size={16} /> : <ArrowRight size={16} />}创建演示任务</Button></div>
    </form></DialogContent></Dialog>;
}
