import type { Audit, RealAuditInput, TaskTarget } from '../../shared/contracts';

export function repositoryName(path: string) {
  return path.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'repo';
}

export function resolveBatchTargets(targetIds: string[], targets: TaskTarget[]): TaskTarget[] {
  const byId = new Map(targets.map(target => [target.id, target]));
  return [...new Set(targetIds)].map(id => byId.get(id) || {
    id, name: id, path: '', runnable: false, reason: '项目已移出当前产品或已归档，请返回列表重新选择。',
  });
}

export function batchAuditName(path: string, date = new Date()) {
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `${repositoryName(path).slice(0, 147)} · ${day}`;
}

export interface BatchAuditItem {
  input: RealAuditInput;
  key: string;
  path: string;
  status: 'pending' | 'submitting' | 'created' | 'failed' | 'uncertain';
  audit?: Audit;
  error?: string;
  requestId?: string | null;
}

export function prepareBatchAudits(config: RealAuditInput, targets: TaskTarget[], date = new Date()): BatchAuditItem[] {
  const selected = resolveBatchTargets(targets.map(target => target.id), targets);
  const unavailable = selected.find(target => !target.runnable);
  if (unavailable) throw new Error(`${unavailable.name}：${unavailable.reason || '项目不可运行'}`);
  return selected.map(target => ({
    input: { ...structuredClone(config), targetId: target.id, auditId: `audit-${crypto.randomUUID()}`, name: batchAuditName(target.path, date) },
    key: crypto.randomUUID(), path: target.path, status: 'pending',
  }));
}

export async function submitBatchAudits(
  items: BatchAuditItem[], create: (input: RealAuditInput, key: string) => Promise<Audit>,
  onUpdate: (items: BatchAuditItem[]) => void,
) {
  let results = items.map(item => ({ ...item }));
  const update = (index: number, patch: Partial<BatchAuditItem>) => {
    results = results.map((item, i) => i === index ? { ...item, ...patch } : item);
    onUpdate(results);
  };
  for (let index = 0; index < results.length; index++) {
    const item = results[index];
    if (item.status === 'created') continue;
    update(index, { status: 'submitting', error: undefined, requestId: undefined });
    try {
      const audit = await create(item.input, item.key);
      update(index, { status: 'created', audit });
    } catch (error) {
      const details = error as { status?: number; requestId?: string } | null;
      const status = details?.status;
      const uncertain = !status || status >= 500;
      update(index, { status: uncertain ? 'uncertain' : 'failed', error: error instanceof Error ? error.message : '任务提交失败，请重试。', requestId: details?.requestId });
    }
  }
  return results;
}
