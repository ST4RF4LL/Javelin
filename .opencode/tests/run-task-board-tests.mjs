import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL, atomicJson, hash, normalizeApiList } from "../lib/task-board/contract.mjs";
import { createBoard, readBoard, TaskBoardStore } from "../lib/task-board/store.mjs";
import { TaskBoardService, workerConfiguration } from "../lib/task-board/service.mjs";
import { acceptReview, finalizeBoard, prepareReview, verifyBoardCompletion } from "../lib/task-board/review.mjs";
import { AuditRunner } from "../web/dynamic-validation-observatory/audit-runner.mjs";
import { auditsFromArtifacts } from "../web/dynamic-validation-observatory/workspace-model.mjs";

const scope = "a".repeat(64), auditId = "audit-board-test";
const task = (id, domain = "java", extra = {}) => ({ task_id: id, kind: "focus_area", title: `审查 ${id}`, domain, source_ref: `threat:${id}`, prompt: "分析指定业务路径及权限控制。", code_refs: [], ...extra });
async function fixture(t, apiList = "") {
  const root = await mkdtemp(join(tmpdir(), "task-board-")), reportsRoot = join(root, "reports"), path = join(root, "state", "board.json");
  await mkdir(reportsRoot); await createBoard({ path, auditId, apiList });
  const store = await new TaskBoardStore({ path, reportsRoot, auditId, scopeDigest: scope }).open();
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, path, reportsRoot, store };
}
async function deliver(store, root, job, report = { summary: "已检查入口与授权路径。", findings: [], gaps: [] }) {
  const work = join(root, job.attempt.attempt_id); await mkdir(work, { recursive: true });
  await writeFile(join(work, "report.json"), typeof report === "string" ? report : JSON.stringify(report));
  const receipt = { protocol: PROTOCOL, audit_id: auditId, task_id: job.task.task_id, attempt_id: job.attempt.attempt_id, outcome: "REPORTED", report_path: "report.json" };
  await store.receive({ taskId: job.task.task_id, attemptId: job.attempt.attempt_id, receipt, inputRoot: work });
  return { work, receipt };
}
async function artifact(root, name, value) {
  const path = `validation/${name}.json`; await atomicJson(join(root, path), value);
  return { path, sha256: hash(await readFile(join(root, path))) };
}
async function quality(root, inputRef, tasks, overrides = {}) {
  return artifact(root, "quality", { protocol: PROTOCOL, audit_id: auditId, input_sha256: inputRef.sha256, role: "REPORT_REVIEW", agent_session_id: "session-quality",
    assessments: tasks.map(row => ({ task_id: row.task_id, status: "REVIEWED", reason: "已核对任务要求和源码。", evidence_refs: ["src/handler.java:1"], gaps: [] })), ...overrides });
}

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const afterAbort = signal => signal.aborted ? Promise.resolve() : new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
async function timeoutFixture(t, worker, leaseMs = 100) {
  const context = await fixture(t); const { root, path, reportsRoot, store } = context;
  await store.publish({ tasks: [task("deadline")] });
  const service = new TaskBoardService({ path, reportsRoot, privateRoot: join(root, "service"), workspaceRoot: root,
    sourceRoot: root, auditId, scopeDigest: scope, environment: {}, worker, leaseMs });
  service.store = store;
  // Use the execution kernel directly: no server, dispatch API, model or browser.
  const keepAlive = setTimeout(() => {}, 5000); t.after(() => clearTimeout(keepAlive));
  const start = async () => {
    const job = await store.claim("java", leaseMs), controller = new AbortController();
    assert.ok(job);
    const active = { job, controller, promise: null }; service.active.set("java", active);
    active.promise = service.execute(active).finally(() => service.active.delete("java"));
    return active;
  };
  return { ...context, service, start };
}
async function writeWorkerDelivery({ input, job }, report = { summary: "截止前完整交付", findings: [], gaps: [] }, overrides = {}) {
  await atomicJson(input.report_path, report);
  await atomicJson(input.receipt_path, { protocol: PROTOCOL, audit_id: auditId, task_id: job.task.task_id,
    attempt_id: input.attempt_id, outcome: "REPORTED", report_path: "report.json", ...overrides });
}

