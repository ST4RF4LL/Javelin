import { engineId } from '../contract.mjs';

export const auditEngine = audit => audit?.execution?.engine ?? 'opencode';
export function normalizeEngineModel(value, engine = 'opencode') {
  if (value == null || value === '' || value === 'default') return null;
  if (typeof value !== 'string' || value.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value)) {
    throw Object.assign(new Error('模型标识无效。'), { statusCode: 422, code: 'agent-model-invalid' });
  }
  if (engine !== 'grow' && !value.includes('/')) throw Object.assign(new Error('模型须使用 provider/model 标识。'), { statusCode: 422, code: 'agent-model-invalid' });
  return value;
}

// The task, worker, receipt and report contracts are independent of the CLI.
export async function prepareAgentLaunch(options) {
  const engine = engineId(options.engine ?? 'opencode');
  if (engine === 'grow') return (await import('./grow.mjs')).prepareLaunch(options);
  if (engine === 'opencode-v2') return (await import('./opencode-v2.mjs')).prepareLaunch(options);
  if (engine !== 'opencode') throw Object.assign(new Error('此 Agent 尚不支持平台托管进程。'), { code: 'agent-launch-unavailable' });
  const { command = 'opencode', environment, role, prompt, files = [], model, sessionId, cwd, title } = options;
  return { command, environment, sessionId,
    args: ['run', prompt, '--format', 'json', '--agent', role, '--dir', cwd,
      ...(sessionId ? ['--session', sessionId] : []), ...(model ? ['--model', model] : []),
      ...(title ? ['--title', title] : []), ...(files.length ? ['--file', ...files] : [])] };
}

export function normalizeAgentLine(line, launch) {
  if (!launch?.eventTransform) return line;
  try {
    const event = launch.eventTransform(JSON.parse(line));
    if (event == null) return null;
    return typeof event === 'string' ? event : JSON.stringify(event);
  } catch { return line; }
}
