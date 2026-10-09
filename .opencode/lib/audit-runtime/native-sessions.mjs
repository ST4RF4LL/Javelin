import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { AGENT_SESSION_PROTOCOL, engineId, isNativeAudit } from './contract.mjs';

const fail = (message, code = 'agent-session-invalid', statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const done = status => ['completed', 'failed', 'cancelled'].includes(status);
const sessionId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{3,240}$/.test(value);

export class NativeSessionController {
  constructor({ runner, token, createAudit, clock = Date.now, heartbeatMs = 60_000 }) {
    Object.assign(this, { runner, token, createAudit, clock, heartbeatMs });
    this.clients = new Map(); this.locks = new Map(); this.checking = false;
    runner.nativeSessionController = this;
    this.timer = setInterval(() => this.check().catch(() => {}), Math.min(10_000, heartbeatMs)); this.timer.unref();
  }
  authorize(request) {
    const value = Buffer.from(String(request.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!this.token || request.headers.origin || request.headers['sec-fetch-site'] || value.length !== this.token.length || !timingSafeEqual(value, Buffer.from(this.token))) throw fail('当前会话入口只接受已登记的本机 Agent 客户端。', 'agent-access-denied', 403);
  }
  serial(key, operation) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation); this.locks.set(key, pending);
    pending.finally(() => { if (this.locks.get(key) === pending) this.locks.delete(key); }).catch(() => {});
    return pending;
  }
  async restart(audit, session) {
    await this.runner.stopTaskBoard(audit); await this.runner.stopRuntimeTesting(audit);
    try { await this.runner.start(audit, this.runner.repositoryForAudit(audit), { resume: true, nativeSession: session }); }
    catch (error) {
      await this.runner.stopTaskBoard(audit); await this.runner.stopRuntimeTesting(audit);
      audit.status = 'interrupted'; audit.error = '当前会话的审计上下文恢复失败，请核对冻结的源码范围和已有制品。';
      await this.runner.record(audit, 'audit.interrupted', { reason: 'native-registration-failed', code: error.code ?? null });
      throw error;
    }
  }
  async register(input) {
    const session = input.session && { ...input.session };
    if (!session || !sessionId(session.session_id) || !isAbsolute(session.directory ?? '')) throw fail('必须登记真实的当前 session 和绝对工作目录。');
    engineId(session.engine);
    session.directory = await realpath(session.directory);
    if (!(await stat(session.directory)).isDirectory()) throw fail('当前会话工作目录不存在。');
    if (!sessionId(input.registration_id)) throw fail('缺少稳定的会话登记请求编号。');
    return this.serial(`register:${session.engine}:${session.session_id}`, async () => {
      await this.runner.ready;
      const previous = [...this.runner.audits.values()].find(a => isNativeAudit(a) && a.execution.engine === session.engine && a.execution.session_id === session.session_id && (!done(a.status) || a.execution.registration_id === input.registration_id));
      let audit;
      if (previous) {
        if (input.target_id && input.target_id !== previous.repository_id || input.source_root && await realpath(input.source_root) !== this.runner.repositoryForAudit(previous)?.path) throw fail('当前 session 已绑定另一审计范围，请先结束该任务。');
        audit = previous;
        if (done(audit.status)) return { protocol: AGENT_SESSION_PROTOCOL, audit: this.runner.getAudit(audit.id), terminal: true };
        if (!this.runner.nativeContexts.has(audit.id) || audit.status === 'interrupted') {
          await this.restart(audit, session);
          if (audit.execution.suspended) {
            await this.runner.stopTaskBoard(audit); await this.runner.stopRuntimeTesting(audit); audit.status = 'paused';
          }
        }
      } else {
        const idempotency_key = `native:${createHash('sha256').update(`${session.engine}:${session.session_id}:${input.registration_id}`).digest('hex')}`;
        const created = await this.createAudit({ ...input, idempotency_key,
          runtime_testing: input.runtime_testing ?? { protocol: 'runtime-testing.v1', mode: 'CONTACT_ONLY', budget_minutes: 60,
            identity_mode: 'auto', allowed_actions: ['navigate', 'normal_interaction'], explicit_authorization: input.test_environment_enabled === true },
        }, session);
        audit = this.runner.audits.get(created.id);
      }
      const clientId = this.clients.get(audit.id)?.id ?? randomUUID();
      this.clients.set(audit.id, { id: clientId, seen: this.clock(), session, capabilities: { control: session.control === true } });
      audit.execution.connected = true;
      if (['running', 'paused'].includes(audit.status) && audit.native_context?.command?.state === 'pending') audit.native_context.command.state = 'superseded';
      audit.execution.capabilities = { control: session.control === true, terminal: false };
      await this.runner.record(audit, 'audit.session.connected', { engine: session.engine, session_id: session.session_id });
      return this.context(audit, clientId);
    });
  }
  context(audit, clientId) {
    const context = this.runner.nativeContexts.get(audit.id);
    if (!context) throw fail('当前任务上下文不可用，请在原会话重新登记。');
    const environment = Object.fromEntries(Object.entries(context.environment).filter(([key]) => key.startsWith('AUDIT_')));
    return { protocol: AGENT_SESSION_PROTOCOL, client_id: clientId, audit: this.runner.getAudit(audit.id),
      environment, workspace_root: context.paths.workspace_root,
      prompt: context.prompt.replace(/(?<![\w./])\.opencode\//g, `${this.runner.platformRoot}/.opencode/`), heartbeat_ms: Math.min(5000, this.heartbeatMs / 4) };
  }
  requireClient(input) {
    const client = this.clients.get(input.audit_id), audit = this.runner.audits.get(input.audit_id);
    if (!client || client.id !== input.client_id || !audit || client.session.session_id !== audit.execution?.session_id) throw fail('会话登记已过期，请重新登记当前会话。', 'agent-session-stale');
    client.seen = this.clock(); return { client, audit };
  }
  async heartbeat(input) {
    return this.serial(input.audit_id, async () => {
      const { audit } = this.requireClient(input);
      if (input.ack) {
        const command = audit.native_context?.command;
        if (command?.id === input.ack.id && command.state === 'pending') {
          command.state = input.ack.error ? 'failed' : 'applied';
          if (input.ack.error) {
            await this.runner.stopTaskBoard(audit); await this.runner.stopRuntimeTesting(audit);
            audit.status = 'interrupted'; audit.error = '原生 Agent 未能执行任务管理指令，请在当前会话查看原因后重新登记。';
          } else {
            audit.status = { pause: 'paused', cancel: 'cancelled', resume: 'running', recover: 'running' }[command.action];
            audit.execution.suspended = command.action === 'pause';
            if (command.action === 'cancel') audit.finished_at = new Date(this.clock()).toISOString();
            if (['resume', 'recover'].includes(command.action)) this.runner.taskBoardServices.get(audit.id)?.resume();
          }
          await this.runner.record(audit, `audit.${audit.status}`, { action: command.action, command_id: command.id, source: 'agent-session' });
        }
      }
      for (const event of (Array.isArray(input.events) ? input.events : []).slice(0, 25)) {
        if (event && typeof event.message === 'string') await this.runner.recordLog(audit, 'stdout', event.message.slice(0, 16 * 1024));
      }
      // The agent never declares completion. The platform verifies the same
      // board/report contracts as it does for a service-owned execution.
      if (audit.status === 'running' && (input.check_completion || input.idle)) await this.runner.reconcileManagedCompletion(audit, 'native-session-checkpoint', { allowRunning: true });
      return { protocol: AGENT_SESSION_PROTOCOL, audit_id: audit.id, status: audit.status, terminal: ['completed', 'failed'].includes(audit.status),
        command: audit.native_context?.command?.state === 'pending' ? audit.native_context.command : null };
    });
  }
  async action(audit, action, digest, expectedVersion = audit.version) {
    return this.serial(audit.id, async () => {
      if (audit.action_idempotency_digests?.includes(digest)) return this.runner.getAudit(audit.id);
      if (Number(expectedVersion) !== audit.version) throw fail('审计版本已变化，请刷新后重试。', 'version-mismatch', 412);
      const client = this.clients.get(audit.id);
      if (!client || this.clock() - client.seen > this.heartbeatMs) throw fail('原生 Agent 会话未连接，请在原会话重新登记后继续。', 'agent-session-offline');
      if (!client.capabilities.control) throw fail('此 Agent 尚未接入当前会话控制，请在原会话操作。', 'agent-control-unavailable');
      if (audit.native_context?.command?.state === 'pending') throw fail('上一条任务指令仍在执行，请等待会话确认。', 'agent-command-pending');
      const allowed = { pause: ['running'], resume: ['paused'], recover: ['interrupted', 'cancelled'], cancel: ['running', 'paused', 'interrupted'] };
      if (!allowed[action]?.includes(audit.status)) throw fail('操作与当前任务状态不匹配。', 'action-not-allowed');
      if (['pause', 'cancel'].includes(action)) { await this.runner.stopTaskBoard(audit); await this.runner.stopRuntimeTesting(audit); }
      if (['resume', 'recover'].includes(action) && !this.runner.taskBoardServices.has(audit.id)) {
        await this.restart(audit, client.session);
        await this.runner.taskBoardServices.get(audit.id)?.pause();
        audit.recovery_count = (audit.recovery_count ?? 0) + 1;
      }
      const context = this.context(audit, client.id);
      audit.native_context = { command: { id: randomUUID(), action, state: 'pending',
        ...(['resume', 'recover'].includes(action) ? { prompt: `继续当前审计，复用已交付制品和检查点。\n${context.prompt}` } : {}) } };
      audit.status = { pause: 'pausing', resume: 'recovering', recover: 'recovering', cancel: 'cancelling' }[action];
      audit.action_idempotency_digests = [...(audit.action_idempotency_digests ?? []), digest].slice(-100);
      await this.runner.record(audit, 'audit.session.command', { action, command_id: audit.native_context.command.id });
      return this.runner.getAudit(audit.id);
    });
  }
  async check() {
    if (this.checking) return; this.checking = true;
    try {
      for (const [id, client] of this.clients) if (this.clock() - client.seen > this.heartbeatMs) {
        await this.serial(id, async () => {
          if (this.clock() - client.seen <= this.heartbeatMs) return;
          this.clients.delete(id); const audit = this.runner.audits.get(id);
          if (!audit) return;
          audit.execution.connected = false;
          if (done(audit.status)) { await this.runner.persist(audit); return; }
          audit.execution.suspended = ['paused', 'pausing'].includes(audit.status);
          await this.runner.stopTaskBoard(audit); await this.runner.stopRuntimeTesting(audit);
          audit.execution.connected = false; audit.status = 'interrupted'; audit.interruption_reason = 'agent-session-disconnected';
          audit.error = '原生 Agent 会话已断开；在原会话重新登记即可使用已有制品继续。';
          await this.runner.record(audit, 'audit.interrupted', { reason: audit.interruption_reason });
        });
      }
    } finally { this.checking = false; }
  }
  async close() {
    clearInterval(this.timer); await Promise.allSettled([...this.locks.values()]);
    for (const id of this.clients.keys()) {
      const audit = this.runner.audits.get(id); if (!audit) continue;
      audit.execution.connected = false;
      audit.execution.suspended = ['paused', 'pausing'].includes(audit.status);
      if (!done(audit.status)) { audit.status = 'interrupted'; audit.interruption_reason = 'execution-service-stopped'; }
      await this.runner.record(audit, 'audit.session.disconnected', { reason: 'execution-service-stopped' });
    }
    this.clients.clear();
  }
}
