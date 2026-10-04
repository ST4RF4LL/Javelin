// Offline only: fake MCP clients and fetch; no listener, browser, model or target.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ChromeRuntimeBrowser } from "../lib/runtime-testing/browser.mjs";
import { RuntimeTestingController } from "../lib/runtime-testing/controller.mjs";
import { PROTOCOL, authorize, selection } from "../lib/runtime-testing/contract.mjs";
import { resolveEnvironment } from "../lib/runtime-testing/environment-prompt.mjs";

const origin = "http://127.0.0.1:8000";
const tools = [
  { name: "list_pages", inputSchema: { type: "object", properties: {} } },
  { name: "new_page", inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string" } } } },
  { name: "navigate_page", inputSchema: { type: "object", required: ["pageId"], properties: { pageId: { type: "number" }, url: { type: "string" }, initScript: { type: "string" } } } },
  { name: "get_network_request", inputSchema: { type: "object", required: ["pageId"], properties: { pageId: { type: "number" }, reqid: { type: "number" }, requestFilePath: { type: "string" }, responseFilePath: { type: "string" } } } },
  { name: "take_snapshot", inputSchema: { type: "object", required: ["pageId"], properties: { pageId: { type: "number" }, filePath: { type: "string" } } } },
  { name: "evaluate_script", inputSchema: { type: "object", properties: {} } },
];
function authorization() {
  const initial = authorize({ auditId: "audit-adapter-fixture", selected: selection({ runtime_testing: {
    protocol: PROTOCOL, mode: "INTEGRATED_TESTING", budget_minutes: 60, explicit_authorization: true,
    identity_mode: "auto", allowed_actions: ["navigate", "normal_interaction"],
  } }), enabled: true, context: "离线夹具，无目标连接。", scopeDigest: "a".repeat(64) });
  return resolveEnvironment(initial.public, { target_url: origin, origins: [origin], identities: [{ id: "account-1", role: "test-user" }, { id: "account-2", role: "test-user" }], sensitive_values: ["fixture-private-value"] }).public;
}
function packet(auth) { return { protocol: PROTOCOL, id: "contact-1", phase: "CONTACT", audit_id: auth.audit_id,
  authorization_digest: auth.artifact_digest, environment_revision: auth.environment_revision, identity_ids: auth.identities.map(i => i.id),
  actions: ["navigate", "normal_interaction"], budget_seconds: 60, question: "验证离线适配边界。", expected_behavior: "保留真实工具契约。", steps: ["读取替身结果。"], counterchecks: [] }; }
function fakeBrowser(t, respond = async () => ({ content: [], structuredContent: {} })) {
  const auth = authorization(), calls = [], sessions = [], closed = [];
  const browser = new ChromeRuntimeBrowser(auth, { clientFactory: async identity => {
    sessions.push(identity);
    return { listTools: async () => ({ tools: structuredClone(tools) }),
      callTool: async call => { calls.push({ identity, ...structuredClone(call) }); return respond(call, identity); }, close: async () => { closed.push(identity); } };
  } });
  // Supply a proxy fixture before session initialization; never bind a port.
  browser.proxyPromise = Promise.resolve({ url: "http://127.0.0.1:1", close: async () => {} });
  t.after(() => browser.close());
  return { auth, plan: packet(auth), browser, calls, sessions, closed };
}
async function temporary(t) { const root = await mkdtemp(join(tmpdir(), "runtime-adapter-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test("MCP1.8页面ID契约完整保留，Network要求实际reqid，禁止参数不向Agent公开", async t => {
  const f = fakeBrowser(t), catalog = await f.browser.tools(f.plan);
  assert.equal(catalog.some(tool => tool.name === "evaluate_script"), false);
  const network = catalog.find(tool => tool.name === "get_network_request");
  assert.deepEqual(network.inputSchema.required, ["pageId", "reqid", "identity_id"]);
  assert.equal("requestFilePath" in network.inputSchema.properties, false);
  assert.equal("responseFilePath" in network.inputSchema.properties, false);
  assert.equal("initScript" in catalog.find(tool => tool.name === "navigate_page").inputSchema.properties, false);
  assert.equal("filePath" in catalog.find(tool => tool.name === "take_snapshot").inputSchema.properties, false);
  assert.deepEqual(catalog.find(tool => tool.name === "new_page").inputSchema.required, ["url", "identity_id"]);
});

test("pageIdx不能冒充pageId，缺失reqid不调用MCP，真实页/请求ID按身份原样传递", async t => {
  const raw = { content: [{ type: "text", text: "captured" }], structuredContent: { networkRequest: { requestId: 73, method: "GET", url: `${origin}/a`, status: "200", requestHeaders: {}, responseBody: "proof" } } };
  const f = fakeBrowser(t, async () => raw);
  await assert.rejects(f.browser.call("navigate_page", { identity_id: "account-1", pageIdx: 0, url: origin }, f.plan), /page-id-required/);
  await assert.rejects(f.browser.call("get_network_request", { identity_id: "account-1", pageId: 9 }, f.plan), /network-request-id-required/);
  assert.equal(f.calls.length, 0);
  for (const identity_id of ["account-1", "account-2"]) {
    const result = await f.browser.call("get_network_request", { identity_id, pageId: 9, reqid: 73 }, f.plan);
    assert.deepEqual(result, raw);
  }
  assert.deepEqual(f.calls.map(c => [c.identity, c.arguments]), [["account-1", { pageId: 9, reqid: 73 }], ["account-2", { pageId: 9, reqid: 73 }]]);
  assert.deepEqual(f.sessions, ["account-1", "account-2"]);
});

test("禁止脚本和文件参数在创建会话前拒绝，授权origin和工具边界不变", async t => {
  const f = fakeBrowser(t);
  for (const [name, args] of [
    ["navigate_page", { initScript: "void 0" }], ["get_network_request", { requestFilePath: "/tmp/forbidden" }],
    ["get_network_request", { responseFilePath: "/tmp/forbidden" }], ["take_snapshot", { filePath: "/tmp/forbidden" }],
    ["take_snapshot", { file_path: "" }],
  ]) await assert.rejects(f.browser.call(name, { identity_id: "account-1", pageId: 9, reqid: 73, ...args }, f.plan), /script-or-file-operation-not-authorized/);
  await assert.rejects(f.browser.call("navigate_page", { identity_id: "account-1", pageId: 9, url: "https://other.invalid" }, f.plan), /origin-not-authorized/);
  await assert.rejects(f.browser.call("evaluate_script", { identity_id: "account-1" }, f.plan), /tool-not-authorized/);
  assert.deepEqual(f.sessions, []); assert.deepEqual(f.calls, []);
});

test("官方navigate失败消息转成错误；成功消息和页面内容不误判", async t => {
  for (const message of ["Unable to navigate in the selected page: net::ERR_CONNECTION_REFUSED", "Unable to navigate back in the selected page: failure", "Unable to navigate forward in the selected page: failure", "Unable to reload the selected page: failure"]) {
    const f = fakeBrowser(t, async () => ({ isError: false, content: [], structuredContent: { message } }));
    assert.equal((await f.browser.call("navigate_page", { identity_id: "account-1", pageId: 9, url: origin }, f.plan)).isError, true);
  }
  const f = fakeBrowser(t, async () => ({ isError: false, content: [{ type: "text", text: "Unable to navigate in the selected page: literal page content" }], structuredContent: { message: "Successfully navigated to the authorized page." } }));
  assert.equal((await f.browser.call("navigate_page", { identity_id: "account-1", pageId: 9, url: origin }, f.plan)).isError, false);
});

test("真实Controller不把失败导航算CONTACT基线，向Agent返回脱敏typed页面/HTTP并持久化错误", async t => {
  const root = await temporary(t);
  const f = fakeBrowser(t, async ({ name }) => name === "navigate_page"
    ? { isError: false, content: [], structuredContent: { message: "Unable to navigate in the selected page: refused" } }
    : { content: [], structuredContent: { pages: [{ id: 9, url: `${origin}/a`, selected: true }], networkRequest: { requestId: 73, method: "POST", url: `${origin}/a`, status: "200", requestHeaders: { Authorization: "Bearer fixture-private-value" }, requestBody: '{"token":"fixture-private-value","marker":1}', responseHeaders: {}, responseBody: "proof" } } });
  const controller = new RuntimeTestingController({ root, authorization: f.auth, privateContext: { environment_ready: true, sensitive_values: ["fixture-private-value"] },
    browserFactory: async () => f.browser, worker: async () => assert.fail("不得启动模型") });
  await controller.ready; const active = await controller.start(f.plan);
  try {
  const failed = await controller.call(active.token, "navigate_page", { identity_id: "account-1", pageId: 9, url: origin });
  assert.equal(failed.isError, true); assert.equal(active.identitiesUsed.size, 0);
  const result = await controller.call(active.token, "get_network_request", { identity_id: "account-1", pageId: 9, reqid: 73 });
  assert.equal(typeof result.result, "string"); assert.equal(result.isError, false);
  assert.equal(result.structured_result.structuredContent.pages[0].id, 9);
  const network = result.structured_result.structuredContent.networkRequest;
  assert.equal(network.requestId, 73); assert.equal(network.requestHeaders.Authorization, "[REDACTED]");
  assert.deepEqual(JSON.parse(network.requestBody), { token: "[REDACTED]", marker: 1 });
  assert.equal(JSON.stringify(result).includes("fixture-private-value"), false);
  const evidence = JSON.parse(await readFile(join(root, "evidence", `${failed.evidence_id}.json`), "utf8"));
  assert.equal(evidence.structured_content.result.isError, true);
  } finally { await controller.cancel(); }
});

test("抛出的浏览器错误留存身份、参数与脱敏诊断，运行中证据索引立即落盘", async t => {
  const root = await temporary(t);
  const f = fakeBrowser(t, async () => { throw new Error("Protocol error (Target.setDiscoverTargets): Target closed; token=fixture-private-value"); });
  const controller = new RuntimeTestingController({ root, authorization: f.auth, privateContext: { environment_ready: true, sensitive_values: ["fixture-private-value"] },
    browserFactory: async () => f.browser, worker: async () => assert.fail("不得启动模型") });
  await controller.ready; const active = await controller.start(f.plan);
  try {
    await assert.rejects(controller.call(active.token, "navigate_page", { identity_id: "account-1", pageId: 9, url: `${origin}/?token=fixture-private-value` }), /Target closed/);
    const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    assert.equal(state.evidence.length, 1); assert.equal(state.active_packet, "contact-1");
    assert.equal(active.actionIds.has(state.evidence[0].id), true); assert.equal(active.identitiesUsed.size, 0);
    const evidence = JSON.parse(await readFile(join(root, state.evidence[0].path), "utf8"));
    assert.equal(evidence.structured_content.identity_id, "account-1");
    assert.equal(evidence.structured_content.arguments.pageId, 9);
    assert.match(evidence.structured_content.arguments.url, /REDACTED/);
    assert.equal(evidence.structured_content.status, "FAILED");
    assert.equal(evidence.structured_content.result.isError, true);
    assert.match(evidence.structured_content.result.error.message, /Target closed/);
    assert.equal(JSON.stringify(evidence).includes("fixture-private-value"), false);
  } finally { await controller.cancel(); }
});

test("失败导航后的成功快照、错误页和其他页都不能使CONTACT完成；仅授权实际导航计入", async t => {
  const root = await temporary(t); let mode = "failed";
  const f = fakeBrowser(t, async ({ name }) => {
    if (name === "take_snapshot") return { isError: false, structuredContent: { snapshot: { url: "chrome-error://chromewebdata/" }, pages: [{ id: 9, selected: true, url: origin }] } };
    if (mode === "failed") return { isError: false, structuredContent: { message: "Unable to navigate in the selected page: refused", pages: [{ id: 9, selected: true, url: "chrome-error://chromewebdata/" }] } };
    const pages = mode === "blank" ? [{ id: 9, selected: true, url: "about:blank" }]
      : mode === "outside" ? [{ id: 9, selected: true, url: "https://other.invalid" }]
      : mode === "wrong-page" ? [{ id: 8, selected: true, url: origin }]
      : [{ id: 9, selected: true, url: `${origin}/login` }];
    return { isError: false, structuredContent: { pages } };
  });
  const controller = new RuntimeTestingController({ root, authorization: f.auth, privateContext: {}, browserFactory: async () => f.browser, worker: async () => assert.fail("不得启动模型") });
  await controller.ready; const active = await controller.start(f.plan);
  const submission = () => ({ execution_status: "COMPLETED", outcome: "NOT_OBSERVED", cleanup_status: "NOT_REQUIRED", summary: "离线基线夹具。", observations: [], gaps: [], changes: [], evidence_ids: [...active.actionIds] });
  try {
    await controller.call(active.token, "navigate_page", { identity_id: "account-1", pageId: 9, url: origin });
    for (const identity_id of f.plan.identity_ids) await controller.call(active.token, "take_snapshot", { identity_id, pageId: 9 });
    assert.equal(active.identitiesUsed.size, 0);
    await assert.rejects(controller.submit(active.token, submission()), /contact-identities-not-observed/);
    for (mode of ["blank", "outside", "wrong-page"]) {
      await controller.call(active.token, "navigate_page", { identity_id: "account-1", pageId: 9, url: origin });
      assert.equal(active.identitiesUsed.size, 0);
    }
    mode = "authorized";
    await controller.call(active.token, "navigate_page", { identity_id: "account-1", pageId: 9, url: origin });
    await controller.call(active.token, "new_page", { identity_id: "account-2", url: origin });
    assert.deepEqual([...active.identitiesUsed], ["account-1", "account-2"]);
    await controller.submit(active.token, submission());
    assert.equal(active.submission.execution_status, "COMPLETED");
  } finally { await controller.cancel(); }
});

test("真实stdio工作桥保留typed result和isError；伪fetch确保零网络", async t => {
  const root = await temporary(t), preload = join(root, "fake-fetch.mjs");
  await writeFile(preload, `globalThis.fetch = async (url, init) => {
    if (url !== "http://127.0.0.1:1/call") throw new Error("unexpected-network-attempt");
    const input=JSON.parse(init.body); const failed=input.name === "navigate_page";
    return new Response(JSON.stringify({evidence_id:"contact-1.action-1",result:"legacy",isError:failed,structured_result:{isError:failed,structuredContent:{pages:[{id:9,selected:true}]}}}),{status:200,headers:{"content-type":"application/json"}});
  };`);
  const client = new Client({ name: "offline-browser-adapter-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", preload, fileURLToPath(new URL("../lib/runtime-testing/worker-mcp.mjs", import.meta.url))],
    env: { RUNTIME_WORKER_ENDPOINT: "http://127.0.0.1:1", RUNTIME_WORKER_TOKEN: "offline-fixture-token" }, stderr: "ignore" });
  t.after(() => client.close()); await client.connect(transport);
  for (const name of ["navigate_page", "list_pages"]) {
    const result = await client.callTool({ name: "browser_call", arguments: { name, arguments: { identity_id: "account-1", pageId: 9 } } });
    assert.equal(result.isError, name === "navigate_page");
    assert.equal(result.structuredContent.structured_result.structuredContent.pages[0].id, 9);
    assert.equal(JSON.parse(result.content[0].text).evidence_id, "contact-1.action-1");
  }
});
