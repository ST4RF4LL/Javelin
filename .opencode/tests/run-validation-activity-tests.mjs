// Offline fixtures only: no HTTP listener, browser, model, or target connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { seal, PROTOCOL } from "../lib/runtime-testing/contract.mjs";
import { RuntimeTestingController } from "../lib/runtime-testing/controller.mjs";
import { listValidationRunDetails, sanitizeForWeb } from "../web/dynamic-validation-observatory/model.mjs";
import { buildBrunoCollection } from "../web/dynamic-validation-observatory/bruno-exporter.mjs";
import { readRuntimeTestingActivity } from "../web/dynamic-validation-observatory/runtime-testing-activity.mjs";
import { buildValidationActivity, filterValidationActivity } from "../web/dynamic-validation-observatory/validation-activity.mjs";
import { createProvenanceIndex, matchesProvenance } from "../web/dynamic-validation-observatory/provenance.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function write(root, path, value) {
  await mkdir(join(root, path, ".."), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(value)); await writeFile(join(root, path), bytes);
  return { path, sha256: hash(bytes) };
}
async function fixture(t, { phase = "CONFIRM", terminal = true, textOnly = false, raw = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "validation-activity-")); t.after(() => rm(root, { recursive: true, force: true }));
  const audit = { id: "audit-fixture", runtime_testing_state: { status: "BLOCKED", reason: "ENVIRONMENT_CONTACT_INCOMPLETE" } };
  const relative = `runtime-testing/${audit.id}`, runtime = join(root, relative), scope = "a".repeat(64);
  const authorization = seal({ protocol: PROTOCOL, audit_id: audit.id, scope_digest: scope, environment_revision: "fixture-revision", environment_ready: true,
    status: "AUTHORIZED", budget_ms: 60000, cleanup_reserve_ms: 5000,
    identities: [{ id: "anonymous" }], origins: ["http://127.0.0.1:8000"], allowed_actions: ["navigate"], mode: "INTEGRATED_TESTING" });
  const packet = seal({ protocol: PROTOCOL, audit_id: audit.id, id: "packet-1", phase, authorization_digest: authorization.artifact_digest,
    environment_revision: authorization.environment_revision, identity_ids: ["anonymous"], actions: ["navigate"], budget_seconds: 30,
    question: "只读样例是否满足预期？", expected_behavior: "记录已授权测试样例。", steps: ["检查证据"], counterchecks: ["核对反证"],
    ...(phase !== "CONTACT" ? { hypothesis_id: "hypothesis-1", focus_area_id: "FA-1", scope_digest: scope } : {}),
    ...(phase === "CONFIRM" ? { finding_id: "F-1", finding_object_digest: "b".repeat(64), vulnerability_type_id: "JW-INJECT-01" } : {}) });
  await write(runtime, "authorization.json", authorization); await write(runtime, `packets/${packet.id}.input.json`, packet);
  const content = { tool: "get_network_request", identity_id: "anonymous", arguments: { identity_id: "anonymous", reqid: 7 },
    result: textOnly ? { content: [{ type: "text", text: "## Request http://127.0.0.1:8000/a\nStatus: 200\n### Response Body\nproof" }] }
      : { structuredContent: { networkRequest: { requestId: 7, method: "POST", url: "http://127.0.0.1:8000/a?repeat=1&repeat=2", status: "200",
        requestHeaders: { "content-type": "application/json", authorization: "[REDACTED]" }, requestBody: '{"value":"proof"}',
        responseHeaders: { "content-type": "text/plain" }, responseBody: "proof... <truncated>" } } } };
  const record = seal({ protocol: PROTOCOL, audit_id: audit.id, recorded_at: "2026-10-03T00:00:00.000Z", content: raw ? '{"tool":"get_network_request","result":[REDACTED]}' : JSON.stringify(content) });
  const binding = { id: `${packet.id}.action-1`, ...await write(runtime, `evidence/${packet.id}.action-1.json`, record) };
  const result = seal({ protocol: PROTOCOL, audit_id: audit.id, packet_id: packet.id, input_digest: packet.artifact_digest, authorization_digest: authorization.artifact_digest,
    environment_revision: authorization.environment_revision, execution_status: "COMPLETED", outcome: "INCONCLUSIVE", summary: "已记录离线样例动作。", gaps: [] });
  await write(runtime, `packets/${packet.id}.result.json`, result);
  const row = { id: packet.id, phase, input_digest: packet.artifact_digest, started_at: "2026-10-03T00:00:00.000Z", execution_status: terminal ? "COMPLETED" : "RUNNING",
    finding_id: packet.finding_id ?? null, finding_object_digest: packet.finding_object_digest ?? null, hypothesis_id: packet.hypothesis_id ?? null, scope_digest: packet.scope_digest ?? null,
    evidence_ids: terminal ? [binding.id] : [], ...(terminal ? { result_path: `packets/${packet.id}.result.json`, result_digest: result.artifact_digest } : {}) };
  const state = { protocol: PROTOCOL, audit_id: audit.id, authorization_digest: authorization.artifact_digest, environment_revision: authorization.environment_revision,
    status: terminal ? "CLOSED" : "IN_USE", packets: [row], ...(terminal ? { artifact_type: "runtime-testing-evidence-set", evidence_bindings: [binding] } : { active_packet: packet.id, evidence: [binding] }) };
  const statePath = terminal ? "evidence-set.json" : "state.json";
  await write(runtime, statePath, terminal ? seal(state) : state);
  return { root, runtime, audit, authorization, packet, record, binding, state, statePath, content,
    read: () => readRuntimeTestingActivity({ reportsRoot: root, repositoryId: "repo-1", audit }),
    saveState: () => write(runtime, statePath, terminal ? seal(state) : state) };
}

