#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { checkReportIntegrity } from "../lib/task-board/report-integrity.mjs";
import { PROTOCOL, check } from "../lib/task-board/contract.mjs";

try {
  const input = JSON.parse(await readFile(process.argv[2], "utf8"));
  const bytes = await readFile(input.report_path), report = JSON.parse(bytes.toString("utf8"));
  const session = JSON.parse(await readFile(input.session_path, "utf8"));
  check(report.protocol === PROTOCOL && report.audit_id === input.audit_id && report.task_id === input.task.task_id
    && report.attempt_id === input.attempt_id && report.agent_session_id === session.agent_session_id, "报告任务或真实生产会话绑定不一致。");
  await checkReportIntegrity(bytes, { reportsRoot: input.reports_root, taskId: input.task.task_id });
  process.stdout.write(`${JSON.stringify({ valid: true, task_id: input.task.task_id })}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