test("硬截止回收截止前完整快照，worker非零退出和迟到改写不丢失或替换报告", async t => {
  const originalReport = { summary: "截止前完整交付", findings: [], gaps: [] };
  const { store, start, reportsRoot } = await timeoutFixture(t, async args => {
    await writeWorkerDelivery(args, originalReport);
    await afterAbort(args.signal);
    await atomicJson(args.input.report_path, { summary: "截止后改写", findings: [], gaps: [] });
    throw new Error("专业 Agent 退出码：1。");
  });
  const active = await start(); await active.promise;
  const board = store.snapshot(), row = board.tasks[0];
  assert.equal(active.controller.signal.aborted, true);
  assert.equal(row.status, "REPORTED"); assert.equal(row.failure_count, undefined); assert.equal(row.attempt_count, 1);
  assert.equal(board.attempts[0].status, "REPORTED");
  assert.deepEqual(JSON.parse(await readFile(join(reportsRoot, row.report.path), "utf8")), originalReport);
});

test("硬截止拒绝半写回执、半写报告、缺报告、其他attempt和越界路径，保留超时原因", async t => {
  for (const kind of ["receipt-partial", "report-partial", "report-missing", "other-attempt", "outside-path"]) await t.test(kind, async t => {
    const { store, start } = await timeoutFixture(t, async args => {
      if (kind !== "report-missing") await atomicJson(args.input.report_path, { summary: "测试报告", findings: [], gaps: [] });
      const receipt = { protocol: PROTOCOL, audit_id: auditId, task_id: args.job.task.task_id, attempt_id: args.input.attempt_id,
        outcome: "REPORTED", report_path: "report.json" };
      if (kind === "other-attempt") receipt.attempt_id = "attempt-stale";
      if (kind === "outside-path") receipt.report_path = "../outside.json";
      await writeFile(args.input.receipt_path, kind === "receipt-partial" ? '{"protocol":' : JSON.stringify(receipt));
      if (kind === "report-partial") await writeFile(args.input.report_path, '{"summary":');
      await afterAbort(args.signal); throw new Error("专业 Agent 退出码：1。");
    }, 70);
    await (await start()).promise;
    const board = store.snapshot();
    assert.equal(board.tasks[0].status, "PENDING"); assert.equal(board.tasks[0].report, null);
    assert.equal(board.tasks[0].failure_count, 1); assert.equal(board.attempts[0].reason, "任务执行超时。");
  });
});

test("硬截止之后才写出的完整回执不能补交", async t => {
  const { store, start } = await timeoutFixture(t, async args => {
    await afterAbort(args.signal); await writeWorkerDelivery(args);
    throw new Error("专业 Agent 退出码：1。");
  }, 60);
  await (await start()).promise;
  assert.equal(store.snapshot().tasks[0].status, "PENDING"); assert.equal(store.snapshot().tasks[0].report, null);
  assert.equal(store.snapshot().tasks[0].reason, "任务执行超时。");
});

test("回执异步读取跨过硬截止不能形成及时快照", async t => {
  const entered = deferred(), release = deferred(), finished = deferred();
  const { store, start } = await timeoutFixture(t, async args => {
    await writeWorkerDelivery(args); await afterAbort(args.signal); release.resolve();
    throw new Error("专业 Agent 退出码：1。");
  });
  const prepare = store.prepareReceipt.bind(store);
  t.mock.method(store, "prepareReceipt", async input => {
    const snapshot = await prepare(input); entered.resolve(); await release.promise; finished.resolve(); return snapshot;
  });
  const active = await start(); await entered.promise; await active.promise; await finished.promise;
  assert.equal(store.snapshot().tasks[0].status, "PENDING"); assert.equal(store.snapshot().tasks[0].report, null);
});

