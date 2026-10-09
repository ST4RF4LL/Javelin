// Offline contract tests: no target application, browser, or audit Agent is started.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { bacFixture, readJson, writeJson, reviewedFinding } from "./fixtures/bac.mjs";
import { objectDigest as manifestDigest } from "../skills/common-subagent/audit-coverage-accounting/scripts/coverage-v2-common.mjs";
import { BAC_CONTRACT, TASK_PLAN, BAC_EVIDENCE_STRUCTURE_ERROR, seal, validateReview, verifiedPlan } from "../lib/bac/contract.mjs";
import { compareBac, prepareBac, prepareReview as prepareBacReview, reviewBac } from "../lib/bac/service.mjs";
import { validateBacSummary } from "../lib/bac/summary.mjs";
import { atomicJson, hash, PROTOCOL } from "../lib/task-board/contract.mjs";
import { createBoard, TaskBoardStore } from "../lib/task-board/store.mjs";
import { prepareTaskBacPlan, summarizeTaskBac } from "../lib/task-board/bac.mjs";
import { acceptReview, finalizeBoard, prepareReview, validateReviewBundle, verifyBoardCompletion } from "../lib/task-board/review.mjs";
import { TaskBoardService } from "../lib/task-board/service.mjs";
import { correctReport } from "../lib/task-board/report-correction.mjs";
import { seal as sealRuntime } from "../lib/runtime-testing/contract.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../scripts/bac-analysis.mjs", import.meta.url));
async function artifact(root, path, value) {
  await atomicJson(join(root, path), value);
  return { path, sha256: hash(await readFile(join(root, path))) };
}
async function fixture(t, { kind = "focus_area", domain = "java", mode = "auto", missingPolicies = false } = {}) {
  const f = await bacFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  f.source = await realpath(f.source); f.reports = await realpath(f.reports);
  for (const key of ["acp", "paths", "api_catalog"]) f.request[key].repository.root = f.source;
  f.auditId = f.plan.audit_id; f.scope = f.plan.scope_digest;
  f.boardPath = join(f.root, "board.json");
  await createBoard({ path: f.boardPath, auditId: f.auditId, scopeDigest: f.scope, miningStrategy: kind,
    apiList: kind === "api" ? "读取当前订单（自由描述）" : "", bacMode: mode });
  f.store = await new TaskBoardStore({ path: f.boardPath, reportsRoot: f.reports, auditId: f.auditId, scopeDigest: f.scope }).open();
  t.after(() => f.store.close());
  const board = f.store.snapshot();
  f.apiId = kind === "api" ? board.api_sources[0].source_id : "interface-order";
  f.request.paths.paths[0].api_id = f.apiId; f.request.api_catalog.apis[0].api_id = f.apiId;
  const policy = await artifact(f.reports, "bac/policy.json", { contract_version: BAC_CONTRACT, artifact_type: "bac-policy-shard",
    audit_id: f.auditId, scope_digest: f.scope, task_ids: ["task-order"], acp: f.request.acp });
  const catalog = await artifact(f.reports, "bac/catalog.json", { contract_version: BAC_CONTRACT, artifact_type: "bac-resource-role-catalog", audit_id: f.auditId, scope_digest: f.scope, ...f.request.resource_role_catalog });
  const baseline = { audit_id: f.auditId, scope_digest: f.scope, root: f.source, files: f.plan.source_index, complete: true, errors: [] };
  baseline.manifest_digest = manifestDigest(baseline);
  await artifact(f.reports, `coverage/source-baseline.${f.auditId}.json`, baseline);
  f.spec = { task_id: "task-order", kind, domain, title: "订单访问控制", prompt: "审查订单读取的直接所有者约束。",
    source_ref: kind === "api" ? f.apiId : "FA-ORDER", code_refs: [{ path: "src/OrderService.java", line: 2 }],
    bac_analysis: { entry_points: [{ api_id: f.apiId, operation: "读取订单" }], ...(missingPolicies ? {} : { policy_shards: [policy], resource_role_catalog: catalog }) } };
  await f.store.publish({ tasks: [f.spec] }); await f.store.seal();
  return f;
}
async function claim(f) {
  f.job = await f.store.claim(f.spec.domain, 30_000);
  f.planRef = await prepareTaskBacPlan({ board: f.store.snapshot(), ...f.job, reportsRoot: f.reports, sourceRoot: f.source });
  await f.store.mutate(board => { board.attempts.at(-1).bac_plan = f.planRef; });
  f.nativePlan = await verifiedPlan(join(f.reports, f.planRef.path));
  return f;
}
async function compare(f, { viaCli = false, incomplete = false, noMismatch = false } = {}) {
  const options = { planPath: join(f.reports, f.planRef.path), sourceRoot: f.source, reportsRoot: f.reports,
    taskId: f.job.task.task_id, attemptId: f.job.attempt.attempt_id, sessionId: "source-session-1", runId: "task-run-1" };
  const prepared = viaCli ? JSON.parse((await execute(process.execPath, [cli, "prepare", "--plan", options.planPath, "--source-root", f.source,
    "--reports-root", f.reports, "--task", options.taskId, "--attempt", options.attemptId, "--session", options.sessionId, "--run-id", options.runId])).stdout) : await prepareBac(options);
  f.prepared = prepared;
  const request = await readJson(prepared.request_path);
  assert.equal(request.plan_digest, f.nativePlan.artifact_digest);
  assert.equal(request.paths.coverage.status, "PARTIAL");
  request.paths = structuredClone(f.request.paths); request.paths.producer = request.producer;
  request.api_catalog = structuredClone(f.request.api_catalog);
  if (incomplete) request.paths.paths[0].known_gaps = ["尚未解析条件分支。"];
  if (noMismatch) for (const key of Object.keys(request.paths.paths[0].implemented_controls.hac)) if (key !== "evidence") request.paths.paths[0].implemented_controls.hac[key] = true;
  await writeJson(prepared.request_path, request); f.nativeRequest = request;
  f.compared = await compareBac({ requestPath: prepared.request_path, reportsRoot: f.reports });
  f.run = await readJson(f.compared.run_path);
  return f;
}
async function deliver(f, { receiveReport = true } = {}) {
  const reviewPath = join(f.root, "native-review.json");
  const template = await prepareBacReview({ runPath: f.compared.run_path, output: reviewPath });
  assert.equal(template.routing.task_id, f.spec.task_id); assert.equal(template.checks, undefined);
  const review = await readJson(reviewPath);
  if (review.decisions.length) {
    const finding = reviewedFinding(f, f.run);
    finding.routing = { ...template.routing, threat_ids: ["T-ORDER"] };
    if (f.spec.domain === "web") finding.classification.origin_lens = "sink-driven";
    review.decisions[0] = { bac_finding_id: f.run.result.findings[0].finding_id, disposition: "ACCEPTED", reason: "已检查源码及反证。", finding };
  }
  f.review = review;
  await writeJson(reviewPath, review);
  f.delivery = await reviewBac({ runPath: f.compared.run_path, reviewPath, reportsRoot: f.reports });
  f.report = { protocol: PROTOCOL, audit_id: f.auditId, task_id: f.spec.task_id, attempt_id: f.job.attempt.attempt_id,
    agent_session_id: f.run.producer.agent_session_id, summary: "已按任务范围完成独立策略与实际路径差分。", findings: f.delivery.findings, gaps: [], bac_analysis: f.delivery.attachment };
  if (receiveReport) await receive(f, f.report);
  return f;
}
async function receive(f, report) {
  const work = join(f.root, "worker"); await mkdir(work, { recursive: true });
  await writeFile(join(work, "report.json"), typeof report === "string" ? report : JSON.stringify(report));
  await f.store.receive({ taskId: f.spec.task_id, attemptId: f.job.attempt.attempt_id, inputRoot: work,
    receipt: { protocol: PROTOCOL, audit_id: f.auditId, task_id: f.spec.task_id, attempt_id: f.job.attempt.attempt_id, outcome: "REPORTED", report_path: "report.json" } });
  await f.store.mutate(board => { board.attempts.at(-1).session_id = "source-session-1"; });
}
async function bundle(f, options = {}) {
  const ref = await prepareReview(f.store, { bacMode: "auto", runtimeRequired: options.runtimeRequired ?? false });
  const input = await readJson(join(f.reports, ref.path));
  return reviewDocuments(f, ref, input, options);
}
async function reviewDocuments(f, ref, input, { gap = false, taskGap = false, moderatorVerdict = "TRUE_POSITIVE" } = {}) {
  const base = { protocol: PROTOCOL, audit_id: f.auditId, input_sha256: ref.sha256 };
  const result = { quality: await artifact(f.reports, `validation/quality.${ref.sha256}.json`, { ...base, role: "REPORT_REVIEW", agent_session_id: "quality-session",
    assessments: [{ task_id: f.spec.task_id, status: taskGap ? "GAP" : "REVIEWED", reason: taskGap ? "专项证据结构尚须补齐。" : "已核查任务和源码证据。", evidence_refs: ["src/OrderService.java:4"], gaps: taskGap ? ["专项证据结构尚须补齐。"] : [] }],
    bac_analysis: { status: gap ? "GAP" : "REVIEWED", reason: gap ? "专项仍有未解析分支。" : "差分与复查附件均已核对。", evidence_refs: ["src/OrderService.java:4"] } }) };
  for (const [role, verdict] of [["AFFIRMATIVE", "PROVEN"], ["NEGATIVE", "NOT_REFUTED"], ["MODERATOR", moderatorVerdict]]) {
    result[role.toLowerCase()] = await artifact(f.reports, `validation/${role}.${ref.sha256}.json`, { ...base, role, agent_session_id: `session-${role}`,
      ...(result.affirmative ? { affirmative_sha256: result.affirmative.sha256 } : {}), ...(result.negative ? { negative_sha256: result.negative.sha256 } : {}),
      findings: input.candidates.map(row => ({ candidate_id: row.candidate_id, verdict: typeof verdict === "function" ? verdict(row) : verdict, reason: "离线样例复核。", evidence_refs: ["src/OrderService.java:4"], gaps: [] })) });
  }
  return { ref, input, result };
}

