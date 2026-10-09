import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAuditEvent, normalizeAuditEvents, itemKey } from "../web/dynamic-validation-observatory/public/audit-event-adapter.js";
import { openCodeEventView } from "../web/dynamic-validation-observatory/opencode-event-view.mjs";

const at = "2026-10-04T13:16:55.566Z";
const worker = (event, prefix = "[web/fa-fe-trust-r3] ", overrides = {}) => ({ occurred_at: at, source: "stdout", kind: "raw", label: "Runner 输出", status: null, body: prefix + JSON.stringify(event), detail: "", ...overrides });

// Exact, already-redacted metadata-only sample from runner.log.jsonl of
// audit-1791117922493-9eb972ff. No tool bodies, prompts or private context.
const recordedStep = { occurred_at: at, source: "stdout", message: '[platform/fa-supply-deploy-r3] {"type":"step_finish","timestamp":1791119815566,"sessionID":"ses_ef8f0a775ffezAcaCgzsdw06TI","part":{"id":"prt_1070f738c001hnjcwRiNtxo6P9","reason":"tool-calls","snapshot":"73708a3ef5887893f5f3fd61115d36c54ea73992","messageID":"msg_1070f59bd001r7pqchlZhMeDgN","sessionID":"ses_ef8f0a775ffezAcaCgzsdw06TI","type":"step-finish","tokens":{"total":34976,"input":34814,"output":80,"reasoning":82,"cache":{"write":0,"read":0}},"cost":0}}' };

test("真实脱敏 worker 单步日志经现有服务端 raw 映射后可恢复来源与 token，不能宣称任务完成", () => {
  const raw = openCodeEventView(recordedStep);
  assert.equal(raw.kind, "raw");
  const result = normalizeAuditEvent(raw);
  assert.equal(result.parse_status, "structured");
  assert.equal(result.domain, "platform"); assert.equal(result.task_id, "fa-supply-deploy-r3");
  assert.equal(result.session_id, "ses_ef8f0a775ffezAcaCgzsdw06TI");
  assert.equal(result.part_id, "prt_1070f738c001hnjcwRiNtxo6P9");
  assert.equal(result.label, "单步结束"); assert.equal(result.status, "ended"); assert.equal(result.semantic_scope, "step");
  assert.equal(result.usage.total, 34976); assert.equal(result.usage.cache_read, 0); assert.equal(result.usage.cost, 0);
  assert.equal(Object.hasOwn(result, "task_status"), false); assert.doesNotMatch(result.label, /任务完成|本轮完成|COMPLETED/);
});

test("工具事件保留 session/call/任务身份与嵌套工具输出，completed 仅属于工具", () => {
  const source = worker({ type: "tool_use", sessionID: "ses-worker", part: { id: "prt-read", tool: "read", callID: "call-7", state: {
    status: "completed", metadata: { title: "读取源码" }, input: { filePath: "src/example.py", offset: 20 }, output: JSON.stringify({ output: "20: return allowed" }),
  } } });
  const before = structuredClone(source), result = normalizeAuditEvent(source);
  assert.deepEqual(source, before); assert.equal(result.tool, "read"); assert.equal(result.call_id, "call-7"); assert.equal(result.part_id, "prt-read");
  assert.equal(result.label, "读取源码"); assert.equal(result.body, "20: return allowed"); assert.match(result.detail, /src\/example.py/);
  assert.equal(result.semantic_scope, "tool"); assert.equal(result.status, "completed"); assert.equal(result.task_id, "fa-fe-trust-r3");
});

test("text/error/start/status 各自保留语义且 HTML 仅作为文本返回", () => {
  assert.equal(normalizeAuditEvent(worker({ type: "text", part: { text: "<img src=x onerror=alert(1)>" } })).body, "<img src=x onerror=alert(1)>");
  const failed = normalizeAuditEvent(worker({ type: "error", error: { message: "工具不可用" } }, "[python/task:one] ", { source: "stderr", kind: "error" }));
  assert.equal(failed.body, "工具不可用"); assert.equal(failed.kind, "error"); assert.equal(failed.task_id, "task:one");
  assert.equal(normalizeAuditEvent(worker({ type: "step_start" })).label, "单步开始");
  assert.equal(normalizeAuditEvent(worker({ type: "prompt_status", status: "idle" })).status, "idle");
  assert.equal(normalizeAuditEvent(worker({ type: "prompt_request_started", message: "已提交" })).body, "已提交");
});