test("用户暂停拒绝已有快照与取消过程中迟到的读取，且不累计执行失败", async t => {
  for (const crossCancel of [false, true]) await t.test(crossCancel ? "读取跨取消" : "取消前已有快照", async t => {
    const entered = deferred(), release = deferred();
    const { store, start, service } = await timeoutFixture(t, async args => {
      await writeWorkerDelivery(args); await afterAbort(args.signal); release.resolve();
      throw new Error("专业 Agent 退出码：1。");
    }, 1000);
    const prepare = store.prepareReceipt.bind(store);
    t.mock.method(store, "prepareReceipt", async input => {
      const snapshot = await prepare(input); entered.resolve(); if (crossCancel) await release.promise; return snapshot;
    });
    const active = await start(); await entered.promise;
    if (!crossCancel) await new Promise(resolve => setImmediate(resolve));
    await service.pause(); await active.promise;
    assert.equal(store.snapshot().tasks[0].status, "PENDING"); assert.equal(store.snapshot().tasks[0].report, null);
    assert.equal(store.snapshot().tasks[0].failure_count, undefined); assert.equal(store.snapshot().attempts[0].status, "INTERRUPTED");
  });
});

test("硬截止快照排队提交期间用户暂停仍优先，不能封存报告", async t => {
  for (const resumeImmediately of [false, true]) await t.test(resumeImmediately ? "暂停后立即恢复" : "保持暂停", async t => {
    const entered = deferred(), release = deferred();
    const { store, start, service } = await timeoutFixture(t, async args => {
      await writeWorkerDelivery(args); await afterAbort(args.signal); throw new Error("专业 Agent 退出码：1。");
    });
    const receive = store.receivePreparedReceipt.bind(store);
    t.mock.method(store, "receivePreparedReceipt", async (...args) => { entered.resolve(); await release.promise; return receive(...args); });
    t.mock.method(service, "pump", () => {});
    const active = await start(); await entered.promise;
    const paused = service.pause();
    if (resumeImmediately) service.resume();
    release.resolve(); await paused; await active.promise;
    assert.equal(store.snapshot().tasks[0].status, "PENDING"); assert.equal(store.snapshot().tasks[0].report, null);
    assert.equal(store.snapshot().tasks[0].failure_count, undefined);
    assert.equal(active.deliveryRevoked, true);
  });
});

test("连续三次硬截止失败封顶，清理旧轮询后不重复收件", async t => {
  let preparations = 0;
  const { store, start } = await timeoutFixture(t, async args => {
    await atomicJson(args.input.receipt_path, { protocol: PROTOCOL, audit_id: auditId, task_id: args.job.task.task_id,
      attempt_id: args.input.attempt_id, outcome: "REPORTED", report_path: "report.json" });
    await afterAbort(args.signal); throw new Error("专业 Agent 退出码：1。");
  }, 50);
  const prepare = store.prepareReceipt.bind(store);
  t.mock.method(store, "prepareReceipt", async input => { preparations++; return prepare(input); });
  for (let count = 1; count <= 3; count++) {
    await (await start()).promise;
    assert.equal(store.snapshot().tasks[0].failure_count, count);
    assert.equal(store.snapshot().tasks[0].status, count < 3 ? "PENDING" : "FAILED");
  }
  assert.equal(await store.claim("java", 50), null);
  const before = preparations; await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(preparations, before);
});

test("截止快照继续拒绝已失效attempt，不绕过正常收件绑定", async t => {
  const { store, root } = await fixture(t); await store.publish({ tasks: [task("one")] });
  const old = await store.claim("java", 1000), work = join(root, "snapshot"); await mkdir(work);
  await atomicJson(join(work, "report.json"), { summary: "旧尝试报告", findings: [], gaps: [] });
  const receipt = { protocol: PROTOCOL, audit_id: auditId, task_id: old.task.task_id, attempt_id: old.attempt.attempt_id,
    outcome: "REPORTED", report_path: "report.json" };
  const snapshot = await store.prepareReceipt({ taskId: old.task.task_id, attemptId: old.attempt.attempt_id, receipt, inputRoot: work });
  await assert.rejects(store.receivePreparedReceipt({}), /未经当前任务服务验证/);
  await store.fail(old.task.task_id, old.attempt.attempt_id, "模拟旧尝试失效"); await store.claim("java", 1000);
  await assert.rejects(store.receivePreparedReceipt(snapshot), /旧执行尝试/); assert.equal(store.summary().reported, 0);
});