test("已封存动作读取官方结构化网络，保留截断与未知耗时并生成稳定导出ID", async t => {
  const f = await fixture(t), before = await readFile(join(f.runtime, f.statePath));
  const first = await f.read(), second = await f.read();
  assert.equal(first.cases[0].finding_id, "F-1"); assert.equal(first.cases[0].actions.length, 1);
  assert.equal(first.exchanges.length, 1); const exchange = first.exchanges[0];
  assert.match(exchange.exchange_id, /^http_[A-Za-z0-9-]+$/); assert.equal(exchange.exchange_id, second.exchanges[0].exchange_id);
  assert.equal(exchange.response.body.truncated, true); assert.equal(exchange.response.body.text, "proof... <truncated>");
  assert.equal(exchange.duration_ms, null); assert.equal(exchange.timestamp_source, "evidence_capture");
  assert.deepEqual(first.cases[0].actions[0].exchange_ids, [exchange.exchange_id]);
  assert.deepEqual(await readFile(join(f.runtime, f.statePath)), before);
});

test("活跃工作包可读取已绑定动作；没有可靠结构时保留脱敏原文并不虚构请求", async t => {
  for (const options of [{ terminal: false }, { textOnly: true }, { raw: true }]) await t.test(JSON.stringify(options), async t => {
    const f = await fixture(t, options), result = await f.read();
    assert.equal(result.cases[0].actions.length, 1);
    assert.equal(result.exchanges.length, options.terminal === false ? 1 : 0);
    if (options.terminal !== false) assert.ok(result.cases[0].actions[0].gaps.length);
  });
});

test("CONTACT与EXPLORE明确未关联；无动作BLOCKED仍可见", async t => {
  for (const phase of ["CONTACT", "EXPLORE"]) await t.test(phase, async t => {
    const f = await fixture(t, { phase }), value = await f.read();
    assert.equal(value.cases[0].finding_id, null); assert.match(value.cases[0].title, /未关联漏洞/);
  });
  const f = await fixture(t); f.state.packets = []; f.state.evidence_bindings = []; f.state.status = "BLOCKED"; f.state.reason = "ENVIRONMENT_CONTACT_INCOMPLETE"; await f.saveState();
  const value = await f.read(); assert.equal(value.cases.length, 1); assert.equal(value.cases[0].status, "BLOCKED");
  assert.equal(value.cases[0].actions.length, 0); assert.ok(value.cases[0].gaps.length);
});

