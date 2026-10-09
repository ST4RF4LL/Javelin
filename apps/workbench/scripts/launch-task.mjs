import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createTaskInput, idempotencyKey } from '../build/api/server/task-contract.js';
import { createUpstreamTransport } from '../build/api/server/upstream-transport.js';
import { WORKBENCH_API_VERSION } from '../build/api/shared/contracts.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function validateSpec(spec) {
  const url = new URL(spec.origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('新版地址必须是无凭据的 HTTP(S) origin。');
  createTaskInput(spec.input); idempotencyKey(spec.idempotencyKey);
  if (!spec.input.model || spec.input.model === 'default') throw new Error('验收任务必须指定完整的 provider/model，不能依赖默认模型。');
  return url.origin;
}
export async function launchTask(spec, { transport, wait = delay, timeoutMs = 120000, progress = () => {} } = {}) {
  const origin = validateSpec(spec); const { input } = spec;
  let owned;
  if (!transport) { owned = createUpstreamTransport(); transport = owned.fetch; }
  const checks = [];
  async function call(path, { body, key, format = 'json', missing = false } = {}) {
    const isWrite = body !== undefined;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new DOMException('请求超时', 'TimeoutError')), isWrite ? 70000 : 25000);
    try {
      const response = await transport(`${origin}${path}`, { signal: abort.signal, method: isWrite ? 'POST' : 'GET', redirect: 'error', headers: { Accept: format === 'html' ? 'text/html' : 'application/json', ...(isWrite ? { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) }, ...(isWrite ? { body: JSON.stringify(body) } : {}) });
      if (missing && response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`新版接口 ${path.split('?')[0]} 返回 HTTP ${response.status}，请求编号 ${response.headers.get('x-request-id') || '未提供'}。`), { status: response.status }); }
      if (format === 'bytes') return Buffer.from(await response.arrayBuffer());
      if (format === 'html') { const content = await response.text(); if (!response.headers.get('content-type')?.includes('text/html') || !content.includes('<html')) throw new Error(`页面 ${path} 未返回 HTML。`); return content; }
      return await response.json();
    } catch (error) {
      if (isWrite && !error.status) throw new Error(`提交结果尚未确认。请沿用本次文件和任务编号 ${input.auditId} 再次查询，不要新建第二份任务。`, { cause: error });
      throw error;
    } finally { clearTimeout(timer); }
  }
  const api = (path, options) => call(`/api/workbench/${path}`, options);
  function checkAudit(audit) {
    if (audit.id !== input.auditId || audit.model !== input.model || audit.productId !== input.productId || audit.targetId !== input.targetId) throw new Error('任务编号、模型或源码归属与提交文件不一致，已停止操作。');
    if (input.testEnvironmentEnabled && input.testEnvironmentContext?.trim() && audit.runtimeTestingStatus === 'SKIPPED') throw new Error('该任务未开启所请求的动态测试，已停止操作。');
  }
  try {
    const health = await api('health');
    if (health.apiVersion !== WORKBENCH_API_VERSION) throw new Error('4181 仍在运行旧版后端，请正常重启新版后再执行；未提交任务。');
    if (health.mode !== 'integrated' || health.liveReadOnly) throw new Error('当前入口不能运行真实任务；未提交任务。');
    const [models, products, runner, targets, snapshot, findings, audits] = await Promise.all([
      api('task-models'), api('task-products'), api('task-runner'), api(`products/${encodeURIComponent(input.productId)}/targets`), api('snapshot'), api('findings'), api('audits'),
    ]);
    if (!models.models?.some(model => model.value === input.model)) throw new Error('指定模型不在原平台 OpenCode 配置清单内；未提交任务。');
    if (!products.items?.some(product => product.id === input.productId) || !targets.items?.some(target => target.id === input.targetId && target.runnable && (!spec.expectedSourcePath || target.path === spec.expectedSourcePath))) throw new Error('产品、源码对象或源码路径与预期不符；未提交任务。');
    if (!runner.runnerEnabled || !Array.isArray(snapshot.reports) || !Array.isArray(findings.findings) || !Array.isArray(audits.items)) throw new Error('执行器或数据列表未就绪；未提交任务。');
    checks.push('模型、产品、源码、执行器、概览、任务和漏洞接口通过');
    for (const page of ['/', '/products', '/audits', '/findings', '/reports', '/validation', '/runtime', '/settings']) await call(page, { format: 'html' });
    checks.push('六个页面的 HTTP 入口通过（不等同于浏览器渲染验收）');
    if (snapshot.reports.length) {
      const id = encodeURIComponent(snapshot.reports[0].id);
      const [report, bytes] = await Promise.all([api(`reports/${id}`), api(`reports/${id}/download`, { format: 'bytes' })]);
      if (typeof report.body !== 'string' || !report.date || !report.presentation?.source_sha256 || sha256(bytes) !== report.presentation.source_sha256) throw new Error('报告正文、日期或封存原文字节校验失败；未提交任务。');
      checks.push('报告正文、封存日期和原文下载校验通过');
    }
    progress({ phase: 'preflight', checks });
    const path = `audits/${encodeURIComponent(input.auditId)}`;
    let audit = await api(path, { missing: true });
    if (!audit) audit = await api('audits', { body: input, key: spec.idempotencyKey });
    checkAudit(audit);
    const deadline = Date.now() + timeoutMs; let dispatchAttempted = false;
    while (true) {
      progress({ phase: 'task', auditId: audit.id, status: audit.status, model: audit.model });
      if (['running', 'completed'].includes(audit.status)) return { status: 'started', auditId: audit.id, model: audit.model, taskStatus: audit.status, runtimeTestingStatus: audit.runtimeTestingStatus, url: `${origin}/audits/${encodeURIComponent(audit.id)}`, checks, modelResponseVerified: false, targetContactVerified: false };
      if (!['queued', 'preparing', 'recovering'].includes(audit.status)) throw new Error(`任务 ${audit.id} 当前为 ${audit.status}；未自动恢复或另建任务，请查看任务详情。`);
      if (audit.status === 'queued' && audit.allowedActions?.includes('dispatch') && !dispatchAttempted) {
        dispatchAttempted = true;
        try { await api(`${path}/actions`, { body: { action: 'dispatch', version: audit.version }, key: `dispatch:${sha256(`${spec.idempotencyKey}:${audit.version}`)}` }); }
        catch (error) { if (![409, 412].includes(error.status)) throw error; }
      }
      if (Date.now() >= deadline) return { status: 'waiting', auditId: audit.id, taskStatus: audit.status, model: audit.model, checks };
      await wait(2000); audit = await api(path); checkAudit(audit);
    }
  } finally { owned?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) { process.stderr.write('用法：node apps/workbench/scripts/launch-task.mjs <任务 JSON 文件> [--validate-only]\n'); process.exitCode = 1; }
  else try {
    const spec = JSON.parse(await readFile(path, 'utf8')); validateSpec(spec);
    if (process.argv.includes('--validate-only')) process.stdout.write(`任务参数有效：${spec.input.auditId} · ${spec.input.model}（尚未提交）\n`);
    else {
      const result = await launchTask(spec, { progress: event => process.stdout.write(`${JSON.stringify(event)}\n`) });
      await writeFile(`${path}.result.json`, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.status !== 'started') process.exitCode = 2;
    }
  } catch (error) { process.stderr.write(`任务未完成启动验收：${error.message}\n`); process.exitCode = 1; }
}