const malformedBacEvidence = () => ({ path: "src/OrderService.java", line: 4, note: "原报告只有非结构化定位。" });
const ordinaryFinding = () => ({ finding_id: "ordinary-static-finding", title: "独立于专项附件的普通源码发现", description: "普通发现继续接受独立复核。" });
const auditFor = f => ({ id: f.auditId, task_board_path: f.boardPath, mining_strategy: "focus_area", bac_analysis: { mode: "auto" }, source_baseline: { scope_digest: f.scope }, ...(f.runtimeRequired ? { runtime_testing: true } : {}) });
function notApplicableReport(f) {
  return { protocol: PROTOCOL, audit_id: f.auditId, task_id: f.spec.task_id, attempt_id: f.job.attempt.attempt_id,
    summary: "原始报告中的专项依据缺少结构字段，普通发现仍须复核。", findings: [ordinaryFinding()], gaps: [],
    bac_analysis: { contract_version: BAC_CONTRACT, status: "NOT_APPLICABLE", reason: "待核验适用性。", plan_path: join(f.reports, f.planRef.path), source_root: f.source,
      evidence: [malformedBacEvidence()] } };
}
async function malformedCompleteFixture(t, edit = () => {}) {
  const f = await fixture(t); await claim(f); await compare(f); await deliver(f, { receiveReport: false });
  const ref = f.report.bac_analysis.review, review = await readJson(join(f.reports, ref.path));
  review.evidence = [malformedBacEvidence()];
  f.report.bac_analysis.review = await artifact(f.reports, ref.path, seal(review));
  f.report.findings.push(ordinaryFinding());
  await receive(f, f.report);
  // Simulate a pre-upgrade accepted report; new deliveries are tested separately.
  await edit(f);
  const reportRef = f.store.snapshot().tasks[0].report;
  await writeFile(join(f.reports, reportRef.path), JSON.stringify(f.report));
  await f.store.mutate(board => { board.tasks[0].report.sha256 = hash(JSON.stringify(f.report)); });
  return f;
}