test("普通成功与崩溃回收的异步读取或排队期间暂停均撤销交付，恢复不复活旧attempt", async t => {
  for (const crash of [false, true]) for (const stage of ["session", "read", "queue"]) for (const resume of [false, true]) {
    await t.test(`${crash ? "崩溃回收" : "正常成功"}/${stage}/${resume ? "立即恢复" : "保持暂停"}`, async t => {
      const ready = deferred(), proceed = deferred(), entered = deferred(), release = deferred();
      const { store, service, start } = await timeoutFixture(t, async args => {
        await writeWorkerDelivery(args); ready.resolve(); await proceed.promise;
        const result = stage === "session" ? { session_id: "fixture-session" } : {};
        if (crash) throw Object.assign(new Error("模拟进程退出"), result);
        return result;
      }, 1000);
      t.mock.method(service, "pump", () => {});
      const active = await start(); await ready.promise;
      if (stage === "read") {
        const prepare = store.prepareReceipt.bind(store);
        t.mock.method(store, "prepareReceipt", async input => {
          const snapshot = await prepare(input);
          if (!input.requireCompleteJson) { entered.resolve(); await release.promise; }
          return snapshot;
        });
      } else {
        const mutate = store.mutate.bind(store);
        if (stage === "queue") store.queue = release.promise;
        let intercepted = false;
        t.mock.method(store, "mutate", async operation => {
          if (intercepted) return mutate(operation);
          intercepted = true;
          if (stage === "queue") { const pending = mutate(operation); entered.resolve(); return pending; }
          const value = await mutate(operation); entered.resolve(); await release.promise; return value;
        });
      }
      proceed.resolve(); await entered.promise;
      const paused = service.pause(); if (resume) service.resume(); release.resolve();
      await paused; await active.promise;
      const board = store.snapshot();
      assert.equal(board.tasks[0].status, "PENDING"); assert.equal(board.tasks[0].report, null);
      assert.equal(board.tasks[0].failure_count, undefined); assert.equal(board.attempts[0].status, "INTERRUPTED");
      assert.equal(store.summary().reported, 0); assert.equal(active.deliveryRevoked, true);
    });
  }
});

test("未取消的普通成功和非超时崩溃继续按原收件合同接收，内容质量留给独立复核", async t => {
  for (const crash of [false, true]) await t.test(crash ? "崩溃回收" : "正常成功", async t => {
    const { store, start } = await timeoutFixture(t, async args => {
      await writeWorkerDelivery(args);
      await writeFile(args.input.report_path, "原收件合同允许交付后由独立复核登记解析或内容缺口。");
      if (crash) throw new Error("模拟进程退出");
      return {};
    }, 1000);
    await (await start()).promise;
    assert.equal(store.snapshot().tasks[0].status, "REPORTED");
    assert.equal(store.snapshot().tasks[0].failure_count, undefined);
  });
});

test("API 清单保留自由文本、重复条目与稳定来源，不按路由正则过滤", () => {
  const rows = normalizeApiList("GET /one\n描述尚未明确的接口\nGET /one");
  assert.equal(rows.length, 3); assert.equal(rows[1].text, "描述尚未明确的接口"); assert.notEqual(rows[0].source_id, rows[2].source_id);
  assert.deepEqual(rows, normalizeApiList("GET /one\n描述尚未明确的接口\nGET /one"));
  assert.equal(normalizeApiList('[{"method":"POST","path":"/two"}]').length, 1);
});

test("发布封存核对全部 API，Focus/API 并列，重复发布幂等且拒绝漂移", async t => {
  const { store } = await fixture(t, "GET /one\nPOST /two");
  const sources = store.snapshot().api_sources;
  await store.publish({ tasks: [task("risk"), task("api-one", "java", { kind: "api", source_ref: sources[0].source_id })] });
  await assert.rejects(store.seal(), /API 未发布/);
  await store.publish({ tasks: [task("api-two", "python", { kind: "api", source_ref: sources[1].source_id })] });
  await store.seal(); await store.publish({ tasks: [task("risk")] });
  await assert.rejects(store.publish({ tasks: [task("risk", "web")] }), /内容不同/);
  await assert.rejects(store.publish({ tasks: [task("new")] }), /封存/);
  assert.equal(store.summary().tracks.api.total, 2); assert.equal(store.summary().tracks.focus_area.total, 1);
});

