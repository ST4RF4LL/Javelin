#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import http from "node:http";
import { PassThrough, Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PROTOCOL, authorize, selection, seal, digest, validatePacket, validateSubmission, redact } from "../lib/runtime-testing/contract.mjs";
import { resolveEnvironment, workerInput, environmentTools } from "../lib/runtime-testing/environment-prompt.mjs";
import { RuntimeTestingController } from "../lib/runtime-testing/controller.mjs";
import { RuntimeTestingService } from "../lib/runtime-testing/service.mjs";
import { ChromeRuntimeBrowser, authorizedConnectTarget, targetLookup, createOriginProxy } from "../lib/runtime-testing/browser.mjs";
import { verifyRuntimeEvidenceFiles, runtimeCandidates } from "../lib/runtime-testing/evidence.mjs";
import { runtimeStageRegistry } from "../lib/runtime-testing/stage-registry.mjs";
import { reportArtifactPath } from "../lib/runtime-testing/paths.mjs";
import { verifyIntegratedFinalReport } from "../lib/runtime-testing/final-verification.mjs";
import { finalReportModelDigest } from "../skills/common-subagent/audit-coverage-accounting/scripts/final-report-model-core.mjs";
import { validateStageContractRegistry } from "../skills/common-subagent/audit-artifact-management/scripts/stage-agent-contract.mjs";
import { validateStageDeliveryRegistry } from "../skills/common-subagent/audit-artifact-management/scripts/stage-delivery-contract.mjs";
import { validateTruthValidationBundle, validateStaticRoleReview, validateTruthValidationIntake } from "../skills/vulnerability-validator-subagent/vulnerability-validation/scripts/truth-validation-contract.mjs";

const SHA = "a".repeat(64);
const selected = selection({ runtime_testing: { protocol: PROTOCOL, mode: "INTEGRATED_TESTING", budget_minutes: 60, explicit_authorization: true, identity_mode: "anonymous", allowed_actions: ["navigate", "normal_interaction", "test_input"] } });
function promptGrant(overrides = {}) { return authorize({ auditId: "audit-runtime-test", selected, enabled: true, context: JSON.stringify({ url: "http://127.0.0.1:8080", revision: "fixture-1" }), scopeDigest: SHA, ...overrides }); }
// Existing controller/evidence regressions use an already interpreted fixture.
// Only this fixture adapter reads its own JSON; production consumes raw prompts.
function grant(overrides = {}) {
  const initial = promptGrant(overrides);
  if (initial.public.status === "SKIPPED") return initial;
  const fixture = JSON.parse(overrides.context ?? JSON.stringify({ url: "http://127.0.0.1:8080" }));
  const accounts = fixture.accounts ?? [];
  const plan = { target_url: fixture.url, origins: fixture.origins ?? [new URL(fixture.url).origin],
    identities: accounts.length ? accounts.map(account => ({ id: account.id, role: "test-user" })) : [{ id: "anonymous", role: "anonymous" }],
    sensitive_values: accounts.flatMap(account => [account.username, account.password]),
    ...(fixture.test_data_scope ? { test_data_scope: fixture.test_data_scope, cleanup_instructions: fixture.cleanup_instructions } : {}) };
  const prepared = resolveEnvironment(initial.public, plan);
  return { public: prepared.public, private: { ...initial.private, ...prepared.private } };
}

