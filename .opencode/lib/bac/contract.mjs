import { createHash } from "node:crypto";
import { readFile, realpath, lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { validateFinding, findingObjectDigest } from "../../skills/common-subagent/finding-evidence-contract/scripts/finding-contract.mjs";
import { objectDigest as planDigest } from "../../skills/common-subagent/audit-coverage-accounting/scripts/coverage-v2-common.mjs";

export const BAC_CONTRACT = "bac-analysis.v1";
export const BAC_AGENTS = new Set(["java-source-auditor", "python-source-auditor", "web-source-auditor"]);
export const BAC_TYPES = new Set(["JW-ACCESS-01", "JW-ACCESS-02", "JAVA-ACCESS-01"]);
export const TASK_PLAN = "bac-task-plan.v1";
export const BAC_EVIDENCE_STRUCTURE_ERROR = "bac-evidence-structure-invalid";
export class BacEvidenceStructureError extends Error {
  constructor() {
    super("越权专项：BAC 证据须有中文说明、类型与结构化 locator。");
    this.name = "BacEvidenceStructureError"; this.code = BAC_EVIDENCE_STRUCTURE_ERROR;
  }
}
export const isTaskPlan = plan => plan?.protocol === "task-board.v1" && plan?.artifact_type === TASK_PLAN;
export const sha256 = value => createHash("sha256").update(value).digest("hex");
export const isDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const nonempty = value => typeof value === "string" && value.trim().length > 0;
export function requireBac(value, message) { if (!value) throw new Error(`越权专项：${message}`); }
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  requireBac(typeof value !== "number" || Number.isFinite(value), "摘要对象包含非有限数值。");
  return value;
}
export const objectDigest = value => sha256(JSON.stringify(canonical(value)));
export function seal(value) { const { artifact_digest: _digest, ...body } = value; return { ...body, artifact_digest: objectDigest(body) }; }
export function verifySeal(value) {
  requireBac(value && value.contract_version === BAC_CONTRACT, "制品版本无效。");
  requireBac(value.artifact_digest === seal(value).artifact_digest, "制品摘要不匹配。");
  return value;
}
export function inside(root, file) { const rel = relative(root, file); return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
export async function boundFile(root, binding) {
  requireBac(binding && nonempty(binding.path) && !isAbsolute(binding.path) && isDigest(binding.sha256), "文件绑定无效。");
  const base = await realpath(root), path = resolve(base, binding.path);
  requireBac(inside(base, path), "制品路径越界。");
  const stat = await lstat(path);
  requireBac(stat.isFile() && !stat.isSymbolicLink() && inside(base, await realpath(path)), "制品必须是受控普通文件。");
  const bytes = await readFile(path);
  requireBac(sha256(bytes) === binding.sha256, "制品文件已改变。");
  return { value: JSON.parse(bytes.toString("utf8")), bytes, path };
}
export function bacSelection(value = "auto") {
  if (!["auto", "off"].includes(value)) throw Object.assign(new Error("越权专项：bac_analysis 仅支持 auto/off。"), { statusCode: 422, code: "bac-mode-invalid" });
  return { contract_version: BAC_CONTRACT, mode: value };
}
export function bacForUnit(plan, unit) {
  if (!plan.bac_analysis) return null;
  bacSelection(plan.bac_analysis.mode);
  requireBac(plan.bac_analysis.contract_version === BAC_CONTRACT, "Plan 的专项版本不受支持。");
  if (plan.bac_analysis.mode === "off" || !BAC_AGENTS.has(unit.agent_name)) return null;
  requireBac(isTaskPlan(plan) || plan.packet_report_contract === "tri-lens-v2" && plan.finding_detail_contract === "finding-details.v1", "越权专项需要当前任务计划或三视角与 Finding 详细证据契约。");
  return { contract_version: BAC_CONTRACT, required: true,
    plan_manifest_digest: isTaskPlan(plan) ? plan.artifact_digest : plan.manifest_digest,
    plan_binding_digest: objectDigest(planBinding(plan, unit)),
    source_index_digest: objectDigest(plan.source_index ?? []) };
}
export function planBinding(plan, unit) {
  if (isTaskPlan(plan)) return { protocol: plan.protocol, artifact_type: TASK_PLAN, audit_id: plan.audit_id,
    scope_digest: plan.scope_digest, task: unit, attempt_id: plan.attempt_id };
  return { audit_id: plan.audit_id, scope_digest: plan.scope_digest, coverage_units: [unit],
    checks: (plan.checks ?? []).filter(check => unit.check_ids.includes(check.check_id)) };
}
export function unitForPlan(plan, identity) {
  return isTaskPlan(plan)
    ? plan.task?.task_id === identity.task_id && plan.attempt_id === identity.attempt_id ? plan.task : null
    : plan.coverage_units?.find(row => row.focus_area_id === identity.focus_area_id && row.assignment_id === identity.assignment_id);
}
export function interfacesForUnit(plan, unit) {
  if (isTaskPlan(plan)) return plan.entry_points;
  const ids = new Set(plan.checks.filter(row => unit.check_ids.includes(row.check_id)).flatMap(row => row.required_interface_ids ?? []));
  return (plan.interface_index ?? []).filter(row => ids.has(row.interface_id) && row.direction !== "egress");
}
export function unitForRequest(plan, request) {
  requireBac(request.contract_version === BAC_CONTRACT, "请求版本无效。");
  requireBac(request.audit_id === plan.audit_id && request.scope_digest === plan.scope_digest, "请求与冻结范围不一致。");
  const unit = unitForPlan(plan, request);
  requireBac(unit && unit.agent_name === request.producer?.agent_name && BAC_AGENTS.has(unit.agent_name), "请求不属于当前源码工作包。");
  requireBac(nonempty(request.producer?.agent_session_id), "缺少真实源码会话 ID。");
  return unit;
}
export async function verifiedPlan(path) {
  requireBac(nonempty(path), "缺少冻结 Plan 路径。");
  const value = JSON.parse(await readFile(resolve(path), "utf8"));
  if (isTaskPlan(value)) {
    verifySeal(value);
    requireBac(value.task?.scope_digest === value.scope_digest && nonempty(value.task.task_id) && nonempty(value.attempt_id)
      && Array.isArray(value.source_index) && Array.isArray(value.entry_points), "任务计划范围或执行绑定无效。");
    const { value: baseline } = await boundFile(value.reports_root, value.source_baseline);
    requireBac(baseline.audit_id === value.audit_id && baseline.scope_digest === value.scope_digest
      && baseline.manifest_digest === planDigest(baseline) && await realpath(baseline.root) === await realpath(value.source_root), "任务计划的冻结源码基线无效。");
    requireBac(objectDigest(value.source_index) === objectDigest(baseline.files.filter(row => row.type === "file").map(row => ({ path: row.path, sha256: row.sha256 }))), "任务计划源码索引不匹配。");
    return value;
  }
  requireBac(value.protocol !== "task-board.v1", "新版任务请使用执行附件中的 bac_plan.path，不得将 Focus Area 描述当作旧 Coverage Plan。");
  requireBac(isDigest(value.manifest_digest) && value.manifest_digest === planDigest(value), "Coverage Plan 摘要无效。");
  return value;
}
async function planForAttachment(path, item, auditId) {
  const plan = await verifiedPlan(path);
  const unit = unitForPlan(plan, item);
  requireBac(plan.audit_id === auditId && plan.scope_digest === item.scope_digest && unit?.agent_name === item.agent_name
    && objectDigest(bacForUnit(plan, unit)) === objectDigest(item.bac_analysis), "专项引用了未分派的 Plan 或源码快照。");
  return plan;
}
export function validateComparison(result, request) {
  requireBac(result?.schema_version === "bac-comparison.v1" && result.analysis_kind === "STATIC_BAC_CANDIDATE_ANALYSIS", "差分结果版本无效。");
  requireBac(result.summary?.dynamic_validation_performed === false && result.validation_status === "NOT_PERFORMED", "静态结果不得冒充动态验证。");
  for (const key of ["findings", "path_results", "inconclusive", "unmatched_paths", "suppressed_paths", "limitations", "out_of_model"]) requireBac(Array.isArray(result[key]), `结果缺少 ${key}。`);
  const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && [...a].sort().join("\0") === [...b].sort().join("\0");
  requireBac(sameSet(result.path_results.map(row => row.path_id), request.paths.paths.map(row => row.path_id)), "输入路径与结果不守恒。");
  requireBac(sameSet(result.findings.map(row => row.finding_id), result.path_results.filter(row => row.state === "CANDIDATE").map(row => row.finding_id)), "候选集合与路径状态不一致。");
  const states = new Set(["CANDIDATE", "NO_MISMATCH", "INCONCLUSIVE", "UNMATCHED", "SUPPRESSED_UNREACHABLE"]);
  requireBac(result.path_results.every(row => states.has(row.state) && Array.isArray(row.gaps)), "路径终态无效。");
  for (const [list, state] of [["inconclusive", "INCONCLUSIVE"], ["unmatched_paths", "UNMATCHED"], ["suppressed_paths", "SUPPRESSED_UNREACHABLE"]]) {
    requireBac(sameSet(result[list].map(row => row.path_id), result.path_results.filter(row => row.state === state).map(row => row.path_id)), "路径结果子集不守恒。");
  }
  requireBac(result.summary.findings === result.findings.length && result.summary.access_paths === result.path_results.length, "差分统计不一致。");
  requireBac(result.coverage_gaps && ["unreferenced_acp", "uncovered_apis", "unknown_api_relevance"].every(key => Array.isArray(result.coverage_gaps[key])), "差分缺少完整覆盖账目。");
  const statistics = {
    acp_quadruples: request.acp.quadruples.length,
    matched_paths: request.paths.paths.length - result.unmatched_paths.length,
    inconclusive_paths: result.inconclusive.length, unmatched_paths: result.unmatched_paths.length,
    suppressed_unreachable_paths: result.suppressed_paths.length,
    unreferenced_acp: result.coverage_gaps.unreferenced_acp.length,
    uncovered_database_relevant_apis: result.coverage_gaps.uncovered_apis.length,
    unknown_api_relevance: result.coverage_gaps.unknown_api_relevance.length,
    out_of_model: result.out_of_model.length,
    no_mismatch_paths: result.path_results.filter(row => row.state === "NO_MISMATCH").length,
    bvac_candidates: result.findings.filter(row => row.missing_controls?.includes("VAC")).length,
    bhac_candidates: result.findings.filter(row => row.missing_controls?.includes("HAC")).length,
  };
  requireBac(Object.entries(statistics).every(([key, value]) => result.summary[key] === value), "差分分类账目不一致。");
  for (const finding of result.findings) {
    requireBac(finding.status === "CANDIDATE" && finding.validation_status === "NOT_PERFORMED" && finding.review_required === true, "候选状态无效。");
    requireBac(Object.keys(finding.tuple_ref ?? {}).sort().join() === "AC,D,O,R", "四元组被扩展。");
    const missing = finding.missing_controls;
    requireBac(Array.isArray(missing) && missing.length > 0 && new Set(missing).size === missing.length && missing.every(c => ["VAC", "HAC"].includes(c)), "缺失控制集合无效。");
    const classification = missing.length === 2 ? "BVAC_BHAC_CANDIDATE" : missing[0] === "VAC" ? "BVAC_CANDIDATE" : "BHAC_CANDIDATE";
    requireBac(finding.classification === classification && missing.every(c => finding.control_evaluation?.[c]?.state === "MISSING"), "候选分类与控制不一致。");
    const path = request.paths.paths.find(row => row.path_id === finding.path_id);
    requireBac(path && result.path_results.some(row => row.path_id === path.path_id && row.finding_id === finding.finding_id)
      && objectDigest(path.sink) === objectDigest(finding.sink) && objectDigest(path.entrypoint) === objectDigest(finding.entrypoint)
      && path.api_id === finding.api_id && request.acp.quadruples.some(row => objectDigest(row.tuple) === objectDigest(finding.tuple_ref)), "候选没有对应的原始路径或策略。");
  }
  const incomplete = result.limitations.length || result.path_results.some(row => row.gaps.length || ["INCONCLUSIVE", "UNMATCHED"].includes(row.state))
    || Object.values(result.coverage_gaps ?? {}).some(rows => !Array.isArray(rows) || rows.length);
  requireBac(result.summary.analysis_complete === !Boolean(incomplete), "分析完整性与缺口不一致。");
  return result;
}

export function validateRun(run) {
  verifySeal(run);
  requireBac(run.artifact_type === "bac-run" && run.engine_version === "bac-comparison.v1" && isDigest(run.engine_sha256), "差分运行来源无效。");
  requireBac(run.input && run.input_digest === objectDigest(run.input), "专项输入摘要无效。");
  const unit = unitForRequest(run.plan_binding, run.input);
  const identity = isTaskPlan(run.plan_binding) ? ["task_id", "attempt_id"] : ["focus_area_id", "assignment_id"];
  requireBac(["audit_id", "scope_digest", ...identity, "run_id"].every(key => run[key] === run.input[key])
    && objectDigest(run.producer) === objectDigest(run.input.producer) && unit.agent_name === run.producer.agent_name, "差分运行与输入身份不一致。");
  requireBac(run.input.acp?.producer?.agent_name === "security-threat-modeler" && nonempty(run.input.acp.producer.agent_session_id)
    && run.input.acp.producer.agent_session_id !== run.producer.agent_session_id
    && objectDigest(run.input.paths?.producer) === objectDigest(run.producer), "差分运行缺少独立策略生产者。");
  requireBac([run.input.acp, run.input.paths, run.input.api_catalog].every(value => value?.repository?.scope_digest === run.scope_digest
    && value.repository.root === run.input.source_root), "差分输入的源码范围不一致。");
  validateComparison(run.result, run.input);
  return run;
}

// Fact positions are checked against the frozen Plan, never inferred from prose.
export async function verifyEvidenceSources(plan, sourceRoot, objects) {
  const root = await realpath(sourceRoot);
  const index = new Map((plan.source_index ?? []).map(row => [row.path, row]));
  const cache = new Map();
  let malformedEvidence = false;
  async function locator(value) {
    requireBac(value && nonempty(value.file) && !isAbsolute(value.file) && Number.isInteger(value.line_start) && value.line_start > 0 && isDigest(value.source_digest), "证据定位字段无效。");
    const row = index.get(value.file);
    requireBac(row && row.sha256 === value.source_digest, "证据不属于冻结源码。");
    if (!cache.has(value.file)) {
      const path = resolve(root, value.file), info = await lstat(path);
      requireBac(inside(root, path) && info.isFile() && !info.isSymbolicLink() && inside(root, await realpath(path)), "源码位置越界或不是普通文件。");
      const bytes = await readFile(path);
      requireBac(sha256(bytes) === row.sha256, "源码自冻结后发生变化。");
      cache.set(value.file, bytes.toString("utf8").split(/\r?\n/u).length);
    }
    requireBac(value.line_start <= cache.get(value.file) && (value.line_end == null || (Number.isInteger(value.line_end) && value.line_end >= value.line_start && value.line_end <= cache.get(value.file))), "证据行号超出源码。");
  }
  async function walk(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) await walk(item); return; }
    if (Object.hasOwn(value, "file") || Object.hasOwn(value, "line_start")) await locator(value);
    if (value.locator && value.source_digest != null) requireBac(value.source_digest === value.locator.source_digest, "事实摘要与位置摘要不一致。");
    for (const [key, child] of Object.entries(value)) {
      if (["evidence", "policy_binding_evidence"].includes(key) && Array.isArray(child)) {
        for (const fact of child) {
          if (!(fact && nonempty(fact.claim) && nonempty(fact.kind) && fact.locator)) malformedEvidence = true;
          // A malformed fact must not hide another fact's invalid source or path.
          if (fact?.locator != null) await locator(fact.locator);
        }
      }
      await walk(child);
    }
  }
  await walk(objects);
  if (malformedEvidence) throw new BacEvidenceStructureError();
  return [...cache.keys()].sort();
}

