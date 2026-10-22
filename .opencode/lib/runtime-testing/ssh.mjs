import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { constants } from 'node:fs';
import { check, fail, text } from './contract.mjs';

const OUTPUT_LIMIT = 64 * 1024;
const toolProperties = { identity_id: { type: 'string' }, target_id: { type: 'string' } };
const tools = [
  { name: 'ssh_connect', description: '登录已登记的 SSH 目标，记录认证成功和主机指纹；不运行命令。', inputSchema: {
    type: 'object', additionalProperties: false, properties: toolProperties, required: ['identity_id', 'target_id'],
  } },
  { name: 'ssh_exec', description: '在已连接的授权 SSH 目标执行当前工作包范围内的命令。禁止横向访问、读取无关数据和后台持久化。每次独立执行，不保留工作目录；需在命令中明确授权目录。', inputSchema: {
    type: 'object', additionalProperties: false, properties: { ...toolProperties, command: { type: 'string', maxLength: 16000 },
      action: { enum: ['normal_interaction', 'test_input', 'test_mutation'] }, timeout_seconds: { type: 'integer', minimum: 1, maximum: 40 } },
    required: ['identity_id', 'target_id', 'command', 'action'],
  } },
];

// Commands run through SSH channels on the registered target, never a local shell.
export class SshRuntimeExecutor {
  constructor(authorization, privateContext, { clientFactory, readKey = readPrivateKey } = {}) {
    this.authorization = authorization; this.privateContext = privateContext; this.clientFactory = clientFactory; this.readKey = readKey;
    this.connections = new Map(); this.clients = new Set(); this.channels = new Set(); this.pending = new Set(); this.closed = false; this.uncertain = false;
  }
  async tools(packet) {
    return tools.filter(tool => tool.name === 'ssh_connect' ? packet.actions.includes('navigate')
      : packet.actions.some(action => ['normal_interaction', 'test_input', 'test_mutation'].includes(action))).map(tool => ({ ...tool, inputSchema: {
      ...tool.inputSchema, properties: { ...tool.inputSchema.properties,
        identity_id: { type: 'string', enum: packet.identity_ids.filter(id => this.authorization.identities.some(identity => identity.id === id && identity.transport === 'ssh')) },
        target_id: { type: 'string', enum: this.authorization.ssh_targets.filter(target => packet.identity_ids.includes(target.identity_id)).map(target => target.id) } },
    } }));
  }
  async call(name, args, packet) {
    check(!this.closed && !this.uncertain, 'runtime-ssh-unavailable');
    const tool = (await this.tools(packet)).find(tool => tool.name === name);
    check(!this.closed && !this.uncertain, "runtime-ssh-unavailable");
    check(tool && args && Object.keys(args).every(key => Object.hasOwn(tool.inputSchema.properties, key)) && packet.identity_ids.includes(args.identity_id), 'runtime-ssh-tool-not-authorized');
    const target = this.authorization.ssh_targets.find(target => target.id === args.target_id && target.identity_id === args.identity_id);
    check(target, 'runtime-ssh-target-not-authorized');
    if (name === 'ssh_connect') return this.connect(target);
    check(text(args.command) && args.command.length <= 16000 && !args.command.includes('\0')
      && ['normal_interaction', 'test_input', 'test_mutation'].includes(args.action) && packet.actions.includes(args.action), 'runtime-ssh-command-not-authorized');
    if (args.action === 'test_mutation') check(text(packet.cleanup_plan) && packet.test_data_scope === this.authorization.test_data_scope && text(packet.test_data_scope), 'mutation-cleanup-required');
    const seconds = args.timeout_seconds ?? 30;
    check(Number.isInteger(seconds) && seconds >= 1 && seconds <= 40, 'runtime-ssh-timeout-invalid');
    const connection = this.connections.get(target.id);
    check(connection && !connection.disconnected, 'runtime-ssh-connect-required');
    return this.execute(target, connection, args, seconds);
  }
  async connect(target) {
    const existing = this.connections.get(target.id);
    if (existing && !existing.disconnected) return this.connectionResult(target, existing);
    const credentials = this.privateContext.ssh_targets?.find(value => value.id === target.id);
    check(credentials && credentials.host.toLowerCase() === target.host && credentials.port === target.port
      && credentials.identity_id === target.identity_id, 'runtime-ssh-private-binding-invalid');
    let privateKey = credentials.private_key;
    if (credentials.private_key_path) privateKey = await this.readKey(credentials.private_key_path);
    if (privateKey) this.privateContext.sensitive_values = [...new Set([...(this.privateContext.sensitive_values ?? []), String(privateKey)])];
    check(!this.closed, 'runtime-ssh-unavailable');
    const client = this.clientFactory ? await this.clientFactory() : new (await import('ssh2')).default.Client();
    if (this.closed) { client.destroy(); throw fail('runtime-ssh-unavailable'); }
    this.clients.add(client);
    const connection = { client, fingerprint: null, disconnected: false };
    const pinned = credentials.host_key_sha256?.replace(/=+$/, '') ?? existing?.fingerprint;
    await new Promise((resolve, reject) => {
      let finished = false; let timer; let mismatch = false;
      const finish = error => {
        if (finished) return; finished = true; clearTimeout(timer); this.pending.delete(cancel);
        if (error) { reject(error); client.destroy(); } else resolve();
      };
      const cancel = () => finish(fail('runtime-ssh-cancelled'));
      this.pending.add(cancel);
      client.once('ready', () => finish());
      client.on('error', () => finish(fail(mismatch ? 'runtime-ssh-host-key-mismatch' : 'runtime-ssh-connection-failed')));
      client.once('close', () => { connection.disconnected = true; this.clients.delete(client); finish(fail('runtime-ssh-connection-closed')); });
      timer = setTimeout(() => finish(fail('runtime-ssh-connect-timed-out')), 20_000);
      try { client.connect({ host: target.host, port: target.port, username: credentials.username,
        ...(privateKey ? { privateKey, passphrase: credentials.passphrase } : { password: credentials.password }),
        readyTimeout: 18_000, keepaliveInterval: 10_000, keepaliveCountMax: 2,
        agentForward: false, tryKeyboard: false,
        hostVerifier: key => {
          connection.fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
          mismatch = Boolean(pinned && pinned !== connection.fingerprint); return !mismatch;
        },
      }); } catch { finish(fail('runtime-ssh-connection-failed')); }
    });
    check(!this.closed, 'runtime-ssh-unavailable');
    this.connections.set(target.id, connection);
    return this.connectionResult(target, connection);
  }
  connectionResult(target, connection) {
    return { structuredContent: { ssh_connection: { target_id: target.id, identity_id: target.identity_id, origin: target.origin,
      authenticated: true, host_key_sha256: connection.fingerprint } } };
  }
  async execute(target, connection, args, seconds) {
    return new Promise(resolve => {
      let channel; let finished = false; let timer; let bytes = 0; const stdout = []; const stderr = []; let truncated = false;
      const append = (list, value) => {
        const chunk = Buffer.from(value); const available = Math.max(0, OUTPUT_LIMIT - bytes);
        if (chunk.length > available) truncated = true;
        if (available) list.push(chunk.subarray(0, available)); bytes += Math.min(chunk.length, available);
      };
      const finish = (status, exitCode = null, signal = null) => {
        if (finished) return; finished = true; clearTimeout(timer); this.pending.delete(cancel); this.channels.delete(channel);
        connection.client.removeListener('close', disconnected);
        if (['TIMED_OUT', 'CANCELLED', 'DISCONNECTED', 'FAILED'].includes(status)) this.uncertain = true;
        resolve({ isError: status !== 'COMPLETED' || exitCode !== 0, structuredContent: { ssh_execution: {
          target_id: target.id, identity_id: target.identity_id, origin: target.origin, command: args.command, action: args.action,
          status, exit_code: exitCode, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
          output_truncated: truncated, timeout_seconds: seconds,
        } } });
      };
      const stop = () => { try { channel?.signal('TERM'); channel?.close(); } catch { /* Only this command channel is closed. */ } };
      const cancel = () => { finish('CANCELLED'); stop(); };
      const disconnected = () => finish('DISCONNECTED');
      this.pending.add(cancel); connection.client.once('close', disconnected);
      timer = setTimeout(() => { finish('TIMED_OUT'); stop(); connection.client.destroy(); }, seconds * 1000);
      try { connection.client.exec(args.command, { pty: false }, (error, stream) => {
        if (finished) { try { stream?.signal('TERM'); stream?.close(); } catch {} return; }
        if (error) { finish('REJECTED'); return; }
        channel = stream; this.channels.add(channel);
        channel.on('data', data => append(stdout, data)); channel.stderr.on('data', data => append(stderr, data));
        channel.on('error', () => { finish('FAILED'); stop(); });
        channel.once('close', (code, signal) => finish(Number.isInteger(code) || signal ? 'COMPLETED' : 'DISCONNECTED', code ?? null, signal ?? null));
        channel.end();
      }); } catch { finish('FAILED'); stop(); }
    });
  }
  async close() {
    this.closed = true;
    for (const cancel of [...this.pending]) cancel();
    for (const client of this.clients) client.destroy();
    this.clients.clear(); this.channels.clear();
    // Closing a channel does not prove that its remote process stopped.
    if (this.uncertain) throw fail('runtime-ssh-remote-state-unknown');
  }
}

async function readPrivateKey(path) {
  check(isAbsolute(path), 'runtime-ssh-key-path-invalid');
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await file.stat(); check(info.isFile() && info.size > 0 && info.size <= 128 * 1024, 'runtime-ssh-key-file-invalid');
    return await file.readFile('utf8');
  } catch { throw fail('runtime-ssh-key-file-unavailable'); } finally { await file?.close(); }
}