test("已绑定不适用附件的证据结构错误降为质量缺口，普通发现及原文摘要保留到终稿", async t => {
  const f = await fixture(t); await claim(f); await receive(f, notApplicableReport(f));
  f.runtimeRequired = true;
  const authorization = sealRuntime({ protocol: "runtime-testing.v1", audit_id: f.auditId, scope_digest: f.scope, environment_revision: 1 });
  await artifact(f.reports, `runtime-testing/${f.auditId}/authorization.json`, authorization);
  await artifact(f.reports, `runtime-testing/${f.auditId}/evidence-set.json`, sealRuntime({ protocol: "runtime-testing.v1", artifact_type: "runtime-testing-evidence-set",
    audit_id: f.auditId, environment_revision: 1, authorization_digest: authorization.artifact_digest, status: "BLOCKED", reason: "ENVIRONMENT_CONTACT_INCOMPLETE",
    cleanup_status: "NOT_REQUIRED", elapsed_ms: 0, evidence_bindings: [], packets: [] }));
  const rawRef = f.store.snapshot().tasks[0].report, rawBytes = await readFile(join(f.reports, rawRef.path));
  const b = await bundle(f, { gap: true, runtimeRequired: true });
  assert.equal(b.input.bac_summary.status, "PARTIAL"); assert.deepEqual(validateBacSummary(b.input.bac_summary), []);
  assert.equal(b.input.bac_summary.units[0].evidence_error.code, BAC_EVIDENCE_STRUCTURE_ERROR);
  assert.deepEqual(b.input.bac_summary.units[0].evidence_error.report, rawRef);
  assert.match(b.input.tasks[0].bac_gap, /证据结构无效/); assert.equal(b.input.candidates.length, 1);
  assert.equal(b.input.candidates[0].bac_gap, undefined);
  await assert.rejects(acceptReview(f.store, b.result), /专项证据缺口必须保留/);
  const accepted = await bundle(f, { gap: true, taskGap: true, runtimeRequired: true });
  assert.equal(accepted.ref.sha256, b.ref.sha256);
  await acceptReview(f.store, accepted.result); await finalizeBoard(f.store);
  const final = f.store.snapshot().final_report, model = await readJson(join(f.reports, final.model));
  assert.equal(model.findings.length, 1); assert.equal(model.bac_analysis.status, "GAP");
  assert.equal(model.runtime.status, "BLOCKED"); assert.equal(model.runtime.reason, "ENVIRONMENT_CONTACT_INCOMPLETE");
  assert.ok(model.residual_gaps.some(gap => gap.includes("证据结构无效")));
  assert.match(await readFile(join(f.reports, final.path), "utf8"), /证据结构无效/);
  assert.deepEqual(await readFile(join(f.reports, rawRef.path)), rawBytes);
  assert.equal((await verifyBoardCompletion({ audit: auditFor(f), reportsRoot: f.reports })).complete, true);
});

test("结构无效专项的关联候选不得确认，普通候选仍可确认且最终复核确定性闭合", async t => {
  const f = await malformedCompleteFixture(t);
  const b = await bundle(f, { gap: true, taskGap: true });
  assert.equal(b.input.candidates.filter(row => row.bac_gap).length, 1);
  await assert.rejects(acceptReview(f.store, b.result), /BAC 候选不得确认为真实漏洞/);
  const accepted = await bundle(f, { gap: true, taskGap: true, moderatorVerdict: row => row.finding.bac_source ? "INCONCLUSIVE" : "TRUE_POSITIVE" });
  await acceptReview(f.store, accepted.result); await finalizeBoard(f.store);
  const model = await readJson(join(f.reports, f.store.snapshot().final_report.model));
  assert.equal(model.findings.length, 1); assert.equal(model.findings[0].title, ordinaryFinding().title);
  assert.equal(model.excluded_findings.length, 1); assert.ok(model.excluded_findings[0].bac_source);
  assert.equal(model.excluded_findings[0].validation_state, "INCONCLUSIVE");
  assert.equal((await verifyBoardCompletion({ audit: auditFor(f), reportsRoot: f.reports })).complete, true);
});

