// Presentation fields are derived from live execution state; they are not
// evidence that a report's contents have passed review.
export function applyAuditProgress(audit) {
  const board = audit.task_board ?? (audit.todo?.protocol === "task-board.v1" ? audit.todo : null);
  if (!board) return audit;
  if (audit.audit_mode === "dynamic") {
    const runtime = audit.runtime_testing_state;
    const finalized = board.next_action === "DONE" || audit.todo_completion?.complete === true || audit.status === "completed";
    const graph = runtime?.exploration;
    const closed = ["CLOSED", "BLOCKED", "QUARANTINED", "SKIPPED"].includes(runtime?.status);
    const steps = [["contact", "环境接触", !!runtime?.baseline_packet], ["explore", "动态探索", graph?.status === "COMPLETED" || closed], ["cleanup", "证据与清理封存", closed], ["validation", "独立三方复核", board.validation?.status === "REVIEWED"], ["report", "报告封存", finalized]];
    let active = false;
    const stages = steps.map(([id, label, done]) => { const state = done ? "completed" : !active && audit.status === "running" ? "active" : "pending"; if (!done) active = true; return { id, label, state }; });
    const completed = (runtime?.packets ?? []).filter(packet => packet.execution_status === "COMPLETED").length;
    return { ...audit, task_board: board, stages, stage: audit.status === "queued" ? "等待调度" : finalized ? "动态报告已封存" : stages.find(row => row.state === "active")?.label ?? "动态测试",
      progress: Math.round(steps.filter(step => step[2]).length * 100 / steps.length), progress_source: "runtime-testing",
      progress_text: `动态工作包完成 ${completed}/${runtime?.packets?.length ?? 0} · 探索 ${graph?.rounds ?? 0} 轮${closed ? " · 证据已封存" : ""}` };
  }
  const sealed = board.publication === "SEALED";
  const mined = board.mining_complete === true;
  const reviewed = board.validation?.status === "REVIEWED";
  const finalized = board.next_action === "DONE" || audit.todo_completion?.complete === true || audit.status === "completed";
  const total = Number(board.total) || 0, reported = Number(board.reported) || 0;
  const sweep = board.file_sweep;
  const noReports = mined && (total > 0 && reported === 0 || Boolean(sweep) && total === 0 && !sweep.browsed_files);
  const definitions = [
    ["scope", "范围冻结", Boolean(audit.paths || audit.source_baseline || sealed)],
    ["planning", sweep ? "逐文件浏览与任务发布" : "任务规划与发布", sealed],
    ["audit", noReports ? "任务执行（未收到报告）" : "任务执行与报告收集", mined],
    ["validation", "报告内容复核", reviewed],
    ["report", "报告封存", finalized],
  ];
  let active = false;
  const stopped = ["queued", "paused", "interrupted", "cancelled", "failed"].includes(audit.status);
  const stages = definitions.map(([id, label, reached]) => {
    const state = id === "audit" && noReports ? "failed" : reached ? "completed" : !active && !stopped ? "active" : "pending";
    if (!reached) active = true;
    return { id, label, state };
  });
  const progress = total ? Math.max(0, Math.min(100, Math.round(reported * 10000 / total) / 100)) : 0;
  const stage = noReports && finalized ? "执行未完成 · 缺口记录已封存" : audit.status === "queued" ? "等待调度" : !sealed ? sweep ? "逐文件浏览与任务发布" : "任务规划与发布"
    : !mined ? board.failed ? "任务执行 · 需处理失败项" : `任务执行 · 已交报告 ${reported}/${total}`
      : !reviewed ? "报告内容复核" : finalized ? "报告已封存" : "报告封存";
  const progressText = audit.status === "queued" ? "等待调度" : sweep
    ? `文件已浏览 ${sweep.browsed_files}/${sweep.eligible_files} · 浏览缺口 ${sweep.gap_files} · 已发布 Area ${total} · 已交报告 ${reported}${sealed && !total ? " · 本轮仅有威胁发现记录" : ""}`
    : !sealed
    ? total ? `发布中 · 已发布 ${total} 项，已交报告 ${reported} 份` : "规划中 · 尚未发布任务"
    : !total ? "本轮无审计任务" : `报告交付 ${reported}/${total} · ${progress}%${board.gap ? ` · 缺口 ${board.gap}` : ""}`;
  const reviewProgress = board.validation?.total_batches > 0 && mined
    ? ` · 复核批次 ${board.validation.completed_batches ?? 0}/${board.validation.total_batches}` : "";
  return { ...audit, task_board: board, execution_incomplete: noReports && finalized, stage, stages, progress, progress_text: progressText + reviewProgress, progress_source: "task-board" };
}

export function mergeAuditPresentation(current, snapshot = {}) {
  return applyAuditProgress({ ...snapshot, ...current });
}