function packet(authorization, phase = "CONTACT", id = "contact-1", extra = {}) {
  return { protocol: PROTOCOL, audit_id: authorization.audit_id, id, phase, authorization_digest: authorization.artifact_digest,
    environment_revision: authorization.environment_revision, identity_ids: authorization.identities.map(identity => identity.id),
    budget_seconds: 600, actions: ["navigate"], question: "边界是否按预期工作？", expected_behavior: "正常输入得到预期响应。", steps: ["检查授权测试页面。"], counterchecks: ["与正常输入对照。"],
    ...(["EXPLORE", "CONFIRM"].includes(phase) ? { hypothesis_id: `hypothesis-${id}`, focus_area_id: "focus-fixture", scope_digest: SHA, vulnerability_type_id: "JW-ACCESS-01" } : {}),
    ...(phase === "CONFIRM" ? { finding_id: "finding-1", finding_object_digest: SHA } : {}), ...extra };
}
function submission(extra = {}) { return { execution_status: "COMPLETED", outcome: "NOT_OBSERVED", cleanup_status: "NOT_REQUIRED", summary: "已完成授权基线检查。", observations: ["普通请求符合预期。"], evidence_ids: [], changes: [], gaps: [], ...extra }; }
async function temporary(t) { const root = await mkdtemp(join(tmpdir(), "runtime-testing-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }
function fakeBrowser(counts) {
  return { tools: async () => [{ name: "navigate_page", inputSchema: { type: "object" } }],
    call: async (name, args) => { counts.calls++; return { content: [{ type: "text", text: `正常页面 ${args.identity_id}` }],
      ...(["navigate_page", "new_page"].includes(name) ? { structuredContent: { pages: [{ id: args.pageId ?? 1, url: args.url, selected: true }] } } : {}) }; },
    close: async () => { counts.closed++; } };
}
async function successfulWorker({ controller, active }) {
  const evidence = [];
  for (const identity_id of active.packet.identity_ids) evidence.push((await controller.call(active.token, "navigate_page", { identity_id, url: "http://127.0.0.1:8080" })).evidence_id);
  await controller.submit(active.token, submission({ evidence_ids: evidence }));
}

test("空环境及旧 opt-in 不启动控制服务、worker 或浏览器", async t => {
  assert.equal(selection({ test_environment_enabled: true }), null);
  const root = await temporary(t); let calls = 0;
  for (const [index, context] of [undefined, null, "", "   \r\n", {}].entries()) {
    const authorization = grant({ context }); assert.equal(authorization.public.status, "SKIPPED");
    const service = new RuntimeTestingService({ root: join(root, `reports-${index}`), privateRoot: join(root, `private-${index}`), authorization: authorization.public,
      browserFactory: async () => { calls++; throw new Error("不得启动浏览器"); }, worker: async () => { calls++; } });
    await service.start(); assert.equal(service.server, null); await service.contact();
    assert.equal((await service.controller.run({})).status, "SKIPPED");
    const evidence = await verifyRuntimeEvidenceFiles(join(root, `reports-${index}`, "evidence-set.json"));
    assert.equal(evidence.packets.length, 0); await service.shutdown();
  }
  assert.equal(calls, 0);
  assert.equal(grant({ selected: null }).public.reason, "DYNAMIC_NOT_AUTHORIZED");
  assert.equal(grant({ enabled: false }).public.status, "SKIPPED");
});

test("Web 服务与默认 worker 在当前主机按工具能力启动，不设操作系统门禁", async t => {
  const root = await temporary(t); const auth = grant();
  const configPath = join(root, "opencode.json"); await writeFile(configPath, "{}");
  const counts = { calls: 0, closed: 0 }; const launches = [];
  const service = new RuntimeTestingService({ root: join(root, "reports"), privateRoot: join(root, "private"),
    authorization: auth.public, privateContext: auth.private, command: "fixture-opencode", workspaceRoot: root,
    environment: { OPENCODE_CONFIG: configPath }, browserFactory: async () => fakeBrowser(counts),
    spawnProcess(command, args, options) {
      launches.push({ command, args, options });
      const child = new EventEmitter(); child.kill = () => true;
      queueMicrotask(() => successfulWorker({ controller: service.controller, active: service.controller.active })
        .then(() => child.emit("close", 0), error => child.emit("error", error)));
      return child;
    } });
  try {
    await service.start(); assert.notEqual(service.server, null);
    await service.contact(); await service.draining;
    assert.equal(launches.length, 1); assert.equal(launches[0].command, "fixture-opencode");
    assert.equal(launches[0].options.shell, false);
    assert.equal(service.controller.state.status, "READY"); assert.equal(counts.calls, 1);
    await service.shutdown();
    const evidence = await verifyRuntimeEvidenceFiles(join(root, "reports", "evidence-set.json"));
    assert.equal(evidence.packets[0].execution_status, "COMPLETED");
    assert.equal(evidence.cleanup_status, "NOT_REQUIRED"); assert.equal(evidence.stages.CLEANUP, "SKIPPED");
    assert.equal(counts.closed, 1);
  } finally { await service.shutdown(); }
});

test("默认 CONTACT worker 从同一份 JSON 读取环境原文，待登记状态不阻止注册且注册前禁止访问", async t => {
  const contexts = ["http://127.0.0.1:8080/\n", "授权测试入口 http://127.0.0.1:8080/。\n使用测试 SSO 身份进行正常登录，无固定账号字段。"];
  for (const [index, context] of contexts.entries()) {
    const root = await temporary(t); const configPath = join(root, "opencode.json");
    await writeFile(configPath, JSON.stringify({ mcp: { "unrelated-mcp": { enabled: true } } }));
    const auth = promptGrant({ context, selected: { ...selected, identity_mode: "auto" } });
    const counts = { calls: 0, closed: 0 }; let received; let inputPath; let workerDone; let workerFinished;
    const service = new RuntimeTestingService({ root: join(root, "reports"), privateRoot: join(root, "private"),
      authorization: auth.public, privateContext: auth.private, command: "fixture-opencode", workspaceRoot: root,
      environment: { OPENCODE_CONFIG: configPath }, browserFactory: async () => fakeBrowser(counts),
      spawnProcess(_command, args, options) {
        const child = new EventEmitter(); child.kill = () => true;
        workerDone = Promise.resolve().then(async () => {
          assert.equal(args[0], "run");
          assert.match(args[1], /environment\.prompt/); assert.match(args[1], /configure_environment/);
          assert.equal(args.at(-2), "--file"); inputPath = args.at(-1);
          assert.equal(args.includes(context), false); assert.equal(JSON.stringify(options.env).includes(JSON.stringify(context).slice(1, -1)), false);
          assert.equal(options.shell, false); assert.equal(options.stdio, "ignore");
          const workerConfig = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
          assert.deepEqual(workerConfig.agent["runtime-testing-worker"].permission, { "*": "deny", "runtime-browser_*": "allow" });
          assert.equal(workerConfig.mcp["unrelated-mcp"].enabled, false);
          assert.match(workerConfig.agent["runtime-testing-worker"].prompt, /environment\.prompt 是属性路径/);
          received = JSON.parse(await readFile(inputPath, "utf8"));
          assert.equal(received.environment.prompt, context); assert.deepEqual(received.packet, packet(auth.public));
          assert.equal(received.authorization.environment_ready, false); assert.deepEqual(received.authorization.origins, []);
          const controller = service.controller; const token = controller.active.token;
          assert.deepEqual((await controller.tools(token)).map(tool => tool.name), ["configure_environment"]);
          await assert.rejects(controller.call(token, "navigate_page", { identity_id: "environment", url: "http://127.0.0.1:8080/" }), { code: "runtime-environment-not-prepared" });
          assert.equal(counts.calls, 0); assert.equal(controller.state.browser_allocated, false);
          const identity = index === 0 ? { id: "anonymous", role: "anonymous" } : { id: "account-1", role: "test-user" };
          await controller.configureEnvironment(token, { target_url: "http://127.0.0.1:8080/", origins: ["http://127.0.0.1:8080"], identities: [identity], sensitive_values: [] });
          assert.equal(controller.authorization.environment_ready, true); assert.equal(counts.calls, 0);
          const result = await controller.call(token, "navigate_page", { identity_id: identity.id, url: "http://127.0.0.1:8080/" });
          await controller.submit(token, submission({ evidence_ids: [result.evidence_id] }));
        }).then(() => child.emit("close", 0), error => { child.emit("error", error); throw error; });
        // Avoid a rejection escaping while the controller settles its worker race.
        workerDone.catch(() => {});
        return child;
      } });
    const defaultWorker = service.worker.bind(service);
    service.worker = args => (workerFinished = defaultWorker(args));
    try {
      await service.controller.ready; await mkdir(service.privateRoot, { recursive: true });
      // Exercise the default worker and controller without binding a port, real
      // OpenCode process, model request, browser, or authorized test target.
      await service.controller.run(packet(auth.public)); await workerDone; await workerFinished;
      assert.equal(service.controller.state.status, "READY"); assert.equal(counts.calls, 1);
      assert.equal(service.controller.state.packets[0].execution_status, "COMPLETED");
      await assert.rejects(readFile(inputPath), { code: "ENOENT" });
    } finally { await service.shutdown(); }
    assert.equal(counts.closed, 1);
  }
});

test("Web 浏览器默认 MCP 连接路径不设主机门禁，无需 clientFactory 绕过", async t => {
  const auth = grant(); let connected = 0; let closed = 0;
  t.mock.method(Client.prototype, "connect", async () => { connected++; });
  t.mock.method(Client.prototype, "listTools", async () => ({ tools: [{ name: "navigate_page", inputSchema: { type: "object" } }] }));
  t.mock.method(Client.prototype, "callTool", async () => ({ content: [] }));
  t.mock.method(Client.prototype, "close", async () => { closed++; });
  const browser = new ChromeRuntimeBrowser(auth.public);
  try {
    assert.equal((await browser.tools(packet(auth.public)))[0].name, "navigate_page");
    await browser.call("navigate_page", { identity_id: "anonymous", url: "http://127.0.0.1:8080" }, packet(auth.public));
    assert.equal(connected, 1);
  } finally { await browser.close(); }
  assert.equal(closed, 1);
});

test("Web 跨平台执行仍保留未授权或空环境的跳过原因", async t => {
  const root = await temporary(t);
  for (const [index, overrides] of [{ enabled: false }, { context: "" }].entries()) {
    const auth = promptGrant(overrides);
    const service = new RuntimeTestingService({ root: join(root, `${index}`), privateRoot: join(root, "private", `${index}`),
      authorization: auth.public });
    try {
      await service.start();
      assert.equal(service.controller.state.status, "SKIPPED");
      assert.equal(service.controller.state.reason, auth.public.reason);
      assert.equal(service.server, null);
    } finally { await service.shutdown(); }
  }
});

test("旧版主机限制的封存结果保持原样，不自动重启已跳过的任务", async t => {
  const root = await temporary(t); const auth = grant();
  const first = new RuntimeTestingController({ root, authorization: auth.public }); await first.ready;
  first.state.status = "SKIPPED"; first.state.reason = "RUNTIME_HOST_UNSUPPORTED";
  first.state.stages = Object.fromEntries(Object.keys(first.state.stages).map(phase => [phase, "SKIPPED"]));
  const before = await first.close();
  const recovered = new RuntimeTestingService({ root, privateRoot: join(root, "private"), authorization: auth.public });
  try {
    await recovered.start();
    const evidence = await verifyRuntimeEvidenceFiles(join(root, "evidence-set.json"));
    assert.deepEqual(evidence, before);
    assert.equal(recovered.server, null);
  } finally { await recovered.shutdown(); }
});

test("环境原文原样进入私有 prompt，不用地址、账号或 JSON 格式决定准入", () => {
  const contexts = [
    "前端管理员账号密码：fixture-user/Fixture_789，环境在 test.example:8080。",
    "使用公司测试 SSO 登录，不需要单独的用户名和密码字段。",
    '{"url":"http://test.example","accounts":[', "没有约定字段格式的自然语言说明", "{}", "[]",
    "测试站点在 192.0.2.10:31943；请先理解说明，再访问目标。",
  ];
  for (const context of contexts) {
    const auth = promptGrant({ context, selected: { ...selected, identity_mode: "auto", allowed_actions: ["navigate", "test_mutation"] } });
    assert.equal(auth.public.status, "AUTHORIZED"); assert.equal(auth.public.environment_ready, false);
    assert.equal(auth.private.prompt, context); assert.deepEqual(auth.public.origins, []);
    // Match a serialized string value: "[]" / "{}" are also ordinary JSON syntax.
    assert.equal(auth.private.accounts, undefined); assert.equal(JSON.stringify(auth.public).includes(JSON.stringify(context)), false);
    const attachment = workerInput(packet(auth.public), auth.public, auth.private);
    assert.equal(attachment.environment.prompt, context);
    assert.equal(promptGrant({ context, enabled: false }).public.reason, "DYNAMIC_NOT_AUTHORIZED");
  }
  assert.notEqual(promptGrant({ context: "说明甲" }).public.context_digest, promptGrant({ context: "说明乙" }).public.context_digest);
  assert.equal(selection({ runtime_testing: { protocol: PROTOCOL, mode: "CONTACT_ONLY" } }).identity_mode, "auto");
  assert.deepEqual(environmentTools.map(tool => tool.name), ["register_sensitive_values", "configure_environment", "browser_tools", "browser_call"]);
});

function interpretedEnvironment(extra = {}) {
  return { target_url: "http://192.0.2.10:31943", origins: ["http://192.0.2.10:31943"],
    identities: [{ id: "account-1", role: "test-user" }], sensitive_values: ["fixture-user", "Fixture_789"], ...extra };
}

test("Agent 理解配置后才允许浏览器，原文和敏感值不进入公共证据", async t => {
  const root = await temporary(t); const prompt = "前端管理员账号密码：fixture-user/Fixture_789，站点在 192.0.2.10:31943。";
  const initial = promptGrant({ context: prompt, selected: { ...selected, identity_mode: "auto" } }); let browsers = 0; let persisted;
  const extraSecrets = ["x/y", 'quoted"\\fixture'];
  const counts = { calls: 0, closed: 0 };
  const controller = new RuntimeTestingController({ root, authorization: initial.public, privateContext: initial.private,
    persistEnvironment: async value => { persisted = structuredClone(value); },
    browserFactory: async () => { browsers++; return fakeBrowser(counts); },
    worker: async ({ controller, active, privateContext }) => {
      assert.equal(privateContext.prompt, prompt);
      assert.deepEqual(controller.registerSensitiveValues(active.token, extraSecrets), { registered: true });
      assert.deepEqual((await controller.tools(active.token)).map(tool => tool.name), ["configure_environment"]);
      await assert.rejects(controller.call(active.token, "navigate_page", { identity_id: "environment", url: "http://192.0.2.10:31943" }), /not-prepared/);
      assert.equal(browsers, 0);
      const resolved = await controller.configureEnvironment(active.token, interpretedEnvironment());
      assert.equal(browsers, 0); assert.equal(JSON.stringify(resolved).includes("Fixture_789"), false);
      assert.deepEqual(active.packet.identity_ids, ["account-1"]);
      assert.notEqual(active.packet.authorization_digest, initial.public.artifact_digest);
      await assert.rejects(controller.configureEnvironment(active.token, interpretedEnvironment()), /already-prepared/);
      const evidence = await controller.call(active.token, "navigate_page", { identity_id: "account-1", url: "http://192.0.2.10:31943" });
      await controller.submit(active.token, submission({ evidence_ids: [evidence.evidence_id], summary: `已完成测试身份基线：${extraSecrets.join("、")}。` }));
    } });
  await controller.run(packet(initial.public)); await controller.close();
  assert.equal(browsers, 1); assert.equal(persisted.prompt, prompt); assert.deepEqual(persisted.sensitive_values, [...extraSecrets, "fixture-user", "Fixture_789"]);
  const masked = redact({ value: extraSecrets.join("、") }, persisted);
  for (const secret of extraSecrets) assert.equal(masked.includes(JSON.stringify(secret).slice(1, -1)), false);
  const evidence = await verifyRuntimeEvidenceFiles(join(root, "evidence-set.json"));
  assert.equal(evidence.packets.length, 1); assert.equal(JSON.stringify(evidence).includes("Fixture_789"), false);
  for (const secret of extraSecrets) assert.equal(evidence.packets[0].summary.includes(secret), false);
  const authorization = JSON.parse(await readFile(join(root, "authorization.json"), "utf8"));
  assert.equal(authorization.input_authorization_digest, initial.public.artifact_digest);
  assert.equal(JSON.stringify(authorization).includes("fixture-user"), false);
});

test("Agent 判断信息确实不足时可直接说明缺口，无需浏览器或账号格式解析", async t => {
  const root = await temporary(t); const initial = promptGrant({ context: "账号说明已给出，但目标和登录入口尚不明确。" }); let browsers = 0;
  const controller = new RuntimeTestingController({ root, authorization: initial.public, privateContext: initial.private,
    browserFactory: async () => { browsers++; throw new Error("不得启动浏览器"); },
    worker: async ({ controller, active }) => controller.submit(active.token, submission({ execution_status: "SKIPPED", outcome: "INCONCLUSIVE",
      summary: "原文没有明确目标及登录入口，无法执行环境接触。", gaps: ["目标及登录入口缺失。"] })) });
  await controller.run(packet(initial.public)); await controller.close();
  assert.equal(browsers, 0); assert.equal(controller.state.stages.CONTACT, "SKIPPED");
  const evidence = await verifyRuntimeEvidenceFiles(join(root, "evidence-set.json")); assert.equal(evidence.packets[0].execution_status, "SKIPPED");
});

test("执行配置只约束目标、隔离和已授权动作，不要求用户名密码结构", () => {
  const initial = promptGrant({ context: "SSO 测试入口 https://test.example，使用已提供的登录流程。", selected: { ...selected, identity_mode: "auto" } });
  const configured = resolveEnvironment(initial.public, interpretedEnvironment({ target_url: "https://test.example", origins: ["https://test.example"], sensitive_values: [] }));
  assert.equal(configured.public.environment_ready, true); assert.equal(configured.private.prompt, undefined);
  for (const target_url of ["file:///tmp/test", "ftp://test.example", "http://user:pass@test.example", "http://host:99999"]) {
    assert.throws(() => resolveEnvironment(initial.public, interpretedEnvironment({ target_url })), /origins-invalid/);
  }
  assert.throws(() => resolveEnvironment(initial.public, interpretedEnvironment({ origins: ["http://other.example"] })), /origins-invalid/);
  assert.throws(() => resolveEnvironment(initial.public, interpretedEnvironment({ identities: [{ id: "a", role: "test-user" }, { id: "a", role: "test-user" }] })), /identities-invalid/);
  const mutation = promptGrant({ context: "可操作指定测试记录，结束后删除。", selected: { ...selected, identity_mode: "auto", allowed_actions: ["navigate", "test_mutation"] } });
  for (const details of [{}, { test_data_scope: "指定测试记录" }, { cleanup_instructions: "通过应用删除记录。" }]) {
    const contactOnly = resolveEnvironment(mutation.public, interpretedEnvironment(details)).public;
    assert.equal(contactOnly.test_data_scope, null);
    assert.doesNotThrow(() => validatePacket(packet(contactOnly), contactOnly));
    assert.throws(() => validatePacket(packet(contactOnly, "EXPLORE", "mutation", {
      actions: ["test_mutation"], test_data_scope: "指定测试记录", cleanup_plan: "通过应用删除记录。",
    }), contactOnly), /mutation-cleanup-required/);
  }
  const prepared = resolveEnvironment(mutation.public, interpretedEnvironment({ test_data_scope: "用户指定的测试记录", cleanup_instructions: "通过应用删除记录。" }));
  assert.equal(prepared.private.test_data_scope, "用户指定的测试记录");
  assert.equal(prepared.public.test_data_scope.startsWith("environment-scope:"), true);
  assert.equal(JSON.stringify(prepared.public).includes("用户指定的测试记录"), false);
});

test("服务把完整 prompt 传入 worker，登记后才取得环境租约并私有持久化", async t => {
  const root = await temporary(t); const prompt = "测试站点 192.0.2.10:31943，前端管理员账号密码：fixture-user/Fixture_789。";
  const initial = promptGrant({ context: prompt, selected: { ...selected, identity_mode: "auto" } });
  const counts = { calls: 0, closed: 0 }; let workerCalls = 0;
  const privateRoot = join(root, "state", "audit", "runtime-testing");
  const service = new RuntimeTestingService({ root: join(root, "reports"), privateRoot, authorization: initial.public, privateContext: initial.private,
    browserFactory: async () => fakeBrowser(counts), worker: async ({ controller, active, privateContext }) => {
      workerCalls++; assert.equal(privateContext.prompt, prompt); assert.equal(service.leases.length, 0);
      await controller.configureEnvironment(active.token, interpretedEnvironment());
      assert.equal(service.leases.length, 1); assert.equal(counts.calls, 0);
      const result = await controller.call(active.token, "navigate_page", { identity_id: "account-1", url: "http://192.0.2.10:31943" });
      await controller.submit(active.token, submission({ evidence_ids: [result.evidence_id] }));
    } });
  try {
    await service.start(); assert.equal(workerCalls, 0); assert.equal(service.leases.length, 0);
    await service.contact(); await service.draining;
    assert.equal(workerCalls, 1); assert.equal(service.controller.state.status, "READY");
    const privateEnvironment = JSON.parse(await readFile(join(privateRoot, "environment.json"), "utf8"));
    assert.equal(privateEnvironment.prompt, prompt); assert.equal(privateEnvironment.sensitive_values.includes("Fixture_789"), true);
    assert.equal(JSON.stringify(service.controller.snapshot()).includes("Fixture_789"), false);
  } finally { await service.shutdown(); }
  await verifyRuntimeEvidenceFiles(join(root, "reports", "evidence-set.json"));
});

test("环境登记期间取消会释放刚取得的租约，不启动浏览器或提交迟到绑定", async t => {
  const root = await temporary(t); const initial = promptGrant({ selected: { ...selected, identity_mode: "auto" } });
  let release; let entered; let released = 0; let browsers = 0;
  const gate = new Promise(resolve => { release = resolve; }); const waiting = new Promise(resolve => { entered = resolve; });
  const controller = new RuntimeTestingController({ root, authorization: initial.public, privateContext: initial.private,
    prepareEnvironment: async () => { entered(); await gate; return async () => { released++; }; },
    browserFactory: async () => { browsers++; throw new Error("不得启动浏览器"); } });
  const active = await controller.start(packet(initial.public));
  const pending = controller.configureEnvironment(active.token, interpretedEnvironment());
  const rejected = assert.rejects(pending, /lease-invalid/);
  await waiting;
  await assert.rejects(controller.tools(active.token), /preparation-in-progress/);
  await assert.rejects(controller.submit(active.token, submission({ execution_status: "SKIPPED" })), /preparation-in-progress/);
  const cancelling = controller.cancel(); release();
  await rejected; await cancelling;
  assert.equal(released, 1); assert.equal(browsers, 0);
  assert.equal(controller.authorization.artifact_digest, initial.public.artifact_digest);
  const evidence = await verifyRuntimeEvidenceFiles(join(root, "evidence-set.json")); assert.equal(evidence.packets[0].execution_status, "CANCELLED");
});

test("阶段契约按显式协议分流，旧注册表保持原摘要", async () => {
  const agentPath = new URL("../skills/common-subagent/audit-artifact-management/contracts/stage-agent-contracts.json", import.meta.url);
  const deliveryPath = new URL("../skills/common-subagent/audit-artifact-management/contracts/workbench-stage-deliveries.json", import.meta.url);
  const agents = JSON.parse(await readFile(agentPath, "utf8")); const deliveries = JSON.parse(await readFile(deliveryPath, "utf8"));
  const original = JSON.stringify([agents, deliveries]);
  assert.equal(runtimeStageRegistry(agents, ""), agents);
  const nextAgents = runtimeStageRegistry(agents, PROTOCOL); const nextDeliveries = runtimeStageRegistry(deliveries, PROTOCOL);
  assert.deepEqual(validateStageContractRegistry(nextAgents), []);
  assert.deepEqual(validateStageDeliveryRegistry(nextDeliveries, nextAgents), []);
  assert.equal(nextAgents.contracts.some(row => row.agent_name === "quick-dynamic-validator"), false);
  assert.ok(nextAgents.contracts.find(row => row.agent_name === "vulnerability-validator").output.required_artifact_types.includes("runtime-testing-evidence-set"));
  assert.equal(JSON.stringify([agents, deliveries]), original);
});

test("工作包不能扩展授权、范围或借 CONTACT 进行探索", () => {
  const authorization = grant().public;
  for (const extra of [{ actions: ["test_input"] }, { identity_ids: ["victim"] }, { environment_revision: "changed" }, { authorization_digest: SHA }]) assert.throws(() => validatePacket(packet(authorization, "CONTACT", "contact", extra), authorization));
  assert.throws(() => validatePacket(packet(authorization, "EXPLORE", "explore", { scope_digest: "b".repeat(64) }), authorization));
  assert.throws(() => validatePacket(packet(authorization, "CONFIRM", "confirm", { finding_object_digest: null }), authorization));
});

test("测试数据变更不能标为无需清理，中期 XSS 支持也必须提供应用证据", () => {
  const authorization = grant().public; const plan = packet(authorization, "EXPLORE", "explore-xss", { vulnerability_type_id: "JW-INJECT-06" });
  const result = submission({ outcome: "SUPPORTED", evidence_ids: ["action-1"] });
  assert.throws(() => validateSubmission(result, plan, new Set(["action-1"])), /xss-application-proof-required/);
  const regular = packet(authorization, "EXPLORE", "explore-regular");
  assert.throws(() => validateSubmission(submission({ changes: [{ marker: "unique-marker", resource: "授权测试记录", cleanup_status: "SUCCEEDED" }] }), regular, new Set()), /cleanup-summary-mismatch/);
  assert.throws(() => validateSubmission(submission({ changes: [{ marker: "unique-marker", resource: "授权测试记录", cleanup_status: "NOT_REQUIRED" }] }), regular, new Set()), /change-ledger-required/);
});

test("XSS 支持需要两个身份的实际工具记录，脱敏保留固定 proof.method", async t => {
  const root = await temporary(t); const auth = grant({ selected: { ...selected, identity_mode: "distinct" }, context: JSON.stringify({ url: "http://127.0.0.1:8080", accounts: [
    { id: "attacker", username: "REAL", password: "fixture-password-a" }, { id: "victim", username: "victim-test", password: "fixture-password-b" },
  ] }) });
  const counts = { calls: 0, closed: 0 };
  const controller = new RuntimeTestingController({ root, authorization: auth.public, privateContext: auth.private, browserFactory: async () => fakeBrowser(counts), worker: successfulWorker });
  try {
    await controller.run(packet(auth.public));
    const active = await controller.start(packet(auth.public, "EXPLORE", "explore-xss", { vulnerability_type_id: "JW-INJECT-06" }));
    const first = await controller.call(active.token, "navigate_page", { identity_id: "attacker", url: auth.private.target_url });
    const result = submission({ outcome: "SUPPORTED", evidence_ids: [first.evidence_id], proof: {
      method: "REAL_APPLICATION_INPUT", persisted_or_revisited: "通过真实应用输入后重访测试页面。", victim_execution: "独立授权身份观察唯一测试标记。",
    } });
    await assert.rejects(controller.submit(active.token, result), /xss-identities-not-observed/);
    const second = await controller.call(active.token, "take_snapshot", { identity_id: "victim" }); result.evidence_ids.push(second.evidence_id);
    await assert.rejects(controller.submit(active.token, result), /xss-identities-not-observed/);
    const visit = await controller.call(active.token, "navigate_page", { identity_id: "victim", url: auth.private.target_url }); result.evidence_ids.push(visit.evidence_id);
    await controller.submit(active.token, result); await controller.finish(active, active.submission); await controller.close();
    const evidence = await verifyRuntimeEvidenceFiles(join(root, "evidence-set.json"));
    assert.equal(evidence.packets[1].result.proof.method, "REAL_APPLICATION_INPUT");
  } finally { await controller.cancel(); }
});

test("CONTACT 提交被拒绝后进程正常退出，保留具体拒绝原因和原始终止原因", async t => {
  const root = await temporary(t); const auth = grant();
  const controller = new RuntimeTestingController({ root, authorization: auth.public, browserFactory: async () => ({
    tools: async () => [], close: async () => {}, call: async () => ({ content: [{ type: "text", text: "## Pages\n1: about:blank\n2: Langflow (http://127.0.0.1:8080/flows) [selected]" }] }),
  }), worker: async ({ controller, active }) => {
    const evidence = await controller.call(active.token, "new_page", { identity_id: "anonymous", url: "http://127.0.0.1:8080" });
    await assert.rejects(controller.submit(active.token, submission({ evidence_ids: [evidence.evidence_id] })), /contact-identities-not-observed/);
  } });
  try {
    const state = await controller.run(packet(auth.public));
    assert.equal(state.status, "QUARANTINED"); assert.equal(state.reason, "contact-identities-not-observed");
    assert.equal(state.baseline_packet, null); assert.equal(state.cleanup_status, "UNKNOWN");
    assert.equal(state.packets[0].last_submission_error.code, "contact-identities-not-observed");
    assert.match(state.packets[0].summary, /提交被拒绝/);
    const result = JSON.parse(await readFile(join(root, "packets/contact-1.result.json"), "utf8"));
    assert.equal(result.reason, "contact-identities-not-observed"); assert.equal(result.termination_reason, "runtime-no-submission");
  } finally { await controller.cancel(); }
});

test("CONTACT 拒绝错误页面、其他 origin 和失败导航，修正后允许提交", async t => {
  const root = await temporary(t); const auth = grant(); let response;
  const controller = new RuntimeTestingController({ root, authorization: auth.public, browserFactory: async () => ({
    tools: async () => [], close: async () => {}, call: async () => response,
  }), worker: async ({ controller, active }) => {
    for (const invalid of [
      { structuredContent: { pages: [{ id: 1, url: "http://127.0.0.1:8080", selected: true }, { id: 2, url: "about:blank" }] } },
      { structuredContent: { pages: [{ id: 2, url: "http://unlisted.invalid", selected: true }] } },
      { isError: true, structuredContent: { pages: [{ id: 2, url: "http://127.0.0.1:8080", selected: true }] } },
    ]) {
      response = invalid;
      const evidence = await controller.call(active.token, "navigate_page", { identity_id: "anonymous", pageId: 2, url: "http://127.0.0.1:8080" });
      await assert.rejects(controller.submit(active.token, submission({ evidence_ids: [evidence.evidence_id] })), /contact-identities-not-observed/);
    }
    response = { structuredContent: { pages: [{ id: 2, url: "http://127.0.0.1:8080/flows", selected: true }] } };
    const evidence = await controller.call(active.token, "navigate_page", { identity_id: "anonymous", pageId: 2, url: "http://127.0.0.1:8080" });
    await controller.submit(active.token, submission({ evidence_ids: [evidence.evidence_id] }));
  } });
  try {
    const state = await controller.run(packet(auth.public));
    assert.equal(state.status, "READY"); assert.equal(state.baseline_packet, "contact-1");
    assert.equal(state.packets[0].execution_status, "COMPLETED");
  } finally { await controller.cancel(); }
});

test("浏览器缺少结构化输出时立即明确报错，保留原文但不从标题解析访问证明", async () => {
  const auth = grant(); let response = { content: [{ type: "text", text: "## Pages\n2: Langflow (http://127.0.0.1:8080/flows) [selected]" }] };
  const browser = new ChromeRuntimeBrowser(auth.public, { clientFactory: async () => ({ listTools: async () => ({ tools: [] }),
    callTool: async () => response, close: async () => {} }) });
  try {
    for (const name of ["new_page", "navigate_page", "list_pages"]) {
      const result = await browser.call(name, { identity_id: "anonymous", url: "http://127.0.0.1:8080" }, packet(auth.public));
      assert.equal(result.isError, true); assert.equal(result.error.code, "BROWSER_STRUCTURED_OUTPUT_MISSING");
      assert.deepEqual(result.content, response.content); assert.equal(result.structuredContent, undefined);
    }
    assert.deepEqual(await browser.call("take_snapshot", { identity_id: "anonymous" }, packet(auth.public)), response);
    response = { structuredContent: { message: "Unable to navigate in the selected page: net::ERR_CONNECTION_REFUSED.", pages: [{ id: 2, url: "http://127.0.0.1:8080", selected: true }] } };
    assert.equal((await browser.call("navigate_page", { identity_id: "anonymous", pageId: 2 }, packet(auth.public))).isError, true);
  } finally { await browser.close(); }
});

test("浏览器输出协议失败且未提交时，展示浏览器错误而不是笼统的未提交", async t => {
  const root = await temporary(t); const auth = grant();
  const controller = new RuntimeTestingController({ root, authorization: auth.public, browserFactory: async () => new ChromeRuntimeBrowser(auth.public, {
    clientFactory: async () => ({ listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => {} }),
  }), worker: async ({ controller, active }) => {
    await controller.call(active.token, "new_page", { identity_id: "anonymous", url: "http://127.0.0.1:8080" });
  } });
  try {
    const state = await controller.run(packet(auth.public));
    assert.equal(state.reason, "BROWSER_STRUCTURED_OUTPUT_MISSING"); assert.match(state.packets[0].summary, /结构化页面记录/);
  } finally { await controller.cancel(); }
});

test("Web 注入的报告绝对目录与工作区 reports 别名均可解析，越界路径拒绝", async t => {
  const root = await temporary(t); const prior = process.env.AUDIT_REPORTS_ROOT;
  try {
    process.env.AUDIT_REPORTS_ROOT = join(root, "durable", "repo"); const workspace = join(root, "workspace", "audit");
    const actual = join(process.env.AUDIT_REPORTS_ROOT, "runtime-testing", "audit-one", "evidence-set.json");
    assert.deepEqual(reportArtifactPath(workspace, actual), { absolute: actual, relative: "reports/runtime-testing/audit-one/evidence-set.json" });
    assert.equal(reportArtifactPath(workspace, "reports/validation/intake.json").relative, "reports/validation/intake.json");
    assert.throws(() => reportArtifactPath(workspace, join(root, "durable", "other", "secret.json")), /路径不在/);
    assert.throws(() => reportArtifactPath(workspace, actual, "reports/validation/"), /路径不在/);
  } finally { if (prior === undefined) delete process.env.AUDIT_REPORTS_ROOT; else process.env.AUDIT_REPORTS_ROOT = prior; }
});

test("同一环境串行复用浏览器，身份基线和实际证据必须齐备", async t => {
  const root = await temporary(t); const auth = grant(); const counts = { calls: 0, closed: 0, factories: 0 };
  const controller = new RuntimeTestingController({ root, authorization: auth.public, browserFactory: async () => { counts.factories++; return fakeBrowser(counts); }, worker: successfulWorker });
  await controller.ready;
  await assert.rejects(controller.start(packet(auth.public, "EXPLORE", "premature")), /baseline/);
  const active = await controller.start(packet(auth.public));
  await assert.rejects(controller.start(packet(auth.public, "CONTACT", "duplicate")), /busy/);
  await assert.rejects(controller.submit(active.token, submission()), /evidence-required/);
  await successfulWorker({ controller, active }); await controller.finish(active, active.submission);
  await assert.rejects(controller.call(active.token, "navigate_page", { identity_id: "anonymous" }), /lease-invalid/);
  await controller.run(packet(auth.public, "EXPLORE", "explore-1"));
  assert.equal(counts.factories, 1); assert.equal(counts.calls, 2);
  await controller.close(); assert.equal(counts.closed, 1);
  const evidence = await verifyRuntimeEvidenceFiles(join(root, "evidence-set.json")); assert.equal(evidence.packets.length, 2);
  await writeFile(join(root, evidence.evidence_bindings[0].path), "{}");
  await assert.rejects(verifyRuntimeEvidenceFiles(join(root, "evidence-set.json")), /evidence-changed/);
});

test("跨审计与 loopback 别名不能并发占用同一环境", async t => {
  const root = await temporary(t); const services = [];
  try {
  for (const [index, host] of ["127.0.0.1", "localhost"].entries()) {
    const auth = grant({ auditId: `audit-lock-${index}`, context: JSON.stringify({ url: `http://${host}:8080` }) });
    const service = new RuntimeTestingService({ root: join(root, `reports-${index}`), privateRoot: join(root, "state", `audit-${index}`, "runtime-testing"), authorization: auth.public,
      worker: async () => { throw new Error("此用例不应启动 worker"); } }); services.push(service); await service.start();
  }
  assert.notEqual(services[0].server, null); assert.equal(services[1].server, null);
  assert.equal(services[1].controller.state.reason, "ENVIRONMENT_ALREADY_LEASED");
  } finally { for (const service of services) await service.shutdown(); }
});

test("不同远程主机同端口不互锁，同一授权目标仍互斥且不启动浏览器", async t => {
  const root = await temporary(t); const services = []; let browserCalls = 0;
  try {
    for (const [index, host] of ["192.0.2.10", "198.51.100.10", "localhost", "192.0.2.10"].entries()) {
      const auth = grant({ auditId: `audit-remote-lock-${index}`, context: JSON.stringify({ url: `http://${host}:8080` }) });
      const service = new RuntimeTestingService({ root: join(root, `reports-${index}`), privateRoot: join(root, "state", `audit-${index}`, "runtime-testing"), authorization: auth.public,
        browserFactory: async () => { browserCalls++; throw new Error("不得启动浏览器"); } });
      services.push(service); await service.start();
    }
    for (const service of services.slice(0, 3)) assert.notEqual(service.server, null);
    assert.equal(services[3].server, null); assert.equal(services[3].controller.state.reason, "ENVIRONMENT_ALREADY_LEASED");
    assert.equal(browserCalls, 0);
  } finally { for (const service of services) await service.shutdown(); }
});

test("服务启动通知失败会关闭 API 并释放未使用的环境租约", async t => {
  const root = await temporary(t); const auth = grant();
  const failed = new RuntimeTestingService({ root: join(root, "failed"), privateRoot: join(root, "state", "failed", "runtime-testing"),
    authorization: auth.public, onChange: async () => { throw new Error("fixture-notification-failed"); } });
  await assert.rejects(failed.start(), /fixture-notification-failed/);
  assert.equal(failed.server, null);
  const next = new RuntimeTestingService({ root: join(root, "next"), privateRoot: join(root, "state", "next", "runtime-testing"), authorization: auth.public });
  try { await next.start(); assert.notEqual(next.server, null); } finally { await next.shutdown(); }
});

test("出队后准入前关闭服务，工作包在封存前记 SKIPPED 且不会迟到改写", async t => {
  const root = await temporary(t); const auth = grant(); let release; let entered; let workers = 0;
  const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  const service = new RuntimeTestingService({ root: join(root, "reports"), privateRoot: join(root, "state", "audit", "runtime-testing"),
    authorization: auth.public, worker: async () => { workers++; } });
  await service.start();
  const admit = service.controller.start.bind(service.controller);
  service.controller.start = async value => { entered(); await gate; return admit(value); };
  try {
    await service.enqueue(packet(auth.public)); await started;
    await service.shutdown();
    const before = await readFile(join(root, "reports", "evidence-set.json"), "utf8");
    release(); await service.draining;
    const evidence = await verifyRuntimeEvidenceFiles(join(root, "reports", "evidence-set.json"));
    assert.equal(evidence.packets.length, 1); assert.equal(evidence.packets[0].execution_status, "SKIPPED");
    assert.equal(JSON.stringify(service.controller.state.packets), JSON.stringify(evidence.packets.map(({ evidence_validity, ...row }) => row)));
    assert.equal(await readFile(join(root, "reports", "evidence-set.json"), "utf8"), before); assert.equal(workers, 0);
  } finally { release(); await service.shutdown(); }
});

for (const [index, failure] of ["BLOCKED", "FAILED"].entries()) test(`${failure} 自动封存并跳过未执行队列，CLI close 可供静态收尾`, async t => {
  const root = await temporary(t); const auth = grant({ context: JSON.stringify({ url: `http://127.0.0.1:${19090 + index}` }) });
  let entered; let release; const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const reports = join(root, "reports"); const privateRoot = join(root, "state", "audit", "runtime-testing");
  const service = new RuntimeTestingService({ root: reports, privateRoot, authorization: auth.public, worker: async ({ controller, active }) => {
    entered(); await gate;
    if (failure === "FAILED") throw new Error("fixture-worker-failed");
    await controller.submit(active.token, submission({ execution_status: "BLOCKED", outcome: "INCONCLUSIVE", gaps: ["测试登录步骤不可用。"] }));
  } });
  try {
    await service.start(); await service.contact(); await started;
    await service.enqueue(packet(auth.public, "EXPLORE", "pending-explore")); release(); await service.draining;
    const evidence = await verifyRuntimeEvidenceFiles(join(reports, "evidence-set.json"));
    assert.equal(evidence.status, failure === "BLOCKED" ? "BLOCKED" : "QUARANTINED");
    assert.equal(evidence.packets.length, 2); assert.equal(evidence.packets[1].execution_status, "SKIPPED");
    assert.equal(evidence.packets[1].reason, "ENVIRONMENT_UNAVAILABLE"); assert.equal(service.controller.closed, true);
    const cli = fileURLToPath(new URL("../scripts/runtime-testing.mjs", import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [cli, "close"], { timeout: 5000, env: { ...process.env,
      AUDIT_RUNTIME_PROTOCOL: PROTOCOL, AUDIT_RUNTIME_STATE_ROOT: reports, AUDIT_RUNTIME_CONNECTION_PATH: join(privateRoot, "endpoint.json") } });
    assert.equal(JSON.parse(stdout).status, evidence.status);
  } finally { release(); await service.shutdown(); }
});

test("证据汇总不能更改工作包的 finding、阶段或实际证据归属", async t => {
  const root = await temporary(t); const auth = grant(); const counts = { calls: 0, closed: 0 };
  const controller = new RuntimeTestingController({ root, authorization: auth.public, browserFactory: async () => fakeBrowser(counts), worker: successfulWorker });
  await controller.run(packet(auth.public)); await controller.run(packet(auth.public, "CONFIRM", "confirm-1"));
  const evidence = await controller.close(); const path = join(root, "evidence-set.json");
  await verifyRuntimeEvidenceFiles(path);
  for (const [field, value] of [["finding_id", "another-finding"], ["phase", "EXPLORE"], ["scope_digest", "b".repeat(64)]]) {
    const changed = structuredClone(evidence); changed.packets[1][field] = value;
    await writeFile(path, JSON.stringify(seal(changed)));
    await assert.rejects(verifyRuntimeEvidenceFiles(path), /input-binding-invalid/);
  }
  const changed = structuredClone(evidence); changed.packets[1].evidence_ids = evidence.packets[0].evidence_ids;
  await writeFile(path, JSON.stringify(seal(changed)));
  await assert.rejects(verifyRuntimeEvidenceFiles(path), /evidence-invalid/);
});

test("受控 MCP 接受已授权远程导航，拒绝其他目标和任意脚本，各身份独立", async () => {
  const auth = grant({ selected: { ...selected, identity_mode: "distinct" }, context: JSON.stringify({ url: "http://test.example:8080", accounts: [
    { id: "attacker", username: "test-a", password: "private-a" }, { id: "victim", username: "test-v", password: "private-v" },
  ] }) });
  const created = []; const calls = []; const closed = [];
  const browser = new ChromeRuntimeBrowser(auth.public, { clientFactory: async id => {
    created.push(id); return { listTools: async () => ({ tools: [{ name: "navigate_page", inputSchema: { type: "object", properties: { url: { type: "string" } } } }, { name: "evaluate_script", inputSchema: {} }] }),
      callTool: async request => { calls.push({ id, request }); return { content: [] }; }, close: async () => closed.push(id) };
  } });
  try {
    const plan = packet(auth.public);
    await assert.rejects(browser.call("navigate_page", { identity_id: "attacker", url: "http://test.example:8081" }, plan), /origin-not-authorized/);
    await assert.rejects(browser.call("navigate_page", { identity_id: "attacker", url: "http://127.0.0.1:8081" }, plan), /origin-not-authorized/);
    await assert.rejects(browser.call("navigate_page", { identity_id: "attacker", url: "https://example.com" }, plan), /origin-not-authorized/);
    await assert.rejects(browser.call("evaluate_script", { identity_id: "attacker", function: "() => 1" }, plan), /tool-not-authorized/);
    assert.deepEqual(created, []);
    const available = await browser.tools(plan); assert.equal(available.some(tool => tool.name === "evaluate_script"), false);
    for (const id of ["attacker", "victim", "attacker"]) await browser.call("navigate_page", { identity_id: id, url: "http://test.example:8080" }, plan);
    assert.deepEqual(created, ["attacker", "victim"]); assert.equal(calls.length, 3);
  } finally { await browser.close(); }
  assert.deepEqual(closed.sort(), ["attacker", "victim"]);
});

test("HTTPS 默认端口和 IPv6 CONNECT 正确匹配，非法 authority 不接触目标", () => {
  const origins = ["https://localhost", "https://127.0.0.1:8443", "https://[::1]", "https://test.example", "https://192.0.2.10:8443", "https://[2001:db8::1]:8443"];
  assert.deepEqual(authorizedConnectTarget("localhost:443", origins), { host: "127.0.0.1", port: 443 });
  assert.deepEqual(authorizedConnectTarget("[::1]:443", origins), { host: "::1", port: 443 });
  assert.deepEqual(authorizedConnectTarget("127.0.0.1:8443", origins), { host: "127.0.0.1", port: 8443 });
  assert.deepEqual(authorizedConnectTarget("test.example:443", origins), { host: "test.example", port: 443 });
  assert.deepEqual(authorizedConnectTarget("192.0.2.10:8443", origins), { host: "192.0.2.10", port: 8443 });
  assert.deepEqual(authorizedConnectTarget("[2001:db8::1]:8443", origins), { host: "2001:db8::1", port: 8443 });
  for (const authority of ["localhost:444", "localhost:443/path", "localhost:443#fragment", "user@localhost:443", "example.com:443", "localhost", "127.1:443"]) assert.equal(authorizedConnectTarget(authority, origins), null);
});

test("只有 localhost 固定到本机，远程 IP 保持实际地址且不发 DNS 请求", async () => {
  targetLookup("localhost", { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: "127.0.0.1", family: 4 }]); });
  targetLookup("localhost", {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, "127.0.0.1"); assert.equal(family, 4); });
  await new Promise((resolve, reject) => targetLookup("192.0.2.10", { all: true }, (error, addresses) => {
    if (error) return reject(error);
    try { assert.deepEqual(addresses, [{ address: "192.0.2.10", family: 4 }]); resolve(); } catch (failure) { reject(failure); }
  }));
});