test("无效专项候选的展示标记或输入被改写也不能恢复确认", async t => {
  const f = await malformedCompleteFixture(t), b = await bundle(f, { gap: true, taskGap: true });
  const board = f.store.snapshot();
  for (const [name, edit, pattern] of [
    ["删除展示标记", input => { delete input.tasks[0].bac_gap; for (const row of input.candidates) delete row.bac_gap; }, /BAC 候选不得确认为真实漏洞/],
    ["删除来源", input => { delete input.candidates.find(row => row.finding.bac_source).finding.bac_source; }, /原始候选绑定/],
    ["更改任务", input => { input.candidates[0].task_id = "another-task"; }, /原始候选绑定/],
    ["更改标识", input => { input.candidates[0].candidate_id = "another-candidate"; }, /原始候选绑定/],
    ["保留原项追加副本", input => { const copy = structuredClone(input.candidates[0]); copy.candidate_id = "copied-candidate"; copy.task_id = "another-task"; input.candidates.push(copy); }, /原始候选集合/],
    ["冒充运行候选", input => { const copy = structuredClone(input.candidates[0]); copy.candidate_id = "runtime-copy"; copy.task_id = null; copy.claim_scope = "RUNTIME_ONLY"; delete copy.finding.bac_source; input.candidates.push(copy); }, /原始候选集合/],
    ["删除质量任务", input => { input.tasks = []; }, /复核结果必须逐项覆盖输入/],
  ]) await t.test(name, async () => {
    const input = structuredClone(b.input); edit(input);
    const ref = await artifact(f.reports, `validation/tampered-${name}.json`, input);
    const docs = await reviewDocuments(f, ref, input, { gap: true, taskGap: true });
    await assert.rejects(validateReviewBundle({ ...board, validation: { ...board.validation, input: ref } }, f.reports, docs.result), pattern);
  });
});

test("证据结构错误不能掩盖审计、尝试、摘要、路径、定位或冻结来源硬门禁", async t => {
  for (const [name, edit, pattern] of [
    ["audit", (f, report) => { report.audit_id = "other-audit"; }, /任务或执行绑定无效/],
    ["attempt", (f, report) => { report.attempt_id = "old-attempt"; }, /任务或执行绑定无效/],
    ["plan-path", (f, report) => { report.bac_analysis.plan_path = f.planPath; }, /不同任务计划/],
    ["bad-locator", (f, report) => { report.bac_analysis.evidence.push({ locator: { ...f.locator(4), source_digest: "0".repeat(64) } }); }, /不属于冻结源码/],
    ["outside-source", (f, report) => { report.bac_analysis.evidence.push({ ...f.evidence(), locator: { ...f.locator(4), file: "../outside.java" } }); }, /不属于冻结源码/],
    ["line-range", (f, report) => { report.bac_analysis.evidence.push({ ...f.evidence(), locator: f.locator(999) }); }, /行号超出源码/],
    ["source-changed", async f => { await writeFile(join(f.source, "src/OrderService.java"), "changed source"); }, /源码自冻结后发生变化/],
  ]) await t.test(name, async t => {
    const f = await fixture(t); await claim(f); const report = notApplicableReport(f);
    if (name === "source-changed") report.bac_analysis.evidence.push(f.evidence());
    await edit(f, report); await receive(f, report);
    await assert.rejects(prepareReview(f.store, { bacMode: "auto" }), pattern);
    assert.equal(f.store.snapshot().validation.input, undefined);
  });
  for (const kind of ["hash", "path"]) await t.test(`report-${kind}`, async t => {
    const f = await fixture(t); await claim(f); await receive(f, notApplicableReport(f));
    await f.store.mutate(board => { if (kind === "hash") board.tasks[0].report.sha256 = "0".repeat(64); else board.tasks[0].report.path = "../outside.json"; });
    await assert.rejects(prepareReview(f.store, { bacMode: "auto" }));
  });
});

test("结构错误不能掩盖专项会话、策略、候选守恒或完成状态错误", async t => {
  for (const [name, edit, pattern] of [
    ["session", f => { f.report.agent_session_id = "other-session"; }, /生产会话绑定/],
    ["finding-changed", f => { f.report.findings[0].title = "被替换的发现"; }, /未原样进入当前报告/],
    ["extra-linked", f => { f.report.findings.push({ finding_id: "extra-linked", bac_source: { candidate_id: "unreviewed" } }); }, /无专项复查记录/],
    ["status", f => { f.report.bac_analysis.status = "PARTIAL"; }, /隐藏了覆盖或复查缺口/],
    ["policy", async f => { const policy = await readJson(join(f.reports, "bac/policy.json")); policy.acp.quadruples[0].tuple.AC = "NONE"; await writeJson(join(f.reports, "bac/policy.json"), policy); }, /制品文件已改变/],
  ]) await t.test(name, async t => {
    const f = await malformedCompleteFixture(t, edit);
    await assert.rejects(prepareReview(f.store, { bacMode: "auto" }), pattern);
    assert.equal(f.store.snapshot().validation.input, undefined);
  });
});

for (const [kind, domain] of [["focus_area", "web"], ["api", "java"], ["api", "python"]]) test(`${kind}/${domain}：原生任务差分、Finding、复核、终稿完整闭合`, async t => {
  const f = await fixture(t, { kind, domain }); await claim(f); await compare(f, { viaCli: true }); await deliver(f);
  assert.equal(f.nativePlan.coverage_units, undefined); assert.equal(f.nativePlan.checks, undefined);
  assert.equal(f.run.focus_area_id, undefined); assert.equal(f.run.assignment_id, undefined);
  assert.equal(f.delivery.attachment.status, "COMPLETE");
  const summary = await summarizeTaskBac(f.store.snapshot(), f.reports);
  assert.equal(summary.status, "COMPLETE"); assert.deepEqual(summary.counts, { units: 1, candidates: 1, accepted: 1, paths: 1, policies: 1 });
  assert.deepEqual(validateBacSummary(summary), []);
  const b = await bundle(f); await acceptReview(f.store, b.result); await finalizeBoard(f.store);
  const audit = { id: f.auditId, task_board_path: f.boardPath, mining_strategy: kind, bac_analysis: { mode: "auto" }, source_baseline: { scope_digest: f.scope } };
  assert.equal((await verifyBoardCompletion({ audit, reportsRoot: f.reports })).complete, true);
  const final = f.store.snapshot().final_report;
  assert.match(await readFile(join(f.reports, final.path), "utf8"), /状态：COMPLETE；工作包：1；路径：1；策略：1；原始候选：1；接入复核：1/);
  assert.equal((await readJson(join(f.reports, final.model))).bac_analysis.summary.status, "COMPLETE");
  await writeFile(join(f.source, "src/OrderService.java"), "changed");
  assert.equal((await verifyBoardCompletion({ audit, reportsRoot: f.reports })).complete, false);
});

