import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { check, controlledBytes, digest, hash, timestamp } from "./contract.mjs";

export async function verifyIncrementalReplacement(task, bytes, root) {
  const ref = task.incremental?.previous_report;
  if (!ref) return;
  let previous;
  try { previous = await boundJson(root, ref); } catch (error) { if (!(error instanceof SyntaxError)) throw error; return; }
  if (!Array.isArray(previous?.findings) || !previous.findings.length) return;
  let replacement;
  try { replacement = JSON.parse(bytes.toString("utf8")); } catch { check(false, "增量替代报告必须为完整 JSON，不能丢失原有发现。"); }
  check(Array.isArray(replacement?.findings), "增量替代报告缺少发现列表。");
  const retained = new Set(replacement.findings.map(digest));
  for (const finding of previous.findings) {
    const fingerprint = digest(finding);
    if (retained.has(fingerprint)) continue;
    const change = replacement.incremental_changes?.find(row => row.previous_finding_sha256 === fingerprint);
    check(change && typeof change.reason === "string" && change.reason.trim() && Array.isArray(change.evidence_refs) && change.evidence_refs.length > 0,
      `增量报告遗漏或修改了原有发现 ${fingerprint}；须保留原发现，或通过 incremental_changes 提供变更原因和证据。`);
  }
}

async function boundJson(root, ref) {
  const bytes = await controlledBytes(root, ref.path);
  check(hash(bytes) === ref.sha256, "历史制品摘要不匹配，不能基于被改写的报告增量审计。");
  return JSON.parse(bytes.toString("utf8"));
}

// The plan is derived from durable evidence, never from the current UI filter.
export async function incrementalPlan(board, root) {
  const reasons = new Map();
  const taskIds = new Set(board.tasks.map(task => task.task_id));
  const add = (id, reason) => {
    if (!taskIds.has(id)) return;
    if (!reasons.has(id)) reasons.set(id, []);
    reasons.get(id).push(reason);
  };
  for (const task of board.tasks) {
    if (task.status !== "REPORTED") add(task.task_id, task.reason || `任务尚未完成（${task.status}）。`);
    if (task.status === "REPORTED" && !task.report) add(task.task_id, "缺少已接收报告。");
    if (task.report) {
      let report, parsed = false;
      try { report = await boundJson(root, task.report); parsed = true; }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; add(task.task_id, "原报告无法解析，需要重新交付结构化报告。"); }
      if (parsed) {
        if (!Array.isArray(report?.findings) || !Array.isArray(report?.gaps) || typeof report?.summary !== "string" || !report.summary.trim()) add(task.task_id, "原报告缺少摘要、发现或缺口列表。");
        for (const gap of Array.isArray(report?.gaps) ? report.gaps : []) add(task.task_id, typeof gap === "string" ? gap : JSON.stringify(gap));
      }
    }
  }
  for (const row of board.validation?.assessments ?? []) {
    if (row.status !== "REVIEWED") add(row.task_id, row.reason || "内容复核要求补充分析。");
    for (const gap of row.gaps ?? []) add(row.task_id, typeof gap === "string" ? gap : JSON.stringify(gap));
  }
  if (board.validation?.input) {
    const input = await boundJson(root, board.validation.input);
    for (const task of input.tasks ?? []) for (const key of ["parse_gap", "bac_gap"]) if (task[key]) add(task.task_id, task[key]);
  }
  if (board.final_report) {
    const model = await boundJson(root, { path: board.final_report.model, sha256: board.final_report.model_sha256 });
    for (const row of model.excluded_findings ?? []) if (row.review?.verdict === "INCONCLUSIVE") add(row.task_id, row.review.reason || "漏洞候选证据尚不充分。");
  }
  const files = (board.file_sweep?.files ?? []).filter(file => ["GAP", "PENDING", "READING"].includes(file.status)).map(file => file.file_id);
  return { tasks: [...reasons].map(([task_id, items]) => ({ task_id, reasons: [...new Set(items)] })), files,
    publication_pending: board.publication.state !== "SEALED",
    review_pending: board.tasks.length > 0 && (!board.final_report || board.validation?.status !== "REVIEWED") };
}