test("HTTP 代理能访问本用例的授权伪服务，其他 origin 被拒绝", async () => {
  let received = 0;
  const target = http.createServer((_request, response) => { received++; response.end("fixture-response"); });
  await new Promise((resolve, reject) => { target.once("error", reject); target.listen(0, "127.0.0.1", resolve); });
  const origin = `http://localhost:${target.address().port}`; let proxy;
  try {
    proxy = await createOriginProxy([origin]);
    const request = path => new Promise((resolve, reject) => {
      const pending = http.request(proxy.url, { method: "GET", path, agent: false }, response => {
        const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      pending.on("error", reject); pending.setTimeout(2000, () => pending.destroy(new Error("fixture-timeout"))); pending.end();
    });
    assert.deepEqual(await request(`${origin}/fixture`), { status: 200, body: "fixture-response" });
    assert.equal((await request("http://example.com/forbidden")).status, 403);
    assert.equal(received, 1);
  } finally {
    await proxy?.close(); target.closeAllConnections(); await new Promise(resolve => target.close(resolve));
  }
});

test("HTTP 代理向授权远程地址转发且拒绝其他 origin；上游使用替身", async t => {
  const originalRequest = http.request; const forwarded = [];
  t.mock.method(http, "request", (url, options, receive) => {
    forwarded.push({ url, options });
    const upstream = new PassThrough();
    upstream.on("finish", () => {
      const reply = Readable.from(["fixture-response"]); reply.statusCode = 200; reply.headers = {};
      receive(reply);
    });
    return upstream;
  });
  const origin = "http://192.0.2.10:31943";
  const proxy = await createOriginProxy([origin]);
  const request = path => new Promise((resolve, reject) => {
    const pending = originalRequest(proxy.url, { path, headers: { "proxy-authorization": "fixture-secret" } }, response => {
      let body = ""; response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    pending.on("error", reject); pending.end();
  });
  try {
    assert.deepEqual(await request(`${origin}/login`), { status: 200, body: "fixture-response" });
    for (const other of ["http://192.0.2.10:31944", "http://198.51.100.10:31943", "http://localhost:31943"]) assert.equal((await request(other)).status, 403);
    assert.equal(forwarded.length, 1); assert.equal(forwarded[0].url.href, `${origin}/login`);
    assert.equal(forwarded[0].options.headers.host, "192.0.2.10:31943");
    assert.equal(forwarded[0].options.headers["proxy-authorization"], undefined);
    assert.equal(forwarded[0].options.lookup, targetLookup);
  } finally { await proxy.close(); }
});

test("并发工具发现只初始化一次身份，关闭后迟到的 client 不再连接", async () => {
  const auth = grant(); let created = 0; let closed = 0; let listed = 0; let release; let started;
  const gate = new Promise(resolve => { release = resolve; }); const entered = new Promise(resolve => { started = resolve; });
  const browser = new ChromeRuntimeBrowser(auth.public, { clientFactory: async () => {
    created++; started(); await gate;
    return { listTools: async () => { listed++; return { tools: [] }; }, close: async () => { closed++; } };
  } });
  const pending = Promise.allSettled([browser.tools(packet(auth.public)), browser.tools(packet(auth.public))]);
  try {
    await entered; assert.equal(created, 1); await browser.close(); release();
    assert.ok((await pending).every(result => result.status === "rejected"));
    assert.equal(listed, 0); assert.equal(closed, 1);
  } finally { release(); await browser.close(); await pending; }
});

test("控制器取消后迟到的 browser factory 必须关闭且不能执行工具", async t => {
  const root = await temporary(t); const auth = grant(); let release; let started; let closed = 0; let listed = 0;
  const gate = new Promise(resolve => { release = resolve; }); const entered = new Promise(resolve => { started = resolve; });
  const controller = new RuntimeTestingController({ root, authorization: auth.public, browserFactory: async () => {
    started(); await gate; return { tools: async () => { listed++; return []; }, close: async () => { closed++; } };
  } });
  const active = await controller.start(packet(auth.public)); const pending = controller.tools(active.token);
  const rejected = assert.rejects(pending, /lease-invalid/);
  await entered; await controller.cancel(); release(); await rejected;
  assert.equal(controller.browser, null); assert.equal(listed, 0); assert.equal(closed, 1);
});

test("初始化期间取消阻止尚未准入的工作包和浏览器启动", async t => {
  const root = await temporary(t); const auth = grant(); let workers = 0;
  const controller = new RuntimeTestingController({ root, authorization: auth.public, worker: async () => { workers++; } });
  const pending = assert.rejects(controller.run(packet(auth.public)), /unavailable/);
  await controller.cancel(); await pending;
  assert.equal(workers, 0); assert.equal(controller.state.packets.length, 0); assert.equal(controller.state.status, "CLOSED");
});

test("取消使挂起的 worker 退出控制器等待并保持唯一 CANCELLED 结果", async t => {
  const root = await temporary(t); const auth = grant(); let entered; let stopped = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const controller = new RuntimeTestingController({ root, authorization: auth.public, worker: async ({ active }) => {
    active.stopWorker = () => { stopped++; }; entered(); await new Promise(() => {});
  } });
  const pending = controller.run(packet(auth.public)); await started; await controller.cancel();
  let timer;
  try {
    const state = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("cancel-waited-for-worker")), 2000); })]);
    assert.equal(state.packets.length, 1); assert.equal(state.packets[0].execution_status, "CANCELLED");
    assert.equal(stopped, 1);
  } finally { clearTimeout(timer); }
});

