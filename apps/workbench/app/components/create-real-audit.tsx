import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ArrowRight, LoaderCircle, Plus, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { api, ApiError } from '../lib/api';
import { batchAuditName, parseRepositoryPaths, prepareBatchAudits, registerBatchRepositories, submitBatchAudits, uniqueRepositories, type BatchAuditItem } from '../lib/batch-audit';
import { useWorkspace } from '../lib/workspace';
import type { RealAuditInput } from '../../shared/contracts';

const initializationPolicy = { retry: false, staleTime: 30000, refetchOnWindowFocus: false, refetchOnReconnect: false, networkMode: 'always' as const };
function InitializationError({ label, error, retry }: { label: string; error: Error; retry: () => void }) {
  return <div className="task-alert" role="alert"><p>{label}未就绪：{error.message}</p>{error instanceof ApiError && error.requestId && <small>请求编号：{error.requestId}</small>}<Button type="button" variant="outline" size="sm" onClick={retry}>重试{label}</Button></div>;
}
export function CreateRealAudit() {
  const { setCreateOpen, batchCreate, retryDraft } = useWorkspace();
  const navigate = useNavigate(); const client = useQueryClient();
  const [requestKey] = useState(() => crypto.randomUUID());
  const [draft, setDraft] = useState<RealAuditInput>(() => ({
    productId: '', targetId: '', auditId: `audit-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    name: '', model: '', miningStrategy: 'focus_area', apiInventory: '', memoryMode: 'full', bacAnalysis: 'auto',
    additionalInstructionsEnabled: false, additionalInstructions: '', testEnvironmentEnabled: false, testEnvironmentContext: '',
    runtimeTesting: { mode: 'CONTACT_ONLY', budgetMinutes: 60, identityMode: 'auto', testInput: false, testMutation: false },
    ...retryDraft,
  }));
  const edit = <K extends keyof RealAuditInput>(key: K, value: RealAuditInput[K]) => setDraft(old => ({ ...old, [key]: value }));
  const [addingTarget, setAddingTarget] = useState(false);
  const [targetName, setTargetName] = useState(''); const [targetPath, setTargetPath] = useState('');
  const [batchMode, setBatchMode] = useState(batchCreate);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [directoryText, setDirectoryText] = useState('');
  const [batchItems, setBatchItems] = useState<BatchAuditItem[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const submittingBatch = useRef(false);
  const products = useQuery({ ...initializationPolicy, queryKey: ['task-products'], queryFn: ({ signal }) => api.taskProducts(signal) });
  const models = useQuery({ ...initializationPolicy, queryKey: ['task-models'], queryFn: ({ signal }) => api.taskModels(signal) });
  const runner = useQuery({ ...initializationPolicy, queryKey: ['task-runner'], queryFn: ({ signal }) => api.taskRunner(signal) });
  const productId = draft.productId || products.data?.items[0]?.id || '';
  const targets = useQuery({ ...initializationPolicy, queryKey: ['task-targets', productId], queryFn: ({ signal }) => api.targets(productId, signal), enabled: !!productId });
  const targetId = draft.targetId || targets.data?.items.find(t => t.runnable)?.id || '';
  const selectedTarget = targets.data?.items.find(t => t.id === targetId);
  const preferredModel = models.data?.selectedModel || 'default';
  const model = draft.model || preferredModel;
  const modelAvailable = models.data?.models.some(m => m.value === model) === true;
  const attempted = useRef<RealAuditInput | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const creation = useMutation({
    mutationFn: (input: RealAuditInput) => { attempted.current = input; return api.createReal(input, requestKey); }, retry: false,
    onSuccess: audit => {
      client.setQueryData(['audit', 'live', audit.id], audit);
      void client.invalidateQueries({ queryKey: ['audits', 'live'] }); void client.invalidateQueries({ queryKey: ['snapshot', 'live'] });
      setCreateOpen(false); toast.success(audit.status === 'queued' ? '任务已创建，正在等待调度' : '真实任务已提交'); navigate(`/audits/${encodeURIComponent(audit.id)}`);
    },
    onError: error => { setUncertain(!(error instanceof ApiError) || error.status === 0 || error.status >= 500); },
  });
  const registration = useMutation({
    mutationFn: () => api.registerTarget(productId, { name: targetName, path: targetPath }), retry: false,
    onSuccess: target => { edit('targetId', target.id); setAddingTarget(false); setTargetName(''); setTargetPath(''); toast.success('源码对象已登记'); },
    onSettled: () => { void client.invalidateQueries({ queryKey: ['task-targets', productId] }); },
  });
  const batchRegistration = useMutation({
    mutationFn: async () => {
      const paths = parseRepositoryPaths(directoryText);
      const latest = await api.targets(productId);
      return registerBatchRepositories(paths, latest.items, input => api.registerTarget(productId, input));
    },
    retry: false,
    onSuccess: result => {
      client.setQueryData(['task-targets', productId], { items: result.targets });
      setSelectedIds(old => [...new Set([...old, ...result.selectedIds])]);
      setDirectoryText(result.failures.map(failure => failure.path).join('\n'));
    },
  });
  const batchTargets = uniqueRepositories((targets.data?.items || []).filter(target => selectedIds.includes(target.id)));
  const busy = creation.isPending || registration.isPending || batchRegistration.isPending || batchBusy;
  const ready = products.isSuccess && models.isSuccess && modelAvailable && runner.isSuccess && runner.data.runnerEnabled && targets.isSuccess && (batchMode ? batchTargets.length > 0 && !directoryText.trim() : selectedTarget?.runnable);
  const batchStarted = batchItems.length > 0;
  const batchCreated = batchItems.filter(item => item.status === 'created').length;
  const initialLoading = products.isPending || models.isPending || runner.isPending || (!!productId && targets.isPending);
  const close = () => { if (!busy) setCreateOpen(false); };
  const submitBatch = async () => {
    if (submittingBatch.current) return;
    submittingBatch.current = true; setBatchBusy(true);
    const items = batchStarted ? batchItems : prepareBatchAudits({ ...draft, productId, model }, batchTargets);
    setBatchItems(items);
    try {
      const result = await submitBatchAudits(items, async (input, key) => {
        const audit = await api.createReal(input, key);
        client.setQueryData(['audit', 'live', audit.id], audit);
        void client.invalidateQueries({ queryKey: ['audits', 'live'] });
        return audit;
      }, setBatchItems);
      const created = result.filter(item => item.status === 'created').length;
      if (created === result.length) toast.success(`已创建 ${created} 个审计任务`);
      else toast.warning(`已创建 ${created}/${result.length} 个任务，其余项可重试`);
    } finally {
      submittingBatch.current = false; setBatchBusy(false);
      void client.invalidateQueries({ queryKey: ['snapshot', 'live'] });
      window.dispatchEvent(new Event('workbench:refresh'));
    }
  };
  const submit = () => {
    if (busy) return;
    if (batchMode) { if (ready || batchStarted) void submitBatch(); return; }
    if (uncertain && attempted.current) { creation.mutate(attempted.current); return; }
    if (!ready) return;
    creation.mutate({ ...draft, productId, targetId, model });
  };
  return <Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent className="create-dialog real-create-dialog" onInteractOutside={event => { if (busy) event.preventDefault(); }} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
    <DialogHeader><div className="dialog-symbol"><ShieldCheck size={22} /></div><DialogTitle>{retryDraft ? '新建重试任务' : '创建真实审计任务'}</DialogTitle><DialogDescription>{retryDraft ? '已回填原任务配置。确认后将使用新的任务编号运行，原任务与报告保留。' : '选择产品和本机源码目录，提交后由当前平台的执行队列调度。'}</DialogDescription></DialogHeader>
    <form className="create-form real-create-form" onSubmit={event => { event.preventDefault(); submit(); }}>
      {runner.isPending && <p className="initialization-status" role="status"><LoaderCircle size={14} className="animate-spin" />正在检查执行器，可先填写任务信息…</p>}
      {runner.error && <InitializationError label="执行器状态" error={runner.error} retry={() => void runner.refetch()} />}
      {runner.isSuccess && !runner.data.runnerEnabled && <div role="alert" className="task-alert">原平台尚未开启 Runner。请使用任务模式启动服务后重新检查。<Button type="button" variant="outline" onClick={() => void runner.refetch()}>重新检查</Button></div>}
      <fieldset disabled={busy || uncertain || batchStarted} className="task-form-fields">
        {!retryDraft && <div className="batch-mode-switch" role="group" aria-label="创建方式"><Button type="button" variant={batchMode ? 'outline' : 'default'} aria-pressed={!batchMode} onClick={() => { setBatchMode(false); batchRegistration.reset(); }}>单个仓库</Button><Button type="button" variant={batchMode ? 'default' : 'outline'} aria-pressed={batchMode} onClick={() => { setBatchMode(true); setAddingTarget(false); registration.reset(); creation.reset(); }}>多个仓库批量创建</Button></div>}
        {!batchMode && <label>任务名称<input required maxLength={160} autoComplete="off" placeholder="例如：订单服务 · 访问控制审计" value={draft.name} onChange={e => edit('name', e.target.value)} /></label>}
        {batchMode && <p className="field-hint">每个目录创建一个独立任务，名称自动使用“仓库名 · 日期”。下方配置应用于本批次所有任务。</p>}
        <div className="task-form-grid"><label>所属产品<select required value={productId} disabled={products.isPending || !!products.error} onChange={e => { setDraft(old => ({ ...old, productId: e.target.value, targetId: '' })); setSelectedIds([]); setAddingTarget(false); registration.reset(); batchRegistration.reset(); }}><option value="" disabled>{products.isPending ? '正在读取产品目录…' : '选择产品'}</option>{products.data?.items.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
          <label>执行模型<select value={models.isSuccess ? model : ''} disabled={models.isPending || !!models.error} onChange={e => edit('model', e.target.value)}>{!models.isSuccess && <option value="">{models.isPending ? '正在读取模型配置…' : '模型配置读取失败'}</option>}{models.isSuccess && !modelAvailable && <option value={model} disabled>{model}（配置中已不可用，请重新选择）</option>}{models.data?.models.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label></div>
        {products.error && <InitializationError label="产品目录" error={products.error} retry={() => void products.refetch()} />}
        {products.isSuccess && !products.data.items.length && <p className="task-alert">还没有可用产品，请先在原工作台创建产品。</p>}
        {models.error && <InitializationError label="模型配置" error={models.error} retry={() => void models.refetch()} />}
        {batchMode ? <section className="batch-sources" aria-label="批量源码目录">
          <div className="batch-source-heading"><strong>选择源码目录 · 已选 {batchTargets.length} 个</strong><div><Button type="button" variant="outline" size="sm" disabled={!targets.isSuccess} onClick={() => setSelectedIds(uniqueRepositories(targets.data?.items || []).map(target => target.id))}>全选可用目录</Button><Button type="button" variant="ghost" size="sm" onClick={() => setSelectedIds([])}>清空选择</Button></div></div>
          <div className="batch-source-list">
            {targets.isPending && <p className="field-hint">{productId ? '正在读取源码目录…' : '请先选择产品'}</p>}
            {targets.isSuccess && !targets.data.items.length && <p className="field-hint">还没有源码对象，在下方粘贴目录即可批量添加。</p>}
            {targets.data?.items.map(target => <label className="checkbox-field batch-source" key={target.id}><input type="checkbox" checked={selectedIds.includes(target.id)} disabled={!target.runnable} onChange={event => setSelectedIds(old => event.target.checked ? [...old, target.id] : old.filter(id => id !== target.id))} /><span><strong>{target.name}</strong><code>{target.path}</code><small>{target.runnable ? `任务名：${batchAuditName(target.path)}` : target.reason}</small></span></label>)}
          </div>
          <label>添加更多本机源码目录<textarea rows={4} autoComplete="off" spellCheck={false} placeholder={'每行一个绝对路径，例如：\nD:\\repos\\order-service\nD:\\repos\\payment-service\n或 /Users/me/repos/order-service'} value={directoryText} onChange={event => { setDirectoryText(event.target.value); batchRegistration.reset(); }} /></label>
          <p className="field-hint">目录须位于运行平台的电脑。添加时检查目录并自动勾选，已有目录会复用；此时尚未启动任务。</p>
          <Button type="button" size="sm" variant="outline" disabled={!productId || !directoryText.trim() || !targets.isSuccess} onClick={() => batchRegistration.mutate()}>{batchRegistration.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />}{batchRegistration.isPending ? '正在添加目录…' : '添加到批量列表'}</Button>
          {batchRegistration.error && <p role="alert" className="task-error">{batchRegistration.error.message}</p>}
          {!!batchRegistration.data?.failures.length && <div role="alert" className="task-alert"><p>以下目录未添加，请修正后重试，或移除这些行后提交已选目录。</p>{batchRegistration.data.failures.map(failure => <p className="source-path" key={failure.path}>{failure.path}：{failure.message}</p>)}</div>}
        </section> : <><label>源码对象<select required value={targetId} disabled={!productId || targets.isPending || !!targets.error} onChange={e => edit('targetId', e.target.value)}><option value="" disabled>{!productId ? '请先选择产品' : targets.isPending ? '正在读取源码目录…' : '选择源码对象'}</option>{targets.data?.items.map(t => <option key={t.id} value={t.id} disabled={!t.runnable}>{t.name}{t.runnable ? '' : `（${t.reason}）`}</option>)}</select></label>
        {selectedTarget && <p className="field-hint source-path">{selectedTarget.path}</p>}</>}
        {targets.error && <InitializationError label="源码目录" error={targets.error} retry={() => void targets.refetch()} />}
        <div className="target-tools">{!batchMode && <Button type="button" size="sm" variant="outline" disabled={!productId || !!products.error} onClick={() => setAddingTarget(!addingTarget)}><Plus size={14} />登记本机源码目录</Button>}<a className="legacy-link" href="/products" target="_blank" rel="noreferrer">管理产品</a></div>
        {addingTarget && <section className="target-registration"><div className="task-form-grid"><label>源码名称<input maxLength={160} value={targetName} placeholder="order-service" onChange={e => setTargetName(e.target.value)} /></label><label>本机绝对路径<input maxLength={4096} value={targetPath} placeholder="/Users/…/order-service" onChange={e => setTargetPath(e.target.value)} /></label></div><p className="field-hint">目录须位于运行平台的这台电脑。登记成功后即可选择，不会立即启动审计。</p><Button type="button" size="sm" disabled={!targetName.trim() || !targetPath.trim()} onClick={() => registration.mutate()}>登记目录</Button>{registration.error && <p role="alert" className="task-error">{registration.error.message} 请先检查源码列表再重试登记。</p>}</section>}
        <div className="task-form-grid"><label>审计策略<select value={draft.miningStrategy} onChange={e => edit('miningStrategy', e.target.value as 'focus_area' | 'api')}><option value="focus_area">高风险 Focus Area</option><option value="api">逐接口 API 审查</option></select></label><label>历史记忆<select value={draft.memoryMode} onChange={e => edit('memoryMode', e.target.value)}><option value="full">完整记忆</option><option value="facts_only">仅代码事实</option><option value="off">关闭记忆</option><option value="blind">盲审</option></select></label></div>
        {draft.miningStrategy === 'api' && <label>API 清单<textarea required rows={5} maxLength={120000} placeholder="填写本次需要审查的接口、路由和相关说明" value={draft.apiInventory} onChange={e => edit('apiInventory', e.target.value)} /></label>}
        <details className="task-options"><summary>审计专项与补充说明</summary><div className="task-option-body"><label>越权专项<select value={draft.bacAnalysis} onChange={e => edit('bacAnalysis', e.target.value)}><option value="auto">自动分析（推荐）</option><option value="off">关闭专项</option></select></label><label className="checkbox-field"><input type="checkbox" checked={draft.additionalInstructionsEnabled} onChange={e => edit('additionalInstructionsEnabled', e.target.checked)} />附加审计说明</label>{draft.additionalInstructionsEnabled && <label>补充说明<textarea required rows={4} maxLength={12000} value={draft.additionalInstructions} onChange={e => edit('additionalInstructions', e.target.value)} placeholder="关注的业务范围、排除项和交付要求" /></label>}</div></details>
        <details className="task-options"><summary>动态测试授权 <span>{draft.testEnvironmentEnabled && draft.testEnvironmentContext.trim() ? '已启用' : '默认跳过'}</span></summary><div className="task-option-body"><label className="checkbox-field"><input type="checkbox" checked={draft.testEnvironmentEnabled} onChange={e => edit('testEnvironmentEnabled', e.target.checked)} />我授权在下方指定的测试环境执行所选操作</label><p className="field-hint">未启用或未填写环境时，动态测试记为 SKIPPED。环境说明会作为私有上下文交给执行 Agent。</p>
          {draft.testEnvironmentEnabled && <><label>授权测试环境<textarea rows={5} maxLength={24000} autoComplete="off" spellCheck={false} placeholder="描述授权目标地址、测试账号或登录方式、允许范围及限制。可用自然语言完整填写。" value={draft.testEnvironmentContext} onChange={e => edit('testEnvironmentContext', e.target.value)} /></label>
            <div className="task-form-grid"><label>测试方式<select value={draft.runtimeTesting.mode} onChange={e => edit('runtimeTesting', { ...draft.runtimeTesting, mode: e.target.value })}><option value="CONTACT_ONLY">连通性与页面观察</option><option value="INTEGRATED_TESTING">综合测试</option><option value="TARGETED_CONFIRMATION">定向确认</option></select></label><label>时间预算（分钟）<input type="number" min={10} max={240} step={1} required value={draft.runtimeTesting.budgetMinutes} onChange={e => edit('runtimeTesting', { ...draft.runtimeTesting, budgetMinutes: Number(e.target.value) })} /></label></div>
            <label>测试身份<select value={draft.runtimeTesting.identityMode} onChange={e => edit('runtimeTesting', { ...draft.runtimeTesting, identityMode: e.target.value })}><option value="auto">按环境说明判断</option><option value="anonymous">匿名</option><option value="shared">单个授权测试身份</option><option value="distinct">独立授权测试身份</option></select></label>
            <label className="checkbox-field"><input type="checkbox" checked={draft.runtimeTesting.testInput} onChange={e => edit('runtimeTesting', { ...draft.runtimeTesting, testInput: e.target.checked })} />允许提交测试输入</label><label className="checkbox-field"><input type="checkbox" checked={draft.runtimeTesting.testMutation} onChange={e => edit('runtimeTesting', { ...draft.runtimeTesting, testMutation: e.target.checked })} />允许修改授权测试数据</label></>}
        </div></details>
      </fieldset>
      {batchStarted && <section className="batch-results" aria-label="批量创建结果"><h3 role="status">已创建 {batchCreated}/{batchItems.length} 个任务{batchBusy ? ' · 正在提交…' : ''}</h3><p className="field-hint">已创建的任务由队列调度。重试只处理未确认或失败项，并沿用原任务编号。</p><ul>{batchItems.map(item => <li key={item.input.auditId} data-status={item.status}><div className="batch-result-heading"><strong>{item.input.name}</strong><span>{({ pending: '等待提交', submitting: '正在提交', created: '已创建', failed: '提交失败', uncertain: '结果待确认' })[item.status]}</span></div><code>{item.path}</code>{item.error && <p className="task-error">{item.error}</p>}{item.requestId && <small>请求编号：{item.requestId}</small>}{item.status === 'created' ? <Link target="_blank" rel="noreferrer" to={`/audits/${encodeURIComponent(item.audit!.id)}`}>查看任务</Link> : <small>任务编号：{item.input.auditId}</small>}</li>)}</ul></section>}
      {creation.error && <div className="task-alert" role="alert"><p>{creation.error.message}</p><small>任务编号：{draft.auditId}</small>{creation.error instanceof ApiError && creation.error.requestId && <small>请求编号：{creation.error.requestId}</small>}{uncertain && <Link to="/audits" onClick={close}>先查看任务列表</Link>}</div>}
      <div className="task-submit-note"><span>动态测试：{draft.testEnvironmentEnabled && draft.testEnvironmentContext.trim() ? '已授权指定环境' : 'SKIPPED · 仅静态审计'}</span><span>提交后可能先进入队列</span></div>
      {!ready && !busy && !batchStarted && <p className="field-hint" role="status">{initialLoading ? '选项正在分别加载，可先填写任务信息。超过等待时间会显示具体失败项。' : batchMode && directoryText.trim() ? '请先将填写的目录添加到批量列表。' : batchMode && !batchTargets.length ? '请至少选择一个可用的源码目录。' : '请完成上方未就绪项后提交；重试选项不会清空已填写的内容。'}</p>}
      <div className="dialog-footer"><Button type="button" variant="outline" disabled={busy} onClick={close}>{batchStarted ? '关闭' : '取消'}</Button>{batchStarted && !batchBusy && <Button type="button" variant="outline" onClick={() => { close(); navigate('/audits'); }}>查看任务列表</Button>}{(!batchStarted || batchCreated < batchItems.length) && <Button type="submit" disabled={busy || (!batchStarted && !uncertain && !ready) || addingTarget}>{creation.isPending || batchBusy ? <LoaderCircle size={16} className="animate-spin" /> : <ArrowRight size={16} />}{creation.isPending || batchBusy ? '正在提交…' : batchStarted ? '重试未完成项' : batchMode ? `批量创建 ${batchTargets.length} 个任务` : uncertain ? '确认原任务提交结果' : '创建并运行任务'}</Button>}</div>
    </form>
  </DialogContent></Dialog>;
}
