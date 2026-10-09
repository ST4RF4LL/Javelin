import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PROTOCOL, atomicJson, check, controlledBytes, deliveryOutcome, digest, hash, summarize, timestamp } from "./contract.mjs";
import { readBoard } from "./store.mjs";
import { runtimeCandidates, verifyRuntimeEvidenceFiles } from "../runtime-testing/evidence.mjs";
import { renderStructuredBoardReport } from "./report.mjs";
import { summarizeTaskBac, taskBacEnabled } from "./bac.mjs";
import { BAC_EVIDENCE_STRUCTURE_ERROR } from "../bac/contract.mjs";

const nonempty = value => typeof value === "string" && value.trim();
const reviewState = board => ({ scope_digest: board.scope_digest, api_sources_digest: digest(board.api_sources), publication: board.publication, tasks: board.tasks.map(task => ({ task_id: task.task_id, spec_digest: task.spec_digest, status: task.status, report: task.report, reason: task.reason })), ...(board.mining_strategy ? { mining_strategy: board.mining_strategy } : {}),
  ...(board.report_corrections?.length ? { report_corrections: board.report_corrections } : {}),
  ...(taskBacEnabled(board) ? { bac_analysis: board.bac_analysis, bac_attempts: board.tasks.map(task => {
    const attempt = board.attempts.find(row => row.attempt_id === task.attempt_id);
    return { task_id: task.task_id, attempt_id: task.attempt_id, bac_plan: attempt?.bac_plan, bac_gap: attempt?.bac_gap, session_id: attempt?.session_id };
  }) } : {}) });
const binding = (path, bytes) => ({ path, sha256: hash(bytes) });
const sourceCandidate = (taskId, index, finding) => ({ candidate_id: `candidate-${hash(`${taskId}:${index}:${digest(finding)}`).slice(0, 32)}`,
  task_id: taskId, claim_scope: "SOURCE", source_finding_id: finding?.finding_id ?? null, finding });

async function invalidBacEvidence(summary, root, candidates, board, inputTasks, runtime) {
  const tasks = new Map(), blockedCandidates = new Set();
  for (const unit of summary?.units ?? []) {
    if (unit.evidence_error?.code !== BAC_EVIDENCE_STRUCTURE_ERROR) continue;
    tasks.set(unit.task_id, unit.reason);
  }
  if (!tasks.size) return { tasks, blockedCandidates };
  exactIds(inputTasks, board.tasks.map(task => task.task_id), "task_id");
  // Rebuild the whole candidate set so a copied finding cannot escape by changing
  // its task/ID/scope, or by deleting a removable display marker from the input.
  const expected = [];
  for (const task of board.tasks) if (task.report) {
    let report;
    try { report = await boundJson(root, task.report); } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    for (const [index, finding] of (Array.isArray(report?.findings) ? report.findings : []).entries()) {
      const candidate = sourceCandidate(task.task_id, index, finding); expected.push(candidate);
      if (tasks.has(task.task_id) && finding?.bac_source) blockedCandidates.add(candidate.candidate_id);
    }
  }
  if (runtime) for (const finding of runtimeCandidates(await boundJson(root, runtime), expected.map(row => row.finding))) expected.push({
    candidate_id: finding.finding_id, task_id: null, claim_scope: "RUNTIME_ONLY", source_mapping: "UNKNOWN", finding });
  check(candidates.length === expected.length, "无效专项附件的原始候选集合发生变化。");
  for (const row of expected) {
    const matches = candidates.filter(candidate => candidate.candidate_id === row.candidate_id);
    check(matches.length === 1 && digest((({ bac_gap, ...bound }) => bound)(matches[0])) === digest(row), "无效专项附件的原始候选绑定发生变化。");
  }
  return { tasks, blockedCandidates };
}