test("身份、请求ID与授权origin不匹配不导出；大型原文仅截断显示并标明缺口", async t => {
  for (const [name, edit, actionCount] of [
    ["identity", content => { content.identity_id = "another-identity"; }, 0],
    ["reqid", content => { content.arguments.reqid = 999; }, 1],
    ["origin", content => { content.result.structuredContent.networkRequest.url = "https://not-authorized.invalid/a"; }, 1],
    ["text-preview", content => { content.result = { content: [{ type: "text", text: "x".repeat(70 * 1024) }] }; }, 1],
  ]) await t.test(name, async t => {
    const f = await fixture(t), content = structuredClone(f.content); edit(content);
    const record = seal({ ...f.record, content: JSON.stringify(content) });
    f.state.evidence_bindings[0] = { id: f.binding.id, ...await write(f.runtime, f.binding.path, record) }; await f.saveState();
    const value = await f.read(); assert.equal(value.exchanges.length, 0); assert.equal(value.cases[0].actions.length, actionCount);
    if (name === "text-preview") { assert.equal(value.cases[0].actions[0].result.truncated, true); assert.ok(value.cases[0].actions[0].gaps.length); }
  });
});

test("SHA、审计、工作包输入、动作清单、路径与符号链接异常均不公开动作或导出", async t => {
  for (const [name, change] of [
    ["hash", async f => { f.state.evidence_bindings[0].sha256 = "0".repeat(64); await f.saveState(); }],
    ["audit", async f => { const r = seal({ ...f.record, audit_id: "other-audit" }); f.state.evidence_bindings[0] = { id: f.binding.id, ...await write(f.runtime, f.binding.path, r) }; await f.saveState(); }],
    ["packet", async f => { f.state.packets[0].finding_id = "other-finding"; await f.saveState(); }],
    ["unadmitted", async f => { f.state.packets[0].evidence_ids = []; await f.saveState(); }],
    ["escape", async f => { f.state.evidence_bindings[0].path = "../../secret.json"; await f.saveState(); }],
    ["symlink", async f => { const outside = join(f.root, "other.json"); await writeFile(outside, JSON.stringify(f.record)); await rm(join(f.runtime, f.binding.path)); await symlink(outside, join(f.runtime, f.binding.path)); }],
    ["input-hash", async f => { f.state.packets[0].input_digest = "0".repeat(64); await f.saveState(); }],
  ]) await t.test(name, async t => {
    const f = await fixture(t); await change(f); const value = await f.read();
    assert.equal(value.exchanges.length, 0); assert.equal(value.cases.flatMap(row => row.actions).length, 0); assert.ok(value.cases.some(row => row.gaps.length));
  });
});

test("仅明确别名可归并，跨仓库/审计隔离，历史网络和待执行请求均进入病例", () => {
  const snapshot = { audits: [], reports: [{ id: "report-1", repository_id: "repo-1", audit_id: "audit-1", finding_ids: ["canonical-1"], finding_index_available: true }],
    findings: [{ id: "canonical-1", source_finding_ids: ["source-1"], title: "对应漏洞", repository_id: "repo-1", audit_id: "audit-1" }] };
  const attachSource = createProvenanceIndex(snapshot, row => ({ product_id: row.repository_id === "repo-1" ? "product-1" : "product-2" }));
  const caseOf = (repository_id, audit_id, finding_id) => ({ repository_id, audit_id, finding_id, title: "样例", status: "COMPLETED", summary: "已执行", actions: [], exchange_ids: [], gaps: [] });
  const value = buildValidationActivity({ attachSource, runtimeCases: [caseOf("repo-1", "audit-1", "source-1"), caseOf("repo-2", "audit-1", "source-1"), caseOf("repo-1", "audit-2", "source-1")],
    requests: [{ repository_id: "repo-1", audit_id: "audit-1", finding_id: "canonical-1", dispatch_ready: true }, { repository_id: "repo-1", audit_id: "audit-1", finding_id: "pending-1", dispatch_ready: true }],
    manualRuns: [{ repository_id: "repo-1", audit_id: "audit-1", finding: { id: "canonical-1", outcome: "SUPPORTED" }, network: { exchanges: [{ exchange_id: "http_same", request: { method: "GET", url: "http://127.0.0.1:8000/a" }, response: { status: 200 } }] } }] });
  assert.equal(value.count, 4); assert.equal(value.has_more, false); assert.equal(value.exchanges.length, 1);
  const merged = value.items.find(row => row.finding_id === "canonical-1"); assert.equal(merged.actions.length, 1); assert.equal(merged.exchange_ids.length, 1);
  assert.equal(merged.status, "COMPLETED"); assert.equal(value.items.find(row => row.finding_id === "pending-1").actions.length, 0);
  assert.equal(value.items.filter(row => matchesProvenance(row, new URLSearchParams({ product_id: "product-1", audit_id: "audit-1", report_id: "report-1" }))).length, 1);
  const filtered = filterValidationActivity(value, new URLSearchParams({ product_id: "product-1", audit_id: "audit-1", report_id: "report-1" }));
  assert.equal(filtered.count, 1); assert.equal(filtered.exchanges.length, 1); assert.deepEqual(filtered.items[0].exchange_ids, [filtered.exchanges[0].exchange_id]);
  assert.equal(filterValidationActivity(value, new URLSearchParams({ audit_id: "audit-2" })).exchanges.length, 0);
});