test("有证据的无差分路径可闭合，不虚构候选", async t => {
  const f = await fixture(t); await claim(f); await compare(f, { noMismatch: true }); await deliver(f);
  const b = await bundle(f); await acceptReview(f.store, b.result); await finalizeBoard(f.store);
  assert.equal(b.input.bac_summary.status, "COMPLETE"); assert.equal(b.input.bac_summary.counts.candidates, 0);
});

test("真实覆盖缺口必须保留，文字 REVIEWED 不能抹掉 PARTIAL", async t => {
  const f = await fixture(t); await claim(f); await compare(f, { incomplete: true }); await deliver(f);
  const b = await bundle(f); assert.equal(b.input.bac_summary.status, "PARTIAL");
  await assert.rejects(acceptReview(f.store, b.result), /不能以文字/);
  const g = await bundle(f, { gap: true }); await acceptReview(f.store, g.result); await finalizeBoard(f.store);
  const model = await readJson(join(f.reports, f.store.snapshot().final_report.model));
  assert.ok(model.residual_gaps.some(row => row.includes("尚未解析条件分支")));
});

test("缺策略是明确条件缺口，关闭模式不生成计划", async t => {
  const f = await fixture(t, { missingPolicies: true }); await claim(f);
  await assert.rejects(compare(f), /未绑定独立策略/);
  await receive(f, { protocol: PROTOCOL, audit_id: f.auditId, task_id: f.spec.task_id, attempt_id: f.job.attempt.attempt_id,
    summary: "常规审计继续。", findings: [], gaps: [], bac_analysis: { contract_version: BAC_CONTRACT, status: "GAP", reason: "缺少独立策略制品。" } });
  assert.equal((await summarizeTaskBac(f.store.snapshot(), f.reports)).status, "PARTIAL");
  const off = await fixture(t, { mode: "off" });
  assert.equal(await summarizeTaskBac(off.store.snapshot(), off.reports), null);
  await assert.rejects(claim(off), /未启用新版/);
});

test("未知路径不能省略 API 原文，独立策略不能改写或冒充同一会话", async t => {
  const f = await fixture(t, { kind: "api" }); await claim(f); await compare(f);
  const original = structuredClone(f.nativeRequest);
  for (const edit of [r => r.api_catalog.apis = [], r => r.acp.quadruples[0].tuple.AC = "NONE", r => r.acp.producer.agent_session_id = r.producer.agent_session_id,
    r => r.attempt_id = "old-attempt", r => r.plan_digest = "0".repeat(64)]) {
    const request = structuredClone(original); request.run_id = "bad-input"; edit(request); await writeJson(f.prepared.request_path, request);
    await assert.rejects(compareBac({ requestPath: f.prepared.request_path, reportsRoot: f.reports }));
  }
});

test("候选不能绑定另一任务、执行或领域，也不能混用旧 check", async t => {
  const f = await fixture(t); await claim(f); await compare(f); await deliver(f);
  for (const edit of [r => r.task_id = "other", r => r.attempt_id = "old", r => r.domain = "python", r => r.primary_check_id = "fake-check"]) {
    const changed = structuredClone(f.review); edit(changed.decisions[0].finding.routing);
    assert.throws(() => validateReview(changed, f.run, f.nativePlan));
  }
});

test("附件、生产会话和策略绑定篡改阻断最终复核", async t => {
  const f = await fixture(t); await claim(f); await compare(f); await deliver(f);
  const board = f.store.snapshot();
  const wrongSession = structuredClone(board); wrongSession.attempts[0].session_id = "other-session";
  await assert.rejects(summarizeTaskBac(wrongSession, f.reports), /会话绑定/);
  const otherAttempt = structuredClone(board); otherAttempt.tasks[0].attempt_id = "old-attempt";
  assert.equal((await summarizeTaskBac(otherAttempt, f.reports)).status, "PARTIAL");
  const policy = await readJson(join(f.reports, "bac/policy.json")); policy.acp.quadruples[0].tuple.AC = "NONE";
  await writeJson(join(f.reports, "bac/policy.json"), policy);
  await assert.rejects(summarizeTaskBac(board, f.reports), /制品文件已改变/);
});

test("新版原始 Focus Area 描述被指向正确入口，不再误报用户关闭专项", async t => {
  const f = await fixture(t);
  const value = { protocol: PROTOCOL, audit_id: f.auditId, scope_digest: f.scope, focus_areas: [{ focus_area_id: "FA-001" }], gaps: [] };
  value.manifest_digest = manifestDigest(value);
  const path = join(f.root, "focus-areas.json"); await writeJson(path, value);
  await assert.rejects(verifiedPlan(path), /执行附件中的 bac_plan.path/);
});

