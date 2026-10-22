import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ArrowRight, LoaderCircle, Plus, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { api, ApiError } from '../lib/api';
import { batchAuditName, prepareBatchAudits, resolveBatchTargets, submitBatchAudits, type BatchAuditItem } from '../lib/batch-audit';
import { useWorkspace } from '../lib/workspace';
import type { CodingEngine, RealAuditInput } from '../../shared/contracts';

const initializationPolicy = { retry: false, staleTime: 30000, refetchOnWindowFocus: false, refetchOnReconnect: false, networkMode: 'always' as const };
function InitializationError({ label, error, retry }: { label: string; error: Error; retry: () => void }) {
  return <div className="task-alert" role="alert"><p>{label}未就绪：{error.message}</p>{error instanceof ApiError && error.requestId && <small>请求编号：{error.requestId}</small>}<Button type="button" variant="outline" size="sm" onClick={retry}>重试{label}</Button></div>;
}
export function CreateRealAudit() {
  const { setCreateOpen, batchSelection, retryDraft } = useWorkspace();
  const navigate = useNavigate(); const client = useQueryClient();
  const [requestKey] = useState(() => crypto.randomUUID());
  const [draft, setDraft] = useState<RealAuditInput>(() => ({
    productId: batchSelection?.productId || '', targetId: '', auditId: `audit-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    auditMode: retryDraft?.auditMode ?? (retryDraft?.testEnvironmentEnabled ? 'joint' : 'static'), name: '', model: '', miningStrategy: 'focus_area', apiInventory: '', memoryMode: 'full', bacAnalysis: 'auto',
    additionalInstructionsEnabled: false, additionalInstructions: '', testEnvironmentEnabled: false, testEnvironmentContext: '',
    runtimeTesting: { mode: 'INTEGRATED_TESTING', budgetMinutes: 60, identityMode: 'auto', testInput: false, testMutation: false },
    ...retryDraft,
  }));
  const edit = <K extends keyof RealAuditInput>(key: K, value: RealAuditInput[K]) => setDraft(old => ({ ...old, [key]: value, ...(key === 'auditMode' && value === 'dynamic' && old.runtimeTesting?.mode === 'TARGETED_CONFIRMATION' ? { runtimeTesting: { ...old.runtimeTesting, mode: 'INTEGRATED_TESTING' as const } } : {}) }));
  const [addingTarget, setAddingTarget] = useState(false);
  const [targetName, setTargetName] = useState(''); const [targetPath, setTargetPath] = useState('');
  const batchMode = batchSelection !== null;
  const dynamicOnly = draft.auditMode === 'dynamic';
  const reportValidation = !!draft.sourceReport;
  const findingValidation = !!draft.sourceReport?.finding_ids;
  const [batchItems, setBatchItems] = useState<BatchAuditItem[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const submittingBatch = useRef(false);
  const products = useQuery({ ...initializationPolicy, queryKey: ['task-products'], queryFn: ({ signal }) => api.taskProducts(signal) });
  const agents = useQuery({ ...initializationPolicy, staleTime: 0, queryKey: ['task-agents'], queryFn: ({ signal }) => api.taskAgents(signal) });
  const enabledProfiles = agents.data?.profiles.filter(item => item.enabled !== false) ?? [];
  const engine = draft.engine || agents.data?.default_engine || 'opencode';
  const profile = enabledProfiles.find(item => item.id === engine);
  const models = useQuery({ ...initializationPolicy, queryKey: ['task-models', engine], queryFn: ({ signal }) => api.taskModels(signal, engine), enabled: agents.isSuccess && !!profile });
  const runner = useQuery({ ...initializationPolicy, queryKey: ['task-runner'], queryFn: ({ signal }) => api.taskRunner(signal) });
  const productId = draft.productId || products.data?.items[0]?.id || '';
  const targets = useQuery({ ...initializationPolicy, queryKey: ['task-targets', productId], queryFn: ({ signal }) => api.targets(productId, signal), enabled: !!productId && !dynamicOnly, staleTime: batchMode ? 0 : initializationPolicy.staleTime, refetchOnMount: batchMode ? 'always' : true });
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
  const batchTargets = resolveBatchTargets(batchSelection?.targetIds || [], targets.data?.items || []);
  const batchReady = batchTargets.length > 0 && batchTargets.every(target => target.runnable) && !targets.isFetching && products.data?.items.some(product => product.id === productId && product.status === 'active');
  const busy = creation.isPending || registration.isPending || batchBusy;
  const ready = agents.isSuccess && profile?.available === true && products.isSuccess && models.isSuccess && modelAvailable && runner.isSuccess && runner.data.runnerEnabled && (dynamicOnly ? draft.testEnvironmentEnabled && !!draft.testEnvironmentContext.trim() : targets.isSuccess && (batchMode ? batchReady : selectedTarget?.runnable));
  const batchStarted = batchItems.length > 0;
  const batchCreated = batchItems.filter(item => item.status === 'created').length;
  const initialLoading = products.isPending || agents.isPending || models.isFetching || runner.isPending || (!dynamicOnly && !!productId && targets.isPending);
  const close = () => { if (!busy) setCreateOpen(false); };
  const submitBatch = async () => {
    if (submittingBatch.current) return;
    submittingBatch.current = true; setBatchBusy(true);
    const items = batchStarted ? batchItems : prepareBatchAudits({ ...draft, productId, engine, model }, batchTargets);
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
    creation.mutate({ ...draft, productId, targetId: dynamicOnly ? '' : targetId, engine, model });
  };
  return <Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent className="create-dialog real-create-dialog" onInteractOutside={event => { if (busy) event.preventDefault(); }} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
    <DialogHeader><div className="dialog-symbol"><ShieldCheck size={22} /></div><DialogTitle>{findingValidation ? '单漏洞动态验证' : reportValidation ? '基于最终报告动态验证' : batchMode ? '批量创建审计任务' : retryDraft ? '新建重试任务' : '创建真实审计任务'}</DialogTitle><DialogDescription>{findingValidation ? `仅验证所选 ${draft.sourceReport!.finding_ids!.length} 项：${draft.sourceFindingTitle || draft.sourceReport!.finding_ids!.join('、')}。结果独立保存。` : reportValidation ? `已冻结报告中的 ${draft.sourceFindingCount ?? '全部'} 项漏洞与未确定候选。仅做必要登录后逐项验证，结果另行封存。` : batchMode ? '已带入列表中勾选的项目。填写一份配置，为每个项目分别创建审计任务。' : retryDraft ? '已回填原任务配置。确认后将使用新的任务编号运行，原任务与报告保留。' : '选择审计模式和所属产品，配置源码或授权测试环境后提交执行。'}</DialogDescription></DialogHeader>
    <form className="create-form real-create-form" onSubmit={event => { event.preventDefault(); submit(); }}>
      {runner.isPending && <p className="initialization-status" role="status"><LoaderCircle size={14} className="animate-spin" />正在检查执行器，可先填写任务信息…</p>}
      {runner.error && <InitializationError label="执行器状态" error={runner.error} retry={() => void runner.refetch()} />}
      {runner.isSuccess && !runner.data.runnerEnabled && <div role="alert" className="task-alert">原平台尚未开启 Runner。请使用任务模式启动服务后重新检查。<Button type="button" variant="outline" onClick={() => void runner.refetch()}>重新检查</Button></div>}
      <fieldset disabled={busy || uncertain || batchStarted} className="task-form-fields">
        <label>审计模式<select disabled={reportValidation} value={draft.auditMode || 'static'} onChange={e => edit('auditMode', e.target.value as RealAuditInput['auditMode'])}><option value="static">静态审计</option>{!batchMode && <option value="dynamic">{reportValidation ? '基于最终报告验证' : '独立动态测试'}</option>}<option value="joint">静态＋动态联合审计</option></select></label>
        <p className="field-hint">{reportValidation ? '不重跑源码审计和自主探索；环境准备最多 2 分钟，每项验证最多 5 分钟，另受总预算限制。' : dynamicOnly ? '只需要授权测试环境；基于 Web 或 SSH 的实际操作建立基线、规划实验并复核结果。' : draft.auditMode === 'joint' ? '源码审计与动态探索并行，自动交接线索，汇合后统一复核。' : '分析源码并存档报告。'}</p>
        {!batchMode && <label>任务名称<input required maxLength={160} autoComplete="off" placeholder="例如：订单服务 · 访问控制审计" value={draft.name} onChange={e => edit('name', e.target.value)} /></label>}
        {batchMode && <p className="field-hint">任务名称自动使用“仓库名 · 日期”，下方配置应用于所有已选项目。</p>}
        <label>Agent 基座<select required value={agents.isSuccess && enabledProfiles.length ? engine : ''} disabled={!agents.isSuccess || !enabledProfiles.length} onChange={e => setDraft(old => ({ ...old, engine: e.target.value as CodingEngine, model: '' }))}>{!agents.isSuccess && <option value="">{agents.isPending ? '正在读取 Agent 基座…' : 'Agent 基座读取失败'}</option>}{agents.isSuccess && !enabledProfiles.length && <option value="">未启用任何 Agent</option>}{agents.isSuccess && enabledProfiles.length > 0 && !profile && <option value={engine} disabled>原任务基座未启用，请重新选择</option>}{enabledProfiles.map(item => <option key={item.id} value={item.id}>{item.label}{item.available ? '' : '（不可用）'}</option>)}</select></label>
        {agents.error && <InitializationError label="Agent 基座" error={agents.error} retry={() => void agents.refetch()} />}
        {agents.isSuccess && !enabledProfiles.length && <p className="task-alert" role="alert">请先在<Link to="/settings" onClick={close}>工作台设置</Link>中启用至少一个 Agent 基座。</p>}
        {profile && <p className={profile.available ? 'field-hint' : 'task-alert'} role={profile.available ? undefined : 'alert'}>{profile.available ? `${profile.label}${profile.version ? ` · ${profile.version}` : ''}；任务创建后固定此基座，排队及恢复沿用。` : profile.reason || '此基座尚未就绪，请在工作台设置中检查可执行程序。'}</p>}
        <div className="task-form-grid"><label>所属产品<select required value={productId} disabled={reportValidation || batchMode || products.isPending || !!products.error} onChange={e => { setDraft(old => ({ ...old, productId: e.target.value, targetId: '' })); setAddingTarget(false); registration.reset(); }}><option value="" disabled>{products.isPending ? '正在读取产品目录…' : '选择产品'}</option>{products.data?.items.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
          <label>执行模型<select value={profile && models.isSuccess ? model : ''} disabled={!profile || models.isPending || !!models.error} onChange={e => edit('model', e.target.value)}>{!profile ? <option value="">请先启用并选择 Agent 基座</option> : <>{!models.isSuccess && <option value="">{models.isPending ? '正在读取模型配置…' : '模型配置读取失败'}</option>}{models.isSuccess && !modelAvailable && <option value={model} disabled>{model}（配置中已不可用，请重新选择）</option>}{models.data?.models.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</>}</select></label></div>
        {products.error && <InitializationError label="产品目录" error={products.error} retry={() => void products.refetch()} />}
        {products.isSuccess && !products.data.items.length && <p className="task-alert">还没有可用产品，请先在原工作台创建产品。</p>}
        {profile && models.error && <InitializationError label="模型配置" error={models.error} retry={() => void models.refetch()} />}
        {!dynamicOnly && (batchMode ? <section className="batch-sources" aria-label="已选项目">
          <strong className="batch-source-heading">已选 {batchTargets.length} 个项目</strong>
          <div className="batch-source-list">
            {targets.isFetching ? <p className="field-hint">正在读取所选项目…</p> : batchTargets.map(target => <div className="batch-source" key={target.id}><strong>{target.name}</strong><code>{target.path}</code>{target.runnable ? <small>任务名：{batchAuditName(target.path)}</small> : <p className="task-error" role="alert">{target.reason}</p>}</div>)}
          </div>
          <p className="field-hint">如需调整项目，请关闭弹窗后在项目列表重新勾选。</p>
        </section> : <><label>源码对象<select required value={targetId} disabled={!productId || targets.isPending || !!targets.error} onChange={e => edit('targetId', e.target.value)}><option value="" disabled>{!productId ? '请先选择产品' : targets.isPending ? '正在读取源码目录…' : '选择源码对象'}</option>{targets.data?.items.map(t => <option key={t.id} value={t.id} disabled={!t.runnable}>{t.name}{t.runnable ? '' : `（${t.reason}）`}</option>)}</select></label>
        {selectedTarget && <p className="field-hint source-path">{selectedTarget.path}</p>}</>)}
        {!dynamicOnly && targets.error && <InitializationError label="源码目录" error={targets.error} retry={() => void targets.refetch()} />}
        {!dynamicOnly && !batchMode && <div className="target-tools"><Button type="button" size="sm" variant="outline" disabled={!productId || !!products.error} onClick={() => setAddingTarget(!addingTarget)}><Plus size={14} />登记本机源码目录</Button><a className="legacy-link" href="/products" target="_blank" rel="noreferrer">管理产品</a></div>}
        {!dynamicOnly && addingTarget && <section className="target-registration"><div className="task-form-grid"><label>源码名称<input maxLength={160} value={targetName} placeholder="order-service" onChange={e => setTargetName(e.target.value)} /></label><label>本机绝对路径<input maxLength={4096} value={targetPath} placeholder="/Users/…/order-service" onChange={e => setTargetPath(e.target.value)} /></label></div><p className="field-hint">目录须位于运行平台的这台电脑。登记成功后即可选择，不会立即启动审计。</p><Button type="button" size="sm" disabled={!targetName.trim() || !targetPath.trim()} onClick={() => registration.mutate()}>登记目录</Button>{registration.error && <p role="alert" className="task-error">{registration.error.message} 请先检查源码列表再重试登记。</p>}</section>}
        {!dynamicOnly && <><div className="task-form-grid"><label>审计策略<select value={draft.miningStrategy} onChange={e => edit('miningStrategy', e.target.value as 'focus_area' | 'api' | 'file_sweep')}><option value="focus_area">Focus Area（风险优先）</option><option value="api">逐接口 API 审查</option><option value="file_sweep">逐文件地毯式审计</option></select></label><label>历史记忆<select value={draft.memoryMode} onChange={e => edit('memoryMode', e.target.value)}><option value="full">完整记忆</option><option value="facts_only">仅代码事实</option><option value="off">关闭记忆</option><option value="blind">盲审</option></select></label></div>
        {draft.miningStrategy === 'focus_area' && <p className="field-hint">围绕源码疑点和安全边界定向审计，高风险优先；保留待核查的不确定区域，不代表逐文件覆盖。</p>}
        {draft.miningStrategy === 'api' && <label>API 清单<textarea required rows={5} maxLength={120000} placeholder="填写本次需要审查的接口、路由和相关说明" value={draft.apiInventory} onChange={e => edit('apiInventory', e.target.value)} /></label>}
        {draft.miningStrategy === 'file_sweep' && <p className="field-hint">威胁分析 Agent 逐个浏览范围内的文本文件，将疑似风险发布为 Focus Area，由专业 Agent 领取并深入审计。浏览进度与 Area 报告交付分别统计；文件已浏览不代表已完成深入审计。</p>}
        </>}<details className="task-options"><summary>审计专项与补充说明</summary><div className="task-option-body">{!dynamicOnly && <label>越权专项<select value={draft.bacAnalysis} onChange={e => edit('bacAnalysis', e.target.value)}><option value="auto">自动分析（推荐）</option><option value="off">关闭专项</option></select></label>}<label className="checkbox-field"><input type="checkbox" checked={draft.additionalInstructionsEnabled} onChange={e => edit('additionalInstructionsEnabled', e.target.checked)} />附加审计说明</label>{draft.additionalInstructionsEnabled && <label>补充说明<textarea required rows={4} maxLength={12000} value={draft.additionalInstructions} onChange={e => edit('additionalInstructions', e.target.value)} placeholder="关注的业务范围、排除项和交付要求" /></label>}</div></details>
        {draft.auditMode !== 'static' && <details open className="task-options"><summary>动态测试授权 <span>{draft.testEnvironmentEnabled && draft.testEnvironmentContext.trim() ? '已启用' : dynamicOnly ? '待授权' : '默认跳过'}</span></summary><div className="task-option-body"><label className="checkbox-field"><input type="checkbox" checked={draft.testEnvironmentEnabled} onChange={e => edit('testEnvironmentEnabled', e.target.checked)} />我授权在下方指定的测试环境执行所选操作</label><p className="field-hint">{dynamicOnly ? '请启用授权并填写测试环境后再创建动态验证任务。' : '未启用或未填写环境时，动态测试记为 SKIPPED。'}环境说明会作为私有上下文交给执行 Agent。</p>
          {draft.testEnvironmentEnabled && <><label>授权测试环境<textarea rows={5} maxLength={24000} autoComplete="off" spellCheck={false} placeholder="描述 Web 或 SSH 目标、测试账号及口令/私钥等登录方式、允许操作的服务或目录、范围及限制。可用自然语言完整填写。" value={draft.testEnvironmentContext} onChange={e => edit('testEnvironmentContext', e.target.value)} /></label>
            <div className="task-form-grid"><label>测试方式<select disabled={reportValidation} value={draft.runtimeTesting.mode} onChange={e => edit('runtimeTesting', { ...draft.runtimeTesting, mode: e.target.value })}><option value="CONTACT_ONLY">连通性与运行环境观察</option><option value="INTEGRATED_TESTING">综合测试</option>{(!dynamicOnly || reportValidation) && <option value="TARGETED_CONFIRMATION">{reportValidation ? '逐项验证报告候选' : '定向确认静态候选'}</option>}</select></label><label>时间预算（分钟）<input type="number" min={10} max={240} step={1} required value={draft.runtimeTesting.budgetMinutes} onChange={e => edit('runtimeTesting', { ...draft.runtimeTesting, budgetMinutes: Number(e.target.value) })} /></label></div>
            <label>测试身份<select value={draft.runtimeTesting.identityMode} onChange={e => edit('runtimeTesting', { ...draft.runtimeTesting, identityMode: e.target.value })}><option value="auto">按环境说明判断</option><option value="anonymous">匿名</option><option value="shared">单个授权测试身份</option><option value="distinct">独立授权测试身份</option></select></label>
            <label className="checkbox-field"><input type="checkbox" checked={draft.runtimeTesting.testInput} onChange={e => edit('runtimeTesting', { ...draft.runtimeTesting, testInput: e.target.checked })} />允许提交测试输入</label><label className="checkbox-field"><input type="checkbox" checked={draft.runtimeTesting.testMutation} onChange={e => edit('runtimeTesting', { ...draft.runtimeTesting, testMutation: e.target.checked })} disabled />允许修改授权测试数据（自主探索暂不开放）</label></>}
        </div></details>}
      </fieldset>
      {batchStarted && <section className="batch-results" aria-label="批量创建结果"><h3 role="status">已创建 {batchCreated}/{batchItems.length} 个任务{batchBusy ? ' · 正在提交…' : ''}</h3><p className="field-hint">已创建的任务由队列调度。重试只处理未确认或失败项，并沿用原任务编号。</p><ul>{batchItems.map(item => <li key={item.input.auditId} data-status={item.status}><div className="batch-result-heading"><strong>{item.input.name}</strong><span>{({ pending: '等待提交', submitting: '正在提交', created: '已创建', failed: '提交失败', uncertain: '结果待确认' })[item.status]}</span></div><code>{item.path}</code>{item.error && <p className="task-error">{item.error}</p>}{item.requestId && <small>请求编号：{item.requestId}</small>}{item.status === 'created' ? <Link target="_blank" rel="noreferrer" to={`/audits/${encodeURIComponent(item.audit!.id)}`}>查看任务</Link> : <small>任务编号：{item.input.auditId}</small>}</li>)}</ul></section>}
      {creation.error && <div className="task-alert" role="alert"><p>{creation.error.message}</p><small>任务编号：{draft.auditId}</small>{creation.error instanceof ApiError && creation.error.requestId && <small>请求编号：{creation.error.requestId}</small>}{uncertain && <Link to="/audits" onClick={close}>先查看任务列表</Link>}</div>}
      <div className="task-submit-note"><span>动态测试：{draft.auditMode !== 'static' && draft.testEnvironmentEnabled && draft.testEnvironmentContext.trim() ? '已授权指定环境' : dynamicOnly ? '待授权并填写环境 · 尚未启动' : 'SKIPPED · 仅静态审计'}</span><span>提交后可能先进入队列</span></div>
      {!ready && !busy && !batchStarted && <p className="field-hint" role="status">{initialLoading ? '选项正在分别加载，可先填写任务信息。超过等待时间会显示具体失败项。' : batchMode && !batchReady ? '请返回项目列表检查所选项目及其所属产品，确认可用后重新打开。' : '请完成上方未就绪项后提交；重试选项不会清空已填写的内容。'}</p>}
      <div className="dialog-footer"><Button type="button" variant="outline" disabled={busy} onClick={close}>{batchStarted ? '关闭' : batchMode ? '返回选择项目' : '取消'}</Button>{batchStarted && !batchBusy && <Button type="button" variant="outline" onClick={() => { close(); navigate('/audits'); }}>查看任务列表</Button>}{(!batchStarted || batchCreated < batchItems.length) && <Button type="submit" disabled={busy || (!batchStarted && !uncertain && !ready) || (!dynamicOnly && addingTarget)}>{creation.isPending || batchBusy ? <LoaderCircle size={16} className="animate-spin" /> : <ArrowRight size={16} />}{creation.isPending || batchBusy ? '正在提交…' : batchStarted ? '重试未完成项' : batchMode ? `批量创建 ${batchTargets.length} 个任务` : uncertain ? '确认原任务提交结果' : '创建并运行任务'}</Button>}</div>
    </form>
  </DialogContent></Dialog>;
}
