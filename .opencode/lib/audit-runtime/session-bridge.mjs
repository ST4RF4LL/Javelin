import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createNativeClient } from './native-client.mjs';
import { platformRoot } from './service-process.mjs';
import { join } from 'node:path';

const exec = promisify(execFile);
const scripts = { task_board: 'task-board.mjs', memory: 'audit-memory.mjs', knowledge: 'knowledge-query.mjs', bac: 'bac-analysis.mjs', runtime: 'runtime-testing.mjs' };

// Generic MCP hosts own their session lifecycle. The bridge owns neither a main
// agent process nor its stdin; control is advertised only by capable adapters.
export class AgentSessionBridge {
  constructor({ api = createNativeClient(), execute = exec } = {}) { this.api = api; this.execute = execute; this.sessions = new Map(); }
  async register(input) {
    const key = `${input.engine}:${input.session_id}`;
    const prior = this.sessions.get(key);
    const active = prior && !['completed', 'failed', 'cancelled'].includes(prior.status);
    if (active && (input.source_root !== prior.registration.source_root || input.target_id && input.target_id !== prior.registration.target_id)) throw new Error('当前会话已绑定另一审计范围。');
    const registration = (active ? prior.registration : null) ?? { ...input, registration_id: randomUUID(),
      additional_instructions_enabled: Boolean(input.additional_instructions),
      session: { engine: input.engine, session_id: input.session_id, directory: input.directory, control: false } };
    const context = await this.api.call('register', registration);
    if (context.terminal) return { audit: context.audit, terminal: true };
    clearInterval(prior?.timer);
    const binding = { ...context, registration, status: context.audit.status };
    this.sessions.set(key, binding);
    binding.timer = setInterval(() => { void this.checkpoint(key).catch(() => {}); }, context.heartbeat_ms); binding.timer.unref();
    return { audit_id: context.audit.id, session_id: input.session_id, workspace_root: context.workspace_root, prompt: context.prompt,
      tools: Object.keys(scripts), control: false };
  }
  binding(key) { const binding = this.sessions.get(key); if (!binding) throw new Error('请先登记当前 Agent 会话。'); return binding; }
  async checkpoint(key, message = null) {
    const binding = this.binding(key);
    if (binding.busy) return { status: binding.status };
    binding.busy = true;
    try {
      const result = await this.api.call('heartbeat', { audit_id: binding.audit.id, client_id: binding.client_id, check_completion: true,
        events: message ? [{ message: JSON.stringify({ type: 'text', sessionID: binding.registration.session.session_id,
          part: { type: 'text', text: message } }) }] : [] });
      binding.status = result.status; binding.error = null;
      if (result.terminal) clearInterval(binding.timer);
      return result;
    } catch (error) {
      binding.error = error;
      if (error.code === 'agent-session-stale') {
        const updated = await this.api.call('register', binding.registration);
        if (updated.terminal) clearInterval(binding.timer);
        else { Object.assign(binding, updated); binding.status = updated.audit.status; binding.error = null; }
      }
      throw error;
    } finally { binding.busy = false; }
  }
  async command(key, name, args) {
    const binding = this.binding(key);
    if (!scripts[name] || !Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))) throw new Error('审计命令参数无效。');
    await this.checkpoint(key);
    if (binding.error || binding.status !== 'running') throw new Error('任务没有运行，请在当前会话重新登记。');
    const result = await this.execute(process.execPath, [join(platformRoot, '.opencode/scripts', scripts[name]), ...args], {
      cwd: binding.workspace_root, env: { ...process.env, ...binding.environment }, timeout: 120_000, maxBuffer: 2 * 1024 * 1024, shell: false, windowsHide: true,
    });
    await this.checkpoint(key);
    return result.stdout;
  }
  close() { for (const binding of this.sessions.values()) clearInterval(binding.timer); this.sessions.clear(); }
}
