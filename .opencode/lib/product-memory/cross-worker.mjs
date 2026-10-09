import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenCodeEnvironment } from '../../web/dynamic-validation-observatory/opencode-runtime-config.mjs';
import { atomicJson, check, hash, parse } from './contract.mjs';
import { controlledBytes } from '../task-board/contract.mjs';
const guardian = fileURLToPath(new URL('../task-board/worker-host.mjs', import.meta.url));
const promptPath = fileURLToPath(new URL('./cross-worker.md', import.meta.url));

export async function runCrossRepoAgent({ input, outputRoot, runner, model, signal, onLog = async () => {} }) {
  await mkdir(outputRoot, { recursive: true });
  const inputPath = join(outputRoot, 'input.json'), resultPath = join(outputRoot, 'result.json'), sessionPath = join(outputRoot, 'session.json');
  const prompt = await readFile(promptPath, 'utf8');
  const inheritedEnvironment = await buildOpenCodeEnvironment(runner.configPath, runner.environment);
  const inherited = JSON.parse(inheritedEnvironment.OPENCODE_CONFIG_CONTENT ?? '{}');
  const agent = input.role === 'ANALYZE' ? 'security-cross-repo-analyzer' : `cross-repo-${input.role.toLowerCase()}`;
  const config = { ...inherited, plugin: [], mcp: Object.fromEntries(Object.keys(inherited.mcp ?? {}).map(key => [key, { enabled: false }])),
    agent: { [agent]: { mode: 'primary', description: '产品跨 Repo 静态分析与独立复核', prompt,
      permission: { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', edit: 'allow', bash: 'allow', skill: 'allow', external_directory: 'allow', task: 'deny', question: 'deny', webfetch: 'deny', websearch: 'deny' } } } };
  await atomicJson(inputPath, { ...input, result_path: resultPath, session_path: sessionPath });
  const env = { ...inheritedEnvironment, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), AUDIT_RUNTIME_CONNECTION_PATH: '', AUDIT_TEST_ENVIRONMENT_CONTEXT_PATH: '', AUDIT_MEMORY_CONNECTION_PATH: '', AUDIT_MEMORY_MODE: input.memory_mode ?? 'full', AUDIT_QUICK_DYNAMIC_ENABLED: 'false' };
  const args = ['run', '读取附件，按 role 执行跨 Repo 静态分析或独立复核。输出 result.json 后结束。', '--format', 'json', '--agent', agent, '--dir', outputRoot, ...(model ? ['--model', model] : []), '--file', inputPath];
  const execution = await new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('跨 Repo 任务已停止。'));
    const child = (runner.spawnProcess ?? spawn)(process.execPath, [guardian, runner.command, ...args], { cwd: outputRoot, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let sessionId = null, persist = Promise.resolve(), stopping = null, failed = null;
    const stop = () => { if (stopping) return; if (child.connected) child.send({ type: 'stop' }, () => {}); child.kill('SIGTERM'); stopping = setTimeout(() => child.kill('SIGKILL'), 7000); stopping.unref?.(); };
    signal.addEventListener('abort', stop, { once: true });
    for (const [stream, source] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      let buffer = ''; stream?.setEncoding?.('utf8'); stream?.on('data', chunk => {
        buffer = (buffer + chunk).slice(-256 * 1024); const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) {
          const event = parse(line); const id = event?.sessionID ?? event?.session_id ?? event?.session?.id;
          if (!sessionId && typeof id === 'string' && id) { sessionId = id; persist = atomicJson(sessionPath, { agent_session_id: id, campaign_id: input.campaign_id, role: input.role }).catch(error => { failed = error; }); }
          onLog(source, line).catch(() => {});
        }
      });
    }
    child.once('error', error => { clearTimeout(stopping); signal.removeEventListener('abort', stop); reject(error); });
    child.once('close', async code => { clearTimeout(stopping); signal.removeEventListener('abort', stop); await persist;
      if (failed || code !== 0 || signal.aborted) reject(failed ?? new Error(`跨 Repo Agent 结束：${signal.aborted ? '已中止' : code}`)); else resolve({ sessionId }); });
  });
  check(execution.sessionId, '跨 Repo Agent 没有真实会话登记。');
  const bytes = await controlledBytes(outputRoot, 'result.json'); const result = JSON.parse(bytes.toString('utf8'));
  check(result.agent_session_id === execution.sessionId && result.campaign_id === input.campaign_id && result.input_digest === input.input_digest && result.role === input.role, '跨 Repo 结果未绑定输入或真实会话。');
  return { result, sha256: hash(bytes), path: resultPath, session_id: execution.sessionId };
}
