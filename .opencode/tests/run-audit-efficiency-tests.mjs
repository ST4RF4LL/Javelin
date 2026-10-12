import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicJson, hash, PROTOCOL } from "../lib/task-board/contract.mjs";
import { createBoard, TaskBoardStore } from "../lib/task-board/store.mjs";
import { prepareReview, acceptReview, finalizeBoard, verifyBoardCompletion } from "../lib/task-board/review.mjs";
import { prepareReviewBatches, nextReviewBatch, submitReviewBatch, readBound, estimateTokens } from "../lib/task-board/review-batches.mjs";
import { FileFactsCache, nextFileBatch, completeFileBatch, relatedTasks } from "../lib/task-board/file-batches.mjs";
import { TaskBoardService } from "../lib/task-board/service.mjs";
import { applyAuditProgress } from "../web/dynamic-validation-observatory/audit-progress.mjs";

const auditId = "audit-efficiency", scope = "a".repeat(64);
const task = (id, extra = {}) => ({ task_id: id, kind: "focus_area", title: `审查 ${id}`, domain: "python", source_ref: `threat:${id}`,
  prompt: "核对当前资源的输入、控制与边界。", code_refs: [{ path: "auth.py", line: 1 }], ...extra });
async function fixture(t, miningStrategy = "focus_area", contents = { "auth.py": "def auth():\n  return True\n", "guard.py": "enabled = True\n" }) {
  const root = await mkdtemp(join(tmpdir(), "audit-efficiency-")), reportsRoot = join(root, "reports"), sourceRoot = join(root, "source"), path = join(root, "board.json");
  await mkdir(reportsRoot); await mkdir(sourceRoot);
  const files = [];
  for (const [name, value] of Object.entries(contents)) {
    await writeFile(join(sourceRoot, name), value);
    files.push({ file_id: `file:${hash(name).slice(0, 24)}`, path: name, type: "file", content_kind: "source", sha256: hash(value), size: Buffer.byteLength(value) });
  }
  const manifest = { audit_id: auditId, scope_digest: scope, complete: true, files, exclusions: [] }, manifestPath = join(root, "manifest.json");
  await atomicJson(manifestPath, manifest); await createBoard({ path, auditId, miningStrategy, bacMode: "off" });
  const store = await new TaskBoardStore({ path, reportsRoot, auditId, scopeDigest: scope }).open();
  if (miningStrategy === "file_sweep") await store.initializeFiles(manifest);
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, reportsRoot, sourceRoot, path, manifest, manifestPath, store };
}
async function artifact(f, name, value) {
  const path = `validation/${name}.json`; await atomicJson(join(f.reportsRoot, path), value);
  return { path, sha256: hash(await readFile(join(f.reportsRoot, path))) };
}
async function candidateFixture(t, count = 9) {
  const f = await fixture(t); await f.store.publish({ tasks: [task("fa-auth")] });
  const job = await f.store.claim("python", 60000), work = join(f.root, "worker"); await mkdir(work);
  await atomicJson(join(work, "report.json"), { summary: "已核对指定范围。", findings: Array.from({ length: count }, (_, i) => ({ finding_id: `source-${i}`,
    title: `候选 ${i}`, locations: { primary: { file: "auth.py", line_start: i + 1 } }, description: "证据与控制条件" })), gaps: [] });
  await f.store.receive({ taskId: job.task.task_id, attemptId: job.attempt.attempt_id, inputRoot: work, receipt: {
    protocol: PROTOCOL, audit_id: auditId, task_id: job.task.task_id, attempt_id: job.attempt.attempt_id, outcome: "REPORTED", report_path: "report.json" } });
  await f.store.seal(); f.input = await prepareReview(f.store, { bounded: true }); return f;
}
async function roleResult(f, next, overrides = {}) {
  const packet = await readBound(f.reportsRoot, next.input);
  return artifact(f, `${next.batch_id}-${next.role}-${hash(JSON.stringify(overrides)).slice(0, 8)}`, {
    protocol: PROTOCOL, audit_id: auditId, input_sha256: next.input_sha256, batch_input_sha256: next.input.sha256,
    batch_id: next.batch_id, role: next.role, agent_session_id: `session-${next.batch_id}-${next.role}`,
    ...(next.affirmative ? { affirmative_sha256: next.affirmative.sha256 } : {}), ...(next.negative ? { negative_sha256: next.negative.sha256 } : {}),
    findings: packet.candidates.map(row => ({ candidate_id: row.candidate_id, verdict: ({ AFFIRMATIVE: "PROVEN", NEGATIVE: "NOT_REFUTED", MODERATOR: "TRUE_POSITIVE" })[next.role],
      reason: "已逐项核对入口、控制和源码证据。", evidence_refs: ["auth.py:1"], gaps: [] })), ...overrides });
}
const completedFile = file => ({ file_id: file.file_id, attempt_id: file.attempt_id, outcome: "BROWSED", summary: "已核对当前文件职责、输入与控制，未形成新的疑点。", task_ids: [] });