export function validateReview(review, run, plan) {
  requireBac(review.contract_version === BAC_CONTRACT && review.run_digest === run.artifact_digest, "复查未绑定当前差分。");
  requireBac(review.audit_id === run.audit_id && review.scope_digest === run.scope_digest, "复查范围不匹配。");
  requireBac(review.producer?.agent_session_id === run.producer.agent_session_id && review.producer?.agent_name === run.producer.agent_name, "复查必须由当前专业工作包产生。");
  const expected = new Map(run.result.findings.map(row => [row.finding_id, row]));
  requireBac(Array.isArray(review.decisions) && review.decisions.length === expected.size, "每个 BAC 候选必须恰好有一个复查去向。");
  const platformIds = new Set();
  for (const decision of review.decisions) {
    const candidate = expected.get(decision.bac_finding_id);
    requireBac(candidate, "复查包含重复或未知候选。"); expected.delete(decision.bac_finding_id);
    requireBac(nonempty(decision.reason) && ["ACCEPTED", "INCONCLUSIVE", "REJECTED", "DUPLICATE"].includes(decision.disposition), "复查缺少处置或理由。");
    if (decision.disposition === "ACCEPTED") {
      const finding = decision.finding;
      const unit = unitForPlan(plan, run);
      let context;
      if (isTaskPlan(plan)) {
        requireBac(BAC_TYPES.has(finding?.classification?.vulnerability_type_id), "候选必须属于权限控制分析。");
        context = { task: { ...unit, attempt_id: run.attempt_id } };
      } else {
        const check = plan.checks?.find(row => row.check_id === finding?.routing?.primary_check_id);
        requireBac(check && unit?.check_ids.includes(check.check_id) && check.focus_area_id === run.focus_area_id && check.lens === "control-driven" && BAC_TYPES.has(check.vulnerability_type_id), "候选主 check 不属于当前权限工作包。");
        requireBac(check.domain === unit.domain, "候选跨责任域。");
        context = { check };
      }
      const errors = validateFinding(finding, { ...context, auditId: run.audit_id, scopeDigest: run.scope_digest, requireReportDetails: true });
      requireBac(!errors.length && finding.state === "CANDIDATE", `Finding v2 未通过：${errors.join("、")}`);
      requireBac(finding.bac_source?.run_digest === run.artifact_digest && finding.bac_source?.candidate_id === candidate.finding_id, "Finding 缺少 BAC 来源绑定。");
      requireBac(!platformIds.has(finding.finding_id), "平台 Finding ID 重复。"); platformIds.add(finding.finding_id);
      requireBac(finding.provenance.source_report_sha256 === run.artifact_digest, "Finding 来源摘要不匹配。");
    } else requireBac(!decision.finding, "未接入项不得携带未验证 Finding。");
    if (decision.disposition === "REJECTED") requireBac(Array.isArray(decision.evidence) && decision.evidence.length > 0, "否定候选必须提供可复核的反证。");
    if (decision.disposition === "DUPLICATE") requireBac(nonempty(decision.duplicate_of), "重复项必须引用平台 Finding。");
  }
  for (const decision of review.decisions.filter(row => row.disposition === "DUPLICATE")) requireBac(platformIds.has(decision.duplicate_of), "重复项必须指向本次已接入候选，跨包去重由 correlator 完成。");
  return review;
}

