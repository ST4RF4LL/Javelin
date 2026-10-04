import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BAC_AGENTS, BAC_CONTRACT, TASK_PLAN, BacEvidenceStructureError, bacForUnit, bacSelection, boundFile, inside, objectDigest, requireBac, seal,
  sha256, validateBacAttachment, verifiedPlan } from "../bac/contract.mjs";
import { outputDirectory, taskPolicyInputs, validateRequest, writeImmutableJson } from "../bac/service.mjs";
import { buildBacSummary } from "../bac/summary.mjs";
import { digest, normalizeTask } from "./contract.mjs";

export const taskBacEnabled = board => board.bac_analysis?.mode === "auto" && board.bac_analysis?.task_plan_contract === TASK_PLAN;

// The service freezes the published task and attempt, not a synthesized legacy coverage unit.
export async function prepareTaskBacPlan({ board, task, attempt, reportsRoot, sourceRoot }) {
  requireBac(taskBacEnabled(board) && BAC_AGENTS.has(task.agent_name), "当前任务未启用新版专项计划。");
  const root = await realpath(reportsRoot), source = await realpath(sourceRoot);
  requireBac(root !== source && !inside(source, root), "交付目录不得位于源码根目录内。");
  const baselinePath = `coverage/source-baseline.${board.audit_id}.json`;
  const baselineRef = { path: baselinePath, sha256: sha256(await readFile(join(root, baselinePath))) };
  const { value: baseline } = await boundFile(root, baselineRef);
  const spec = normalizeTask(task, board);
  requireBac(digest(spec) === task.spec_digest && attempt.task_id === task.task_id && task.attempt_id === attempt.attempt_id, "专项任务与执行尝试不匹配。");
  const entries = [...(spec.bac_analysis?.entry_points ?? [])];
  if (task.kind === "api") {
    const input = board.api_sources.find(row => row.source_id === task.source_ref);
    requireBac(input, "API 任务缺少原始清单绑定。");
    if (!entries.some(row => row.api_id === input.source_id)) entries.unshift({ api_id: input.source_id, operation: input.text });
  }
  const plan = seal({ contract_version: BAC_CONTRACT, protocol: "task-board.v1", artifact_type: TASK_PLAN,
    audit_id: board.audit_id, scope_digest: board.scope_digest, source_root: source, reports_root: root,
    bac_analysis: bacSelection("auto"), task: { ...spec, spec_digest: task.spec_digest }, attempt_id: attempt.attempt_id,
    source_baseline: baselineRef, source_index: baseline.files.filter(row => row.type === "file").map(row => ({ path: row.path, sha256: row.sha256 })),
    entry_points: entries });
  const path = `bac/${board.audit_id}/task-plans/${sha256(`${task.task_id}:${attempt.attempt_id}`).slice(0, 32)}.json`;
  await outputDirectory(root, dirname(join(root, path)));
  await writeImmutableJson(join(root, path), plan);
  await verifiedPlan(join(root, path));
  return { path, sha256: sha256(await readFile(join(root, path))) };
}

export async function summarizeTaskBac(board, reportsRoot) {
  if (!taskBacEnabled(board)) return null;
  const rows = [];
  for (const task of board.tasks.filter(row => BAC_AGENTS.has(row.agent_name))) {
    const attempt = board.attempts.find(row => row.attempt_id === task.attempt_id);
    const row = { task_id: task.task_id, attempt_id: task.attempt_id ?? "unexecuted" };
    const gap = reason => ({ ...row, status: "GAP", reason, candidates: 0, accepted: 0, paths: 0, policies: 0, gaps: [reason] });
    if (!task.report || !attempt?.bac_plan) {
      rows.push(gap(attempt?.bac_gap ?? task.reason ?? "当前任务尚未交付绑定本次执行的越权专项计划和报告。")); continue;
    }
    const { path } = await boundFile(reportsRoot, attempt.bac_plan);
    const plan = await verifiedPlan(path);
    requireBac(plan.audit_id === board.audit_id && plan.scope_digest === board.scope_digest && plan.attempt_id === task.attempt_id
      && plan.task.spec_digest === task.spec_digest && digest(normalizeTask(plan.task, board)) === task.spec_digest
      && plan.reports_root === await realpath(reportsRoot), "专项计划不属于已发布任务或当前执行尝试。");
    let report;
    try { ({ value: report } = await boundFile(reportsRoot, task.report)); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      rows.push(gap("任务报告不是可解析 JSON，无法核验专项附件。")); continue;
    }
    const attachment = report?.bac_analysis;
    if (!attachment?.contract_version) { rows.push(gap("当前任务未交付可校验的 BAC 附件；文字差分不能替代封存制品。")); continue; }
    requireBac(report.protocol === "task-board.v1" && report.audit_id === board.audit_id && report.task_id === task.task_id
      && report.attempt_id === task.attempt_id, "专项报告的任务或执行绑定无效。");
    if (attachment.run) {
      const { value: run } = await boundFile(reportsRoot, attachment.run);
      validateRequest(run.input, plan);
      requireBac(run.input.plan_digest === plan.artifact_digest && await realpath(run.input.plan_path) === await realpath(path), "专项运行引用了不同的任务计划。");
      const policies = await taskPolicyInputs(plan);
      requireBac(Object.entries(policies).every(([key, value]) => objectDigest(run.input[key]) === objectDigest(value)), "专项运行篡改了独立策略输入。");
      requireBac(typeof report.agent_session_id === "string" && report.agent_session_id.length > 0
        && attempt.session_id === report.agent_session_id, "专项报告缺少真实生产会话绑定。");
    }
    if (attachment.status === "NOT_APPLICABLE") requireBac(await realpath(attachment.plan_path) === await realpath(path), "不适用证据引用了不同任务计划。");
    const item = { ...plan.task, attempt_id: plan.attempt_id, bac_analysis: bacForUnit(plan, plan.task) };
    try {
      const result = await validateBacAttachment({ reportsRoot, attachment, item, auditId: board.audit_id,
        findings: report.findings ?? [], sessionId: report.agent_session_id });
      rows.push({ ...row, ...result });
    } catch (error) {
      if (!(error instanceof BacEvidenceStructureError)) throw error;
      rows.push({ ...gap(`专项附件证据结构无效，不能据此确认专项结论。${error.message}`),
        evidence_error: { code: error.code, report: structuredClone(task.report) } });
    }
  }
  return buildBacSummary(rows);
}