test("有界复核精确覆盖全部候选；逐批三方独立、断点复用并能封存终稿", async t => {
  const f = await candidateFixture(t), plan = await readBound(f.reportsRoot, f.input.batch_plan);
  assert.equal(plan.batches.length, 2); assert.ok(plan.batches.every(batch => batch.candidate_ids.length <= 6));
  assert.equal(new Set(plan.batches.flatMap(batch => batch.candidate_ids)).size, 9);
  const first = await nextReviewBatch(f.store), firstResult = await roleResult(f, first);
  await submitReviewBatch(f.store, { ...first, result: firstResult });
  assert.equal((await submitReviewBatch(f.store, { ...first, result: firstResult })).duplicate, true);
  const next = await nextReviewBatch(f.store);
  await assert.rejects(() => submitReviewBatch(f.store, { ...next, result: firstResult }), /角色、批次/);
  await assert.rejects(async () => submitReviewBatch(f.store, { ...next, result: await roleResult(f, next, { agent_session_id: `session-${first.batch_id}-${first.role}` }) }), /全新独立会话/);
  await assert.rejects(async () => submitReviewBatch(f.store, { ...next, result: await roleResult(f, next, { findings: [] }) }), /逐项覆盖/);
  await assert.rejects(async () => submitReviewBatch(f.store, { ...next, result: await roleResult(f, next, { affirmative_sha256: "0".repeat(64) }) }), /正方证据/);
  await f.store.close();
  f.store = await new TaskBoardStore({ path: f.path, reportsRoot: f.reportsRoot, auditId, scopeDigest: scope }).open(); t.after(() => f.store.close());
  assert.equal((await nextReviewBatch(f.store)).role, "NEGATIVE");
  assert.deepEqual(await prepareReviewBatches(f.store), { ...f.input.batch_plan, batch_count: 2 });
  const quality = await artifact(f, "quality", { protocol: PROTOCOL, audit_id: auditId, input_sha256: f.input.sha256, role: "REPORT_REVIEW", agent_session_id: "session-quality",
    assessments: [{ task_id: "fa-auth", status: "REVIEWED", reason: "已核对任务要求与报告。", evidence_refs: ["auth.py:1"], gaps: [] }] });
  await assert.rejects(() => acceptReview(f.store, { quality }), /逐项覆盖|绑定无效/);
  for (;;) {
    const next = await nextReviewBatch(f.store); if (next.done) break;
    if (next.batch_id !== first.batch_id) await assert.rejects(async () => submitReviewBatch(f.store, { ...next,
      result: await roleResult(f, next, { agent_session_id: `session-${first.batch_id}-${first.role}` }) }), /全新独立会话/);
    await submitReviewBatch(f.store, { ...next, result: await roleResult(f, next) });
  }
  assert.match(applyAuditProgress({ status: "running", task_board: f.store.summary() }).progress_text, /复核批次 2\/2/);
  await acceptReview(f.store, { quality });
  const final = await finalizeBoard(f.store); assert.equal(final.findings, 9);
  const checked = await verifyBoardCompletion({ audit: { id: auditId, mining_strategy: "focus_area", task_board_path: f.path,
    source_baseline: { scope_digest: scope } }, reportsRoot: f.reportsRoot }); assert.deepEqual(checked.errors, []);
  await finalizeBoard(f.store);
});