test("清理失败保留支持证据并隔离环境，后续测试不能继续", async t => {
  const root = await temporary(t); const auth = grant(); const counts = { calls: 0, closed: 0 };
  const controller = new RuntimeTestingController({ root, authorization: auth.public, browserFactory: async () => fakeBrowser(counts), worker: successfulWorker });
  await controller.run(packet(auth.public));
  controller.worker = async ({ controller, active }) => {
    const evidence = await controller.call(active.token, "navigate_page", { identity_id: "anonymous", url: "http://127.0.0.1:8080" });
    await controller.submit(active.token, submission({ outcome: "SUPPORTED", evidence_ids: [evidence.evidence_id], cleanup_status: "FAILED", gaps: ["测试记录仍需人工清理。"],
      changes: [{ marker: "unique-test-marker", resource: "授权测试记录", cleanup_status: "FAILED" }] }));
  };
  await controller.run(packet(auth.public, "EXPLORE", "explore-1"));
  assert.equal(controller.state.status, "QUARANTINED");
  await assert.rejects(controller.run(packet(auth.public, "EXPLORE", "explore-2")), /unavailable/);
  const evidence = await controller.close(); assert.equal(evidence.packets[1].outcome, "SUPPORTED"); assert.equal(evidence.cleanup_status, "FAILED");
  assert.equal(runtimeCandidates(evidence).length, 1);
});

