import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const AUDIT_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/i;
const unavailable = message => Object.assign(new Error(message), { status: 409 });

function readState(stateRoot, id) {
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
    if (audit.id !== id || audit.status !== 'running' || !audit.terminal?.live) {
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
  if (binding.schema_version !== 'opencode-shared-run.v1' || binding.audit_id !== id ||
    !/^ses_[A-Za-z0-9_-]+$/.test(binding.session_id ?? '') || !binding.generation ||
    (audit.provider_session_id && binding.session_id !== audit.provider_session_id) ||
    (audit.terminal.server_generation && binding.generation !== audit.terminal.server_generation) ||
    binding.directory !== audit.paths?.workspace_root || !isAbsolute(binding.directory ?? '') ||
    !isAbsolute(binding.command ?? '') || !/^[a-f0-9]{64}$/.test(binding.password ?? '') || binding.username !== 'opencode') {
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
export function readAuditTerminal(stateRoot, id, { generation, readOnly = false, tmuxCommand = 'tmux' } = {}) {
  const { audit } = readState(stateRoot, id);
  let target;
  if (audit.terminal.shared_server) {
    const binding = readAuditConnection(stateRoot, id);
    if (generation && generation !== binding.generation) throw unavailable('任务已恢复到新执行，请从工作台重新打开终端。');
    target = { kind: 'opencode', generation: binding.generation, readOnly,
      command: binding.command, args: ['attach', binding.url, '--session', binding.session_id, '--dir', binding.directory],
      cwd: binding.directory, environment: { OPENCODE_SERVER_USERNAME: binding.username, OPENCODE_SERVER_PASSWORD: binding.password } };
  } else {
    const { socket_name: socket, target: pane = 'audit:tui' } = audit.terminal;
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,100}$/.test(socket ?? '') || !/^[A-Za-z0-9_$:.-]{1,160}$/.test(pane)) {
      throw unavailable('旧任务的终端绑定无效。');
    }
    const version = createHash('sha256').update(JSON.stringify(audit.terminal)).digest('hex');
    if (generation && generation !== version) throw unavailable('旧任务的终端绑定已改变，请重新打开。');
    target = { kind: 'tmux', generation: version, readOnly: true, command: tmuxCommand,
      args: ['-L', socket, 'attach-session', '-r', '-f', 'read-only,ignore-size', '-t', pane],
      cwd: resolve(audit.paths?.workspace_root || stateRoot), environment: { TMUX: '', TMUX_PANE: '' } };
  }
  return { ...target, auditId: id, name: audit.name || id,
    fingerprint: createHash('sha256').update(JSON.stringify({ auditId: id, ...target })).digest('hex') };
}