export const hasIncrementalWork = plan => Boolean(plan.tasks.length || plan.files.length || plan.publication_pending || plan.review_pending);

// The caller holds the store's exclusive lock and has checked the frozen source.
export async function reopenIncremental(store, requestDigest) {
  return store.mutate(async board => {
    const duplicate = board.incremental_rounds?.find(round => round.request_digest === requestDigest);
    if (duplicate) return duplicate;
    const plan = await incrementalPlan(board, store.reportsRoot);
    check(hasIncrementalWork(plan), "没有需要增补的任务、文件或报告复核。");
    const number = (board.incremental_rounds?.length ?? 0) + 1;
    const prefix = `task-board/${board.audit_id}/.incremental/${number}-${requestDigest.slice(0, 16)}`;
    async function archive(name, bytes, expected) {
      check(!expected || hash(bytes) === expected, "原报告摘要不匹配，拒绝覆盖历史交付。");
      const path = `${prefix}/${name}`;
      await mkdir(dirname(join(store.reportsRoot, path)), { recursive: true });
      try { await writeFile(join(store.reportsRoot, path), bytes, { mode: 0o600, flag: "wx" }); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        check((await readFile(join(store.reportsRoot, path))).equals(bytes), "增量审计历史快照发生冲突。");
      }
      return { path, sha256: hash(bytes) };
    }
    const previous = {};
    if (board.final_report) {
      previous.report = await archive("report.md", await controlledBytes(store.reportsRoot, board.final_report.path), board.final_report.sha256);
      previous.model = await archive("model.json", await controlledBytes(store.reportsRoot, board.final_report.model), board.final_report.model_sha256);
    }
    previous.board = await archive("board.json", Buffer.from(`${JSON.stringify(board, null, 2)}\n`));
    const round = { number, request_digest: requestDigest, started_at: timestamp(), task_ids: plan.tasks.map(task => task.task_id),
      file_ids: plan.files, previous, publication_pending: plan.publication_pending };
    for (const item of plan.tasks) {
      const task = board.tasks.find(task => task.task_id === item.task_id);
      task.incremental = { round: number, reasons: item.reasons, previous_report: task.report ?? task.incremental?.previous_report ?? null,
        previous_attempt_id: task.attempt_id, previous_validation: board.validation.assessments?.find(row => row.task_id === task.task_id) ?? null };
      if (task.incremental.previous_report) {
        try {
          const old = await boundJson(store.reportsRoot, task.incremental.previous_report);
          task.incremental.previous_findings = (Array.isArray(old?.findings) ? old.findings : []).map(finding => ({ finding_id: finding.finding_id ?? null, sha256: digest(finding) }));
        } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
      const attempt = board.attempts.find(row => row.attempt_id === task.attempt_id);
      if (attempt?.status === "RUNNING") { attempt.status = "INTERRUPTED"; attempt.reason = "增量审计替换未完成尝试。"; }
      Object.assign(task, { status: "PENDING", attempt_id: null, report: null, reason: null, failure_count: 0 });
      delete task.completed_at; delete task.timeout_recovery;
    }
    for (const file of board.file_sweep?.files ?? []) if (plan.files.includes(file.file_id)) {
      file.incremental = { round: number, reason: file.reason };
      Object.assign(file, { status: "PENDING", attempt_id: null, reason: null });
      delete file.read_error;
    }
    if (plan.files.length) board.publication = { state: "OPEN", empty_reason: null };
    delete board.suspension;
    board.final_report = null;
    board.validation = { status: "NOT_STARTED" };
    (board.incremental_rounds ??= []).push(round);
    return round;
  });
}