export function validateBacFindingBindings(findings, review, taskId = null) {
  requireBac(Array.isArray(findings) && Array.isArray(review?.decisions), "报告或专项复查缺少候选列表。");
  const accepted = review.decisions.filter(row => row.disposition === "ACCEPTED");
  for (const decision of accepted) {
    requireBac(nonempty(decision.finding?.finding_id), "专项接收项缺少 Finding ID。");
    const matches = findings.filter(row => row?.finding_id === decision.finding.finding_id);
    const finding = matches[0];
    if (matches.length !== 1 || findingObjectDigest(finding) !== findingObjectDigest(decision.finding)) {
      const fields = finding ? [...new Set([...Object.keys(finding), ...Object.keys(decision.finding)])]
        .filter(key => objectDigest([finding[key]]) !== objectDigest([decision.finding[key]])) : [];
      throw Object.assign(new Error(`越权专项：已接入候选未原样进入当前报告。任务 ${taskId ?? review.task_id ?? "未知"}；Finding ${decision.finding.finding_id}；${matches.length !== 1 ? "缺失或重复" : `差异字段：${fields.join("、")}`}。请原样使用专项 review 返回的 finding，不要追加展示字段。`),
        { code: "bac-finding-binding-mismatch", task_id: taskId, finding_id: decision.finding.finding_id, fields });
    }
  }
  const bound = new Set(accepted.map(row => row.finding.finding_id));
  const linked = findings.filter(row => row?.bac_source);
  requireBac(linked.length === bound.size && linked.every(row => bound.has(row.finding_id)), "报告含重复或无专项复查记录的 BAC 候选。");
  return accepted;
}

