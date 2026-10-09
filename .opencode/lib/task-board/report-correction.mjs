import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PROTOCOL, check, controlledBytes, digest, hash, summarize, timestamp } from "./contract.mjs";
import { checkReportIntegrity } from "./report-integrity.mjs";
import { summarizeTaskBac } from "./bac.mjs";

// Only an unsealed audit can bind a new report version; old bytes are immutable.
export async function correctReport(store, { task_id: taskId, expected_sha256: expected, report: ref, reason }) {
  check(typeof reason === "string" && reason.trim() && reason.length <= 4000, "报告更正必须提供具体中文原因。");
  check(ref && /^[a-f0-9]{64}$/.test(ref.sha256 ?? "") && /^[a-f0-9]{64}$/.test(expected ?? ""), "报告更正缺少新旧摘要绑定。");
  const bytes = await controlledBytes(store.reportsRoot, ref.path);
  check(hash(bytes) === ref.sha256, "更正报告摘要不匹配。");
  const report = JSON.parse(bytes.toString("utf8"));
  return store.mutate(async board => {
    check(!board.final_report, "最终报告已经封存，不能更正本轮交付。");
    check(summarize(board).mining_complete, "报告尚未收齐，不能更正已交付报告。");
    const task = board.tasks.find(row => row.task_id === taskId);
    check(task?.status === "REPORTED" && task.report, "只能更正已接收的报告。");
    const prior = board.report_corrections?.find(row => row.task_id === taskId && row.previous.sha256 === expected && row.replacement.sha256 === ref.sha256 && row.reason === reason.trim());
    if (task.report.sha256 === ref.sha256 && prior) return { corrected: true, duplicate: true, correction: prior };
    check(task.report.sha256 === expected, "报告版本已变化，请刷新后重新更正。");
    check(hash(await controlledBytes(store.reportsRoot, task.report.path)) === expected, "原报告已被改写，拒绝更正。");
    const attempt = board.attempts.find(row => row.attempt_id === task.attempt_id);
    check(report.protocol === PROTOCOL && report.audit_id === board.audit_id && report.task_id === taskId
      && report.attempt_id === task.attempt_id && report.agent_session_id === attempt?.session_id, "更正报告的审计、任务、尝试或生产会话绑定无效。");
    check(typeof report.summary === "string" && report.summary.trim() && Array.isArray(report.findings) && Array.isArray(report.gaps), "更正报告缺少摘要、发现或缺口列表。");
    await checkReportIntegrity(bytes, { reportsRoot: store.reportsRoot, taskId });
    const path = `task-board/${board.audit_id}/corrections/${hash(taskId).slice(0, 24)}.${ref.sha256}.json`;
    const file = join(store.reportsRoot, path);
    await mkdir(dirname(file), { recursive: true });
    try { await writeFile(file, bytes, { mode: 0o600, flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; check((await readFile(file)).equals(bytes), "更正版本文件已经存在但内容不同。"); }
    const replacement = { path, sha256: ref.sha256, byte_length: bytes.length };
    // Validate the corrected unit against its original frozen plan and producer.
    await summarizeTaskBac({ ...board, tasks: [{ ...task, report: replacement }] }, store.reportsRoot);
    const correction = { task_id: taskId, previous: structuredClone(task.report), replacement, reason: reason.trim(),
      corrected_at: timestamp(), previous_validation: structuredClone(board.validation) };
    correction.id = `correction-${digest(correction).slice(0, 32)}`;
    (board.report_corrections ??= []).push(correction);
    task.report = replacement;
    board.validation = { status: "NOT_STARTED" };
    return { corrected: true, correction, next_action: "VALIDATE" };
  });
}
