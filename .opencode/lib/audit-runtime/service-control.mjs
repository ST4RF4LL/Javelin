import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readServiceConnection, SERVICE_PROTOCOL } from './service-process.mjs';
import { localServiceFetch, serviceRequestErrorCode } from './local-service-transport.mjs';

const ACTIVE = new Set(['queued', 'preparing', 'recovering', 'running', 'pausing', 'paused', 'cancelling']);

// Control an existing daemon through its public task APIs. Never construct a
// Runner, acquire its state lease, or require the daemon's code digest to match.
export async function connectServiceControl({ serviceRoot, fetcher = localServiceFetch } = {}) {
  const connection = await readServiceConnection(serviceRoot);
  async function request(path, options = {}) {
    let response;
    try {
      response = await fetcher(`${connection.origin}${path}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${connection.token}`, ...(options.body ? { 'Content-Type': 'application/json', Origin: connection.origin } : {}), ...options.headers } });
    } catch (error) {
      throw Object.assign(new Error(`无法连接审计后台（${serviceRequestErrorCode(error)}）；未终止进程或改写任务状态。`), { code: serviceRequestErrorCode(error) });
    }
    const value = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(`后台请求失败：HTTP ${response.status}${typeof value?.code === 'string' ? ` / ${value.code}` : ''}。`), { status: response.status });
    if (!value || typeof value !== 'object') throw new Error('后台未返回有效 JSON，未执行后续操作。');
    return value;
  }
  async function health() {
    const value = await request('/api/v1/runtime/health');
    if (value.service !== 'opencode-audit-workbench' || value.runtime_service?.protocol !== SERVICE_PROTOCOL
      || value.runtime_service.generation !== connection.generation || value.runtime_service.pid !== connection.pid || value.runtime_service.ready !== true) {
      throw new Error('后台身份已变化或尚未就绪，请重新执行命令；未向其他实例发送取消请求。');
    }
    return value;
  }
  await health();
  async function tasks() {
    const audits = new Map();
    for (let page = 1, total = 1; page <= total; page++) {
      const value = await request(`/api/v1/audits?live=1&page_size=100&page=${page}`);
      if (!Array.isArray(value.items) || !Number.isInteger(value.total_pages) || value.total_pages < 1 || value.total_pages > 10000) throw new Error('后台任务分页格式无效，未把读取失败视为无活动任务。');
      total = value.total_pages;
      for (const audit of value.items) if (ACTIVE.has(audit.status)) audits.set(audit.id, { kind: 'audit', id: audit.id, status: audit.status });
    }
    const validations = await request('/api/v1/validation-requests');
    if (!Array.isArray(validations.items)) throw new Error('后台动态验证列表格式无效。');
    const jobs = new Map();
    for (const row of validations.items) if (row.job?.id && ACTIVE.has(row.job.status)) jobs.set(row.job.id, { kind: 'validation', id: row.job.id, status: row.job.status });
    return [...audits.values(), ...jobs.values()];
  }
  async function cancel(task) {
    const key = randomUUID();
    if (task.kind === 'validation') return request(`/api/v1/validations/${encodeURIComponent(task.id)}/actions`, { method: 'POST', body: JSON.stringify({ action: 'cancel' }), headers: { 'Idempotency-Key': key } });
    for (let attempt = 0; attempt < 3; attempt++) {
      const audit = await request(`/api/v1/audits/${encodeURIComponent(task.id)}?live=1`);
      if (!ACTIVE.has(audit.status) || audit.status === 'cancelling') return audit;
      if (!Number.isInteger(audit.version)) throw new Error('后台未提供任务版本，未发送取消请求。');
      const product = audit.provenance?.audit_product_id ?? audit.provenance?.product_id;
      const base = product ? `/api/v2/products/${encodeURIComponent(product)}/audits` : '/api/v1/audits';
      try {
        return await request(`${base}/${encodeURIComponent(task.id)}/actions`, { method: 'POST', body: JSON.stringify({ action: 'cancel' }),
          headers: { 'If-Match': `"${audit.version}"`, 'Idempotency-Key': key } });
      } catch (error) { if (error.status !== 412 || attempt === 2) throw error; }
    }
  }
  return { tasks, health, cancel };
}

export async function cancelAllServiceTasks(control, { timeoutMs = 60000, pollMs = 500, notify = () => {}, now = Date.now, sleep = delay } = {}) {
  const deadline = now() + timeoutMs, attempted = new Set(), failures = new Map();
  let pending = [];
  do {
    const health = await control.health();
    pending = await control.tasks();
    if (!pending.length) {
      if (Number(health.runner?.active_processes) === 0 && Number(health.dynamic_runner?.active_processes) === 0) {
        notify('已确认没有活动任务；已有报告和运行记录保留。');
        return;
      }
    }
    for (const task of pending) {
      const key = `${task.kind}:${task.id}`;
      if (task.status === 'cancelling' || attempted.has(key)) continue;
      attempted.add(key);
      try { await control.cancel(task); notify(`已提交取消：${task.id}；等待后台确认结束。`); }
      catch (error) { failures.set(key, error.message); notify(`取消未确认：${task.id}；${error.message}`); }
    }
    // An HTTP error may race with task completion. Re-read before reporting it.
    if (pending.some(task => failures.has(`${task.kind}:${task.id}`))) {
      pending = await control.tasks();
      if (pending.some(task => failures.has(`${task.kind}:${task.id}`) && task.status !== 'cancelling')) break;
    }
    if (now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  } while (now() < deadline);
  const remaining = pending.map(task => `${task.id}（${task.status}）`).join('、');
  throw new Error(`尚未确认全部结束：${remaining || '后台仍有执行进程或状态未知'}。未强杀进程，也未把任务强行标记为已取消；请保留此输出。`);
}