export async function validateBacAttachment({ reportsRoot, attachment, item, auditId, findings = [], sessionId }) {
  requireBac(attachment?.contract_version === BAC_CONTRACT, "工作包缺少专项交付。");
  if (["GAP", "NOT_APPLICABLE"].includes(attachment.status)) {
    requireBac(nonempty(attachment.reason), "未执行或不适用必须说明原因。");
    requireBac(!attachment.run && !attachment.review && !findings.some(row => row.bac_source), "缺口/不适用不得冒充差分证据。");
    if (attachment.status === "NOT_APPLICABLE") {
      requireBac(Array.isArray(attachment.evidence) && attachment.evidence.length > 0 && nonempty(attachment.source_root), "不适用必须有审查依据及源码根目录。");
      const plan = await planForAttachment(attachment.plan_path, item, auditId);
      if (isTaskPlan(plan)) requireBac(await realpath(attachment.source_root) === plan.source_root, "不适用证据与任务源码根目录不同。");
      await verifyEvidenceSources(plan, attachment.source_root, { evidence: attachment.evidence });
    }
    return { status: attachment.status, reason: attachment.reason, candidates: 0, accepted: 0, gaps: attachment.status === "GAP" ? [attachment.reason] : [] };
  }
  requireBac(["COMPLETE", "PARTIAL"].includes(attachment.status), "专项交付状态无效。");
  const { value: run } = await boundFile(reportsRoot, attachment.run);
  const { value: review } = await boundFile(reportsRoot, attachment.review);
  validateRun(run); verifySeal(review);
  const plan = await planForAttachment(run.input.plan_path, item, auditId);
  requireBac(run.artifact_type === "bac-run" && review.artifact_type === "bac-review", "专项制品类型无效。");
  const identity = isTaskPlan(plan) ? ["task_id", "attempt_id"] : ["focus_area_id", "assignment_id"];
  requireBac(run.audit_id === auditId && run.scope_digest === item.scope_digest && identity.every(key => run[key] === item[key])
    && run.producer.agent_session_id === sessionId && run.producer.agent_name === item.agent_name, "专项来源与工作包不匹配。");
  requireBac(review.run_digest === run.artifact_digest, "专项复查绑定失效。");
  requireBac(objectDigest(run.plan_binding) === item.bac_analysis?.plan_binding_digest
    && run.source_index_digest === item.bac_analysis?.source_index_digest, "专项引用了未分派的 Plan 或源码快照。");
  validateReview(review, run, run.plan_binding);
  const accepted = validateBacFindingBindings(findings, review, item.task_id);
  const gaps = [...run.result.limitations.map(row => JSON.stringify(row)), ...review.decisions.filter(row => row.disposition === "INCONCLUSIVE").map(row => row.reason)];
  if (!run.result.summary.analysis_complete) gaps.push("策略或路径覆盖尚未闭合。");
  if (run.result.out_of_model.length) gaps.push("存在模型外权限控制，须由原授权审计继续核对。");
  const status = gaps.length ? "PARTIAL" : "COMPLETE";
  requireBac(attachment.status === status, "专项状态隐藏了覆盖或复查缺口。");
  // Preserve every binding/accepted-finding check before a recoverable shape error.
  await verifyEvidenceSources(plan, run.input.source_root, [run.input.acp, run.input.paths, run.input.api_catalog, run.input.resource_role_catalog, review]);
  return { status, candidates: run.result.findings.length, accepted: accepted.length,
    paths: run.result.path_results.length, policies: run.result.summary.acp_quadruples,
    policy_bindings: run.input.acp.quadruples.map(row => row.tuple),
    run: attachment.run, review: attachment.review, gaps };
}