test("真实计时包含 worker 等待，超时撤销租约且不接收迟到结果", async t => {
  const root = await temporary(t); const auth = grant(); let active; let time = 0; let stopped = 0;
  const controller = new RuntimeTestingController({ root, authorization: auth.public, now: () => time,
    setTimer: callback => setTimeout(() => { time += 10_001; callback(); }, 5),
    worker: async args => { active = args.active; active.stopWorker = () => { stopped++; }; await new Promise(() => {}); } });
  const state = await controller.run(packet(auth.public, "CONTACT", "contact-1", { budget_seconds: 10 }));
  assert.equal(state.status, "QUARANTINED"); assert.equal(state.packets[0].execution_status, "TIMED_OUT"); assert.equal(state.elapsed_ms, 10_001); assert.equal(stopped, 1);
  await assert.rejects(controller.submit(active.token, submission()), /lease-invalid/);
  await controller.close();
});

test("已接收结果立即结束计时，不依赖 worker 自愿退出", async t => {
  const root = await temporary(t); const auth = grant(); const counts = { calls: 0, closed: 0 }; let stopped = 0; let watchdog;
  const controller = new RuntimeTestingController({ root, authorization: auth.public, browserFactory: async () => fakeBrowser(counts),
    setTimer: callback => { watchdog = callback; return 1; }, clearTimer: () => {},
    worker: async ({ controller, active }) => {
      active.stopWorker = () => { stopped++; };
      await successfulWorker({ controller, active });
      await new Promise(() => {});
    } });
  let timer;
  try {
    const result = await Promise.race([controller.run(packet(auth.public)), new Promise((_, reject) => {
      timer = setTimeout(() => { watchdog?.(); reject(new Error("accepted-result-waited-for-worker")); }, 2000);
    })]);
    assert.equal(result.packets[0].execution_status, "COMPLETED"); assert.equal(result.status, "READY"); assert.equal(stopped, 1);
  } finally { clearTimeout(timer); await controller.close(); }
});