test("超大候选外置完整证据；分包不丢失候选或混入其他任务", async t => {
  const f = await fixture(t);
  const data = { protocol: PROTOCOL, audit_id: auditId, scope_digest: scope, bac_mode: "off", tasks: [{ task_id: "big", prompt: "证据".repeat(30000) }],
    candidates: [{ candidate_id: "large", task_id: "big", claim_scope: "SOURCE", finding: { title: "大候选", description: "原文".repeat(30000), locations: Array.from({ length: 3000 }, (_, i) => ({ file: `module-${i}/auth.py`, line_start: i + 1 })) } }], runtime: null };
  const ref = await artifact(f, "input", data); await f.store.mutate(board => { board.validation.input = ref; });
  const planRef = await prepareReviewBatches(f.store), plan = await readBound(f.reportsRoot, planRef), packet = await readBound(f.reportsRoot, plan.batches[0].input);
  assert.ok(estimateTokens(packet) < 16000); assert.equal(packet.candidates[0].evidence_external, true);
  const original = await readBound(f.reportsRoot, packet.candidates[0].evidence);
  assert.deepEqual(original.candidates, data.candidates); assert.deepEqual(original.tasks, data.tasks);
});

test("文件批次一次领取并读取，分段保存后新尝试续读；延后不产生 GAP", async t => {
  const f = await fixture(t, "file_sweep", { "large.py": Array.from({ length: 260 }, (_, i) => `def operation_${i}(untrusted_input): return untrusted_input`).join("\n") });
  const first = await nextFileBatch(f.store, f.sourceRoot, { target_tokens: 1000 });
  assert.equal(first.files.length, 1); const file = first.files[0]; assert.ok(file.next_line > 1);
  await completeFileBatch(f.store, f.sourceRoot, { results: [{ ...file, outcome: "CONTINUE", resume_note: "已核对前段函数输入，余下函数待继续。" }] });
  const second = await nextFileBatch(f.store, f.sourceRoot, { target_tokens: 1000 });
  assert.equal(second.files[0].start_line, file.next_line); assert.notEqual(second.files[0].attempt_id, file.attempt_id);
  await assert.rejects(() => completeFileBatch(f.store, f.sourceRoot, { results: [completedFile(file)] }), /失效/);
  await completeFileBatch(f.store, f.sourceRoot, { results: [{ ...second.files[0], outcome: "DEFERRED" }] });
  assert.equal(f.store.summary().file_sweep.gap_files, 0); assert.equal(f.store.summary().file_sweep.pending_files, 1);
  const again = await nextFileBatch(f.store, f.sourceRoot, { target_tokens: 1000 });
  assert.equal(again.files[0].start_line, second.files[0].start_line);
  await completeFileBatch(f.store, f.sourceRoot, { results: [{ ...again.files[0], outcome: "DEFERRED" }] });
  for (let i = 0; i < 30 && !f.store.summary().file_sweep.browsed_files; i++) {
    const next = (await nextFileBatch(f.store, f.sourceRoot, { target_tokens: 1000 })).files[0];
    await completeFileBatch(f.store, f.sourceRoot, { results: [next.next_line ? { ...next, outcome: "CONTINUE", resume_note: "本段源码已分析，继续剩余函数。" } : completedFile(next)] });
  }
  assert.equal(f.store.summary().file_sweep.browsed_files, 1); assert.equal(f.store.summary().file_sweep.gap_files, 0);
});

