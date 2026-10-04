import type { Audit, AuditPage, Snapshot, Source, WorkbenchRuntime, FindingPage, ReportContent, TaskOptions, TaskTarget, TaskProduct, TaskModels, RealAuditInput, RealAuditDraft } from '../../shared/contracts';
export class ApiError extends Error {
  status: number;
  requestId: string | null;
  constructor(message: string, status: number, requestId: string | null) { super(message); this.status = status; this.requestId = requestId; }
}
type RequestPolicy = { timeoutMs?: number; label?: string; format?: 'blob' };
export async function request<T>(path: string, source: Source, options: RequestInit = {}, policy: RequestPolicy = {}): Promise<T> {
  const controller = new AbortController(); const signal = options.signal;
  const relayAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) relayAbort(); else signal?.addEventListener('abort', relayAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), policy.timeoutMs ?? (options.method === 'POST' ? 70000 : 20000));
  let requestId: string | null = null;
  let rejectOnAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) rejectOnAbort(); else controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([aborted, (async () => {
      const response = await fetch(`/api/workbench/${path}${path.includes('?') ? '&' : '?'}source=${source}`, { ...options, signal: controller.signal, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
      requestId = response.headers.get('x-request-id');
      if (response.ok && policy.format === 'blob') return await response.blob() as T;
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new ApiError(typeof data?.message === 'string' ? data.message : `请求失败（${response.status}）`, response.status, requestId);
      if (data === null) throw new ApiError('工作台响应内容无法识别，请重试。', 502, requestId);
      return data;
    })()]);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof ApiError) throw error;
    const label = policy.label || '工作台';
    const message = options.method === 'POST' ? '未能确认操作结果，请先刷新任务状态，避免重复提交。' : `${label}${controller.signal.aborted ? '响应超时' : '连接失败'}，请重试。`;
    throw new ApiError(message, 0, requestId);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', relayAbort); controller.signal.removeEventListener('abort', rejectOnAbort);
  }
}
const initialization = (label: string) => ({ timeoutMs: 8000, label });
export const api = {
  runtime: () => request<WorkbenchRuntime>('config', 'live', {}, initialization('工作台配置')),
  findings: (source: Source, auditId?: string, signal?: AbortSignal, filters: Record<string, string> = {}) => request<FindingPage>(`findings?${new URLSearchParams({ ...filters, ...(auditId ? { audit_id: auditId } : {}) })}`, source, { signal }, { timeoutMs: 10000, label: '漏洞列表' }),
  report: (id: string, signal?: AbortSignal) => request<ReportContent>(`reports/${encodeURIComponent(id)}`, 'live', { signal }, { timeoutMs: 25000, label: '报告正文' }),
  reportDownload: (id: string) => request<Blob>(`reports/${encodeURIComponent(id)}/download`, 'live', {}, { timeoutMs: 25000, label: '报告下载', format: 'blob' }),
  snapshot: (source: Source, signal?: AbortSignal) => request<Snapshot>('snapshot', source, { signal }),
  audits: (source: Source, params: URLSearchParams, signal?: AbortSignal) => request<AuditPage>(`audits?${params}`, source, { signal }),
  audit: (source: Source, id: string, signal?: AbortSignal) => request<Audit>(`audits/${encodeURIComponent(id)}`, source, { signal }),
  create: (source: Source, input: { name: string; repository: string; strategy: string }) => request<Audit>('audits', source, { method: 'POST', body: JSON.stringify(input) }),
  taskOptions: (signal?: AbortSignal) => request<TaskOptions>('task-options', 'live', { signal }, initialization('任务配置')),
  taskProducts: (signal?: AbortSignal) => request<{ items: TaskProduct[] }>('task-products', 'live', { signal }, initialization('产品目录')),
  taskModels: (signal?: AbortSignal) => request<TaskModels>('task-models', 'live', { signal }, initialization('模型配置')),
  taskRunner: (signal?: AbortSignal) => request<{ runnerEnabled: boolean }>('task-runner', 'live', { signal }, initialization('执行器状态')),
  targets: (productId: string, signal?: AbortSignal) => request<{ items: TaskTarget[] }>(`products/${encodeURIComponent(productId)}/targets`, 'live', { signal }, initialization('源码目录')),
  registerTarget: (productId: string, input: { name: string; path: string }) => request<TaskTarget>(`products/${encodeURIComponent(productId)}/targets`, 'live', { method: 'POST', body: JSON.stringify(input) }),
  createReal: (input: RealAuditInput, key: string) => request<Audit>('audits', 'live', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(input) }),
  retryDraft: (id: string) => request<RealAuditDraft>(`audits/${encodeURIComponent(id)}/retry-draft`, 'live', { method: 'POST', body: '{}' }),
  action: (source: Source, id: string, action: string, version: number, key: string) => request<Audit>(`audits/${encodeURIComponent(id)}/actions`, source, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ action, version }) }),
};