test("进程恢复不继承未知环境，已耗预算与历史保留", async t => {
  const root = await temporary(t); const auth = grant();
  const first = new RuntimeTestingController({ root, authorization: auth.public }); await first.ready; await first.start(packet(auth.public));
  const recovered = new RuntimeTestingController({ root, authorization: auth.public }); await recovered.ready;
  assert.equal(recovered.state.status, "QUARANTINED"); assert.equal(recovered.state.packets[0].execution_status, "FAILED");
  await assert.rejects(recovered.run(packet(auth.public, "CONTACT", "retry")), /unavailable/);
  const different = new RuntimeTestingController({ root, authorization: seal({ ...auth.public, environment_revision: "changed" }) });
  await assert.rejects(different.ready, /new-run-required/);
});

test("恢复后未执行队列逐项记 SKIPPED，并能封存证据供静态收尾", async t => {
  const root = await temporary(t); const auth = grant();
  const first = new RuntimeTestingController({ root, authorization: auth.public }); await first.ready;
  first.state.queued_packets = [packet(auth.public)]; await first.save();
  let calls = 0;
  const recovered = new RuntimeTestingService({ root, privateRoot: join(root, "private"), authorization: auth.public, worker: async () => { calls++; } });
  await recovered.start(); assert.equal(recovered.server, null); await recovered.contact();
  const evidence = await verifyRuntimeEvidenceFiles(join(root, "evidence-set.json"));
  assert.equal(evidence.packets[0].execution_status, "SKIPPED"); assert.equal(evidence.packets[0].reason, "PROCESS_RECOVERY_QUEUE_INTERRUPTED");
  assert.equal(calls, 0); await recovered.shutdown();
});

