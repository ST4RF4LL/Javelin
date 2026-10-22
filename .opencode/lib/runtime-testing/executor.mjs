import { ChromeRuntimeBrowser } from './browser.mjs';
import { SshRuntimeExecutor } from './ssh.mjs';
import { check } from './contract.mjs';

export class RuntimeExecutor {
  constructor(authorization, privateContext, { browserFactory = grant => new ChromeRuntimeBrowser(grant), sshFactory = (grant, context) => new SshRuntimeExecutor(grant, context) } = {}) {
    this.authorization = authorization; this.privateContext = privateContext; this.browserFactory = browserFactory; this.sshFactory = sshFactory;
    this.adapters = new Map(); this.closed = false;
  }
  packetFor(packet, transport) {
    return { ...packet, identity_ids: packet.identity_ids.filter(id => this.authorization.identities.some(identity => identity.id === id && (identity.transport ?? 'web') === transport)) };
  }
  async adapter(transport) {
    check(!this.closed, 'runtime-executor-closed');
    if (!this.adapters.has(transport)) this.adapters.set(transport, Promise.resolve().then(() => {
      check(!this.closed, 'runtime-executor-closed');
      const grant = { ...this.authorization, identities: this.authorization.identities.filter(identity => (identity.transport ?? 'web') === transport) };
      return transport === 'ssh' ? this.sshFactory(grant, this.privateContext) : this.browserFactory(grant, this.privateContext);
    }));
    return this.adapters.get(transport);
  }
  async tools(packet) {
    const result = [];
    for (const transport of ['ssh', 'web']) {
      const scoped = this.packetFor(packet, transport);
      if (scoped.identity_ids.length) result.push(...await (await this.adapter(transport)).tools(scoped));
    }
    return result;
  }
  async call(name, args, packet) {
    const transport = name.startsWith('ssh_') ? 'ssh' : 'web';
    const scoped = this.packetFor(packet, transport);
    check(scoped.identity_ids.includes(args.identity_id), 'runtime-transport-identity-not-authorized');
    return (await this.adapter(transport)).call(name, args, scoped);
  }
  async close() {
    this.closed = true;
    const results = await Promise.allSettled([...this.adapters.values()].map(async promise => (await promise).close()));
    const failure = results.find(result => result.status === 'rejected'); if (failure) throw failure.reason;
  }
}