export async function prepareReview(store, { runtimeRequired = false, bacMode = "off" } = {}) {
  check(store.summary().mining_complete, "任务发布或挖掘尚未结束，不能进入报告复核。");
  const board = store.snapshot(), tasks = [], candidates = [];
  if (board.bac_analysis) check(board.bac_analysis.mode === bacMode, "复核专项选择与任务创建时不一致。");
  for (const task of board.tasks) {
    let report = null, parseGap = null;
    if (task.report) {
      const bytes = await controlledBytes(store.reportsRoot, task.report.path);
      check(hash(bytes) === task.report.sha256, "已接收报告发生变化。");
      try { report = JSON.parse(bytes.toString("utf8")); } catch { parseGap = "报告不是可解析的 JSON，需验证 Agent 阅读原文并记录补充任务。"; }
      if (!parseGap && (!Array.isArray(report?.findings) || !Array.isArray(report?.gaps) || !nonempty(report?.summary))) parseGap = "报告缺少明确的摘要、发现列表或缺口列表。";
      for (const [index, finding] of (Array.isArray(report?.findings) ? report.findings : []).entries()) {
        candidates.push(sourceCandidate(task.task_id, index, finding));
      }
    }
    tasks.push({ task_id: task.task_id, kind: task.kind, title: task.title, domain: task.domain, prompt: task.prompt, code_refs: task.code_refs,
      status: task.status, report: task.report, reason: task.reason, parse_gap: parseGap, reported_gaps: Array.isArray(report?.gaps) ? report.gaps : [] });
  }
  let runtime = null;
  if (runtimeRequired) {
    const path = `runtime-testing/${board.audit_id}/evidence-set.json`;
    const bytes = await controlledBytes(store.reportsRoot, path);
    const evidence = await verifyRuntimeEvidenceFiles(join(store.reportsRoot, path));
    const authorization = JSON.parse(await readFile(join(store.reportsRoot, "runtime-testing", board.audit_id, "authorization.json"), "utf8"));
    check(evidence.audit_id === board.audit_id && authorization.scope_digest === board.scope_digest, "运行证据与本次审计范围不匹配。");
    runtime = { ...binding(path, bytes), evidence };
    for (const candidate of runtimeCandidates(evidence, candidates.map(row => row.finding))) candidates.push({
      candidate_id: candidate.finding_id, task_id: null, claim_scope: "RUNTIME_ONLY", source_mapping: "UNKNOWN", finding: candidate });
  }
  const bacSummary = await summarizeTaskBac(board, store.reportsRoot);
  const invalidBac = await invalidBacEvidence(bacSummary, store.reportsRoot, candidates, board, tasks, runtime);
  for (const task of tasks) if (invalidBac.tasks.has(task.task_id)) task.bac_gap = invalidBac.tasks.get(task.task_id);
  for (const candidate of candidates) if (invalidBac.blockedCandidates.has(candidate.candidate_id)) candidate.bac_gap = invalidBac.tasks.get(candidate.task_id);
  const input = { protocol: PROTOCOL, artifact_type: "task-board-review-input", audit_id: board.audit_id, scope_digest: board.scope_digest,
    ...(board.mining_strategy ? { mining_strategy: board.mining_strategy } : {}),
    ...(bacSummary ? { bac_summary: bacSummary } : {}),
    board_digest: digest(reviewState(board)), bac_mode: bacMode, tasks, candidates, runtime };
  const bytes = Buffer.from(`${JSON.stringify(input, null, 2)}\n`);
  const path = `validation/task-board.${board.audit_id}.input.${hash(bytes)}.json`;
  await mkdir(dirname(join(store.reportsRoot, path)), { recursive: true });
  await writeFile(join(store.reportsRoot, path), bytes, { mode: 0o600 });
  const ref = binding(path, bytes);
  await store.mutate(next => {
    check(digest(reviewState(next)) === input.board_digest, "复核准备期间任务范围已变化。");
    if (next.validation.input?.sha256 !== ref.sha256) next.validation = { status: "NOT_STARTED", input: ref };
  });
  return { ...ref, task_count: tasks.length, candidate_count: candidates.length };
}

async function boundJson(root, ref) {
  check(ref && typeof ref.path === "string" && /^[a-f0-9]{64}$/.test(ref.sha256 ?? ""), "复核制品绑定无效。");
  const bytes = await controlledBytes(root, ref.path);
  check(hash(bytes) === ref.sha256, "复核制品摘要不匹配。");
  return JSON.parse(bytes.toString("utf8"));
}

function exactIds(rows, ids, field) {
  check(Array.isArray(rows) && rows.length === ids.length && new Set(rows.map(row => row[field])).size === ids.length
    && rows.every(row => ids.includes(row[field])), "复核结果必须逐项覆盖输入，不能遗漏、重复或新增标识。");
}

