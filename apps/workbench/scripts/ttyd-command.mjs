import { win32 } from 'node:path';
export function ttydAttachCommand(target, { platform = process.platform,
  systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows' } = {}) {
  if (platform !== 'win32') return { command: target.command, args: target.args, cwd: target.cwd, environment: target.environment };
  const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = /\s/.test(powershell) ? `"${powershell}"` : powershell;
  // readAuditTerminal supplies the validated loopback URL and session ID.
  // --dir . uses ttyd's explicit working directory without copying its long path
  // into the Windows command line. OpenCode resolves through the user's PATH.
  const url = target.args[1], session = target.args[3];
  const args = ['-NoLogo', '-NoProfile', '-Command', `opencode attach ${url} --session ${session} --dir .`];
  return { command, args, cwd: target.cwd, environment: target.environment };
}