test("现有服务端 step_finish 也改称单步结束，不猜测已丢失的数字 token", () => {
  const event = JSON.parse(recordedStep.message.slice(recordedStep.message.indexOf("{") ));
  const result = normalizeAuditEvent(openCodeEventView({ occurred_at: at, source: "stdout", message: JSON.stringify(event) }));
  assert.equal(result.label, "单步结束"); assert.equal(result.status, "ended"); assert.equal(result.usage, null);
  assert.match(result.body, /总计 34976/);
});

test("模型 reasoning 只返回活动标记，不能从备用字段或详情泄露正文", () => {
  const secret = "PRIVATE_REASONING_FIXTURE";
  for (const item of [
    worker({ type: "reasoning", sessionID: "ses-r", part: { text: secret, id: "prt-r" } }),
    { kind: "reasoning", body: secret, detail: secret, raw: secret, message: secret },
    { kind: "raw", event_type: "reasoning", body: secret },
    { kind: "raw", body: '[web/task-r] {"type":"reasoning","part":{"text":"' + secret },
    { kind: "raw", body: '[web/task-r] {"sessionID":"ses-r","type":"reasoning","part":{"text":"' + secret },
    { kind: "raw", body: '[web/task-r] {"sessionID":"ses-r","ty\\u0070e":"reasoning","part":{"text":"' + secret },
  ]) {
    const result = normalizeAuditEvent(item);
    assert.equal(result.label, "推理活动"); assert.equal(result.content_omitted, true);
    assert.equal(result.body, ""); assert.equal(result.detail, ""); assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  }
});

test("普通文本、未知协议、非法/截断 JSON 原样回退，不虚构工具状态", () => {
  for (const body of ["普通日志", '[web/task-a] {"type":"tool_use","part":', '[web/task-a] {"type":"future_event","data":"value"}',
    '[web/task-a] {"type":"text","text":"x"} trailing', '[unknown/task-a] {"type":"step_finish"}', '[web/../task-a] {"type":"step_finish"}',
    '[web/task-a] {"type":"text","part":{"text":"...\n…（事件内容已截断）', "{\"type\":\"tool_use\"}"] ) {
    const result = normalizeAuditEvent({ kind: "raw", body });
    assert.equal(result.body, body); assert.equal(result.kind, "raw"); assert.equal(result.status, null); assert.equal(result.usage, null);
  }
  const truncatedTool = '[web/task-a] {"type":"tool_use","part":{"state":{"input":{"type":"reasoning"},"output":"';
  assert.equal(normalizeAuditEvent({ kind: "raw", body: truncatedTool }).body, truncatedTool);
});

test("缺失/非法 token 不当成零，合法零值保留", () => {
  const result = normalizeAuditEvent(worker({ type: "step_finish", part: { tokens: { input: -1, output: "10", total: 0, cache: { read: 0 } }, cost: -1 } }));
  assert.equal(result.usage.total, 0); assert.equal(result.usage.input, null); assert.equal(result.usage.output, null); assert.equal(result.usage.cost, null);
  assert.equal(normalizeAuditEvent(worker({ type: "step_finish", part: {} })).usage, null);
});

test("稳定 key 区分同毫秒、不同任务/参数/状态的事件，并保留完全重复行", () => {
  const base = worker({ type: "tool_use", sessionID: "ses-a", part: { callID: "call-1", state: { status: "running", input: { path: "one" } } } });
  const variants = [base, { ...base, body: base.body.replace('"one"', '"two"') }, { ...base, body: base.body.replace('"running"', '"completed"') },
    { ...base, body: base.body.replace("fa-fe-trust-r3", "fa-other") }];
  const first = normalizeAuditEvents(variants);
  assert.equal(new Set(first.map(item => item.event_key)).size, 4);
  assert.deepEqual(first, normalizeAuditEvents(variants));
  assert.equal(normalizeAuditEvent(base).event_key, itemKey(normalizeAuditEvent(base)));
  const duplicate = normalizeAuditEvents([base, base]);
  assert.equal(duplicate.length, 2); assert.notEqual(duplicate[0].event_key, duplicate[1].event_key);
  assert.deepEqual(normalizeAuditEvents(null), []);
});