test("预算耗尽记 SKIPPED，清理仍使用独立预留预算", async t => {
  const root = await temporary(t); const auth = grant();
  const controller = new RuntimeTestingController({ root, authorization: auth.public }); await controller.ready;
  controller.state.elapsed_ms = auth.public.budget_ms - auth.public.cleanup_reserve_ms;
  assert.equal(await controller.start(packet(auth.public)), null);
  assert.equal(controller.state.packets[0].reason, "BUDGET_EXHAUSTED");
  const cleanup = await controller.start(packet(auth.public, "CLEANUP", "cleanup-1")); assert.equal(cleanup.duration, auth.public.cleanup_reserve_ms);
  await controller.cancel();
});

function review(intake, evidence, role, refs = {}) {
  const verdicts = { AFFIRMATIVE: "PROVEN", NEGATIVE: "UPHELD", MODERATOR: "TRUE_POSITIVE" };
  const active = intake.findings.length + intake.runtime_candidates.length > 0;
  return seal({ schema_version: 3, artifact_type: "evidence-truth-review", audit_id: intake.audit_id, round: 1, role,
    execution_status: active ? "COMPLETE" : "NOT_APPLICABLE", agent_session_id: active ? `session-${role}` : null,
    intake_digest: intake.artifact_digest, runtime_evidence_digest: evidence.artifact_digest, ...refs,
    reviewed_finding_ids: intake.findings.map(row => row.finding_id),
    findings: intake.findings.map(row => ({ finding_id: row.finding_id, verdict: verdicts[role], claims: ["源码边界证据成立。"], evidence_refs: ["src/fixture.js:1"], reasoning: "已独立核查关键源码证据与反证。", gaps: [],
      runtime_review: { evidence_validity: "NOT_APPLICABLE", packet_ids: [], reasoning: "此项没有绑定运行测试。" } })),
    runtime_findings: intake.runtime_candidates.map(row => ({ finding_id: row.finding_id, claim_scope: "RUNTIME_ONLY", source_mapping: "UNKNOWN", packet_id: row.packet_id,
      verdict: verdicts[role], reasoning: "真实应用运行证据成立，源码映射仍未知。", gaps: ["未确认部署版本与源码一致。"], evidence_refs: [`runtime-testing/${row.packet_id}.result.json`] })) });
}

