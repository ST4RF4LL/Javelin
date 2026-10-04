import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { applyAuditProgress, mergeAuditPresentation } from "../web/dynamic-validation-observatory/audit-progress.mjs";
import { auditsFromArtifacts } from "../web/dynamic-validation-observatory/workspace-model.mjs";
import { compactWorkspaceAudits } from "../web/dynamic-validation-observatory/audit-list.mjs";

const base = { id: "audit-progress", name: "进度夹具", status: "running", paths: {}, task_protocol: "task-board.v1", stage_delivery_enforcement: "TODO_ENFORCED" };
const board = overrides => ({ protocol: "task-board.v1", publication: "SEALED", total: 4, reported: 2, done: 2, gap: 0, pending: 1, running: 1, failed: 0,
  mining_complete: false, progress: 50, validation: { status: "NOT_STARTED" }, next_action: "WAIT", ...overrides });
const input = (overrides = {}, status = "running") => { const value = board(overrides); return { ...base, status, task_board: value, todo: value }; };

test("规划阶段显示尚未发布，不能从范围冻结推断出 13% 报告交付", () => {
  const result = auditsFromArtifacts([], [], [input({ publication: "OPEN", total: 0, reported: 0, done: 0, progress: 0 })])[0];
  assert.equal(result.stage, "任务规划与发布"); assert.equal(result.progress, 0);
  assert.equal(result.progress_text, "规划中 · 尚未发布任务");
  assert.equal(result.stages.find(stage => stage.state === "active").id, "planning");
});

test("已登记缺口不计入报告交付率，挖掘结束仍显示后续复核", () => {
  const result = applyAuditProgress(input({ reported: 3, done: 3, gap: 1, running: 0, pending: 0, progress: 100, mining_complete: true }));
  assert.equal(result.progress, 75); assert.match(result.progress_text, /报告交付 3\/4.*缺口 1/);
  assert.equal(result.stage, "报告内容复核"); assert.equal(result.stages.at(-1).state, "pending");
});

test("报告交付 100% 与报告复核、封存分别呈现", () => {
  const result = applyAuditProgress(input({ reported: 4, done: 4, mining_complete: true }));
  assert.equal(result.progress, 100); assert.equal(result.stage, "报告内容复核");
  assert.match(result.progress_text, /^报告交付/);
  assert.equal(applyAuditProgress(input({ reported: 4, mining_complete: true, validation: { status: "REVIEWED" }, next_action: "DONE" })).stage, "报告已封存");
});

test("空计划、失败和暂停均有明确状态", () => {
  assert.equal(applyAuditProgress(input({ total: 0, reported: 0, mining_complete: true })).progress_text, "本轮无审计任务");
  assert.equal(applyAuditProgress(input({ failed: 1 })).stage, "任务执行 · 需处理失败项");
  assert.ok(applyAuditProgress(input({}, "paused")).stages.every(stage => stage.state !== "active"));
});

test("实时状态覆盖缓存进度且保留制品统计，紧凑视图保留进度来源", () => {
  const result = mergeAuditPresentation(input(), { progress: 100, stage: "报告封存", finding_count: 3, artifact_count: 8 });
  assert.equal(result.progress, 50); assert.equal(result.finding_count, 3); assert.equal(result.artifact_count, 8);
  assert.equal(result.progress_source, "task-board");
  const compact = compactWorkspaceAudits([result])[0];
  assert.equal(compact.progress_text, result.progress_text); assert.equal(compact.task_board.reported, 2); assert.equal(compact.stages, undefined);
});

test("历史 TODO 展示保持原语义", () => {
  const audit = { id: "legacy", stage: "证据关联", progress: 100, todo: { total: 3, done: 3, complete: true } };
  assert.deepEqual(applyAuditProgress(audit), audit);
});

test("页面对旧服务的兼容展示与服务端计算一致", async () => {
  const app = await readFile(new URL("../web/dynamic-validation-observatory/public/app.js", import.meta.url), "utf8");
  const source = app.slice(app.indexOf("function normalizeAuditView("), app.indexOf("async function auditViews("));
  const normalize = runInNewContext(`${source}; normalizeAuditView`);
  for (const audit of [input(), input({ publication: "OPEN", total: 0, reported: 0 }), input({ publication: "OPEN" }),
    input({ reported: 3, gap: 1, mining_complete: true }), input({ failed: 1 }), input({}, "paused"), input({}, "queued"),
    input({ mining_complete: true, validation: { status: "REVIEWED" }, next_action: "DONE" })]) {
    const browser = normalize(audit), backend = applyAuditProgress(audit);
    for (const key of ["stage", "progress", "progress_text", "progress_source", "stages"]) assert.equal(JSON.stringify(browser[key]), JSON.stringify(backend[key]), key);
  }
});
