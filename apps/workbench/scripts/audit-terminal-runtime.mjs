import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readCheckpointSession } from '../../../.opencode/lib/audit-runtime/engines/grow-session.mjs';

export const AUDIT_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/i;
const unavailable = message => Object.assign(new Error(message), { status: 409 });

function readState(stateRoot, id, { allowCheckpoint = false } = {}) {
  if (!AUDIT_ID.test(id)) throw unavailable('任务编号无效。');
  try {
    const root = realpathSync(stateRoot), directory = realpathSync(join(root, id));
    if (dirname(directory) !== root) throw unavailable('任务目录不在平台工作区。');
    const read = name => {
      const path = realpathSync(join(directory, name));
      if (dirname(path) !== directory) throw unavailable('任务连接文件不在受控目录。');
      return JSON.parse(readFileSync(path, 'utf8'));
    };
    const audit = read('run.json');
    const checkpoint = allowCheckpoint && audit.execution?.engine === 'grow' && ['paused', 'completed', 'failed', 'interrupted', 'cancelled'].includes(audit.status);
    if (audit.id !== id || (!checkpoint && (audit.status !== 'running' || !audit.terminal?.live))) {
      throw unavailable('任务当前没有运行中的终端。暂停或中断的任务请先使用工作台恢复操作。');
    }
    return { audit, read };
  } catch (error) {
    if (error.status) throw error;
    throw unavailable('任务服务尚未就绪或已结束，请刷新任务状态。');
  }
}

export function readAuditConnection(stateRoot, id) {
  const { audit, read } = readState(stateRoot, id);
  if (!audit.terminal.shared_server) throw unavailable('此任务没有可连接的 OpenCode 共享服务。');
  let binding;
  try { binding = read('opencode-server.json'); } catch { throw unavailable('任务服务尚未就绪或已结束，请刷新任务状态。'); }
  const v2 = audit.execution?.engine === 'opencode-v2';
  if (binding.schema_version !== (v2 ? 'opencode-v2-shared-run.v1' : 'opencode-shared-run.v1') || binding.audit_id !== id ||
    !/^ses_[A-Za-z0-9_-]+$/.test(binding.session_id ?? '') || !binding.generation ||
    (audit.provider_session_id && binding.session_id !== audit.provider_session_id) ||
    (audit.terminal.server_generation && binding.generation !== audit.terminal.server_generation) ||
    binding.directory !== audit.paths?.workspace_root || !isAbsolute(binding.directory ?? '') ||
    !isAbsolute(binding.command ?? '') || !/^[a-f0-9]{64}$/.test(binding.password ?? '') || (!v2 && binding.username !== 'opencode')) {
    throw unavailable('OpenCode 服务与当前任务的绑定不匹配。');
  }
  let url;
  try { url = new URL(binding.url); } catch { throw unavailable('OpenCode 服务地址无效。'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw unavailable('OpenCode 服务地址无效。');
  }
  return binding;
}

// Only server-owned task state determines the command. No client command/socket input.
export function readAuditTerminal(stateRoot, id, { generation, readOnly = false } = {}) {
  const { audit, read } = readState(stateRoot, id, { allowCheckpoint: true });
  let target;
  if (audit.execution?.engine === 'grow') {
    if (!['paused', 'completed', 'failed', 'interrupted', 'cancelled'].includes(audit.status) || audit.pid) throw unavailable('Grow 不支持运行中附着同一会话。请先暂停任务；实时进度可在 JSON 事件中查看。');
    const binding = read('agent-terminal.json');
    const session = audit.provider_session_id;
    if (binding.engine !== 'grow' || binding.audit_id !== id || binding.cwd !== audit.paths?.workspace_root ||
      !isAbsolute(binding.command ?? '') || !isAbsolute(binding.cwd ?? '') ||
      !/^[a-f0-9-]{36}$/i.test(session ?? '') || !isAbsolute(binding.environment?.GROW_HOME ?? '') ||
      binding.generation !== audit.execution.generation || (generation && generation !== binding.generation)) throw unavailable('Grow 会话绑定已失效，请刷新任务状态。');
    const parent = readCheckpointSession(binding.environment.GROW_HOME, session);
    const digest = createHash('sha256').update(`${binding.generation}:${parent}`).digest('hex');
    const fork = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    target = { kind: 'grow', generation: binding.generation, readOnly, command: binding.command, boundSessionId: session,
      args: ['--cwd', binding.cwd, '--resume', parent, '--fork-session', '--session-id', fork,
        '--agent', join(binding.environment.GROW_HOME, 'agents', 'interactive-security-audit-orchestrator.md'), '--permission-mode', 'ask', '--no-memory', '--no-plan'], cwd: binding.cwd,
      environment: { GROW_HOME: binding.environment.GROW_HOME, GROW_DISABLE_AUTOUPDATER: '1',
        GROW_MEMORY: '0', GROW_WORKFLOWS: '0', GROW_GOAL: '0', GROW_SUBAGENTS: '1' },
      leasePath: join(resolve(stateRoot), id, 'agent-terminal-lease.json') };
  } else if (audit.terminal.shared_server) {
    const binding = readAuditConnection(stateRoot, id);
    if (generation && generation !== binding.generation) throw unavailable('任务已恢复到新执行，请从工作台重新打开终端。');
    const v2 = audit.execution?.engine === 'opencode-v2';
    target = { kind: v2 ? 'opencode-v2' : 'opencode', generation: binding.generation, readOnly,
      command: binding.command, args: v2 ? ['--server', binding.url, '--session', binding.session_id]
        : ['attach', binding.url, '--session', binding.session_id, '--dir', binding.directory],
      cwd: binding.directory, environment: v2 ? { OPENCODE_PASSWORD: binding.password,
        OPENCODE_CONFIG: binding.config_path, OPENCODE_CONFIG_DIR: binding.config_directory, OPENCODE_CONFIG_PROJECT_DISABLE: 'true',
        ...Object.fromEntries(['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'JAVELIN_OPENCODE_V2_HOME']
          .filter(key => typeof binding.environment?.[key] === 'string').map(key => [key, binding.environment[key]])) }
        : { OPENCODE_SERVER_USERNAME: binding.username, OPENCODE_SERVER_PASSWORD: binding.password } };
  } else {
    throw unavailable('旧任务没有共享会话连接。请查看归档日志，或在任务结束后断点恢复以使用 ttyd；平台不会启动 tmux/psmux。');
  }
  // A newly persisted Grow interactive branch changes the next launch's args,
  // not ownership of the current terminal. Keep that terminal valid until the
  // managed task generation/session changes or its lease is released.
  const identity = target.kind === 'grow' ? { ...target, args: undefined } : target;
  return { ...target, auditId: id, name: audit.name || id,
    fingerprint: createHash('sha256').update(JSON.stringify({ auditId: id, ...identity })).digest('hex') };
}