test("新协议完整复核源码与运行候选，拒绝混用旧 quick 和跳过角色", async t => {
  const root = await temporary(t); const auth = grant({ context: "" }); const controller = new RuntimeTestingController({ root, authorization: auth.public }); await controller.ready;
  const evidence = await controller.close();
  const intake = seal({ schema_version: 3, artifact_type: "finding-truth-validation-intake", audit_id: auth.public.audit_id, round: 1, scope_digest: SHA,
    policy: { runtime_testing: { protocol: PROTOCOL, evidence_digest: evidence.artifact_digest, authorization_digest: evidence.authorization_digest }, static_review: "AFFIRMATIVE_NEGATIVE_MODERATOR", full_dynamic_trigger: "MANUAL_ONLY" },
    findings: [{ finding_id: "finding-1", finding_object_digest: SHA, finding_path: "reports/finding.json", adjudication_state: "SUPPORTED_STATIC", runtime_request_path: null }], runtime_candidates: [] });
  assert.deepEqual(validateTruthValidationIntake(intake), []);
  const affirmative = review(intake, evidence, "AFFIRMATIVE"); const negative = review(intake, evidence, "NEGATIVE", { affirmative_review_digest: affirmative.artifact_digest });
  const moderator = review(intake, evidence, "MODERATOR", { affirmative_review_digest: affirmative.artifact_digest, negative_review_digest: negative.artifact_digest });
  const routing = seal({ schema_version: 3, artifact_type: "finding-validation-routing-manifest", audit_id: intake.audit_id, round: 1, scope_digest: SHA,
    intake_digest: intake.artifact_digest, runtime_evidence_digest: evidence.artifact_digest, role_review_digests: { affirmative: affirmative.artifact_digest, negative: negative.artifact_digest, moderator: moderator.artifact_digest }, full_dynamic_trigger: "MANUAL_ONLY",
    findings: [{ finding_id: "finding-1", route: "EVIDENCE_THREE_PARTY", runtime_status: "SKIPPED", moderator_verdict: "TRUE_POSITIVE", final_verdict: "TRUE_POSITIVE", report_disposition: "FINDING", evidence_refs: [], rationale: "独立三方复核后确认源码证据成立。" }],
    runtime_findings: [], summary: { total: 1, true_positive: 1, false_positive: 0, inconclusive: 0 }, complete: true });
  const bundle = { intake, quickResultSet: evidence, affirmative, negative, moderator, routing };
  assert.deepEqual(validateTruthValidationBundle(bundle), []);
  assert.ok(validateTruthValidationBundle({ ...bundle, affirmative: seal({ ...affirmative, schema_version: 1 }) }).length);
  assert.ok(validateTruthValidationBundle({ ...bundle, moderator: seal({ ...moderator, agent_session_id: affirmative.agent_session_id }) }).length);
  const bypass = structuredClone(routing); bypass.findings[0].route = "QUICK_DYNAMIC"; bypass.findings[0].moderator_verdict = null;
  assert.ok(validateTruthValidationBundle({ ...bundle, routing: seal(bypass) }).length);
  assert.ok(validateStaticRoleReview(seal({ ...affirmative, findings: [], reviewed_finding_ids: [] }), { intake, quickResultSet: evidence, role: "AFFIRMATIVE" }).length);
  const tampered = seal({ ...evidence, authorization_digest: "b".repeat(64) });
  assert.ok(validateTruthValidationBundle({ ...bundle, quickResultSet: tampered }).length);
});

test("仅运行候选也必须启动三个独立角色，缺失逐项复核被拒绝", () => {
  const candidate = { finding_id: "runtime-explore-1", claim_scope: "RUNTIME_ONLY", source_mapping: "UNKNOWN", packet_id: "explore-1", vulnerability_type_id: "JW-ACCESS-01", evidence_digest: SHA, scope_digest: SHA };
  const evidence = { artifact_digest: SHA, packets: [] };
  const intake = seal({ schema_version: 3, artifact_type: "finding-truth-validation-intake", audit_id: "audit-runtime-test", round: 1, scope_digest: SHA,
    policy: { runtime_testing: { protocol: PROTOCOL, evidence_digest: SHA, authorization_digest: SHA }, static_review: "AFFIRMATIVE_NEGATIVE_MODERATOR", full_dynamic_trigger: "MANUAL_ONLY" }, findings: [], runtime_candidates: [candidate] });
  const affirmative = review(intake, evidence, "AFFIRMATIVE");
  assert.deepEqual(validateStaticRoleReview(affirmative, { intake, quickResultSet: evidence, role: "AFFIRMATIVE" }), []);
  assert.ok(validateStaticRoleReview(seal({ ...affirmative, execution_status: "NOT_APPLICABLE", agent_session_id: null }), { intake, quickResultSet: evidence, role: "AFFIRMATIVE" }).length);
  assert.ok(validateStaticRoleReview(seal({ ...affirmative, runtime_findings: [] }), { intake, quickResultSet: evidence, role: "AFFIRMATIVE" }).length);
});

test("缺少环境的 v3 空候选审计可完成封存，旧模型不能冒充新协议交付", async t => {
  const root = await temporary(t); const reportsRoot = join(root, "reports"); const auth = grant({ context: "" });
  const runtimeRoot = join(reportsRoot, "runtime-testing", auth.public.audit_id);
  const controller = new RuntimeTestingController({ root: runtimeRoot, authorization: auth.public }); await controller.ready;
  const evidence = await controller.close();
  const intake = seal({ schema_version: 3, artifact_type: "finding-truth-validation-intake", audit_id: auth.public.audit_id, round: 1, scope_digest: SHA,
    policy: { runtime_testing: { protocol: PROTOCOL, evidence_digest: evidence.artifact_digest, authorization_digest: evidence.authorization_digest }, static_review: "AFFIRMATIVE_NEGATIVE_MODERATOR", full_dynamic_trigger: "MANUAL_ONLY" }, findings: [], runtime_candidates: [] });
  const affirmative = review(intake, evidence, "AFFIRMATIVE"); const negative = review(intake, evidence, "NEGATIVE", { affirmative_review_digest: affirmative.artifact_digest });
  const moderator = review(intake, evidence, "MODERATOR", { affirmative_review_digest: affirmative.artifact_digest, negative_review_digest: negative.artifact_digest });
  const routing = seal({ schema_version: 3, artifact_type: "finding-validation-routing-manifest", audit_id: intake.audit_id, round: 1, scope_digest: SHA,
    intake_digest: intake.artifact_digest, runtime_evidence_digest: evidence.artifact_digest, role_review_digests: { affirmative: affirmative.artifact_digest, negative: negative.artifact_digest, moderator: moderator.artifact_digest }, full_dynamic_trigger: "MANUAL_ONLY", findings: [], runtime_findings: [], summary: { total: 0, true_positive: 0, false_positive: 0, inconclusive: 0 }, complete: true });
  await mkdir(join(reportsRoot, "validation"), { recursive: true }); await mkdir(join(reportsRoot, "final"), { recursive: true });
  const inputs = {};
  for (const [key, value] of Object.entries({ truth_validation_intake: intake, affirmative_review: affirmative, negative_review: negative, moderator_review: moderator, validation_routing: routing })) {
    inputs[key] = join(reportsRoot, "validation", `${key}.json`); await writeFile(inputs[key], JSON.stringify(value));
  }
  for (const key of ["coverage_summary", "adjudication_input", "adjudication", "cvss_assessment", "attack_chains"]) inputs[key] = `reports/${key}.json`;
  inputs.runtime_testing_evidence = join(runtimeRoot, "evidence-set.json");
  const source = (artifact, digest) => ({ artifact, digest, json_pointer: "/summary" });
  const model = { schema_version: 3, audit_id: intake.audit_id, scope_digest: SHA, report_kind: "FINAL", inputs,
    coverage: { summary_digest: SHA, coverage_status: "COMPLETE", seal_state: "FINALIZED_COMPLETE", policy_satisfied: true, metrics: [] },
    truth_validation: { routing_digest: routing.artifact_digest, full_dynamic_trigger: "MANUAL_ONLY", summary: routing.summary, source: source(inputs.validation_routing, routing.artifact_digest) },
    runtime_testing: { protocol: PROTOCOL, evidence_digest: evidence.artifact_digest, authorization_digest: evidence.authorization_digest, status: evidence.status, reason: evidence.reason, cleanup_status: evidence.cleanup_status, packets: [], runtime_only_findings: [], source: source(inputs.runtime_testing_evidence, evidence.artifact_digest) },
    findings: [], excluded_findings: [], chains: [], rejected_chains: [] };
  model.manifest_digest = finalReportModelDigest(model);
  const path = join(reportsRoot, "final", `security-audit-report-model.${intake.audit_id}.json`); await writeFile(path, JSON.stringify(model));
  const audit = { id: intake.audit_id, source_baseline: { scope_digest: SHA }, paths: { workspace_root: root }, runtime_testing_state: controller.snapshot() };
  assert.equal(await verifyIntegratedFinalReport({ audit, reportsRoot }), true);
  model.detail_contract = "audit-report-details.v1"; model.delivery_gaps = [];
  model.runtime_testing.details = { evidence, reviews: [affirmative, negative, moderator].map(value => ({ role: value.role, session_id: value.agent_session_id,
    findings: value.runtime_findings, source: { ...source(inputs[`${value.role.toLowerCase()}_review`], value.artifact_digest), json_pointer: "/runtime_findings" } })) };
  model.manifest_digest = finalReportModelDigest(model); await writeFile(path, JSON.stringify(model));
  assert.equal(await verifyIntegratedFinalReport({ audit, reportsRoot }), true);
  model.runtime_testing.details.reviews[0].session_id = "unbound-session";
  model.manifest_digest = finalReportModelDigest(model); await writeFile(path, JSON.stringify(model));
  await assert.rejects(verifyIntegratedFinalReport({ audit, reportsRoot }), /only-review-details-mismatch/);
  model.runtime_testing.details.reviews[0].session_id = affirmative.agent_session_id;
  model.schema_version = 2; model.manifest_digest = finalReportModelDigest(model); await writeFile(path, JSON.stringify(model));
  await assert.rejects(verifyIntegratedFinalReport({ audit, reportsRoot }), /protocol-mismatch/);
});