test("monitor 自动注入绑定任务的原生计划，缺少策略不会阻断静态报告交付", async t => {
  const f = await fixture(t, { missingPolicies: true }); await f.store.close();
  let observed;
  const service = new TaskBoardService({ path: f.boardPath, reportsRoot: f.reports, privateRoot: join(f.root, "service"), workspaceRoot: f.root,
    sourceRoot: f.source, auditId: f.auditId, scopeDigest: f.scope, environment: {}, bacMode: "auto", worker: async ({ input, workRoot }) => {
      observed = input;
      await atomicJson(join(workRoot, "report.json"), { protocol: PROTOCOL, audit_id: f.auditId, task_id: input.task.task_id, attempt_id: input.attempt_id,
        summary: "缺少独立策略，已继续常规审计。", findings: [], gaps: [], bac_analysis: { contract_version: BAC_CONTRACT, status: "GAP", reason: "未提供独立策略。" } });
      await atomicJson(join(workRoot, "receipt.json"), { protocol: PROTOCOL, audit_id: f.auditId, task_id: input.task.task_id, attempt_id: input.attempt_id, outcome: "REPORTED", report_path: "report.json" });
      return { session_id: "source-session-1" };
    } });
  await service.start(); t.after(() => service.shutdown());
  const deadline = Date.now() + 5000;
  while (!service.store.summary().mining_complete && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.store.summary().reported, 1); assert.ok(observed.bac_plan?.path);
  assert.equal((await verifiedPlan(observed.bac_plan.path)).attempt_id, observed.attempt_id);
  assert.equal(observed.runtime_protocol, null);
  assert.equal((await summarizeTaskBac(service.store.snapshot(), f.reports)).status, "PARTIAL");
});

test("不适用须有本次计划与冻结源码依据，缺失附件和坏报告仍记缺口", async t => {
  const f = await fixture(t, { missingPolicies: true }); await claim(f);
  const attachment = { contract_version: BAC_CONTRACT, status: "NOT_APPLICABLE", reason: "离线样例用于核验不适用证据契约。",
    plan_path: join(f.reports, f.planRef.path), source_root: f.source, evidence: [f.evidence()] };
  await receive(f, { protocol: PROTOCOL, audit_id: f.auditId, task_id: f.spec.task_id, attempt_id: f.job.attempt.attempt_id,
    summary: "已检查本任务的适用性。", findings: [], gaps: [], bac_analysis: attachment });
  assert.equal((await summarizeTaskBac(f.store.snapshot(), f.reports)).units[0].status, "NOT_APPLICABLE");
  for (const report of ["not JSON", "null", JSON.stringify({ summary: "只有文字差分", findings: [], gaps: [] })]) {
    const other = await fixture(t); await claim(other); await receive(other, report);
    assert.equal((await summarizeTaskBac(other.store.snapshot(), other.reports)).status, "PARTIAL");
  }
});

test("计划幂等封存，旧尝试及变化的冻结基线不能复用", async t => {
  const f = await fixture(t); await claim(f);
  assert.deepEqual(await prepareTaskBacPlan({ board: f.store.snapshot(), ...f.job, reportsRoot: f.reports, sourceRoot: f.source }), f.planRef);
  const oldRef = f.planRef;
  await f.store.fail(f.spec.task_id, f.job.attempt.attempt_id, "离线模拟中断。", { interrupted: true });
  await claim(f);
  assert.notEqual(oldRef.path, f.planRef.path);
  await assert.rejects(prepareBac({ planPath: join(f.reports, oldRef.path), sourceRoot: f.source, reportsRoot: f.reports,
    taskId: f.spec.task_id, attemptId: f.job.attempt.attempt_id, sessionId: "source-session-2", runId: "new-run" }));
  const baseline = join(f.reports, `coverage/source-baseline.${f.auditId}.json`);
  await writeFile(baseline, "changed");
  await assert.rejects(verifiedPlan(join(f.reports, f.planRef.path)), /制品文件已改变/);
});

test("worker 真实会话从运行事件写入只读交接文件，失败退出仍保留生产者", async t => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const f = await fixture(t); await claim(f);
  const inputPath = join(f.root, "input.json");
  const service = new TaskBoardService({ path: f.boardPath, reportsRoot: f.reports, sourceRoot: f.source, workspaceRoot: f.root,
    auditId: f.auditId, scopeDigest: f.scope, environment: {}, spawnProcess: () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      setTimeout(() => { child.stdout.write(`${JSON.stringify({ sessionID: "actual-provider-session" })}\n`); child.emit("close", 1); }, 5);
      return child;
    } });
  await assert.rejects(service.runWorker({ job: f.job, inputPath, signal: new AbortController().signal }), error => error.session_id === "actual-provider-session");
  const registered = await readJson(join(f.root, "session.json"));
  assert.equal(registered.agent_session_id, "actual-provider-session");
  assert.equal(registered.attempt_id, f.job.attempt.attempt_id);
});

test("工作台新建任务默认冻结原生专项选择，读取重试草稿不改写原选择", async t => {
  const { AuditRunner } = await import("../web/dynamic-validation-observatory/audit-runner.mjs");
  const { readBoard } = await import("../lib/task-board/store.mjs");
  const f = await fixture(t);
  const platform = join(f.root, "platform"), configPath = join(platform, ".opencode/opencode.json");
  await atomicJson(configPath, { mcp: {} });
  const runner = new AuditRunner({ stateRoot: join(platform, "state"), platformRoot: platform, configPath, enabled: true });
  t.after(() => runner.shutdown()); runner.setQueueScheduler({ async enqueueNewAudit() { return true; } });
  const snapshot = { target_id: "fixture", target_name: "离线源码夹具", source_scopes: [{ id: "scope-one", path: f.source }] };
  const created = await runner.createAuditFromTarget({ audit_id: "audit-bac-native-default", target_id: "fixture", execution_spec: snapshot,
    execution_spec_digest: hash(JSON.stringify(snapshot)), mining_strategy: "focus_area" }, "native-default");
  const audit = runner.audits.get(created.id);
  const board = await readBoard(audit.task_board_path);
  assert.equal(board.bac_analysis.mode, "auto"); assert.equal(board.bac_analysis.task_plan_contract, TASK_PLAN);
  assert.equal((await runner.retryDraft(created.id)).mining_strategy, "focus_area");
  assert.deepEqual((await readBoard(audit.task_board_path)).bac_analysis, board.bac_analysis);
  assert.equal(runner.taskBoardServices.size, 0);
});


