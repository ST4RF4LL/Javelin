import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('./ttyd-attach-launch.cjs', import.meta.url));

export function ttydAttachCommand(target, { platform = process.platform, executable = process.execPath, launcherPath = launcher } = {}) {
  if (platform !== 'win32') return { command: target.command, args: target.args, cwd: target.cwd, environment: target.environment };
  // ttyd 1.7.7 joins its ConPTY command into a fixed 256-byte buffer. Keep
  // paths/session arguments out of that command and pass them via private env.
  // Start Node relative to its own installation directory, never via PATH or
  // the audited source directory (which could contain an unrelated node.exe).
  const command = `.\\${win32.basename(executable)}`;
  const args = ['-e', 'require(process.env.JAVELIN_TTYD_LAUNCHER)'];
  if (Buffer.byteLength([command, ...args].join(' '), 'utf8') >= 240) throw Object.assign(new Error('Node 可执行文件名过长，无法启动 Windows 交互终端。'), { status: 503 });
  return { command, args, cwd: win32.dirname(executable), environment: { ...target.environment,
    JAVELIN_TTYD_LAUNCHER: launcherPath,
    JAVELIN_TTYD_ATTACH: JSON.stringify({ command: target.command, args: target.args, cwd: target.cwd }),
  } };
}