test("缓存只复用版本匹配的源码事实，依赖、配置或规则变化后失效", async t => {
  const f = await fixture(t, "file_sweep", { "auth.py": "value = 1\n", "guard.py": "enabled = True\n", "config.json": "{}\n" });
  const cache = new FileFactsCache({ root: join(f.root, "facts"), rulesDigest: "a".repeat(64) });
  const batch = await nextFileBatch(f.store, f.sourceRoot, {}, cache), file = batch.files.find(file => file.path === "auth.py");
  await completeFileBatch(f.store, f.sourceRoot, { results: batch.files.map(row => ({ ...completedFile(row),
    facts: { responsibility: "定义常量", inputs: [], verdict: "不得缓存的历史结论" }, related_files: ["guard.py"] })) }, cache);
  const cached = await cache.get(file, f.store.snapshot(), f.sourceRoot); assert.equal(cached.facts.responsibility, "定义常量"); assert.equal(cached.facts.verdict, undefined);
  const changedConfig = f.store.snapshot(); changedConfig.file_sweep.files.find(file => file.path === "config.json").sha256 = "f".repeat(64);
  assert.equal(await cache.get(file, changedConfig, f.sourceRoot), null);
  assert.equal(await new FileFactsCache({ root: cache.root, rulesDigest: "b".repeat(64) }).get(file, f.store.snapshot(), f.sourceRoot), null);
  await writeFile(join(f.sourceRoot, "guard.py"), "enabled = False\n"); assert.equal(await cache.get(file, f.store.snapshot(), f.sourceRoot), null);
});

test("文件批次把缓存与关联任务计入预算，省略的辅助详情仍可按 ID 查询", async t => {
  const f = await fixture(t, "file_sweep", { "auth.py": Array.from({ length: 300 }, (_, i) => `value_${i} = untrusted_input`).join("\n") });
  const file = await f.store.claimFile({ file_id: f.manifest.files[0].file_id });
  const refs = Array.from({ length: 100 }, (_, i) => ({ path: "auth.py", line: i + 1, symbol: "长函数名".repeat(100) }));
  await f.store.publish({ tasks: Array.from({ length: 8 }, (_, i) => task(`related-${i}`, { source_ref: file.file_id, code_refs: refs })) });
  await f.store.resetFileClaims();
  const batch = await nextFileBatch(f.store, f.sourceRoot, { target_tokens: 1000 }, { get: async () => ({ facts: { responsibility: "缓存事实".repeat(900) } }) });
  assert.ok(batch.estimated_tokens <= 1000); assert.ok(batch.files[0].next_line > 1);
  assert.equal(batch.files[0].cached_facts, null); assert.equal(batch.files[0].related_task_ids.length, 8);
  assert.equal(relatedTasks(f.store.snapshot(), { paths: ["auth.py"] }).items[0].code_refs.length, 8);
  const full = relatedTasks(f.store.snapshot(), { task_id: "related-0" });
  assert.equal(full.total, 1); assert.deepEqual(full.items[0].code_refs, refs);
  assert.throws(() => relatedTasks(f.store.snapshot(), { root_cause: { path: 42 } }), /根因查询/);
});

test("同根因复用任务但保留不同边界与前提；按风险优先领取且未执行任务不可 skip", async t => {
  const f = await fixture(t), cause = { path: "auth.py", symbol: "authorize", weakness: "missing-owner", trust_boundary: "user-to-record", preconditions: "authenticated user" };
  await f.store.publish({ tasks: [task("first", { root_cause: cause, priority: 3 })] });
  const reused = await f.store.publish({ tasks: [task("second", { root_cause: cause })] }); assert.deepEqual(reused.published, ["first"]);
  await f.store.publish({ tasks: [task("other", { root_cause: { ...cause, preconditions: "anonymous user" }, priority: 1 }), task("no-root")] });
  assert.equal(relatedTasks(f.store.snapshot(), { root_cause: cause }).total, 1);
  const expanded = await f.store.publish({ tasks: [task("new-entry", { root_cause: cause, code_refs: [{ path: "auth.py", line: 1 }, { path: "guard.py", line: 1 }] })] });
  assert.deepEqual(expanded.published, ["new-entry"]); assert.equal(f.store.snapshot().tasks.find(task => task.task_id === "new-entry").related_task_id, "first");
  assert.equal((await f.store.claim("python", 60000)).task.task_id, "other");
  await assert.rejects(() => f.store.skip({ task_id: "first", reason: "预算不够" }), /三次/);
});