test("并发领取每领域唯一；旧尝试隔离；收报告不判断内容；重复回执不重复执行", async t => {
  const { root, store } = await fixture(t);
  await store.publish({ tasks: [task("one"), task("two")] });
  const claims = await Promise.all([store.claim("java", 5000), store.claim("java", 5000)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const old = claims.find(Boolean); await store.fail(old.task.task_id, old.attempt.attempt_id, "模拟中断");
  const current = await store.claim("java", 5000);
  await assert.rejects(deliver(store, root, old), /旧执行/);
  const received = await deliver(store, root, current, "内容留给后续 Agent 判断，当前仅收件。");
  await store.receive({ taskId: current.task.task_id, attemptId: current.attempt.attempt_id, receipt: received.receipt, inputRoot: received.work });
  assert.equal(store.summary().reported, 1);
  assert.equal(store.summary().validation.status, "NOT_STARTED");
  assert.equal(store.summary().mining_complete, false);
});

test("拒绝路径逃逸与报告符号链接", async t => {
  const { root, store } = await fixture(t); await store.publish({ tasks: [task("one")] });
  const job = await store.claim("java", 5000), work = join(root, "work"); await mkdir(work);
  const outside = join(root, "outside.json"); await writeFile(outside, "{}"); await symlink(outside, join(work, "report.json"));
  const receipt = { protocol: PROTOCOL, audit_id: auditId, task_id: "one", attempt_id: job.attempt.attempt_id, outcome: "REPORTED", report_path: "report.json" };
  await assert.rejects(store.receive({ taskId: "one", attemptId: job.attempt.attempt_id, receipt, inputRoot: work }), /普通文件/);
  await assert.rejects(store.receive({ taskId: "one", attemptId: job.attempt.attempt_id, receipt: { ...receipt, report_path: "../outside.json" }, inputRoot: work }), /受控目录/);
  assert.equal(store.summary().reported, 0);
});

test("服务恢复保留已交报告，旧 RUNNING 回收，活跃服务不能重复接管", async t => {
  const { root, path, reportsRoot, store } = await fixture(t);
  await assert.rejects(new TaskBoardStore({ path, reportsRoot, auditId, scopeDigest: scope }).open(), /运行中/);
  await store.publish({ tasks: [task("one"), task("two", "web")] });
  await deliver(store, root, await store.claim("java", 5000)); await store.claim("web", 5000); await store.close();
  const recovered = await new TaskBoardStore({ path, reportsRoot, auditId, scopeDigest: scope }).open();
  assert.equal(recovered.summary().reported, 1); assert.equal(recovered.summary().pending, 1);
  await recovered.close();
});

test("monitor 同领域串行、跨领域并行、报告收齐不等于复核完成", async t => {
  const { root, path, reportsRoot, store } = await fixture(t); await store.close();
  const busy = new Set(), order = []; let peak = 0;
  const service = new TaskBoardService({ path, reportsRoot, privateRoot: join(root, "service"), workspaceRoot: root, sourceRoot: root, auditId, scopeDigest: scope, environment: {},
    worker: async ({ job, input, workRoot }) => {
      assert.ok(!busy.has(job.task.domain)); busy.add(job.task.domain); peak = Math.max(peak, busy.size); order.push(job.task.task_id);
      await new Promise(resolve => setTimeout(resolve, 20));
      await writeFile(input.report_path, JSON.stringify({ summary: "模拟审查", findings: [], gaps: [] }));
      await atomicJson(input.receipt_path, { protocol: PROTOCOL, audit_id: auditId, task_id: job.task.task_id, attempt_id: input.attempt_id, outcome: "REPORTED", report_path: "report.json" });
      busy.delete(job.task.domain); return { session_id: `session-${job.task.task_id}` };
    } });
  await service.start(); t.after(() => service.shutdown());
  await service.store.publish({ tasks: [task("a"), task("b"), task("c", "web")] }); await service.store.seal(); service.pump();
  const deadline = Date.now() + 3000;
  while (!service.store.summary().mining_complete && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.store.summary().reported, 3); assert.ok(peak >= 2); assert.ok(order.indexOf("a") < order.indexOf("b"));
  assert.equal(service.store.summary().validation.status, "NOT_STARTED");
  const response = await fetch(`${service.endpoint}/status`, { method: "POST", headers: { Authorization: `Bearer ${service.token}`, "Content-Type": "application/json" }, body: "{}" });
  assert.equal((await response.json()).mining_complete, true);
  await service.shutdown();
});

test("零发现报告也须质量复核，封存后校验原报告与最终报告摘要", async t => {
  const { root, reportsRoot, store, path } = await fixture(t);
  await store.publish({ tasks: [task("one")] }); await deliver(store, root, await store.claim("java", 5000)); await store.seal();
  await assert.rejects(finalizeBoard(store), /复核未完成/);
  const input = await prepareReview(store); const qualityRef = await quality(reportsRoot, input, store.snapshot().tasks);
  await acceptReview(store, { quality: qualityRef }); await finalizeBoard(store);
  const audit = { id: auditId, task_board_path: path, source_baseline: { scope_digest: scope } };
  assert.equal((await verifyBoardCompletion({ audit, reportsRoot })).complete, true);
  const board = await readBoard(path); await writeFile(join(reportsRoot, board.tasks[0].report.path), "changed");
  assert.equal((await verifyBoardCompletion({ audit, reportsRoot })).complete, false);
});

test("内容缺陷留到后续复核处理，不能将格式缺口标成审查充分", async t => {
  const { root, reportsRoot, store } = await fixture(t);
  await store.publish({ tasks: [task("one")] }); await deliver(store, root, await store.claim("java", 5000), "not json"); await store.seal();
  const input = await prepareReview(store), ref = await quality(reportsRoot, input, store.snapshot().tasks);
  await assert.rejects(acceptReview(store, { quality: ref }), /解析失败/);
  const gap = await quality(reportsRoot, input, [], { assessments: [{ task_id: "one", status: "NEEDS_FOLLOWUP", reason: "报告格式不足", evidence_refs: [], gaps: ["需补充分析结果"] }] });
  await acceptReview(store, { quality: gap }); const result = await finalizeBoard(store); assert.ok(result.gaps > 0);
});

test("候选必须由不同会话三方复核，不能遗漏候选或复用同一会话", async t => {
  const { root, reportsRoot, store } = await fixture(t);
  await store.publish({ tasks: [task("one")] });
  await deliver(store, root, await store.claim("java", 5000), { summary: "权限分析", findings: [{ finding_id: "F1", title: "待确认权限问题" }], gaps: [] }); await store.seal();
  const inputRef = await prepareReview(store), input = JSON.parse(await readFile(join(reportsRoot, inputRef.path), "utf8"));
  const bundle = { quality: await quality(reportsRoot, inputRef, store.snapshot().tasks) };
  for (const [role, verdict] of [["AFFIRMATIVE", "PROVEN"], ["NEGATIVE", "NOT_REFUTED"], ["MODERATOR", "TRUE_POSITIVE"]]) {
    bundle[role.toLowerCase()] = await artifact(reportsRoot, role, { protocol: PROTOCOL, audit_id: auditId, input_sha256: inputRef.sha256, role, agent_session_id: `session-${role}`,
      ...(bundle.affirmative ? { affirmative_sha256: bundle.affirmative.sha256 } : {}), ...(bundle.negative ? { negative_sha256: bundle.negative.sha256 } : {}),
      findings: input.candidates.map(candidate => ({ candidate_id: candidate.candidate_id, verdict, reason: "已独立回查源码", evidence_refs: ["src/handler.java:1"], gaps: [] })) });
  }
  await assert.rejects(acceptReview(store, { ...bundle, negative: bundle.affirmative }), /角色/);
  await acceptReview(store, bundle); const result = await finalizeBoard(store); assert.equal(result.findings, 1);
});

test("专业 worker 复用领域知识和索引权限，禁用浏览器与嵌套任务", async () => {
  const { config, agent } = await workerConfiguration({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { "chrome-devtools": { enabled: true }, jvm_index: { enabled: true } } }) }, { domain: "java", agent_name: "java-source-auditor" });
  assert.equal(config.agent[agent].mode, "primary");
  assert.equal(config.agent[agent].permission["jvm_index_*"], "allow");
  assert.equal(config.agent[agent].permission.task, "deny"); assert.equal(config.mcp["chrome-devtools"].enabled, false);
  assert.match(config.agent[agent].prompt, /Audit Dimensions/); assert.doesNotMatch(config.agent[agent].prompt, /## Stage\/Agent I\/O Contract/);
});

test("新建工作台任务默认进入面板，API 原文可恢复，monitor 到最终报告完整连接且动态 SKIPPED", async t => {
  const root = await mkdtemp(join(tmpdir(), "board-runner-"));
  const source = join(root, "source"), configPath = join(root, ".opencode", "opencode.json");
  await mkdir(source); await writeFile(join(source, "api.js"), "export function getOrder() { return {}; }\n");
  await atomicJson(configPath, { mcp: {} });
  const child = new EventEmitter(); child.pid = 12345; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = signal => { if (signal === "SIGTERM") queueMicrotask(() => child.emit("close", 0, signal)); return true; };
  let launch;
  const runner = new AuditRunner({ stateRoot: join(root, "state"), platformRoot: root, configPath, enabled: true,
    terminalMonitor: { async probe() { return { available: false, message: "测试使用受控进程替身" }; }, async stop() {} },
    spawnProcess(command, args, options) { launch = { command, args, options }; return child; } });
  t.after(async () => { await runner.shutdown(); await rm(root, { recursive: true, force: true }); });
  runner.setQueueScheduler({ async enqueueNewAudit() { return true; } });
  const snapshot = { target_id: "fixture", target_name: "源码夹具", source_scopes: [{ id: "source-one", path: await realpath(source) }] };
  const apiText = "GET /orders/{id} 订单详情\n尚待定位的第二个接口";
  const created = await runner.createAuditFromTarget({ audit_id: auditId, target_id: "fixture", execution_spec: snapshot,
    execution_spec_digest: hash(JSON.stringify(snapshot)), api_inventory: apiText, bac_analysis: "off",
    runtime_testing: { protocol: "runtime-testing.v1", mode: "CONTACT_ONLY", budget_minutes: 10, identity_mode: "auto", allowed_actions: ["navigate"], explicit_authorization: false } }, "create-board-fixture");
  assert.equal(created.task_protocol, PROTOCOL); assert.equal(created.task_board.api_inventory.submitted, 2);
  assert.equal((await runner.retryDraft(created.id)).api_inventory, apiText);
  assert.equal((await runner.taskBoardPage(created.id)).items.length, 0);
  await runner.dispatchQueuedAudit(created.id);
  assert.equal(launch.options.env.AUDIT_TASK_PROTOCOL, PROTOCOL); assert.equal(launch.options.env.AUDIT_TODO_PATH, "");
  assert.match(launch.args.at(-1), /monitor 自动按领域执行/);
  assert.equal(runner.getAudit(created.id).runtime_testing_state.status, "SKIPPED");
  const service = runner.taskBoardServices.get(created.id);
  service.worker = async ({ job, input }) => {
    await atomicJson(input.report_path, { summary: "已检查该接口的源码路径。", findings: [], gaps: [] });
    await atomicJson(input.receipt_path, { protocol: PROTOCOL, audit_id: auditId, task_id: job.task.task_id, attempt_id: input.attempt_id, outcome: "REPORTED", report_path: "report.json" });
  };
  await service.store.publish({ tasks: service.store.snapshot().api_sources.map((row, index) => task(`api-${index}`, "web", { kind: "api", source_ref: row.source_id })) });
  await service.store.seal(); service.pump();
  let deadline = Date.now() + 3000;
  while (!service.store.summary().mining_complete && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.store.summary().reported, 2);
  const projected = auditsFromArtifacts([], [], runner.listAudits())[0];
  assert.equal(projected.stage, "报告内容复核"); assert.equal(projected.progress_source, "task-board");
  const page = await runner.taskBoardPage(created.id, { kind: "api", limit: 1 }); assert.equal(page.items.length, 1); assert.equal(page.next_offset, 1);
  const inputRef = await prepareReview(service.store, { runtimeRequired: true });
  await acceptReview(service.store, { quality: await quality(service.reportsRoot, inputRef, service.store.snapshot().tasks) }); await finalizeBoard(service.store);
  child.emit("close", 0, null);
  deadline = Date.now() + 3000;
  while (runner.getAudit(created.id).status === "running" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runner.getAudit(created.id).status, "completed", runner.getAudit(created.id).error);
  assert.equal(runner.taskBoardServices.size, 0);
});