export async function validateReviewBundle(board, root, bundle) {
  const input = await boundJson(root, board.validation.input);
  check(input.audit_id === board.audit_id && input.board_digest === digest(reviewState(board)), "复核输入与当前任务面板不一致。");
  check((input.mining_strategy ?? null) === (board.mining_strategy ?? null), "复核输入未绑定本次漏洞挖掘策略。");
  if (board.bac_analysis) check(input.bac_mode === board.bac_analysis.mode, "复核输入的专项选择发生变化。");
  const bacSummary = await summarizeTaskBac(board, root);
  if (taskBacEnabled(board)) check(digest(input.bac_summary) === digest(bacSummary), "专项汇总与当前任务制品不一致。");
  const invalidBac = await invalidBacEvidence(bacSummary, root, input.candidates, board, input.tasks, input.runtime);
  for (const task of input.tasks) if (task.report) {
    const bytes = await controlledBytes(root, task.report.path); check(hash(bytes) === task.report.sha256, "已接收报告发生变化。");
  }
  if (input.runtime) {
    const bytes = await controlledBytes(root, input.runtime.path); check(hash(bytes) === input.runtime.sha256, "运行证据发生变化。");
    await verifyRuntimeEvidenceFiles(join(root, input.runtime.path));
  }
  const quality = await boundJson(root, bundle.quality);
  const sessions = new Set();
  function header(doc, role) {
    check(doc.protocol === PROTOCOL && doc.audit_id === board.audit_id && doc.input_sha256 === board.validation.input.sha256 && doc.role === role, "复核角色、审计或输入摘要不匹配。");
    check(nonempty(doc.agent_session_id) && !sessions.has(doc.agent_session_id), "复核角色必须使用独立的真实会话。"); sessions.add(doc.agent_session_id);
  }
  header(quality, "REPORT_REVIEW");
  exactIds(quality.assessments, input.tasks.map(task => task.task_id), "task_id");
  for (const row of quality.assessments) {
    check(["REVIEWED", "NEEDS_FOLLOWUP", "GAP"].includes(row.status) && nonempty(row.reason) && Array.isArray(row.evidence_refs) && Array.isArray(row.gaps), "报告质量复核字段不完整。");
    const task = input.tasks.find(task => task.task_id === row.task_id);
    if (task.parse_gap || task.status === "GAP" || task.reported_gaps.length || invalidBac.tasks.has(row.task_id)) check(row.status !== "REVIEWED", "报告解析失败、执行缺口、自报缺口或专项证据缺口必须保留为待补充。");
    if (row.status === "REVIEWED") check(row.evidence_refs.length > 0 && row.gaps.length === 0, "审查充分的结论必须引用证据且没有未解决缺口。");
  }
  if (input.bac_mode === "auto") check(quality.bac_analysis && ["REVIEWED", "GAP"].includes(quality.bac_analysis.status)
    && nonempty(quality.bac_analysis.reason) && Array.isArray(quality.bac_analysis.evidence_refs)
    && (quality.bac_analysis.status !== "REVIEWED" || quality.bac_analysis.evidence_refs.length), "启用的越权专项必须复核并保留证据或具体缺口。");
  if (input.bac_summary?.status === "PARTIAL") check(quality.bac_analysis?.status === "GAP", "专项制品仍有缺口，不能以文字复核标为完成。");
  const roles = {}, ids = input.candidates.map(row => row.candidate_id);
  if (ids.length) {
    for (const [key, role, verdicts] of [
      ["affirmative", "AFFIRMATIVE", ["PROVEN", "NOT_PROVEN", "INCONCLUSIVE"]],
      ["negative", "NEGATIVE", ["REFUTED", "NOT_REFUTED", "INCONCLUSIVE"]],
      ["moderator", "MODERATOR", ["TRUE_POSITIVE", "FALSE_POSITIVE", "INCONCLUSIVE"]],
    ]) {
      const doc = await boundJson(root, bundle[key]); header(doc, role);
      exactIds(doc.findings, ids, "candidate_id");
      for (const row of doc.findings) check(verdicts.includes(row.verdict) && nonempty(row.reason) && Array.isArray(row.evidence_refs) && Array.isArray(row.gaps)
        && (row.verdict === "INCONCLUSIVE" || row.evidence_refs.length > 0), "漏洞复核结论或证据字段不完整。");
      if (key !== "affirmative") check(doc.affirmative_sha256 === bundle.affirmative.sha256, "复核未绑定正方证据。");
      if (key === "moderator") check(doc.negative_sha256 === bundle.negative.sha256, "裁决未绑定反方证据。");
      if (key === "moderator") for (const row of doc.findings) check(!invalidBac.blockedCandidates.has(row.candidate_id) || row.verdict !== "TRUE_POSITIVE", "专项附件证据结构无效的 BAC 候选不得确认为真实漏洞。");
      roles[key] = doc;
    }
  }
  return { input, quality, roles };
}