test("实际 HTTP 批次接口与 defer 暂停保留进度；恢复可继续领取", async t => {
  const f = await fixture(t, "file_sweep"); await f.store.close(); let notice;
  const service = new TaskBoardService({ path: f.path, reportsRoot: f.reportsRoot, privateRoot: join(f.root, "service"), workspaceRoot: f.root,
    sourceRoot: f.sourceRoot, auditId, scopeDigest: scope, fileManifestPath: f.manifestPath, onPauseRequested: reason => { notice = reason; } });
  await service.start(); t.after(() => service.shutdown());
  const call = async (route, body = {}) => {
    const response = await fetch(`${service.endpoint}/${route}`, { method: "POST", headers: { Authorization: `Bearer ${service.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const batch = await call("file-batch"); assert.equal(batch.data.files.length, 2);
  assert.equal((await call("defer", { reason: "测试预算到达，保存未完成工作。" })).status, 200);
  await new Promise(resolve => setImmediate(resolve)); assert.match(notice, /预算/);
  assert.equal(service.store.summary().next_action, "PAUSED"); assert.equal(service.store.summary().file_sweep.pending_files, 2); assert.equal(service.store.summary().file_sweep.gap_files, 0);
  assert.equal((await call("file-batch")).status, 422);
  await service.resume(); const resumed = await call("file-batch"); assert.equal(resumed.data.files.length, 2);
  assert.equal((await call("file-batch-complete", { results: resumed.data.files.map(completedFile) })).status, 200);
  assert.equal(service.store.summary().file_sweep.browsed_files, 2);
});

test("复核 CLI 经 HTTP 提交三方结果，由后台汇编并封存，不需要模型生成全量数组", async t => {
  const f = await candidateFixture(t, 1); await f.store.close();
  const service = new TaskBoardService({ path: f.path, reportsRoot: f.reportsRoot, privateRoot: join(f.root, "service"), workspaceRoot: f.root,
    sourceRoot: f.sourceRoot, auditId, scopeDigest: scope, environment: {}, worker: async () => { throw new Error("已交付任务不应重跑"); } });
  await service.start(); t.after(() => service.shutdown());
  const exec = promisify(execFile);
  const run = async (...args) => JSON.parse((await exec(process.execPath, [".opencode/scripts/task-board.mjs", ...args], {
    env: { ...process.env, AUDIT_TASK_PROTOCOL: PROTOCOL, AUDIT_TASK_BOARD_CONNECTION_PATH: service.connectionPath, AUDIT_REPORTS_ROOT: f.reportsRoot }, maxBuffer: 1024 * 1024,
  })).stdout);
  assert.ok((await run("review-input")).batch_plan);
  for (let index = 0; index < 3; index++) {
    const next = await run("review-next"), result = await roleResult(f, next), path = join(f.root, "submit.json");
    await atomicJson(path, { batch_id: next.batch_id, role: next.role, result });
    assert.equal((await run("review-submit", path)).received, true);
  }
  assert.equal((await run("review-next")).done, true);
  const quality = await artifact(f, "quality-cli", { protocol: PROTOCOL, audit_id: auditId, input_sha256: f.input.sha256, role: "REPORT_REVIEW", agent_session_id: "quality-cli",
    assessments: [{ task_id: "fa-auth", status: "REVIEWED", reason: "任务内容和源码已核对。", evidence_refs: ["auth.py:1"], gaps: [] }] });
  const bundle = join(f.root, "bundle.json"); await atomicJson(bundle, { quality });
  assert.equal((await run("review", bundle)).candidates, 1);
  assert.equal((await run("finalize")).findings, 1);
});
