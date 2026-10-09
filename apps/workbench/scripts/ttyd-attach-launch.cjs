const { spawn } = require('node:child_process');

// Runs inside ttyd's ConPTY. Do not detach or hide the child here: the native
// OpenCode TUI must inherit this console. Only ttyd's outer process is hidden.
function launchAttach(environment = process.env, spawnProcess = spawn) {
  const { command, args, cwd } = JSON.parse(environment.JAVELIN_TTYD_ATTACH);
  const env = { ...environment };
  delete env.JAVELIN_TTYD_ATTACH;
  delete env.JAVELIN_TTYD_LAUNCHER;
  delete env.JAVELIN_TTYD_NODE;
  return spawnProcess(command, args, { cwd, env, stdio: 'inherit', shell: false, windowsHide: false });
}

module.exports = { launchAttach };
if (require.main === module || process.env.JAVELIN_TTYD_LAUNCHER === __filename) {
  try {
    const child = launchAttach();
    child.once('error', () => { console.error('OpenCode 交互客户端启动失败，请检查 OpenCode 安装。'); process.exitCode = 1; });
    child.once('exit', code => { process.exitCode = code ?? 1; });
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
  } catch {
    console.error('交互终端启动参数不可用，请从工作台重新打开。'); process.exitCode = 1;
  }
}