export async function acceptReview(store, bundle) {
  const checked = await validateReviewBundle(store.snapshot(), store.reportsRoot, bundle);
  await store.mutate(board => {
    check(!board.final_report || digest(board.validation.bundle) === digest(bundle), "已封存报告的复核不能替换，请在后续审计中补充。");
    check(board.validation.input?.sha256 === checked.quality.input_sha256, "复核期间输入已改变。");
    board.validation = { status: "REVIEWED", input: board.validation.input, bundle, assessments: checked.quality.assessments, reviewed_at: timestamp() };
  });
  return { reviewed: checked.input.tasks.length, candidates: checked.input.candidates.length };
}

export function renderBoardReport(model) {
  if (model.report_version >= 3) return renderStructuredBoardReport(model);
  const noReports = model.report_version >= 2 && model.delivery_outcome === "NO_REPORTS";
  const outcomeLines = model.report_version >= 2
    ? model.delivery_outcome === "NO_REPORTS" ? ["**审计执行未完成：本轮未收到任何源码审计报告，全部任务均登记为执行缺口。以下内容仅记录失败原因与缺口，无法据此判断目标是否存在漏洞。修复执行问题后须重新创建审计。**", ""]
      : model.delivery_outcome === "PARTIAL" ? ["**本轮仅收到部分任务的审计报告。漏洞结论仅限已交付且完成复核的证据，未交付任务仍须补充审计。**", ""]
        : model.delivery_outcome === "NO_TASKS" ? ["**本轮未发布审计任务，无法据此判断目标是否存在漏洞。**", ""] : []
    : [];
  const strategy = model.summary.mining_strategy;
  const strategyDescription = strategy === "api"
    ? "本次采用逐接口 API 审查策略，逐项分析用户提供清单中的接口。交付比例不代表已发现所有漏洞，也不证明接口清单覆盖全部应用入口。"
    : strategy === "focus_area"
      ? "本次采用高风险 Focus Area 策略，对威胁建模识别的高风险主题定向深入分析。交付比例不代表已发现所有漏洞或已逐一审查全部接口。"
      : "Focus Area 为高风险定向审查；API 为用户提供清单中的逐接口审查。交付比例不代表已发现所有漏洞，也不证明接口清单覆盖全部应用入口。";
  const trackLines = strategy === "focus_area"
    ? [`Focus Area：${model.summary.tracks.focus_area.reported}/${model.summary.tracks.focus_area.total}。`]
    : strategy === "api"
      ? [`API 任务：${model.summary.tracks.api.reported}/${model.summary.tracks.api.total}。`, `用户提交 API ${model.summary.api_inventory.submitted} 项，相关任务全部交付 ${model.summary.api_inventory.reported} 项。`]
      : [`Focus Area：${model.summary.tracks.focus_area.reported}/${model.summary.tracks.focus_area.total}；API 任务：${model.summary.tracks.api.reported}/${model.summary.tracks.api.total}。`, `用户提交 API ${model.summary.api_inventory.submitted} 项，相关任务全部交付 ${model.summary.api_inventory.reported} 项。`];
  const lines = [noReports ? "# 审计执行失败记录" : "# 安全审计报告", "", `审计标识：${model.audit_id}`, `源码范围摘要：${model.scope_digest}`, "",
    ...outcomeLines,
    "## 任务执行与复核", "", strategyDescription, "",
    `任务 ${model.summary.total} 项，收到报告 ${model.summary.reported} 项，执行缺口 ${model.summary.gap} 项。`,
    ...trackLines, "",
    "## 已确认源码漏洞", ""];
  for (const row of model.findings) lines.push(`### ${row.title ?? row.finding_id}`, "", row.description ?? row.summary ?? "", "",
    `严重性：${typeof row.severity === "string" ? row.severity : row.severity?.rating ?? "未评级"}；代码位置：${row.location ? JSON.stringify(row.location) : "见绑定审计报告"}。`,
    `复核依据：${row.review.reason}`, `证据：${row.review.evidence_refs.map(ref => typeof ref === "string" ? ref : JSON.stringify(ref)).join("；")}`,
    `修复建议：${typeof row.remediation === "string" ? row.remediation : row.remediation?.summary ?? "见绑定审计报告"}`, "");
  if (!model.findings.length) lines.push(noReports ? "没有可供源码漏洞复核的审计报告；本轮无法形成源码安全结论。" : "本次未形成经三方复核确认的源码漏洞。", "");
  lines.push("## 任务复核明细", "");
  for (const task of model.tasks) {
    const review = model.assessments.find(row => row.task_id === task.task_id);
    lines.push(`- ${task.title}（${task.kind === "api" ? "API" : "Focus Area"} / ${task.domain}）：${review?.status === "REVIEWED" ? "已复核" : "存在缺口或待补充"}。${review?.reason ?? task.reason ?? ""}${task.report ? ` 原始报告：${task.report.path}` : ""}`);
  }
  lines.push("", "## 剩余缺口", "", ...model.residual_gaps.map(gap => `- ${gap}`));
  if (!model.residual_gaps.length) lines.push("已发布任务的复核未记录剩余缺口。");
  lines.push("", "## 运行测试与清理", "", `状态：${model.runtime?.status ?? "SKIPPED"}；原因：${model.runtime?.reason ?? "未启用动态验证"}；清理：${model.runtime?.cleanup_status ?? "NOT_REQUIRED"}。`);
  for (const packet of model.runtime?.packets ?? []) lines.push(`- ${packet.id}：${packet.result?.summary ?? packet.reason ?? packet.execution_status}；清理状态 ${packet.cleanup_status}。${JSON.stringify(packet.result?.changes ?? [])}`);
  if (model.runtime_findings.length) { lines.push("", "### 仅运行环境结论", ""); for (const row of model.runtime_findings) lines.push(`- ${row.finding_id}：${row.review.verdict}。${row.review.reason}（源码映射未知）`); }
  if (model.bac_analysis) lines.push("", "## 越权专项", "", model.bac_analysis.reason);
  lines.push("", "## 排除及未确定候选", "");
  for (const row of model.excluded_findings) lines.push(`- ${row.title ?? row.finding_id}：${row.review.verdict}。${row.review.reason}`);
  return `${lines.join("\n")}\n`;
}

