import type { Audit, RealAuditInput, TaskTarget } from '../../shared/contracts';

export function directoryKey(path: string) {
  const trimmed = path.trim().replace(/[\\/]+$/, '');
  return /^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(trimmed) ? trimmed.replace(/\\/g, '/').toLowerCase() : trimmed;
}

export function repositoryName(path: string) {
  return path.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'repo';
}

export function parseRepositoryPaths(text: string) {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    let path = line.trim();
    if (!path) continue;
    if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1, -1).trim();
    if (path.length > 4096 || !/^(?:\/|[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(path)) throw new Error(`第 ${index + 1} 行请填写本机绝对目录，每行一个。`);
    const key = directoryKey(path);
    if (!seen.has(key)) { seen.add(key); paths.push(path); }
  }
  if (!paths.length) throw new Error('请至少填写一个本机源码目录。');
  return paths;
}

export async function registerBatchRepositories(
  paths: string[], existing: TaskTarget[], register: (input: { name: string; path: string }) => Promise<TaskTarget>,
) {
  const targets = [...existing];
  const selectedIds: string[] = [];
  const failures: { path: string; message: string }[] = [];
  for (const path of paths) {
    try {
      const matching = targets.filter(target => directoryKey(target.path) === directoryKey(path));
      let target = matching.find(target => target.runnable) || matching[0];
      if (!target) {
        target = await register({ name: repositoryName(path).slice(0, 160), path });
        targets.push(target);
      }
      if (!target.runnable) throw new Error(target.reason || '源码目录不可用');
      selectedIds.push(target.id);
    } catch (error) {
      failures.push({ path, message: error instanceof Error ? error.message : '目录登记失败，请重试。' });
    }
  }
  return { targets, selectedIds: [...new Set(selectedIds)], failures };
}

export function uniqueRepositories(targets: TaskTarget[]) {
  const seen = new Set<string>();
  return targets.filter(target => {
    const key = directoryKey(target.path);
    if (!target.runnable || seen.has(key)) return false;
    seen.add(key); return true;
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
  return uniqueRepositories(targets).map(target => ({
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
