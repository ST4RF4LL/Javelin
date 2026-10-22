import { isIP } from 'node:net';
import { check, text, ID } from './contract.mjs';

export function sshOrigin(host, port = 22) {
  check(typeof host === 'string' && host.length <= 253 && (isIP(host) || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))
    && Number.isInteger(port) && port >= 1 && port <= 65535, 'runtime-ssh-target-invalid');
  return `ssh://${isIP(host) === 6 ? `[${host}]` : host.toLowerCase()}:${port}`;
}

export const sshTargetSchema = { type: 'object', additionalProperties: false, properties: {
  id: { type: 'string' }, host: { type: 'string', description: '用户明确授权的 SSH 主机，不含协议、用户名或路径。' }, port: { type: 'integer', minimum: 1, maximum: 65535 },
  identity_id: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' },
  private_key: { type: 'string', description: '用户提供的私钥正文，仅私有保存。' },
  private_key_path: { type: 'string', description: '用户明确提供的本机私钥绝对路径；不得搜索其他凭据。' }, passphrase: { type: 'string' },
  host_key_sha256: { type: 'string', description: '可选，用户提供的 SHA256:base64 主机指纹；未提供时记录并固定首次连接指纹。' },
}, required: ['id', 'host', 'identity_id', 'username'] };

export function resolveSshTargets(targets, identities) {
  check(Array.isArray(targets) && targets.length <= 8, 'runtime-ssh-targets-invalid');
  const secrets = [];
  const prepared = targets.map(target => {
    check(target && Object.keys(target).every(key => Object.hasOwn(sshTargetSchema.properties, key)) && ID.test(target.id ?? '')
      && identities.some(identity => identity.id === target.identity_id && identity.role === 'test-user' && identity.transport === 'ssh')
      && text(target.username) && target.username.length <= 256 && !/[\x00-\x1f\x7f]/.test(target.username), 'runtime-ssh-identity-invalid');
    const origin = sshOrigin(target.host, target.port ?? 22);
    check(['password', 'private_key', 'private_key_path'].filter(key => text(target[key])).length === 1, 'runtime-ssh-authentication-required');
    check(['password', 'private_key', 'private_key_path', 'passphrase', 'host_key_sha256'].every(key => target[key] == null || text(target[key])), 'runtime-ssh-authentication-invalid');
    check(!target.host_key_sha256 || /^SHA256:[A-Za-z0-9+/]{43}=?$/.test(target.host_key_sha256), 'runtime-ssh-host-key-invalid');
    secrets.push(...['username', 'password', 'private_key', 'private_key_path', 'passphrase'].map(key => target[key]).filter(text));
    return { public: { id: target.id, host: target.host.toLowerCase(), port: target.port ?? 22, identity_id: target.identity_id, origin },
      private: { ...target, port: target.port ?? 22 } };
  });
  check(new Set(prepared.map(target => target.public.id)).size === prepared.length, 'runtime-ssh-targets-invalid');
  check(identities.filter(identity => identity.transport === 'ssh').every(identity => prepared.some(target => target.public.identity_id === identity.id)), 'runtime-ssh-identity-target-required');
  check(prepared.every(target => !secrets.includes(target.public.id)), 'runtime-ssh-id-must-not-contain-credentials');
  return { targets: prepared.map(target => target.public), privateTargets: prepared.map(target => target.private), secrets };
}

export const environmentOrigins = grant => [...(grant.origins ?? []), ...(grant.ssh_targets ?? []).map(target => target.origin)];
export const environmentAllocated = state => Boolean(state?.browser_allocated || state?.ssh_allocated);

export const environmentUntouched = state => state?.browser_allocated === false && state?.ssh_allocated !== true;
