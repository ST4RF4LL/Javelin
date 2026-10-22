import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { authorize, selection, seal, redactStructured } from '../lib/runtime-testing/contract.mjs';
import { resolveEnvironment } from '../lib/runtime-testing/environment-prompt.mjs';
import { SshRuntimeExecutor } from '../lib/runtime-testing/ssh.mjs';
import { RuntimeExecutor } from '../lib/runtime-testing/executor.mjs';
import { RuntimeTestingService } from '../lib/runtime-testing/service.mjs';
import { RuntimeTestingController } from '../lib/runtime-testing/controller.mjs';
import { EnvironmentLeaseStore, environmentLeaseKey } from '../lib/runtime-testing/environment-leases.mjs';
import { AgentSlots } from '../lib/agent-slots.mjs';
import { verifyRuntimeEvidenceFiles } from '../lib/runtime-testing/evidence.mjs';
import { readRuntimeTestingActivity } from '../web/dynamic-validation-observatory/runtime-testing-activity.mjs';

// ssh2's native parser supports OpenSSH keys; use an RSA PEM fixture on every host.
const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });
const fingerprint = `SHA256:${createHash('sha256').update(ssh2.utils.parseKey(hostKey).getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
const account = 'fixture-login', password = 'fixture-private-password';
const selected = selection({ runtime_testing: { protocol: 'runtime-testing.v2', mode: 'INTEGRATED_TESTING', explicit_authorization: true,
  budget_minutes: 10, allowed_actions: ['navigate', 'normal_interaction', 'test_input'] } });
const initial = (overrides = {}) => authorize({ auditId: 'ssh-fixture', selected, enabled: true,
  context: '通过 SSH 登录指定测试主机，只操作测试程序和专用记录。', scopeDigest: 'a'.repeat(64), ...overrides });
const plan = (port = 2222, extra = {}) => ({ identities: [{ id: 'account-1', role: 'test-user', transport: 'ssh' }], sensitive_values: [],
  ssh_targets: [{ id: 'remote-1', host: '127.0.0.1', port, identity_id: 'account-1', username: account, password, ...extra }] });
const packet = grant => ({ protocol: grant.protocol, audit_id: grant.audit_id, id: 'contact-1', phase: 'CONTACT',
  authorization_digest: grant.artifact_digest, environment_revision: grant.environment_revision, identity_ids: grant.identities.map(identity => identity.id),
  budget_seconds: 20, actions: ['navigate', 'normal_interaction'], question: '授权 SSH 是否可用？', expected_behavior: '认证成功。', steps: ['认证并检查正常输出。'], counterchecks: [] });
const args = { identity_id: 'account-1', target_id: 'remote-1' };
const submission = ids => ({ execution_status: 'COMPLETED', outcome: 'NOT_OBSERVED', cleanup_status: 'NOT_REQUIRED', summary: '已检查授权 SSH 运行基线。', observations: ['实际认证和命令输出见证据。'], evidence_ids: ids, changes: [], gaps: [] });
async function temporary(t) { const root = await mkdtemp(join(tmpdir(), 'runtime-ssh-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function serverFixture(t, options = {}) {
  const clients = new Set(), calls = []; let connections = 0;
  const server = new ssh2.Server({ hostKeys: [hostKey] }, client => {
    connections++; clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => {
      if (ctx.username === account && (ctx.method === 'password' && ctx.password === password || options.publicKey && ctx.method === 'publickey')) ctx.accept(); else ctx.reject();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (acceptExec, _reject, info) => {
        calls.push(info.command); const stream = acceptExec(); stream.on('error', () => {});
        if (info.command === 'hang') return;
        if (info.command === 'large') stream.write('x'.repeat(100000));
        else if (info.command === 'split') { const bytes = Buffer.from('中文输出'); stream.write(bytes.subarray(0, 1)); stream.write(bytes.subarray(1)); }
        else stream.write(`fixture output ${password}\n`);
        stream.stderr.write('fixture diagnostic'); stream.exit(info.command === 'fail' ? 7 : 0); stream.end();
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const client of clients) client.end(); server.close(); });
  return { port: server.address().port, calls, connections: () => connections };
}
function executor(t, port, extra = {}, options = {}) {
  const auth = initial(); const prepared = resolveEnvironment(auth.public, plan(port, extra));
  const context = { ...auth.private, ...prepared.private };
  const adapter = new SshRuntimeExecutor(prepared.public, context, options);
  t.after(() => adapter.close().catch(() => {}));
  return { adapter, grant: prepared.public, context, work: packet(prepared.public) };
}

test('SSH-only 自然语言授权无需 HTTP 地址，凭据私有且旧 v1 不扩大', () => {
  const auth = initial(); assert.equal(auth.public.status, 'AUTHORIZED');
  const prepared = resolveEnvironment(auth.public, plan());
  assert.deepEqual(prepared.public.origins, []); assert.equal(prepared.public.ssh_targets[0].origin, 'ssh://127.0.0.1:2222');
  assert.equal(JSON.stringify(prepared.public).includes(password), false); assert.equal(JSON.stringify(prepared.public).includes(account), false);
  assert.ok(prepared.private.sensitive_values.includes(password));
  assert.throws(() => resolveEnvironment(initial({ selected: { ...selected, protocol: 'runtime-testing.v1' } }).public, plan()), /requires-v2/);
  for (const host of ['public.example', '10.1.1.1', '127.0.0.1', '::1']) assert.ok(resolveEnvironment(auth.public, plan(22, { host })).public.ssh_targets.length);
  for (const host of ['-oProxyCommand=evil', 'host/path', 'ssh://host', 'host\nfoo']) assert.throws(() => resolveEnvironment(auth.public, plan(22, { host })), /target-invalid/);
  assert.throws(() => resolveEnvironment(auth.public, plan(22, { password: undefined })), /authentication/);
  assert.throws(() => resolveEnvironment(auth.public, plan(22, { identity_id: 'other' })), /identity-invalid/);
});

test('Web 与 SSH 身份分别绑定；只有 SSH 不初始化 Chrome', async t => {
  const prepared = resolveEnvironment(initial().public, plan()); let browsers = 0;
  const runtime = new RuntimeExecutor(prepared.public, prepared.private, { browserFactory: () => { browsers++; throw Error('不应创建浏览器'); } });
  t.after(() => runtime.close());
  assert.deepEqual((await runtime.tools(packet(prepared.public))).map(tool => tool.name), ['ssh_connect', 'ssh_exec']); assert.equal(browsers, 0);
  await assert.rejects(runtime.call('navigate_page', { ...args, url: 'http://outside.example' }, packet(prepared.public)), /transport-identity/);
  const mixed = resolveEnvironment(initial().public, { ...plan(), target_url: 'https://test.example', origins: ['https://test.example'],
    identities: [...plan().identities, { id: 'web-1', role: 'anonymous' }] });
  const routes = [];
  const combined = new RuntimeExecutor(mixed.public, mixed.private, { browserFactory: () => ({ tools: async p => { routes.push(p.identity_ids); return []; }, close: async () => {} }) });
  await combined.tools(packet(mixed.public)); await combined.close(); assert.deepEqual(routes, [['web-1']]);
});

test('真实本地 SSH 协议认证、主机指纹、退出码及分块输出', async t => {
  const server = await serverFixture(t); const f = executor(t, server.port, { host_key_sha256: fingerprint });
  const connected = await f.adapter.call('ssh_connect', args, f.work);
  assert.equal(connected.structuredContent.ssh_connection.authenticated, true);
  assert.equal(connected.structuredContent.ssh_connection.host_key_sha256, fingerprint);
  for (const command of ['baseline', 'fail', 'split', 'large']) {
    const result = await f.adapter.call('ssh_exec', { ...args, command, action: 'normal_interaction' }, f.work);
    const row = result.structuredContent.ssh_execution;
    assert.equal(row.exit_code, command === 'fail' ? 7 : 0); assert.equal(row.status, 'COMPLETED');
    if (command === 'split') assert.equal(row.stdout, '中文输出');
    if (command === 'large') { assert.equal(row.output_truncated, true); assert.ok(Buffer.byteLength(row.stdout) <= 65536); }
    assert.equal(JSON.stringify(redactStructured(result, f.context)).includes(password), false);
  }
  assert.equal(server.connections(), 1); assert.equal(server.calls.length, 4);
});

test('SSH 拒绝错误凭据和指纹，不执行命令', async t => {
  const server = await serverFixture(t);
  const badAuth = executor(t, server.port, { password: 'wrong-fixture-value' });
  await assert.rejects(badAuth.adapter.call('ssh_connect', args, badAuth.work), /connection-failed/);
  const badKey = executor(t, server.port, { host_key_sha256: `SHA256:${'A'.repeat(43)}` });
  await assert.rejects(badKey.adapter.call('ssh_connect', args, badKey.work), /host-key-mismatch/);
  assert.deepEqual(server.calls, []);
});

test('显式私钥路径及解密口令传给 SSH；不读取其他密钥', async t => {
  const root = await temporary(t); const path = join(root, 'fixture.pem');
  const userKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1', cipher: 'aes-256-cbc', passphrase: 'fixture-passphrase' });
  await writeFile(path, userKey, { mode: 0o600 });
  const server = await serverFixture(t, { publicKey: true }); const f = executor(t, server.port, { password: undefined, private_key_path: path, passphrase: 'fixture-passphrase' });
  await f.adapter.call('ssh_connect', args, f.work); assert.equal(server.connections(), 1);
  assert.ok(f.context.sensitive_values.includes(String(userKey)));
  const missing = executor(t, server.port, { password: undefined, private_key_path: join(root, 'missing') });
  await assert.rejects(missing.adapter.call('ssh_connect', args, missing.work), /key-file-unavailable/); assert.equal(server.connections(), 1);
});

test('目标、身份、动作与超时边界在连接和命令执行前校验', async t => {
  const server = await serverFixture(t); const f = executor(t, server.port);
  await assert.rejects(f.adapter.call('ssh_connect', { ...args, target_id: 'unknown' }, f.work), /not-authorized/);
  await assert.rejects(f.adapter.call('ssh_connect', { ...args, host: 'outside.example' }, f.work), /not-authorized/);
  await assert.rejects(f.adapter.call('ssh_exec', { ...args, command: 'baseline', action: 'normal_interaction' }, f.work), /connect-required/);
  assert.equal(server.connections(), 0);
  await f.adapter.call('ssh_connect', args, f.work);
  for (const extra of [{ action: 'test_input' }, { action: 'test_mutation' }, { timeout_seconds: 41 }]) {
    await assert.rejects(f.adapter.call('ssh_exec', { ...args, command: 'baseline', action: 'normal_interaction', ...extra }, f.work));
  }
  assert.deepEqual(server.calls, []);
});

test('命令超时保留状态、禁止复用、关闭不能伪称远端已停止', async t => {
  const server = await serverFixture(t); const f = executor(t, server.port);
  await f.adapter.call('ssh_connect', args, f.work);
  const result = await f.adapter.call('ssh_exec', { ...args, command: 'hang', action: 'normal_interaction', timeout_seconds: 1 }, f.work);
  assert.equal(result.structuredContent.ssh_execution.status, 'TIMED_OUT');
  await assert.rejects(f.adapter.call('ssh_exec', { ...args, command: 'baseline', action: 'normal_interaction' }, f.work), /unavailable/);
  await assert.rejects(f.adapter.close(), /remote-state-unknown/);
});

test('关闭只取消当前连接命令，返回 CANCELLED 和未知远端状态', async t => {
  const server = await serverFixture(t); const f = executor(t, server.port);
  await f.adapter.call('ssh_connect', args, f.work);
  const pending = f.adapter.call('ssh_exec', { ...args, command: 'hang', action: 'normal_interaction' }, f.work);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.adapter.close(), /remote-state-unknown/);
  assert.equal((await pending).structuredContent.ssh_execution.status, 'CANCELLED');
});

test('SSH 环境租约按主机端口互斥，未知清理保留占用', async t => {
  const root = await temporary(t); const store = new EnvironmentLeaseStore({ stateRoot: root });
  assert.notEqual(environmentLeaseKey('ssh://one.example:22'), environmentLeaseKey('ssh://two.example:22'));
  assert.notEqual(environmentLeaseKey('ssh://one.example:22'), environmentLeaseKey('ssh://one.example:23'));
  assert.equal(environmentLeaseKey('ssh://localhost:22'), environmentLeaseKey('ssh://127.0.0.1:22'));
  const leases = await store.acquire({ origins: ['ssh://one.example:22'], auditId: 'ssh-fixture', runtimeRoot: root, owner: 'owner' });
  await store.finish(leases, { browser_allocated: false, ssh_allocated: true, cleanup_status: 'UNKNOWN' });
  const row = await store.inspect(leases[0].id); assert.equal(row.status, 'needs_review'); assert.equal(row.origin, 'ssh://one.example:22');
  await store.abandon(leases);
});

test('SSH 超时不能由 Worker 提交无需清理覆盖，恢复不复用连接', async t => {
  const root = await temporary(t); const prepared = resolveEnvironment(initial().public, plan());
  const controller = new RuntimeTestingController({ root, authorization: prepared.public, privateContext: prepared.private,
    browserFactory: async () => ({ tools: async () => [], call: async name => name === 'ssh_connect' ? { structuredContent: { ssh_connection: { ...args, origin: prepared.public.ssh_targets[0].origin, authenticated: true } } }
      : { isError: true, structuredContent: { ssh_execution: { status: 'TIMED_OUT' } } }, close: async () => {} }),
    worker: async ({ active }) => {
      const ids = [(await controller.call(active.token, 'ssh_connect', args)).evidence_id];
      ids.push((await controller.call(active.token, 'ssh_exec', args)).evidence_id);
      await assert.rejects(controller.submit(active.token, submission(ids)), /remote-state-unknown/);
      await controller.submit(active.token, { ...submission(ids), execution_status: 'BLOCKED', cleanup_status: 'UNKNOWN' });
    } });
  await controller.run(packet(prepared.public)); assert.equal(controller.state.status, 'QUARANTINED'); assert.equal(controller.state.browser_allocated, false);
  await controller.close();
  const state = JSON.parse(await readFile(join(root, 'state.json'))); state.status = 'READY'; await writeFile(join(root, 'state.json'), JSON.stringify(state));
  const recovered = new RuntimeTestingController({ root, authorization: prepared.public, privateContext: prepared.private }); await recovered.ready;
  assert.equal(recovered.state.status, 'QUARANTINED'); assert.equal(recovered.state.reason, 'PROCESS_RECOVERY_ENVIRONMENT_UNKNOWN');
});

test('工作包取消保留在途命令请求，不能把 STARTED 当成执行成功', async t => {
  const root = await temporary(t); const server = await serverFixture(t); const prepared = resolveEnvironment(initial().public, plan(server.port));
  const controller = new RuntimeTestingController({ root, authorization: prepared.public, privateContext: prepared.private,
    browserFactory: (grant, context) => new RuntimeExecutor(grant, context) });
  const active = await controller.start(packet(prepared.public));
  await controller.call(active.token, 'ssh_connect', args);
  const call = controller.call(active.token, 'ssh_exec', { ...args, command: 'hang', action: 'normal_interaction' });
  const rejected = assert.rejects(call, /lease-invalid/);
  for (let i = 0; i < 100 && !server.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(server.calls, ['hang']); await controller.cancel(); await rejected;
  const records = await Promise.all(controller.state.evidence.map(binding => readFile(join(root, binding.path), 'utf8').then(JSON.parse)));
  assert.ok(records.some(row => row.structured_content.status === 'STARTED' && row.structured_content.arguments.command === 'hang'));
  assert.equal(controller.state.cleanup_status, 'UNKNOWN'); assert.equal(controller.state.status, 'QUARANTINED');
  await verifyRuntimeEvidenceFiles(join(root, 'evidence-set.json'));
});

for (const reportMode of [false, true]) test(`${reportMode ? '报告定向验证' : '动态探索'} 通过 SSH 完成接触、执行和证据封存，不启动 Chrome`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-ssh-')); const server = await serverFixture(t); const reports = join(root, 'reports'); const auth = initial({ selected: { ...selected, mode: reportMode ? 'TARGETED_CONFIRMATION' : 'INTEGRATED_TESTING' } }); const phases = []; let planned = 0;
  const sourceReport = reportMode ? seal({ protocol: 'report-validation.v1', source: { report_id: 'source-report', audit_id: 'original', repository_id: 'fixture', report_path: 'final/report.md', report_sha256: 'b'.repeat(64), model_sha256: 'c'.repeat(64), scope_digest: 'a'.repeat(64), finding_count: 1 },
    findings: [{ finding_id: 'f-one', vulnerability_type_id: 'JW-ACCESS-01', title: '权限边界测试', description: '测试夹具候选' }] }) : undefined;
  const service = new RuntimeTestingService({ root: join(reports, 'runtime-testing', 'ssh-fixture'), privateRoot: join(root, 'private', 'runtime'),
    authorization: auth.public, privateContext: auth.private, sourceReport, agentSlots: new AgentSlots(2),
    browserFactory: () => assert.fail('SSH-only 不应创建浏览器'),
    planner: async context => {
      planned++; assert.equal(context.capabilities.remote_shell, true); assert.equal(context.capabilities.browser, false);
      assert.equal(context.scopes[0].transport, 'ssh');
      return { complete: true, summary: '测试夹具完成，未请求额外探测。', intents: [], gaps: [] };
    },
    worker: async ({ controller, active }) => {
      phases.push(active.packet.phase);
      if (active.packet.phase === 'CONTACT') await controller.configureEnvironment(active.token, plan(server.port));
      const ids = [];
      ids.push((await controller.call(active.token, 'ssh_connect', args)).evidence_id);
      ids.push((await controller.call(active.token, 'ssh_exec', { ...args, command: 'baseline', action: 'normal_interaction' })).evidence_id);
      await controller.submit(active.token, submission(ids));
    } });
  t.after(async () => { await service.shutdown(); await rm(root, { recursive: true, force: true }); }); await service.start(); await service.contact();
  for (let i = 0; i < 40; i++) {
    await service.draining; await service.exploration.running; await new Promise(resolve => setImmediate(resolve));
    if (service.exploration.state.status === 'COMPLETED') break;
  }
  assert.equal(service.exploration.state.status, 'COMPLETED'); assert.deepEqual(phases, reportMode ? ['CONTACT', 'CONFIRM'] : ['CONTACT']);
  assert.equal(planned, reportMode ? 0 : 1); assert.equal(service.controller.state.browser_allocated, false); assert.equal(service.controller.state.ssh_allocated, true);
  await service.close(); const evidence = await verifyRuntimeEvidenceFiles(join(service.root, 'evidence-set.json')); assert.equal(evidence.packets.length, phases.length);
  const activity = await readRuntimeTestingActivity({ reportsRoot: reports, repositoryId: 'fixture', audit: { id: 'ssh-fixture' } });
  assert.equal(activity.exchanges.length, 0); assert.ok(activity.cases.some(row => row.actions.some(action => action.transport === 'ssh')));
  assert.equal(JSON.stringify(activity).includes(password), false);
  assert.equal(service.leases.length, 0);
});

test('没有显式授权或空环境时 SSH、Chrome 和 Worker 均零启动', async t => {
  for (const options of [{ enabled: false }, { context: '' }]) {
    const root = await temporary(t); const auth = initial(options);
    const service = new RuntimeTestingService({ root: join(root, 'runtime'), privateRoot: join(root, 'private', 'runtime'), authorization: auth.public, privateContext: auth.private,
      worker: () => assert.fail('不应启动 Worker'), sshFactory: () => assert.fail('不应连接 SSH'), browserFactory: () => assert.fail('不应启动 Chrome') });
    await service.start(); assert.equal(service.controller.state.status, 'SKIPPED'); await service.shutdown();
  }
});
