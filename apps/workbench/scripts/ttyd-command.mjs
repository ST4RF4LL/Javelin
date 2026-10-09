import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('./ttyd-attach-launch.cjs', import.meta.url));

export function ttydAttachCommand(target, { platform = process.platform, executable = process.execPath, launcherPath = launcher,
  systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows' } = {}) {
  if (platform !== 'win32') return { command: target.command, args: target.args, cwd: target.cwd, environment: target.environment };
  // ttyd 1.7.7 joins its ConPTY command into a fixed 256-byte buffer. Keep
  // paths/session arguments out of that command and pass them via private env.
  // Windows PowerShell establishes the console before launching the attached
  // client. Use trusted absolute executables, never PATH or project-local ones.
  if (!win32.isAbsolute(systemRoot) || /["\r\n]/.test(systemRoot)) throw Object.assign(new Error('Windows 系统目录无效，无法启动 PowerShell 交互终端。'), { status: 503 });
  const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // ttyd joins argv without quoting. Preserve a SystemRoot containing spaces.
  const command = /\s/.test(powershell) ? `"${powershell}"` : powershell;
  // No -NoExit: an ended/failed client must not leave an arbitrary Shell open.
  const args = ['-NoLogo', '-NoProfile', '-Command',
    "$ErrorActionPreference='Stop';& $env:JAVELIN_TTYD_NODE -e 'require(process.env.JAVELIN_TTYD_LAUNCHER)';exit $LASTEXITCODE"];
  if (Buffer.byteLength([command, ...args].join(' '), 'utf8') >= 240) throw Object.assign(new Error('Windows PowerShell 路径过长，无法启动交互终端。'), { status: 503 });
  return { command, args, cwd: target.cwd, environment: { ...target.environment,
    JAVELIN_TTYD_NODE: executable,
    JAVELIN_TTYD_LAUNCHER: launcherPath,
    JAVELIN_TTYD_ATTACH: JSON.stringify({ command: target.command, args: target.args, cwd: target.cwd }),
  } };
}
