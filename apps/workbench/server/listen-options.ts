import { isIP } from 'node:net';

export function listenOptions(argv: string[], environment = process.env, { defaultPort = 4181, allowLegacy = false } = {}) {
  let host = environment.WORKBENCH_HOST || '127.0.0.1';
  let portText = environment.WORKBENCH_PORT || String(defaultPort);
  let legacy = false, help = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg === '--legacy' && allowLegacy) { legacy = true; continue; }
    const [key, ...inline] = arg.split('=');
    if (!['--host', '--port'].includes(key)) throw new Error(`未知启动参数：${arg}，使用 --help 查看用法。`);
    const value = inline.length ? inline.join('=') : argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${key} 需要指定值。`);
    if (key === '--host') host = value; else portText = value;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host !== 'localhost' && !isIP(host)) throw new Error('--host / WORKBENCH_HOST 必须是 IPv4、IPv6 地址或 localhost。');
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535 || [4173, 4183].includes(port)) {
    throw new Error('--port / WORKBENCH_PORT 需要是有效端口，且不能占用原界面的 4173 或审计 API 的 4183。');
  }
  return { host, port, legacy, help };
}

export const listenHelp = '参数：--host <IP>（默认 127.0.0.1）、--port <端口>（平台默认 4181，预览默认 4180）；也支持 WORKBENCH_HOST、WORKBENCH_PORT，命令行优先。';
export function listenOrigin(host: string, port: number) {
  return `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

// UI links follow the address used by the browser, including IPv6 literals.
export function interfaceOrigin(host: string, port: number) {
  const url = new URL(`http://${host}`);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('工作台访问地址无效。');
  url.port = String(port);
  return url.origin;
}