test("接收前拒绝额外字段、候选改写或重复，提示精确到任务和 Finding；更正后可在同一尝试交付", async t => {
  const f = await fixture(t); await claim(f); await compare(f); await deliver(f, { receiveReport: false });
  for (const change of [r => { r.findings[0].origin_lens = "control-driven"; r.findings[0].bac_source_marker = true; },
    r => { r.findings[0].title = "被改写"; }, r => { r.findings.push(r.findings[0]); }]) {
    const bad = structuredClone(f.report); change(bad);
    await assert.rejects(receive(f, bad), error => error.code === "bac-finding-binding-mismatch" && error.task_id === f.spec.task_id && error.finding_id === f.report.findings[0].finding_id);
    assert.equal(f.store.snapshot().tasks[0].status, "RUNNING"); assert.equal(f.store.snapshot().tasks[0].report, null);
  }
  await receive(f, f.report); assert.equal(f.store.snapshot().tasks[0].status, "REPORTED");
});

test("已接收报告更正保留旧字节与复核，拒绝旧 bundle，新复核可以封存并显示更正记录", async t => {
  const f = await fixture(t); await claim(f); await compare(f); await deliver(f);
  const oldBundle = await bundle(f);
  await acceptReview(f.store, oldBundle.result);
  const good = structuredClone(f.report);
  // Historical incident: worker appended metadata before the old receiver froze it.
  f.report.findings[0].origin_lens = "control-driven"; f.report.findings[0].bac_source_marker = true;
  const old = f.store.snapshot().tasks[0].report;
  const oldBytes = Buffer.from(JSON.stringify(f.report)); await writeFile(join(f.reports, old.path), oldBytes);
  await f.store.mutate(board => { board.tasks[0].report.sha256 = hash(oldBytes); });
  await assert.rejects(prepareReview(f.store, { bacMode: "auto" }), /差异字段.*origin_lens.*bac_source_marker/);
  const ref = await artifact(f.reports, "proposals/corrected.json", good);
  const request = { task_id: f.spec.task_id, expected_sha256: hash(oldBytes), report: ref, reason: "移除组装阶段误加字段，原样恢复专项封存 Finding。" };
  const result = await correctReport(f.store, request), after = f.store.snapshot();
  assert.equal(after.validation.status, "NOT_STARTED"); assert.equal(after.validation.input, undefined);
  assert.equal(after.tasks[0].attempt_count, 1); assert.equal(after.tasks[0].report.sha256, ref.sha256);
  assert.equal(after.report_corrections.length, 1); assert.equal(result.correction.previous_validation.status, "REVIEWED");
  assert.deepEqual(await readFile(join(f.reports, old.path)), oldBytes);
  assert.equal(hash(await readFile(join(f.reports, oldBundle.ref.path))), oldBundle.ref.sha256);
  assert.equal((await correctReport(f.store, request)).duplicate, true); assert.equal(f.store.snapshot().report_corrections.length, 1);
  await assert.rejects(acceptReview(f.store, oldBundle.result), /绑定无效/);
  const next = await bundle(f); assert.notEqual(next.ref.sha256, oldBundle.ref.sha256);
  assert.equal(hash(await readFile(join(f.reports, oldBundle.ref.path))), oldBundle.ref.sha256);
  await assert.rejects(acceptReview(f.store, oldBundle.result), /输入摘要不匹配/);
  await acceptReview(f.store, next.result); await finalizeBoard(f.store);
  const final = f.store.snapshot().final_report;
  assert.match(await readFile(join(f.reports, final.path), "utf8"), /报告更正记录/);
  assert.equal((await readJson(join(f.reports, final.model))).report_corrections.length, 1);
  assert.equal((await verifyBoardCompletion({ audit: auditFor(f), reportsRoot: f.reports })).complete, true);
  await assert.rejects(correctReport(f.store, request), /已经封存/);
});

test("更正拒绝旧版本、越界路径、伪造会话、专项候选变更及原报告被修改", async t => {
  const f = await fixture(t); await claim(f); await compare(f); await deliver(f);
  const before = f.store.snapshot(), previous = before.tasks[0].report;
  const ref = await artifact(f.reports, "proposals/good.json", f.report);
  const request = { task_id: f.spec.task_id, expected_sha256: previous.sha256, report: ref, reason: "测试受控更正。" };
  await assert.rejects(correctReport(f.store, { ...request, expected_sha256: "0".repeat(64) }), /版本已变化/);
  await assert.rejects(correctReport(f.store, { ...request, report: { ...ref, path: "../outside.json" } }));
  for (const [key, change, error] of [["session", r => { r.agent_session_id = "invented-session"; }, /生产会话绑定无效/],
    ["finding", r => { r.findings[0].title = "被篡改"; }, /未原样进入当前报告/]]) {
    const report = structuredClone(f.report); change(report);
    const bad = await artifact(f.reports, `proposals/${key}.json`, report);
    await assert.rejects(correctReport(f.store, { ...request, report: bad }), error);
  }
  assert.deepEqual(f.store.snapshot(), before);
  await writeFile(join(f.reports, previous.path), "changed");
  await assert.rejects(correctReport(f.store, request), /原报告已被改写/);
});

