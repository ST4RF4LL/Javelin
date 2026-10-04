#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { PROTOCOL, check, controlledBytes, hash } from "../lib/task-board/contract.mjs";

try {
  check(process.env.AUDIT_TASK_PROTOCOL === PROTOCOL, "当前任务未选择通用任务面板协议。");
  const [command = "status", argument, value] = process.argv.slice(2);
  check(["status", "list", "publish", "seal", "skip", "review-input", "review", "finalize", "wait", "bind"].includes(command), "任务面板命令无效。");
  if (command === "bind") {
    const bytes = await controlledBytes(process.env.AUDIT_REPORTS_ROOT, argument);
    process.stdout.write(`${JSON.stringify({ path: argument, sha256: hash(bytes) })}\n`);
    process.exit(0);
  }
  const connection = JSON.parse(await readFile(process.env.AUDIT_TASK_BOARD_CONNECTION_PATH, "utf8"));
  check(connection.protocol === PROTOCOL && /^http:\/\/127\.0\.0\.1:\d+$/.test(connection.endpoint), "任务服务连接信息无效。");
  let body = {};
  if (["publish", "skip", "review"].includes(command)) body = JSON.parse(await readFile(argument, "utf8"));
  if (command === "seal" && argument) body = { empty_reason: argument };
  if (command === "list") body = argument === "api" ? { source: "api", offset: Number(value) || 0 } : { status: argument || null, offset: Number(value) || 0 };
  const call = async route => {
    const response = await fetch(`${connection.endpoint}/${route}`, { method: "POST", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(55_000) });
    const result = await response.json(); check(response.ok, result.error ?? "任务服务调用失败。"); return result;
  };
  let result;
  if (command === "wait") {
    const deadline = Date.now() + Math.min(30, Math.max(1, Number(argument) || 30)) * 1000;
    do {
      result = await call("status");
      if (result.mining_complete || ["RESOLVE_FAILURES", "PUBLISH"].includes(result.next_action)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() < deadline);
  } else result = await call(command);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
