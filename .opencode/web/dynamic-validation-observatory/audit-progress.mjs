// Presentation fields are derived from live execution state; they are not
// evidence that a report's contents have passed review.
export function applyAuditProgress(audit) {
  const board = audit.task_board ?? (audit.todo?.protocol === "task-board.v1" ? audit.todo : null);
  if (!board) return audit;
  const sealed = board.publication === "SEALED";
  const mined = board.mining_complete === true;
  const reviewed = board.validation?.status === "REVIEWED";
  const finalized = board.next_action === "DONE" || audit.todo_completion?.complete === true || audit.status === "completed";
  const total = Number(board.total) || 0, reported = Number(board.reported) || 0;
  const noReports = mined && total > 0 && reported === 0;
  const definitions = [
    ["scope", "范围冻结", Boolean(audit.paths || audit.source_baseline || sealed)],
    ["planning", "任务规划与发布", sealed],
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
  const stage = noReports && finalized ? "执行未完成 · 缺口记录已封存" : audit.status === "queued" ? "等待调度" : !sealed ? "任务规划与发布"
    : !mined ? board.failed ? "任务执行 · 需处理失败项" : `任务执行 · 已交报告 ${reported}/${total}`
      : !reviewed ? "报告内容复核" : finalized ? "报告已封存" : "报告封存";
  const progressText = audit.status === "queued" ? "等待调度" : !sealed
    ? total ? `发布中 · 已发布 ${total} 项，已交报告 ${reported} 份` : "规划中 · 尚未发布任务"
    : !total ? "本轮无审计任务" : `报告交付 ${reported}/${total} · ${progress}%${board.gap ? ` · 缺口 ${board.gap}` : ""}`;
  return { ...audit, task_board: board, execution_incomplete: noReports && finalized, stage, stages, progress, progress_text: progressText, progress_source: "task-board" };
}

export function mergeAuditPresentation(current, snapshot = {}) {
  return applyAuditProgress({ ...snapshot, ...current });
}