test("worker 预检 CLI 在回执写入前拒绝额外字段，通过后不修改报告", async t => {
  const f = await fixture(t); await claim(f); await compare(f); await deliver(f, { receiveReport: false });
  const inputPath = join(f.root, "worker-input.json"), reportPath = join(f.root, "worker-report.json"), sessionPath = join(f.root, "session.json");
  await writeJson(inputPath, { audit_id: f.auditId, task: f.spec, attempt_id: f.job.attempt.attempt_id, report_path: reportPath, session_path: sessionPath, reports_root: f.reports });
  await writeJson(sessionPath, { agent_session_id: "source-session-1" });
  const bad = structuredClone(f.report); bad.findings[0].bac_source_marker = true; await writeJson(reportPath, bad);
  const checkCli = fileURLToPath(new URL("../scripts/task-report-check.mjs", import.meta.url));
  await assert.rejects(execute(process.execPath, [checkCli, inputPath]), /bac_source_marker/);
  await writeJson(reportPath, f.report); const before = await readFile(reportPath);
  assert.equal(JSON.parse((await execute(process.execPath, [checkCli, inputPath])).stdout).valid, true);
  assert.deepEqual(await readFile(reportPath), before);
});


test("更正命令通过任务服务鉴权，CLI 往返保留幂等性，并发旧版本只有一次生效", async t => {
  const f = await fixture(t); await claim(f); await compare(f); await deliver(f);
  const service = new TaskBoardService({ auditId: f.auditId }); service.store = f.store; service.pump = () => {};
  const server = http.createServer((req, res) => service.handle(req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const ref = await artifact(f.reports, "proposals/http.json", { ...f.report, summary: "修正摘要表述，专项证据与候选保持原样。" });
  const request = { task_id: f.spec.task_id, expected_sha256: f.store.snapshot().tasks[0].report.sha256, report: ref, reason: "修正摘要表述。" };
  const denied = await fetch(`${endpoint}/correct-report`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
  assert.equal(denied.ok, false);
  const connectionPath = join(f.root, "connection.json"), requestPath = join(f.root, "correction.json");
  await writeJson(connectionPath, { protocol: PROTOCOL, endpoint, token: service.token }); await writeJson(requestPath, request);
  const env = { ...process.env, AUDIT_TASK_PROTOCOL: PROTOCOL, AUDIT_TASK_BOARD_CONNECTION_PATH: connectionPath };
  const taskCli = fileURLToPath(new URL("../scripts/task-board.mjs", import.meta.url));
  assert.equal(JSON.parse((await execute(process.execPath, [taskCli, "correct-report", requestPath], { env })).stdout).corrected, true);
  assert.equal(JSON.parse((await execute(process.execPath, [taskCli, "correct-report", requestPath], { env })).stdout).duplicate, true);
  const expected = f.store.snapshot().tasks[0].report.sha256;
  const requests = await Promise.all([1, 2].map(async i => ({ ...request, expected_sha256: expected,
    report: await artifact(f.reports, `proposals/race-${i}.json`, { ...f.report, summary: `更正摘要 ${i}` }) })));
  const results = await Promise.allSettled(requests.map(input => correctReport(f.store, input)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.match(results.find(r => r.status === "rejected").reason.message, /版本已变化/);
});

for (const stage of ["review", "finalize"]) test(`更正抢先提交时，${stage} 不得提交旧复核或封存旧报告`, async t => {
  const f = await fixture(t); await claim(f); await compare(f); await deliver(f);
  const old = await bundle(f);
  if (stage === "finalize") await acceptReview(f.store, old.result);
  const request = { task_id: f.spec.task_id, expected_sha256: f.store.snapshot().tasks[0].report.sha256,
    report: await artifact(f.reports, "proposals/concurrent.json", { ...f.report, summary: "更正后的报告摘要。" }), reason: "补充报告摘要。" };
  const mutate = f.store.mutate.bind(f.store);
  // Another request wins the store queue before the pending operation commits.
  f.store.mutate = async operation => {
    f.store.mutate = mutate;
    await correctReport(f.store, request);
    return mutate(operation);
  };
  await assert.rejects(stage === "review" ? acceptReview(f.store, old.result) : finalizeBoard(f.store),
    stage === "review" ? /复核期间输入已改变/ : /后续复核未完成/);
  assert.equal(f.store.snapshot().validation.status, "NOT_STARTED");
  assert.equal(f.store.snapshot().final_report ?? null, null);
  await assert.rejects(readFile(join(f.reports, `final/security-audit-report.${f.auditId}.md`)), { code: "ENOENT" });
  const next = await bundle(f); await acceptReview(f.store, next.result); await finalizeBoard(f.store);
  assert.equal((await verifyBoardCompletion({ audit: auditFor(f), reportsRoot: f.reports })).complete, true);
});

test("封存持有提交锁时，并发更正必须等待并拒绝，不能改写已封存版本", async t => {
  const f = await fixture(t); await claim(f); await compare(f); await deliver(f);
  await acceptReview(f.store, (await bundle(f)).result);
  const request = { task_id: f.spec.task_id, expected_sha256: f.store.snapshot().tasks[0].report.sha256,
    report: await artifact(f.reports, "proposals/late.json", { ...f.report, summary: "过晚提交的更正摘要。" }), reason: "补充摘要。" };
  const [finalized, correction] = await Promise.allSettled([finalizeBoard(f.store), correctReport(f.store, request)]);
  assert.equal(finalized.status, "fulfilled"); assert.equal(correction.status, "rejected");
  assert.match(correction.reason.message, /已经封存/);
  assert.equal((await verifyBoardCompletion({ audit: auditFor(f), reportsRoot: f.reports })).complete, true);
});
