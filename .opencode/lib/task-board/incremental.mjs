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

// Execution failures are distinct from incomplete evidence or unfinished planning.
export function retryableFailure(task, board) {
  if (!["FAILED", "GAP"].includes(task.status)) return null;
  const attempt = board.attempts?.find(row => row.attempt_id === task.attempt_id && row.task_id === task.task_id);
  const failure = task.execution_failure;
  if (failure?.retryable === false) return null;
  if (failure && failure.attempt_id === task.attempt_id && attempt?.status === "FAILED") return failure;
  // Legacy skip() retained the last failed attempt even after changing FAILED to GAP.
  if (attempt?.status === "FAILED" && (task.status === "FAILED" || task.failure_count > 0 || task.timeout_recovery?.exhausted === true)) {
    return { attempt_id: attempt.attempt_id, kind: "EXECUTION_FAILED", retryable: true };
  }
  return null;
}

export async function incrementalPlan(board, _root) {
  const tasks = board.tasks.flatMap(task => {
    const failure = retryableFailure(task, board);
    return failure ? [{ task_id: task.task_id, source_attempt_id: failure.attempt_id,
      failure_kind: failure.kind, reasons: [task.reason || "工作项执行失败，需要重新执行。"] }] : [];
  });
  return { mode: "FAILED_ITEMS_ONLY", tasks, files: [], publication_pending: false, review_pending: false };
}

export const hasIncrementalWork = plan => Boolean(plan.tasks.length);

// The caller holds the store's exclusive lock and has checked the frozen source.
export async function reopenIncremental(store, requestDigest) {
  return store.mutate(async board => {
    const duplicate = board.incremental_rounds?.find(round => round.request_digest === requestDigest);
    if (duplicate) return duplicate;
    const plan = await incrementalPlan(board, store.reportsRoot);
    check(hasIncrementalWork(plan), "没有执行失败的工作项，无需增量审计。");
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
    const round = { number, mode: "FAILED_ITEMS_ONLY", request_digest: requestDigest, started_at: timestamp(),
      board_revision: board.revision, scope_digest: board.scope_digest, task_ids: plan.tasks.map(task => task.task_id),
      source_attempt_ids: plan.tasks.map(task => task.source_attempt_id), file_ids: [], previous, publication_pending: false };
    board.active_round = { number, mode: round.mode, work_item_ids: [...round.task_ids], source_attempt_ids: [...round.source_attempt_ids] };
    for (const item of plan.tasks) {
      const task = board.tasks.find(task => task.task_id === item.task_id);
      task.incremental = { round: number, reasons: item.reasons, previous_report: task.report ?? task.incremental?.previous_report ?? null,
        previous_attempt_id: task.attempt_id, previous_failure: task.execution_failure ?? { kind: item.failure_kind, attempt_id: item.source_attempt_id }, previous_validation: board.validation.assessments?.find(row => row.task_id === task.task_id) ?? null };
      if (task.incremental.previous_report) {
        try {
          const old = await boundJson(store.reportsRoot, task.incremental.previous_report);
          task.incremental.previous_findings = (Array.isArray(old?.findings) ? old.findings : []).map(finding => ({ finding_id: finding.finding_id ?? null, sha256: digest(finding) }));
        } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
      const attempt = board.attempts.find(row => row.attempt_id === task.attempt_id);
      if (attempt?.status === "RUNNING") { attempt.status = "INTERRUPTED"; attempt.reason = "增量审计替换未完成尝试。"; }
      Object.assign(task, { status: "PENDING", attempt_id: null, report: null, reason: null, failure_count: 0 });
      delete task.completed_at; delete task.timeout_recovery; delete task.execution_failure;
    }
    delete board.suspension;
    board.final_report = null;
    board.validation = { status: "NOT_STARTED" };
    (board.incremental_rounds ??= []).push(round);
    return round;
  });
}
