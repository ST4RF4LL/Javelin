import { spawn } from 'node:child_process';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const compile = spawn(npm, ['exec', 'tsc', '--', '-p', 'tsconfig.server.json'], { stdio: 'inherit' });
compile.once('exit', code => {
  if (code) { process.exitCode = code; return; }
  const api = spawn(process.execPath, ['build/api/server/main.js'], { stdio: 'inherit' });
  const web = spawn(npm, ['run', 'dev:web'], { stdio: 'inherit' });
  let closed = false;
  const close = () => { if (closed) return; closed = true; api.kill('SIGINT'); web.kill('SIGINT'); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  api.once('exit', close); web.once('exit', close);
});