function finalModel(board, { input, quality, roles }) {
  const findings = [], excluded = [], runtimeFindings = [];
  for (const candidate of input.candidates) {
    const review = roles.moderator.findings.find(row => row.candidate_id === candidate.candidate_id);
    const row = { ...(candidate.finding && typeof candidate.finding === "object" ? candidate.finding : {}), finding_id: candidate.candidate_id, task_id: candidate.task_id,
      claim_scope: candidate.claim_scope, review, validation_state: review.verdict };
    if (candidate.claim_scope === "RUNTIME_ONLY") runtimeFindings.push(row);
    else (review.verdict === "TRUE_POSITIVE" ? findings : excluded).push(row);
  }
  const residualGaps = [
    ...(board.publication.empty_reason ? [board.publication.empty_reason] : []),
    ...input.tasks.flatMap(task => [task.reason, task.parse_gap, task.bac_gap, ...task.reported_gaps.map(gap => typeof gap === "string" ? gap : JSON.stringify(gap))].filter(Boolean).map(reason => `${task.title}：${reason}`)),
    ...quality.assessments.filter(row => row.status !== "REVIEWED").map(row => `${row.task_id}：${row.reason}`),
    ...quality.assessments.flatMap(row => row.gaps.map(gap => `${row.task_id}：${gap}`)),
    ...excluded.filter(row => row.review.verdict === "INCONCLUSIVE").map(row => `${row.finding_id}：${row.review.reason}`),
    ...Object.values(roles).flatMap(role => role.findings.flatMap(row => row.gaps.map(gap => `${role.role}/${row.candidate_id}：${gap}`))),
    ...(input.runtime?.evidence.packets ?? []).flatMap(packet => (packet.result?.gaps ?? (packet.reason ? [packet.reason] : [])).map(gap => `运行工作包 ${packet.id}：${gap}`)),
    ...(quality.bac_analysis?.status === "GAP" ? [`越权专项：${quality.bac_analysis.reason}`] : []),
    ...(input.bac_summary?.gaps ?? []).map(gap => `越权专项：${gap}`),
    ...((input.runtime && ["FAILED", "UNKNOWN"].includes(input.runtime.evidence.cleanup_status)) ? ["运行测试清理未确认完成，须按封存证据中的测试范围和残留记录人工处理。"] : []),
  ];
  const { revision, next_action, ...summary } = summarize(board);
  // Sealed v1/v2 artifacts must still reproduce their original model and bytes.
  const reportVersion = board.final_report ? board.final_report.report_version ?? 1 : 3;
  return { protocol: PROTOCOL, artifact_type: "task-board-final-report", audit_id: board.audit_id, scope_digest: board.scope_digest,
    ...(reportVersion >= 2 ? { report_version: reportVersion, delivery_outcome: deliveryOutcome(summary) } : {}),
    board_digest: input.board_digest, inputs: { intake: board.validation.input, ...board.validation.bundle }, summary, tasks: input.tasks,
    assessments: quality.assessments, findings, excluded_findings: excluded, runtime_findings: runtimeFindings,
    ...(board.report_corrections?.length ? { report_corrections: board.report_corrections } : {}),
    runtime: input.runtime?.evidence ?? null, bac_analysis: quality.bac_analysis ? { ...quality.bac_analysis,
      ...(input.bac_summary ? { summary: input.bac_summary } : {}) } : null, residual_gaps: [...new Set(residualGaps)] };
}

