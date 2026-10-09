import { randomUUID } from 'node:crypto';

export const EXECUTION_PROTOCOL = 'audit-execution.v1';
export const AGENT_SESSION_PROTOCOL = 'audit-agent-session.v1';
export const ENGINES = ['opencode', 'codex', 'grow'];
export const isNativeAudit = audit => audit?.execution?.entry === 'agent';
export function engineId(value = 'opencode') {
  if (!ENGINES.includes(value)) throw Object.assign(new Error('不支持的 Agent 引擎。'), { statusCode: 422, code: 'agent-engine-unsupported' });
  return value;
}
export function executionBinding({ engine = 'opencode', entry = 'web', sessionId = null, directory = null } = {}) {
  engineId(engine);
  if (entry === 'web' && engine !== 'opencode') throw Object.assign(new Error('该引擎尚未接入后台会话创建，请从该 Agent 的当前会话登记审计。'), { statusCode: 422, code: 'agent-launch-unavailable' });
  if (!['web', 'agent'].includes(entry)) throw new Error('任务入口无效。');
  if (sessionId !== null && (typeof sessionId !== 'string' || !/^[A-Za-z0-9._:-]{3,240}$/.test(sessionId))) throw Object.assign(new Error('当前 Agent 会话编号无效。'), { statusCode: 422 });
  if (entry === 'agent' && !sessionId) throw Object.assign(new Error('Agent 入口必须绑定当前会话。'), { statusCode: 422 });
  return { protocol: EXECUTION_PROTOCOL, engine, entry, ownership: entry === 'web' ? 'service' : 'external',
    run_id: `run-${randomUUID()}`, session_id: sessionId, session_directory: directory, generation: randomUUID() };
}
