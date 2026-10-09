import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { startSharedRun } from './opencode-shared-run.mjs';

const spec = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!isAbsolute(spec.state_directory ?? '') || !isAbsolute(spec.cwd ?? '') || !isAbsolute(spec.diagnostic_path ?? '') || !isAbsolute(spec.exit_path ?? '') || !Array.isArray(spec.args)) throw new Error('审计执行配置无效。');
const log = createWriteStream(spec.diagnostic_path, { flags: 'w', mode: 0o600 });
log.on('error', () => {});
let result;
try {
  result = await startSharedRun({ ...spec, controllable: true }, { environment: process.env,
    output(chunk) { process.stdout.write(chunk); log.write(chunk); } });
} catch (error) {
  const message = `OpenCode 共享会话执行失败：${error.message}`;
  process.stderr.write(`${message}\n`); log.write(`${message}\n`); result = { code: 1, error: message };
}
await writeFile(spec.exit_path, JSON.stringify(result), { mode: 0o600 });
await new Promise(resolve => log.end(resolve));
process.exit(Number.isInteger(result.code) ? result.code : 1);
