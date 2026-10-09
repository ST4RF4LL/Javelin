import { tool } from '@opencode-ai/plugin';
import { randomUUID } from 'node:crypto';
import { createNativeClient } from './native-client.mjs';

// Register the host's actual session ID. No model-generated ID or extra run.
export default async function nativeAuditSessionPlugin({ client, directory }, options = {}) {
  if (process.env.AUDIT_TASK_PROTOCOL) return {};
  const api = options.api ?? createNativeClient({ serviceRoot: process.env.AUDIT_SERVICE_ROOT });
  const sessions = new Map();
  const parents = new Map();
  function bindingFor(id) {
    const seen = new Set();
    while (id && !seen.has(id)) { seen.add(id); if (sessions.has(id)) return sessions.get(id); id = parents.get(id); }
  }
  const apiCall = async (method, options) => {
    const result = await client.session[method]({ ...options, throwOnError: true });
    if (result?.error) throw new Error('原生会话控制失败。'); return result;
  };
  async function tick(sessionID, binding) {
    if (binding.busy || binding.ended) return;
    binding.busy = true;
    try {
      const events = binding.events.slice(0, 25);
      const result = await api.call('heartbeat', { audit_id: binding.audit.id, client_id: binding.client_id, events,
        idle: binding.idle, ...(binding.ack ? { ack: binding.ack } : {}) });
      binding.events.splice(0, events.length); binding.ack = null; binding.idle = false; binding.status = result.status;
      if (result.terminal) { binding.ended = true; clearInterval(binding.timer); return; }
      const command = result.command;
      if (command && command.id !== binding.commandId) {
        binding.commandId = command.id;
        try {
          if (['pause', 'cancel'].includes(command.action)) await apiCall('abort', { path: { id: sessionID }, query: { directory } });
          else {
            binding.status = 'running';
            await apiCall('promptAsync', { path: { id: sessionID }, query: { directory }, body: { agent: binding.agent,
              parts: [{ type: 'text', text: command.prompt }] } });
          }
          binding.ack = { id: command.id };
        } catch { binding.status = 'interrupted'; binding.ack = { id: command.id, error: true }; }
      }
      binding.error = null;
    } catch (error) {
      binding.error = error;
      if (error.code === 'agent-session-stale' && !binding.reconnecting) {
        binding.reconnecting = true;
        try {
          const updated = await api.call('register', binding.registration);
          if (updated.terminal) { binding.ended = true; clearInterval(binding.timer); }
          else { Object.assign(binding, updated); binding.status = updated.audit.status; binding.error = null; }
        } catch {} finally { binding.reconnecting = false; }
      }
    }
    finally { binding.busy = false; }
  }
  return {
    tool: {
      audit_register: tool({
        description: '在当前真实 Agent session 登记源码审计，接入后台任务板、Web 进度和报告。保留当前主会话，读取返回的审计 prompt 后继续。只在用户要求启动审计时调用。',
        args: { source_root: tool.schema.string().describe('用户要求审计的源码绝对目录'), name: tool.schema.string().optional(),
          product_id: tool.schema.string().optional(), target_id: tool.schema.string().optional(),
          mining_strategy: tool.schema.enum(['focus_area', 'api']).optional(), api_inventory: tool.schema.string().optional(),
          memory_mode: tool.schema.enum(['full', 'facts_only', 'off', 'blind']).optional(),
          bac_analysis: tool.schema.enum(['auto', 'off']).optional(),
          additional_instructions: tool.schema.string().optional(),
          runtime_testing: tool.schema.object({ protocol: tool.schema.literal('runtime-testing.v1'),
            mode: tool.schema.enum(['CONTACT_ONLY', 'INTEGRATED_TESTING', 'TARGETED_CONFIRMATION']),
            budget_minutes: tool.schema.number().int().min(10).max(240), identity_mode: tool.schema.enum(['auto', 'anonymous', 'shared', 'distinct']),
            allowed_actions: tool.schema.array(tool.schema.enum(['navigate', 'normal_interaction', 'test_input', 'test_mutation'])),
            explicit_authorization: tool.schema.boolean() }).optional(),
          test_environment_enabled: tool.schema.boolean().optional(), test_environment_context: tool.schema.string().optional() },
        async execute(args, context) {
          const prior = sessions.get(context.sessionID);
          const active = prior && !prior.ended && !['completed', 'failed', 'cancelled'].includes(prior.status);
          if (active && !prior.error) {
            if (args.source_root !== prior.registration.source_root || args.target_id && args.target_id !== prior.registration.target_id) throw new Error('当前 session 已有审计任务，请先完成或取消后再登记其他范围。');
            return JSON.stringify({ audit_id: prior.audit.id, status: prior.status, prompt: prior.prompt });
          }
          const registration = active ? prior.registration : { ...args, registration_id: randomUUID(), additional_instructions_enabled: Boolean(args.additional_instructions),
            session: { engine: 'opencode', session_id: context.sessionID, directory: context.directory ?? directory, control: true } };
          const binding = await api.call('register', registration);
          if (binding.terminal) return JSON.stringify({ audit_id: binding.audit.id, status: binding.audit.status });
          if (prior) clearInterval(prior.timer);
          Object.assign(binding, { registration, events: [], agent: context.agent, status: binding.audit.status });
          sessions.set(context.sessionID, binding);
          binding.timer = setInterval(() => { void tick(context.sessionID, binding); }, binding.heartbeat_ms); binding.timer.unref?.();
          return JSON.stringify({ audit_id: binding.audit.id, session_id: context.sessionID, workspace_root: binding.workspace_root, prompt: binding.prompt });
        },
      }),
    },
    'shell.env': async (input, output) => {
      const binding = bindingFor(input.sessionID); if (binding && !binding.ended) Object.assign(output.env, binding.environment);
    },
    'tool.execute.before': async (input, output) => {
      const binding = bindingFor(input.sessionID); if (!binding || binding.ended || input.tool === 'audit_register') return;
      if (binding.error || !['running'].includes(binding.status)) throw new Error('审计当前暂停、断开或正在恢复，请等待任务管理指令。');
      if (input.tool === 'bash' && !output.args.workdir) output.args.workdir = binding.workspace_root;
    },
    'experimental.chat.system.transform': async (input, output) => {
      const binding = bindingFor(input.sessionID);
      if (binding && !binding.ended) output.system.push(`当前会话已登记审计 ${binding.audit.id}。\n${binding.prompt}`);
    },
    event: async ({ event }) => {
      const props = event.properties ?? {}, part = props.part ?? {}, sessionID = props.sessionID ?? part.sessionID ?? props.info?.sessionID ?? props.info?.id;
      if (event.type === 'session.created' && props.info?.parentID) parents.set(props.info.id, props.info.parentID);
      const binding = bindingFor(sessionID); if (!binding || binding.ended) return;
      if (event.type === 'session.idle' && sessions.has(sessionID)) { binding.idle = true; await tick(sessionID, binding); }
      if (event.type === 'message.part.updated' && ['text', 'tool', 'step-start', 'step-finish'].includes(part.type)) {
        if (part.type === 'text' && !part.time?.end) return;
        if (part.type === 'tool' && !['completed', 'error'].includes(part.state?.status)) return;
        const type = { text: 'text', tool: 'tool_use', 'step-start': 'step_start', 'step-finish': 'step_finish' }[part.type];
        binding.events.push({ message: JSON.stringify({ type, sessionID, part }) });
        if (binding.events.length > 100) binding.events.splice(0, binding.events.length - 100);
      }
    },
  };
}