test("真实Controller写入保留结构化HTTP；Authorization、引号secret和Set-Cookie不会破坏外层JSON或泄漏", async t => {
  const f = await fixture(t), secret = 'fixture-quoted-"credential"';
  const controller = new RuntimeTestingController({ root: f.runtime, authorization: f.authorization,
    privateContext: { environment_ready: true, sensitive_values: [secret] }, now: () => 0,
    browserFactory: () => assert.fail("不应启动浏览器"), worker: () => assert.fail("不应启动模型") });
  await controller.ready;
  const active = { token: "fixture-only", start: 0, duration: 1000 }; controller.active = active;
  const content = structuredClone(f.content), network = content.result.structuredContent.networkRequest;
  network.requestHeaders.Authorization = `Bearer ${secret}`;
  network.requestHeaders["X-Api-Key"] = "unknown-api-secret";
  network.requestHeaders.Cookie = "session=unknown-cookie";
  network.requestHeaders["X-Session-Id"] = "unknown-header-session";
  network.requestBody = JSON.stringify({ marker: "proof", note: secret, token: "unknown-body-token", session: "unknown-body-session", nested: { sessionId: "unknown-nested-session" } });
  network.responseHeaders["Set-Cookie"] = "session=unknown-response-cookie; HttpOnly";
  network.responseBody = JSON.stringify({ marker: "proof-response", session_id: "unknown-response-session", nested: { token: "unknown-response-token" } });
  const binding = await controller.evidence(f.binding.id, content, active);
  const written = JSON.parse(await readFile(join(f.runtime, binding.path), "utf8"));
  assert.equal(typeof written.content, "string");
  const structured = written.structured_content.result.structuredContent.networkRequest;
  assert.equal(structured.method, "POST"); assert.equal(structured.url, network.url);
  assert.equal(structured.requestHeaders.Authorization, "[REDACTED]"); assert.equal(structured.requestHeaders["X-Api-Key"], "[REDACTED]");
  assert.equal(structured.requestHeaders.Cookie, "[REDACTED]"); assert.equal(structured.responseHeaders["Set-Cookie"], "[REDACTED]");
  assert.equal(structured.requestHeaders["X-Session-Id"], "[REDACTED]");
  assert.deepEqual(JSON.parse(structured.requestBody), { marker: "proof", note: "[REDACTED]", token: "[REDACTED]", session: "[REDACTED]", nested: { sessionId: "[REDACTED]" } });
  assert.deepEqual(JSON.parse(structured.responseBody), { marker: "proof-response", session_id: "[REDACTED]", nested: { token: "[REDACTED]" } });
  for (const value of [secret, "unknown-api-secret", "unknown-cookie", "unknown-response-cookie", "unknown-header-session", "unknown-body-token", "unknown-body-session", "unknown-nested-session", "unknown-response-session", "unknown-response-token"]) assert.equal(JSON.stringify(written.structured_content).includes(value), false);
  f.state.evidence_bindings = [binding]; await f.saveState();
  const read = await f.read(); assert.equal(read.exchanges.length, 1);
  assert.equal(read.exchanges[0].request.method, "POST"); assert.equal(read.exchanges[0].response.body.text, structured.responseBody);
  assert.equal(read.exchanges[0].request.body.text, structured.requestBody);
  const collection = JSON.parse(buildBrunoCollection(read.exchanges).bytes.toString("utf8"));
  const item = collection.items[0].items?.[0] ?? collection.items[0];
  const exportedBody = JSON.parse(item.request.body.json);
  assert.equal(exportedBody.marker, "proof");
  for (const value of [exportedBody.token, exportedBody.session, exportedBody.nested.sessionId, exportedBody.note]) assert.match(value, /^\{\{DYNVAL_/);
  const exportedResponse = JSON.parse(item.examples[0].response.body.content);
  assert.equal(exportedResponse.marker, "proof-response");
  assert.equal(JSON.stringify(collection).includes("unknown-"), false);
});

test("历史JSON正文中带转义引号的凭据完整脱敏且不破坏语法或数字字面量", () => {
  const secret = 'qa-"escaped"-credential';
  const input = ` { "id":9223372036854775807, "token":${JSON.stringify(secret)}, "value":1e400, "id":-0 } `;
  const actual = sanitizeForWeb({ body: { text: input } }).body.text;
  assert.equal(actual, input.replace(JSON.stringify(secret), '"[REDACTED]"'));
  assert.doesNotThrow(() => JSON.parse(actual));
  assert.equal(actual.includes("escaped"), false);
});

test("Controller封存、网页读取和Bruno导出均保留大整数、精确小数与重复键", async t => {
  const f = await fixture(t), secret = 'qa-"quoted"-secret';
  const body = ` { "id":9223372036854775807, "decimal":0.1234567890123456789012345, "duplicate":1, "duplicate":2, "negativeZero":-0, "note":${JSON.stringify(secret)}, "token":12345678901234567890 } `;
  const controller = new RuntimeTestingController({ root: f.runtime, authorization: f.authorization,
    privateContext: { environment_ready: true, sensitive_values: [secret] }, now: () => 0,
    browserFactory: () => assert.fail("不应启动浏览器"), worker: () => assert.fail("不应启动模型") });
  await controller.ready;
  const active = { token: "fixture-only", start: 0, duration: 1000 }; controller.active = active;
  const content = structuredClone(f.content), network = content.result.structuredContent.networkRequest;
  network.requestBody = body; network.responseBody = body;
  network.responseHeaders["content-type"] = "application/json";
  const binding = await controller.evidence(f.binding.id, content, active);
  f.state.evidence_bindings = [binding]; await f.saveState();
  const result = await f.read(); assert.equal(result.exchanges.length, 1);
  const collection = buildBrunoCollection(result.exchanges).document;
  const texts = [result.exchanges[0].request.body.text, result.exchanges[0].response.body.text,
    collection.items[0].request.body.json, collection.items[0].examples[0].response.body.content];
  for (const text of texts) {
    assert.doesNotThrow(() => JSON.parse(text));
    for (const fragment of ['"id":9223372036854775807', '"decimal":0.1234567890123456789012345', '"duplicate":1, "duplicate":2', '"negativeZero":-0']) assert.ok(text.includes(fragment));
    assert.equal(text.includes("quoted"), false); assert.equal(text.includes("12345678901234567890 }"), false);
  }
});

test("历史HTTP明确归属冲突被拒；只有可证实canonical别名可归并", () => {
  const attachSource = createProvenanceIndex({ audits: [], reports: [], findings: [{ id: "canonical-A", source_finding_ids: ["alias-A"], repository_id: "repo-A", audit_id: "audit-A" }] }, () => ({}));
  const base = { repository_id: "repo-A", audit_id: "audit-A", finding: { id: "canonical-A" } };
  const exchange = { exchange_id: "http_bound", request: { method: "GET", url: "http://127.0.0.1/a" }, response: { status: 200 } };
  for (const binding of [{ audit_id: "audit-B" }, { repository_id: "repo-B" }, { finding_id: "finding-B" }, { evidence_binding: { audit_id: "audit-B" } }]) {
    const value = buildValidationActivity({ attachSource, manualRuns: [{ ...base, network: { exchanges: [{ ...exchange, ...binding }] } }] });
    assert.equal(value.exchanges.length, 0); assert.match(value.items[0].gaps.join(" "), /冲突/);
  }
  const value = buildValidationActivity({ attachSource, manualRuns: [{ ...base, network: { exchanges: [{ ...exchange, finding_id: "alias-A" }] } }] });
  assert.equal(value.exchanges.length, 1); assert.equal(value.exchanges[0].finding_id, "canonical-A");
});

test("旧版无归属字段证据只从当前finding证据目录读取，network与observations均隔离", async t => {
  for (const mode of ["valid", "other-audit", "other-finding", "root-symlink", "file-symlink", "result-audit", "result-finding", "legacy-conflict"]) await t.test(mode, async t => {
    const root = await mkdtemp(join(tmpdir(), "validation-legacy-scope-")); t.after(() => rm(root, { recursive: true, force: true }));
    const audit = "audit-A", finding = "finding-A", ownPath = `${audit}/${finding}/evidence/http.json`;
    const otherPath = mode === "other-finding" ? `${audit}/finding-B/evidence/http.json` : "audit-B/finding-B/evidence/http.json";
    const exchange = { schema_version: 1, artifact_type: "SANITIZED_HTTP_EXCHANGE", exchange_id: "http_old",
      request: { method: "GET", url: "http://127.0.0.1/a", headers: [] }, response: { status: 200, headers: [] },
      ...(mode === "legacy-conflict" ? { audit_id: "audit-B", evidence_binding: { finding_id: "finding-B" } } : {}) };
    let path = ownPath;
    if (["other-audit", "other-finding"].includes(mode)) path = otherPath;
    await write(root, path, exchange);
    if (mode.endsWith("symlink")) {
      await write(root, otherPath, exchange);
      if (mode === "root-symlink") { await rm(join(root, audit, finding, "evidence"), { recursive: true }); await symlink(join(root, "audit-B", "finding-B", "evidence"), join(root, audit, finding, "evidence")); }
      else { await rm(join(root, ownPath)); await symlink(join(root, otherPath), join(root, ownPath)); }
    }
    await write(root, `${audit}/${finding}.result.json`, { audit_id: mode === "result-audit" ? "audit-B" : audit,
      finding_id: mode === "result-finding" ? "finding-B" : finding,
      evidence_artifacts: [{ artifact_id: "artifact-1", path: join(root, path), media_type: "application/json", sanitized: true }],
      network_trace: { schema_version: 1, exchanges: [{ artifact_id: "artifact-1" }] }, observations: [{ evidence_artifact_ids: ["artifact-1"] }] });
    const rows = await listValidationRunDetails(root), run = rows.find(row => row.audit_id === audit);
    const allowed = ["valid", "legacy-conflict"].includes(mode);
    assert.equal(run.network.exchange_count, allowed ? 1 : 0);
    if (!allowed) assert.equal(run.observations?.[0]?.evidence[0]?.data ?? null, null);
    if (mode.startsWith("result-")) assert.equal(run.finding.outcome, "READ_ERROR");
    const activity = buildValidationActivity({ manualRuns: [{ ...run, repository_id: "repo-A" }] });
    assert.equal(activity.exchanges.length, mode === "valid" ? 1 : 0);
  });
});

test("无漏洞的旧请求历史明确未关联，历史窗口缺口随过滤结果返回", () => {
  const value = buildValidationActivity({ historicalExchanges: [{ exchange_id: "http_history", started_at: "2026-10-03T00:00:00Z",
    request: { method: "GET", url: "http://127.0.0.1/history" }, response: { status: 200 } }] });
  assert.equal(value.count, 1); assert.equal(value.items[0].finding_id, null); assert.match(value.items[0].title, /未关联漏洞/);
  assert.equal(value.items[0].actions.length, 1); assert.equal(value.exchanges.length, 1);
  value.history_window = { limit: 500, returned: 500, total: 600, has_more: true };
  const filtered = filterValidationActivity(value, new URLSearchParams());
  assert.equal(filtered.has_more, true); assert.equal(filtered.history_window.total, 600);
});