export async function finalizeBoard(store) {
  // Serialize validation, artifact writes and sealing with report corrections.
  return store.mutate(async board => {
    check(summarize(board).mining_complete && board.validation.status === "REVIEWED", "报告尚未收齐或后续复核未完成。");
    const model = finalModel(board, await validateReviewBundle(board, store.reportsRoot, board.validation.bundle));
    const modelPath = `final/task-board-report-model.${board.audit_id}.json`, reportPath = `final/security-audit-report.${board.audit_id}.md`;
    if (board.final_report) {
      check((await controlledBytes(store.reportsRoot, reportPath)).toString("utf8") === renderBoardReport(model)
        && digest(JSON.parse((await controlledBytes(store.reportsRoot, modelPath)).toString("utf8"))) === digest(model), "已封存报告发生变化，不能静默覆盖。");
      return { report_path: reportPath, delivery_outcome: deliveryOutcome(model.summary), findings: model.findings.length, gaps: model.residual_gaps.length };
    }
    await atomicJson(join(store.reportsRoot, modelPath), model);
    const markdown = renderBoardReport(model);
    await writeFile(join(store.reportsRoot, reportPath), markdown, { mode: 0o600 });
    await atomicJson(join(store.reportsRoot, "correlation", `task-board.${board.audit_id}.json`), { protocol: PROTOCOL, audit_id: board.audit_id, canonical_findings: [...model.findings, ...model.excluded_findings] });
    board.final_report = { path: reportPath, sha256: hash(markdown), model: modelPath, model_sha256: hash(`${JSON.stringify(model, null, 2)}\n`), report_version: model.report_version };
    return { report_path: reportPath, delivery_outcome: deliveryOutcome(model.summary), findings: model.findings.length, gaps: model.residual_gaps.length };
  });
}

export async function verifyBoardCompletion({ audit, reportsRoot }) {
  const board = await readBoard(audit.task_board_path), summary = summarize(board), errors = [];
  if ((board.mining_strategy ?? null) !== (audit.mining_strategy ?? null)) errors.push("任务面板与创建时的漏洞挖掘策略不一致。");
  if (!summary.mining_complete) errors.push("任务发布或报告收集尚未结束。");
  if (board.validation.status !== "REVIEWED") errors.push("后续报告复核尚未完成。");
  if (!board.final_report) errors.push("最终中文报告尚未封存。");
  if (!errors.length) {
    try {
      const checked = await validateReviewBundle(board, reportsRoot, board.validation.bundle);
      check(Boolean(checked.input.runtime) === Boolean(audit.runtime_testing)
        && checked.input.bac_mode === (audit.bac_analysis?.mode ?? "off"), "最终复核未绑定创建时的运行测试或专项选择。");
      const ref = board.final_report, modelBytes = await controlledBytes(reportsRoot, ref.model), reportBytes = await controlledBytes(reportsRoot, ref.path);
      const model = JSON.parse(modelBytes.toString("utf8"));
      check(hash(modelBytes) === ref.model_sha256 && hash(reportBytes) === ref.sha256 && reportBytes.toString("utf8") === renderBoardReport(model), "最终报告或模型发生变化。");
      check(model.audit_id === audit.id && model.scope_digest === audit.source_baseline?.scope_digest && model.board_digest === checked.input.board_digest
        && digest(model) === digest(finalModel(board, checked)), "最终报告与任务及复核绑定不一致。");
    } catch (error) { errors.push(error.message); }
  }
  return { complete: errors.length === 0, errors, summary, delivery_outcome: deliveryOutcome(summary), final_report_path: board.final_report?.path ?? null };
}
